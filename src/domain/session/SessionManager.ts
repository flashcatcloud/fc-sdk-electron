import { app } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  deepClone,
  generateUUID,
  ONE_MINUTE,
  performDraw,
  type Subscription,
  type TimeStamp,
} from '@flashcatcloud/browser-core';
import type { Configuration } from '../../config';
import { type EndUserActivityEvent, EventKind, EventManager, LifecycleKind } from '../../event';
import type { FormatHooks } from '../../assembly';
import { addError, setTimeout } from '../telemetry';
import {
  parseSessionRecord,
  SessionContext,
  type SessionRecord,
  TrackingType,
  withholdsEvents,
} from './SessionContext';
import { StateFile } from '../../tools/StateFile';
import { SESSION_TIME_OUT_DELAY } from './session.constants';

export const SESSION_EXPIRATION_DELAY = 15 * ONE_MINUTE;
export const SESSION_FILE_NAME = '_dd_s';

export interface Session extends SessionRecord {
  status: SessionStatus;
}

export type SessionStatus = 'active' | 'expired';

/**
 * Session state stored on disk
 */
interface SessionState extends SessionRecord {
  created: number;
  lastActivity: number;
}

/** What a draw reads: the rate and the on-error switch in force, and the remote version they came from. */
export interface SamplingConfiguration extends Pick<Configuration, 'sessionSampleRate' | 'sessionOnError'> {
  rcVersion?: number;
}

/**
 * Track session lifecycle
 * - store the Session on SESSION_FILE_NAME
 * - on start, if no Session is already active, create a new Session
 * - after SESSION_EXPIRATION_DELAY without activity, expire the Session
 * - after SESSION_TIME_OUT_DELAY if the Session is still active, expire the Session
 * - on activity, if the Session is expired, create a new Session
 * - when a Session is created, draw whether it is collected (see {@link TrackingType}) under the
 *   sampling in force then; a resumed Session keeps the decision it was created with
 * - when the remote configuration asks for a change to apply at once, end the Session only where
 *   the new sampling is decisive for it (see {@link SessionManager.applySamplingChange})
 */
export class SessionManager {
  /** The current session as it is saved: the one copy of its id, draw and error mark. */
  private currentState!: SessionState;
  private status: SessionStatus = 'active';
  /** `SESSION_FILE_NAME`: every write and delete of it lands in the order requested, see {@link StateFile}. */
  private readonly stateFile = new StateFile(getSessionFilePath(), 'session state');
  private sessionContext!: SessionContext;
  private inactivityTimeoutId: ReturnType<typeof setTimeout> | undefined;
  private sessionTimeoutId: ReturnType<typeof setTimeout> | undefined;
  private activitySubscription: Subscription | undefined;

  private constructor(
    private readonly eventManager: EventManager,
    private readonly hooks: FormatHooks,
    /** Read at each draw, never in between: the init values, or what the console delivered over them. */
    private readonly getSampling: () => SamplingConfiguration
  ) {}

  static async start(
    eventManager: EventManager,
    hooks: FormatHooks,
    getSampling: () => SamplingConfiguration
  ): Promise<SessionManager> {
    const manager = new SessionManager(eventManager, hooks, getSampling);
    await manager.init();
    return manager;
  }

  getSession(): Session {
    return deepClone({ ...toSessionRecord(this.currentState), status: this.status });
  }

  expire(): void {
    this.expireSession();
  }

  /**
   * Ends the running session where the sampling now in force is decisive for it, so that the next
   * activity draws a new one under it. Called when a remote configuration that asks to apply at
   * once (`activation: immediate`) has changed the sampling; anything else waits for the next
   * session, because a session's draw is locked for its whole life.
   *
   * Only two cases are decisive:
   * - A session that was not collected and was drawn at rate 0 lost no lottery: nothing was ever
   *   drawn for it. A rate leaving 0, or the on-error switch turning on, would now keep some such
   *   sessions, so it draws again. One that lost a draw at a real rate keeps its outcome: drawing
   *   it again would give it a second chance, and `n` independent draws at rate `p` keep a session
   *   with probability `1 − (1 − p)ⁿ`, more than the rate promises.
   * - A collected session meets the emergency stop, rate 0 — unless it is an on-error session and
   *   the switch stays on: rate 0 next to the switch is that switch's ordinary setting, and ending
   *   the session would throw away exactly the history the switch exists to keep.
   *
   * Idempotent: a session drawn under the sampling now in force is never decisive, so the same
   * configuration arriving again ends nothing.
   */
  applySamplingChange(): void {
    if (this.status !== 'active') {
      return;
    }
    const next = this.getSampling();
    const { trackingType, sampleRate } = this.currentState;
    if (trackingType === TrackingType.NOT_TRACKED) {
      if (sampleRate === 0 && (next.sessionSampleRate > 0 || next.sessionOnError)) {
        this.expireSession();
      }
      return;
    }
    if (next.sessionSampleRate === 0 && !(next.sessionOnError && trackingType === TrackingType.TRACKED_ON_ERROR)) {
      this.expireSession();
    }
  }

  /** The session in force at `startTime`, current or past, or `undefined` when there was none. */
  findSession(startTime: TimeStamp): SessionRecord | undefined {
    return this.sessionContext.find(startTime);
  }

  /**
   * Record that a withheld session reported an error at `errorTime`, which releases what it held. A
   * no-op for any other session: writing the mark there would only cost disk writes.
   *
   * Takes effect in memory at once, and reaches disk afterwards: "an error, then the application
   * quits" is the case this exists for, and it must not wait on a write.
   */
  setSessionHasError(sessionId: string, errorTime: TimeStamp): void {
    // Only while active: an ended session's file is being deleted, and a write would bring it back.
    if (this.status === 'active' && sessionId === this.currentState.id && withholdsEvents(this.currentState)) {
      this.currentState.hasError = true;
      void this.saveCurrentState();
    }
    this.sessionContext.setHasError(sessionId, errorTime);
  }

  /**
   * Writes the session's state and history before returning, for a process that may be about to
   * exit: the error mark a release just set reaches disk asynchronously otherwise, and a session
   * resumed by the next launch would withhold again what this one already uploaded.
   */
  writePendingSync(): void {
    if (this.status === 'active') {
      this.stateFile.writeSync(JSON.stringify(this.currentState));
    } else {
      // Its delete is queued behind the writes; the next launch must not resume it.
      this.stateFile.deleteSync();
    }
    this.sessionContext.persistSync();
  }

  stop(): void {
    this.clearTimers();
    if (this.activitySubscription) {
      this.activitySubscription.unsubscribe();
      this.activitySubscription = undefined;
    }
  }

  private async init(): Promise<void> {
    const now = Date.now();
    this.stateFile.sweep();
    const existingState = await loadSessionState();

    this.sessionContext = await SessionContext.init(this.hooks);
    // The previous launch's entry, resumed session or not: it never got to close itself, and an
    // open entry is never pruned. A resumed session gets a new entry for this launch.
    this.sessionContext.close();

    if (existingState && isSessionValid(existingState, now)) {
      existingState.lastActivity = now;
      this.setCurrent(existingState);
      await this.saveCurrentState();
      if (this.isCurrent(existingState)) {
        this.scheduleInactivityTimeout();
        this.scheduleSessionTimeout(existingState.created);
      }
    } else {
      await this.createNewSession();
    }

    this.activitySubscription = this.eventManager.registerHandler<EndUserActivityEvent>({
      canHandle: (event): event is EndUserActivityEvent =>
        event.kind === EventKind.LIFECYCLE && event.lifecycle === LifecycleKind.END_USER_ACTIVITY,
      handle: () => {
        this.updateActivity().catch(addError);
      },
    });
  }

  /**
   * Creates and saves a session, and answers whether it is still the active one once saved: a
   * configuration that applies at once can end it while it is being written, and nothing may then
   * be scheduled for it or announced about it.
   */
  private async createNewSession(): Promise<boolean> {
    const now = Date.now();
    const sampling = this.getSampling();
    const state: SessionState = {
      id: generateUUID(),
      trackingType: drawTrackingType(sampling),
      sampleRate: sampling.sessionSampleRate,
      ...(sampling.rcVersion === undefined ? {} : { rcVersion: sampling.rcVersion }),
      created: now,
      lastActivity: now,
    };

    this.setCurrent(state);
    await this.saveCurrentState();
    if (!this.isCurrent(state)) {
      return false;
    }

    this.scheduleInactivityTimeout();
    this.scheduleSessionTimeout(state.created);
    return true;
  }

  /** Whether `state` is still the session in force, and still active, after an `await`. */
  private isCurrent(state: SessionState): boolean {
    return this.status === 'active' && this.currentState === state;
  }

  private setCurrent(state: SessionState): void {
    this.currentState = state;
    this.status = 'active';
    this.sessionContext.add(toSessionRecord(state));
  }

  /**
   * Queue a write of the current state. Each write serializes the state as of when it runs, and they
   * run one after another, so the last one on disk is always the latest state.
   */
  private saveCurrentState(): Promise<boolean> {
    return this.stateFile.write(() => JSON.stringify(this.currentState));
  }

  private expireSession(): void {
    this.clearTimers();
    this.status = 'expired';
    this.sessionContext.close();
    // Behind the queued writes: a save queued just before — the error mark, say — would otherwise
    // land after the delete and resurrect the ended session on the next launch.
    void this.stateFile.delete();
    this.eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
  }

  private async updateActivity(): Promise<void> {
    if (this.isExpired()) {
      if (await this.createNewSession()) {
        this.eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
      }
      return;
    }

    const state = await loadSessionState();
    if (this.isExpired()) {
      // Expired while the state was being read: writing it back would bring the session back.
      return;
    }
    if (!state || state.id !== this.currentState.id) {
      addError(new Error('SessionManager: Invalid session state'));
      return;
    }

    // Written from memory rather than from what was just read: the error mark reaches memory first
    // and disk afterwards, and writing the read state back could undo it.
    const current = this.currentState;
    current.lastActivity = Date.now();
    await this.saveCurrentState();
    if (!this.isCurrent(current)) {
      return;
    }

    this.scheduleInactivityTimeout();
  }

  /** A method rather than a comparison in place: the status changes under an `await`. */
  private isExpired(): boolean {
    return this.status === 'expired';
  }

  private scheduleInactivityTimeout(): void {
    if (this.inactivityTimeoutId !== undefined) {
      clearTimeout(this.inactivityTimeoutId);
    }
    this.inactivityTimeoutId = setTimeout(() => this.expireSession(), SESSION_EXPIRATION_DELAY);
  }

  private scheduleSessionTimeout(createdAt: number): void {
    // One four-hour timer at a time: one left behind would end a later session early.
    clearTimeout(this.sessionTimeoutId);
    const now = Date.now();
    const remainingTime = SESSION_TIME_OUT_DELAY - (now - createdAt);
    if (remainingTime > 0) {
      this.sessionTimeoutId = setTimeout(() => this.expireSession(), remainingTime);
    } else {
      this.expireSession();
    }
  }

  private clearTimers(): void {
    if (this.inactivityTimeoutId !== undefined) {
      clearTimeout(this.inactivityTimeoutId);
      this.inactivityTimeoutId = undefined;
    }
    if (this.sessionTimeoutId !== undefined) {
      clearTimeout(this.sessionTimeoutId);
      this.sessionTimeoutId = undefined;
    }
  }
}

/**
 * The plain rate first; `sessionOnError` only ever applies to what it missed, so a session is never
 * counted by both.
 */
function drawTrackingType({ sessionSampleRate, sessionOnError }: SamplingConfiguration): TrackingType {
  if (performDraw(sessionSampleRate)) {
    return TrackingType.TRACKED;
  }
  return sessionOnError ? TrackingType.TRACKED_ON_ERROR : TrackingType.NOT_TRACKED;
}

/** The record part of a state, without its timestamps. Absent fields stay absent. */
function toSessionRecord({ id, trackingType, sampleRate, rcVersion, hasError }: SessionState): SessionRecord {
  return {
    id,
    trackingType,
    sampleRate,
    ...(rcVersion === undefined ? {} : { rcVersion }),
    ...(hasError === undefined ? {} : { hasError }),
  };
}

function getSessionFilePath(): string {
  return path.join(app.getPath('userData'), SESSION_FILE_NAME);
}

function isSessionValid(state: SessionState, now: number): boolean {
  const isNotExpired = now - state.lastActivity < SESSION_EXPIRATION_DELAY;
  const isNotTimedOut = now - state.created < SESSION_TIME_OUT_DELAY;
  return isNotExpired && isNotTimedOut;
}

async function loadSessionState(): Promise<SessionState | undefined> {
  try {
    const filePath = getSessionFilePath();
    await fs.access(filePath);
    return parseSessionState(JSON.parse(await fs.readFile(filePath, 'utf-8')));
  } catch {
    return undefined;
  }
}

/**
 * The state `value` holds, or `undefined` when it is not one — a corrupt file, a hand edit — so that
 * a fresh session is drawn rather than a draw that was never made resumed. A state written before
 * sessions were sampled has no draw: every session was collected then, and a session keeps the
 * decision it was created with.
 */
function parseSessionState(value: unknown): SessionState | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { created, lastActivity, trackingType, sampleRate, ...rest } = value as Record<string, unknown>;
  if (!Number.isFinite(created) || !Number.isFinite(lastActivity)) return undefined;
  const record = parseSessionRecord({
    ...rest,
    trackingType: trackingType ?? TrackingType.TRACKED,
    sampleRate: sampleRate ?? 100,
  });
  return record && { ...record, created: created as number, lastActivity: lastActivity as number };
}

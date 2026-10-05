import { app } from 'electron';
import { writeFileSync } from 'node:fs';
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
import { displayError } from '../../tools/display';
import { SessionContext, type SessionRecord, TrackingType, withholdsEvents } from './SessionContext';
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

export type SamplingConfiguration = Pick<Configuration, 'sessionSampleRate' | 'sessionOnError'>;

/**
 * Track session lifecycle
 * - store the Session on SESSION_FILE_NAME
 * - on start, if no Session is already active, create a new Session
 * - after SESSION_EXPIRATION_DELAY without activity, expire the Session
 * - after SESSION_TIME_OUT_DELAY if the Session is still active, expire the Session
 * - on activity, if the Session is expired, create a new Session
 * - when a Session is created, draw whether it is collected (see {@link TrackingType}); a resumed
 *   Session keeps the decision it was created with
 */
export class SessionManager {
  /** The current session as it is saved: the one copy of its id, draw and error mark. */
  private currentState!: SessionState;
  private status: SessionStatus = 'active';
  /** Every write of `currentState`, in order, so that a late write cannot undo an earlier one. */
  private pendingSave: Promise<void> = Promise.resolve();
  private sessionContext!: SessionContext;
  private inactivityTimeoutId: ReturnType<typeof setTimeout> | undefined;
  private sessionTimeoutId: ReturnType<typeof setTimeout> | undefined;
  private activitySubscription: Subscription | undefined;

  private constructor(
    private readonly eventManager: EventManager,
    private readonly hooks: FormatHooks,
    private readonly sampling: SamplingConfiguration
  ) {}

  static async start(
    eventManager: EventManager,
    hooks: FormatHooks,
    sampling: SamplingConfiguration
  ): Promise<SessionManager> {
    const manager = new SessionManager(eventManager, hooks, sampling);
    await manager.init();
    return manager;
  }

  getSession(): Session {
    const { id, trackingType, sampleRate, hasError } = this.currentState;
    return deepClone({ id, trackingType, sampleRate, hasError, status: this.status });
  }

  expire(): void {
    this.expireSession();
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
      try {
        writeFileSync(getSessionFilePath(), JSON.stringify(this.currentState), 'utf-8');
      } catch (error) {
        displayError('Failed to save session state:', error);
      }
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
    const existingState = await loadSessionState();

    this.sessionContext = await SessionContext.init(this.hooks);
    // The previous launch's entry, resumed session or not: it never got to close itself, and an
    // open entry is never pruned. A resumed session gets a new entry for this launch.
    this.sessionContext.close();

    if (existingState && isSessionValid(existingState, now)) {
      existingState.lastActivity = now;
      this.setCurrent(existingState);
      await this.saveCurrentState();
      this.scheduleInactivityTimeout();
      this.scheduleSessionTimeout(existingState.created);
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

  private async createNewSession(): Promise<void> {
    const now = Date.now();
    const state: SessionState = {
      id: generateUUID(),
      trackingType: drawTrackingType(this.sampling),
      sampleRate: this.sampling.sessionSampleRate,
      created: now,
      lastActivity: now,
    };

    this.setCurrent(state);
    await this.saveCurrentState();

    this.scheduleInactivityTimeout();
    this.scheduleSessionTimeout(state.created);
  }

  private setCurrent(state: SessionState): void {
    this.currentState = state;
    this.status = 'active';
    const { id, trackingType, sampleRate, hasError } = state;
    this.sessionContext.add({ id, trackingType, sampleRate, hasError });
  }

  /**
   * Queue a write of the current state. Each write serializes the state as of when it runs, and they
   * run one after another, so the last one on disk is always the latest state.
   */
  private saveCurrentState(): Promise<void> {
    this.pendingSave = this.pendingSave.then(() => saveSessionState(this.currentState));
    return this.pendingSave;
  }

  private expireSession(): void {
    this.clearTimers();
    this.status = 'expired';
    this.sessionContext.close();
    // Behind the queued writes: a save queued just before — the error mark, say — would otherwise
    // land after the delete and resurrect the ended session on the next launch.
    this.pendingSave = this.pendingSave.then(deleteSessionFile);
    this.eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
  }

  private async updateActivity(): Promise<void> {
    if (this.isExpired()) {
      await this.createNewSession();
      this.eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
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
    this.currentState.lastActivity = Date.now();
    await this.saveCurrentState();

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
    const content = await fs.readFile(filePath, 'utf-8');
    const state = JSON.parse(content) as Omit<SessionState, 'trackingType' | 'sampleRate'> & Partial<SessionState>;
    // A state written before sessions were sampled has no draw: every session was collected then,
    // and a session keeps the decision it was created with.
    return { ...state, trackingType: state.trackingType ?? TrackingType.TRACKED, sampleRate: state.sampleRate ?? 100 };
  } catch {
    return undefined;
  }
}

async function saveSessionState(state: SessionState): Promise<void> {
  try {
    const filePath = getSessionFilePath();
    await fs.writeFile(filePath, JSON.stringify(state), 'utf-8');
  } catch (error) {
    displayError('Failed to save session state:', error);
  }
}

async function deleteSessionFile(): Promise<void> {
  try {
    const filePath = getSessionFilePath();
    await fs.unlink(filePath);
  } catch {
    // File might not exist, ignore error
  }
}

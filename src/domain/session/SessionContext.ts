import { app } from 'electron';
import * as path from 'node:path';
import { DISCARDED, SKIPPED, timeStampNow, type TimeStamp } from '@flashcatcloud/browser-core';
import type { FormatHooks } from '../../assembly';
import { DiskValueHistory } from '../../tools/DiskValueHistory';
import { SESSION_TIME_OUT_DELAY } from './session.constants';

export const SESSION_HISTORY_FILE_NAME = '_dd_session_history';

/**
 * What the sampling draw decided for a session. It is drawn once, when the session is created, and
 * kept for the session's whole life — a session resumed after a restart keeps the decision it was
 * created with.
 *
 * The values are the browser SDK's tracking types. The ones that involve Session Replay do not
 * exist here: the main process does not record.
 */
export const TrackingType = {
  /** Not drawn: nothing is collected. */
  NOT_TRACKED: '0',
  /** Drawn by `sessionSampleRate`: collected and uploaded as it happens. */
  TRACKED: '2',
  /**
   * Missed by `sessionSampleRate` but kept by `sessionOnError`: collected, held in memory, and
   * uploaded only once the session reports an error.
   */
  TRACKED_ON_ERROR: '4',
} as const;
export type TrackingType = (typeof TrackingType)[keyof typeof TrackingType];

export interface SessionRecord {
  id: string;
  trackingType: TrackingType;
  /**
   * The `sessionSampleRate` the session was drawn at. Kept with the session because it is what the
   * backend extrapolates a drawn session by: a session resumed under a configuration that changed
   * the rate still stands for `100 / rate` sessions of the rate that drew it.
   */
  sampleRate: number;
  /**
   * The version of the remote configuration the session was drawn under, when its draw read one.
   * Reported on its events as `_dd.configuration.rc_version`, so the console can trace a session
   * back to the settings that decided whether to keep it — a resumed session and a crash reported
   * a launch later included.
   */
  rcVersion?: number;
  /**
   * Set once a `TRACKED_ON_ERROR` session reports its first error, which releases what it withheld.
   * Never set on any other session.
   */
  hasError?: boolean;
}

/** Whether what this session collects is still being held back, waiting for an error. */
export function withholdsEvents(record: SessionRecord): boolean {
  return record.trackingType === TrackingType.TRACKED_ON_ERROR && !record.hasError;
}

/**
 * Resolves which session an event belongs to, by the event's own start time, and stamps the
 * sampling attributes the backend reads off it.
 *
 * The history is kept on disk so that a native crash, reported on the next launch, is attributed —
 * and sampled — as the session it happened in.
 */
export class SessionContext {
  private activeSessionId: string | undefined;

  private constructor(
    private readonly history: DiskValueHistory<SessionRecord | string>,
    hooks: FormatHooks
  ) {
    hooks.registerRum((params) => {
      const record = this.find(params.startTime);
      if (record === undefined || record.trackingType === TrackingType.NOT_TRACKED) return DISCARDED;
      // A withheld session that ended without an error had everything it held thrown away. An event
      // of it assembled afterwards — a request that completed late, the final view update — would
      // store the very session the withholding avoided.
      if (withholdsEvents(record) && record.id !== this.activeSessionId) return DISCARDED;

      const sampledForError = record.trackingType === TrackingType.TRACKED_ON_ERROR;
      return {
        session: {
          id: record.id,
          // Tells the backend this session's detail only starts where the buffer reached. Views
          // only: the backend reads session attributes off them.
          sampled_for_error: sampledForError && params.eventType === 'view' ? true : undefined,
        },
        // A session kept only because it errored stands for itself, not for `100 / rate` sessions
        // like a drawn one: 0 is what the backend reads as "do not extrapolate". Derived from the
        // record, so a resumed session and a crash reported a launch later get it too.
        _dd: {
          configuration: { session_sample_rate: sampledForError ? 0 : record.sampleRate, rc_version: record.rcVersion },
        },
      };
    });

    hooks.registerTelemetry((params) => {
      const record = this.find(params.startTime);
      // Telemetry is the SDK's own data and leaves either way; a session that is not collected is
      // simply nothing to attribute it to, as in the browser SDK.
      if (record === undefined || record.trackingType === TrackingType.NOT_TRACKED) return SKIPPED;
      return { session: { id: record.id } };
    });

    hooks.registerSpan((params) => {
      const record = this.find(params.startTime);
      if (record === undefined) return DISCARDED;
      return { meta: { '_dd.session.id': record.id } };
    });
  }

  static async init(hooks: FormatHooks, expireDelay = SESSION_TIME_OUT_DELAY): Promise<SessionContext> {
    const filePath = path.join(app.getPath('userData'), SESSION_HISTORY_FILE_NAME);
    const history = await DiskValueHistory.init<SessionRecord | string>({ filePath, expireDelay });
    return new SessionContext(history, hooks);
  }

  /** The session in force at `startTime`, or `undefined` when there was none. */
  find(startTime: TimeStamp): SessionRecord | undefined {
    return toSessionRecord(this.history.find(startTime));
  }

  /** Writes the history before returning, for a process that may be about to exit. */
  persistSync(): void {
    this.history.persistSync();
  }

  add(record: SessionRecord): void {
    this.activeSessionId = record.id;
    this.history.add(record, timeStampNow());
  }

  close(): void {
    this.activeSessionId = undefined;
    this.history.closeActive(timeStampNow());
  }

  /**
   * Record that a withheld session reported an error at `errorTime`: on the entry in force then,
   * and on the active entry when the session is the current one, since from now on everything of
   * it is uploaded.
   *
   * Not on every entry of the session: a session resumed after a restart has one entry per launch,
   * and whether the earlier launch's entry still withholds is what tells a crash reported now that
   * nothing of that launch — the view the crash happened in, to begin with — ever reached the
   * intake. An error of the current launch must not answer that question for the earlier one.
   */
  setHasError(sessionId: string, errorTime: TimeStamp): void {
    const entries = [this.history.find(errorTime)];
    if (sessionId === this.activeSessionId) {
      entries.push(this.history.find(timeStampNow()));
    }
    let changed = false;
    for (const record of entries.map(parseSessionRecord)) {
      if (record?.id === sessionId && withholdsEvents(record)) {
        record.hasError = true;
        changed = true;
      }
    }
    if (changed) {
      this.history.persist();
    }
  }
}

/**
 * Entries written before sessions were sampled hold the bare session id. Every session was
 * collected then, and a session keeps the decision it was created with. Anything else must be a
 * well-formed record: a malformed one — a corrupt file, a hand edit — is no session at all, so its
 * events are discarded rather than uploaded under a draw that was never made.
 */
function toSessionRecord(value: unknown): SessionRecord | undefined {
  return typeof value === 'string'
    ? { id: value, trackingType: TrackingType.TRACKED, sampleRate: 100 }
    : parseSessionRecord(value);
}

const TRACKING_TYPES = new Set<unknown>(Object.values(TrackingType));

/**
 * The record `value` is, or `undefined` when it is not one: a non-empty id, a known type, a rate from
 * 0 to 100, a whole non-negative configuration version, a boolean mark.
 */
export function parseSessionRecord(value: unknown): SessionRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { id, trackingType, sampleRate, rcVersion, hasError } = value as Record<string, unknown>;
  if (typeof id !== 'string' || id === '') return undefined;
  if (!TRACKING_TYPES.has(trackingType)) return undefined;
  if (typeof sampleRate !== 'number' || !(sampleRate >= 0 && sampleRate <= 100)) return undefined;
  if (rcVersion !== undefined && !isConfigurationVersion(rcVersion)) return undefined;
  if (hasError !== undefined && typeof hasError !== 'boolean') return undefined;
  return value as SessionRecord;
}

/** A remote configuration version: a publish counter, so a whole number from 0 up. */
export function isConfigurationVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

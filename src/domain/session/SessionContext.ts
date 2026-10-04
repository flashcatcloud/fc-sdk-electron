import { app } from 'electron';
import * as path from 'node:path';
import { DISCARDED, round, SKIPPED, timeStampNow, type TimeStamp } from '@flashcatcloud/browser-core';
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
    hooks: FormatHooks,
    sessionSampleRate: number
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
        // tracking type, so a resumed session and a crash reported a launch later get it too.
        _dd: { configuration: { session_sample_rate: sampledForError ? 0 : round(sessionSampleRate, 3) } },
      };
    });

    hooks.registerTelemetry((params) => {
      const record = this.find(params.startTime);
      if (record === undefined) return SKIPPED;
      return { session: { id: record.id } };
    });

    hooks.registerSpan((params) => {
      const record = this.find(params.startTime);
      if (record === undefined) return DISCARDED;
      return { meta: { '_dd.session.id': record.id } };
    });
  }

  static async init(
    hooks: FormatHooks,
    sessionSampleRate: number,
    expireDelay = SESSION_TIME_OUT_DELAY
  ): Promise<SessionContext> {
    const filePath = path.join(app.getPath('userData'), SESSION_HISTORY_FILE_NAME);
    const history = await DiskValueHistory.init<SessionRecord | string>({ filePath, expireDelay });
    return new SessionContext(history, hooks, sessionSampleRate);
  }

  /** The session in force at `startTime`, or `undefined` when there was none. */
  find(startTime: TimeStamp): SessionRecord | undefined {
    return toSessionRecord(this.history.find(startTime));
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
   * Record that a withheld session reported its error. Every entry of the session is updated: a
   * session resumed after a restart has one entry per launch, and a crash of the earlier launch is
   * resolved through the earlier entry.
   */
  setHasError(sessionId: string): void {
    let changed = false;
    for (const { value } of this.history.getEntries()) {
      if (typeof value !== 'string' && value.id === sessionId && withholdsEvents(value)) {
        value.hasError = true;
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
 * collected then, and a session keeps the decision it was created with.
 */
function toSessionRecord(value: SessionRecord | string | undefined): SessionRecord | undefined {
  return typeof value === 'string' ? { id: value, trackingType: TrackingType.TRACKED } : value;
}

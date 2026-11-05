import { app, BrowserWindow } from 'electron';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ONE_DAY, ONE_MINUTE, ONE_SECOND, type Subscription } from '@flashcatcloud/browser-core';
import type { Configuration } from '../config';
import {
  EventKind,
  LifecycleKind,
  type AppMayExitEvent,
  type EndUserActivityEvent,
  type EventManager,
  type SessionRenewEvent,
  type UserChangedEvent,
} from '../event';
import { StateFile } from '../tools/StateFile';
import { displayError } from '../tools/display';
import { getUserAgent } from '../transport';
import { addError, setTimeout } from './telemetry';
import type { User } from './UserContext';

export const ACTIVE_PING_FILE_NAME = '_fc_active_ping';
const ACTIVE_PATH = '/api/v2/rum/active';
/** The shape of the file written here, not the SDK version: only a change of shape orphans it. */
const FILE_FORMAT = 2;
export const REQUEST_TIMEOUT = 10 * ONE_SECOND;
/**
 * In-process retries of one beacon, then not until the next natural trigger (a new session, a
 * login, the next launch). The same budget the native SDKs' beacons run on.
 */
export const RETRY_DELAYS = [2 * ONE_SECOND, 8 * ONE_SECOND];
/**
 * A report that still has not left after this long is dropped rather than delivered stale. The
 * intake refuses an `age_ms` above 72 hours; this stays a minute short of that, so a report
 * judged fresh here is still within it when the request leaves.
 */
const MAX_PENDING_AGE = 3 * ONE_DAY - ONE_MINUTE;
/** Bounds on what one installation can be made to store, whatever the application does with `setUser`. */
const MAX_SENT_COMBINATIONS = 50;
const MAX_PENDING_REPORTS = 10;
/** Nothing this SDK keeps in the state file comes anywhere near this; a larger file is not ours to read whole. */
const MAX_STATE_BYTES = 256 * 1024;

/**
 * One active beacon body, as the intake reads it (plus `age_ms`, computed at each send). The
 * shape is the intake's, shared with every other SDK's beacon: identity nested under `usr`
 * the way RUM events carry it, and the platform facts in the body rather than left to a
 * User-Agent the beacon endpoint does not parse. `usr.anonymous_id` is this process's anonymous
 * id — the renderer under the bridge never sends its own beacon; this one stands for the whole
 * application. The application itself is named by the client token, not the body.
 */
interface ActiveBeaconBody {
  service: string;
  env?: string;
  version?: string;
  build_version: string;
  sdk_version: string;
  usr: { anonymous_id?: string; id?: string };
  os: { name: string; version: string };
  device: { type: string; model: string; brand: string };
}

interface PendingReport {
  combination: string;
  report: ActiveBeaconBody;
  firstAttemptAt: number;
}

interface StoredState {
  day: string;
  sent: string[];
  pending: PendingReport[];
}

interface StoredFile extends StoredState {
  format: typeof FILE_FORMAT;
}

type RequestOutcome = 'accepted' | 'rejected' | 'retry';

/**
 * The dedicated "this device / this user is active today" report, from the main process.
 *
 * Ordinary events from here reach the intake written to disk in batches, minutes later at best,
 * and only for sessions the sampling draw kept — so a launch that lasts a few seconds, or loses
 * its draw, can miss the day's active-device count entirely even though the application plainly
 * ran. This report closes that gap the way the other FlashCat SDKs do: one small request of its
 * own per day and per (device, user) pair, sent straight over the network rather than through
 * the batch files, and independent of sampling. The backend merges it with what it derives from
 * view events, so a client that never sends it is still counted from its views.
 *
 * A new combination is only reported once the application has actually been in the foreground —
 * a window of it has had focus. `init` runs before the first window exists, and an application
 * started hidden by the OS (a login item, a background relaunch) has not been *used* yet;
 * counting it would report activity nobody performed. Focus is also the trigger, alongside a new
 * session and a change of user: each is a moment the answer to "who is active today" can change.
 * A window kept in use across midnight owes the new day a report too: real user activity (the
 * same presence input that renews sessions) re-checks the date, cheaply, and reports then.
 *
 * A report is written to disk before it is sent and removed only once the server has accepted
 * it. A launch that ends seconds later — the very case this exists for — therefore still counts:
 * its report goes out on the next launch carrying how long ago it first tried to leave
 * (`age_ms`), and the server dates it from that, never from this machine's clock.
 *
 * This SDK has no tracking-consent state of its own: the application calls `init` only once it
 * may collect, and that is the gate. There is accordingly no consent-withdrawn path here — an
 * application that stops calling `init` stops the report with everything else.
 */
export class ActivePing {
  private readonly stateFile = new StateFile(getFilePath(), 'the active report state');
  private state: StoredState = { day: localDay(Date.now()), sent: [], pending: [] };
  private inFlight: AbortController | undefined;
  private inFlightReport: PendingReport | undefined;
  private retryTimeoutId: ReturnType<typeof setTimeout> | undefined;
  private failedAttempts = 0;
  private hasForeground = false;
  private subscriptions: Subscription[] = [];
  private stopped = false;

  private constructor(
    private readonly config: Configuration,
    private readonly anonymousId: string,
    private readonly getUser: () => User | undefined
  ) {}

  /** Reads back what an earlier launch could not deliver. */
  static async init(config: Configuration, anonymousId: string, getUser: () => User | undefined): Promise<ActivePing> {
    const activePing = new ActivePing(config, anonymousId, getUser);
    await activePing.restore();
    return activePing;
  }

  /**
   * Starts reporting: delivers what an earlier launch left behind, then answers to a window
   * gaining focus, a new session, and a change of user for the rest of the run.
   */
  start(eventManager: EventManager): void {
    this.subscriptions.push(
      eventManager.registerHandler<UserChangedEvent>({
        canHandle: (event): event is UserChangedEvent =>
          event.kind === EventKind.LIFECYCLE && event.lifecycle === LifecycleKind.USER_CHANGED,
        handle: () => this.attempt(),
      }),
      eventManager.registerHandler<SessionRenewEvent>({
        canHandle: (event): event is SessionRenewEvent =>
          event.kind === EventKind.LIFECYCLE && event.lifecycle === LifecycleKind.SESSION_RENEW,
        handle: () => this.attempt(),
      }),
      eventManager.registerHandler<EndUserActivityEvent>({
        canHandle: (event): event is EndUserActivityEvent =>
          event.kind === EventKind.LIFECYCLE && event.lifecycle === LifecycleKind.END_USER_ACTIVITY,
        // Presence events are frequent; the date comparison is the whole cost unless the
        // day has actually rolled over under a window that stayed open across midnight,
        // in which case the new day's report is owed before this user quits.
        handle: () => {
          if (localDay(Date.now()) !== this.state.day) {
            this.attempt();
          }
        },
      }),
      eventManager.registerHandler<AppMayExitEvent>({
        canHandle: (event): event is AppMayExitEvent =>
          event.kind === EventKind.LIFECYCLE && event.lifecycle === LifecycleKind.APP_MAY_EXIT,
        handle: () => this.writeSync(),
      })
    );
    app.on('browser-window-focus', this.onForeground);
    // `quit` rather than the quit events before it: those can be cancelled, and this cannot be undone.
    app.on('quit', this.onQuit);
    // An application that created and focused its window before calling `init` gets no focus
    // event after this point; the window it already has is the foreground it is waiting for.
    this.hasForeground = BrowserWindow.getFocusedWindow() !== null;
    this.attempt();
  }

  /** Stops for good, writing first what has not landed: nothing after this point will. */
  stop(): void {
    try {
      this.writeSync();
    } finally {
      this.stopped = true;
      this.inFlight?.abort();
      this.inFlight = undefined;
      this.inFlightReport = undefined;
      clearTimeout(this.retryTimeoutId);
      this.subscriptions.forEach((subscription) => subscription.unsubscribe());
      this.subscriptions = [];
      app.removeListener('browser-window-focus', this.onForeground);
      app.removeListener('quit', this.onQuit);
    }
  }

  private readonly onQuit = () => this.stop();

  private readonly onForeground = () => {
    this.hasForeground = true;
    this.attempt();
  };

  private async restore(): Promise<void> {
    this.stateFile.sweep();
    try {
      if ((await fs.stat(getFilePath())).size > MAX_STATE_BYTES) {
        return;
      }
      const parsed = parseStoredFile(JSON.parse(await fs.readFile(getFilePath(), 'utf-8')));
      if (!parsed) {
        return;
      }
      const today = localDay(Date.now());
      // A new local day retires the sent-marks. Judged on this machine's clock on purpose: the
      // marks only save requests, and being wrong costs at most one extra request — the day a
      // report is counted under is decided by the server from `age_ms`.
      this.state =
        parsed.day === today
          ? { day: today, sent: parsed.sent, pending: parsed.pending }
          : { day: today, sent: [], pending: parsed.pending };
      this.prunePending();
    } catch {
      // No file yet, or one that is not ours to read: this launch starts from nothing.
    }
  }

  private attempt(): void {
    if (this.stopped) {
      return;
    }
    this.rollDay();
    this.prunePending();
    // Today's activity is recorded before anything can make this call return early. A login
    // that starts and ends while an earlier report is still in flight is activity today, and
    // the moment it happened — not the moment the network answers — is what dates it: queue
    // the combination now, with its own first-attempt time, and let the sends drain serially.
    this.recordCurrentCombination();
    this.drainQueue();
  }

  /**
   * Sends the oldest queued report, if any. Network continuations call only this — never
   * `attempt()` — so a request that finishes after midnight cannot by itself look like
   * activity on the new day; a new day is recorded only by a real trigger.
   */
  private drainQueue(): void {
    if (this.stopped || this.inFlight) {
      return;
    }
    // Retries and the queue behind a request reach here without `attempt()`, possibly long
    // after the last check: what has aged out since is dropped, not sent to be refused.
    this.prunePending();
    // An earlier launch's undelivered reports go first, focused or not: they describe activity
    // that already happened in the foreground, and they are the ones closest to ageing out.
    const pending = this.state.pending[0];
    if (pending) {
      this.send(pending);
    }
  }

  /** Queues today's (device, user) combination, once, whether or not it can leave yet. */
  private recordCurrentCombination(): void {
    if (!this.hasForeground) {
      return;
    }
    const userId = this.getUser()?.id ?? '';
    // The application version is part of what was reported: an upgrade the same day is
    // reported for the new version too, the intake keeping a row per version.
    const combination = combinationOf(this.anonymousId, userId, this.config.version ?? '');
    if (
      this.state.sent.includes(combination) ||
      // A report left over from an earlier day does not cover today's activity, even for the
      // same combination: it will be dated to its own first attempt when it finally leaves.
      this.state.pending.some(
        (candidate) => candidate.combination === combination && localDay(candidate.firstAttemptAt) === this.state.day
      )
    ) {
      return;
    }
    const report: ActiveBeaconBody = {
      service: this.config.service,
      ...(this.config.env ? { env: this.config.env } : {}),
      ...(this.config.version ? { version: this.config.version } : {}),
      build_version: '',
      sdk_version: __SDK_VERSION__,
      usr: {
        anonymous_id: this.anonymousId,
        ...(userId ? { id: userId } : {}),
      },
      os: platformOS(),
      device: platformDevice(),
    };
    // Kept before it is sent, not after: a process that exits a second later has already lost
    // its request, and the next launch is what delivers this one.
    this.state.pending.push({ combination, report, firstAttemptAt: Date.now() });
    this.prunePending();
    this.persist();
  }

  private send(pending: PendingReport): void {
    const controller = new AbortController();
    this.inFlight = controller;
    this.inFlightReport = pending;
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    void this.request(pending, controller.signal)
      .catch((error: unknown): RequestOutcome => {
        // Not a network failure — those are outcomes — but a bug: reported, and not retried.
        addError(error);
        return 'rejected';
      })
      .then((outcome) => {
        clearTimeout(timeoutId);
        if (this.inFlight !== controller) {
          return;
        }
        this.inFlight = undefined;
        this.inFlightReport = undefined;
        if (this.stopped) {
          return;
        }
        if (outcome === 'accepted') {
          this.failedAttempts = 0;
          this.state.pending = this.state.pending.filter((candidate) => candidate !== pending);
          this.markSent(pending);
          this.persist();
          // Only what a real trigger already queued goes out next; completing a request —
          // possibly after midnight — is not itself activity on a new day.
          this.drainQueue();
        } else if (outcome === 'rejected') {
          // The server answered about this report itself; asking again would get the same
          // answer. Like the Browser SDK, the combination counts as dealt with for today —
          // otherwise every focus or user change re-asks a refusing intake all day long.
          // Tomorrow it is asked again, when the refusal may no longer apply.
          this.failedAttempts = 0;
          this.state.pending = this.state.pending.filter((candidate) => candidate !== pending);
          this.markSent(pending);
          this.persist();
          // Whatever was queued behind it still goes out; only this one was refused.
          this.drainQueue();
        } else {
          this.scheduleRetry();
        }
      });
  }

  private scheduleRetry(): void {
    if (this.failedAttempts >= RETRY_DELAYS.length) {
      this.failedAttempts = 0;
      return;
    }
    // ±20%: an endpoint incident aligns every failed client's retry clock, and recovery would
    // otherwise be greeted by the whole fleet at once.
    const delay = RETRY_DELAYS[this.failedAttempts] * (0.8 + 0.4 * Math.random());
    this.failedAttempts += 1;
    this.retryTimeoutId = setTimeout(() => {
      this.retryTimeoutId = undefined;
      // A retry re-sends what is already queued; it must not record a new day by itself.
      this.drainQueue();
    }, delay);
  }

  private async request(pending: PendingReport, signal: AbortSignal): Promise<RequestOutcome> {
    let response: Response;
    try {
      response = await fetch(this.buildUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'DD-API-KEY': this.config.clientToken,
          'User-Agent': getUserAgent(),
        },
        body: JSON.stringify({ ...pending.report, age_ms: Math.max(0, Date.now() - pending.firstAttemptAt) }),
        signal,
      });
    } catch {
      // Offline, refused, or timed out. (Aborted by `stop` lands here too, and is sorted out
      // there: the caller sees the controller is no longer the one in flight and does nothing.)
      return 'retry';
    }
    // Nothing in the answer is read; the status is the whole of it.
    void response.body?.cancel().catch(() => undefined);
    if (response.status >= 200 && response.status < 300) {
      return 'accepted';
    }
    return response.status === 429 || response.status >= 500 ? 'retry' : 'rejected';
  }

  private buildUrl(): string {
    const { clientToken, proxy, site } = this.config;
    // The token is the whole of what the query carries; everything else is in the body.
    // Behind a proxy, it travels inside `ddforward` like every other request.
    const pathAndQuery = `${ACTIVE_PATH}?dd-api-key=${encodeURIComponent(clientToken)}`;
    return proxy ? `${proxy}?ddforward=${encodeURIComponent(pathAndQuery)}` : `https://${site}${pathAndQuery}`;
  }

  private rollDay(): void {
    const today = localDay(Date.now());
    if (this.state.day !== today) {
      this.state = { day: today, sent: [], pending: this.state.pending };
    }
  }

  /** Only a report about today earns the "already dealt with" shortcut; a stale one says nothing about today. */
  private markSent(pending: PendingReport): void {
    if (isToday(pending.firstAttemptAt) && !this.state.sent.includes(pending.combination)) {
      this.state.sent.push(pending.combination);
      this.state.sent = this.state.sent.slice(-MAX_SENT_COMBINATIONS);
    }
  }

  private prunePending(): void {
    const now = Date.now();
    const fresh = this.state.pending.filter((pending) => now - pending.firstAttemptAt < MAX_PENDING_AGE);
    let kept = fresh.slice(-MAX_PENDING_REPORTS);
    // The cap must not throw away the report that is already on the wire: if it is answered
    // with a failure there would be nothing left to retry.
    if (this.inFlightReport && fresh.includes(this.inFlightReport) && !kept.includes(this.inFlightReport)) {
      kept = [this.inFlightReport, ...kept.slice(0, MAX_PENDING_REPORTS - 1)];
    }
    this.state.pending = kept;
  }

  private persist(): void {
    void this.stateFile.write(() => JSON.stringify({ format: FILE_FORMAT, ...this.state }));
  }

  private writeSync(): void {
    let content: string;
    try {
      content = JSON.stringify({ format: FILE_FORMAT, ...this.state });
    } catch (error) {
      // Reported, not thrown: this runs on the way out of the process.
      displayError('Failed to serialize the active report state:', error);
      return;
    }
    this.stateFile.writeSync(content);
  }
}

function getFilePath(): string {
  return path.join(app.getPath('userData'), ACTIVE_PING_FILE_NAME);
}

function combinationOf(deviceKey: string, userId: string, version: string) {
  return [deviceKey, userId, version].map(encodeURIComponent).join('|');
}

/**
 * The platform facts the beacon carries. The OS name is spelled the way it lands on view rows
 * (where the intake derives it from the renderer's User-Agent), so filtering active rows by
 * operating system matches either writer. The version deliberately does not match: Chromium
 * freezes the version in its User-Agent (macOS always reads `10.15.7`, Windows only `10`), so
 * view rows carry that placeholder while this reports the real one (e.g. `15.3.0`,
 * `10.0.22631`). Device counts are unaffected; they are distinct over device ids.
 */
function platformOS(): { name: string; version: string } {
  const getSystemVersion = (process as NodeJS.Process & { getSystemVersion?: () => string }).getSystemVersion;
  const version = (typeof getSystemVersion === 'function' ? getSystemVersion() : '') || os.release();
  switch (process.platform) {
    case 'darwin':
      return { name: 'Mac OS X', version };
    case 'win32':
      return { name: 'Windows', version };
    default:
      return { name: os.type(), version };
  }
}

function platformDevice(): { type: string; model: string; brand: string } {
  switch (process.platform) {
    case 'darwin':
      return { type: 'Desktop', model: 'Mac', brand: 'Apple' };
    default:
      return { type: 'Desktop', model: '', brand: '' };
  }
}

function localDay(time: number) {
  const date = new Date(time);
  const month = `0${date.getMonth() + 1}`.slice(-2);
  const day = `0${date.getDate()}`.slice(-2);
  return `${date.getFullYear()}-${month}-${day}`;
}

function isToday(time: number) {
  return localDay(time) === localDay(Date.now());
}

/**
 * Storage is checked on the way out as strictly as a response would be on the way in: the file
 * sits in a directory the user and other applications can write, and survives SDK downgrades.
 * Anything unrecognisable reads as "nothing kept" rather than as a state to act on.
 */
function parseStoredFile(parsed: unknown): StoredState | undefined {
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const candidate = parsed as Partial<StoredFile>;
  if (
    candidate.format !== FILE_FORMAT ||
    typeof candidate.day !== 'string' ||
    !Array.isArray(candidate.sent) ||
    !Array.isArray(candidate.pending)
  ) {
    return undefined;
  }
  return {
    day: candidate.day,
    sent: candidate.sent.filter((entry): entry is string => typeof entry === 'string'),
    pending: candidate.pending.filter(isPendingReport),
  };
}

function isPendingReport(candidate: unknown): candidate is PendingReport {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }
  const { combination, report, firstAttemptAt } = candidate as Partial<PendingReport>;
  return (
    typeof combination === 'string' &&
    typeof firstAttemptAt === 'number' &&
    !!report &&
    typeof report === 'object' &&
    !!report.usr &&
    typeof report.usr === 'object' &&
    (typeof report.usr.anonymous_id === 'string' || typeof report.usr.id === 'string')
  );
}

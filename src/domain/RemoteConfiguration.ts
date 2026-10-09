import { app } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { deepClone, ONE_SECOND, type Subscription } from '@flashcatcloud/browser-core';
import type { Configuration } from '../config';
import { type AppMayExitEvent, EventKind, type EventManager, LifecycleKind, type SessionRenewEvent } from '../event';
import { displayWarn } from '../tools/display';
import { StateFile } from '../tools/StateFile';
import { isConfigurationVersion, type SamplingConfiguration, type SessionManager } from './session';
import { addError, setTimeout } from './telemetry';

export const REMOTE_CONFIGURATION_FILE_NAME = '_fc_remote_config';
const CONFIG_PATH = '/api/v2/rum/config';
/**
 * The response shape this SDK can read. The server stamps every response with it, and a value this
 * build does not recognise means the payload changed in a way it could misread — so the whole
 * response is discarded and the settings already in force are kept.
 */
const SUPPORTED_SCHEMA_VERSION = 1;
/** The shape of the file written here, not the SDK version: only a change of shape orphans it. */
const FILE_FORMAT = 1;
export const REQUEST_TIMEOUT = 10 * ONE_SECOND;
/**
 * A failed request is retried quickly, then patiently, then not until the next natural trigger (a
 * new session, or the next launch). Two extra requests per outage, so a fleet can never turn an
 * endpoint incident into a storm.
 */
export const RETRY_DELAYS = [5 * ONE_SECOND, 60 * ONE_SECOND];
/**
 * How old the configuration must be before a return to the foreground asks again, when the server
 * gives no `ttl`: the backend's own default.
 */
export const DEFAULT_TTL = 600 * ONE_SECOND;
/** The shortest `ttl` honoured, whatever the server sends: focus can come back many times a minute. */
export const MIN_TTL = 60 * ONE_SECOND;

/** What the console asks a running client to do about the session it already has. */
export const Activation = {
  /** Leave it as it is: the new values apply from the next session. The server's default. */
  NEXT_SESSION: 'next_session',
  /** End it where the new values are decisive for it, see `SessionManager.applySamplingChange`. */
  IMMEDIATE: 'immediate',
} as const;

/** The knobs this SDK reads. One the console did not set is absent, and the init value applies. */
interface RemoteValues {
  sessionSampleRate?: number;
  sessionOnError?: boolean;
}

/** The last configuration the server delivered and this SDK accepted. */
interface Delivered {
  /**
   * A publish counter that only goes up — a rollback is republished under a new number. 0 is what
   * an application with nothing published answers: no version was delivered, and none is reported.
   */
  version: number;
  values: RemoteValues;
  /** The application's own pass-through bag, handed to it verbatim by `getRemoteConfig()`. */
  custom?: Record<string, unknown>;
  /**
   * What it asked of a session already running, kept so that a launch resuming a session the
   * previous launch should have ended still ends it — see {@link RemoteConfiguration.start}.
   */
  activation: string;
  /**
   * When to ask again, as the server described it — stored with the values because a 304 or a
   * failure carries neither, and a client that settled on 304s must not forget its permission.
   * `ttl` is in seconds, absent when the server gave none.
   */
  ttl?: number;
  /**
   * Whether the operator allows asking again when the user comes back to the application. Off by
   * default: every client of a fleet comes back at about the same time, a burst on the endpoint.
   */
  refreshOnForeground: boolean;
}

/** What owns the sessions: the one that draws them, and is told when a change applies at once. */
type SessionOwner = Pick<SessionManager, 'getSession' | 'applySamplingChange'>;

/** A file written before these were kept has none: the next session, and no foreground refresh. */
interface StoredConfiguration extends Omit<Delivered, 'activation' | 'refreshOnForeground'> {
  activation?: string;
  refreshOnForeground?: boolean;
  format: typeof FILE_FORMAT;
  /**
   * The SDK that wrote the file. Another version may have read the same response differently — a
   * knob it did not know is missing from its values — and its ETag would keep that knob missing
   * through every 304. So the ETag of another version is not sent; its values still apply until
   * the full response replaces them, which keeps the first session after an upgrade on the
   * console's values rather than back on the init ones.
   */
  sdkVersion: string;
  /** Who the answer was for: it only applies to the same endpoint, application, env and version. */
  identity: string;
  etag?: string;
}

type RequestOutcome = 'done' | 'retry';

/**
 * The console's settings for this application, kept fresh and kept on disk.
 *
 * Sessions read the sampling from {@link getSampling} at each draw and never in between, so a
 * configuration arriving mid-session changes the next session, not this one. When the console asks
 * for a change to apply at once (`activation: immediate`), the owner of the sessions is told and
 * decides whether the running session has to end — see `SessionManager.applySamplingChange`.
 *
 * It asks at init and whenever a new session starts, as the other FlashCat SDKs do; there is no
 * timer between sessions. When the operator allows it (`refresh_on_foreground`), it also asks when
 * the user comes back to the application — a window of it gains focus — if what it holds is at least
 * `ttl` old (at least {@link MIN_TTL}, {@link DEFAULT_TTL} when the server gives none). There is
 * never more than one request in flight. Nothing waits on the network: the last good answer is read from disk at init, so a session drawn before the server
 * answers draws with it, and a request that fails, times out, or answers something unreadable
 * leaves the settings in force exactly as they were.
 *
 * The server pairs `Cache-Control: no-cache` with an `ETag`. Node's `fetch` has no HTTP cache to
 * revalidate with, so the ETag is kept here with the values it describes and sent back as
 * `If-None-Match`; a 304 then keeps what is held.
 *
 * Off unless `remoteConfigurationEnabled`: no request, no file, and the init values apply.
 */
export class RemoteConfiguration {
  private readonly stateFile = new StateFile(getFilePath(), 'remote configuration');
  private readonly identity: string;
  private delivered: Delivered | undefined;
  private etag: string | undefined;
  private inFlight: AbortController | undefined;
  private retryTimeoutId: ReturnType<typeof setTimeout> | undefined;
  private failedAttempts = 0;
  /** When the last request ended, however it ended: what a return to the foreground is gated on. */
  private lastFetchAt: number | undefined;
  /** An accepted configuration whose asynchronous write has not landed yet. */
  private unlanded: StoredConfiguration | undefined;
  private subscriptions: Subscription[] = [];
  private sessions: SessionOwner | undefined;
  /** Said once per launch: the server keeps answering the same way at every new session. */
  private warnedUnsupportedSchema = false;
  private stopped = false;

  private constructor(private readonly config: Configuration) {
    this.identity = JSON.stringify([config.proxy ?? config.site, config.applicationId, config.env, config.version]);
  }

  /** Reads the configuration the previous launch kept, if remote configuration is on. */
  static async init(config: Configuration): Promise<RemoteConfiguration> {
    const remoteConfiguration = new RemoteConfiguration(config);
    if (config.remoteConfigurationEnabled) {
      await remoteConfiguration.restore();
    }
    return remoteConfiguration;
  }

  /**
   * The sampling a draw made now would use: the console's value where it set one, the init value
   * where it did not, and the version they came from once a configuration has been delivered.
   */
  getSampling(): SamplingConfiguration {
    const values = this.delivered?.values ?? {};
    const version = this.deliveredVersion();
    return {
      sessionSampleRate: values.sessionSampleRate ?? this.config.sessionSampleRate,
      sessionOnError: values.sessionOnError ?? this.config.sessionOnError,
      ...(version === undefined ? {} : { rcVersion: version }),
    };
  }

  /** A copy of the application's `custom` values, or `undefined` when none were delivered. */
  getCustom(): Record<string, unknown> | undefined {
    return this.delivered?.custom && deepClone(this.delivered.custom);
  }

  /**
   * Judges a session resumed from a previous launch by the configuration that launch kept, when it
   * asked to apply at once and the session was drawn before it — under an older version, or none.
   * That launch ended the session in memory, but may have ended itself before the session file was
   * deleted. Called before anything is collected, so nothing of such a session is.
   */
  applyKept(sessions: SessionOwner): void {
    const kept = this.delivered;
    if (kept?.activation === Activation.IMMEDIATE && (sessions.getSession().rcVersion ?? -1) < kept.version) {
      sessions.applySamplingChange();
    }
  }

  /**
   * Starts keeping the configuration fresh, and tells `sessions` when a configuration that applies
   * at once has changed what a draw would read.
   */
  start(eventManager: EventManager, sessions: SessionOwner): void {
    if (!this.config.remoteConfigurationEnabled) {
      return;
    }
    this.sessions = sessions;
    this.subscriptions.push(
      eventManager.registerHandler<SessionRenewEvent>({
        canHandle: (event): event is SessionRenewEvent =>
          event.kind === EventKind.LIFECYCLE && event.lifecycle === LifecycleKind.SESSION_RENEW,
        handle: () => this.trigger(),
      }),
      eventManager.registerHandler<AppMayExitEvent>({
        canHandle: (event): event is AppMayExitEvent =>
          event.kind === EventKind.LIFECYCLE && event.lifecycle === LifecycleKind.APP_MAY_EXIT,
        handle: () => this.writePendingSync(),
      })
    );
    // Focus is how "the user came back" shows on a desktop: on every platform, unlike macOS's
    // `did-become-active`, and unlike `powerMonitor`'s `resume`, which is the machine waking rather
    // than anyone using the application — and which a focus follows when they do. Moving focus
    // between the application's own windows also counts, and is absorbed by the ttl.
    app.on('browser-window-focus', this.onForeground);
    // `quit` rather than the quit events before it: those can be cancelled, and this cannot be undone.
    app.on('quit', this.onQuit);
    this.trigger();
  }

  stop(): void {
    this.stopped = true;
    this.inFlight?.abort();
    this.inFlight = undefined;
    clearTimeout(this.retryTimeoutId);
    this.subscriptions.forEach((subscription) => subscription.unsubscribe());
    this.subscriptions = [];
    app.removeListener('browser-window-focus', this.onForeground);
    app.removeListener('quit', this.onQuit);
  }

  private readonly onQuit = () => this.stop();

  /** Asks again on a return to the foreground, if the operator allows it and what is held is stale. */
  private readonly onForeground = () => {
    const held = this.delivered;
    if (!held?.refreshOnForeground) {
      return;
    }
    if (this.lastFetchAt !== undefined && Date.now() - this.lastFetchAt < ttlOf(held)) {
      return;
    }
    this.trigger();
  };

  /**
   * Writes an accepted configuration whose write has not landed before returning, for a process
   * that may be about to exit: an emergency stop the session already obeyed must still be in force
   * at the next launch, offline included. A write requested earlier and landing later is discarded
   * by the file, so this one is not overwritten by an older state.
   */
  private writePendingSync(): void {
    if (this.unlanded) {
      this.stateFile.writeSync(JSON.stringify(this.unlanded));
      this.unlanded = undefined;
    }
  }

  /** The version delivered, or `undefined` when none was: version 0 means nothing is published. */
  private deliveredVersion(): number | undefined {
    return this.delivered && this.delivered.version > 0 ? this.delivered.version : undefined;
  }

  private async restore(): Promise<void> {
    this.stateFile.sweep();
    let stored: StoredConfiguration | undefined;
    try {
      stored = parseStoredConfiguration(JSON.parse(await fs.readFile(getFilePath(), 'utf-8')));
    } catch {
      // No file yet, or one that is not ours to read: the init values apply until the server answers.
      return;
    }
    if (stored === undefined || stored.identity !== this.identity) {
      return;
    }
    const { version, values, custom, activation, ttl, refreshOnForeground } = stored;
    this.delivered = {
      version,
      values,
      ...(custom ? { custom } : {}),
      activation: activation ?? Activation.NEXT_SESSION,
      ...(ttl === undefined ? {} : { ttl }),
      refreshOnForeground: refreshOnForeground ?? false,
    };
    this.etag = stored.sdkVersion === __SDK_VERSION__ ? stored.etag : undefined;
  }

  /** A natural trigger re-arms the whole backoff: a session starting mid-outage asks again at once. */
  private trigger(): void {
    clearTimeout(this.retryTimeoutId);
    this.retryTimeoutId = undefined;
    this.failedAttempts = 0;
    this.fetchNow();
  }

  private fetchNow(): void {
    if (this.stopped || this.inFlight) {
      return;
    }
    const controller = new AbortController();
    this.inFlight = controller;
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    void this.request(controller.signal)
      .catch((error: unknown): RequestOutcome => {
        // Not a network failure — those are outcomes — but a bug: reported, and not retried.
        addError(error);
        return 'done';
      })
      .then((outcome) => {
        clearTimeout(timeoutId);
        if (this.inFlight !== controller) {
          return;
        }
        this.inFlight = undefined;
        this.lastFetchAt = Date.now();
        if (outcome === 'retry') {
          this.scheduleRetry();
        }
      });
  }

  private scheduleRetry(): void {
    if (this.failedAttempts >= RETRY_DELAYS.length) {
      return;
    }
    // ±20%: an endpoint incident aligns every failed client's retry clock, and recovery would
    // otherwise be greeted by the whole fleet at once.
    const delay = RETRY_DELAYS[this.failedAttempts] * (0.8 + 0.4 * Math.random());
    this.failedAttempts += 1;
    this.retryTimeoutId = setTimeout(() => {
      this.retryTimeoutId = undefined;
      this.fetchNow();
    }, delay);
  }

  private async request(signal: AbortSignal): Promise<RequestOutcome> {
    let response: Response;
    let body: string;
    try {
      response = await fetch(this.buildUrl(), {
        headers: this.etag ? { 'If-None-Match': this.etag } : {},
        signal,
      });
      body = await response.text();
    } catch {
      // Offline, refused, timed out, or stopped.
      return 'retry';
    }
    if (signal.aborted) {
      return 'done';
    }
    if (response.status === 304) {
      // Only ever asked with an ETag, which only ever sits next to the values it describes.
      return this.delivered ? 'done' : 'retry';
    }
    if (response.status !== 200) {
      return response.status === 429 || response.status >= 500 ? 'retry' : 'done';
    }
    const parsed = parseResponse(body);
    if (parsed === undefined) {
      // A 200 is not proof the body came from the configuration endpoint: a captive portal or a
      // misrouted proxy answers 200 too. Storing that would blank the console's values.
      return 'retry';
    }
    if ('unsupportedSchema' in parsed) {
      if (!this.warnedUnsupportedSchema) {
        this.warnedUnsupportedSchema = true;
        displayWarn(
          `Remote configuration ignored: the server answered with schema_version ${parsed.unsupportedSchema}, which this SDK (${__SDK_VERSION__}) cannot read. The settings already in force (init values or the last good configuration) still apply; upgrading the SDK is the fix.`
        );
      }
      return 'done';
    }
    this.apply(parsed, response.headers.get('etag') ?? undefined);
    return 'done';
  }

  private apply(delivered: Delivered, etag: string | undefined): void {
    const held = this.delivered;
    // Settings only ever change under a higher number, so a lower one is an older answer arriving
    // late; applying it would put this client back on settings the console has already replaced.
    if (held !== undefined && delivered.version < held.version) {
      return;
    }
    this.delivered = delivered;
    this.etag = etag;
    const stored: StoredConfiguration = {
      format: FILE_FORMAT,
      sdkVersion: __SDK_VERSION__,
      identity: this.identity,
      ...delivered,
      ...(etag === undefined ? {} : { etag }),
    };
    this.unlanded = stored;
    void this.stateFile
      .write(() => JSON.stringify(stored))
      .then(() => {
        if (this.unlanded === stored) {
          this.unlanded = undefined;
        }
      });

    // The running session hears about a newly published version, and about the version it already
    // holds when this SDK reads it differently from the one that kept it — after an upgrade, a knob
    // the previous SDK did not read. A plain repeat, the ordinary answer, says nothing new; judging
    // the session again on it would be harmless, but it is not news.
    const isNew = held === undefined || delivered.version > held.version || !sameValues(held.values, delivered.values);
    if (isNew && delivered.activation === Activation.IMMEDIATE) {
      this.sessions?.applySamplingChange();
    }
  }

  private buildUrl(): string {
    const { clientToken, env, version, proxy, site } = this.config;
    const parameters = [
      `client_token=${encodeURIComponent(clientToken)}`,
      'sdk=electron',
      `sdk_version=${encodeURIComponent(__SDK_VERSION__)}`,
    ];
    if (env) {
      parameters.push(`env=${encodeURIComponent(env)}`);
    }
    if (version) {
      parameters.push(`app_version=${encodeURIComponent(version)}`);
    }
    // What lets the console tell how far a change has reached. Not for version 0, which is no
    // version: reporting it would count clients as running a configuration nobody published.
    const appliedVersion = this.deliveredVersion();
    if (appliedVersion !== undefined) {
      parameters.push(`applied_version=${appliedVersion}`);
    }
    // Behind a proxy, everything the intake has to see travels inside `ddforward`.
    const pathAndQuery = `${CONFIG_PATH}?${parameters.join('&')}`;
    return proxy ? `${proxy}?ddforward=${encodeURIComponent(pathAndQuery)}` : `https://${site}${pathAndQuery}`;
  }
}

/** How old what is held must be before a return to the foreground asks again, in milliseconds. */
function ttlOf({ ttl }: Delivered): number {
  return ttl === undefined ? DEFAULT_TTL : Math.max(ttl * ONE_SECOND, MIN_TTL);
}

function sameValues(a: RemoteValues, b: RemoteValues): boolean {
  return a.sessionSampleRate === b.sessionSampleRate && a.sessionOnError === b.sessionOnError;
}

/**
 * The configuration `text` holds, the schema version when it is one this SDK does not know, or
 * `undefined` for anything that is not recognisably a configuration response.
 *
 * Only the envelope decides that. A knob holding something that is not a rate or a switch is
 * dropped — it reads as "not delivered", and the init value stays — rather than refusing the
 * response, so one bad value cannot switch every other knob back off. The values and `custom` are
 * withheld while the kill switch (`enabled`) is off; the version is kept either way.
 */
function parseResponse(text: string): Delivered | { unsupportedSchema: number } | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isBag(body)) {
    return undefined;
  }
  if (body.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    return typeof body.schema_version === 'number' ? { unsupportedSchema: body.schema_version } : undefined;
  }
  const { version, enabled, rum, custom, activation, ttl } = body;
  if (!isConfigurationVersion(version) || typeof enabled !== 'boolean') {
    return undefined;
  }
  // Absent or null is an empty bag: a response with nothing set has no knobs to carry.
  if (rum !== undefined && rum !== null && !isBag(rum)) {
    return undefined;
  }
  const values: RemoteValues = {};
  if (enabled && isBag(rum)) {
    if (isRate(rum.sessionSampleRate)) {
      values.sessionSampleRate = rum.sessionSampleRate;
    }
    // A switch is a boolean or nothing: a "true" string or a 1 is dropped, not read as either.
    if (typeof rum.sessionOnError === 'boolean') {
      values.sessionOnError = rum.sessionOnError;
    }
  }
  return {
    version,
    values,
    ...(enabled && isBag(custom) ? { custom } : {}),
    activation: typeof activation === 'string' ? activation : Activation.NEXT_SESSION,
    ...(isPositiveInteger(ttl) ? { ttl } : {}),
    refreshOnForeground: body.refresh_on_foreground === true,
  };
}

/**
 * The file is checked on the way out as strictly as a response on the way in: anything on disk can
 * be edited by hand or left by another version. A file that does not hold a well-formed record is
 * no configuration at all, and the init values apply until the server answers.
 */
function parseStoredConfiguration(value: unknown): StoredConfiguration | undefined {
  if (!isBag(value) || value.format !== FILE_FORMAT) {
    return undefined;
  }
  const { sdkVersion, identity, version, values, custom, etag, activation } = value;
  if (typeof sdkVersion !== 'string' || typeof identity !== 'string' || !isConfigurationVersion(version)) {
    return undefined;
  }
  if (activation !== undefined && typeof activation !== 'string') {
    return undefined;
  }
  if (value.ttl !== undefined && !isPositiveInteger(value.ttl)) {
    return undefined;
  }
  if (value.refreshOnForeground !== undefined && typeof value.refreshOnForeground !== 'boolean') {
    return undefined;
  }
  if (!isBag(values) || (custom !== undefined && !isBag(custom)) || (etag !== undefined && typeof etag !== 'string')) {
    return undefined;
  }
  const { sessionSampleRate, sessionOnError } = values;
  if (sessionSampleRate !== undefined && !isRate(sessionSampleRate)) {
    return undefined;
  }
  if (sessionOnError !== undefined && typeof sessionOnError !== 'boolean') {
    return undefined;
  }
  return value as unknown as StoredConfiguration;
}

function isPositiveInteger(value: unknown): value is number {
  return isConfigurationVersion(value) && value > 0;
}

function isRate(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 100;
}

/** A keyed object, as opposed to an array or a primitive. */
function isBag(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getFilePath(): string {
  return path.join(app.getPath('userData'), REMOTE_CONFIGURATION_FILE_NAME);
}

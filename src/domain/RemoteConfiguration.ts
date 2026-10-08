import { app } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { deepClone, ONE_SECOND, type Subscription } from '@flashcatcloud/browser-core';
import type { Configuration } from '../config';
import { EventKind, type EventManager, LifecycleKind, type SessionRenewEvent } from '../event';
import { displayWarn } from '../tools/display';
import { StateFile } from '../tools/StateFile';
import { isConfigurationVersion, type SamplingConfiguration } from './session';
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
  /** A publish counter that only goes up — a rollback is republished under a new number. */
  version: number;
  values: RemoteValues;
  /** The application's own pass-through bag, handed to it verbatim by `getRemoteConfig()`. */
  custom?: Record<string, unknown>;
}

interface StoredConfiguration extends Delivered {
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
 * Fetching follows the sessions' rhythm, as in the other FlashCat SDKs: once at init and once
 * whenever a new session starts — a change can only matter at a draw, and every draw is a new
 * session. There is no timer between sessions; the server's `ttl` and `refresh_on_foreground` are
 * read by no one here. Nothing waits on the network: the last good answer is read from disk at init,
 * so the first session of a launch draws with it, and a request that fails, times out, or answers
 * something unreadable leaves the settings in force exactly as they were.
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
  private renewSubscription: Subscription | undefined;
  private onImmediateChange: () => void = () => undefined;
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
    return {
      sessionSampleRate: values.sessionSampleRate ?? this.config.sessionSampleRate,
      sessionOnError: values.sessionOnError ?? this.config.sessionOnError,
      ...(this.delivered ? { rcVersion: this.delivered.version } : {}),
    };
  }

  /** A copy of the application's `custom` values, or `undefined` when none were delivered. */
  getCustom(): Record<string, unknown> | undefined {
    return this.delivered?.custom && deepClone(this.delivered.custom);
  }

  /**
   * Fetches now and at every new session. `onImmediateChange` is called when a newly published
   * configuration asks to apply at once, after it is in force.
   */
  start(eventManager: EventManager, onImmediateChange: () => void): void {
    if (!this.config.remoteConfigurationEnabled) {
      return;
    }
    this.onImmediateChange = onImmediateChange;
    this.renewSubscription = eventManager.registerHandler<SessionRenewEvent>({
      canHandle: (event): event is SessionRenewEvent =>
        event.kind === EventKind.LIFECYCLE && event.lifecycle === LifecycleKind.SESSION_RENEW,
      handle: () => this.trigger(),
    });
    this.trigger();
  }

  stop(): void {
    this.stopped = true;
    this.inFlight?.abort();
    this.inFlight = undefined;
    clearTimeout(this.retryTimeoutId);
    this.renewSubscription?.unsubscribe();
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
    const { version, values, custom } = stored;
    this.delivered = { version, values, ...(custom ? { custom } : {}) };
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
    if (parsed === 'unsupported') {
      if (!this.warnedUnsupportedSchema) {
        this.warnedUnsupportedSchema = true;
        displayWarn('Remote configuration ignored: the server answered with a schema this SDK cannot read.');
      }
      return 'done';
    }
    if (parsed === undefined) {
      // A 200 is not proof the body came from the configuration endpoint: a captive portal or a
      // misrouted proxy answers 200 too. Storing that would blank the console's values.
      return 'retry';
    }
    this.apply(parsed, response.headers.get('etag') ?? undefined);
    return 'done';
  }

  private apply({ activation, ...delivered }: ParsedResponse, etag: string | undefined): void {
    const heldVersion = this.delivered?.version;
    // Settings only ever change under a higher number, so a lower one is an older answer arriving
    // late; applying it would put this client back on settings the console has already replaced.
    if (heldVersion !== undefined && delivered.version < heldVersion) {
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
    void this.stateFile.write(() => JSON.stringify(stored));

    // A repeat of the version already held is the ordinary answer, and it brings nothing new: the
    // running session must hear about published changes only, or it would be re-judged at every
    // renewal for nothing.
    const isNew = heldVersion === undefined || delivered.version > heldVersion;
    if (isNew && activation === Activation.IMMEDIATE) {
      this.onImmediateChange();
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
    // What lets the console tell how far a change has reached. 0 is a version like any other.
    if (this.delivered) {
      parameters.push(`applied_version=${this.delivered.version}`);
    }
    // Behind a proxy, everything the intake has to see travels inside `ddforward`.
    const pathAndQuery = `${CONFIG_PATH}?${parameters.join('&')}`;
    return proxy ? `${proxy}?ddforward=${encodeURIComponent(pathAndQuery)}` : `https://${site}${pathAndQuery}`;
  }
}

interface ParsedResponse extends Delivered {
  activation: string;
}

/**
 * The configuration `text` holds, `'unsupported'` for a schema this SDK does not know, or
 * `undefined` for anything that is not recognisably a configuration response.
 *
 * Only the envelope decides that. A knob holding something that is not a rate or a switch is
 * dropped — it reads as "not delivered", and the init value stays — rather than refusing the
 * response, so one bad value cannot switch every other knob back off. The values and `custom` are
 * withheld while the kill switch (`enabled`) is off; the version is kept either way.
 */
function parseResponse(text: string): ParsedResponse | 'unsupported' | undefined {
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
    return typeof body.schema_version === 'number' ? 'unsupported' : undefined;
  }
  const { version, enabled, rum, custom, activation } = body;
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
  const { sdkVersion, identity, version, values, custom, etag } = value;
  if (typeof sdkVersion !== 'string' || typeof identity !== 'string' || !isConfigurationVersion(version)) {
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

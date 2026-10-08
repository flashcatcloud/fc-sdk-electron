import {
  ONE_KIBI_BYTE,
  ONE_MEBI_BYTE,
  ONE_SECOND,
  DefaultPrivacyLevel,
  isPercentage,
} from '@flashcatcloud/browser-core';
import { displayError, displayWarn } from './tools/display';

/**
 * Intake host used when `site` is omitted.
 *
 * `site` is used verbatim as the intake host (see transport/utils.ts), mirroring the
 * FlashCat browser-sdk fork. There is deliberately no list of accepted hosts, so
 * self-hosted deployments can point at their own intake. Note that the URL template
 * hardcodes `https://`, so an intake served over plain HTTP must be reached through
 * `proxy` instead.
 */
export const DEFAULT_SITE = 'browser.flashcat.cloud';

export const BatchSizes = {
  SMALL: 16 * ONE_KIBI_BYTE,
  MEDIUM: 512 * ONE_KIBI_BYTE,
  LARGE: 4 * ONE_MEBI_BYTE,
} as const;

export const BatchUploadFrequencies = {
  RARE: 30 * ONE_SECOND,
  NORMAL: 10 * ONE_SECOND,
  FREQUENT: 5 * ONE_SECOND,
} as const;

export type BatchSize = 'SMALL' | 'MEDIUM' | 'LARGE';
export type UploadFrequency = 'RARE' | 'NORMAL' | 'FREQUENT';

export interface InitConfiguration {
  /** Intake host, used verbatim. Defaults to {@link DEFAULT_SITE}. */
  site?: string;
  proxy?: string;
  service: string;
  clientToken: string;
  applicationId: string;
  env?: string;
  version?: string;
  /**
   * Percentage of sessions collected (0–100). Defaults to `100`. Drawn once per session, in the main
   * process, and it applies to the renderer events that reach it over the bridge too.
   */
  sessionSampleRate?: number;
  /**
   * Keep collecting the sessions `sessionSampleRate` did not draw, but upload them only if they
   * report an error. Defaults to `false`.
   *
   * Such a session holds the last minute of its events in memory and uploads nothing; at its first
   * error it hands that minute to the upload batch along with the error, 0–3 s later, then reports
   * as it happens like any other session. A session that ends without an error is thrown away
   * whole. It only applies to what the plain rate missed, so with the default `sessionSampleRate`
   * of 100 there is nothing left for it to apply to.
   */
  sessionOnError?: boolean;
  /**
   * Let the console change `sessionSampleRate` and `sessionOnError` without a new release of the
   * application, and deliver the application's own `custom` values (see `getRemoteConfig()`).
   * Defaults to `false`: nothing is requested and the init values apply.
   *
   * The main process asks for the configuration at init and whenever a new session starts, and
   * keeps the last good answer on disk, so the next launch draws its first session with it before
   * the network answers. A delivered value takes precedence over the init value; a value the
   * console did not set leaves the init value in place. A change applies to the next session,
   * unless the console asks for it to apply at once — see the README, Remote configuration.
   *
   * Set it here, in the main process, and not in the renderers' browser SDK: the main process owns
   * the sessions and their sampling, and a renderer under the bridge ignores its own.
   */
  remoteConfigurationEnabled?: boolean;
  telemetrySampleRate?: number;
  batchSize?: BatchSize;
  uploadFrequency?: UploadFrequency;
  defaultPrivacyLevel?: DefaultPrivacyLevel;
  allowedWebViewHosts?: string[];
  /**
   * Rebase the paint metrics (FCP / LCP) of pre-warmed windows onto the moment the window first
   * became visible, the way the Paint Timing spec handles prerendered pages. Defaults to `true`.
   *
   * Turn it off to report the raw document-level timings instead — an application that pre-creates
   * hidden windows will then see its FCP/LCP inflated by the whole pre-warm interval.
   *
   * @see ViewTimingCorrector
   */
  correctPrewarmedViewTimings?: boolean;
  /**
   * Rewrite the absolute file paths in error stacks to `app:///<path relative to the app root>`,
   * so uploaded sourcemaps match regardless of where the application was installed. Defaults to
   * `true`.
   *
   * Turn it off to report the raw runtime paths instead — sourcemap un-minification then only
   * works for installations whose paths match the ones the sourcemaps were uploaded under.
   *
   * @see StackPathNormalizer
   */
  normalizeStackPaths?: boolean;
  /**
   * Rewrite a stack frame's absolute path before the built-in `app:///` normalization runs.
   * Return `undefined` to fall through to the built-in behaviour, or a string to use verbatim.
   *
   * Reach for this when a single application root cannot express the mapping — for instance a
   * build that emits to `<app root>/public/dist` but uploads its sourcemaps under `/dist`:
   *
   * ```ts
   * normalizeStackPath: (absolutePath) => {
   *   const match = /\/public(\/dist\/.+)$/.exec(absolutePath);
   *   return match ? match[1] : undefined;
   * };
   * ```
   *
   * Applies to main-process and renderer frames alike. A callback that throws is reported as an
   * SDK error and the frame falls back to the built-in behaviour.
   */
  normalizeStackPath?: (absolutePath: string) => string | undefined;
}

export interface Configuration {
  site: string;
  service: string;
  clientToken: string;
  applicationId: string;
  env?: string;
  version?: string;
  proxy?: string;
  sessionSampleRate: number;
  sessionOnError: boolean;
  remoteConfigurationEnabled: boolean;
  telemetrySampleRate: number;
  batchSize?: BatchSize;
  uploadFrequency?: UploadFrequency;
  defaultPrivacyLevel: DefaultPrivacyLevel;
  allowedWebViewHosts: string[];
  correctPrewarmedViewTimings: boolean;
  normalizeStackPaths: boolean;
  normalizeStackPath?: (absolutePath: string) => string | undefined;
}

function validateRequiredString(value: unknown, fieldName: string): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    displayError(`Configuration error: '${fieldName}' must be a non-empty string`);
    return undefined;
  }
  return value;
}

function validateSite(value: unknown): string | undefined {
  // Omitted — fall back to the default intake host rather than failing init.
  if (value === undefined || value === null) {
    return DEFAULT_SITE;
  }
  if (typeof value !== 'string' || value.length === 0) {
    displayError("Configuration error: 'site' must be a non-empty string");
    return undefined;
  }
  return value;
}

function validateOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  return value.length > 0 ? value : undefined;
}

/** Same contract as the browser SDK: an out-of-range rate fails `init` rather than being guessed at. */
function isValidSessionSampleRate(value: unknown): boolean {
  if (value !== undefined && value !== null && !isPercentage(value)) {
    displayError("SDK initialization failed: 'sessionSampleRate' must be a finite number from 0 to 100");
    return false;
  }
  return true;
}

function validateTelemetrySampleRate(value: unknown): number {
  if (value === undefined || value === null) {
    return 20;
  }
  if (typeof value !== 'number' || value < 0 || value > 100) {
    displayError("Configuration error: 'telemetrySampleRate' must be a number between 0 and 100");
    return 20;
  }
  return value;
}

const VALID_PRIVACY_LEVELS: readonly DefaultPrivacyLevel[] = [
  DefaultPrivacyLevel.MASK,
  DefaultPrivacyLevel.ALLOW,
  DefaultPrivacyLevel.MASK_USER_INPUT,
];

function validateDefaultPrivacyLevel(value: unknown): DefaultPrivacyLevel {
  if (value === undefined || value === null) {
    return DefaultPrivacyLevel.MASK;
  }
  if (typeof value !== 'string' || !(VALID_PRIVACY_LEVELS as readonly string[]).includes(value)) {
    displayError(`Configuration error: 'defaultPrivacyLevel' must be one of: ${VALID_PRIVACY_LEVELS.join(', ')}`);
    return DefaultPrivacyLevel.MASK;
  }
  return value as DefaultPrivacyLevel;
}

function validateOptionalBoolean(value: unknown, fieldName: string, defaultValue: boolean): boolean {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== 'boolean') {
    displayError(`Configuration error: '${fieldName}' must be a boolean`);
    return defaultValue;
  }
  return value;
}

function validateOptionalCallback<T>(value: unknown, fieldName: string): T | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'function') {
    displayError(`Configuration error: '${fieldName}' must be a function`);
    return undefined;
  }
  return value as T;
}

function validateAllowedWebViewHosts(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    displayError("Configuration error: 'allowedWebViewHosts' must be an array of strings");
    return [];
  }
  return value;
}

export function buildConfiguration(initConfig: InitConfiguration): Configuration | undefined {
  const service = validateRequiredString(initConfig.service, 'service');
  const clientToken = validateRequiredString(initConfig.clientToken, 'clientToken');
  const applicationId = validateRequiredString(initConfig.applicationId, 'applicationId');
  const site = validateSite(initConfig.site);

  if (
    service === undefined ||
    clientToken === undefined ||
    applicationId === undefined ||
    site === undefined ||
    !isValidSessionSampleRate(initConfig.sessionSampleRate)
  ) {
    return undefined;
  }

  const proxy = validateOptionalString(initConfig.proxy);
  const sessionSampleRate = initConfig.sessionSampleRate ?? 100;
  const sessionOnError = validateOptionalBoolean(initConfig.sessionOnError, 'sessionOnError', false);
  const remoteConfigurationEnabled = validateOptionalBoolean(
    initConfig.remoteConfigurationEnabled,
    'remoteConfigurationEnabled',
    false
  );
  // Not with remote configuration: the console may lower the rate the switch then applies to.
  if (sessionOnError && sessionSampleRate === 100 && !remoteConfigurationEnabled) {
    displayWarn(
      'sessionOnError does not affect new sessions at sessionSampleRate 100. Resumed sessions retain their previous sampling decision.'
    );
  }

  return {
    site,
    service,
    clientToken,
    applicationId,
    env: validateOptionalString(initConfig.env),
    version: validateOptionalString(initConfig.version),
    proxy,
    sessionSampleRate,
    sessionOnError,
    remoteConfigurationEnabled,
    telemetrySampleRate: validateTelemetrySampleRate(initConfig.telemetrySampleRate),
    defaultPrivacyLevel: validateDefaultPrivacyLevel(initConfig.defaultPrivacyLevel),
    allowedWebViewHosts: validateAllowedWebViewHosts(initConfig.allowedWebViewHosts),
    correctPrewarmedViewTimings: validateOptionalBoolean(
      initConfig.correctPrewarmedViewTimings,
      'correctPrewarmedViewTimings',
      true
    ),
    normalizeStackPaths: validateOptionalBoolean(initConfig.normalizeStackPaths, 'normalizeStackPaths', true),
    normalizeStackPath: validateOptionalCallback<InitConfiguration['normalizeStackPath']>(
      initConfig.normalizeStackPath,
      'normalizeStackPath'
    ),
  };
}

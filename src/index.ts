import type { TimeStamp } from '@flashcatcloud/browser-core';
import { Assembly, createFormatHooks, registerCommonContext } from './assembly';
import type { InitConfiguration } from './config';
import { buildConfiguration } from './config';
import { RumCollection } from './domain/rum';
import { SessionManager } from './domain/session';
import { initAnonymousId } from './domain/AnonymousId';
import { UserContext, type User } from './domain/UserContext';
import { UserActivityTracker } from './domain/UserActivityTracker';
import { RendererRegistry } from './domain/RendererRegistry';
import { ViewTimingCorrector } from './domain/ViewTimingCorrector';
import { WindowVisibilityTracker } from './domain/WindowVisibilityTracker';
import { StackPathNormalizer } from './domain/StackPathNormalizer';
import type { ErrorOptions, FailureReason, FeatureOperationOptions } from './domain/rum';
import { callMonitored, startTelemetry } from './domain/telemetry';
import { EventManager } from './event';
import { BridgeHandler } from './bridge';
import { Transport } from './transport';
import { Tracing } from './domain/tracing/Tracing';
import { SpanProcessor } from './domain/tracing/SpanProcessor';

let sessionManager: SessionManager | undefined;
let eventManager: EventManager | undefined;
let transport: Transport | undefined;
let rumApi: ReturnType<RumCollection['getApi']> | undefined;
let tracing: Tracing | undefined;
let userContext: UserContext | undefined;

/**
 * Initialize the Electron SDK
 */
export async function init(configuration: InitConfiguration): Promise<boolean> {
  const config = buildConfiguration(configuration);

  if (!config) {
    return false;
  }

  tracing = new Tracing();

  eventManager = new EventManager();
  const hooks = createFormatHooks();

  const anonymousId = await initAnonymousId();
  const context = await UserContext.init(eventManager);
  userContext = context;
  // Looked up per event by start time rather than captured: a native crash is assembled on the
  // next startup carrying the crash's own timestamp, so "who is logged in now" is the wrong
  // question to ask of it. See `UserContext`.
  const getUserAt = (startTime: TimeStamp) => context.find(startTime);

  registerCommonContext(config, hooks, anonymousId, getUserAt);
  startTelemetry(eventManager, config);
  const manager = await SessionManager.start(eventManager, hooks);
  sessionManager = manager;

  const rendererRegistry = new RendererRegistry();
  const stackPathNormalizer = await StackPathNormalizer.create(config.normalizeStackPaths, config.normalizeStackPath);

  // Observing window visibility is only useful to the correction it feeds.
  if (config.correctPrewarmedViewTimings) {
    new WindowVisibilityTracker(rendererRegistry);
  }

  new Assembly(eventManager, hooks, getUserAt);
  // Only the fields the renderer bridge reads: they are returned over a synchronous IPC channel,
  // which can carry structured-cloneable data only — a callback would throw there. The session id
  // is read through a getter rather than captured, because it changes as the session is renewed.
  new BridgeHandler(
    eventManager,
    {
      defaultPrivacyLevel: config.defaultPrivacyLevel,
      allowedWebViewHosts: config.allowedWebViewHosts,
      anonymousId,
    },
    () => getActiveSessionId(manager),
    () => context.get(),
    rendererRegistry,
    new ViewTimingCorrector(rendererRegistry, config.correctPrewarmedViewTimings),
    stackPathNormalizer
  );
  new UserActivityTracker(eventManager);

  if (tracing.enabled) {
    new SpanProcessor(eventManager, hooks, config);
  }

  transport = await Transport.create(config, eventManager);
  const rum = await RumCollection.start(eventManager, hooks, rendererRegistry, stackPathNormalizer);
  rumApi = rum.getApi();

  return true;
}

/**
 * Id of the session renderers should attribute their events to, or `''` while none is active —
 * an expired session must not keep collecting renderer data under its old id.
 */
function getActiveSessionId(manager: SessionManager): string {
  const session = manager.getSession();
  return session.status === 'active' ? session.id : '';
}

/**
 * Stop the current session
 */
export function stopSession(): void {
  callMonitored(() => sessionManager?.expire());
}

/**
 * Identify the logged-in user. The identity is attached to every subsequent main-process event and
 * to the renderer events that reach the main process over the bridge.
 *
 * An `id` is required; a call without one is ignored with a warning, as is one whose `name` or
 * `email` is not a string — a half-applied identity is harder to notice than none at all. Only
 * `id`, `name` and `email` are read; any other property is dropped.
 *
 * This does **not** touch `usr.anonymous_id`. The two identifiers coexist by design: the anonymous
 * id is device-scoped and stable across logins, and unique users are counted off it first.
 *
 * The name matches `flashcatRum.setUser()` in `@flashcatcloud/browser-rum`, so both processes of
 * the same application use one vocabulary.
 *
 * @example
 * setUser({ id: 'user-123', name: 'Alice', email: 'alice@example.com' });
 * // Later, when the user logs out:
 * clearUser();
 */
export function setUser(user: User): void {
  callMonitored(() => userContext?.set(user));
}

/**
 * The identity currently set through {@link setUser}, or `undefined` when nobody is logged in.
 * Returns a copy — mutating it changes nothing.
 */
export function getUser(): User | undefined {
  return callMonitored(() => userContext?.get());
}

/**
 * Forget the identity set through {@link setUser}, for instance on logout.
 *
 * Subsequent events carry no `usr.id` **at all**, rather than an empty one: unique users are
 * counted off `NULLIF(usr_id, '')`, where an absent field and an empty string are different rows.
 * Events already reported keep the identity they were reported with, and events describing a
 * moment before the logout still resolve to the user who was logged in then.
 *
 * `usr.anonymous_id` is unaffected — the device is still the same device.
 */
export function clearUser(): void {
  callMonitored(() => userContext?.clear());
}

/**
 * Report a manually handled error
 */
export function addError(error: unknown, options?: ErrorOptions): void {
  callMonitored(() => rumApi?.addError(error, options));
}

/**
 * Start a RUM Operation step.
 *
 * Pair every `startOperation` with exactly one `succeedOperation` or `failOperation`.
 * Use `options.operationKey` to distinguish parallel operations sharing the same name.
 *
 * @experimental This API is in preview and may change in future releases.
 * @see README "Operation Monitoring" for usage details.
 */
export function startOperation(name: string, options?: FeatureOperationOptions): void {
  callMonitored(() => rumApi?.startOperation(name, options));
}

/**
 * Record the successful completion of a RUM Operation started with `startOperation`.
 *
 * Pass the same `name` (and `operationKey`, if any) that was used when starting the operation.
 *
 * @experimental This API is in preview and may change in future releases.
 * @see README "Operation Monitoring" for usage details.
 */
export function succeedOperation(name: string, options?: FeatureOperationOptions): void {
  callMonitored(() => rumApi?.succeedOperation(name, options));
}

/**
 * Record the failure of a RUM Operation started with `startOperation`.
 *
 * Pass the same `name` (and `operationKey`, if any) that was used when starting the operation.
 *
 * @experimental This API is in preview and may change in future releases.
 * @see README "Operation Monitoring" for usage details.
 */
export function failOperation(name: string, failureReason: FailureReason, options?: FeatureOperationOptions): void {
  callMonitored(() => rumApi?.failOperation(name, failureReason, options));
}

/**
 * @deprecated Use `startOperation` instead. This alias exists for backwards compatibility with the API name used in
 * early previews and will be removed in a future major release.
 *
 * @experimental This API is in preview and may change in future releases.
 * @see README "Operation Monitoring" for usage details.
 */
export function startFeatureOperation(name: string, options?: FeatureOperationOptions): void {
  callMonitored(() => rumApi?.startFeatureOperation(name, options));
}

/**
 * @deprecated Use `succeedOperation` instead. This alias exists for backwards compatibility with the API name used in
 * early previews and will be removed in a future major release.
 *
 * @experimental This API is in preview and may change in future releases.
 * @see README "Operation Monitoring" for usage details.
 */
export function succeedFeatureOperation(name: string, options?: FeatureOperationOptions): void {
  callMonitored(() => rumApi?.succeedFeatureOperation(name, options));
}

/**
 * @deprecated Use `failOperation` instead. This alias exists for backwards compatibility with the API name used in
 * early previews and will be removed in a future major release.
 *
 * @experimental This API is in preview and may change in future releases.
 * @see README "Operation Monitoring" for usage details.
 */
export function failFeatureOperation(
  name: string,
  failureReason: FailureReason,
  options?: FeatureOperationOptions
): void {
  callMonitored(() => rumApi?.failFeatureOperation(name, failureReason, options));
}

/**
 * Internal API to flush all pending batches to the intake
 */
export async function _flushTransport(): Promise<void> {
  await tracing?.flush();
  await transport?.flush();
}

/*
 * Internal API to test monitoring
 * TODO replace with the usage of another API when available
 */
export function _generateTelemetryError() {
  return callMonitored(() => {
    throw new Error('expected error');
  });
}

export type { InitConfiguration } from './config';
export type { User } from './domain/UserContext';
export type {
  FailureReason,
  FeatureOperationOptions,
  RumErrorEvent,
  RumResourceEvent,
  RumViewEvent,
  RumVitalEvent,
  RumVitalOperationStepEvent,
} from './domain/rum';
export type { TelemetryErrorEvent } from './domain/telemetry';

export { SESSION_TIME_OUT_DELAY } from './domain/session';

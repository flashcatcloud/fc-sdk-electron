import { Assembly, createFormatHooks, registerCommonContext } from './assembly';
import type { InitConfiguration } from './config';
import { buildConfiguration } from './config';
import { RumCollection } from './domain/rum';
import { SessionManager } from './domain/session';
import { initAnonymousId } from './domain/AnonymousId';
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

/**
 * Initialize the Electron SDK
 */
export async function init(configuration: InitConfiguration): Promise<boolean> {
  const config = buildConfiguration(configuration);

  if (!config) {
    return false;
  }

  // Before Transport.create(), so the SDK's own uploads are excluded from instrumentation before
  // the first one can happen.
  tracing = new Tracing(config);

  eventManager = new EventManager();
  const hooks = createFormatHooks();

  const anonymousId = await initAnonymousId();

  registerCommonContext(config, hooks, anonymousId);
  startTelemetry(eventManager, config);
  const manager = await SessionManager.start(eventManager, hooks);
  sessionManager = manager;

  const rendererRegistry = new RendererRegistry();
  const stackPathNormalizer = await StackPathNormalizer.create(config.normalizeStackPaths, config.normalizeStackPath);

  // Observing window visibility is only useful to the correction it feeds.
  if (config.correctPrewarmedViewTimings) {
    new WindowVisibilityTracker(rendererRegistry);
  }

  new Assembly(eventManager, hooks);
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

import { ipcMain } from 'electron';
import type { IpcMainEvent, WebContents } from 'electron';
import { DefaultPrivacyLevel } from '@flashcatcloud/browser-core';
import { EventKind, EventSource, EventFormat, LifecycleKind } from '../event';
import type { EventManager, LifecycleEvent, RawRumEvent } from '../event';
import { monitor, addError as addTelemetryError } from '../domain/telemetry';
import { BRIDGE_CHANNEL, CONFIG_CHANNEL, IDENTITY_CHANNEL } from '../common';
import type { BridgeConfig, IdentityUpdate } from '../common';
import type { RendererRegistry } from '../domain/RendererRegistry';
import type { ViewTimingCorrector } from '../domain/ViewTimingCorrector';
import type { StackPathNormalizer } from '../domain/StackPathNormalizer';

type BridgeEventType = 'rum' | 'log' | 'internal_telemetry';

interface BridgeEvent {
  eventType: BridgeEventType;
  event: unknown;
}

/** Subset of an assembled browser RUM event the main process reads for renderer attribution. */
interface BridgedRumEvent {
  view?: { id?: string; url?: string };
}

/** The part of the bridge configuration that is fixed for the lifetime of the SDK. */
export interface BridgeOptions {
  defaultPrivacyLevel: DefaultPrivacyLevel;
  allowedWebViewHosts: string[];
  anonymousId: string;
}

/**
 * Receives events from renderer processes via IPC and routes them through the
 * main-process EventManager pipeline.
 *
 * The SDK's preload script exposes a `DatadogEventBridge` to each renderer.
 * When the browser RUM SDK sends an event through the bridge,
 * it arrives here as a JSON string and is forwarded as a `RawRumEvent` (or, in
 * the future, a log / telemetry event) to the existing assembly & transport
 * chain.
 *
 * It also answers the renderers' identity questions. `anonymousId` never changes, so the
 * synchronous config channel carries it once; `sessionId` does, so it is pushed to every renderer
 * known to have a bridge whenever it changes — asking for it synchronously per event would be far
 * too slow.
 */
export class BridgeHandler {
  /** Renderers that asked for the configuration, and so hold a preload cache to keep up to date. */
  private readonly bridgedRenderers = new Set<WebContents>();

  constructor(
    private readonly eventManager: EventManager,
    private readonly bridgeOptions: BridgeOptions,
    private readonly getSessionId: () => string,
    private readonly rendererRegistry: RendererRegistry,
    private readonly viewTimingCorrector: ViewTimingCorrector,
    private readonly stackPathNormalizer: StackPathNormalizer
  ) {
    ipcMain.on(
      BRIDGE_CHANNEL,
      monitor((ipcEvent: IpcMainEvent, msg: string) => {
        this.onBridgeMessage(msg, ipcEvent?.sender?.id);
      })
    );

    ipcMain.on(
      CONFIG_CHANNEL,
      monitor((ipcEvent: IpcMainEvent) => {
        this.trackBridgedRenderer(ipcEvent?.sender);
        ipcEvent.returnValue = this.buildConfig();
      })
    );

    this.eventManager.registerHandler<LifecycleEvent>({
      canHandle: (event): event is LifecycleEvent =>
        event.kind === EventKind.LIFECYCLE &&
        (event.lifecycle === LifecycleKind.SESSION_RENEW || event.lifecycle === LifecycleKind.SESSION_EXPIRED),
      handle: monitor(() => {
        this.pushIdentity();
      }),
    });
  }

  private onBridgeMessage(msg: string, webContentsId: number | undefined): void {
    let bridgeEvent: BridgeEvent;
    try {
      bridgeEvent = JSON.parse(msg) as BridgeEvent;
    } catch {
      addTelemetryError(new Error(`Failed to parse bridge message: ${msg}`));
      return;
    }

    switch (bridgeEvent.eventType) {
      case 'rum':
        this.trackRenderer(bridgeEvent.event, webContentsId);
        // Both rewrite the event in place, before it is handed over: everything downstream
        // treats the bridged event as final. They are independent of one another and the order
        // between them does not matter — the correction only reads `type: 'view'` events and
        // only writes `view.*` paint metrics, the normalization only reads events carrying a
        // top-level `error` and only writes `error.stack`. Neither replaces the event object,
        // so neither can swallow the other.
        this.viewTimingCorrector.correct(bridgeEvent.event, webContentsId);
        this.stackPathNormalizer.normalizeRumEvent(bridgeEvent.event);
        this.eventManager.notify({
          kind: EventKind.RAW,
          source: EventSource.RENDERER,
          format: EventFormat.RUM,
          data: bridgeEvent.event,
        } as RawRumEvent);
        break;
      case 'log':
        // TODO(RUM-15047)
        break;
      case 'internal_telemetry':
        // TODO(RUM-15253)
        break;
      default:
        addTelemetryError(new Error(`Unhandled bridge event type: ${String(bridgeEvent.eventType)}`));
    }
  }

  /**
   * Remember which RUM view each renderer is on, keyed by the `webContents` that sent the event.
   * `ProcessGoneCollection` reads it back to attribute a renderer termination to the page that was
   * running, which is otherwise unknowable from the main process.
   */
  private trackRenderer(event: unknown, webContentsId: number | undefined): void {
    if (webContentsId === undefined) {
      return;
    }
    const view = (event as BridgedRumEvent | undefined)?.view;
    if (!view) {
      return;
    }
    this.rendererRegistry.set(webContentsId, { viewId: view.id, url: view.url });
  }

  /**
   * Only the fields the preload reads, and only plain data: this crosses a synchronous IPC channel,
   * which carries structured-cloneable values only — a function would throw there.
   */
  private buildConfig(): BridgeConfig {
    return { ...this.bridgeOptions, sessionId: this.getSessionId() };
  }

  private trackBridgedRenderer(sender: WebContents | undefined): void {
    if (!sender || this.bridgedRenderers.has(sender)) {
      return;
    }
    this.bridgedRenderers.add(sender);
    sender.once('destroyed', () => this.bridgedRenderers.delete(sender));
  }

  private pushIdentity(): void {
    const update: IdentityUpdate = { sessionId: this.getSessionId() };

    for (const sender of this.bridgedRenderers) {
      if (sender.isDestroyed()) {
        // 'destroyed' does not always fire before the renderer goes away, so prune here as well.
        this.bridgedRenderers.delete(sender);
        continue;
      }
      try {
        sender.send(IDENTITY_CHANNEL, update);
      } catch (error) {
        addTelemetryError(error);
      }
    }
  }
}

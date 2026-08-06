import { ipcMain, webContents } from 'electron';
import type { IpcMainEvent } from 'electron';
import { EventKind, EventSource, EventFormat, LifecycleKind } from '../event';
import type { EventManager, LifecycleEvent, RawRumEvent } from '../event';
import { monitor, addError as addTelemetryError } from '../domain/telemetry';
import { BRIDGE_CHANNEL, CONFIG_CHANNEL, CONFIG_PUSH_CHANNEL } from '../common';
import type { BridgeConfig } from '../common';
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

/**
 * The part of the bridge configuration that is fixed for the lifetime of the SDK — everything the
 * preload reads except the session id, which `buildConfig` adds as of the moment it is asked.
 * Derived from `BridgeConfig` so the two cannot drift as fields are added.
 */
export type BridgeOptions = Omit<BridgeConfig, 'sessionId'>;

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
 * It also answers the renderers' configuration questions. A renderer's preload caches the answer —
 * asking synchronously per event would be far too slow — so this class pushes a fresh configuration
 * whenever the cached one goes stale.
 */
export class BridgeHandler {
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

    // Supersede the fallback listener `installBridgePreload` left on this channel, rather than
    // adding to it: Electron answers a synchronous request with the *first* `returnValue` set, so
    // a surviving fallback would keep answering with its unconfigured placeholder. The channel is
    // private to the SDK, so there is nothing else here to remove.
    ipcMain.removeAllListeners(CONFIG_CHANNEL);
    ipcMain.on(
      CONFIG_CHANNEL,
      monitor((ipcEvent: IpcMainEvent) => {
        ipcEvent.returnValue = this.buildConfig();
      })
    );

    this.eventManager.registerHandler<LifecycleEvent>({
      canHandle: (event): event is LifecycleEvent =>
        event.kind === EventKind.LIFECYCLE &&
        (event.lifecycle === LifecycleKind.SESSION_RENEW || event.lifecycle === LifecycleKind.SESSION_EXPIRED),
      handle: monitor(() => {
        this.pushConfig();
      }),
    });

    // Renderers that started before this point were answered by the fallback listener and cached
    // its placeholder — no session, no device id. This is what corrects them, and it cannot arrive
    // too early to be heard: a renderer holds the placeholder only if it asked before this
    // constructor ran, and it subscribes to the push channel before it asks.
    this.pushConfig();
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

  /**
   * Send the current configuration to every live renderer.
   *
   * Every one of them, rather than a set of those known to have asked: a renderer that started
   * before this handler existed never reached it, and is exactly the one that most needs the
   * update. Renderers without a bridge — devtools, say — simply have no listener on the channel and
   * ignore the message, which costs nothing at the rate sessions change.
   */
  private pushConfig(): void {
    const config = this.buildConfig();

    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) {
        continue;
      }
      try {
        contents.send(CONFIG_PUSH_CHANNEL, config);
      } catch (error) {
        addTelemetryError(error);
      }
    }
  }
}

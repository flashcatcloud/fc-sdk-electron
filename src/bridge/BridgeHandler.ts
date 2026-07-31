import { ipcMain } from 'electron';
import type { IpcMainEvent } from 'electron';
import { DefaultPrivacyLevel } from '@flashcatcloud/browser-core';
import { EventKind, EventSource, EventFormat } from '../event';
import type { EventManager, RawRumEvent } from '../event';
import { monitor, addError as addTelemetryError } from '../domain/telemetry';
import { BRIDGE_CHANNEL, CONFIG_CHANNEL } from '../common';
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

export interface BridgeOptions {
  defaultPrivacyLevel: DefaultPrivacyLevel;
  allowedWebViewHosts: string[];
}

/**
 * Receives events from renderer processes via IPC and routes them through the
 * main-process EventManager pipeline.
 *
 * dd-trace's preload script exposes a `DatadogEventBridge` to each renderer.
 * When the browser RUM SDK sends an event through the bridge,
 * it arrives here as a JSON string and is forwarded as a `RawRumEvent` (or, in
 * the future, a log / telemetry event) to the existing assembly & transport
 * chain.
 */
export class BridgeHandler {
  constructor(
    private readonly eventManager: EventManager,
    private readonly bridgeOptions: BridgeOptions,
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
      monitor((event: { returnValue: unknown }) => {
        event.returnValue = this.bridgeOptions;
      })
    );
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
}

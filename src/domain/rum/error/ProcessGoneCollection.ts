import { app } from 'electron';
import type { Details, RenderProcessGoneDetails, WebContents } from 'electron';
import { generateUUID, timeStampNow } from '@flashcatcloud/browser-core';
import { EventFormat, EventKind, EventManager, EventSource } from '../../../event';
import type { RawRumError } from '../rawRumData.types';
import type { RendererRegistry } from '../../RendererRegistry';
import { monitor } from '../../telemetry';

type ExitReason = RenderProcessGoneDetails['reason'];

/**
 * Exit reasons that Crashpad turns into a minidump. Those terminations are already reported by
 * `CrashCollection`, which picks the dump up on the next launch and emits an `is_crash: true`
 * error; emitting them here too would double-report the same incident.
 *
 * `killed` is deliberately **not** in this set even though macOS's `forcefullyCrashRenderer()`
 * does produce a dump for it: on every other platform (and for every other way a renderer gets
 * killed — OOM killer, task manager, sandbox teardown) no dump is written at all. Reporting it
 * risks a rare duplicate; skipping it would silently drop a whole class of real terminations.
 */
const MINIDUMP_EXIT_REASONS: readonly ExitReason[] = ['crashed', 'oom'];

/** The process shut down on its own terms — not an incident, nothing to report. */
const EXPECTED_EXIT_REASONS: readonly ExitReason[] = ['clean-exit'];

/**
 * Collect RUM error events for process-level terminations reported by Electron:
 * `render-process-gone` (renderers, including `WebContentsView` and `<webview>`) and
 * `child-process-gone` (GPU, Utility, Zygote, …).
 *
 * Both listeners are bound to `app` rather than to individual `webContents`, so no renderer is
 * missed because it does not belong to a `BrowserWindow`.
 *
 * These events complement `CrashCollection` instead of overlapping with it: reasons that yield a
 * minidump are left to that collection, and the reasons handled here (`killed`, `abnormal-exit`,
 * `launch-failed`, `integrity-failure`, `memory-eviction`) produce no dump and would otherwise go
 * completely unreported. Any reason Electron adds in the future is reported by default, since a
 * new reason is far more likely to be dump-less than to be a crash.
 *
 * Events are emitted as regular RUM errors with `is_crash: false`: they describe a terminated
 * child process, not a crash of the host application, and the backend escalates every `is_crash`
 * error to a critical alert.
 *
 * Note that the main process cannot unwind the stack of a process that is already gone, so these
 * events carry no stacktrace.
 */
export class ProcessGoneCollection {
  private readonly renderProcessGoneListener: (
    event: unknown,
    webContents: WebContents,
    details: RenderProcessGoneDetails
  ) => void;
  private readonly childProcessGoneListener: (event: unknown, details: Details) => void;

  constructor(
    private readonly eventManager: EventManager,
    private readonly rendererRegistry: RendererRegistry
  ) {
    this.renderProcessGoneListener = monitor(
      (_event: unknown, webContents: WebContents, details: RenderProcessGoneDetails) =>
        this.onRenderProcessGone(webContents, details)
    );
    this.childProcessGoneListener = monitor((_event: unknown, details: Details) => this.onChildProcessGone(details));

    app.on('render-process-gone', this.renderProcessGoneListener);
    app.on('child-process-gone', this.childProcessGoneListener);
  }

  stop(): void {
    app.off('render-process-gone', this.renderProcessGoneListener);
    app.off('child-process-gone', this.childProcessGoneListener);
  }

  private onRenderProcessGone(webContents: WebContents, details: RenderProcessGoneDetails): void {
    const webContentsId = readWebContentsId(webContents);
    const renderer = webContentsId === undefined ? undefined : this.rendererRegistry.get(webContentsId);

    // The renderer is gone for good whatever the reason, so stop tracking it either way.
    if (webContentsId !== undefined) {
      this.rendererRegistry.delete(webContentsId);
    }

    if (isSilenced(details.reason)) {
      return;
    }

    this.emitProcessGoneEvent({
      message: `Renderer process gone: ${details.reason}`,
      errorType: 'RenderProcessGone',
      processName: 'renderer',
      reason: details.reason,
      exitCode: details.exitCode,
      // `getURL()` is still readable here — the webContents wrapper outlives the renderer process
      // — and is more accurate than the registry, which only knows urls seen through the bridge.
      url: readRendererUrl(webContents) ?? renderer?.url,
      viewId: renderer?.viewId,
    });
  }

  private onChildProcessGone(details: Details): void {
    if (isSilenced(details.reason)) {
      return;
    }

    this.emitProcessGoneEvent({
      message: `${details.type} process gone: ${details.reason}`,
      errorType: 'ChildProcessGone',
      processName: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
    });
  }

  private emitProcessGoneEvent(params: {
    message: string;
    errorType: string;
    processName: string;
    reason: ExitReason;
    exitCode: number;
    url?: string;
    viewId?: string;
  }): void {
    const startTime = timeStampNow();

    const errorEvent: RawRumError = {
      type: 'error',
      date: startTime,
      error: {
        id: generateUUID(),
        message: params.message,
        type: params.errorType,
        source: 'source',
        handling: 'unhandled',
        category: 'Exception',
        // Never `true`: see the class JSDoc — the host application is still alive.
        is_crash: false,
        meta: {
          process: params.processName,
          exit_reason: params.reason,
          exit_code: String(params.exitCode),
          ...(params.url ? { url: params.url } : {}),
        },
      },
      // Attribute the termination to the renderer's own RUM view, mirroring how renderer events
      // are stamped in `Assembly`. The event's own `view` stays the main-process view, added by
      // the view hook.
      ...(params.viewId ? { container: { view: { id: params.viewId }, source: 'electron' as const } } : {}),
    };

    this.eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.MAIN,
      format: EventFormat.RUM,
      data: errorEvent,
      startTime,
    });
  }
}

function isSilenced(reason: ExitReason): boolean {
  return MINIDUMP_EXIT_REASONS.includes(reason) || EXPECTED_EXIT_REASONS.includes(reason);
}

/** Reading a destroyed `webContents` throws, so every access is guarded. */
function readWebContentsId(webContents: WebContents): number | undefined {
  try {
    return webContents.id;
  } catch {
    return undefined;
  }
}

function readRendererUrl(webContents: WebContents): string | undefined {
  try {
    return webContents.getURL() || undefined;
  } catch {
    return undefined;
  }
}

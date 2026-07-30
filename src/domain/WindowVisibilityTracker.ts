import { app, BrowserWindow } from 'electron';
import type { RendererRegistry } from './RendererRegistry';
import { monitor } from './telemetry';

/**
 * A window that already existed when the SDK started may have been on screen for any amount of
 * time, so it is anchored at the epoch: `activationStart` then always clamps to `0` and its views
 * are never corrected, which is exactly what "it was already visible" should mean.
 */
const ALREADY_VISIBLE = 0;

/**
 * Records, per `BrowserWindow`, the first instant its window actually became visible on screen.
 *
 * Electron applications routinely pre-warm renderers: `new BrowserWindow({ show: false })` is
 * created (and navigated) long before the user ever sees it. Because `paintWhenInitiallyHidden`
 * defaults to `true`, such a page is `visible` as far as the web platform is concerned — it paints
 * normally and never fires a `visibilitychange` — so the browser SDK's `trackFirstHidden` guard,
 * which only looks at `document.visibilityState`, never trips. Any first paint the application
 * defers until `show()` is therefore reported verbatim, inflated by the whole pre-warm interval.
 *
 * Chromium does not treat a pre-created window as a prerender either: `activationStart` is always
 * `0` and `document.prerendering` always `false`, so the activation instant has to be observed
 * from the main process, which is the only place that knows the window lifecycle.
 *
 * `show` is the only correct signal for a pre-warmed window. `ready-to-show` is not: with the
 * default configuration it fires while the window is still hidden, and with
 * `paintWhenInitiallyHidden: false` it is delayed until after `show()` — it is wrong on both
 * sides.
 *
 * An ordinary window (`show: true`, the default) must not be anchored on its `show` event though:
 * that event only arrives once the platform has actually put the window on screen, ~90ms after
 * construction on macOS, which would deflate the paint metrics of every ordinary load. Such a
 * window is anchored on its creation instant instead, which precedes the navigation that starts
 * the view, so `activationStart` clamps to `0` and nothing is rewritten. Telling the two apart
 * requires deferring the `isVisible()` read by one tick: inside `browser-window-created` the
 * native window has not been shown yet and `isVisible()` returns `false` even for `show: true`.
 *
 * v1 covers `BrowserWindow` only. `WebContentsView` / `<webview>` have no `show` event; their
 * renderers stay unknown to this tracker and their timings are left untouched.
 *
 * @see ViewTimingCorrector for how the recorded instant is turned into an `activationStart`.
 */
export class WindowVisibilityTracker {
  private readonly windowCreatedListener: (event: unknown, window: BrowserWindow) => void;
  private stopped = false;

  constructor(private readonly rendererRegistry: RendererRegistry) {
    this.windowCreatedListener = monitor((_event: unknown, window: BrowserWindow) =>
      this.trackWindow(window, Date.now())
    );

    // Windows that already exist — the SDK is initialized asynchronously, so an application may
    // well have pre-warmed a window before `init()` resolved.
    for (const window of readExistingWindows()) {
      this.trackWindow(window, ALREADY_VISIBLE);
    }

    app.on('browser-window-created', this.windowCreatedListener);
  }

  stop(): void {
    this.stopped = true;
    app.off('browser-window-created', this.windowCreatedListener);
  }

  private trackWindow(window: BrowserWindow, createdAt: number): void {
    const webContentsId = readWebContentsId(window);
    if (webContentsId === undefined) {
      return;
    }

    this.rendererRegistry.trackWindowVisibility(webContentsId);

    // Deferred by one tick: see the class documentation — `isVisible()` is still `false` inside
    // `browser-window-created`, the native window is shown as the constructor finishes.
    setImmediate(
      monitor(() => {
        if (this.stopped) {
          return;
        }
        if (isVisible(window)) {
          this.rendererRegistry.recordFirstVisible(webContentsId, createdAt);
          return;
        }
        window.on(
          'show',
          monitor(() => this.rendererRegistry.recordFirstVisible(webContentsId, Date.now()))
        );
      })
    );
  }
}

/** Reading a destroyed window throws, so every access is guarded. */
function readExistingWindows(): BrowserWindow[] {
  try {
    return BrowserWindow.getAllWindows();
  } catch {
    return [];
  }
}

function readWebContentsId(window: BrowserWindow): number | undefined {
  try {
    return window.webContents.id;
  } catch {
    return undefined;
  }
}

function isVisible(window: BrowserWindow): boolean {
  try {
    return window.isVisible();
  } catch {
    return false;
  }
}

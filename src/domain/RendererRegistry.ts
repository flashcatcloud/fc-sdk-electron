/**
 * Tracks the last known RUM identity of every renderer process, keyed by `webContents.id`.
 *
 * Renderer RUM events reach the main process through the IPC bridge, where `ipcEvent.sender.id`
 * identifies the originating `webContents`. Recording the view id and url carried by those events
 * gives the main process a way to attribute a later renderer termination (`render-process-gone`)
 * to the page that was actually running — the crash callback itself only receives a `webContents`
 * handle, which is already being torn down.
 *
 * The registry also holds the window visibility timeline observed by `WindowVisibilityTracker`,
 * which `ViewTimingCorrector` reads back to rebase the paint metrics of pre-warmed windows.
 *
 * The same `webContents.id` is what the upstream Datadog SDK uses as the join key between a
 * process event and that process's RUM events, so this mapping stays compatible with it.
 */
export interface RendererInfo {
  /** RUM view id assembled by the browser SDK in the renderer process. */
  viewId?: string;
  /** Url of the document the renderer was displaying. */
  url?: string;
  /**
   * `true` once this `webContents` has been recognized as belonging to a `BrowserWindow` whose
   * visibility we observe. It is what tells "this window has never been shown" apart from "we know
   * nothing about this renderer" (a `WebContentsView`, a `<webview>`, or a window that already
   * existed before the SDK started).
   */
  visibilityTracked?: boolean;
  /**
   * Epoch ms of the first moment the window became visible; `undefined` while it has never been
   * shown. Only the *first* transition is kept — a window that is hidden and shown again keeps its
   * original activation instant, mirroring `PerformanceNavigationTiming.activationStart`, which is
   * likewise recorded once.
   */
  firstVisibleAt?: number;
}

/**
 * Upper bound on tracked renderers. Entries are only removed when a renderer is reported gone, so
 * a long-running app that opens and closes many windows would otherwise grow this map forever.
 * Eviction is insertion-ordered, which for `webContents.id` (monotonically increasing) means the
 * oldest renderer is dropped first.
 */
const MAX_TRACKED_RENDERERS = 100;

export class RendererRegistry {
  private readonly renderers = new Map<number, RendererInfo>();

  /** Record what is known about a renderer. Fields are merged, so partial updates keep prior values. */
  set(webContentsId: number, info: RendererInfo): void {
    this.merge(webContentsId, info);
  }

  get(webContentsId: number): RendererInfo | undefined {
    return this.renderers.get(webContentsId);
  }

  delete(webContentsId: number): void {
    this.renderers.delete(webContentsId);
  }

  /**
   * Declare that this renderer is hosted by a `BrowserWindow` whose visibility we observe, so a
   * missing `firstVisibleAt` can be read as "not shown yet" rather than "unknown".
   */
  trackWindowVisibility(webContentsId: number): void {
    this.merge(webContentsId, { visibilityTracked: true });
  }

  /** Record the first instant (epoch ms) the window became visible. Later shows are ignored. */
  recordFirstVisible(webContentsId: number, timeStamp: number): void {
    this.merge(webContentsId, { visibilityTracked: true, firstVisibleAt: timeStamp });
  }

  private merge(webContentsId: number, info: RendererInfo): void {
    const current = this.renderers.get(webContentsId);
    this.renderers.set(webContentsId, {
      viewId: info.viewId ?? current?.viewId,
      url: info.url ?? current?.url,
      visibilityTracked: info.visibilityTracked ?? current?.visibilityTracked,
      // First one wins: this is an activation instant, not a "last known" value.
      firstVisibleAt: current?.firstVisibleAt ?? info.firstVisibleAt,
    });

    if (this.renderers.size > MAX_TRACKED_RENDERERS) {
      const oldest = this.renderers.keys().next();
      if (!oldest.done) {
        this.renderers.delete(oldest.value);
      }
    }
  }
}

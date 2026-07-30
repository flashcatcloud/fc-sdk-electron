/**
 * Tracks the last known RUM identity of every renderer process, keyed by `webContents.id`.
 *
 * Renderer RUM events reach the main process through the IPC bridge, where `ipcEvent.sender.id`
 * identifies the originating `webContents`. Recording the view id and url carried by those events
 * gives the main process a way to attribute a later renderer termination (`render-process-gone`)
 * to the page that was actually running — the crash callback itself only receives a `webContents`
 * handle, which is already being torn down.
 *
 * The same `webContents.id` is what the upstream Datadog SDK uses as the join key between a
 * process event and that process's RUM events, so this mapping stays compatible with it.
 */
export interface RendererInfo {
  /** RUM view id assembled by the browser SDK in the renderer process. */
  viewId?: string;
  /** Url of the document the renderer was displaying. */
  url?: string;
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
    const current = this.renderers.get(webContentsId);
    this.renderers.set(webContentsId, {
      viewId: info.viewId ?? current?.viewId,
      url: info.url ?? current?.url,
    });

    if (this.renderers.size > MAX_TRACKED_RENDERERS) {
      const oldest = this.renderers.keys().next();
      if (!oldest.done) {
        this.renderers.delete(oldest.value);
      }
    }
  }

  get(webContentsId: number): RendererInfo | undefined {
    return this.renderers.get(webContentsId);
  }

  delete(webContentsId: number): void {
    this.renderers.delete(webContentsId);
  }
}

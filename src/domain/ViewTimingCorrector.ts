import type { RendererRegistry } from './RendererRegistry';

/** Nanoseconds per millisecond — RUM durations are in ns, `date` and window timestamps in ms. */
const NS_PER_MS = 1e6;

/**
 * Subset of an assembled browser RUM view event this module rewrites. Declared locally, and
 * mutable, because the generated schema types are deeply `readonly`; the event is rewritten in
 * place right after it was parsed from the bridge message, so nothing else observes it yet.
 */
interface CorrectableViewEvent {
  type?: string;
  /** View start, epoch ms. */
  date?: number;
  view?: {
    loading_type?: string;
    first_contentful_paint?: number;
    largest_contentful_paint?: number;
    largest_contentful_paint_target_selector?: string;
    performance?: {
      fcp?: { timestamp?: number };
      lcp?: { timestamp?: number };
    };
  };
}

/**
 * Rebases the paint metrics of pre-warmed windows onto the moment the user could first see them.
 *
 * A window created with `show: false` and navigated ahead of time keeps painting while hidden
 * (`paintWhenInitiallyHidden` defaults to `true`), so a page that defers its first render until
 * `show()` reports an FCP/LCP inflated by the entire pre-warm interval — measured at 8.2s for a
 * window shown 8s after creation. LCP is affected more widely than FCP: it keeps updating until
 * the first user interaction, which cannot happen while the window is hidden, so a large element
 * appearing at `show()` becomes the LCP even when FCP itself looks healthy.
 *
 * This is the same situation as a prerendered page, which the W3C Paint Timing spec handles by
 * subtracting `activationStart` from every paint timing (and which `web-vitals` implements the
 * same way). Chromium does not expose `activationStart` for pre-created Electron windows, so the
 * activation instant is observed in the main process instead — see `WindowVisibilityTracker`:
 *
 * ```
 * activationStart = max(0, firstVisibleAt − view.date)
 * metric'         = max(0, metric − activationStart)
 * ```
 *
 * The formula degrades to a no-op on its own for windows that are reused: a view started after
 * the window is already visible has `view.date > firstVisibleAt`, so `activationStart` clamps to
 * `0` and nothing is rewritten. Only `initial_load` views are eligible — a route change inside an
 * already-running document is not an activation.
 *
 * Windows that have never been shown are a separate case: there is no activation instant to
 * rebase onto, and a corrected value would still be meaningless, so the paint metrics are dropped
 * instead of reported. That mirrors what the browser SDK's `trackFirstHidden` guard would have
 * done had Electron let it observe the window as hidden.
 *
 * Renderers we know nothing about — `WebContentsView`, `<webview>`, or a window created before
 * the SDK started — are left untouched: "not observed" must not be mistaken for "never visible".
 */
export class ViewTimingCorrector {
  constructor(
    private readonly rendererRegistry: RendererRegistry,
    private readonly enabled: boolean
  ) {}

  /** Rewrites the event in place. Non-view events and ineligible views are left as they are. */
  correct(event: unknown, webContentsId: number | undefined): void {
    if (!this.enabled || webContentsId === undefined) {
      return;
    }

    const viewEvent = event as CorrectableViewEvent | undefined;
    if (viewEvent?.type !== 'view') {
      return;
    }

    const view = viewEvent.view;
    if (!view || view.loading_type !== 'initial_load') {
      return;
    }

    const renderer = this.rendererRegistry.get(webContentsId);
    if (!renderer?.visibilityTracked) {
      return;
    }

    if (renderer.firstVisibleAt === undefined) {
      discardPaintTimings(view);
      return;
    }

    if (typeof viewEvent.date !== 'number') {
      return;
    }

    const activationStart = Math.max(0, renderer.firstVisibleAt - viewEvent.date) * NS_PER_MS;
    if (activationStart === 0) {
      return;
    }

    rebasePaintTimings(view, activationStart);
  }
}

type ViewProperties = NonNullable<CorrectableViewEvent['view']>;

function rebasePaintTimings(view: ViewProperties, activationStart: number): void {
  view.first_contentful_paint = rebase(view.first_contentful_paint, activationStart);
  view.largest_contentful_paint = rebase(view.largest_contentful_paint, activationStart);

  if (view.performance?.fcp) {
    view.performance.fcp.timestamp = rebase(view.performance.fcp.timestamp, activationStart);
  }
  if (view.performance?.lcp) {
    view.performance.lcp.timestamp = rebase(view.performance.lcp.timestamp, activationStart);
  }
}

/**
 * Rounded, not because either input is fractional today — `firstVisibleAt` and the renderer's
 * `date` are both whole milliseconds — but because these fields are `int64` on the intake, which
 * drops the entire event on a fraction without a word. Rounding here keeps that guarantee a
 * property of this module rather than of whatever the renderer happens to send.
 */
function rebase(metric: number | undefined, activationStart: number): number | undefined {
  return metric === undefined ? undefined : Math.round(Math.max(0, metric - activationStart));
}

function discardPaintTimings(view: ViewProperties): void {
  delete view.first_contentful_paint;
  delete view.largest_contentful_paint;
  delete view.largest_contentful_paint_target_selector;
  delete view.performance?.fcp;
  delete view.performance?.lcp;
}

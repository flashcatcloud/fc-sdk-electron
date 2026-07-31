import { beforeEach, describe, expect, it } from 'vitest';
import { RendererRegistry } from './RendererRegistry';
import { ViewTimingCorrector } from './ViewTimingCorrector';

const WEB_CONTENTS_ID = 7;
/** Nanoseconds per millisecond — paint metrics are in ns, `date` in epoch ms. */
const MS = 1e6;
/** Epoch ms at which the view started. */
const VIEW_DATE = 1000;

interface TestView {
  id?: string;
  loading_type?: string;
  first_contentful_paint?: number;
  largest_contentful_paint?: number;
  largest_contentful_paint_target_selector?: string;
  performance?: {
    fcp?: { timestamp: number };
    lcp?: { timestamp: number; target_selector?: string };
  };
}

interface TestViewEvent {
  type: string;
  date?: number;
  view: TestView;
}

/** A pre-warmed window's view: everything painted only once the window was shown, 8s in. */
function createViewEvent(view: TestView = {}): TestViewEvent {
  return {
    type: 'view',
    date: VIEW_DATE,
    view: {
      id: 'view-1',
      loading_type: 'initial_load',
      first_contentful_paint: 8000 * MS,
      largest_contentful_paint: 8100 * MS,
      largest_contentful_paint_target_selector: '#hero',
      performance: {
        fcp: { timestamp: 8000 * MS },
        lcp: { timestamp: 8100 * MS, target_selector: '#hero' },
      },
      ...view,
    },
  };
}

describe('ViewTimingCorrector', () => {
  let registry: RendererRegistry;
  let corrector: ViewTimingCorrector;

  beforeEach(() => {
    registry = new RendererRegistry();
    corrector = new ViewTimingCorrector(registry, true);
  });

  describe('pre-warmed window shown after the view started', () => {
    it('subtracts the activation delay from both paint metrics', () => {
      registry.recordFirstVisible(WEB_CONTENTS_ID, VIEW_DATE + 7900);
      const event = createViewEvent();

      corrector.correct(event, WEB_CONTENTS_ID);

      expect(event.view.first_contentful_paint).toBe(100 * MS);
      expect(event.view.largest_contentful_paint).toBe(200 * MS);
    });

    it('corrects the non-deprecated performance mirrors too', () => {
      registry.recordFirstVisible(WEB_CONTENTS_ID, VIEW_DATE + 7900);
      const event = createViewEvent();

      corrector.correct(event, WEB_CONTENTS_ID);

      expect(event.view.performance?.fcp?.timestamp).toBe(100 * MS);
      expect(event.view.performance?.lcp?.timestamp).toBe(200 * MS);
      expect(event.view.performance?.lcp?.target_selector).toBe('#hero');
    });

    it('clamps a paint that happened before activation to zero rather than going negative', () => {
      // The `prewarm-lcp-grows` case: FCP already painted while hidden, LCP only appears at show.
      registry.recordFirstVisible(WEB_CONTENTS_ID, VIEW_DATE + 8000);
      const event = createViewEvent({ first_contentful_paint: 400 * MS, performance: undefined });

      corrector.correct(event, WEB_CONTENTS_ID);

      expect(event.view.first_contentful_paint).toBe(0);
      expect(event.view.largest_contentful_paint).toBe(100 * MS);
    });

    it('leaves absent metrics absent', () => {
      registry.recordFirstVisible(WEB_CONTENTS_ID, VIEW_DATE + 7900);
      const event = createViewEvent({
        first_contentful_paint: undefined,
        largest_contentful_paint: undefined,
        performance: undefined,
      });

      corrector.correct(event, WEB_CONTENTS_ID);

      expect(event.view.first_contentful_paint).toBeUndefined();
      expect(event.view.largest_contentful_paint).toBeUndefined();
    });
  });

  describe('window already visible when the view started', () => {
    it('does not touch a window that was created visible', () => {
      registry.recordFirstVisible(WEB_CONTENTS_ID, VIEW_DATE - 50);
      const event = createViewEvent();

      corrector.correct(event, WEB_CONTENTS_ID);

      expect(event.view.first_contentful_paint).toBe(8000 * MS);
      expect(event.view.largest_contentful_paint).toBe(8100 * MS);
    });

    it('does not touch a view started long after the window was shown (reused window)', () => {
      registry.recordFirstVisible(WEB_CONTENTS_ID, VIEW_DATE - 60_000);
      const event = createViewEvent();

      corrector.correct(event, WEB_CONTENTS_ID);

      expect(event.view.first_contentful_paint).toBe(8000 * MS);
    });
  });

  describe('window never shown', () => {
    it('discards the paint metrics instead of reporting a meaningless value', () => {
      registry.trackWindowVisibility(WEB_CONTENTS_ID);
      const event = createViewEvent();

      corrector.correct(event, WEB_CONTENTS_ID);

      expect(event.view).not.toHaveProperty('first_contentful_paint');
      expect(event.view).not.toHaveProperty('largest_contentful_paint');
      expect(event.view).not.toHaveProperty('largest_contentful_paint_target_selector');
      expect(event.view.performance).not.toHaveProperty('fcp');
      expect(event.view.performance).not.toHaveProperty('lcp');
    });

    it('does not fail when the view carries no performance object', () => {
      registry.trackWindowVisibility(WEB_CONTENTS_ID);
      const event = createViewEvent({ performance: undefined });

      expect(() => corrector.correct(event, WEB_CONTENTS_ID)).not.toThrow();
      expect(event.view).not.toHaveProperty('first_contentful_paint');
    });
  });

  describe('renderers whose visibility is not observed', () => {
    it('leaves an unknown webContents untouched', () => {
      const event = createViewEvent();

      corrector.correct(event, WEB_CONTENTS_ID);

      expect(event.view.first_contentful_paint).toBe(8000 * MS);
    });

    it('leaves a renderer known only through the bridge untouched', () => {
      // A `WebContentsView` reports RUM events but has no `show` event to observe.
      registry.set(WEB_CONTENTS_ID, { viewId: 'view-1' });
      const event = createViewEvent();

      corrector.correct(event, WEB_CONTENTS_ID);

      expect(event.view.first_contentful_paint).toBe(8000 * MS);
    });

    it('ignores an event without a sender', () => {
      const event = createViewEvent();

      corrector.correct(event, undefined);

      expect(event.view.first_contentful_paint).toBe(8000 * MS);
    });
  });

  describe('ineligible events', () => {
    beforeEach(() => {
      registry.recordFirstVisible(WEB_CONTENTS_ID, VIEW_DATE + 7900);
    });

    it('leaves route changes untouched', () => {
      const event = createViewEvent({ loading_type: 'route_change' });

      corrector.correct(event, WEB_CONTENTS_ID);

      expect(event.view.first_contentful_paint).toBe(8000 * MS);
    });

    it('leaves views without a loading type untouched', () => {
      const event = createViewEvent({ loading_type: undefined });

      corrector.correct(event, WEB_CONTENTS_ID);

      expect(event.view.first_contentful_paint).toBe(8000 * MS);
    });

    it('leaves non-view events untouched', () => {
      const event: TestViewEvent = { ...createViewEvent(), type: 'error' };

      corrector.correct(event, WEB_CONTENTS_ID);

      expect(event.view.first_contentful_paint).toBe(8000 * MS);
    });

    it('does not throw on events without a view', () => {
      expect(() => corrector.correct({ type: 'view', date: VIEW_DATE }, WEB_CONTENTS_ID)).not.toThrow();
    });

    it('does not correct a view without a date', () => {
      const event: TestViewEvent = { ...createViewEvent(), date: undefined };

      corrector.correct(event, WEB_CONTENTS_ID);

      expect(event.view.first_contentful_paint).toBe(8000 * MS);
    });
  });

  describe('when disabled', () => {
    it('reports the raw document-level timings', () => {
      const disabled = new ViewTimingCorrector(registry, false);
      registry.recordFirstVisible(WEB_CONTENTS_ID, VIEW_DATE + 7900);
      const event = createViewEvent();

      disabled.correct(event, WEB_CONTENTS_ID);

      expect(event.view.first_contentful_paint).toBe(8000 * MS);
      expect(event.view.largest_contentful_paint).toBe(8100 * MS);
    });

    it('does not discard the metrics of a window that was never shown', () => {
      const disabled = new ViewTimingCorrector(registry, false);
      registry.trackWindowVisibility(WEB_CONTENTS_ID);
      const event = createViewEvent();

      disabled.correct(event, WEB_CONTENTS_ID);

      expect(event.view.first_contentful_paint).toBe(8000 * MS);
    });
  });
});

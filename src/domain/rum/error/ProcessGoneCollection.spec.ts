const { mockAppOn, mockAppOff } = vi.hoisted(() => ({ mockAppOn: vi.fn(), mockAppOff: vi.fn() }));

vi.mock('electron', () => ({
  app: {
    on: mockAppOn,
    off: mockAppOff,
  },
}));

vi.mock('../../telemetry', () => ({
  addError: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  monitor: (fn: Function) => fn,
}));

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Details, RenderProcessGoneDetails, WebContents } from 'electron';
import { ProcessGoneCollection } from './ProcessGoneCollection';
import { EventFormat, EventKind, EventManager, EventSource } from '../../../event';
import type { RawRumEvent } from '../../../event';
import type { RawRumError } from '../rawRumData.types';
import { RendererRegistry } from '../../RendererRegistry';

const WEB_CONTENTS_ID = 3;

function fakeWebContents(overrides?: { id?: number; url?: string; destroyed?: boolean }): WebContents {
  return {
    get id() {
      if (overrides?.destroyed) {
        throw new Error('Object has been destroyed');
      }
      return overrides?.id ?? WEB_CONTENTS_ID;
    },
    getURL: () => {
      if (overrides?.destroyed) {
        throw new Error('Object has been destroyed');
      }
      return overrides?.url ?? '';
    },
  } as unknown as WebContents;
}

describe('ProcessGoneCollection', () => {
  let eventManager: EventManager;
  let rendererRegistry: RendererRegistry;
  let collection: ProcessGoneCollection;
  let rawRumEvents: RawRumEvent[];
  let simulateRenderProcessGone: (details: RenderProcessGoneDetails, webContents?: WebContents) => void;
  let simulateChildProcessGone: (details: Details) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    eventManager = new EventManager();
    rendererRegistry = new RendererRegistry();
    rawRumEvents = [];

    eventManager.registerHandler<RawRumEvent>({
      canHandle: (event): event is RawRumEvent => event.kind === EventKind.RAW && event.format === EventFormat.RUM,
      handle: (event) => rawRumEvents.push(event),
    });

    mockAppOn.mockImplementation((eventName: string, listener: (...args: unknown[]) => void) => {
      if (eventName === 'render-process-gone') {
        simulateRenderProcessGone = (details, webContents = fakeWebContents()) => listener({}, webContents, details);
      }
      if (eventName === 'child-process-gone') {
        simulateChildProcessGone = (details) => listener({}, details);
      }
    });

    collection = new ProcessGoneCollection(eventManager, rendererRegistry);
  });

  function lastError(): RawRumError {
    return rawRumEvents[rawRumEvents.length - 1].data as RawRumError;
  }

  it('listens on app, not on webContents', () => {
    expect(mockAppOn).toHaveBeenCalledWith('render-process-gone', expect.any(Function));
    expect(mockAppOn).toHaveBeenCalledWith('child-process-gone', expect.any(Function));
  });

  it('removes both listeners on stop', () => {
    collection.stop();

    expect(mockAppOff).toHaveBeenCalledWith('render-process-gone', expect.any(Function));
    expect(mockAppOff).toHaveBeenCalledWith('child-process-gone', expect.any(Function));
  });

  describe('reason routing', () => {
    // Reasons that produce a minidump are left to CrashCollection, and a clean exit is not an
    // incident. Everything else produces no dump and would otherwise go unreported.
    it.each(['crashed', 'oom', 'clean-exit'] as const)('does not report a renderer gone with %s', (reason) => {
      simulateRenderProcessGone({ reason, exitCode: 5 });

      expect(rawRumEvents).toHaveLength(0);
    });

    it.each(['killed', 'abnormal-exit', 'launch-failed', 'integrity-failure', 'memory-eviction'] as const)(
      'reports a renderer gone with %s',
      (reason) => {
        simulateRenderProcessGone({ reason, exitCode: 9 });

        expect(rawRumEvents).toHaveLength(1);
        expect(lastError().error.message).toBe(`Renderer process gone: ${reason}`);
      }
    );

    it.each(['crashed', 'oom', 'clean-exit'] as const)('does not report a child process gone with %s', (reason) => {
      simulateChildProcessGone({ type: 'GPU', reason, exitCode: 5 });

      expect(rawRumEvents).toHaveLength(0);
    });

    it.each(['killed', 'abnormal-exit', 'launch-failed', 'integrity-failure', 'memory-eviction'] as const)(
      'reports a child process gone with %s',
      (reason) => {
        simulateChildProcessGone({ type: 'GPU', reason, exitCode: 9 });

        expect(rawRumEvents).toHaveLength(1);
        expect(lastError().error.message).toBe(`GPU process gone: ${reason}`);
      }
    );

    it('reports an unknown future reason rather than dropping it', () => {
      simulateRenderProcessGone({ reason: 'brand-new-reason' as RenderProcessGoneDetails['reason'], exitCode: 1 });

      expect(rawRumEvents).toHaveLength(1);
    });
  });

  describe('renderer event shape', () => {
    beforeEach(() => {
      simulateRenderProcessGone({ reason: 'killed', exitCode: 9 });
    });

    it('emits a raw main-process RUM event', () => {
      const event = rawRumEvents[0];

      expect(event.kind).toBe(EventKind.RAW);
      expect(event.source).toBe(EventSource.MAIN);
      expect(event.format).toBe(EventFormat.RUM);
      expect(event.data.type).toBe('error');
      expect(event.startTime).toBe(lastError().date);
    });

    it('uses an error type the backend accepts', () => {
      const error = lastError().error;

      expect(error.source).toBe('source');
      expect(error.handling).toBe('unhandled');
      expect(error.category).toBe('Exception');
      expect(error.type).toBe('RenderProcessGone');
      expect(error.id).toEqual(expect.any(String));
    });

    it('never flags the event as a host application crash', () => {
      expect(lastError().error.is_crash).toBe(false);
    });

    it('carries the exit reason and code in meta', () => {
      expect(lastError().error.meta).toEqual({
        process: 'renderer',
        exit_reason: 'killed',
        exit_code: '9',
      });
    });
  });

  describe('child process event shape', () => {
    it('names the child process type in the message and meta', () => {
      simulateChildProcessGone({ type: 'Utility', reason: 'abnormal-exit', exitCode: 133, name: 'Network Service' });

      const error = lastError().error;
      expect(error.message).toBe('Utility process gone: abnormal-exit');
      expect(error.type).toBe('ChildProcessGone');
      expect(error.is_crash).toBe(false);
      expect(error.meta).toEqual({ process: 'Utility', exit_reason: 'abnormal-exit', exit_code: '133' });
    });

    it('has no renderer attribution', () => {
      simulateChildProcessGone({ type: 'GPU', reason: 'killed', exitCode: 9 });

      expect(lastError().container).toBeUndefined();
      expect(lastError().error.meta?.url).toBeUndefined();
    });
  });

  describe('renderer attribution', () => {
    it('reads the url from the still-alive webContents', () => {
      simulateRenderProcessGone({ reason: 'killed', exitCode: 9 }, fakeWebContents({ url: 'file:///app/index.html' }));

      expect(lastError().error.meta?.url).toBe('file:///app/index.html');
    });

    it('attributes the error to the renderer view recorded through the bridge', () => {
      rendererRegistry.set(WEB_CONTENTS_ID, { viewId: 'view-1', url: 'file:///app/index.html' });

      simulateRenderProcessGone({ reason: 'killed', exitCode: 9 });

      expect(lastError().container).toEqual({ view: { id: 'view-1' }, source: 'electron' });
    });

    it('falls back to the registered url when the webContents has none', () => {
      rendererRegistry.set(WEB_CONTENTS_ID, { viewId: 'view-1', url: 'file:///app/index.html' });

      simulateRenderProcessGone({ reason: 'killed', exitCode: 9 }, fakeWebContents({ url: '' }));

      expect(lastError().error.meta?.url).toBe('file:///app/index.html');
    });

    it('omits container when the renderer is unknown', () => {
      simulateRenderProcessGone({ reason: 'killed', exitCode: 9 });

      expect(lastError().container).toBeUndefined();
    });

    it('stops tracking the renderer once it is gone', () => {
      rendererRegistry.set(WEB_CONTENTS_ID, { viewId: 'view-1' });

      simulateRenderProcessGone({ reason: 'killed', exitCode: 9 });

      expect(rendererRegistry.get(WEB_CONTENTS_ID)).toBeUndefined();
    });

    it('stops tracking the renderer even when the event is not reported', () => {
      rendererRegistry.set(WEB_CONTENTS_ID, { viewId: 'view-1' });

      simulateRenderProcessGone({ reason: 'clean-exit', exitCode: 0 });

      expect(rendererRegistry.get(WEB_CONTENTS_ID)).toBeUndefined();
      expect(rawRumEvents).toHaveLength(0);
    });

    it('still reports when the webContents is already destroyed', () => {
      simulateRenderProcessGone({ reason: 'killed', exitCode: 9 }, fakeWebContents({ destroyed: true }));

      expect(rawRumEvents).toHaveLength(1);
      expect(lastError().error.meta?.url).toBeUndefined();
      expect(lastError().container).toBeUndefined();
    });
  });
});

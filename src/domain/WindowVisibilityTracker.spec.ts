import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RendererRegistry } from './RendererRegistry';
import { WindowVisibilityTracker } from './WindowVisibilityTracker';

const { mockAppOn, mockAppOff, mockGetAllWindows } = vi.hoisted(() => ({
  mockAppOn: vi.fn(),
  mockAppOff: vi.fn(),
  mockGetAllWindows: vi.fn(() => [] as unknown[]),
}));

vi.mock('electron', () => ({
  app: { on: mockAppOn, off: mockAppOff },
  BrowserWindow: { getAllWindows: mockGetAllWindows },
}));

vi.mock('./telemetry', () => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  monitor: (fn: Function) => fn,
}));

const WEB_CONTENTS_ID = 7;
const NOW = 1_700_000_000_000;
/** How long the platform takes to actually put an ordinary `show: true` window on screen. */
const NATIVE_SHOW_DELAY = 90;

interface FakeWindow {
  webContents: { id: number };
  visible: boolean;
  isVisible: () => boolean;
  on: ReturnType<typeof vi.fn>;
  emitShow: () => void;
}

function createWindow(options: { id?: number; visible?: boolean } = {}): FakeWindow {
  const listeners: Record<string, (() => void)[]> = {};
  const window: FakeWindow = {
    webContents: { id: options.id ?? WEB_CONTENTS_ID },
    // Mirrors the real behaviour: inside `browser-window-created` even a `show: true` window
    // still reports `false`; it flips as the native constructor finishes.
    visible: false,
    isVisible: () => window.visible,
    on: vi.fn((event: string, listener: () => void) => {
      (listeners[event] ??= []).push(listener);
    }),
    emitShow: () => {
      window.visible = true;
      listeners.show?.forEach((listener) => listener());
    },
  };
  if (options.visible) {
    window.visible = true;
  }
  return window;
}

function asBrowserWindow(window: FakeWindow): BrowserWindow {
  return window as unknown as BrowserWindow;
}

describe('WindowVisibilityTracker', () => {
  let registry: RendererRegistry;
  /** Replays what `app.on('browser-window-created', …)` would deliver. */
  let simulateWindowCreated: (window: FakeWindow) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockGetAllWindows.mockReturnValue([]);
    registry = new RendererRegistry();

    mockAppOn.mockImplementation((event: string, listener: (event: unknown, window: BrowserWindow) => void) => {
      if (event === 'browser-window-created') {
        simulateWindowCreated = (window: FakeWindow) => listener({}, asBrowserWindow(window));
      }
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('subscribes to window creation', () => {
    new WindowVisibilityTracker(registry);

    expect(mockAppOn).toHaveBeenCalledWith('browser-window-created', expect.any(Function));
  });

  describe('pre-warmed window', () => {
    it('marks it as tracked but not yet visible', () => {
      new WindowVisibilityTracker(registry);

      simulateWindowCreated(createWindow());
      vi.runAllTimers();

      expect(registry.get(WEB_CONTENTS_ID)).toMatchObject({ visibilityTracked: true });
      expect(registry.get(WEB_CONTENTS_ID)?.firstVisibleAt).toBeUndefined();
    });

    it('records the instant it is finally shown', () => {
      new WindowVisibilityTracker(registry);
      const window = createWindow();
      simulateWindowCreated(window);
      vi.runAllTimers();

      vi.setSystemTime(NOW + 8000);
      window.emitShow();

      expect(registry.get(WEB_CONTENTS_ID)?.firstVisibleAt).toBe(NOW + 8000);
    });

    it('keeps the first activation instant when it is shown again', () => {
      new WindowVisibilityTracker(registry);
      const window = createWindow();
      simulateWindowCreated(window);
      vi.runAllTimers();

      vi.setSystemTime(NOW + 1000);
      window.emitShow();
      vi.setSystemTime(NOW + 5000);
      window.emitShow();

      expect(registry.get(WEB_CONTENTS_ID)?.firstVisibleAt).toBe(NOW + 1000);
    });
  });

  describe('ordinary window', () => {
    it('is anchored on its creation instant rather than on its later show event', () => {
      new WindowVisibilityTracker(registry);
      const window = createWindow();
      simulateWindowCreated(window);

      // The native window goes on screen as the constructor finishes, before the deferred check.
      window.visible = true;
      vi.setSystemTime(NOW + NATIVE_SHOW_DELAY);
      vi.runAllTimers();

      expect(registry.get(WEB_CONTENTS_ID)?.firstVisibleAt).toBe(NOW);
      expect(window.on).not.toHaveBeenCalled();
    });
  });

  describe('windows that predate the SDK', () => {
    it('anchors an already visible one at the epoch so its views are never corrected', () => {
      mockGetAllWindows.mockReturnValue([createWindow({ id: 3, visible: true })]);

      new WindowVisibilityTracker(registry);
      vi.runAllTimers();

      expect(registry.get(3)?.firstVisibleAt).toBe(0);
    });

    it('still waits for the show event of a hidden one', () => {
      const window = createWindow({ id: 3 });
      mockGetAllWindows.mockReturnValue([window]);

      new WindowVisibilityTracker(registry);
      vi.runAllTimers();
      vi.setSystemTime(NOW + 4000);
      window.emitShow();

      expect(registry.get(3)?.firstVisibleAt).toBe(NOW + 4000);
    });
  });

  it('ignores a window whose webContents is already destroyed', () => {
    new WindowVisibilityTracker(registry);
    const destroyed = {
      get webContents(): { id: number } {
        throw new Error('Object has been destroyed');
      },
      isVisible: () => true,
      on: vi.fn(),
    };

    expect(() => simulateWindowCreated(destroyed as unknown as FakeWindow)).not.toThrow();
    vi.runAllTimers();
    expect(registry.get(WEB_CONTENTS_ID)).toBeUndefined();
  });

  describe('stop', () => {
    it('unsubscribes from window creation', () => {
      const tracker = new WindowVisibilityTracker(registry);

      tracker.stop();

      expect(mockAppOff).toHaveBeenCalledWith('browser-window-created', expect.any(Function));
    });

    it('drops a deferred visibility check', () => {
      const tracker = new WindowVisibilityTracker(registry);
      const window = createWindow({ visible: true });
      simulateWindowCreated(window);

      tracker.stop();
      vi.runAllTimers();

      expect(registry.get(WEB_CONTENTS_ID)?.firstVisibleAt).toBeUndefined();
    });
  });
});

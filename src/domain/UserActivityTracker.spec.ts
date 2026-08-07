import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventManager, EventKind, LifecycleKind, type LifecycleEvent } from '../event';
import { UserActivityTracker } from './UserActivityTracker';

type InputListener = (event: unknown, input: { type: string }) => void;

/** Stand-in for a `webContents`, capturing the input listener the tracker attaches to it. */
function createWebContents() {
  const listeners: InputListener[] = [];
  return {
    on: vi.fn((channel: string, listener: InputListener) => {
      if (channel === 'input-event') {
        listeners.push(listener);
      }
    }),
    /** Replays an input event of the given type, the way Electron delivers it. */
    input(type: string) {
      for (const listener of listeners) {
        listener({}, { type });
      }
    },
  };
}

const { mockGetAllWebContents, mockAppOn } = vi.hoisted(() => ({
  mockGetAllWebContents: vi.fn(() => [] as unknown[]),
  mockAppOn: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { on: mockAppOn, getAppPath: vi.fn(() => '/mock/app/root') },
  webContents: { getAllWebContents: mockGetAllWebContents },
}));

vi.mock('./telemetry', () => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  monitor: (fn: Function) => fn,
}));

describe('UserActivityTracker', () => {
  let eventManager: EventManager;
  let activityCount: number;
  let existing: ReturnType<typeof createWebContents>;

  /** Replays Electron creating a webContents after the tracker was constructed. */
  function createRendererLater() {
    const contents = createWebContents();
    for (const [channel, listener] of mockAppOn.mock.calls) {
      if (channel === 'web-contents-created') {
        (listener as (event: unknown, contents: unknown) => void)({}, contents);
      }
    }
    return contents;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    eventManager = new EventManager();
    activityCount = 0;
    eventManager.registerHandler<LifecycleEvent>({
      canHandle: (event): event is LifecycleEvent => event.kind === EventKind.LIFECYCLE,
      handle: (event) => {
        if (event.lifecycle === LifecycleKind.END_USER_ACTIVITY) {
          activityCount++;
        }
      },
    });

    existing = createWebContents();
    mockGetAllWebContents.mockImplementation(() => [existing]);
    new UserActivityTracker(eventManager);
  });

  describe('input that means the user is there', () => {
    it.each(['mouseDown', 'mouseWheel', 'keyDown', 'rawKeyDown'])('should count %s', (type) => {
      existing.input(type);

      expect(activityCount).toBe(1);
    });
  });

  describe('input that does not', () => {
    // A cursor crossing the window is not someone using the application; taking these would keep a
    // session alive for as long as the mouse happened to rest over it.
    it.each(['mouseMove', 'mouseEnter', 'mouseLeave'])('should ignore %s', (type) => {
      existing.input(type);

      expect(activityCount).toBe(0);
    });

    // Releases always follow a press that already counted.
    it.each(['mouseUp', 'keyUp'])('should ignore %s', (type) => {
      existing.input(type);

      expect(activityCount).toBe(0);
    });
  });

  it('should watch renderers that already existed when the SDK started', () => {
    // Windows can be open before `init()` runs, and they are exactly the ones whose input would
    // otherwise go unseen.
    existing.input('mouseDown');

    expect(activityCount).toBe(1);
  });

  it('should watch renderers created afterwards', () => {
    const later = createRendererLater();

    later.input('mouseDown');

    expect(activityCount).toBe(1);
  });

  it('should count input from every renderer, not just the first', () => {
    const later = createRendererLater();

    existing.input('mouseDown');
    later.input('keyDown');

    expect(activityCount).toBe(2);
  });

  it('should not depend on the renderer reporting anything of its own', () => {
    // The previous signal was a click action forwarded over the bridge, so it needed the Browser
    // SDK to be present and collecting. Nothing here goes through the bridge at all.
    const withoutBrowserSdk = createRendererLater();

    withoutBrowserSdk.input('mouseDown');

    expect(activityCount).toBe(1);
  });
});

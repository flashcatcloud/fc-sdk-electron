vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/user/data') },
}));

vi.mock('../domain/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../domain/telemetry')>()),
  addTelemetryDebug: vi.fn(),
}));

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { generateUUID, type TimeStamp } from '@flashcatcloud/browser-core';
import { EventKind, EventManager, LifecycleKind } from '../event';
import type { RumEvent } from '../domain/rum';
import { type Session, TrackingType } from '../domain/session';
import { addTelemetryDebug } from '../domain/telemetry';
import {
  computeReleaseDelay,
  WITHHELD_BUFFER_BYTES_LIMIT,
  WITHHELD_BUFFER_DURATION,
  WITHHELD_BUFFER_EVENTS_LIMIT,
  WITHHELD_BUFFER_RELEASE_MAX_DELAY,
  WITHHELD_BUFFER_VIEWS_LIMIT,
  WithheldEventBuffer,
} from './WithheldEventBuffer';

const SESSION_ID = 'withheld-session-id';
const RELEASE_DELAY = computeReleaseDelay(SESSION_ID);
const MAIN_VIEW = 'main-view';

let sequence = 0;

function view(id: string, date: number, isActive = true, sessionId = SESSION_ID): RumEvent {
  return {
    type: 'view',
    date,
    session: { id: sessionId },
    view: { id, is_active: isActive },
    _dd: { document_version: ++sequence },
  } as unknown as RumEvent;
}

function detail(
  type: 'action' | 'error' | 'resource' | 'long_task',
  attributes: Record<string, unknown> = {},
  { viewId = MAIN_VIEW, sessionId = SESSION_ID } = {}
): RumEvent {
  return {
    type,
    date: Date.now(),
    session: { id: sessionId },
    view: { id: viewId },
    seq: ++sequence,
    ...attributes,
  } as unknown as RumEvent;
}

function error(source = 'custom', attributes: Record<string, unknown> = {}, viewId = MAIN_VIEW): RumEvent {
  return detail('error', { error: { source, message: 'boom' }, ...attributes }, { viewId });
}

function resource(statusCode: number, attributes: Record<string, unknown> = {}): RumEvent {
  return detail('resource', { resource: { status_code: statusCode }, ...attributes });
}

/** Padding that makes a single event weigh about `bytes`. */
function padding(bytes: number) {
  return { context: { padding: 'x'.repeat(bytes) } };
}

describe('WithheldEventBuffer', () => {
  let eventManager: EventManager;
  let session: Session;
  let setSessionHasError: Mock<(sessionId: string, errorTime: TimeStamp) => void>;
  let forwarded: RumEvent[];
  let buffer: WithheldEventBuffer;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    eventManager = new EventManager();
    session = { id: SESSION_ID, status: 'active', trackingType: TrackingType.TRACKED_ON_ERROR, sampleRate: 0 };
    setSessionHasError = vi.fn((sessionId: string) => {
      if (sessionId === session.id) session.hasError = true;
    });
    forwarded = [];
    buffer = new WithheldEventBuffer(
      eventManager,
      { getSession: () => ({ ...session }), setSessionHasError },
      (event) => forwarded.push(event)
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function notifyLifecycle(lifecycle: (typeof LifecycleKind)[keyof typeof LifecycleKind]) {
    eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle } as never);
  }

  function expireSession() {
    session.status = 'expired';
    notifyLifecycle(LifecycleKind.SESSION_EXPIRED);
  }

  describe('a session drawn by the plain rate', () => {
    it('forwards every event as it comes', () => {
      session.trackingType = TrackingType.TRACKED;
      const events = [view(MAIN_VIEW, 1), detail('action'), error()];

      events.forEach((event) => buffer.collect(event));

      expect(forwarded).toEqual(events);
      expect(setSessionHasError).not.toHaveBeenCalled();
    });
  });

  describe('a withheld session', () => {
    it('forwards nothing until an error is reported', () => {
      buffer.collect(view(MAIN_VIEW, 1));
      buffer.collect(detail('action'));
      buffer.collect(resource(200));

      vi.advanceTimersByTime(10 * WITHHELD_BUFFER_RELEASE_MAX_DELAY);

      expect(forwarded).toEqual([]);
    });

    it('is released by an error, after the per-session jitter', () => {
      buffer.collect(view(MAIN_VIEW, 1));
      buffer.collect(detail('action'));
      buffer.collect(error());

      // Marked when released, not when the error arrives: until the release nothing of the session
      // has reached the batch, which is what the mark means to a crash reported on the next launch.
      expect(setSessionHasError).not.toHaveBeenCalled();
      if (RELEASE_DELAY > 0) {
        vi.advanceTimersByTime(RELEASE_DELAY - 1);
        expect(forwarded).toEqual([]);
      }
      vi.advanceTimersByTime(1);

      expect(forwarded.map((event) => event.type)).toEqual(['view', 'error', 'action']);
      expect(setSessionHasError).toHaveBeenCalledWith(SESSION_ID, expect.any(Number));
    });

    it('releases views oldest first, then errors, then the rest oldest first', () => {
      const views = [view('renderer-view', 300), view(MAIN_VIEW, 100), view('other-window', 200)];
      const action1 = detail('action', {}, { viewId: 'renderer-view' });
      const resource1 = resource(200);
      const firstError = error('source', {}, 'renderer-view');
      const action2 = detail('action', {}, { viewId: 'other-window' });
      const secondError = error();
      [views[0], action1, views[1], resource1, views[2]].forEach((event) => buffer.collect(event));

      buffer.collect(firstError);
      buffer.collect(action2);
      buffer.collect(secondError);
      vi.advanceTimersByTime(WITHHELD_BUFFER_RELEASE_MAX_DELAY);

      expect(forwarded).toEqual([views[1], views[2], views[0], firstError, secondError, action1, resource1, action2]);
    });

    it('keeps only the latest update of a view', () => {
      const first = view(MAIN_VIEW, 1);
      const latest = view(MAIN_VIEW, 1);
      buffer.collect(first);
      buffer.collect(latest);
      buffer.collect(error());
      vi.advanceTimersByTime(WITHHELD_BUFFER_RELEASE_MAX_DELAY);

      expect(forwarded.filter((event) => event.type === 'view')).toEqual([latest]);
    });

    it('forwards the events that follow a release as they come', () => {
      buffer.collect(view(MAIN_VIEW, 1));
      buffer.collect(error());
      vi.advanceTimersByTime(WITHHELD_BUFFER_RELEASE_MAX_DELAY);
      forwarded = [];

      const next = detail('action');
      buffer.collect(next);

      expect(forwarded).toEqual([next]);
    });

    it('is not released by an error the SDK reported about itself', () => {
      buffer.collect(view(MAIN_VIEW, 1));
      buffer.collect(error('agent'));
      vi.advanceTimersByTime(10 * WITHHELD_BUFFER_RELEASE_MAX_DELAY);

      expect(forwarded).toEqual([]);
      expect(setSessionHasError).not.toHaveBeenCalled();
    });

    it('is released once the session is marked errored elsewhere, by its next event', () => {
      buffer.collect(view(MAIN_VIEW, 1));
      // What `CrashCollection` does for a crash reported on the next launch.
      session.hasError = true;
      buffer.collect(detail('action'));
      vi.advanceTimersByTime(WITHHELD_BUFFER_RELEASE_MAX_DELAY);

      expect(forwarded.map((event) => event.type)).toEqual(['view', 'action']);
    });

    it('leaves the events of another session alone', () => {
      buffer.collect(view(MAIN_VIEW, 1));
      const other = detail('action', {}, { sessionId: 'previous-session-id' });

      buffer.collect(other);

      expect(forwarded).toEqual([other]);
    });

    it('reports the release through telemetry', () => {
      buffer.collect(view(MAIN_VIEW, 1));
      buffer.collect(detail('action'));
      buffer.collect(error());
      vi.advanceTimersByTime(WITHHELD_BUFFER_RELEASE_MAX_DELAY);

      expect(addTelemetryDebug).toHaveBeenCalledWith('Error session event buffer released', {
        'buffer.views_count': 1,
        'buffer.events_count': 2,
        'buffer.dropped_count': 0,
        'buffer.bytes': expect.any(Number) as number,
      });
    });
  });

  describe('window', () => {
    it('keeps only the last minute of detail', () => {
      buffer.collect(view(MAIN_VIEW, 1));
      const old = detail('action');
      buffer.collect(old);
      vi.advanceTimersByTime(WITHHELD_BUFFER_DURATION + 1);
      const recent = detail('action');
      buffer.collect(recent);

      buffer.collect(error());
      vi.advanceTimersByTime(WITHHELD_BUFFER_RELEASE_MAX_DELAY);

      expect(forwarded).toContain(recent);
      expect(forwarded).not.toContain(old);
    });

    it('freezes the window when the release is scheduled, so a late timer does not prune the history', () => {
      buffer.collect(view(MAIN_VIEW, 1));
      const beforeError = detail('action');
      buffer.collect(beforeError);
      buffer.collect(error());

      // A timer that fires long after it was due, as in a suspended process.
      vi.setSystemTime(Date.now() + 2 * WITHHELD_BUFFER_DURATION);
      vi.advanceTimersByTime(WITHHELD_BUFFER_RELEASE_MAX_DELAY);

      expect(forwarded).toContain(beforeError);
    });

    it('drops an ended view once no detail of it is left, but keeps an active one', () => {
      buffer.collect(view(MAIN_VIEW, 1));
      buffer.collect(view('ended-view', 2, false));
      buffer.collect(view('active-view', 3, true));
      buffer.collect(detail('action'));

      vi.advanceTimersByTime(WITHHELD_BUFFER_DURATION + 1);
      buffer.collect(error());
      vi.advanceTimersByTime(WITHHELD_BUFFER_RELEASE_MAX_DELAY);

      const viewIds = forwarded.filter((event) => event.type === 'view').map((event) => event.view.id);
      expect(viewIds).toEqual([MAIN_VIEW, 'active-view']);
    });

    it('keeps an ended view that arrives ahead of its detail, as a crash reported on the next launch brings it', () => {
      buffer.collect(view(MAIN_VIEW, 2));
      session.hasError = true;
      const crashedView = view('crashed-view', 1, false);
      buffer.collect(crashedView);
      vi.advanceTimersByTime(WITHHELD_BUFFER_RELEASE_MAX_DELAY);

      expect(forwarded).toEqual([crashedView, expect.objectContaining({ view: { id: MAIN_VIEW, is_active: true } })]);
    });

    it('keeps an error whose view stopped receiving detail a while ago, as long as the view is active', () => {
      buffer.collect(view(MAIN_VIEW, 1));
      buffer.collect(view('idle-window', 2, true));
      vi.advanceTimersByTime(5 * WITHHELD_BUFFER_DURATION);

      const idleWindowError = error('source', {}, 'idle-window');
      buffer.collect(idleWindowError);
      vi.advanceTimersByTime(WITHHELD_BUFFER_RELEASE_MAX_DELAY);

      expect(forwarded).toContain(idleWindowError);
    });
  });

  describe('budget', () => {
    it('evicts long tasks and successful requests first, then the rest, then errors newest first', () => {
      buffer.collect(view(MAIN_VIEW, 1));
      const failedRequest = resource(500);
      const firstErrorOfAgent = error('agent');
      const secondErrorOfAgent = error('agent');
      buffer.collect(failedRequest);
      buffer.collect(firstErrorOfAgent);
      buffer.collect(secondErrorOfAgent);
      buffer.collect(detail('long_task'));
      for (let i = 0; i < WITHHELD_BUFFER_EVENTS_LIMIT - 3; i += 1) {
        buffer.collect(resource(200));
      }
      buffer.collect(detail('action'));

      buffer.collect(error());
      vi.advanceTimersByTime(WITHHELD_BUFFER_RELEASE_MAX_DELAY);

      const types = forwarded.map((event) => event.type);
      expect(types.filter((type) => type === 'long_task')).toEqual([]);
      expect(types.filter((type) => type === 'error')).toHaveLength(3);
      expect(forwarded).toContain(failedRequest);
      expect(forwarded).toContain(firstErrorOfAgent);
      expect(forwarded.length - 1).toBe(WITHHELD_BUFFER_EVENTS_LIMIT);
    });

    it('evicts the newest error when only errors are left, so the first error stays', () => {
      buffer.collect(view(MAIN_VIEW, 1));
      const errors = Array.from({ length: WITHHELD_BUFFER_EVENTS_LIMIT + 5 }, () => error('agent'));
      errors.forEach((event) => buffer.collect(event));
      // Releases through the mark rather than through an error, which would itself join the buffer.
      session.hasError = true;
      buffer.collect(view(MAIN_VIEW, 1));
      vi.advanceTimersByTime(WITHHELD_BUFFER_RELEASE_MAX_DELAY);

      const released = forwarded.filter((event) => event.type === 'error');
      expect(released).toEqual(errors.slice(0, WITHHELD_BUFFER_EVENTS_LIMIT));
    });

    it('stays within the byte budget, dropping successful requests before failed ones', () => {
      buffer.collect(view(MAIN_VIEW, 1));
      const failed = resource(0, padding(20 * 1024));
      buffer.collect(failed);
      const successes = Array.from({ length: 4 }, () => resource(200, padding(20 * 1024)));
      successes.forEach((event) => buffer.collect(event));

      buffer.collect(error());
      vi.advanceTimersByTime(WITHHELD_BUFFER_RELEASE_MAX_DELAY);

      const bytes = forwarded
        .filter((event) => event.type !== 'view')
        .reduce((sum, event) => sum + JSON.stringify(event).length, 0);
      expect(bytes).toBeLessThanOrEqual(WITHHELD_BUFFER_BYTES_LIMIT);
      expect(forwarded).toContain(failed);
      expect(forwarded).toContain(successes[successes.length - 1]);
      expect(forwarded).not.toContain(successes[0]);
    });

    it('drops a single detail larger than the whole budget, and keeps the history', () => {
      buffer.collect(view(MAIN_VIEW, 1));
      const history = detail('action');
      buffer.collect(history);
      buffer.collect(detail('action', padding(WITHHELD_BUFFER_BYTES_LIMIT)));

      buffer.collect(error());
      vi.advanceTimersByTime(WITHHELD_BUFFER_RELEASE_MAX_DELAY);

      expect(forwarded.map((event) => event.type)).toEqual(['view', 'error', 'action']);
      expect(forwarded).toContain(history);
    });

    it('forwards a releasing error larger than the whole budget at once, and the history after the jitter', () => {
      buffer.collect(view(MAIN_VIEW, 1));
      const history = detail('action');
      buffer.collect(history);
      const largeError = error('custom', padding(WITHHELD_BUFFER_BYTES_LIMIT));

      buffer.collect(largeError);

      expect(forwarded).toEqual([largeError]);
      vi.advanceTimersByTime(WITHHELD_BUFFER_RELEASE_MAX_DELAY);
      expect(forwarded.slice(1).map((event) => event.type)).toEqual(['view', 'action']);
    });

    it('evicts ended views first past the view limit, and never releases a detail without its view', () => {
      buffer.collect(view(MAIN_VIEW, 0));
      // An ended view arrives after its detail: its final update is emitted when it ends.
      const orphan = detail('action', {}, { viewId: 'view-0' });
      buffer.collect(orphan);
      buffer.collect(view('view-0', 1, false));
      for (let i = 1; i <= WITHHELD_BUFFER_VIEWS_LIMIT; i += 1) {
        buffer.collect(detail('action', {}, { viewId: `view-${i}` }));
        buffer.collect(view(`view-${i}`, i + 1, false));
      }

      buffer.collect(error());
      vi.advanceTimersByTime(WITHHELD_BUFFER_RELEASE_MAX_DELAY);

      const views = forwarded.filter((event) => event.type === 'view');
      expect(views).toHaveLength(WITHHELD_BUFFER_VIEWS_LIMIT);
      expect(views[0].view.id).toBe(MAIN_VIEW);
      expect(forwarded).not.toContain(orphan);
    });

    it('keeps the view of the releasing error past the view limit, ended as it may be', () => {
      buffer.collect(view(MAIN_VIEW, 0));
      buffer.collect(view('errored-view', 1));
      const releasingError = error('source', {}, 'errored-view');
      buffer.collect(releasingError);
      buffer.collect(view('errored-view', 1, false));
      // During the jitter, more views than the limit allows arrive and end, every one of them
      // updated after the errored view — the eviction order of ended views, were it the only rule.
      for (let i = 1; i <= WITHHELD_BUFFER_VIEWS_LIMIT; i += 1) {
        buffer.collect(view(`view-${i}`, i + 1, false));
      }
      vi.advanceTimersByTime(WITHHELD_BUFFER_RELEASE_MAX_DELAY);

      expect(forwarded).toContain(releasingError);
      expect(forwarded.filter((event) => event.type === 'view').map((event) => event.view.id)).toContain(
        'errored-view'
      );
    });
  });

  describe('budget, crash reported on the next launch', () => {
    it('keeps the view a crash brings along past the view limit, until the crash arrives for it', () => {
      for (let i = 1; i <= WITHHELD_BUFFER_VIEWS_LIMIT; i += 1) {
        buffer.collect(view(`window-${i}`, i));
      }
      // What CrashCollection emits, in this order: the crashed view ended, then the crash itself.
      const crashedView = view('crashed-view', 0, false);
      const crash = error('source', { error: { source: 'source', is_crash: true } }, 'crashed-view');
      session.hasError = true;
      buffer.collect(crashedView);
      buffer.collect(crash);
      vi.advanceTimersByTime(WITHHELD_BUFFER_RELEASE_MAX_DELAY);

      expect(forwarded).toContain(crashedView);
      expect(forwarded).toContain(crash);
    });
  });

  describe('end of the session', () => {
    it('throws away what never earned its release', () => {
      buffer.collect(view(MAIN_VIEW, 1));
      buffer.collect(detail('action'));

      expireSession();
      vi.advanceTimersByTime(10 * WITHHELD_BUFFER_RELEASE_MAX_DELAY);

      expect(forwarded).toEqual([]);
    });

    it('releases at once what is waiting for the jitter', () => {
      buffer.collect(view(MAIN_VIEW, 1));
      buffer.collect(error());

      expireSession();

      expect(forwarded.map((event) => event.type)).toEqual(['view', 'error']);
    });

    it('does not mistake the next session for the one that was thrown away', () => {
      buffer.collect(view(MAIN_VIEW, 1));
      expireSession();
      session = { id: 'next-session-id', status: 'active', trackingType: TrackingType.TRACKED, sampleRate: 100 };

      const next = detail('action', {}, { sessionId: 'next-session-id' });
      buffer.collect(next);

      expect(forwarded).toEqual([next]);
    });
  });

  describe('application exit', () => {
    it('releases at once what is waiting for the jitter', () => {
      buffer.collect(view(MAIN_VIEW, 1));
      buffer.collect(error());

      notifyLifecycle(LifecycleKind.APP_MAY_EXIT);

      expect(forwarded.map((event) => event.type)).toEqual(['view', 'error']);
      expect(setSessionHasError).toHaveBeenCalledWith(SESSION_ID, expect.any(Number));
    });

    it('keeps what has not earned its release', () => {
      buffer.collect(view(MAIN_VIEW, 1));
      const history = detail('action');
      buffer.collect(history);

      notifyLifecycle(LifecycleKind.APP_MAY_EXIT);
      expect(forwarded).toEqual([]);

      buffer.collect(error());
      vi.advanceTimersByTime(WITHHELD_BUFFER_RELEASE_MAX_DELAY);
      expect(forwarded).toContain(history);
    });
  });
});

describe('computeReleaseDelay', () => {
  it('is deterministic per session', () => {
    expect(computeReleaseDelay(SESSION_ID)).toBe(computeReleaseDelay(SESSION_ID));
  });

  it('spreads sessions over the whole jitter window', () => {
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < 1000; i += 1) {
      const delay = computeReleaseDelay(generateUUID());
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(WITHHELD_BUFFER_RELEASE_MAX_DELAY);
      buckets[Math.floor(delay / (WITHHELD_BUFFER_RELEASE_MAX_DELAY / 10))] += 1;
    }

    // 100 per bucket on average: a sum-of-char-codes hash would pile them into one or two.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(50);
    }
  });
});

import { mockFs } from '../../mocks.specUtil';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/user/data') },
}));

vi.mock('../../tools/display', () => ({
  displayError: vi.fn(),
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DISCARDED, type TimeStamp } from '@flashcatcloud/browser-core';
import { createFormatHooks } from '../../assembly';
import { SessionContext, TrackingType } from './SessionContext';

vi.mock('node:fs/promises');
const mfs = mockFs();

// Fake time starts at T0 = 0 so that timeStampNow() aligns with T0
const T0 = 0 as TimeStamp;
const EXPIRE_DELAY = 1000;

describe('SessionContext', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mfs.readFile.mockRejectedValue(new Error('ENOENT'));
    mfs.writeFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mfs.reset();
  });

  describe('before add()', () => {
    it('RUM hook returns DISCARDED', async () => {
      const hooks = createFormatHooks();
      await SessionContext.init(hooks, 100, EXPIRE_DELAY);

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toBe(DISCARDED);
    });

    it('span hook returns DISCARDED', async () => {
      const hooks = createFormatHooks();
      await SessionContext.init(hooks, 100, EXPIRE_DELAY);

      expect(hooks.triggerSpan({ startTime: T0 })).toBe(DISCARDED);
    });

    it('telemetry hook returns SKIPPED (undefined)', async () => {
      const hooks = createFormatHooks();
      await SessionContext.init(hooks, 100, EXPIRE_DELAY);

      expect(hooks.triggerTelemetry({ startTime: T0 })).toBeUndefined();
    });
  });

  describe('after add()', () => {
    it('RUM hook returns the session id', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, 100, EXPIRE_DELAY);

      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED });

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toMatchObject({
        session: { id: 'session-abc' },
      });
    });

    it('span hook returns the session id', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, 100, EXPIRE_DELAY);

      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED });

      expect(hooks.triggerSpan({ startTime: T0 })).toMatchObject({
        meta: {
          '_dd.session.id': 'session-abc',
        },
      });
    });

    it('telemetry hook returns the session id', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, 100, EXPIRE_DELAY);

      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED });

      expect(hooks.triggerTelemetry({ startTime: T0 })).toMatchObject({
        session: { id: 'session-abc' },
      });
    });

    it('reflects the latest add()', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, 100, EXPIRE_DELAY);

      context.add({ id: 'session-first', trackingType: TrackingType.TRACKED }); // at T0
      vi.advanceTimersByTime(10); // advance to T10
      context.add({ id: 'session-second', trackingType: TrackingType.TRACKED }); // at T10

      expect(hooks.triggerRum({ eventType: 'view', startTime: 10 as TimeStamp })).toMatchObject({
        session: { id: 'session-second' },
      });
    });
  });

  describe('after close()', () => {
    it('RUM hook still attributes events during the session period (crash attribution)', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, 100, EXPIRE_DELAY);

      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED }); // at T0 = 0
      vi.advanceTimersByTime(10); // time is now 10
      context.close(); // closed at T10

      // event at T0 (during active period) is still attributed
      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toMatchObject({
        session: { id: 'session-abc' },
      });
    });

    it('RUM hook returns DISCARDED for events before the session started', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, 100, EXPIRE_DELAY);

      vi.advanceTimersByTime(10); // advance to T10
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED }); // session started at T10
      context.close();

      // event at T0 (before session started at T10) → DISCARDED
      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toBe(DISCARDED);
    });

    it('span hook still attributes events during the session period (crash attribution)', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, 100, EXPIRE_DELAY);

      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED }); // at T0 = 0
      vi.advanceTimersByTime(10); // time is now 10
      context.close(); // closed at T10

      // event at T0 (during active period) is still attributed
      expect(hooks.triggerSpan({ startTime: T0 })).toMatchObject({
        meta: {
          '_dd.session.id': 'session-abc',
        },
      });
    });

    it('span hook returns DISCARDED for events before the session started', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, 100, EXPIRE_DELAY);

      vi.advanceTimersByTime(10); // advance to T10
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED }); // session started at T10
      context.close();

      // event at T0 (before session started at T10) → DISCARDED
      expect(hooks.triggerSpan({ startTime: T0 })).toBe(DISCARDED);
    });

    it('telemetry hook still attributes events during the session period', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, 100, EXPIRE_DELAY);

      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED }); // at T0 = 0
      vi.advanceTimersByTime(10);
      context.close();

      expect(hooks.triggerTelemetry({ startTime: T0 })).toMatchObject({
        session: { id: 'session-abc' },
      });
    });

    it('RUM hook returns DISCARDED for events after the session ended', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, 100, EXPIRE_DELAY);

      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED }); // at T0
      vi.advanceTimersByTime(10); // now T10
      context.close(); // closed at T10

      // Event at T20 (after session ended at T10) → DISCARDED
      expect(hooks.triggerRum({ eventType: 'view', startTime: 20 as TimeStamp })).toBe(DISCARDED);
    });
  });

  describe('sampling', () => {
    async function init(sessionSampleRate = 100) {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, sessionSampleRate, EXPIRE_DELAY);
      return { hooks, context };
    }

    it('discards the RUM events of a session the draw did not keep, but still attributes telemetry', async () => {
      const { hooks, context } = await init();
      context.add({ id: 'session-abc', trackingType: TrackingType.NOT_TRACKED });

      expect(hooks.triggerRum({ eventType: 'error', startTime: T0 })).toBe(DISCARDED);
      expect(hooks.triggerTelemetry({ startTime: T0 })).toMatchObject({ session: { id: 'session-abc' } });
    });

    it('reports the configured rate on a drawn session, and no on-error marker', async () => {
      const { hooks, context } = await init(12.5);
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED });

      const view = hooks.triggerRum({ eventType: 'view', startTime: T0 });

      expect(view).toMatchObject({ _dd: { configuration: { session_sample_rate: 12.5 } } });
      expect(view).not.toHaveProperty('session.sampled_for_error', true);
    });

    it('marks the views of a session kept on error, and reports a rate of 0 on every event', async () => {
      const { hooks, context } = await init(20);
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED_ON_ERROR });

      const view = hooks.triggerRum({ eventType: 'view', startTime: T0 });
      const action = hooks.triggerRum({ eventType: 'action', startTime: T0 });

      expect(view).toMatchObject({
        session: { id: 'session-abc', sampled_for_error: true },
        _dd: { configuration: { session_sample_rate: 0 } },
      });
      expect(action).toMatchObject({ _dd: { configuration: { session_sample_rate: 0 } } });
      expect(action).not.toHaveProperty('session.sampled_for_error', true);
    });

    it('keeps the marker and the rate of 0 once the session is released', async () => {
      const { hooks, context } = await init(20);
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED_ON_ERROR });
      context.setHasError('session-abc');

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toMatchObject({
        session: { sampled_for_error: true },
        _dd: { configuration: { session_sample_rate: 0 } },
      });
    });

    it('discards the stragglers of a withheld session that ended without an error', async () => {
      const { hooks, context } = await init();
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED_ON_ERROR });
      vi.advanceTimersByTime(10);
      context.close();

      expect(hooks.triggerRum({ eventType: 'resource', startTime: T0 })).toBe(DISCARDED);
    });

    it('lets the stragglers of a released session through', async () => {
      const { hooks, context } = await init();
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED_ON_ERROR });
      context.setHasError('session-abc');
      vi.advanceTimersByTime(10);
      context.close();

      expect(hooks.triggerRum({ eventType: 'resource', startTime: T0 })).toMatchObject({
        session: { id: 'session-abc' },
      });
    });

    it('marks every entry of a session, so a crash of an earlier launch is resolved as released', async () => {
      const { hooks, context } = await init();
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED_ON_ERROR }); // first launch, at T0
      vi.advanceTimersByTime(10);
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED_ON_ERROR }); // resumed, at T10
      vi.advanceTimersByTime(10);
      context.add({ id: 'session-next', trackingType: TrackingType.TRACKED }); // at T20

      expect(hooks.triggerRum({ eventType: 'error', startTime: T0 })).toBe(DISCARDED);
      context.setHasError('session-abc');
      expect(hooks.triggerRum({ eventType: 'error', startTime: T0 })).toMatchObject({ session: { id: 'session-abc' } });
    });

    it('persists the error mark', async () => {
      const { context } = await init();
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED_ON_ERROR });
      await vi.advanceTimersByTimeAsync(0);
      mfs.writeFile.mockClear();

      context.setHasError('session-abc');
      await vi.advanceTimersByTimeAsync(0);

      expect(mfs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('_dd_session_history'),
        expect.stringContaining('"hasError":true'),
        'utf-8'
      );
    });

    it('does not mark, nor write, a session that withholds nothing', async () => {
      const { context } = await init();
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED });
      await vi.advanceTimersByTimeAsync(0);
      mfs.writeFile.mockClear();

      context.setHasError('session-abc');
      await vi.advanceTimersByTimeAsync(0);

      expect(mfs.writeFile).not.toHaveBeenCalled();
      expect(context.find(T0)).not.toHaveProperty('hasError');
    });

    it('restores the sampling of past sessions from disk, for a crash reported on the next launch', async () => {
      mfs.readFile.mockResolvedValue(
        JSON.stringify([{ startTime: 0, endTime: 5, value: { id: 'crashed', trackingType: '4', hasError: true } }])
      );
      const { hooks } = await init(20);

      expect(hooks.triggerRum({ eventType: 'error', startTime: T0 })).toMatchObject({
        session: { id: 'crashed' },
        _dd: { configuration: { session_sample_rate: 0 } },
      });
    });

    it('reads an entry written before sessions were sampled as a drawn session', async () => {
      mfs.readFile.mockResolvedValue(JSON.stringify([{ startTime: 0, endTime: 5, value: 'legacy-session' }]));
      const { hooks } = await init(20);

      expect(hooks.triggerRum({ eventType: 'error', startTime: T0 })).toMatchObject({
        session: { id: 'legacy-session' },
        _dd: { configuration: { session_sample_rate: 20 } },
      });
    });
  });
});

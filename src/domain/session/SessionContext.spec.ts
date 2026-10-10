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
import { SessionContext, TrackingType, withholdsEvents } from './SessionContext';

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
      await SessionContext.init(hooks, EXPIRE_DELAY);

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toBe(DISCARDED);
    });

    it('span hook returns DISCARDED', async () => {
      const hooks = createFormatHooks();
      await SessionContext.init(hooks, EXPIRE_DELAY);

      expect(hooks.triggerSpan({ startTime: T0 })).toBe(DISCARDED);
    });

    it('telemetry hook returns SKIPPED (undefined)', async () => {
      const hooks = createFormatHooks();
      await SessionContext.init(hooks, EXPIRE_DELAY);

      expect(hooks.triggerTelemetry({ startTime: T0 })).toBeUndefined();
    });
  });

  describe('after add()', () => {
    it('RUM hook returns the session id', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED, sampleRate: 100 });

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toMatchObject({
        session: { id: 'session-abc' },
      });
    });

    it('span hook returns the session id', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED, sampleRate: 100 });

      expect(hooks.triggerSpan({ startTime: T0 })).toMatchObject({
        meta: {
          '_dd.session.id': 'session-abc',
        },
      });
    });

    it('telemetry hook returns the session id', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED, sampleRate: 100 });

      expect(hooks.triggerTelemetry({ startTime: T0 })).toMatchObject({
        session: { id: 'session-abc' },
      });
    });

    it('reflects the latest add()', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      context.add({ id: 'session-first', trackingType: TrackingType.TRACKED, sampleRate: 100 }); // at T0
      vi.advanceTimersByTime(10); // advance to T10
      context.add({ id: 'session-second', trackingType: TrackingType.TRACKED, sampleRate: 100 }); // at T10

      expect(hooks.triggerRum({ eventType: 'view', startTime: 10 as TimeStamp })).toMatchObject({
        session: { id: 'session-second' },
      });
    });
  });

  describe('remote configuration version', () => {
    it('reports the version a session was drawn under, and keeps reporting it after the session ended', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED, sampleRate: 20, rcVersion: 6 });
      vi.advanceTimersByTime(10);
      context.close();

      expect(hooks.triggerRum({ eventType: 'error', startTime: T0 })).toMatchObject({
        _dd: { configuration: { session_sample_rate: 20, rc_version: 6 } },
      });
    });

    it.each([
      { title: 'a whole version', rcVersion: 2, kept: true },
      { title: 'a negative version', rcVersion: -1, kept: false },
      { title: 'a fractional version', rcVersion: 2.5, kept: false },
      { title: 'a version as a string', rcVersion: '2', kept: false },
    ])('restores a history entry with $title only if it is well formed', async ({ rcVersion, kept }) => {
      mfs.readFile.mockResolvedValue(
        JSON.stringify([
          {
            startTime: 0,
            endTime: 10,
            value: { id: 'session-abc', trackingType: TrackingType.TRACKED, sampleRate: 100, rcVersion },
          },
        ])
      );
      const hooks = createFormatHooks();
      await SessionContext.init(hooks, EXPIRE_DELAY);

      const result = hooks.triggerRum({ eventType: 'error', startTime: T0 });
      if (kept) {
        expect(result).toMatchObject({ session: { id: 'session-abc' }, _dd: { configuration: { rc_version: 2 } } });
      } else {
        expect(result).toBe(DISCARDED);
      }
    });
  });

  describe('after close()', () => {
    it('RUM hook still attributes events during the session period (crash attribution)', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED, sampleRate: 100 }); // at T0 = 0
      vi.advanceTimersByTime(10); // time is now 10
      context.close(); // closed at T10

      // event at T0 (during active period) is still attributed
      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toMatchObject({
        session: { id: 'session-abc' },
      });
    });

    it('RUM hook returns DISCARDED for events before the session started', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      vi.advanceTimersByTime(10); // advance to T10
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED, sampleRate: 100 }); // session started at T10
      context.close();

      // event at T0 (before session started at T10) → DISCARDED
      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toBe(DISCARDED);
    });

    it('span hook still attributes events during the session period (crash attribution)', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED, sampleRate: 100 }); // at T0 = 0
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
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      vi.advanceTimersByTime(10); // advance to T10
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED, sampleRate: 100 }); // session started at T10
      context.close();

      // event at T0 (before session started at T10) → DISCARDED
      expect(hooks.triggerSpan({ startTime: T0 })).toBe(DISCARDED);
    });

    it('telemetry hook still attributes events during the session period', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED, sampleRate: 100 }); // at T0 = 0
      vi.advanceTimersByTime(10);
      context.close();

      expect(hooks.triggerTelemetry({ startTime: T0 })).toMatchObject({
        session: { id: 'session-abc' },
      });
    });

    it('RUM hook returns DISCARDED for events after the session ended', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED, sampleRate: 100 }); // at T0
      vi.advanceTimersByTime(10); // now T10
      context.close(); // closed at T10

      // Event at T20 (after session ended at T10) → DISCARDED
      expect(hooks.triggerRum({ eventType: 'view', startTime: 20 as TimeStamp })).toBe(DISCARDED);
    });
  });

  describe('sampling', () => {
    async function init() {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);
      return { hooks, context };
    }

    it('discards the RUM events of a session the draw did not keep, and attributes its telemetry to no session', async () => {
      const { hooks, context } = await init();
      context.add({ id: 'session-abc', trackingType: TrackingType.NOT_TRACKED, sampleRate: 50 });

      expect(hooks.triggerRum({ eventType: 'error', startTime: T0 })).toBe(DISCARDED);
      expect(hooks.triggerTelemetry({ startTime: T0 })).toBeUndefined();
    });

    it('still attributes the telemetry of a withheld session', async () => {
      const { hooks, context } = await init();
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED_ON_ERROR, sampleRate: 50 });

      expect(hooks.triggerTelemetry({ startTime: T0 })).toMatchObject({ session: { id: 'session-abc' } });
    });

    it('reports the rate a drawn session was drawn at, and no on-error marker', async () => {
      const { hooks, context } = await init();
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED, sampleRate: 12.5 });

      const view = hooks.triggerRum({ eventType: 'view', startTime: T0 });

      expect(view).toMatchObject({ _dd: { configuration: { session_sample_rate: 12.5 } } });
      expect(view).not.toHaveProperty('session.sampled_for_error', true);
    });

    it('marks the views of a session kept on error, and reports a rate of 0 on every event', async () => {
      const { hooks, context } = await init();
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED_ON_ERROR, sampleRate: 20 });

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
      const { hooks, context } = await init();
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED_ON_ERROR, sampleRate: 20 });
      context.setHasError('session-abc', T0);

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toMatchObject({
        session: { sampled_for_error: true },
        _dd: { configuration: { session_sample_rate: 0 } },
      });
    });

    it('discards the stragglers of a withheld session that ended without an error', async () => {
      const { hooks, context } = await init();
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED_ON_ERROR, sampleRate: 100 });
      vi.advanceTimersByTime(10);
      context.close();

      expect(hooks.triggerRum({ eventType: 'resource', startTime: T0 })).toBe(DISCARDED);
    });

    it('lets the stragglers of a released session through', async () => {
      const { hooks, context } = await init();
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED_ON_ERROR, sampleRate: 100 });
      context.setHasError('session-abc', T0);
      vi.advanceTimersByTime(10);
      context.close();

      expect(hooks.triggerRum({ eventType: 'resource', startTime: T0 })).toMatchObject({
        session: { id: 'session-abc' },
      });
    });

    it('lets a crash of an earlier launch through once it is marked, after the session ended', async () => {
      const { hooks, context } = await init();
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED_ON_ERROR, sampleRate: 100 }); // at T0
      vi.advanceTimersByTime(10);
      context.close();
      context.add({ id: 'session-next', trackingType: TrackingType.TRACKED, sampleRate: 100 }); // at T10

      expect(hooks.triggerRum({ eventType: 'error', startTime: T0 })).toBe(DISCARDED);
      context.setHasError('session-abc', T0);
      expect(hooks.triggerRum({ eventType: 'error', startTime: T0 })).toMatchObject({ session: { id: 'session-abc' } });
    });

    it('marks the entry in force at the time of the error only, one launch of a resumed session at a time', async () => {
      const { context } = await init();
      const T10 = 10 as TimeStamp;
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED_ON_ERROR, sampleRate: 0 }); // first launch, at T0
      vi.advanceTimersByTime(10);
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED_ON_ERROR, sampleRate: 0 }); // resumed, at T10

      // An error of the current launch says nothing about what the earlier launch uploaded.
      context.setHasError('session-abc', T10);
      expect(withholdsEvents(context.find(T10)!)).toBe(false);
      expect(withholdsEvents(context.find(T0)!)).toBe(true);

      // A crash of the earlier launch, reported now, does.
      context.setHasError('session-abc', T0);
      expect(withholdsEvents(context.find(T0)!)).toBe(false);
    });

    it('releases the current launch too when a crash of an earlier launch releases the session it resumed', async () => {
      const { hooks, context } = await init();
      const T10 = 10 as TimeStamp;
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED_ON_ERROR, sampleRate: 0 }); // first launch, at T0
      vi.advanceTimersByTime(10);
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED_ON_ERROR, sampleRate: 0 }); // resumed, at T10

      // The crash is the session's error: from now on everything of it is uploaded, this launch's
      // events included — so once the session ends, its final view must not be read as a straggler.
      context.setHasError('session-abc', T0);
      vi.advanceTimersByTime(10);
      context.close();

      expect(hooks.triggerRum({ eventType: 'view', startTime: T10 })).toMatchObject({ session: { id: 'session-abc' } });
    });

    it('marks nothing when the session in force at the time is another one', async () => {
      const { context } = await init();
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED_ON_ERROR, sampleRate: 0 });

      context.setHasError('session-other', T0);

      expect(withholdsEvents(context.find(T0)!)).toBe(true);
    });

    it('persists the error mark', async () => {
      const { context } = await init();
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED_ON_ERROR, sampleRate: 100 });
      await vi.advanceTimersByTimeAsync(0);
      mfs.writeFile.mockClear();

      context.setHasError('session-abc', T0);
      await vi.advanceTimersByTimeAsync(0);

      expect(mfs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('_dd_session_history.'),
        expect.stringContaining('"hasError":true'),
        'utf-8'
      );
    });

    it('does not mark, nor write, a session that withholds nothing', async () => {
      const { context } = await init();
      context.add({ id: 'session-abc', trackingType: TrackingType.TRACKED, sampleRate: 100 });
      await vi.advanceTimersByTimeAsync(0);
      mfs.writeFile.mockClear();

      context.setHasError('session-abc', T0);
      await vi.advanceTimersByTimeAsync(0);

      expect(mfs.writeFile).not.toHaveBeenCalled();
      expect(context.find(T0)).not.toHaveProperty('hasError');
    });

    it('restores the sampling of past sessions from disk, for a crash reported on the next launch', async () => {
      mfs.readFile.mockResolvedValue(
        JSON.stringify([
          { startTime: 0, endTime: 5, value: { id: 'crashed', trackingType: '4', sampleRate: 0, hasError: true } },
        ])
      );
      const { hooks } = await init();

      expect(hooks.triggerRum({ eventType: 'error', startTime: T0 })).toMatchObject({
        session: { id: 'crashed' },
        _dd: { configuration: { session_sample_rate: 0 } },
      });
    });

    it.each([
      [
        'a string where the error mark should be a boolean',
        { id: 'bad', trackingType: '4', sampleRate: 0, hasError: 'false' },
      ],
      ['an unknown tracking type', { id: 'bad', trackingType: 7, sampleRate: 0 }],
      ['a rate that is not a finite number', { id: 'bad', trackingType: '2', sampleRate: null }],
      ['no id', { trackingType: '2', sampleRate: 100 }],
      ['a rate above 100', { id: 'bad', trackingType: '2', sampleRate: 150 }],
      ['a negative rate', { id: 'bad', trackingType: '2', sampleRate: -1 }],
      ['a null tracking type', { id: 'bad', trackingType: null, sampleRate: 0 }],
    ])(
      'discards the events of a session whose saved record is malformed (%s), rather than uploading them',
      async (_, value) => {
        mfs.readFile.mockResolvedValue(JSON.stringify([{ startTime: 0, endTime: 5, value }]));
        const { hooks } = await init();

        expect(hooks.triggerRum({ eventType: 'error', startTime: T0 })).toBe(DISCARDED);
      }
    );

    it('reads an entry written before sessions were sampled as a session drawn at 100', async () => {
      mfs.readFile.mockResolvedValue(JSON.stringify([{ startTime: 0, endTime: 5, value: 'legacy-session' }]));
      const { hooks } = await init();

      expect(hooks.triggerRum({ eventType: 'error', startTime: T0 })).toMatchObject({
        session: { id: 'legacy-session' },
        _dd: { configuration: { session_sample_rate: 100 } },
      });
    });
  });
});

import { mockFs } from '../../mocks.specUtil';
vi.mock('node:fs/promises');
const { writeFileSync, renameSync, unlinkSync } = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));
vi.mock('node:fs', () => ({ writeFileSync, renameSync, unlinkSync }));
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data'),
  },
}));

import * as display from '../../tools/display';
vi.mock('../../tools/display', () => ({
  displayError: vi.fn(),
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { type TimeStamp } from '@flashcatcloud/browser-core';
import {
  SessionManager,
  SESSION_EXPIRATION_DELAY,
  SESSION_FILE_NAME,
  type SamplingConfiguration,
} from './SessionManager';
import { SESSION_TIME_OUT_DELAY } from './session.constants';
import { TrackingType } from './SessionContext';

const T0 = 0 as TimeStamp;
const SAMPLING = { sessionSampleRate: 100, sessionOnError: false };
import { EventManager, EventKind, LifecycleKind, type LifecycleEvent } from '../../event';
import { createFormatHooks, type FormatHooks } from '../../assembly';

const mfs = mockFs();

function mockNoSessionFile() {
  mfs.access.mockRejectedValue(new Error('ENOENT'));
}

describe('sessionManager', () => {
  let eventManager: EventManager;
  let hooks: FormatHooks;
  let sessionManager: SessionManager;
  let lifecycleEvents: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mfs.writeFile.mockResolvedValue(undefined);
    eventManager = new EventManager();
    lifecycleEvents = [];
    eventManager.registerHandler<LifecycleEvent>({
      canHandle: (event): event is LifecycleEvent => event.kind === EventKind.LIFECYCLE,
      handle: (event) => lifecycleEvents.push(event.lifecycle),
    });
    hooks = createFormatHooks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mfs.reset();
    sessionManager.stop();
  });

  describe('session creation', () => {
    it('creates new session when no file exists', async () => {
      mockNoSessionFile();

      sessionManager = await SessionManager.start(eventManager, hooks, () => SAMPLING);

      expect(sessionManager.getSession().id).toMatch(/^[0-9a-f-]+$/);
      expect(sessionManager.getSession().status).toBe('active');
      expect(mfs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(SESSION_FILE_NAME),
        expect.any(String),
        'utf-8'
      );

      // no session renew event on initial session creation
      expect(lifecycleEvents).not.toContain(LifecycleKind.SESSION_RENEW);
    });

    it('resumes valid existing session', async () => {
      const now = Date.now();
      const existingState = {
        id: 'existing-session-id',
        created: now - 1000,
        lastActivity: now - 1000,
      };

      mfs.readFile.mockResolvedValue(JSON.stringify(existingState));

      sessionManager = await SessionManager.start(eventManager, hooks, () => SAMPLING);

      expect(sessionManager.getSession().id).toBe('existing-session-id');
      expect(sessionManager.getSession().status).toBe('active');
    });

    it('creates new session when existing is expired (inactivity)', async () => {
      const now = Date.now();
      const existingState = {
        id: 'expired-session-id',
        created: now - SESSION_EXPIRATION_DELAY - 1000,
        lastActivity: now - SESSION_EXPIRATION_DELAY - 1000,
      };

      mfs.readFile.mockResolvedValue(JSON.stringify(existingState));

      sessionManager = await SessionManager.start(eventManager, hooks, () => SAMPLING);

      expect(sessionManager.getSession().id).not.toBe('expired-session-id');
      expect(sessionManager.getSession().status).toBe('active');
    });

    it('creates new session when existing is expired (session timeout)', async () => {
      const now = Date.now();
      const existingState = {
        id: 'timed-out-session-id',
        created: now - SESSION_TIME_OUT_DELAY - 1000,
        lastActivity: now - 1000,
      };

      mfs.readFile.mockResolvedValue(JSON.stringify(existingState));

      sessionManager = await SessionManager.start(eventManager, hooks, () => SAMPLING);

      expect(sessionManager.getSession().id).not.toBe('timed-out-session-id');
      expect(sessionManager.getSession().status).toBe('active');
    });

    it('closes previous session history entry on restart when session expired', async () => {
      vi.setSystemTime(1000);
      const now = Date.now();
      const expiredState = {
        id: 'expired-session-id',
        created: now - SESSION_EXPIRATION_DELAY - 1000,
        lastActivity: now - SESSION_EXPIRATION_DELAY - 1000,
      };
      mfs.readFile
        .mockResolvedValueOnce(JSON.stringify(expiredState)) // _dd_s
        .mockResolvedValueOnce(JSON.stringify([{ startTime: 0, endTime: null, value: 'expired-session-id' }])); // _dd_session_history

      sessionManager = await SessionManager.start(eventManager, hooks, () => SAMPLING);

      const newSessionId = sessionManager.getSession().id;
      expect(newSessionId).not.toBe('expired-session-id');

      // Event at T_now (after restart) → new session
      expect(hooks.triggerRum({ eventType: 'view', startTime: now as TimeStamp })).toMatchObject({
        session: { id: newSessionId },
      });

      // Event at T0 (before restart, within old session) → old session (crash attribution)
      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toMatchObject({
        session: { id: 'expired-session-id' },
      });
    });
  });

  describe('session expiration', () => {
    it('expires session after inactivity delay', async () => {
      mockNoSessionFile();

      sessionManager = await SessionManager.start(eventManager, hooks, () => SAMPLING);

      expect(sessionManager.getSession().status).toBe('active');

      await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY);

      expect(sessionManager.getSession().status).toBe('expired');
      expect(unlinkSync).toHaveBeenCalled();
      expect(lifecycleEvents).toContain(LifecycleKind.SESSION_EXPIRED);
    });

    it('resets inactivity timer on activity', async () => {
      const now = Date.now();
      mockNoSessionFile();

      sessionManager = await SessionManager.start(eventManager, hooks, () => SAMPLING);

      const sessionId = sessionManager.getSession().id;

      // Advance time but not enough to expire
      await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY - 1000);

      // Simulate activity - need to mock readFile for the updateActivity call
      mfs.access.mockResolvedValue(undefined);
      mfs.readFile.mockResolvedValue(
        JSON.stringify({
          id: sessionId,
          created: now,
          lastActivity: now + SESSION_EXPIRATION_DELAY - 1000,
        })
      );

      eventManager.notify({
        kind: EventKind.LIFECYCLE,
        lifecycle: LifecycleKind.END_USER_ACTIVITY,
      });
      await vi.advanceTimersByTimeAsync(0);

      // Advance time again - should not expire yet because timer was reset
      await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY - 1000);

      expect(sessionManager.getSession().status).toBe('active');
      expect(sessionManager.getSession().id).toBe(sessionId);
    });

    it('expires session after session timeout regardless of activity', async () => {
      const startTime = Date.now();
      mockNoSessionFile();

      sessionManager = await SessionManager.start(eventManager, hooks, () => SAMPLING);

      const sessionId = sessionManager.getSession().id;
      expect(sessionId).toBeDefined();

      // Keep session alive with activity, but eventually hit session timeout
      // We need to keep refreshing activity to prevent inactivity timeout
      const activityIntervals = Math.floor(SESSION_TIME_OUT_DELAY / (SESSION_EXPIRATION_DELAY / 2));

      for (let i = 0; i < activityIntervals - 1; i++) {
        // Advance time but not enough to trigger inactivity expiration
        await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY / 2);

        if (sessionManager.getSession().status === 'active') {
          // Simulate activity to reset inactivity timer
          mfs.access.mockResolvedValue(undefined);
          mfs.readFile.mockResolvedValue(
            JSON.stringify({
              id: sessionId,
              created: startTime,
              lastActivity: Date.now(),
            })
          );
          eventManager.notify({
            kind: EventKind.LIFECYCLE,
            lifecycle: LifecycleKind.END_USER_ACTIVITY,
          });
          await vi.advanceTimersByTimeAsync(0);
        }
      }

      // Session should still be alive (we've been keeping it active)
      expect(sessionManager.getSession().status).toBe('active');

      // Advance past session timeout
      await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY);

      // Session should be expired due to session timeout
      expect(sessionManager.getSession().status).toBe('expired');
      expect(lifecycleEvents).toContain(LifecycleKind.SESSION_EXPIRED);
    });

    it('creates new session on activity when expired', async () => {
      mockNoSessionFile();

      sessionManager = await SessionManager.start(eventManager, hooks, () => SAMPLING);

      const originalSessionId = sessionManager.getSession().id;
      expect(sessionManager.getSession().status).toBe('active');

      // Let session expire
      await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY);
      expect(sessionManager.getSession().status).toBe('expired');
      expect(sessionManager.getSession().id).toBe(originalSessionId);

      // Trigger activity on expired session
      eventManager.notify({
        kind: EventKind.LIFECYCLE,
        lifecycle: LifecycleKind.END_USER_ACTIVITY,
      });
      await vi.advanceTimersByTimeAsync(0);

      // Should have a new session with active status
      expect(sessionManager.getSession().status).toBe('active');
      expect(sessionManager.getSession().id).not.toBe(originalSessionId);

      expect(lifecycleEvents).toContain(LifecycleKind.SESSION_RENEW);
    });
  });

  describe('error handling', () => {
    it('handles file read errors gracefully', async () => {
      mfs.access.mockResolvedValue(undefined);
      mfs.readFile.mockRejectedValue(new Error('Read error'));

      sessionManager = await SessionManager.start(eventManager, hooks, () => SAMPLING);

      // Should create a new session despite read error

      expect(sessionManager.getSession().status).toBe('active');
    });

    it('handles file write errors gracefully', async () => {
      mockNoSessionFile();
      mfs.writeFile.mockRejectedValue(new Error('Write error'));

      sessionManager = await SessionManager.start(eventManager, hooks, () => SAMPLING);

      // Session should still be created in memory

      expect(sessionManager.getSession().status).toBe('active');
      expect(display.displayError).toHaveBeenCalledWith('Failed to write session state:', expect.any(Error));
    });

    it('handles JSON parse errors gracefully', async () => {
      mfs.access.mockResolvedValue(undefined);
      mfs.readFile.mockResolvedValue('invalid json');

      sessionManager = await SessionManager.start(eventManager, hooks, () => SAMPLING);

      // Should create a new session despite parse error

      expect(sessionManager.getSession().status).toBe('active');
    });
  });

  describe('expire', () => {
    it('sets session status to expired and clears timers', async () => {
      mockNoSessionFile();

      sessionManager = await SessionManager.start(eventManager, hooks, () => SAMPLING);

      expect(sessionManager.getSession().status).toBe('active');

      sessionManager.expire();

      expect(sessionManager.getSession().status).toBe('expired');
      expect(lifecycleEvents).toContain(LifecycleKind.SESSION_EXPIRED);
      // The delete waits its turn behind the queued writes.
      await vi.advanceTimersByTimeAsync(0);
      expect(unlinkSync).toHaveBeenCalled();
    });
  });

  describe('hook registration', () => {
    it('RUM hook returns session id immediately after start()', async () => {
      mockNoSessionFile();

      sessionManager = await SessionManager.start(eventManager, hooks, () => SAMPLING);

      const result = hooks.triggerRum({ eventType: 'view', startTime: T0 });
      expect(result).toMatchObject({ session: { id: sessionManager.getSession().id } });
    });

    it('telemetry hook returns session id immediately after start()', async () => {
      mockNoSessionFile();

      sessionManager = await SessionManager.start(eventManager, hooks, () => SAMPLING);

      const result = hooks.triggerTelemetry({ startTime: T0 });
      expect(result).toMatchObject({ session: { id: sessionManager.getSession().id } });
    });
  });

  describe('getSession', () => {
    it('should not allow to mutate the current session', async () => {
      mockNoSessionFile();

      sessionManager = await SessionManager.start(eventManager, hooks, () => SAMPLING);

      const session = sessionManager.getSession();
      session.id = 'new-id';

      expect(sessionManager.getSession().id).not.toBe('new-id');
    });
  });

  describe('sampling', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    function savedSessionStates(): Record<string, unknown>[] {
      return mfs.writeFile.mock.calls
        .filter(([filePath]) => (filePath as string).includes(`/${SESSION_FILE_NAME}.`))
        .map(([, content]) => JSON.parse(content as string) as Record<string, unknown>);
    }

    it.each([
      { sessionSampleRate: 100, sessionOnError: false, random: 0.99, expected: TrackingType.TRACKED },
      { sessionSampleRate: 100, sessionOnError: true, random: 0.99, expected: TrackingType.TRACKED },
      { sessionSampleRate: 50, sessionOnError: true, random: 0.2, expected: TrackingType.TRACKED },
      { sessionSampleRate: 50, sessionOnError: true, random: 0.8, expected: TrackingType.TRACKED_ON_ERROR },
      { sessionSampleRate: 50, sessionOnError: false, random: 0.8, expected: TrackingType.NOT_TRACKED },
      { sessionSampleRate: 0, sessionOnError: true, random: 0, expected: TrackingType.TRACKED_ON_ERROR },
      { sessionSampleRate: 0, sessionOnError: false, random: 0, expected: TrackingType.NOT_TRACKED },
    ])(
      'draws $expected at rate $sessionSampleRate with sessionOnError $sessionOnError (random $random)',
      async ({ sessionSampleRate, sessionOnError, random, expected }) => {
        mockNoSessionFile();
        vi.spyOn(Math, 'random').mockReturnValue(random);

        sessionManager = await SessionManager.start(eventManager, hooks, () => ({ sessionSampleRate, sessionOnError }));

        expect(sessionManager.getSession()).toMatchObject({ trackingType: expected, sampleRate: sessionSampleRate });
        expect(savedSessionStates()[0]).toMatchObject({ trackingType: expected, sampleRate: sessionSampleRate });
      }
    );

    it('does not write back a state read before the session ended', async () => {
      mockNoSessionFile();
      sessionManager = await SessionManager.start(eventManager, hooks, () => SAMPLING);
      const { id } = sessionManager.getSession();
      let finishRead!: (content: string) => void;
      mfs.access.mockResolvedValue(undefined);
      mfs.readFile.mockImplementationOnce(() => new Promise<string>((resolve) => (finishRead = resolve)));
      mfs.unlink.mockResolvedValue(undefined);
      mfs.writeFile.mockClear();

      // An activity update starts reading the state, and the session ends before the read completes.
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });
      await vi.advanceTimersByTimeAsync(0);
      sessionManager.expire();
      finishRead(
        JSON.stringify({ id, created: 0, lastActivity: 0, trackingType: TrackingType.TRACKED, sampleRate: 100 })
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(savedSessionStates()).toEqual([]);
    });

    it('closes the previous launch of a resumed session in the history, so the file does not grow with every launch', async () => {
      const now = Date.now();
      mfs.readFile.mockImplementation((filePath: string) =>
        Promise.resolve(
          filePath.endsWith(SESSION_FILE_NAME)
            ? JSON.stringify({
                id: 'existing',
                created: now,
                lastActivity: now,
                trackingType: TrackingType.TRACKED,
                sampleRate: 100,
              })
            : JSON.stringify([
                { startTime: now - 10, endTime: null, value: { id: 'existing', trackingType: '2', sampleRate: 100 } },
              ])
        )
      );

      sessionManager = await SessionManager.start(eventManager, hooks, () => SAMPLING);
      await vi.advanceTimersByTimeAsync(0);

      const histories = mfs.writeFile.mock.calls
        .filter(([filePath]) => (filePath as string).includes('/_dd_session_history.'))
        .map(([, content]) => JSON.parse(content as string) as { endTime: number | null; startTime: number }[]);
      const latest = histories[histories.length - 1];
      expect(latest).toHaveLength(2);
      // Newest first: this launch's entry open, the previous launch's closed at this launch.
      expect(latest[0]).toMatchObject({ startTime: now, endTime: null });
      expect(latest[1]).toMatchObject({ startTime: now - 10, endTime: now });
      // Events of the previous launch still resolve to it.
      expect(hooks.triggerRum({ eventType: 'error', startTime: (now - 5) as TimeStamp })).toMatchObject({
        session: { id: 'existing' },
      });
    });

    it('reports the rate a resumed session was drawn at, not the one configured since', async () => {
      const now = Date.now();
      mfs.readFile.mockResolvedValue(
        JSON.stringify({
          id: 'existing',
          created: now,
          lastActivity: now,
          trackingType: TrackingType.TRACKED,
          sampleRate: 10,
        })
      );

      sessionManager = await SessionManager.start(eventManager, hooks, () => SAMPLING);

      expect(hooks.triggerRum({ eventType: 'view', startTime: now as TimeStamp })).toMatchObject({
        _dd: { configuration: { session_sample_rate: 10 } },
      });
    });

    it('keeps the decision a resumed session was created with, whatever the configuration says now', async () => {
      const now = Date.now();
      mfs.readFile.mockResolvedValue(
        JSON.stringify({ id: 'existing', created: now, lastActivity: now, trackingType: TrackingType.TRACKED_ON_ERROR })
      );

      sessionManager = await SessionManager.start(eventManager, hooks, () => ({
        sessionSampleRate: 100,
        sessionOnError: false,
      }));

      expect(sessionManager.getSession()).toMatchObject({
        id: 'existing',
        trackingType: TrackingType.TRACKED_ON_ERROR,
      });
      // Derived from the tracking type on the restore path too, not from the configured rate.
      expect(hooks.triggerRum({ eventType: 'view', startTime: now as TimeStamp })).toMatchObject({
        session: { id: 'existing', sampled_for_error: true },
        _dd: { configuration: { session_sample_rate: 0 } },
      });
    });

    it('resumes a session that had already reported its error as released', async () => {
      const now = Date.now();
      mfs.readFile.mockResolvedValue(
        JSON.stringify({
          id: 'existing',
          created: now,
          lastActivity: now,
          trackingType: TrackingType.TRACKED_ON_ERROR,
          hasError: true,
        })
      );

      sessionManager = await SessionManager.start(eventManager, hooks, () => SAMPLING);

      expect(sessionManager.getSession().hasError).toBe(true);
    });

    it.each([
      [
        'a string where the error mark should be a boolean',
        { trackingType: TrackingType.TRACKED_ON_ERROR, hasError: 'false' },
      ],
      ['a tracking type that is not one of the known ones', { trackingType: 0 }],
      ['a rate that is not a finite number', { trackingType: TrackingType.TRACKED, sampleRate: 'NaN' }],
      ['no id', { id: '' }],
    ])('starts a fresh session rather than resuming a saved state with %s', async (_, malformed) => {
      const now = Date.now();
      mfs.readFile.mockResolvedValue(
        JSON.stringify({ id: 'existing', created: now, lastActivity: now, sampleRate: 100, ...malformed })
      );

      sessionManager = await SessionManager.start(eventManager, hooks, () => ({
        sessionSampleRate: 0,
        sessionOnError: true,
      }));

      expect(sessionManager.getSession().id).not.toBe('existing');
      expect(sessionManager.getSession().trackingType).toBe(TrackingType.TRACKED_ON_ERROR);
    });

    it('resumes a session saved before sessions were sampled as a drawn one', async () => {
      const now = Date.now();
      mfs.readFile.mockResolvedValue(JSON.stringify({ id: 'existing', created: now, lastActivity: now }));

      sessionManager = await SessionManager.start(eventManager, hooks, () => ({
        sessionSampleRate: 20,
        sessionOnError: false,
      }));

      expect(sessionManager.getSession()).toMatchObject({ id: 'existing', trackingType: TrackingType.TRACKED });
      // Every session was collected then: it stands for itself, not for five.
      expect(hooks.triggerRum({ eventType: 'view', startTime: now as TimeStamp })).toMatchObject({
        _dd: { configuration: { session_sample_rate: 100 } },
      });
    });

    it('draws again when the session is renewed', async () => {
      mockNoSessionFile();
      const random = vi.spyOn(Math, 'random').mockReturnValue(0.8);
      sessionManager = await SessionManager.start(eventManager, hooks, () => ({
        sessionSampleRate: 50,
        sessionOnError: false,
      }));
      expect(sessionManager.getSession().trackingType).toBe(TrackingType.NOT_TRACKED);

      sessionManager.expire();
      random.mockReturnValue(0.2);
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });
      await vi.advanceTimersByTimeAsync(0);

      expect(sessionManager.getSession().trackingType).toBe(TrackingType.TRACKED);
    });

    describe('sampling read from a provider (remote configuration)', () => {
      it('reads the sampling at each draw, so a change applies to the next session and not to this one', async () => {
        mockNoSessionFile();
        let sampling: SamplingConfiguration = { sessionSampleRate: 100, sessionOnError: false };
        sessionManager = await SessionManager.start(eventManager, hooks, () => sampling);
        const first = sessionManager.getSession();

        sampling = { sessionSampleRate: 0, sessionOnError: false, rcVersion: 7 };
        expect(sessionManager.getSession()).toEqual(first);

        sessionManager.expire();
        eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });
        await vi.advanceTimersByTimeAsync(0);

        expect(sessionManager.getSession()).toMatchObject({
          trackingType: TrackingType.NOT_TRACKED,
          sampleRate: 0,
          rcVersion: 7,
        });
      });

      it('stores the configuration version a session was drawn under, and reports it on its events', async () => {
        mockNoSessionFile();
        sessionManager = await SessionManager.start(eventManager, hooks, () => ({
          sessionSampleRate: 100,
          sessionOnError: false,
          rcVersion: 3,
        }));

        expect(savedSessionStates()[0]).toMatchObject({ rcVersion: 3, sampleRate: 100 });
        expect(hooks.triggerRum({ eventType: 'view', startTime: Date.now() as TimeStamp })).toMatchObject({
          _dd: { configuration: { session_sample_rate: 100, rc_version: 3 } },
        });
      });

      it('reports no version for a session drawn without a delivered configuration', async () => {
        mockNoSessionFile();
        sessionManager = await SessionManager.start(eventManager, hooks, () => SAMPLING);

        expect(savedSessionStates()[0]).not.toHaveProperty('rcVersion');
        const result = hooks.triggerRum({ eventType: 'view', startTime: Date.now() as TimeStamp }) as {
          _dd: { configuration: Record<string, unknown> };
        };
        expect(result._dd.configuration.rc_version).toBeUndefined();
      });

      it('keeps the version a resumed session was drawn under, whatever is delivered now', async () => {
        const now = Date.now();
        mfs.readFile.mockResolvedValue(
          JSON.stringify({
            id: 'existing',
            created: now,
            lastActivity: now,
            trackingType: TrackingType.TRACKED_ON_ERROR,
            sampleRate: 0,
            rcVersion: 4,
          })
        );

        sessionManager = await SessionManager.start(eventManager, hooks, () => ({
          sessionSampleRate: 100,
          sessionOnError: false,
          rcVersion: 9,
        }));

        expect(sessionManager.getSession()).toMatchObject({ id: 'existing', rcVersion: 4 });
        // An on-error session stands for itself whatever it was drawn at.
        expect(hooks.triggerRum({ eventType: 'view', startTime: now as TimeStamp })).toMatchObject({
          _dd: { configuration: { session_sample_rate: 0, rc_version: 4 } },
        });
      });

      it.each([-1, 1.5, '3'])(
        'starts a fresh session rather than resuming one saved with version %s',
        async (rcVersion) => {
          const now = Date.now();
          mfs.readFile.mockResolvedValue(
            JSON.stringify({
              id: 'existing',
              created: now,
              lastActivity: now,
              trackingType: TrackingType.TRACKED,
              sampleRate: 100,
              rcVersion,
            })
          );

          sessionManager = await SessionManager.start(eventManager, hooks, () => SAMPLING);

          expect(sessionManager.getSession().id).not.toBe('existing');
        }
      );
    });

    describe('applySamplingChange (a configuration that applies at once)', () => {
      let sampling: SamplingConfiguration;

      async function startSession(drawnUnder: SamplingConfiguration, random = 0.5) {
        mockNoSessionFile();
        vi.spyOn(Math, 'random').mockReturnValue(random);
        sampling = drawnUnder;
        sessionManager = await SessionManager.start(eventManager, hooks, () => sampling);
        lifecycleEvents.length = 0;
      }

      /** Holds the next write of the session state file until the returned function is called. */
      function holdNextSessionStateWrite(): () => void {
        let finish: () => void = () => undefined;
        let held = false;
        mfs.writeFile.mockImplementation((filePath: string) => {
          if (!held && filePath.includes(`/${SESSION_FILE_NAME}.`)) {
            held = true;
            return new Promise<void>((resolve) => (finish = resolve));
          }
          return Promise.resolve();
        });
        return () => finish();
      }

      function applyChange(next: SamplingConfiguration) {
        sampling = next;
        sessionManager.applySamplingChange();
      }

      it.each([
        {
          title: 'a session drawn at rate 0 draws again when the rate leaves 0',
          drawnUnder: { sessionSampleRate: 0, sessionOnError: false },
          next: { sessionSampleRate: 30, sessionOnError: false },
          drawn: TrackingType.NOT_TRACKED,
          ends: true,
        },
        {
          title: 'a session drawn at rate 0 draws again when the on-error switch turns on',
          drawnUnder: { sessionSampleRate: 0, sessionOnError: false },
          next: { sessionSampleRate: 0, sessionOnError: true },
          drawn: TrackingType.NOT_TRACKED,
          ends: true,
        },
        {
          title: 'a session drawn at rate 0 stays when nothing would keep it now either',
          drawnUnder: { sessionSampleRate: 0, sessionOnError: false },
          next: { sessionSampleRate: 0, sessionOnError: false, rcVersion: 2 },
          drawn: TrackingType.NOT_TRACKED,
          ends: false,
        },
        {
          title: 'a session that lost a draw at a real rate keeps its outcome',
          drawnUnder: { sessionSampleRate: 50, sessionOnError: false },
          next: { sessionSampleRate: 100, sessionOnError: true },
          drawn: TrackingType.NOT_TRACKED,
          random: 0.8,
          ends: false,
        },
        {
          title: 'a drawn session meets the emergency stop',
          drawnUnder: { sessionSampleRate: 100, sessionOnError: false },
          next: { sessionSampleRate: 0, sessionOnError: false },
          drawn: TrackingType.TRACKED,
          ends: true,
        },
        {
          title: 'a drawn session meets the emergency stop even with the switch on: the switch shapes the next draw',
          drawnUnder: { sessionSampleRate: 100, sessionOnError: false },
          next: { sessionSampleRate: 0, sessionOnError: true },
          drawn: TrackingType.TRACKED,
          ends: true,
        },
        {
          title: 'an on-error session survives rate 0 while the switch stays on',
          drawnUnder: { sessionSampleRate: 0, sessionOnError: true },
          next: { sessionSampleRate: 0, sessionOnError: true, rcVersion: 5 },
          drawn: TrackingType.TRACKED_ON_ERROR,
          ends: false,
        },
        {
          title: 'an on-error session ends when the switch turns off at rate 0',
          drawnUnder: { sessionSampleRate: 0, sessionOnError: true },
          next: { sessionSampleRate: 0, sessionOnError: false },
          drawn: TrackingType.TRACKED_ON_ERROR,
          ends: true,
        },
        {
          title: 'a drawn session keeps its draw when the rate changes to another real rate',
          drawnUnder: { sessionSampleRate: 100, sessionOnError: false },
          next: { sessionSampleRate: 10, sessionOnError: false },
          drawn: TrackingType.TRACKED,
          ends: false,
        },
        {
          title: 'an on-error session keeps its draw when the rate rises above 0',
          drawnUnder: { sessionSampleRate: 0, sessionOnError: true },
          next: { sessionSampleRate: 50, sessionOnError: false },
          drawn: TrackingType.TRACKED_ON_ERROR,
          ends: false,
        },
      ])('$title', async ({ drawnUnder, next, drawn, random, ends }) => {
        await startSession(drawnUnder, random);
        expect(sessionManager.getSession().trackingType).toBe(drawn);

        applyChange(next);

        expect(sessionManager.getSession().status).toBe(ends ? 'expired' : 'active');
        expect(lifecycleEvents.includes(LifecycleKind.SESSION_EXPIRED)).toBe(ends);
      });

      it('draws the next session under the new sampling, and is idempotent for it', async () => {
        await startSession({ sessionSampleRate: 0, sessionOnError: false });

        applyChange({ sessionSampleRate: 0, sessionOnError: true, rcVersion: 6 });
        eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });
        await vi.advanceTimersByTimeAsync(0);

        const renewed = [LifecycleKind.SESSION_EXPIRED, LifecycleKind.END_USER_ACTIVITY, LifecycleKind.SESSION_RENEW];
        expect(lifecycleEvents).toEqual(renewed);
        expect(sessionManager.getSession()).toMatchObject({
          status: 'active',
          trackingType: TrackingType.TRACKED_ON_ERROR,
          rcVersion: 6,
        });

        // The same configuration again finds nothing decisive left.
        sessionManager.applySamplingChange();
        expect(sessionManager.getSession().status).toBe('active');
        expect(lifecycleEvents).toEqual(renewed);
      });

      it('neither schedules timers for nor announces a renewal of a session that ended while it was being saved', async () => {
        await startSession({ sessionSampleRate: 100, sessionOnError: false });
        sessionManager.expire();
        lifecycleEvents.length = 0;
        const finishWrite = holdNextSessionStateWrite();

        eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });
        await vi.advanceTimersByTimeAsync(0);
        // An immediate stop lands while the new session's state is being written.
        applyChange({ sessionSampleRate: 0, sessionOnError: false });
        finishWrite();
        await vi.advanceTimersByTimeAsync(0);

        expect(lifecycleEvents).toEqual([LifecycleKind.END_USER_ACTIVITY, LifecycleKind.SESSION_EXPIRED]);
        expect(sessionManager.getSession().status).toBe('expired');
        expect(vi.getTimerCount()).toBe(0);
      });

      it('leaves no timer behind that could end a later session early', async () => {
        await startSession({ sessionSampleRate: 100, sessionOnError: false });
        sessionManager.expire();
        const finishWrite = holdNextSessionStateWrite();
        eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });
        await vi.advanceTimersByTimeAsync(0);
        applyChange({ sessionSampleRate: 0, sessionOnError: false });
        finishWrite();
        await vi.advanceTimersByTimeAsync(0);

        // A minute later, before any stale inactivity timer could fire, a kept session is renewed.
        sampling = { sessionSampleRate: 100, sessionOnError: false };
        await vi.advanceTimersByTimeAsync(60_000);
        eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });
        await vi.advanceTimersByTimeAsync(0);

        expect(sessionManager.getSession().status).toBe('active');
        // Its own inactivity and four-hour timers, and nothing left over from the ended session.
        expect(vi.getTimerCount()).toBe(2);
      });

      it('does nothing to a session that has already ended', async () => {
        await startSession({ sessionSampleRate: 100, sessionOnError: false });
        sessionManager.expire();
        lifecycleEvents.length = 0;

        applyChange({ sessionSampleRate: 0, sessionOnError: false });

        expect(lifecycleEvents).toEqual([]);
      });
    });

    describe('setSessionHasError', () => {
      async function startWithheldSession() {
        mockNoSessionFile();
        sessionManager = await SessionManager.start(eventManager, hooks, () => ({
          sessionSampleRate: 0,
          sessionOnError: true,
        }));
        mfs.writeFile.mockClear();
      }

      it('takes effect in memory before anything is written', async () => {
        await startWithheldSession();
        mfs.writeFile.mockReturnValue(new Promise(() => undefined));

        sessionManager.setSessionHasError(sessionManager.getSession().id, T0);

        expect(sessionManager.getSession().hasError).toBe(true);
      });

      it('persists the mark with the session', async () => {
        await startWithheldSession();

        sessionManager.setSessionHasError(sessionManager.getSession().id, T0);
        await vi.advanceTimersByTimeAsync(0);

        expect(savedSessionStates()).toContainEqual(expect.objectContaining({ hasError: true }));
      });

      it('is not undone by an activity update that read the state before the mark reached disk', async () => {
        await startWithheldSession();
        const { id } = sessionManager.getSession();
        mfs.access.mockResolvedValue(undefined);
        mfs.readFile.mockResolvedValue(
          JSON.stringify({ id, created: 0, lastActivity: 0, trackingType: TrackingType.TRACKED_ON_ERROR })
        );

        sessionManager.setSessionHasError(id, T0);
        eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });
        await vi.advanceTimersByTimeAsync(0);

        const states = savedSessionStates();
        expect(states[states.length - 1]).toMatchObject({ hasError: true });
      });

      it('writes one state at a time, so a slow earlier write cannot land over the mark', async () => {
        await startWithheldSession();
        const { id } = sessionManager.getSession();
        mfs.access.mockResolvedValue(undefined);
        mfs.readFile.mockResolvedValue(
          JSON.stringify({ id, created: 0, lastActivity: 0, trackingType: TrackingType.TRACKED_ON_ERROR })
        );
        let finishActivityWrite!: () => void;
        mfs.writeFile.mockImplementationOnce(() => new Promise<void>((resolve) => (finishActivityWrite = resolve)));

        // An activity update starts writing the state it had before the error…
        eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });
        await vi.advanceTimersByTimeAsync(0);
        expect(savedSessionStates()).toHaveLength(1);

        // …and the mark has to wait for it rather than race it.
        sessionManager.setSessionHasError(id, T0);
        await vi.advanceTimersByTimeAsync(0);
        expect(savedSessionStates()).toHaveLength(1);

        finishActivityWrite();
        await vi.advanceTimersByTimeAsync(0);
        const states = savedSessionStates();
        expect(states).toHaveLength(2);
        expect(states[1]).toMatchObject({ hasError: true });
      });

      it('lets a write queued before the session ended finish before the file is deleted', async () => {
        await startWithheldSession();
        let finishMarkWrite!: () => void;
        mfs.writeFile.mockImplementation((filePath: string) =>
          filePath.includes(`/${SESSION_FILE_NAME}.`)
            ? new Promise<void>((resolve) => (finishMarkWrite = resolve))
            : Promise.resolve()
        );
        mfs.unlink.mockResolvedValue(undefined);
        sessionManager.setSessionHasError(sessionManager.getSession().id, T0);
        await vi.advanceTimersByTimeAsync(0);

        // The session ends while the mark is still being written: deleting first would let the
        // write recreate the file, and the next launch resume a session that had ended.
        sessionManager.expire();
        await vi.advanceTimersByTimeAsync(0);
        expect(unlinkSync).not.toHaveBeenCalled();

        finishMarkWrite();
        await vi.advanceTimersByTimeAsync(0);
        expect(unlinkSync).toHaveBeenCalled();
      });

      it('writes nothing for a session that has ended, so the file it had cannot come back', async () => {
        await startWithheldSession();
        const { id } = sessionManager.getSession();
        mfs.unlink.mockResolvedValue(undefined);
        sessionManager.expire();
        await vi.advanceTimersByTimeAsync(0);
        mfs.writeFile.mockClear();

        // A crash of this session, processed after it ended.
        sessionManager.setSessionHasError(id, T0);
        await vi.advanceTimersByTimeAsync(0);

        expect(savedSessionStates()).toEqual([]);
        // The history still learns of it: that is what lets the crash through assembly.
        expect(hooks.triggerRum({ eventType: 'error', startTime: T0 })).toMatchObject({ session: { id } });
      });

      it('writes the state and the history before returning when the application may exit', async () => {
        await startWithheldSession();
        const { id } = sessionManager.getSession();
        writeFileSync.mockClear();
        mfs.writeFile.mockReturnValue(new Promise(() => undefined));
        sessionManager.setSessionHasError(id, T0);

        sessionManager.writePendingSync();

        // Written to a file of its own and renamed into place, so that a write already issued cannot
        // overwrite or interleave with it.
        const written = writeFileSync.mock.calls.map(([filePath, content]) => [String(filePath), String(content)]);
        expect(written.find(([filePath]) => filePath.includes(`/${SESSION_FILE_NAME}.`))?.[1]).toContain(
          '"hasError":true'
        );
        expect(written.find(([filePath]) => filePath.includes('/_dd_session_history.'))?.[1]).toContain(
          '"hasError":true'
        );
        expect(renameSync).toHaveBeenCalledWith(
          expect.stringContaining(`/${SESSION_FILE_NAME}.`),
          expect.stringMatching(/\/_dd_s$/)
        );
        expect(renameSync).toHaveBeenCalledWith(
          expect.stringContaining('/_dd_session_history.'),
          expect.stringMatching(/_dd_session_history$/)
        );
      });

      it('deletes the file of a session that has ended rather than writing it, when the application may exit', async () => {
        await startWithheldSession();
        // The queued delete has not run yet: the application is exiting right after stopSession().
        mfs.unlink.mockReturnValue(new Promise(() => undefined));
        sessionManager.expire();
        writeFileSync.mockClear();

        sessionManager.writePendingSync();

        expect(writeFileSync.mock.calls.map(([filePath]) => String(filePath))).not.toContainEqual(
          expect.stringContaining(`/${SESSION_FILE_NAME}.`)
        );
        expect(unlinkSync).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`/${SESSION_FILE_NAME}$`)));
      });

      it('leaves a drawn session alone, and writes nothing', async () => {
        mockNoSessionFile();
        sessionManager = await SessionManager.start(eventManager, hooks, () => SAMPLING);
        mfs.writeFile.mockClear();

        sessionManager.setSessionHasError(sessionManager.getSession().id, T0);
        await vi.advanceTimersByTimeAsync(0);

        expect(sessionManager.getSession().hasError).toBeUndefined();
        expect(mfs.writeFile).not.toHaveBeenCalled();
      });
    });
  });
});

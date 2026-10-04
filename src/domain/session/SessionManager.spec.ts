import { mockFs } from '../../mocks.specUtil';
vi.mock('node:fs/promises');
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
import { SessionManager, SESSION_EXPIRATION_DELAY, SESSION_FILE_NAME } from './SessionManager';
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

      sessionManager = await SessionManager.start(eventManager, hooks, SAMPLING);

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

      sessionManager = await SessionManager.start(eventManager, hooks, SAMPLING);

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

      sessionManager = await SessionManager.start(eventManager, hooks, SAMPLING);

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

      sessionManager = await SessionManager.start(eventManager, hooks, SAMPLING);

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

      sessionManager = await SessionManager.start(eventManager, hooks, SAMPLING);

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

      sessionManager = await SessionManager.start(eventManager, hooks, SAMPLING);

      expect(sessionManager.getSession().status).toBe('active');

      await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY);

      expect(sessionManager.getSession().status).toBe('expired');
      expect(mfs.unlink).toHaveBeenCalled();
      expect(lifecycleEvents).toContain(LifecycleKind.SESSION_EXPIRED);
    });

    it('resets inactivity timer on activity', async () => {
      const now = Date.now();
      mockNoSessionFile();

      sessionManager = await SessionManager.start(eventManager, hooks, SAMPLING);

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

      sessionManager = await SessionManager.start(eventManager, hooks, SAMPLING);

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

      sessionManager = await SessionManager.start(eventManager, hooks, SAMPLING);

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

      sessionManager = await SessionManager.start(eventManager, hooks, SAMPLING);

      // Should create a new session despite read error

      expect(sessionManager.getSession().status).toBe('active');
    });

    it('handles file write errors gracefully', async () => {
      mockNoSessionFile();
      mfs.writeFile.mockRejectedValue(new Error('Write error'));

      sessionManager = await SessionManager.start(eventManager, hooks, SAMPLING);

      // Session should still be created in memory

      expect(sessionManager.getSession().status).toBe('active');
      expect(display.displayError).toHaveBeenCalledWith('Failed to save session state:', expect.any(Error));
    });

    it('handles JSON parse errors gracefully', async () => {
      mfs.access.mockResolvedValue(undefined);
      mfs.readFile.mockResolvedValue('invalid json');

      sessionManager = await SessionManager.start(eventManager, hooks, SAMPLING);

      // Should create a new session despite parse error

      expect(sessionManager.getSession().status).toBe('active');
    });
  });

  describe('expire', () => {
    it('sets session status to expired and clears timers', async () => {
      mockNoSessionFile();

      sessionManager = await SessionManager.start(eventManager, hooks, SAMPLING);

      expect(sessionManager.getSession().status).toBe('active');

      sessionManager.expire();

      expect(sessionManager.getSession().status).toBe('expired');
      expect(mfs.unlink).toHaveBeenCalled();
      expect(lifecycleEvents).toContain(LifecycleKind.SESSION_EXPIRED);
    });
  });

  describe('hook registration', () => {
    it('RUM hook returns session id immediately after start()', async () => {
      mockNoSessionFile();

      sessionManager = await SessionManager.start(eventManager, hooks, SAMPLING);

      const result = hooks.triggerRum({ eventType: 'view', startTime: T0 });
      expect(result).toMatchObject({ session: { id: sessionManager.getSession().id } });
    });

    it('telemetry hook returns session id immediately after start()', async () => {
      mockNoSessionFile();

      sessionManager = await SessionManager.start(eventManager, hooks, SAMPLING);

      const result = hooks.triggerTelemetry({ startTime: T0 });
      expect(result).toMatchObject({ session: { id: sessionManager.getSession().id } });
    });
  });

  describe('getSession', () => {
    it('should not allow to mutate the current session', async () => {
      mockNoSessionFile();

      sessionManager = await SessionManager.start(eventManager, hooks, SAMPLING);

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
        .filter(([filePath]) => (filePath as string).endsWith(SESSION_FILE_NAME))
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

        sessionManager = await SessionManager.start(eventManager, hooks, { sessionSampleRate, sessionOnError });

        expect(sessionManager.getSession().trackingType).toBe(expected);
        expect(savedSessionStates()[0]).toMatchObject({ trackingType: expected });
      }
    );

    it('keeps the decision a resumed session was created with, whatever the configuration says now', async () => {
      const now = Date.now();
      mfs.readFile.mockResolvedValue(
        JSON.stringify({ id: 'existing', created: now, lastActivity: now, trackingType: TrackingType.TRACKED_ON_ERROR })
      );

      sessionManager = await SessionManager.start(eventManager, hooks, {
        sessionSampleRate: 100,
        sessionOnError: false,
      });

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

      sessionManager = await SessionManager.start(eventManager, hooks, SAMPLING);

      expect(sessionManager.getSession().hasError).toBe(true);
    });

    it('resumes a session saved before sessions were sampled as a drawn one', async () => {
      const now = Date.now();
      mfs.readFile.mockResolvedValue(JSON.stringify({ id: 'existing', created: now, lastActivity: now }));

      sessionManager = await SessionManager.start(eventManager, hooks, { sessionSampleRate: 0, sessionOnError: false });

      expect(sessionManager.getSession()).toMatchObject({ id: 'existing', trackingType: TrackingType.TRACKED });
    });

    it('draws again when the session is renewed', async () => {
      mockNoSessionFile();
      const random = vi.spyOn(Math, 'random').mockReturnValue(0.8);
      sessionManager = await SessionManager.start(eventManager, hooks, {
        sessionSampleRate: 50,
        sessionOnError: false,
      });
      expect(sessionManager.getSession().trackingType).toBe(TrackingType.NOT_TRACKED);

      sessionManager.expire();
      random.mockReturnValue(0.2);
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });
      await vi.advanceTimersByTimeAsync(0);

      expect(sessionManager.getSession().trackingType).toBe(TrackingType.TRACKED);
    });

    describe('setSessionHasError', () => {
      async function startWithheldSession() {
        mockNoSessionFile();
        sessionManager = await SessionManager.start(eventManager, hooks, {
          sessionSampleRate: 0,
          sessionOnError: true,
        });
        mfs.writeFile.mockClear();
      }

      it('takes effect in memory before anything is written', async () => {
        await startWithheldSession();
        mfs.writeFile.mockReturnValue(new Promise(() => undefined));

        sessionManager.setSessionHasError(sessionManager.getSession().id);

        expect(sessionManager.getSession().hasError).toBe(true);
      });

      it('persists the mark with the session', async () => {
        await startWithheldSession();

        sessionManager.setSessionHasError(sessionManager.getSession().id);
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

        sessionManager.setSessionHasError(id);
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
        sessionManager.setSessionHasError(id);
        await vi.advanceTimersByTimeAsync(0);
        expect(savedSessionStates()).toHaveLength(1);

        finishActivityWrite();
        await vi.advanceTimersByTimeAsync(0);
        const states = savedSessionStates();
        expect(states).toHaveLength(2);
        expect(states[1]).toMatchObject({ hasError: true });
      });

      it('leaves a drawn session alone, and writes nothing', async () => {
        mockNoSessionFile();
        sessionManager = await SessionManager.start(eventManager, hooks, SAMPLING);
        mfs.writeFile.mockClear();

        sessionManager.setSessionHasError(sessionManager.getSession().id);
        await vi.advanceTimersByTimeAsync(0);

        expect(sessionManager.getSession().hasError).toBeUndefined();
        expect(mfs.writeFile).not.toHaveBeenCalled();
      });
    });
  });
});

import { mockFs } from '../mocks.specUtil';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/user/data') },
}));

vi.mock('../tools/display', () => ({
  displayError: vi.fn(),
  displayWarn: vi.fn(),
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TimeStamp } from '@flashcatcloud/browser-core';
import { UserContext, type User } from './UserContext';
import { DiskValueHistory } from '../tools/DiskValueHistory';
import { displayWarn } from '../tools/display';
import { EventKind, EventManager, LifecycleKind, type Event, type LifecycleEvent } from '../event';

vi.mock('node:fs/promises');
const mfs = mockFs();

const EXPIRE_DELAY = 10_000;
const ALICE: User = { id: 'alice', name: 'Alice', email: 'alice@example.com' };

describe('UserContext', () => {
  let eventManager: EventManager;
  let lifecycleEvents: LifecycleEvent[];

  async function createContext(): Promise<UserContext> {
    return UserContext.init(eventManager, EXPIRE_DELAY);
  }

  /** Advances the clock so history entries get distinct timestamps. */
  function tick(ms = 10): void {
    vi.setSystemTime(Date.now() + ms);
  }

  function at(): TimeStamp {
    return Date.now() as TimeStamp;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    mfs.readFile.mockRejectedValue(new Error('ENOENT'));
    mfs.writeFile.mockResolvedValue(undefined);

    eventManager = new EventManager();
    lifecycleEvents = [];
    eventManager.registerHandler<LifecycleEvent>({
      canHandle: (event: Event): event is LifecycleEvent => event.kind === EventKind.LIFECYCLE,
      handle: (event) => lifecycleEvents.push(event),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mfs.reset();
  });

  describe('set', () => {
    it('should expose the identity as the current user', async () => {
      const context = await createContext();

      context.set(ALICE);

      expect(context.get()).toEqual(ALICE);
    });

    it('should return a copy, so a caller cannot rewrite the stored identity', async () => {
      const context = await createContext();
      context.set(ALICE);

      context.get()!.id = 'mallory';

      expect(context.get()!.id).toBe('alice');
    });

    it('should not be affected by later mutation of the object it was given', async () => {
      const context = await createContext();
      const user = { ...ALICE };

      context.set(user);
      user.id = 'mallory';

      expect(context.get()!.id).toBe('alice');
    });

    /**
     * The guard against `setUser` reaching `usr.anonymous_id`. Only `id`/`name`/`email` are copied,
     * so no extra property survives — see the note in `UserContext` about upstream's `extraInfo`
     * leaving this key unprotected.
     */
    it('should drop every property that is not id, name or email', async () => {
      const context = await createContext();

      context.set({ id: 'alice', anonymous_id: 'forged', plan: 'premium' } as unknown as User);

      expect(context.get()).toEqual({ id: 'alice' });
    });

    it('should keep a partial identity when only an id is given', async () => {
      const context = await createContext();

      context.set({ id: 'alice' });

      expect(context.get()).toEqual({ id: 'alice' });
    });
  });

  describe('rejected calls', () => {
    it.each([
      ['no id', {}],
      ['an empty id', { id: '' }],
      ['a non-string id', { id: 42 }],
      ['a non-string name', { id: 'alice', name: 42 }],
      ['a non-string email', { id: 'alice', email: {} }],
      ['null', null],
    ])('should ignore a call with %s, and warn', async (_label, input) => {
      const context = await createContext();

      context.set(input as unknown as User);

      expect(context.get()).toBeUndefined();
      expect(displayWarn).toHaveBeenCalled();
    });

    it('should keep the previous identity rather than half-applying an invalid one', async () => {
      const context = await createContext();
      context.set(ALICE);

      context.set({ id: 'bob', name: 42 } as unknown as User);

      expect(context.get()).toEqual(ALICE);
    });

    it('should not notify renderers about a call it rejected', async () => {
      const context = await createContext();
      lifecycleEvents.length = 0;

      context.set({ id: '' } as User);

      expect(lifecycleEvents).toHaveLength(0);
    });
  });

  describe('clear', () => {
    it('should forget the current identity', async () => {
      const context = await createContext();
      context.set(ALICE);

      context.clear();

      expect(context.get()).toBeUndefined();
    });

    /**
     * `get()` reads a plain field rather than querying the history, precisely so that a clear takes
     * effect within the millisecond it happened in. Answering off `history.find(now)` would return
     * the user again, because the entry closed at exactly `now` still spans `now`.
     */
    it('should take effect immediately, even within the same millisecond', async () => {
      const context = await createContext();
      context.set(ALICE);

      context.clear();

      expect(context.get()).toBeUndefined();
    });

    it('should be harmless when nobody is logged in', async () => {
      const context = await createContext();

      expect(() => context.clear()).not.toThrow();
      expect(context.get()).toBeUndefined();
    });
  });

  describe('find — the identity in force at a past moment', () => {
    it('should resolve to undefined before any identity was set', async () => {
      const context = await createContext();
      const before = at();

      tick();
      context.set(ALICE);

      expect(context.find(before)).toBeUndefined();
    });

    it('should resolve an event to the identity in force when it happened', async () => {
      const context = await createContext();
      context.set(ALICE);
      const whileAlice = at();

      tick();
      context.set({ id: 'bob' });

      expect(context.find(whileAlice)).toEqual(ALICE);
    });

    it('should still resolve events from before a logout to the user who was logged in', async () => {
      const context = await createContext();
      context.set(ALICE);
      const whileAlice = at();

      tick();
      context.clear();
      tick();

      expect(context.find(whileAlice)).toEqual(ALICE);
      expect(context.find(at())).toBeUndefined();
    });

    /**
     * Guard for the millisecond race `ViewCollection.createNewView` avoids the same way: `set`
     * closes the previous entry and opens the next one from a **single** clock read. Read the clock
     * twice and anything that happens in between widens into a hole where no identity is in force,
     * so an event landing in it is attributed to nobody.
     *
     * The pause is simulated inside `closeActive` because that is where a real one occurs: it
     * stringifies the whole history and schedules a disk write before returning.
     */
    it('should leave no gap between two identities when closing the previous one is slow', async () => {
      const context = await createContext();
      context.set(ALICE);
      tick();

      const switchMoment = at();
      // Captured unbound on purpose: the mock below re-invokes it with the instance it was called
      // on, so the real close still happens after the simulated pause.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const closeActive = DiskValueHistory.prototype.closeActive;
      const spy = vi.spyOn(DiskValueHistory.prototype, 'closeActive').mockImplementation(function (
        this: DiskValueHistory<User>,
        endTime
      ) {
        vi.setSystemTime(Date.now() + 5);
        closeActive.call(this, endTime);
      });

      context.set({ id: 'bob' });
      spy.mockRestore();

      // Every moment between the two identities has to resolve to one of them.
      for (let offset = 0; offset <= 5; offset++) {
        expect(context.find((switchMoment + offset) as TimeStamp)).toBeDefined();
      }
    });

    it('should return a copy, so an event cannot rewrite history', async () => {
      const context = await createContext();
      context.set(ALICE);
      const moment = at();

      context.find(moment)!.id = 'mallory';

      expect(context.find(moment)!.id).toBe('alice');
    });
  });

  describe('persistence', () => {
    it('should persist the history so a crash parsed on the next startup can be attributed', async () => {
      const context = await createContext();

      context.set(ALICE);
      await vi.advanceTimersByTimeAsync(0);

      expect(mfs.writeFile).toHaveBeenCalledWith('/mock/user/data/_dd_user_history', expect.any(String), 'utf-8');
    });

    it('should resolve an identity recorded by a previous run', async () => {
      // Both timestamps predate this process: the previous run logged in, then crashed, and the
      // dump is only parsed now.
      const loginMoment = 500;
      const crashMoment = 600 as TimeStamp;
      mfs.readFile.mockResolvedValue(
        JSON.stringify([{ startTime: loginMoment, endTime: null, value: { id: 'alice' } }])
      );

      const context = await createContext();

      expect(context.find(crashMoment)).toEqual({ id: 'alice' });
    });

    /**
     * A restored history says who *was* logged in, not who is now. Nothing in a fresh process has
     * called `setUser` yet, so the bridge must not tell renderers there is a user.
     */
    it('should not report a restored identity as the current one', async () => {
      mfs.readFile.mockResolvedValue(JSON.stringify([{ startTime: at(), endTime: null, value: { id: 'alice' } }]));

      const context = await createContext();

      expect(context.get()).toBeUndefined();
    });

    /**
     * Observed against dev before it was fixed: a second run stamped its first view with the *first*
     * run's user. Quitting is not logging out, so the previous run's entry is still open on disk;
     * restoring it as active attributes this process's events to whoever used the machine last.
     */
    it('should not attribute new events to the identity a previous run left open', async () => {
      const previousRun = 500;
      mfs.readFile.mockResolvedValue(
        JSON.stringify([{ startTime: previousRun, endTime: null, value: { id: 'alice' } }])
      );

      const context = await createContext();

      // No `tick()`: the first main-process view is created in the same millisecond as `init`, and
      // that is the event whose identity the session inherits. `find` treats `endTime` as
      // inclusive, so closing the restored entry at exactly `now` would still match here.
      expect(context.find(at())).toBeUndefined();
    });

    it('should still attribute a crash from the previous run to the user who was logged in then', async () => {
      const previousRun = 500;
      const crashMoment = 600;
      mfs.readFile.mockResolvedValue(
        JSON.stringify([{ startTime: previousRun, endTime: null, value: { id: 'alice' } }])
      );

      const context = await createContext();

      expect(context.find(crashMoment as TimeStamp)).toEqual({ id: 'alice' });
    });
  });

  describe('change notifications', () => {
    it('should notify on set, so the bridge can push the identity to renderers', async () => {
      const context = await createContext();
      lifecycleEvents.length = 0;

      context.set(ALICE);

      expect(lifecycleEvents).toEqual([{ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.USER_CHANGED }]);
    });

    it('should notify on clear', async () => {
      const context = await createContext();
      context.set(ALICE);
      lifecycleEvents.length = 0;

      context.clear();

      expect(lifecycleEvents).toEqual([{ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.USER_CHANGED }]);
    });
  });
});

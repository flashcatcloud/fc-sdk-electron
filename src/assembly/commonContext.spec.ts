import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Assembly } from './Assembly';
import { createFormatHooks, type FormatHooks } from './hooks';
import { registerCommonContext } from './commonContext';
import {
  EventFormat,
  EventKind,
  EventManager,
  EventSource,
  type RawRumEvent,
  type ServerEvent,
  type RawTelemetryEvent,
} from '../event';
import type { RumEvent, RawRumData } from '../domain/rum';
import type { User } from '../domain/UserContext';
import { createTestConfiguration } from '../mocks.specUtil';

// `commonContext` and `Assembly` reach `UserContext` for the identity in force, and it imports
// `electron` at module load for the path its history file lives at. Nothing here touches that
// history, but the import alone needs an Electron install these tests do not have.
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/user-data') },
}));

const ANONYMOUS_ID = 'device-anonymous-id';
const ALICE: User = { id: 'alice', name: 'Alice', email: 'alice@example.com' };

const RAW_ERROR_DATA: RawRumData = {
  type: 'error',
  error: { id: '1', message: 'test', source: 'custom', handling: 'handled' },
};

describe('registerCommonContext', () => {
  let eventManager: EventManager;
  let hooks: FormatHooks;
  let serverEvents: ServerEvent[];

  function notifyMainProcessRumEvent(data: RawRumData = RAW_ERROR_DATA) {
    eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.MAIN,
      format: EventFormat.RUM,
      data,
    } as RawRumEvent);
  }

  function lastRumEvent(): RumEvent {
    return serverEvents[serverEvents.length - 1].data as RumEvent;
  }

  /** Stands in for `UserContext.find`: whatever the test last handed to `login`. */
  let currentUser: User | undefined;

  function login(user: User | undefined) {
    currentUser = user;
  }

  beforeEach(() => {
    eventManager = new EventManager();
    hooks = createFormatHooks();
    serverEvents = [];
    currentUser = undefined;

    eventManager.registerHandler<ServerEvent>({
      canHandle: (event): event is ServerEvent => event.kind === EventKind.SERVER,
      handle: (event) => serverEvents.push(event),
    });

    registerCommonContext(createTestConfiguration(), hooks, ANONYMOUS_ID, () => currentUser);
    new Assembly(eventManager, hooks);
  });

  describe('user identity', () => {
    it('should stamp the anonymous id on main-process RUM events', () => {
      notifyMainProcessRumEvent();

      expect(lastRumEvent().usr?.anonymous_id).toBe(ANONYMOUS_ID);
    });

    it('should stamp it on every event type, since the session takes its identity from the first view', () => {
      notifyMainProcessRumEvent({ type: 'view', view: { id: 'v1' } } as unknown as RawRumData);
      notifyMainProcessRumEvent();

      expect(serverEvents).toHaveLength(2);
      for (const event of serverEvents) {
        expect((event.data as RumEvent).usr?.anonymous_id).toBe(ANONYMOUS_ID);
      }
    });

    /**
     * Guard, not an observation. The browser SDK backfills `user.id` with its anonymous id because
     * its unique-user count is `COUNT(DISTINCT usr_id)`. Electron is counted off
     * `COALESCE(NULLIF(usr_anonymous_id, ''), NULLIF(usr_id, ''))`, so backfilling would buy
     * nothing and would split one device into two people at login, when `usr.id` stops being the
     * anonymous id and becomes the real one. Do not "align with the browser SDK" here.
     */
    it('should not backfill usr.id with the anonymous id', () => {
      notifyMainProcessRumEvent();

      const usr = lastRumEvent().usr;
      expect(usr?.anonymous_id).toBe(ANONYMOUS_ID);
      expect(usr?.id).toBeUndefined();
      expect(Object.keys(usr!)).toEqual(['anonymous_id']);
    });

    it('should keep a real user id alongside the anonymous id, and leave it untouched', () => {
      notifyMainProcessRumEvent({ ...RAW_ERROR_DATA, usr: { id: 'real-user-id' } } as unknown as RawRumData);

      const usr = lastRumEvent().usr;
      expect(usr?.id).toBe('real-user-id');
      expect(usr?.anonymous_id).toBe(ANONYMOUS_ID);
    });

    it('should not override a user id the event already carries', () => {
      notifyMainProcessRumEvent({
        ...RAW_ERROR_DATA,
        usr: { id: 'real-user-id', anonymous_id: 'event-anonymous-id' },
      } as unknown as RawRumData);

      const usr = lastRumEvent().usr;
      expect(usr?.id).toBe('real-user-id');
      expect(usr?.anonymous_id).toBe('event-anonymous-id');
    });

    it('should leave renderer events alone — the renderer reads the id off the bridge itself', () => {
      eventManager.notify({
        kind: EventKind.RAW,
        source: EventSource.RENDERER,
        format: EventFormat.RUM,
        data: {
          type: 'error',
          source: 'browser',
          error: { message: 'renderer error', source: 'source' },
          view: { id: 'renderer-view' },
          session: { id: 'renderer-session' },
          application: { id: 'renderer-app' },
        },
      } as unknown as RawRumEvent);

      expect(lastRumEvent().usr).toBeUndefined();
    });

    it('should stamp the identity set through setUser alongside the anonymous id', () => {
      login(ALICE);

      notifyMainProcessRumEvent();

      expect(lastRumEvent().usr).toEqual({ ...ALICE, anonymous_id: ANONYMOUS_ID });
    });

    it('should stamp only the fields the identity actually carries', () => {
      login({ id: 'alice' });

      notifyMainProcessRumEvent();

      expect(lastRumEvent().usr).toEqual({ id: 'alice', anonymous_id: ANONYMOUS_ID });
    });

    /**
     * The logout guard. `usr.id` has to disappear rather than turn into `''`: unique users are
     * counted off `NULLIF(usr_id, '')`, where an empty string and an absent field are not the same
     * row.
     */
    it('should drop usr.id once the identity is cleared, rather than blank it', () => {
      login(ALICE);
      notifyMainProcessRumEvent();

      login(undefined);
      notifyMainProcessRumEvent();

      const usr = lastRumEvent().usr;
      expect(usr).not.toHaveProperty('id');
      expect(Object.keys(usr!)).toEqual(['anonymous_id']);
    });

    it('should keep the anonymous id identical across a login and a logout', () => {
      notifyMainProcessRumEvent();
      login(ALICE);
      notifyMainProcessRumEvent();
      login(undefined);
      notifyMainProcessRumEvent();

      const anonymousIds = serverEvents.map((event) => (event.data as RumEvent).usr?.anonymous_id);
      expect(anonymousIds).toEqual([ANONYMOUS_ID, ANONYMOUS_ID, ANONYMOUS_ID]);
    });

    /**
     * `setUser` cannot carry `anonymous_id` — `sanitizeUser` drops it — but the hook also writes
     * the anonymous id last so the guarantee does not depend on that. This pins the ordering.
     */
    it('should not let an identity displace the anonymous id', () => {
      login({ id: 'alice', anonymous_id: 'forged' } as unknown as User);

      notifyMainProcessRumEvent();

      expect(lastRumEvent().usr?.anonymous_id).toBe(ANONYMOUS_ID);
    });

    it('should resolve the identity as of the event start time, not of assembly time', () => {
      const startTimes: number[] = [];
      registerCommonContext(createTestConfiguration(), hooks, ANONYMOUS_ID, (startTime) => {
        startTimes.push(startTime);
        return ALICE;
      });

      eventManager.notify({
        kind: EventKind.RAW,
        source: EventSource.MAIN,
        format: EventFormat.RUM,
        data: RAW_ERROR_DATA,
        startTime: 1234,
      } as unknown as RawRumEvent);

      expect(startTimes).toContain(1234);
    });

    /**
     * The main process emits exactly one synthetic view per session, spanning the whole session,
     * and the backend derives the session's identity from the **last** view row it receives.
     * `setUser` cannot run before `init`, so that view always begins logged-out — resolving it at
     * its start time would keep the identity off `t_sessions.usr_id` for the entire session.
     */
    it('should stamp a view with the identity in force when it is emitted, not when the view began', () => {
      const viewStart = 1000;
      const asked: number[] = [];
      registerCommonContext(createTestConfiguration(), hooks, ANONYMOUS_ID, (startTime) => {
        asked.push(startTime);
        return ALICE;
      });

      eventManager.notify({
        kind: EventKind.RAW,
        source: EventSource.MAIN,
        format: EventFormat.RUM,
        data: { type: 'view', view: { id: 'v1' } },
        startTime: viewStart,
      } as unknown as RawRumEvent);

      expect(asked).not.toHaveLength(0);
      expect(asked).not.toContain(viewStart);
      expect(lastRumEvent().usr?.id).toBe(ALICE.id);
    });

    it('should still resolve a point-in-time event at its own timestamp, so a late crash keeps its user', () => {
      const crashMoment = 1000;
      const asked: number[] = [];
      registerCommonContext(createTestConfiguration(), hooks, ANONYMOUS_ID, (startTime) => {
        asked.push(startTime);
        return undefined;
      });

      eventManager.notify({
        kind: EventKind.RAW,
        source: EventSource.MAIN,
        format: EventFormat.RUM,
        data: RAW_ERROR_DATA,
        startTime: crashMoment,
      } as unknown as RawRumEvent);

      expect(asked).toContain(crashMoment);
    });

    it('should not stamp telemetry events, whose format has no user properties', () => {
      eventManager.notify({
        kind: EventKind.RAW,
        source: EventSource.MAIN,
        format: EventFormat.TELEMETRY,
        data: { type: 'log', status: 'error', message: 'boom' },
      } as unknown as RawTelemetryEvent);

      expect(serverEvents).toHaveLength(1);
      expect((serverEvents[0].data as Partial<RumEvent>).usr).toBeUndefined();
    });
  });
});

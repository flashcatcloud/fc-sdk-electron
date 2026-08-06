import { beforeEach, describe, expect, it } from 'vitest';
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
import { createTestConfiguration } from '../mocks.specUtil';

const ANONYMOUS_ID = 'device-anonymous-id';

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

  beforeEach(() => {
    eventManager = new EventManager();
    hooks = createFormatHooks();
    serverEvents = [];

    eventManager.registerHandler<ServerEvent>({
      canHandle: (event): event is ServerEvent => event.kind === EventKind.SERVER,
      handle: (event) => serverEvents.push(event),
    });

    registerCommonContext(createTestConfiguration(), hooks, ANONYMOUS_ID);
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

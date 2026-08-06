import { beforeEach, describe, it, expect } from 'vitest';
import { DISCARDED, SKIPPED, type TimeStamp } from '@flashcatcloud/browser-core';
import { Assembly } from './Assembly';
import { createFormatHooks, type FormatHooks } from './hooks';
import { registerCommonContext } from './commonContext';
import {
  EventFormat,
  EventKind,
  EventManager,
  EventSource,
  EventTrack,
  type RawRumEvent,
  type ServerEvent,
} from '../event';
import type { RumEvent, RawRumData } from '../domain/rum';
import type { User } from '../domain/UserContext';
import { createTestConfiguration } from '../mocks.specUtil';

const RAW_ERROR_DATA: RawRumData = {
  type: 'error',
  error: { id: '1', message: 'test', source: 'custom', handling: 'handled' },
};

describe('Assembly', () => {
  let eventManager: EventManager;
  let hooks: FormatHooks;
  let serverEvents: ServerEvent[];

  function notifyRawRumEvent(overrides?: Partial<RawRumEvent>) {
    eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.MAIN,
      format: EventFormat.RUM,
      data: RAW_ERROR_DATA,
      ...overrides,
    });
  }

  beforeEach(() => {
    eventManager = new EventManager();
    hooks = createFormatHooks();
    serverEvents = [];

    eventManager.registerHandler<ServerEvent>({
      canHandle: (event): event is ServerEvent => event.kind === EventKind.SERVER,
      handle: (event) => serverEvents.push(event),
    });

    new Assembly(eventManager, hooks);
  });

  it('favors raw event attributes over hook attributes', () => {
    hooks.registerRum(() => ({ date: 999, session: { id: 'hook-session' } }));

    notifyRawRumEvent({ data: { ...RAW_ERROR_DATA, date: 1234567890 } });

    expect(serverEvents).toHaveLength(1);
    const rumEvent = serverEvents[0].data as RumEvent;
    expect(rumEvent.date).toBe(1234567890);
    expect(rumEvent.session.id).toBe('hook-session');
  });

  it('uses hook attributes when raw event does not provide them', () => {
    hooks.registerRum(() => ({ date: 999, session: { id: 'hook-session' } }));

    notifyRawRumEvent();

    expect(serverEvents).toHaveLength(1);
    const rumEvent = serverEvents[0].data as RumEvent;
    expect(rumEvent.date).toBe(999);
    expect(rumEvent.session.id).toBe('hook-session');
  });

  it('discards events when hook returns DISCARDED', () => {
    hooks.registerRum(() => DISCARDED);

    notifyRawRumEvent();

    expect(serverEvents).toHaveLength(0);
  });

  it('passes startTime from raw event to hooks', () => {
    hooks.registerRum((params) => ({ date: params.startTime }));

    notifyRawRumEvent({ startTime: 42 as TimeStamp });

    expect(serverEvents).toHaveLength(1);
    const rumEvent = serverEvents[0].data as RumEvent;
    expect(rumEvent.date).toBe(42);
  });
});

describe('Assembly — renderer events', () => {
  function setup(getUser: () => User | undefined = () => undefined) {
    const config = createTestConfiguration({ applicationId: 'main-app-id', service: 'main-service' });
    const eventManager = new EventManager();
    const hooks = createFormatHooks();

    registerCommonContext(config, hooks, 'device-anonymous-id');
    hooks.registerRum(() => ({ session: { id: 'main-session-id' }, view: { id: 'main-view-id' } }));

    new Assembly(eventManager, hooks, getUser);
    return { eventManager, hooks };
  }

  it('should only override session.id and application.id', () => {
    const { eventManager } = setup();
    const collected: ServerEvent[] = [];
    eventManager.registerHandler<ServerEvent>({
      canHandle: (event): event is ServerEvent => event.kind === EventKind.SERVER,
      handle: (event) => collected.push(event),
    });

    eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.RENDERER,
      format: EventFormat.RUM,
      data: {
        type: 'view',
        source: 'browser',
        service: 'renderer-service',
        application: { id: 'renderer-app-id' },
        session: { id: 'renderer-session-id', type: 'user' },
        view: { id: 'renderer-view-id', name: 'renderer-view', url: 'http://localhost' },
        ddtags: 'sdk_version:1.0.0',
      },
    } as unknown as RawRumEvent);

    expect(collected).toHaveLength(1);
    const data = collected[0].data as RumEvent;

    // Overridden by main process
    expect(data.session.id).toBe('main-session-id');
    expect(data.application.id).toBe('main-app-id');

    // Container from main process
    expect(data.container).toEqual({ view: { id: 'main-view-id' }, source: 'electron' });

    // Preserved from renderer
    expect(data.source).toBe('browser');
    expect(data.service).toBe('renderer-service');
    expect(data.view.id).toBe('renderer-view-id');
    expect(data.view.name).toBe('renderer-view');
    expect(data.ddtags).toBe('sdk_version:1.0.0');
  });

  it('should preserve renderer view attributes', () => {
    const { eventManager } = setup();
    const collected: ServerEvent[] = [];
    eventManager.registerHandler<ServerEvent>({
      canHandle: (event): event is ServerEvent => event.kind === EventKind.SERVER,
      handle: (event) => collected.push(event),
    });

    eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.RENDERER,
      format: EventFormat.RUM,
      data: {
        type: 'error',
        source: 'browser',
        error: { message: 'renderer error', source: 'source' },
        view: { id: 'renderer-view-456' },
        session: { id: 'will-be-overridden' },
        application: { id: 'will-be-overridden' },
      },
    } as unknown as RawRumEvent);

    expect(collected).toHaveLength(1);
    const data = collected[0].data as RumEvent;
    expect(data.session.id).toBe('main-session-id');
    expect(data.application.id).toBe('main-app-id');
    expect(data.view.id).toBe('renderer-view-456');
    expect(collected[0].track).toBe(EventTrack.RUM);
  });

  describe('user identity', () => {
    const ALICE: User = { id: 'alice', name: 'Alice', email: 'alice@example.com' };

    function assembleRendererEvent(getUser: () => User | undefined, usr?: Record<string, unknown>): RumEvent {
      const { eventManager } = setup(getUser);
      const collected: ServerEvent[] = [];
      eventManager.registerHandler<ServerEvent>({
        canHandle: (event): event is ServerEvent => event.kind === EventKind.SERVER,
        handle: (event) => collected.push(event),
      });

      eventManager.notify({
        kind: EventKind.RAW,
        source: EventSource.RENDERER,
        format: EventFormat.RUM,
        data: {
          type: 'error',
          source: 'browser',
          date: 12345 as TimeStamp,
          error: { message: 'renderer error', source: 'source' },
          view: { id: 'renderer-view' },
          session: { id: 'renderer-session' },
          application: { id: 'renderer-app' },
          ...(usr ? { usr } : {}),
        },
      } as unknown as RawRumEvent);

      return collected[0].data as RumEvent;
    }

    it('should leave a renderer event alone when no identity is set', () => {
      const data = assembleRendererEvent(() => undefined, { id: 'renderer-user', anonymous_id: 'device-id' });

      expect(data.usr).toEqual({ id: 'renderer-user', anonymous_id: 'device-id' });
    });

    it('should not invent a usr on a renderer event that carries none', () => {
      const data = assembleRendererEvent(() => undefined);

      expect(data.usr).toBeUndefined();
    });

    it('should stamp the main process identity on a renderer event that carries none', () => {
      const data = assembleRendererEvent(() => ALICE);

      expect(data.usr).toEqual(ALICE);
    });

    /**
     * The reason this replaces rather than merges. `combine` merges per key and skips `undefined`,
     * so a merge of `{ id, name }` over `{ id, name, email }` would emit Alice's id and name beside
     * Bob's email — an identity belonging to nobody, and worse than either source alone.
     */
    it('should replace the renderer identity wholesale, never stitch the two together', () => {
      const data = assembleRendererEvent(() => ({ id: 'alice', name: 'Alice' }), {
        id: 'bob',
        name: 'Bob',
        email: 'bob@example.com',
      });

      expect(data.usr).toEqual({ id: 'alice', name: 'Alice' });
      expect(data.usr).not.toHaveProperty('email');
    });

    /**
     * The logout guarantee. If a stale renderer-side identity could outlive `clearUser()`, logging
     * out would leave the user's name and email on everything that window kept reporting.
     */
    it('should drop a renderer identity that the main process has cleared', () => {
      const data = assembleRendererEvent(() => ({ id: 'alice' }), { id: 'bob', email: 'bob@example.com' });

      expect(data.usr).toEqual({ id: 'alice' });
    });

    it('should carry the anonymous id across the replacement untouched', () => {
      const data = assembleRendererEvent(() => ALICE, { id: 'bob', anonymous_id: 'device-id' });

      expect(data.usr?.anonymous_id).toBe('device-id');
      expect(data.usr?.id).toBe('alice');
    });

    it('should not stamp the main process anonymous id on a renderer event', () => {
      const data = assembleRendererEvent(() => ALICE);

      expect(data.usr).not.toHaveProperty('anonymous_id');
    });

    it('should resolve the identity as of the event date, not of assembly time', () => {
      const seen: number[] = [];
      assembleRendererEvent((startTime?: unknown) => {
        seen.push(startTime as number);
        return ALICE;
      });

      expect(seen).toContain(12345);
    });

    /**
     * Same rule as the main-process view: a page view that spans a login is re-reported, and the
     * backend takes the session's identity from the last view row.
     */
    it('should resolve a renderer view at emit time, not at the view start', () => {
      const viewStart = 1000;
      const asked: number[] = [];
      const { eventManager } = setup(((startTime: TimeStamp) => {
        asked.push(startTime);
        return ALICE;
      }) as unknown as () => User | undefined);

      eventManager.notify({
        kind: EventKind.RAW,
        source: EventSource.RENDERER,
        format: EventFormat.RUM,
        data: {
          type: 'view',
          source: 'browser',
          date: viewStart as TimeStamp,
          view: { id: 'renderer-view' },
          session: { id: 'renderer-session' },
          application: { id: 'renderer-app' },
        },
      } as unknown as RawRumEvent);

      expect(asked).not.toHaveLength(0);
      expect(asked).not.toContain(viewStart);
    });

    it('should leave the rest of the event untouched', () => {
      const data = assembleRendererEvent(() => ALICE, { id: 'bob' });

      expect(data.session.id).toBe('main-session-id');
      expect(data.view.id).toBe('renderer-view');
      expect(data.source).toBe('browser');
    });
  });

  it('passes event.data.date as startTime for hook context resolution', () => {
    const { eventManager, hooks } = setup();
    let capturedStartTime: TimeStamp | undefined;

    hooks.registerRum((params) => {
      capturedStartTime = params.startTime;
      return SKIPPED;
    });

    eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.RENDERER,
      format: EventFormat.RUM,
      data: {
        type: 'error',
        date: 12345 as TimeStamp,
        session: { id: 'renderer-session' },
        application: { id: 'renderer-app' },
      },
    } as unknown as RawRumEvent);

    expect(capturedStartTime).toBe(12345);
  });
});

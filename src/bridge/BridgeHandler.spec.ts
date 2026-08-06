import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventFormat, EventKind, EventManager, EventSource, LifecycleKind } from '../event';
import type { RawRumEvent } from '../event';
import { BridgeHandler } from './BridgeHandler';
import type { BridgeOptions } from './BridgeHandler';
import { BRIDGE_CHANNEL, CONFIG_CHANNEL, IDENTITY_CHANNEL } from '../common';
import { RendererRegistry } from '../domain/RendererRegistry';
import { ViewTimingCorrector } from '../domain/ViewTimingCorrector';
import { StackPathNormalizer } from '../domain/StackPathNormalizer';
import type { User } from '../domain/UserContext';

const { mockIpcMainOn, mockAddError } = vi.hoisted(() => {
  const mockIpcMainOn = vi.fn();
  const mockAddError = vi.fn();
  return { mockIpcMainOn, mockAddError };
});

vi.mock('electron', () => ({
  ipcMain: {
    on: mockIpcMainOn,
  },
  app: {
    getAppPath: vi.fn(() => '/mock/app/root'),
  },
}));

vi.mock('../domain/telemetry', () => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  monitor: (fn: Function) => fn,
  addError: mockAddError,
}));

const DEFAULT_BRIDGE_OPTIONS: BridgeOptions = {
  defaultPrivacyLevel: 'mask',
  allowedWebViewHosts: [],
  anonymousId: 'anonymous-id',
};

const SENDER_ID = 7;

const APP_ROOT = '/Applications/MyApp.app/Contents/Resources/app.asar';

type IpcCallback = (event: { sender?: unknown; returnValue?: unknown }, msg: string) => void;

/** Stand-in for a renderer's `webContents`, with the methods the handler touches. */
function createSender(id = SENDER_ID) {
  const destroyedListeners: (() => void)[] = [];
  const sender = {
    id,
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
    once: vi.fn((_event: string, listener: () => void) => destroyedListeners.push(listener)),
    destroy: () => {
      sender.isDestroyed.mockReturnValue(true);
      for (const listener of destroyedListeners) {
        listener();
      }
    },
  };
  return sender;
}

describe('BridgeHandler', () => {
  let eventManager: EventManager;
  let rendererRegistry: RendererRegistry;
  let sessionId: string;
  let user: User | undefined;
  /** `senderId: null` simulates an IPC event without a `sender` (e.g. a destroyed webContents). */
  let simulateIpcMessage: (msg: string, senderId?: number | null) => void;
  /** Replays a renderer's synchronous configuration request, and returns what it got back. */
  let simulateConfigRequest: (sender?: ReturnType<typeof createSender>) => unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    eventManager = new EventManager();
    rendererRegistry = new RendererRegistry();
    sessionId = 'session-1';
    user = undefined;

    mockIpcMainOn.mockImplementation((channel: string, callback: IpcCallback) => {
      if (channel === BRIDGE_CHANNEL) {
        simulateIpcMessage = (msg: string, senderId: number | null = SENDER_ID) =>
          callback(senderId === null ? {} : { sender: { id: senderId } }, msg);
      }
      if (channel === CONFIG_CHANNEL) {
        simulateConfigRequest = (sender = createSender()) => {
          const ipcEvent = { sender, returnValue: undefined as unknown };
          callback(ipcEvent, '');
          return ipcEvent.returnValue;
        };
      }
    });

    // Both collaborators are live for every case below, so the two rewriting tests double as
    // proof that neither swallows the other.
    new BridgeHandler(
      eventManager,
      DEFAULT_BRIDGE_OPTIONS,
      () => sessionId,
      () => user,
      rendererRegistry,
      new ViewTimingCorrector(rendererRegistry, true),
      new StackPathNormalizer(true, APP_ROOT)
    );
  });

  it('should register an IPC listener on the bridge channel', () => {
    expect(mockIpcMainOn).toHaveBeenCalledWith(BRIDGE_CHANNEL, expect.any(Function));
  });

  it('should register an IPC listener on the config channel', () => {
    expect(mockIpcMainOn).toHaveBeenCalledWith(CONFIG_CHANNEL, expect.any(Function));
  });

  describe('configuration channel', () => {
    it('should answer with the bridge options and the current session id', () => {
      expect(simulateConfigRequest()).toEqual({
        defaultPrivacyLevel: 'mask',
        allowedWebViewHosts: [],
        anonymousId: 'anonymous-id',
        sessionId: 'session-1',
      });
    });

    it('should answer with plain data only — the channel is synchronous, so it is structured-cloned', () => {
      const config = simulateConfigRequest();

      expect(() => structuredClone(config)).not.toThrow();
    });

    it('should answer with the session id of the moment, not the one init started with', () => {
      sessionId = 'session-2';

      expect(simulateConfigRequest()).toMatchObject({ sessionId: 'session-2' });
    });

    it('should answer with the identity of the moment, so a renderer opened after login starts with it', () => {
      user = { id: 'alice', name: 'Alice' };

      expect(simulateConfigRequest()).toMatchObject({ user: { id: 'alice', name: 'Alice' } });
    });

    it('should answer without a user when nobody is logged in', () => {
      expect(simulateConfigRequest()).not.toHaveProperty('user.id');
    });

    it('should answer a renderer that has no sender', () => {
      const ipcEvent = { returnValue: undefined as unknown };
      const configHandler = mockIpcMainOn.mock.calls.find(([channel]) => channel === CONFIG_CHANNEL)![1] as (
        event: unknown
      ) => void;

      expect(() => configHandler(ipcEvent)).not.toThrow();
      expect(ipcEvent.returnValue).toMatchObject({ sessionId: 'session-1' });
    });
  });

  describe('identity pushes', () => {
    it('should push the renewed session id to every bridged renderer', () => {
      const first = createSender(1);
      const second = createSender(2);
      simulateConfigRequest(first);
      simulateConfigRequest(second);

      sessionId = 'session-2';
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      expect(first.send).toHaveBeenCalledWith(IDENTITY_CHANNEL, { sessionId: 'session-2' });
      expect(second.send).toHaveBeenCalledWith(IDENTITY_CHANNEL, { sessionId: 'session-2' });
    });

    it('should push an empty session id when the session expires', () => {
      const sender = createSender();
      simulateConfigRequest(sender);

      sessionId = '';
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });

      expect(sender.send).toHaveBeenCalledWith(IDENTITY_CHANNEL, { sessionId: '' });
    });

    it('should push the identity when it changes, reusing the session channel', () => {
      const sender = createSender();
      simulateConfigRequest(sender);

      user = { id: 'alice', name: 'Alice' };
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.USER_CHANGED });

      expect(sender.send).toHaveBeenCalledWith(IDENTITY_CHANNEL, {
        sessionId: 'session-1',
        user: { id: 'alice', name: 'Alice' },
      });
    });

    it('should push an absent user once the identity is cleared', () => {
      const sender = createSender();
      simulateConfigRequest(sender);
      user = { id: 'alice' };
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.USER_CHANGED });

      user = undefined;
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.USER_CHANGED });

      expect(sender.send).toHaveBeenLastCalledWith(IDENTITY_CHANNEL, { sessionId: 'session-1', user: undefined });
    });

    it('should carry the identity alongside a session renewal', () => {
      const sender = createSender();
      simulateConfigRequest(sender);
      user = { id: 'alice' };

      sessionId = 'session-2';
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      expect(sender.send).toHaveBeenCalledWith(IDENTITY_CHANNEL, { sessionId: 'session-2', user: { id: 'alice' } });
    });

    it('should not push on unrelated lifecycle events', () => {
      const sender = createSender();
      simulateConfigRequest(sender);

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });

      expect(sender.send).not.toHaveBeenCalled();
    });

    it('should push to a renderer only once even if it asks for the configuration again', () => {
      const sender = createSender();
      simulateConfigRequest(sender);
      simulateConfigRequest(sender);

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      expect(sender.send).toHaveBeenCalledOnce();
    });

    it('should stop pushing to a renderer that went away', () => {
      const sender = createSender();
      simulateConfigRequest(sender);

      sender.destroy();
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      expect(sender.send).not.toHaveBeenCalled();
    });

    it('should keep pushing to the other renderers when one fails', () => {
      const failing = createSender(1);
      const healthy = createSender(2);
      failing.send.mockImplementation(() => {
        throw new Error('Render frame was disposed');
      });
      simulateConfigRequest(failing);
      simulateConfigRequest(healthy);

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      expect(healthy.send).toHaveBeenCalledOnce();
      expect(mockAddError).toHaveBeenCalledOnce();
    });
  });

  describe('rum events', () => {
    it('should notify the event manager with a RawRumEvent', () => {
      const collected: RawRumEvent[] = [];
      eventManager.registerHandler<RawRumEvent>({
        canHandle: (event): event is RawRumEvent => event.kind === EventKind.RAW,
        handle: (event) => collected.push(event),
      });

      const rumData = { type: 'view', view: { id: 'abc' } };
      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: rumData }));

      expect(collected).toHaveLength(1);
      expect(collected[0]).toEqual({
        kind: EventKind.RAW,
        source: EventSource.RENDERER,
        format: EventFormat.RUM,
        data: rumData,
      });
    });

    it('should apply the pre-warm timing correction before notifying', () => {
      const collected: RawRumEvent[] = [];
      eventManager.registerHandler<RawRumEvent>({
        canHandle: (event): event is RawRumEvent => event.kind === EventKind.RAW,
        handle: (event) => collected.push(event),
      });
      // Window shown 2s after the view started, first paint deferred until then.
      rendererRegistry.recordFirstVisible(SENDER_ID, 3000);

      simulateIpcMessage(
        JSON.stringify({
          eventType: 'rum',
          event: {
            type: 'view',
            date: 1000,
            view: { id: 'abc', loading_type: 'initial_load', first_contentful_paint: 2_100 * 1e6 },
          },
        })
      );

      const notified = collected[0].data as unknown as { view: { first_contentful_paint: number } };
      expect(notified.view.first_contentful_paint).toBe(100 * 1e6);
    });

    it('should anchor renderer stacks on the app root before notifying', () => {
      const collected: RawRumEvent[] = [];
      eventManager.registerHandler<RawRumEvent>({
        canHandle: (event): event is RawRumEvent => event.kind === EventKind.RAW,
        handle: (event) => collected.push(event),
      });

      simulateIpcMessage(
        JSON.stringify({
          eventType: 'rum',
          event: {
            type: 'error',
            error: { message: 'boom', stack: `Error: boom\n  at fn @ file://${APP_ROOT}/dist/renderer.js:4:2` },
          },
        })
      );

      const notified = collected[0].data as unknown as { error: { stack: string } };
      expect(notified.error.stack).toBe('Error: boom\n  at fn @ app:///dist/renderer.js:4:2');
    });
  });

  describe('renderer tracking', () => {
    it('should record the view of the sending webContents', () => {
      simulateIpcMessage(
        JSON.stringify({ eventType: 'rum', event: { type: 'view', view: { id: 'abc', url: 'file:///index.html' } } })
      );

      expect(rendererRegistry.get(SENDER_ID)).toEqual({ viewId: 'abc', url: 'file:///index.html' });
    });

    it('should keep previously known fields when a later event omits them', () => {
      simulateIpcMessage(
        JSON.stringify({ eventType: 'rum', event: { type: 'view', view: { id: 'abc', url: 'file:///index.html' } } })
      );
      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: { type: 'error', view: { id: 'def' } } }));

      expect(rendererRegistry.get(SENDER_ID)).toEqual({ viewId: 'def', url: 'file:///index.html' });
    });

    it('should track each webContents separately', () => {
      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: { view: { id: 'abc' } } }), 1);
      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: { view: { id: 'def' } } }), 2);

      expect(rendererRegistry.get(1)?.viewId).toBe('abc');
      expect(rendererRegistry.get(2)?.viewId).toBe('def');
    });

    it('should ignore events without a view', () => {
      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: { type: 'view' } }));

      expect(rendererRegistry.get(SENDER_ID)).toBeUndefined();
    });

    it('should ignore events without a sender', () => {
      expect(() =>
        simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: { view: { id: 'abc' } } }), null)
      ).not.toThrow();
    });
  });

  describe('log events', () => {
    it('should not notify the event manager (not yet implemented)', () => {
      const spy = vi.spyOn(eventManager, 'notify');

      simulateIpcMessage(JSON.stringify({ eventType: 'log', event: { message: 'hello' } }));

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('internal_telemetry events', () => {
    it('should not notify the event manager (not yet implemented)', () => {
      const spy = vi.spyOn(eventManager, 'notify');

      simulateIpcMessage(JSON.stringify({ eventType: 'internal_telemetry', event: {} }));

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('invalid messages', () => {
    it('should not notify on malformed JSON', () => {
      const spy = vi.spyOn(eventManager, 'notify');

      simulateIpcMessage('not valid json{{{');

      expect(spy).not.toHaveBeenCalled();
      expect(mockAddError).toHaveBeenCalledOnce();
      expect((mockAddError.mock.calls[0][0] as Error).message).toContain('Failed to parse');
    });

    it('should not notify on unknown event type', () => {
      const spy = vi.spyOn(eventManager, 'notify');

      simulateIpcMessage(JSON.stringify({ eventType: 'unknown', event: {} }));

      expect(spy).not.toHaveBeenCalled();
      expect(mockAddError).toHaveBeenCalledOnce();
      expect((mockAddError.mock.calls[0][0] as Error).message).toContain('Unhandled bridge event type');
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventFormat, EventKind, EventManager, EventSource, LifecycleKind } from '../event';
import type { RawRumEvent } from '../event';
import { BridgeHandler } from './BridgeHandler';
import type { BridgeOptions } from './BridgeHandler';
import { BRIDGE_CHANNEL, CONFIG_CHANNEL, CONFIG_PUSH_CHANNEL } from '../common';
import { RendererRegistry } from '../domain/RendererRegistry';
import { ViewTimingCorrector } from '../domain/ViewTimingCorrector';
import { StackPathNormalizer } from '../domain/StackPathNormalizer';

const { mockIpcMainOn, mockIpcMainRemoveAllListeners, mockGetAllWebContents, mockAddError } = vi.hoisted(() => ({
  mockIpcMainOn: vi.fn(),
  mockIpcMainRemoveAllListeners: vi.fn(),
  mockGetAllWebContents: vi.fn(() => [] as unknown[]),
  mockAddError: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    on: mockIpcMainOn,
    removeAllListeners: mockIpcMainRemoveAllListeners,
  },
  webContents: {
    getAllWebContents: mockGetAllWebContents,
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
function createSender() {
  const sender = {
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
    destroy: () => sender.isDestroyed.mockReturnValue(true),
  };
  return sender;
}

describe('BridgeHandler', () => {
  let eventManager: EventManager;
  let rendererRegistry: RendererRegistry;
  let sessionId: string;
  /** `senderId: null` simulates an IPC event without a `sender` (e.g. a destroyed webContents). */
  let simulateIpcMessage: (msg: string, senderId?: number | null) => void;
  /** Replays a renderer's synchronous configuration request, and returns what it got back. */
  let simulateConfigRequest: () => unknown;
  /** The renderers Electron would report as alive. The handler pushes to all of them. */
  let liveRenderers: ReturnType<typeof createSender>[];

  /** Both collaborators are live, so the two rewriting tests prove neither swallows the other. */
  function createHandler() {
    return new BridgeHandler(
      eventManager,
      DEFAULT_BRIDGE_OPTIONS,
      () => sessionId,
      rendererRegistry,
      new ViewTimingCorrector(rendererRegistry, true),
      new StackPathNormalizer(true, APP_ROOT)
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    eventManager = new EventManager();
    rendererRegistry = new RendererRegistry();
    sessionId = 'session-1';
    liveRenderers = [];
    mockGetAllWebContents.mockImplementation(() => liveRenderers);

    mockIpcMainOn.mockImplementation((channel: string, callback: IpcCallback) => {
      if (channel === BRIDGE_CHANNEL) {
        simulateIpcMessage = (msg: string, senderId: number | null = SENDER_ID) =>
          callback(senderId === null ? {} : { sender: { id: senderId } }, msg);
      }
      if (channel === CONFIG_CHANNEL) {
        simulateConfigRequest = () => {
          const ipcEvent = { returnValue: undefined as unknown };
          callback(ipcEvent, '');
          return ipcEvent.returnValue;
        };
      }
    });

    createHandler();
  });

  it('should register an IPC listener on the bridge channel', () => {
    expect(mockIpcMainOn).toHaveBeenCalledWith(BRIDGE_CHANNEL, expect.any(Function));
  });

  it('should register an IPC listener on the config channel', () => {
    expect(mockIpcMainOn).toHaveBeenCalledWith(CONFIG_CHANNEL, expect.any(Function));
  });

  it('should supersede the fallback listener rather than queue behind it', () => {
    // Electron answers a synchronous request with the first `returnValue` set, so the fallback
    // `installBridgePreload` left on the channel would otherwise keep answering in this one's place.
    const removedAt = mockIpcMainRemoveAllListeners.mock.invocationCallOrder[0];
    const registeredAt =
      mockIpcMainOn.mock.invocationCallOrder[mockIpcMainOn.mock.calls.findIndex(([c]) => c === CONFIG_CHANNEL)];

    expect(mockIpcMainRemoveAllListeners).toHaveBeenCalledWith(CONFIG_CHANNEL);
    expect(removedAt).toBeLessThan(registeredAt);
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
  });

  describe('configuration pushes', () => {
    const RENEWED_CONFIG = {
      defaultPrivacyLevel: 'mask',
      allowedWebViewHosts: [],
      anonymousId: 'anonymous-id',
      sessionId: 'session-2',
    };

    it('should push the renewed configuration to every live renderer', () => {
      const first = createSender();
      const second = createSender();
      liveRenderers = [first, second];

      sessionId = 'session-2';
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      expect(first.send).toHaveBeenCalledWith(CONFIG_PUSH_CHANNEL, RENEWED_CONFIG);
      expect(second.send).toHaveBeenCalledWith(CONFIG_PUSH_CHANNEL, RENEWED_CONFIG);
    });

    it('should push an empty session id when the session expires', () => {
      const sender = createSender();
      liveRenderers = [sender];

      sessionId = '';
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });

      expect(sender.send).toHaveBeenCalledWith(CONFIG_PUSH_CHANNEL, expect.objectContaining({ sessionId: '' }));
    });

    it('should not push on unrelated lifecycle events', () => {
      const sender = createSender();
      liveRenderers = [sender];

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });

      expect(sender.send).not.toHaveBeenCalled();
    });

    it('should push to a renderer that never asked for the configuration', () => {
      // The one that raced initialization: it was answered by the fallback listener, so this
      // handler never saw it, and it is precisely the one holding a placeholder configuration.
      const raced = createSender();
      liveRenderers = [raced];

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      expect(raced.send).toHaveBeenCalledOnce();
    });

    it('should push as soon as it is constructed, to correct renderers that raced init', () => {
      const raced = createSender();
      liveRenderers = [raced];

      createHandler();

      expect(raced.send).toHaveBeenCalledWith(
        CONFIG_PUSH_CHANNEL,
        expect.objectContaining({ sessionId: 'session-1', anonymousId: 'anonymous-id' })
      );
    });

    it('should stop pushing to a renderer that went away', () => {
      const sender = createSender();
      liveRenderers = [sender];

      sender.destroy();
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      expect(sender.send).not.toHaveBeenCalled();
    });

    it('should keep pushing to the other renderers when one fails', () => {
      const failing = createSender();
      const healthy = createSender();
      failing.send.mockImplementation(() => {
        throw new Error('Render frame was disposed');
      });
      liveRenderers = [failing, healthy];

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

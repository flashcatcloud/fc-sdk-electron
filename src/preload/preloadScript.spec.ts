import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_CHANNEL, CONFIG_CHANNEL, CONFIG_PUSH_CHANNEL } from '../common';
import type { BridgeConfig } from '../common';

const { mockIpcRenderer, mockExposeInMainWorld } = vi.hoisted(() => ({
  mockIpcRenderer: { on: vi.fn(), send: vi.fn(), sendSync: vi.fn() },
  mockExposeInMainWorld: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcRenderer: mockIpcRenderer,
  contextBridge: { exposeInMainWorld: mockExposeInMainWorld },
}));

interface EventBridge {
  getCapabilities: () => string;
  getPrivacyLevel: () => string;
  getAllowedWebViewHosts: () => string;
  getSessionId: () => string;
  getAnonymousId: () => string;
  getUser: () => string;
  send: (msg: string) => void;
}

const DEFAULT_CONFIG: BridgeConfig = {
  defaultPrivacyLevel: 'allow',
  allowedWebViewHosts: ['example.com'],
  anonymousId: 'anonymous-id',
  sessionId: 'session-1',
};

describe('preload script', () => {
  let bridgeWindow: Record<string, unknown>;

  /** Runs the preload script the way Electron does: top-level, against the frame's `window`. */
  async function runPreload(): Promise<EventBridge> {
    vi.resetModules();
    await import('./preloadScript');
    return bridgeWindow.DatadogEventBridge as EventBridge;
  }

  /** Replays a configuration push from the main process. */
  function pushConfig(config: Partial<BridgeConfig>): void {
    const listeners = mockIpcRenderer.on.mock.calls.filter(([channel]) => channel === CONFIG_PUSH_CHANNEL);
    for (const [, listener] of listeners) {
      (listener as (event: unknown, config: BridgeConfig) => void)({}, { ...DEFAULT_CONFIG, ...config });
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    bridgeWindow = {};
    vi.stubGlobal('window', bridgeWindow);
    vi.stubGlobal('location', { hostname: 'app.example.com' });
    mockIpcRenderer.sendSync.mockReturnValue(DEFAULT_CONFIG);
  });

  it('should expose the bridge to the main world', async () => {
    await runPreload();

    expect(mockExposeInMainWorld).toHaveBeenCalledWith('DatadogEventBridge', bridgeWindow.DatadogEventBridge);
  });

  it('should still expose the bridge when contextIsolation is disabled', async () => {
    mockExposeInMainWorld.mockImplementation(() => {
      throw new Error('contextBridge API can only be used when contextIsolation is enabled');
    });

    const bridge = await runPreload();

    expect(bridge.getAnonymousId()).toBe('anonymous-id');
  });

  it('should not set the bridge up twice on the same frame', async () => {
    await runPreload();
    await runPreload();

    expect(mockIpcRenderer.sendSync).toHaveBeenCalledOnce();
    expect(mockExposeInMainWorld).toHaveBeenCalledOnce();
  });

  it('should forward events on the bridge channel', async () => {
    const bridge = await runPreload();

    bridge.send('{"eventType":"rum"}');

    expect(mockIpcRenderer.send).toHaveBeenCalledWith(BRIDGE_CHANNEL, '{"eventType":"rum"}');
  });

  it('should report the configured privacy level', async () => {
    const bridge = await runPreload();

    expect(mockIpcRenderer.sendSync).toHaveBeenCalledWith(CONFIG_CHANNEL);
    expect(bridge.getPrivacyLevel()).toBe('allow');
  });

  it('should mask by default when the main process answers nothing', async () => {
    mockIpcRenderer.sendSync.mockReturnValue(undefined);

    const bridge = await runPreload();

    expect(bridge.getPrivacyLevel()).toBe('mask');
    expect(bridge.getSessionId()).toBe('');
    expect(bridge.getAnonymousId()).toBe('');
  });

  it('should allow the current host on top of the configured ones', async () => {
    const bridge = await runPreload();

    expect(JSON.parse(bridge.getAllowedWebViewHosts())).toEqual(['app.example.com', 'example.com']);
  });

  it('should declare no capability — the main process does not record on the page behalf', async () => {
    const bridge = await runPreload();

    expect(bridge.getCapabilities()).toBe('[]');
  });

  describe('identifiers', () => {
    it('should answer the anonymous id carried by the configuration', async () => {
      const bridge = await runPreload();

      expect(bridge.getAnonymousId()).toBe('anonymous-id');
    });

    it('should answer the session id carried by the configuration', async () => {
      const bridge = await runPreload();

      expect(bridge.getSessionId()).toBe('session-1');
    });

    it('should answer the renewed session id after the main process pushes it', async () => {
      const bridge = await runPreload();

      pushConfig({ sessionId: 'session-2' });

      expect(bridge.getSessionId()).toBe('session-2');
    });

    it('should answer an empty session id once the session expired', async () => {
      const bridge = await runPreload();

      pushConfig({ sessionId: '' });

      expect(bridge.getSessionId()).toBe('');
    });

    it('should answer without a synchronous IPC call per read', async () => {
      const bridge = await runPreload();
      mockIpcRenderer.sendSync.mockClear();

      bridge.getSessionId();
      bridge.getAnonymousId();

      expect(mockIpcRenderer.sendSync).not.toHaveBeenCalled();
    });

    it('should keep a push that lands before the configuration answers', async () => {
      // The renewal races the initial handshake: the config's session id is the older of the two.
      mockIpcRenderer.sendSync.mockImplementation(() => {
        pushConfig({ sessionId: 'session-2' });
        return DEFAULT_CONFIG;
      });

      const bridge = await runPreload();

      expect(bridge.getSessionId()).toBe('session-2');
    });
  });

  describe('user identity', () => {
    it('should answer an empty object when nobody is logged in', async () => {
      const bridge = await runPreload();

      expect(bridge.getUser()).toBe('{}');
    });

    it('should answer the identity carried by the configuration', async () => {
      mockIpcRenderer.sendSync.mockReturnValue({ ...DEFAULT_CONFIG, user: { id: 'alice', name: 'Alice' } });

      const bridge = await runPreload();

      expect(JSON.parse(bridge.getUser())).toEqual({ id: 'alice', name: 'Alice' });
    });

    it('should answer the identity the main process pushes', async () => {
      const bridge = await runPreload();

      pushConfig({ user: { id: 'alice' } });

      expect(JSON.parse(bridge.getUser())).toEqual({ id: 'alice' });
    });

    it('should go back to an empty object once the identity is cleared', async () => {
      mockIpcRenderer.sendSync.mockReturnValue({ ...DEFAULT_CONFIG, user: { id: 'alice' } });
      const bridge = await runPreload();

      // `clearUser` removes the field rather than blanking it, and the push carries the whole
      // configuration — so the absence has to survive the round trip.
      pushConfig({ user: undefined });

      expect(bridge.getUser()).toBe('{}');
    });

    it('should keep a push that lands before the configuration answers', async () => {
      mockIpcRenderer.sendSync.mockImplementation(() => {
        pushConfig({ user: { id: 'bob' } });
        return { ...DEFAULT_CONFIG, user: { id: 'alice' } };
      });

      const bridge = await runPreload();

      expect(JSON.parse(bridge.getUser())).toEqual({ id: 'bob' });
    });
  });

  // A renderer that starts before the SDK is initialized is answered by the fallback listener
  // `installBridgePreload` registers, and only later hears from the real handler.
  describe('started before the SDK was initialized', () => {
    const UNCONFIGURED: BridgeConfig = {
      defaultPrivacyLevel: 'mask',
      allowedWebViewHosts: [],
      anonymousId: '',
      sessionId: '',
    };

    beforeEach(() => {
      mockIpcRenderer.sendSync.mockReturnValue(UNCONFIGURED);
    });

    it('should hold no identifiers until the main process pushes them', async () => {
      const bridge = await runPreload();

      expect(bridge.getSessionId()).toBe('');
      expect(bridge.getAnonymousId()).toBe('');
    });

    it('should adopt every field of the configuration once it is pushed', async () => {
      const bridge = await runPreload();

      pushConfig(DEFAULT_CONFIG);

      expect(bridge.getSessionId()).toBe('session-1');
      expect(bridge.getAnonymousId()).toBe('anonymous-id');
      expect(bridge.getPrivacyLevel()).toBe('allow');
      expect(JSON.parse(bridge.getAllowedWebViewHosts())).toEqual(['app.example.com', 'example.com']);
    });

    it('should keep allowing its own host after a push that does not mention it', async () => {
      const bridge = await runPreload();

      pushConfig({ allowedWebViewHosts: [] });

      expect(JSON.parse(bridge.getAllowedWebViewHosts())).toEqual(['app.example.com']);
    });
  });
});

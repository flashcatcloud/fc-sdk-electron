import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_CHANNEL, CONFIG_CHANNEL, IDENTITY_CHANNEL } from '../common';
import type { BridgeConfig, IdentityUpdate } from '../common';

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

  /** Replays an identity push from the main process. */
  function pushIdentity(update: IdentityUpdate): void {
    const listeners = mockIpcRenderer.on.mock.calls.filter(([channel]) => channel === IDENTITY_CHANNEL);
    for (const [, listener] of listeners) {
      (listener as (event: unknown, update: IdentityUpdate) => void)({}, update);
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

      pushIdentity({ sessionId: 'session-2' });

      expect(bridge.getSessionId()).toBe('session-2');
    });

    it('should answer an empty session id once the session expired', async () => {
      const bridge = await runPreload();

      pushIdentity({ sessionId: '' });

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
        pushIdentity({ sessionId: 'session-2' });
        return DEFAULT_CONFIG;
      });

      const bridge = await runPreload();

      expect(bridge.getSessionId()).toBe('session-2');
    });
  });
});

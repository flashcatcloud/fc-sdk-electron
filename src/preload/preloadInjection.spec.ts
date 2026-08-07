import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreloadScriptRegistration, Session } from 'electron';
import { CONFIG_CHANNEL } from '../common';
import type { PreloadInjectionHost } from './preloadInjection';

vi.mock('../tools/display', () => ({
  displayWarn: vi.fn(),
  displayError: vi.fn(),
}));

const PRELOAD_PATH = '/app/node_modules/@flashcatcloud/electron-sdk/dist/preload.js';
const DD_TRACE_PRELOAD_PATH = '/app/node_modules/dd-trace/packages/datadog-instrumentations/src/electron/preload.js';
const APP_PRELOAD_PATH = '/app/dist/preload.js';

interface FakeSession {
  session: Session;
  registerPreloadScript: ReturnType<typeof vi.fn>;
  /** Paths actually handed to Electron, in registration order. */
  registered: string[];
}

function createSession(): FakeSession {
  const registered: string[] = [];
  let nextId = 0;
  const registerPreloadScript = vi.fn((script: PreloadScriptRegistration) => {
    registered.push(script.filePath);
    return `registration-${++nextId}`;
  });
  return { session: { registerPreloadScript } as unknown as Session, registerPreloadScript, registered };
}

interface FakeHost {
  host: PreloadInjectionHost;
  defaultSession: FakeSession;
  createSession: () => FakeSession;
  emitReady: () => void;
  /** Replays a preload's synchronous configuration request, and returns what it got back. */
  requestConfig: (channel: string) => unknown;
}

function createHost({ readyUpfront = false } = {}): FakeHost {
  const defaultSession = createSession();
  const sessionListeners: ((session: Session) => void)[] = [];
  const readyListeners: (() => void)[] = [];
  const ipcListeners = new Map<string, (event: { returnValue?: unknown }) => void>();

  return {
    host: {
      app: {
        isReady: () => readyUpfront,
        on: (_event, listener) => sessionListeners.push(listener),
        once: (_event, listener) => readyListeners.push(listener),
      },
      session: { defaultSession: defaultSession.session },
      ipcMain: {
        on: (channel, listener) => ipcListeners.set(channel, listener as (event: { returnValue?: unknown }) => void),
      },
    },
    defaultSession,
    requestConfig: (channel: string) => {
      const ipcEvent: { returnValue?: unknown } = {};
      ipcListeners.get(channel)?.(ipcEvent);
      return ipcEvent.returnValue;
    },
    createSession: () => {
      const created = createSession();
      for (const listener of sessionListeners) {
        listener(created.session);
      }
      return created;
    },
    emitReady: () => {
      for (const listener of readyListeners) {
        listener();
      }
    },
  };
}

/** `installBridgePreload` is a one-shot, process-wide install, so each case needs a fresh module. */
async function install(host: PreloadInjectionHost): Promise<void> {
  vi.resetModules();
  const { installBridgePreload } = await import('./preloadInjection');
  installBridgePreload(host, () => PRELOAD_PATH);
}

describe('installBridgePreload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should register the preload on the default session once the app is ready', async () => {
    const { host, defaultSession, emitReady } = createHost();

    await install(host);
    expect(defaultSession.registered).toEqual([]);

    emitReady();

    expect(defaultSession.registered).toEqual([PRELOAD_PATH]);
    expect(defaultSession.registerPreloadScript).toHaveBeenCalledWith({ type: 'frame', filePath: PRELOAD_PATH });
  });

  it('should register on the default session right away when the app is already ready', async () => {
    const { host, defaultSession } = createHost({ readyUpfront: true });

    await install(host);

    expect(defaultSession.registered).toEqual([PRELOAD_PATH]);
  });

  it('should register on sessions created later, so custom partitions are covered', async () => {
    const { host, createSession: createNewSession } = createHost();
    await install(host);

    const partitionSession = createNewSession();

    expect(partitionSession.registered).toEqual([PRELOAD_PATH]);
  });

  it('should register at most once per session', async () => {
    const { host, defaultSession, emitReady } = createHost();
    await install(host);

    emitReady();
    emitReady();

    expect(defaultSession.registered).toEqual([PRELOAD_PATH]);
  });

  it('should keep working when a registration fails', async () => {
    const { host, defaultSession, emitReady } = createHost();
    defaultSession.registerPreloadScript.mockImplementation(() => {
      throw new Error('session is not available');
    });

    await install(host);

    expect(emitReady).not.toThrow();
  });

  describe("superseding dd-trace's preload", () => {
    it('should answer a dd-trace registration with the SDK script instead', async () => {
      const { host, defaultSession, emitReady } = createHost();
      await install(host);
      emitReady();

      // What dd-trace's BrowserWindow subclass does on every window it creates.
      defaultSession.session.registerPreloadScript({ type: 'frame', filePath: DD_TRACE_PRELOAD_PATH });

      expect(defaultSession.registered).toEqual([PRELOAD_PATH]);
    });

    it('should return the SDK registration id to the dd-trace caller', async () => {
      const { host, defaultSession, emitReady } = createHost();
      await install(host);
      emitReady();

      const id = defaultSession.session.registerPreloadScript({ type: 'frame', filePath: DD_TRACE_PRELOAD_PATH });

      expect(id).toBe('registration-1');
    });

    it('should supersede dd-trace even when it registers first', async () => {
      // dd-trace registers from the BrowserWindow constructor, which can run before app ready when
      // the window uses a custom partition — the session-created listener still comes first.
      const { host, createSession: createNewSession } = createHost();
      await install(host);
      const partitionSession = createNewSession();

      partitionSession.session.registerPreloadScript({ type: 'frame', filePath: DD_TRACE_PRELOAD_PATH });

      expect(partitionSession.registered).toEqual([PRELOAD_PATH]);
    });

    it("should leave the application's own preloads alone", async () => {
      const { host, defaultSession, emitReady } = createHost();
      await install(host);
      emitReady();

      defaultSession.session.registerPreloadScript({ type: 'frame', filePath: APP_PRELOAD_PATH });

      expect(defaultSession.registered).toEqual([PRELOAD_PATH, APP_PRELOAD_PATH]);
    });
  });

  it('should do nothing when the preload script cannot be located', async () => {
    const { host, defaultSession, emitReady } = createHost();

    vi.resetModules();
    const { installBridgePreload } = await import('./preloadInjection');
    installBridgePreload(host, () => undefined);
    emitReady();

    expect(defaultSession.registered).toEqual([]);
  });

  /**
   * Electron answers a synchronous request only if a listener is registered when it is made, and
   * blocks the renderer for good when none is — registering one afterwards does not release it. So
   * a preload must never be able to run before something can answer, whatever `init()` is doing.
   */
  describe('fallback configuration listener', () => {
    it('should answer the configuration channel from the moment the preload is registered', async () => {
      const { host, requestConfig } = createHost({ readyUpfront: true });

      await install(host);

      expect(requestConfig(CONFIG_CHANNEL)).toEqual({
        defaultPrivacyLevel: 'mask',
        allowedWebViewHosts: [],
        anonymousId: '',
        sessionId: '',
      });
    });

    it('should be listening before the app is ready, ahead of any window', async () => {
      const { host, requestConfig } = createHost();

      await install(host);

      expect(requestConfig(CONFIG_CHANNEL)).toBeDefined();
    });

    it('should answer with plain data — the channel is synchronous, so it is structured-cloned', async () => {
      const { host, requestConfig } = createHost({ readyUpfront: true });

      await install(host);

      expect(() => structuredClone(requestConfig(CONFIG_CHANNEL))).not.toThrow();
    });

    it('should not register when the preload script cannot be located', async () => {
      const { host, requestConfig } = createHost({ readyUpfront: true });

      vi.resetModules();
      const { installBridgePreload } = await import('./preloadInjection');
      installBridgePreload(host, () => undefined);

      // No preload means nothing will ever ask, and an unused listener would only be able to
      // shadow the real one that `BridgeHandler` registers.
      expect(requestConfig(CONFIG_CHANNEL)).toBeUndefined();
    });
  });
});

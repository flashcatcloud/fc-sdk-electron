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

/**
 * Which preload API the fake Electron exposes: `registerPreloadScript` from Electron 35, the
 * `setPreloads` pair that came before it, or neither.
 */
type SessionApi = 'registerPreloadScript' | 'setPreloads' | 'none';

function createSession({ api = 'registerPreloadScript' }: { api?: SessionApi } = {}): FakeSession {
  const registered: string[] = [];
  let nextId = 0;
  const registerPreloadScript = vi.fn((script: PreloadScriptRegistration) => {
    registered.push(script.filePath);
    return `registration-${++nextId}`;
  });

  // `registered` doubles as the session's preload list, so assertions read the same either way.
  const shapes: Record<SessionApi, object> = {
    registerPreloadScript: { registerPreloadScript },
    setPreloads: {
      setPreloads: (paths: string[]) => registered.splice(0, registered.length, ...paths),
      getPreloads: () => registered.slice(),
    },
    none: {},
  };

  return { session: shapes[api] as unknown as Session, registerPreloadScript, registered };
}

interface FakeHost {
  host: PreloadInjectionHost;
  defaultSession: FakeSession;
  createSession: () => FakeSession;
  emitReady: () => void;
  /** Replays a preload's synchronous configuration request, and returns what it got back. */
  requestConfig: (channel: string) => unknown;
}

function createHost({ readyUpfront = false, api }: { readyUpfront?: boolean; api?: SessionApi } = {}): FakeHost {
  const defaultSession = createSession({ api });
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
      const created = createSession({ api });
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

  /**
   * Electron 2 through 34: `setPreloads` is the whole preload API, and it replaces the session's
   * list rather than adding to it.
   */
  describe('an Electron with only setPreloads', () => {
    it('should register the SDK preload through it', async () => {
      const { host, defaultSession, emitReady } = createHost({ api: 'setPreloads' });
      await install(host);

      emitReady();

      expect(defaultSession.registered).toEqual([PRELOAD_PATH]);
    });

    it("should keep the application's own preloads, which setPreloads would otherwise replace", async () => {
      const { host, defaultSession, emitReady } = createHost({ api: 'setPreloads' });
      await install(host);
      // What the application registered before the SDK ever ran.
      defaultSession.session.setPreloads([APP_PRELOAD_PATH]);

      emitReady();

      expect(defaultSession.registered).toEqual([APP_PRELOAD_PATH, PRELOAD_PATH]);
    });

    it('should cover sessions created later, so custom partitions work too', async () => {
      const { host, createSession: createNewSession } = createHost({ api: 'setPreloads' });
      await install(host);

      expect(createNewSession().registered).toEqual([PRELOAD_PATH]);
    });

    it('should register at most once per session', async () => {
      const { host, defaultSession, emitReady } = createHost({ api: 'setPreloads' });
      await install(host);

      emitReady();
      emitReady();

      expect(defaultSession.registered).toEqual([PRELOAD_PATH]);
    });

    it('should answer a dd-trace registration with the SDK script, as on a newer Electron', async () => {
      const { host, defaultSession, emitReady } = createHost({ api: 'setPreloads' });
      await install(host);
      emitReady();

      // What dd-trace's BrowserWindow subclass does on every window it creates.
      defaultSession.session.registerPreloadScript({ type: 'frame', filePath: DD_TRACE_PRELOAD_PATH });

      expect(defaultSession.registered).toEqual([PRELOAD_PATH]);
    });

    it('should say nothing, because nothing is lost', async () => {
      const { host, emitReady } = createHost({ api: 'setPreloads' });
      await install(host);
      emitReady();

      const { displayWarn } = await import('../tools/display');
      expect(displayWarn).not.toHaveBeenCalled();
    });
  });

  /**
   * With neither API there is no bridge to install. That must cost monitoring, never startup: the
   * SDK registers from an `app` 'ready' listener and dd-trace from inside the `BrowserWindow`
   * constructor, and the host application can guard neither.
   */
  describe('an Electron with no preload API at all', () => {
    it('should not throw out of the app ready listener', async () => {
      const { host, emitReady } = createHost({ api: 'none' });
      await install(host);

      expect(emitReady).not.toThrow();
    });

    it('should not throw out of the session-created listener', async () => {
      const { host, createSession: createNewSession } = createHost({ api: 'none' });
      await install(host);

      expect(createNewSession).not.toThrow();
    });

    it('should not throw when the app is ready before the SDK installs', async () => {
      const { host } = createHost({ api: 'none', readyUpfront: true });

      await expect(install(host)).resolves.toBeUndefined();
    });

    it('should leave a dd-trace registration harmless, so windows can still be created', async () => {
      const { host, defaultSession, emitReady } = createHost({ api: 'none' });
      await install(host);
      emitReady();

      expect(() =>
        defaultSession.session.registerPreloadScript({ type: 'frame', filePath: DD_TRACE_PRELOAD_PATH })
      ).not.toThrow();
    });

    it('should say why once, not once per session', async () => {
      const { host, emitReady, createSession: createNewSession } = createHost({ api: 'none' });
      await install(host);
      emitReady();
      createNewSession();
      createNewSession();

      const { displayWarn } = await import('../tools/display');
      expect(displayWarn).toHaveBeenCalledTimes(1);
      expect(vi.mocked(displayWarn).mock.calls[0][0]).toContain('setPreloads');
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreloadScriptRegistration, Session } from 'electron';
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
}

function createHost({ readyUpfront = false } = {}): FakeHost {
  const defaultSession = createSession();
  const sessionListeners: ((session: Session) => void)[] = [];
  const readyListeners: (() => void)[] = [];

  return {
    host: {
      app: {
        isReady: () => readyUpfront,
        on: (_event, listener) => sessionListeners.push(listener),
        once: (_event, listener) => readyListeners.push(listener),
      },
      session: { defaultSession: defaultSession.session },
    },
    defaultSession,
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
});

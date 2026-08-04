import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PreloadScriptRegistration, Session } from 'electron';
import { displayWarn } from '../tools/display';

/**
 * dd-trace ships a bridge preload of its own and registers it from the `BrowserWindow` subclass it
 * installs when it hooks `require('electron')`. That script is a private dd-trace implementation
 * detail we cannot extend, so the SDK owns the preload instead: it registers its own script on
 * every session and redirects dd-trace's registration to it.
 *
 * Redirecting rather than letting both run is deliberate. `contextBridge.exposeInMainWorld` throws
 * when the key is already taken, so with context isolation on only the first script to run reaches
 * the page — and with context isolation off the last one to assign `window.DatadogEventBridge`
 * wins. Two scripts would therefore make which bridge the page sees depend on registration order.
 */
const DD_TRACE_PRELOAD = /[/\\]datadog-instrumentations[/\\]src[/\\]electron[/\\]preload\.js$/;

/**
 * The slice of the `electron` module this needs. Taking it as an argument keeps this module free of
 * a top-level `require('electron')`, which would otherwise load electron before dd-trace has hooked
 * it, and lets the tests drive it without an Electron runtime.
 */
export interface PreloadInjectionHost {
  app: {
    isReady(): boolean;
    on(event: 'session-created', listener: (session: Session) => void): unknown;
    once(event: 'ready', listener: () => void): unknown;
  };
  session: { readonly defaultSession: Session };
}

let installed = false;

/**
 * Make every renderer load the SDK's bridge preload, and only it.
 *
 * Registration is driven by `session-created` rather than by wrapping `BrowserWindow`: it fires for
 * custom partitions too, and it does not depend on the app reaching the `BrowserWindow` export
 * through a hooked `require` — a static ESM `import { BrowserWindow } from 'electron'` captures the
 * original class before any instrumentation runs.
 */
export function installBridgePreload(
  host: PreloadInjectionHost,
  resolvePath: () => string | undefined = resolvePreloadPath
): void {
  const preloadPath = installed ? undefined : resolvePath();
  if (!preloadPath) {
    return;
  }
  installed = true;

  const registrations = new WeakMap<Session, string>();

  const setUp = (session: Session): void => {
    if (registrations.has(session)) {
      return;
    }

    const register = registerOnce(session, preloadPath, registrations);
    takeOverDdTraceRegistrations(session, register);
    register();
  };

  // Sessions are created before the windows using them, so a session-created listener always runs
  // before dd-trace's BrowserWindow subclass gets a chance to register its own preload.
  host.app.on('session-created', setUp);

  // The default session usually exists before this runs, so 'session-created' has already fired for
  // it. Register it explicitly instead; `registrations` keeps that idempotent if the event did fire.
  const setUpDefaultSession = () => setUp(host.session.defaultSession);
  if (host.app.isReady()) {
    setUpDefaultSession();
  } else {
    host.app.once('ready', setUpDefaultSession);
  }
}

/**
 * Register the preload on a session at most once, whatever the number of callers.
 * `registerPreloadScript` is cumulative and session-wide: calling it again adds a registration
 * rather than replacing the previous one.
 */
function registerOnce(session: Session, preloadPath: string, registrations: WeakMap<Session, string>): () => string {
  const registerPreloadScript = session.registerPreloadScript.bind(session);

  return () => {
    let id = registrations.get(session);
    if (id !== undefined) {
      return id;
    }

    id = '';
    try {
      id = registerPreloadScript({ type: 'frame', filePath: preloadPath });
    } catch (error) {
      // A registration failure must never break window creation.
      displayWarn('Failed to register the bridge preload script:', error);
    }
    registrations.set(session, id);
    return id;
  };
}

/**
 * Answer dd-trace's preload registrations with the SDK's own script. Every other registration —
 * the application's preloads in particular — goes through untouched.
 */
function takeOverDdTraceRegistrations(session: Session, register: () => string): void {
  const original = session.registerPreloadScript.bind(session);

  try {
    session.registerPreloadScript = (script: PreloadScriptRegistration): string =>
      DD_TRACE_PRELOAD.test(script?.filePath ?? '') ? register() : original(script);
  } catch (error) {
    displayWarn("Failed to supersede dd-trace's preload script:", error);
  }
}

/** Absolute path of the bundled `preload.js`, or `undefined` when it cannot be located. */
function resolvePreloadPath(): string | undefined {
  const currentFile = typeof __filename === 'undefined' ? fileURLToPath(import.meta.url) : __filename;

  try {
    return createRequire(currentFile).resolve('@flashcatcloud/electron-sdk/preload');
  } catch {
    // Self-resolution fails when the SDK is linked through a symlink (a Yarn portal, say), because
    // the link target is resolved before module lookup starts. preload.js is always emitted next to
    // this file, so fall back to a path relative to it.
    const fallback = join(dirname(currentFile), 'preload.js');
    if (existsSync(fallback)) {
      return fallback;
    }
    displayWarn('Could not locate the bridge preload script — renderer monitoring will not work');
    return undefined;
  }
}

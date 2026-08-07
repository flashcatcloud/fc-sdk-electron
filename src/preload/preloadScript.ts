/**
 * Preload script exposing the `DatadogEventBridge` to every renderer frame.
 *
 * The Browser SDK looks for this global: when it is present, the Browser SDK forwards its events
 * to the main process over IPC instead of uploading them itself.
 *
 * This file is bundled on its own into `dist/preload.js` and must stay dependency-free apart from
 * `electron`. Preload scripts run in a sandboxed context where only Electron's own module is
 * guaranteed to be requireable, so pulling in anything else here would break at runtime.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { BRIDGE_CHANNEL, CONFIG_CHANNEL, CONFIG_PUSH_CHANNEL } from '../common';
import type { BridgeConfig } from '../common';

// Renderer globals. The package is compiled without the DOM lib, so they are declared locally.
declare const window: Record<string, unknown>;
declare const location: { hostname: string };

const MASK = 'mask';

/**
 * Set on `window` the first time this script runs so a second execution is a no-op.
 *
 * `registerPreloadScript` is cumulative, and a frame may end up with the script registered more
 * than once (for instance when both the session registration and a bundler-injected one apply).
 * `window` is shared by every execution within a frame context — in the preload's own world when
 * context isolation is on — so it is where the flag belongs.
 */
const BRIDGE_INITIALIZED = '__dd_bridge_initialized';

if (!window[BRIDGE_INITIALIZED]) {
  window[BRIDGE_INITIALIZED] = true;

  let defaultPrivacyLevel: string = MASK;
  let allowedHosts: string[] = [location.hostname];
  let anonymousId = '';
  let sessionId = '';
  let user: BridgeConfig['user'];
  let configPushed = false;

  const apply = (config: BridgeConfig | undefined): void => {
    defaultPrivacyLevel = config?.defaultPrivacyLevel ?? MASK;
    anonymousId = config?.anonymousId ?? '';
    sessionId = config?.sessionId ?? '';
    user = config?.user;
    // The renderer's own host is always allowed; the configured ones are additions to it.
    allowedHosts = [...new Set([location.hostname, ...(config?.allowedWebViewHosts ?? [])])];
  };

  // Subscribe before asking, never after. Two things depend on this order:
  //
  // - The main process can push at any moment, and a pushed value must never be overwritten by the
  //   older one the synchronous answer carries — hence `configPushed`.
  // - It is what makes `BridgeHandler`'s catch-up push reliable. Getting the unconfigured
  //   configuration back means the fallback listener answered, which means `BridgeHandler` did not
  //   exist yet, which means its construction push is still to come — and this subscription is
  //   already in place to receive it. Were the order reversed, that push could land in the gap.
  ipcRenderer.on(CONFIG_PUSH_CHANNEL, (_event, config: BridgeConfig | undefined) => {
    configPushed = true;
    apply(config);
  });

  const config = ipcRenderer.sendSync(CONFIG_CHANNEL) as BridgeConfig | undefined;

  if (!configPushed) {
    apply(config);
  }

  const bridge = {
    /**
     * The main process does not record renderer sessions on the Browser SDK's behalf, so the
     * bridge declares no capability. The Browser SDK keeps owning its own recorder.
     */
    getCapabilities() {
      return '[]';
    },
    getPrivacyLevel() {
      return defaultPrivacyLevel;
    },
    getAllowedWebViewHosts() {
      return JSON.stringify(allowedHosts);
    },
    /**
     * Id of the session the main process considers active, or `''` when none is. Answered from a
     * cache kept up to date by {@link CONFIG_PUSH_CHANNEL} pushes, so it stays correct across
     * session expiry and renewal without a synchronous IPC call per read.
     */
    getSessionId() {
      return sessionId;
    },
    /** Device-scoped identifier, stable across app restarts. */
    getAnonymousId() {
      return anonymousId;
    },
    /**
     * Identity the main process set through `setUser`, as JSON, or `'{}'` when nobody is logged
     * in. A JSON string rather than an object, to match `getCapabilities` and
     * `getAllowedWebViewHosts` — the bridge only ever hands strings across.
     *
     * Kept up to date by {@link IDENTITY_CHANNEL} pushes, like the session id. Note that renderer
     * events do not need this: the main process stamps the identity on them as they pass through.
     * It is here so a renderer can attribute anything it uploads itself to the same user.
     */
    getUser() {
      return user ? JSON.stringify(user) : '{}';
    },
    send(msg: string) {
      ipcRenderer.send(BRIDGE_CHANNEL, msg);
    },
  };

  window.DatadogEventBridge = bridge;

  try {
    contextBridge.exposeInMainWorld('DatadogEventBridge', bridge);
  } catch {
    // exposeInMainWorld throws when contextIsolation is disabled — the assignment above is then
    // already the main world's, so the bridge is reachable either way.
  }
}

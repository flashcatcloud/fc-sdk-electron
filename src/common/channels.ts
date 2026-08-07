export const BRIDGE_CHANNEL = 'datadog:bridge-send';
/**
 * Renderer → main, synchronous: the preload's one-off request for the bridge configuration.
 *
 * A synchronous request blocks the renderer's main thread until the main process answers, and
 * Electron never answers a channel that has no `ipcMain` listener — the renderer blocks forever,
 * and registering the listener afterwards does not release it. Something must therefore be
 * listening from the moment a preload can run, which is why `installBridgePreload` registers a
 * fallback listener rather than leaving the channel to `BridgeHandler`, whose construction the
 * SDK's asynchronous `init()` may delay — or skip entirely, when the configuration fails to
 * validate.
 */
export const CONFIG_CHANNEL = 'datadog:bridge-config';
/**
 * Main process → renderer, asynchronous: a fresh `BridgeConfig` replacing what the preload cached.
 *
 * The preload caches the configuration so the bridge can answer the Browser SDK synchronously,
 * instead of paying a synchronous IPC round trip on every event. This channel is what keeps that
 * cache true: it carries the whole configuration, sent whenever the session changes and once when
 * `BridgeHandler` is constructed — so renderers that started before the SDK was ready, and hold the
 * fallback configuration with no session or device id, pick up the real one.
 */
export const CONFIG_PUSH_CHANNEL = 'datadog:bridge-config-push';

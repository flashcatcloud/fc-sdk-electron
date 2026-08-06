import type { DefaultPrivacyLevel } from '@flashcatcloud/browser-core';

/**
 * Everything the preload needs to answer the Browser SDK's bridge calls.
 *
 * Carried by both bridge configuration channels: {@link CONFIG_CHANNEL} answers the preload's
 * initial request with it, and {@link CONFIG_PUSH_CHANNEL} replaces it wholesale whenever it goes
 * stale. One payload for both directions is deliberate — a partial update would leave the preload
 * having to merge, and the fields do not change independently enough to be worth it.
 *
 * It crosses a synchronous IPC boundary, so it must stay structured-cloneable: plain data only,
 * never a function.
 */
export interface BridgeConfig {
  defaultPrivacyLevel: DefaultPrivacyLevel;
  allowedWebViewHosts: string[];
  /** Device-scoped identifier, stable across app restarts. `''` before the SDK is initialized. */
  anonymousId: string;
  /** Id of the active session, or `''` when none is — before initialization, or after expiry. */
  sessionId: string;
}

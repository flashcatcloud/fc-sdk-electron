import type { DefaultPrivacyLevel } from '@flashcatcloud/browser-core';

/**
 * Payload the main process returns over the synchronous {@link CONFIG_CHANNEL}.
 *
 * Everything here crosses a synchronous IPC boundary, so it must stay structured-cloneable: plain
 * data only, never a function. Anything that can change while the app runs is pushed afterwards
 * over {@link IDENTITY_CHANNEL} instead — the values below are only the starting point.
 */
export interface BridgeConfig {
  defaultPrivacyLevel: DefaultPrivacyLevel;
  allowedWebViewHosts: string[];
  /** Device-scoped identifier, stable across app restarts. */
  anonymousId: string;
  /** Id of the session active when the renderer asked, or `''` when no session is active. */
  sessionId: string;
}

/** Payload the main process pushes over {@link IDENTITY_CHANNEL} whenever an identifier changes. */
export interface IdentityUpdate {
  /** Id of the session now active, or `''` when the session expired without a replacement yet. */
  sessionId: string;
}

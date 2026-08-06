import type { DefaultPrivacyLevel } from '@flashcatcloud/browser-core';
import type { User } from '../domain/UserContext';

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
  /** Identity set through `setUser` in the main process, or `undefined` when nobody is logged in. */
  user?: User;
}

/** Payload the main process pushes over {@link IDENTITY_CHANNEL} whenever an identifier changes. */
export interface IdentityUpdate {
  /** Id of the session now active, or `''` when the session expired without a replacement yet. */
  sessionId: string;
  /**
   * Identity now in force, or `undefined` after `clearUser`. Absent and empty are distinct: the
   * backend counts users off `NULLIF(usr_id, '')`, so a cleared identity has to remove the field
   * rather than blank it.
   */
  user?: User;
}

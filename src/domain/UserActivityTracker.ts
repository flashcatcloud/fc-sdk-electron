import { app, webContents } from 'electron';
import type { InputEvent, WebContents } from 'electron';
import { EventKind, LifecycleKind } from '../event';
import type { EventManager } from '../event';
import { monitor } from './telemetry';

/**
 * Input the user has to be present to produce.
 *
 * Deliberately not every `input-event`. Pointer moves and enter/leave fire on a mouse merely
 * crossing the window, which is not someone using the application — taking them would keep a
 * session alive for as long as the cursor happened to rest over it. Key and button *releases* are
 * left out too: they always follow a press that already counted.
 */
const PRESENCE_EVENTS = new Set<InputEvent['type']>(['mouseDown', 'mouseWheel', 'keyDown', 'rawKeyDown']);

/**
 * Bridges user interactions into session management.
 *
 * Reads input from `webContents` directly rather than from the RUM events renderers report:
 *
 * ```
 * renderer input → webContents 'input-event' → END_USER_ACTIVITY → SessionManager.updateActivity()
 * ```
 *
 * It used to watch for click actions arriving over the bridge, which coupled session renewal to
 * the Browser SDK still collecting. That is a cycle, and it closes: the Browser SDK stops
 * collecting while the host reports no session, so the click that was supposed to renew the
 * session never arrived, and a session that had merely timed out could never come back. Reading
 * input here breaks it — nothing about renewal depends on what a renderer chooses to report.
 *
 * It is also simply wider. Keyboard input counts, windows that never loaded the Browser SDK count,
 * and it does not quietly depend on the renderer having `trackUserInteractions` enabled — with
 * that option off, the old signal never fired at all and sessions could not be renewed.
 *
 * @see SessionManager for how `END_USER_ACTIVITY` drives session renewal.
 */
export class UserActivityTracker {
  constructor(eventManager: EventManager) {
    const watch = (contents: WebContents) => {
      contents.on(
        'input-event',
        monitor((_event, input) => {
          if (PRESENCE_EVENTS.has(input.type)) {
            eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });
          }
        })
      );
    };

    // Windows can be open before the SDK is initialized, so both halves are needed: the ones that
    // already exist, and the ones that come later.
    for (const contents of webContents.getAllWebContents()) {
      watch(contents);
    }
    app.on('web-contents-created', (_event, contents) => watch(contents));
  }
}

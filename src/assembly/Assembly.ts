import { combine, DISCARDED, timeStampNow, TimeStamp } from '@flashcatcloud/browser-core';
import type { RecursivePartial } from '../tools/coreCompat';
import { EventFormat, EventKind, EventManager, EventSource, EventTrack, type RawEvent, ServerEvent } from '../event';
import type { RawRumEvent } from '../event';
import type { FormatHooks } from './hooks';
import { resolveEventUser, type User } from '../domain/UserContext';
import { RumEvent } from '../domain/rum';
import { TelemetryEvent } from '../domain/telemetry';

/**
 * Transforms RawEvents into ServerEvents by enriching them with contextual
 * attributes (session, application, view, etc.) via format hooks.
 *
 * Handles two sources differently:
 * - **Main-process events**: fully assembled by combining raw data with all
 *   registered hook results (commonContext, session, view).
 * - **Renderer events**: arrive pre-assembled by `@flashcatcloud/browser-rum` in
 *   the renderer process. Only `session.id` and `application.id` are
 *   overridden from the main process; the renderer's own view, source,
 *   service, and other attributes are preserved.
 */
export class Assembly {
  constructor(
    private eventManager: EventManager,
    private hooks: FormatHooks,
    /**
     * Identity in force at an event's start time — see `UserContext`. Defaults to "never anyone",
     * so a caller that does not wire it up leaves renderer events exactly as they arrived.
     */
    private getUser: (startTime: TimeStamp) => User | undefined = () => undefined
  ) {
    this.eventManager.registerHandler<RawEvent>({
      canHandle: (event) => event.kind === EventKind.RAW,
      handle: (event, notify) => {
        const result = this.assembleToServerEvent(event);
        if (result !== DISCARDED) {
          notify(result);
        }
      },
    });
  }

  /** Route to the appropriate assembly strategy based on event source. */
  private assembleToServerEvent(event: RawEvent): ServerEvent | DISCARDED {
    if (event.format === EventFormat.RUM && event.source === EventSource.RENDERER) {
      return this.assembleRendererRumEvent(event);
    }

    return this.assembleMainProcessEvent(event);
  }

  /**
   * Renderer RUM events arrive already assembled by `@flashcatcloud/browser-rum`.
   * Only `session.id` and `application.id` are overridden from the main
   * process hooks, preserving the renderer's own view, source, and other
   * attributes.
   */
  private assembleRendererRumEvent(event: RawRumEvent): ServerEvent | DISCARDED {
    const hookResult = this.hooks.triggerRum({
      eventType: event.data.type,
      startTime: event.data.date as TimeStamp,
    });

    if (hookResult === DISCARDED) {
      return DISCARDED;
    }

    const { session, application, view } = hookResult ?? {};
    const mainProcessAttributes = {
      session: { id: session?.id },
      application: { id: application?.id },
      container: { view: { id: view?.id }, source: 'electron' },
    };

    // Note `usr` is not in `mainProcessAttributes`: the anonymous id must not be stamped here (the
    // renderer reads the same id off the bridge itself), and the identity needs replacing rather
    // than merging — see below.
    const data = combine(event.data, mainProcessAttributes) as RumEvent;

    return {
      kind: EventKind.SERVER,
      track: EventTrack.RUM,
      source: EventSource.RENDERER,
      // override some renderer event attributes by main process attributes
      data: this.applyUserIdentity(data),
    };
  }

  /**
   * Replace a bridged event's identity with the main process's, when one is set.
   *
   * **Replacement, not a merge.** `combine` merges per key and skips `undefined`, so merging a
   * main-process `{ id, name }` over a renderer's `{ id, name, email }` would emit the main
   * process's id and name next to the previous user's email — an identity that belongs to nobody,
   * and worse than either source alone.
   *
   * **The main process wins.** It is the one place that knows who is logged in, which is why it
   * already overrides `session.id` and `application.id` on the way through. The deciding reason is
   * `clearUser()`: if a stale renderer-side identity could survive it, logging out would leave the
   * user's name and email attached to everything the window kept reporting. A logout has to be
   * enforceable from one place.
   *
   * `usr.anonymous_id` is carried over untouched — it is device-scoped, the renderer took it from
   * this same bridge, and it has to stay put across a login and a logout.
   *
   * When no user is set, nothing is touched, so an application that only ever calls
   * `flashcatRum.setUser()` in its renderers keeps the behaviour it had before this existed.
   */
  private applyUserIdentity(data: RumEvent): RumEvent {
    const user = resolveEventUser(this.getUser, data.type, data.date as TimeStamp);
    if (!user) {
      return data;
    }

    const anonymousId = data.usr?.anonymous_id;
    const usr = anonymousId === undefined ? { ...user } : { ...user, anonymous_id: anonymousId };

    return { ...data, usr } as RumEvent;
  }

  /**
   * Main-process events are assembled by combining raw data with the full
   * hook chain (commonContext, session, view), producing a complete
   * ServerEvent ready for transport.
   */
  private assembleMainProcessEvent(event: RawEvent): ServerEvent | DISCARDED {
    const startTime = event.startTime ?? timeStampNow();

    if (event.format === EventFormat.RUM) {
      const hookResult = this.hooks.triggerRum({
        eventType: event.data.type,
        startTime,
      });
      if (hookResult !== DISCARDED) {
        return {
          kind: EventKind.SERVER,
          track: EventTrack.RUM,
          source: EventSource.MAIN,
          data: assembleData<RumEvent>(event.data, hookResult),
        };
      }
    }

    if (event.format === EventFormat.TELEMETRY) {
      const hookResult = this.hooks.triggerTelemetry({ startTime });
      if (hookResult !== DISCARDED) {
        return {
          kind: EventKind.SERVER,
          track: EventTrack.RUM,
          data: assembleData<TelemetryEvent>(event.data, hookResult),
        };
      }
    }

    return DISCARDED;
  }
}

function assembleData<T>(rawData: unknown, hookResult: RecursivePartial<T> | undefined): T {
  return (hookResult ? combine(hookResult, rawData) : rawData) as T;
}

import type { TimeStamp } from '@flashcatcloud/browser-core';
import type { Configuration } from '../config';
import { resolveEventUser, type User } from '../domain/UserContext';
import type { FormatHooks } from './hooks';

/**
 * Define the common attributes for the events of each format
 *
 * @param anonymousId device-scoped identifier — see `AnonymousId`
 * @param getUser identity in force at an event's start time, or `undefined` when nobody is logged
 *   in — see `UserContext`. Defaults to "never anyone", so a caller that does not wire it up gets
 *   the anonymous id alone.
 */
export function registerCommonContext(
  configuration: Configuration,
  hooks: FormatHooks,
  anonymousId: string,
  getUser: (startTime: TimeStamp) => User | undefined = () => undefined
) {
  hooks.registerRum((params) => ({
    date: Date.now(),
    source: 'electron',
    service: configuration.service,
    version: configuration.version,
    application: { id: configuration.applicationId },
    session: { type: 'user' },
    // The anonymous id and the real identity coexist, and the anonymous id is written last so no
    // identity can displace it — `setUser` cannot even carry the key, but the ordering makes that
    // independent of `sanitizeUser`.
    //
    // `usr.id` is present **only** once the application calls `setUser`. It is deliberately not
    // backfilled with the anonymous id, and not to be "aligned" with the browser SDK later: unique
    // users are counted here off `COALESCE(NULLIF(usr_anonymous_id, ''), NULLIF(usr_id, ''))`,
    // which reads the anonymous id first, and that id is stable across a login. The browser SDK
    // copies it into `usr.id` because its count is `COUNT(DISTINCT usr_id)` and that is the only
    // way it can see logged-out users; doing the same here would buy nothing and would count one
    // device as two people, since `usr.id` would flip from the anonymous id to the real one the
    // moment the user logs in. `NULLIF(usr_id, '')` is also why `clearUser` removes the key
    // instead of blanking it — an empty string and an absent field are not the same row.
    usr: { ...resolveEventUser(getUser, params.eventType, params.startTime), anonymous_id: anonymousId },
    ddtags: `sdk_version:${__SDK_VERSION__}`,
    _dd: { format_version: 2 },
  }));

  hooks.registerTelemetry(() => ({
    date: Date.now(),
    source: 'electron',
    service: 'electron-sdk',
    version: __SDK_VERSION__,
    application: { id: configuration.applicationId },
    _dd: { format_version: 2 },
  }));

  hooks.registerSpan(() => ({
    meta: {
      '_dd.application.id': configuration.applicationId,
    },
  }));
}

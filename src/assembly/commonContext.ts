import type { Configuration } from '../config';
import type { FormatHooks } from './hooks';

/**
 * Define the common attributes for the events of each format
 *
 * @param anonymousId device-scoped identifier — see `AnonymousId`
 */
export function registerCommonContext(configuration: Configuration, hooks: FormatHooks, anonymousId: string) {
  hooks.registerRum(() => ({
    date: Date.now(),
    source: 'electron',
    service: configuration.service,
    version: configuration.version,
    application: { id: configuration.applicationId },
    session: { type: 'user' },
    // `anonymous_id` only. Deliberately **not** `usr.id`, and not to be "aligned" with the browser
    // SDK later: unique users are counted here off
    // `COALESCE(NULLIF(usr_anonymous_id, ''), NULLIF(usr_id, ''))`, which reads the anonymous id
    // first, and that id is stable across a login. The browser SDK copies it into `usr.id` because
    // its count is `COUNT(DISTINCT usr_id)` and that is the only way it can see logged-out users;
    // doing the same here would buy nothing and would count one device as two people, since
    // `usr.id` flips from the anonymous id to the real one the moment the user logs in.
    usr: { anonymous_id: anonymousId },
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

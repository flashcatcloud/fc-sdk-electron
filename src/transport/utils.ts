// FlashCat intake: the configured `site` is already the full intake host
// (e.g. browser.flashcat.cloud). Unlike Datadog, there is no `browser-intake-`
// prefix and no subdomain-to-dash rewriting — the host is used verbatim.
// This mirrors the FlashCat browser-sdk fork's `buildEndpointHost`, which simply
// returns `site`.

/**
 * Origin the SDK uploads to — scheme, host **and port**.
 *
 * This is the origin of the URL {@link computeIntakeUrlForTrack} builds, which is what makes it
 * usable to recognize the SDK's own traffic and keep it out of the data it collects. Comparing
 * origins rather than hostnames matters for self-hosted deployments, where the intake and the
 * application's own services routinely share a host and differ only by port.
 *
 * Returns `undefined` when the configuration does not produce a parsable URL; the caller then has
 * no origin to exclude.
 */
export function computeIntakeOrigin(site: string, proxy?: string): string | undefined {
  try {
    return new URL(proxy ?? `https://${site}`).origin;
  } catch {
    return undefined;
  }
}

/**
 * The URL the SDK uploads a track to.
 *
 * The intake reads an event's environment from the request's `ddtags` query parameter, not from
 * the event — the body has no field for it — so `env` travels there, as `env:<env>`, the one tag
 * the intake takes from the query. Service and version are read from each event, which matters
 * because a renderer's events carry their own; and nothing is sent without an environment, so the
 * URL is then the bare track.
 *
 * Behind a proxy, the whole path and query the intake has to see travel inside `ddforward`; the
 * intake reads its query parameters from there.
 */
export function computeIntakeUrlForTrack(site: string, trackType: string, proxy?: string, env?: string): string {
  const pathAndQuery = `/api/v2/${trackType}${env ? `?ddtags=${encodeURIComponent(buildTag('env', env))}` : ''}`;
  if (proxy) {
    return `${proxy}?ddforward=${encodeURIComponent(pathAndQuery)}`;
  }

  return `https://${site}${pathAndQuery}`;
}

/** `key:value`, with the characters the intake splits tags on — commas, and colons — replaced. */
function buildTag(key: string, value: string): string {
  return `${key}:${value.replace(/[,:]/g, '_')}`;
}

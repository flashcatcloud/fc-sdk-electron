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

export function computeIntakeUrlForTrack(site: string, trackType: string, proxy?: string): string {
  if (proxy) {
    return `${proxy}?ddforward=${encodeURIComponent(`/api/v2/${trackType}`)}`;
  }

  return `https://${site}/api/v2/${trackType}`;
}

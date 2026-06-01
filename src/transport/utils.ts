// FlashCat intake: the configured `site` is already the full intake host
// (e.g. browser.flashcat.cloud). Unlike Datadog, there is no `browser-intake-`
// prefix and no subdomain-to-dash rewriting — the host is used verbatim.
// This mirrors the FlashCat browser-sdk fork's `buildEndpointHost`, which simply
// returns `site`.

export function computeIntakeHostname(site: string, proxy?: string): string {
  if (proxy) {
    return new URL(proxy).hostname;
  }

  return site;
}

export function computeIntakeUrlForTrack(site: string, trackType: string, proxy?: string): string {
  if (proxy) {
    return `${proxy}?ddforward=${encodeURIComponent(`/api/v2/${trackType}`)}`;
  }

  return `https://${site}/api/v2/${trackType}`;
}

import { describe, it, expect } from 'vitest';
import { computeIntakeOrigin, computeIntakeUrlForTrack } from './utils';

describe('computeIntakeOrigin', () => {
  it('builds the origin the SDK uploads to from the site', () => {
    expect(computeIntakeOrigin('browser.flashcat.cloud')).toBe('https://browser.flashcat.cloud');
  });

  it('builds the origin from the staging site', () => {
    expect(computeIntakeOrigin('jira.flashcat.cloud')).toBe('https://jira.flashcat.cloud');
  });

  /**
   * Guard. `site` is used verbatim, so a self-hosted deployment can carry a port — and the whole
   * point of comparing origins is that this port survives.
   */
  it('keeps the port a self-hosted site carries', () => {
    expect(computeIntakeOrigin('10.0.0.5:8790')).toBe('https://10.0.0.5:8790');
  });

  it('uses the proxy origin when a proxy is set', () => {
    expect(computeIntakeOrigin('browser.flashcat.cloud', 'http://localhost:9999/api')).toBe('http://localhost:9999');
  });

  /** Guard. Dropping the proxy port is what made same-host application traffic disappear. */
  it('keeps the proxy port', () => {
    expect(computeIntakeOrigin('browser.flashcat.cloud', 'http://127.0.0.1:8790/api/v2/rum')).toBe(
      'http://127.0.0.1:8790'
    );
  });

  it('normalizes away a port that is the default for the scheme', () => {
    expect(computeIntakeOrigin('browser.flashcat.cloud', 'https://intake.example.com:443/api')).toBe(
      'https://intake.example.com'
    );
  });

  it('returns undefined when the configuration yields no parsable URL', () => {
    expect(computeIntakeOrigin('')).toBeUndefined();
    expect(computeIntakeOrigin('browser.flashcat.cloud', 'not a url')).toBeUndefined();
  });
});

describe('computeIntakeUrlForTrack', () => {
  it('generates intakeUrl for rum track using the site as host', () => {
    const result = computeIntakeUrlForTrack('browser.flashcat.cloud', 'rum');

    expect(result).toBe('https://browser.flashcat.cloud/api/v2/rum');
  });

  it('generates intakeUrl for the staging site', () => {
    const result = computeIntakeUrlForTrack('jira.flashcat.cloud', 'rum');

    expect(result).toBe('https://jira.flashcat.cloud/api/v2/rum');
  });

  it('uses proxy when provided, with ddforward for rum track', () => {
    const result = computeIntakeUrlForTrack('browser.flashcat.cloud', 'rum', 'http://localhost:3000');

    expect(result).toBe('http://localhost:3000?ddforward=%2Fapi%2Fv2%2Frum');
  });

  it('tags the upload with the environment, which the intake reads from the query alone', () => {
    const result = computeIntakeUrlForTrack('browser.flashcat.cloud', 'rum', undefined, 'production');

    expect(result).toBe('https://browser.flashcat.cloud/api/v2/rum?ddtags=env%3Aproduction');
  });

  it('carries the tag inside ddforward behind a proxy, where the intake reads it', () => {
    const result = computeIntakeUrlForTrack('browser.flashcat.cloud', 'rum', 'http://localhost:3000', 'production');

    expect(result).toBe('http://localhost:3000?ddforward=%2Fapi%2Fv2%2Frum%3Fddtags%3Denv%253Aproduction');
    const forwarded = new URL(new URL(result).searchParams.get('ddforward')!, 'http://intake.test');
    expect(forwarded.pathname).toBe('/api/v2/rum');
    expect(forwarded.searchParams.get('ddtags')).toBe('env:production');
  });

  it('sends no tag without an environment', () => {
    expect(computeIntakeUrlForTrack('browser.flashcat.cloud', 'rum', undefined, undefined)).toBe(
      'https://browser.flashcat.cloud/api/v2/rum'
    );
    expect(computeIntakeUrlForTrack('browser.flashcat.cloud', 'rum', 'http://localhost:3000', '')).toBe(
      'http://localhost:3000?ddforward=%2Fapi%2Fv2%2Frum'
    );
  });

  it('keeps the tag in one piece: the intake splits tags on commas and pairs on colons', () => {
    const result = computeIntakeUrlForTrack('browser.flashcat.cloud', 'rum', undefined, 'eu:west,blue');

    expect(new URL(result).searchParams.get('ddtags')).toBe('env:eu_west_blue');
  });

  /** The origin used to exclude the SDK's own traffic must be the origin it actually posts to. */
  it('posts to the origin computeIntakeOrigin reports', () => {
    for (const [site, proxy] of [
      ['browser.flashcat.cloud', undefined],
      ['10.0.0.5:8790', undefined],
      ['browser.flashcat.cloud', 'http://127.0.0.1:8790/api/v2/rum'],
    ] as const) {
      const url = computeIntakeUrlForTrack(site, 'rum', proxy, 'production');
      expect(new URL(url).origin).toBe(computeIntakeOrigin(site, proxy));
    }
  });
});

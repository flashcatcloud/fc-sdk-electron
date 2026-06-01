import { describe, it, expect } from 'vitest';
import { computeIntakeHostname, computeIntakeUrlForTrack } from './utils';

describe('computeIntakeHostname', () => {
  it('returns the site verbatim as the intake hostname', () => {
    expect(computeIntakeHostname('browser.flashcat.cloud')).toBe('browser.flashcat.cloud');
  });

  it('returns the staging site verbatim', () => {
    expect(computeIntakeHostname('jira.flashcat.cloud')).toBe('jira.flashcat.cloud');
  });

  it('returns the proxy hostname when proxy is set', () => {
    expect(computeIntakeHostname('browser.flashcat.cloud', 'http://localhost:9999/api')).toBe('localhost');
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
});

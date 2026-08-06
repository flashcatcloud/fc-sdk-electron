import { describe, expect, it, vi } from 'vitest';
import type { Configuration } from '../../config';
import { createIntakeBlocklist } from './Tracing';

// Reached transitively through the `../../transport` barrel; see docs/TESTING.md.
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/user/data'), getVersion: vi.fn(() => '1.0.0') },
}));

function blocklistFor(overrides: Partial<Configuration>) {
  return createIntakeBlocklist({ site: 'browser.flashcat.cloud', ...overrides } as Configuration);
}

/**
 * The blocklist dd-trace applies to every outbound request before it records a span — the SDK's
 * primary defense against reporting its own uploads as RUM resources.
 *
 * The URIs below are the shape `HttpClientPlugin` builds: `protocol//host[:port]path`, no query
 * string. They are what the `node:http`, `fetch` and Electron `net.request` paths all reduce to.
 */
describe('createIntakeBlocklist', () => {
  it('blocks uploads to the intake host', () => {
    expect(blocklistFor({})!('https://browser.flashcat.cloud/api/v2/rum')).toBe(true);
  });

  it('blocks uploads to the configured proxy', () => {
    const isBlocked = blocklistFor({ proxy: 'http://127.0.0.1:8790/api/v2/rum' })!;

    expect(isBlocked('http://127.0.0.1:8790/api/v2/rum')).toBe(true);
  });

  /**
   * Guard. Matching the host alone silenced every application request that shared a host with the
   * intake — the normal shape of a self-hosted deployment, where the two differ only by port.
   */
  it('allows application requests on the proxy host but another port', () => {
    const isBlocked = blocklistFor({ proxy: 'http://127.0.0.1:8790/api/v2/rum' })!;

    expect(isBlocked('http://127.0.0.1:9001/api/orders')).toBe(false);
  });

  /** Guard for the same bug from the other side: a `site` carrying a port is a valid setup. */
  it('blocks uploads to an intake host that carries a port, and nothing else on that host', () => {
    const isBlocked = blocklistFor({ site: '10.0.0.5:8790' })!;

    expect(isBlocked('https://10.0.0.5:8790/api/v2/rum')).toBe(true);
    expect(isBlocked('https://10.0.0.5:9001/api/orders')).toBe(false);
  });

  it('allows unrelated hosts', () => {
    expect(blocklistFor({})!('https://api.example.com/data')).toBe(false);
  });

  it('allows anything it cannot parse rather than dropping it', () => {
    expect(blocklistFor({})!('not a uri')).toBe(false);
  });

  it('blocks nothing when the configuration yields no intake origin', () => {
    expect(blocklistFor({ proxy: 'not a url' })).toBeUndefined();
  });
});

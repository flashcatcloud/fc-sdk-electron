import { mockFs, createTestConfiguration } from '../mocks.specUtil';
vi.mock('node:fs/promises');
const { writeFileSync, renameSync, unlinkSync, readdirSync } = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(() => []),
}));
vi.mock('node:fs', () => ({ writeFileSync, renameSync, unlinkSync, readdirSync }));
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/user/data') },
}));
vi.mock('../tools/display', () => ({ displayError: vi.fn(), displayWarn: vi.fn() }));

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { Configuration } from '../config';
import { EventKind, EventManager, LifecycleKind } from '../event';
import { displayWarn } from '../tools/display';
import {
  REMOTE_CONFIGURATION_FILE_NAME,
  REQUEST_TIMEOUT,
  RETRY_DELAYS,
  RemoteConfiguration,
} from './RemoteConfiguration';

const mfs = mockFs();
const FILE_PATH = `/mock/user/data/${REMOTE_CONFIGURATION_FILE_NAME}`;

/** A response the way the server writes it: every envelope field present. */
function configurationBody(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    version: 3,
    ttl: 600,
    enabled: true,
    activation: 'next_session',
    refresh_on_foreground: false,
    rum: { sessionSampleRate: 25, sessionOnError: true },
    ...overrides,
  };
}

function ok(body: unknown, etag = '"tag-3"') {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { ETag: etag, 'Content-Type': 'application/json' },
  });
}

/** What the SDK would have written for this configuration and identity. */
function storedFile(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    format: 1,
    sdkVersion: 'test',
    identity: JSON.stringify(['http://proxy.test', 'test-app-id', 'prod', '1.2.3']),
    version: 2,
    values: { sessionSampleRate: 0, sessionOnError: true },
    custom: { flag: 'cached' },
    etag: '"tag-2"',
    ...overrides,
  });
}

describe('RemoteConfiguration', () => {
  let fetchMock: Mock<typeof fetch>;
  let eventManager: EventManager;
  let config: Configuration;
  let remote: RemoteConfiguration | undefined;
  let onImmediateChange: Mock<() => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    mfs.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mfs.writeFile.mockResolvedValue(undefined);
    eventManager = new EventManager();
    onImmediateChange = vi.fn();
    config = createTestConfiguration({
      proxy: 'http://proxy.test',
      clientToken: 'pub-token',
      applicationId: 'test-app-id',
      env: 'prod',
      version: '1.2.3',
      sessionSampleRate: 100,
      sessionOnError: false,
      remoteConfigurationEnabled: true,
    });
  });

  afterEach(() => {
    remote?.stop();
    remote = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    mfs.reset();
  });

  async function start(): Promise<RemoteConfiguration> {
    remote = await RemoteConfiguration.init(config);
    remote.start(eventManager, onImmediateChange);
    await vi.advanceTimersByTimeAsync(0);
    return remote;
  }

  function writtenFiles(): Record<string, unknown>[] {
    return mfs.writeFile.mock.calls
      .filter(([filePath]) => (filePath as string).startsWith(`${FILE_PATH}.`))
      .map(([, content]) => JSON.parse(content as string) as Record<string, unknown>);
  }

  function requestedUrl(call = 0): URL {
    const outer = new URL(fetchMock.mock.calls[call][0] as string);
    return new URL(outer.searchParams.get('ddforward')!, 'http://inner.test');
  }

  function requestHeaders(call = 0): Record<string, string> {
    return (fetchMock.mock.calls[call][1]?.headers ?? {}) as Record<string, string>;
  }

  describe('when disabled', () => {
    it('requests nothing, reads nothing, and answers with the init values', async () => {
      config = { ...config, remoteConfigurationEnabled: false };
      mfs.readFile.mockResolvedValue(storedFile());

      const configuration = await start();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(mfs.readFile).not.toHaveBeenCalled();
      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 100, sessionOnError: false });
      expect(configuration.getCustom()).toBeUndefined();
    });
  });

  describe('request', () => {
    it('asks the config endpoint through the proxy with the client identity', async () => {
      fetchMock.mockResolvedValue(ok(configurationBody()));

      await start();

      const outer = new URL(fetchMock.mock.calls[0][0] as string);
      expect(outer.origin).toBe('http://proxy.test');
      const inner = requestedUrl();
      expect(inner.pathname).toBe('/api/v2/rum/config');
      expect(Object.fromEntries(inner.searchParams)).toEqual({
        client_token: 'pub-token',
        sdk: 'electron',
        sdk_version: 'test',
        env: 'prod',
        app_version: '1.2.3',
      });
    });

    it('asks the site directly without a proxy, and leaves out what is not configured', async () => {
      config = { ...config, proxy: undefined, site: 'intake.example.test', env: undefined, version: undefined };
      fetchMock.mockResolvedValue(ok(configurationBody()));

      await start();

      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(`${url.origin}${url.pathname}`).toBe('https://intake.example.test/api/v2/rum/config');
      expect([...url.searchParams.keys()]).toEqual(['client_token', 'sdk', 'sdk_version']);
    });

    it('reports the version it holds, and sends its ETag', async () => {
      mfs.readFile.mockResolvedValue(storedFile());
      fetchMock.mockResolvedValue(new Response(null, { status: 304 }));

      await start();

      expect(requestedUrl().searchParams.get('applied_version')).toBe('2');
      expect(requestHeaders()).toEqual({ 'If-None-Match': '"tag-2"' });
    });

    it('does not block: start returns while the request is still pending', async () => {
      fetchMock.mockReturnValue(new Promise(() => undefined));
      remote = await RemoteConfiguration.init(config);

      remote.start(eventManager, onImmediateChange);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(remote.getSampling()).toEqual({ sessionSampleRate: 100, sessionOnError: false });
    });

    it('asks again whenever a new session starts', async () => {
      fetchMock.mockResolvedValue(ok(configurationBody()));
      await start();

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(requestedUrl(1).searchParams.get('applied_version')).toBe('3');
    });

    it('does not start a second request while one is in flight', async () => {
      fetchMock.mockReturnValue(new Promise(() => undefined));
      await start();

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('parsing and validation', () => {
    it('applies the delivered rate and switch over the init values, with their version', async () => {
      fetchMock.mockResolvedValue(ok(configurationBody()));

      const configuration = await start();

      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 25, sessionOnError: true, rcVersion: 3 });
    });

    it('keeps the init value of a knob the console did not set', async () => {
      fetchMock.mockResolvedValue(ok(configurationBody({ rum: { sessionOnError: true } })));

      const configuration = await start();

      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 100, sessionOnError: true, rcVersion: 3 });
    });

    it.each([
      ['absent', undefined],
      ['null', null],
    ])('reads a %s rum bag as empty', async (_, rum) => {
      fetchMock.mockResolvedValue(ok(configurationBody({ rum })));

      const configuration = await start();

      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 100, sessionOnError: false, rcVersion: 3 });
    });

    it('drops the values and custom while the kill switch is off, and keeps the version', async () => {
      fetchMock.mockResolvedValue(ok(configurationBody({ enabled: false, custom: { flag: true } })));

      const configuration = await start();

      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 100, sessionOnError: false, rcVersion: 3 });
      expect(configuration.getCustom()).toBeUndefined();
    });

    it.each([
      ['a rate above 100', { sessionSampleRate: 150 }],
      ['a negative rate', { sessionSampleRate: -1 }],
      ['a rate as a string', { sessionSampleRate: '50' }],
      ['a switch as a string', { sessionOnError: 'true' }],
      ['a switch as a number', { sessionOnError: 1 }],
    ])('drops %s and keeps the init value', async (_, rum) => {
      fetchMock.mockResolvedValue(ok(configurationBody({ rum })));

      const configuration = await start();

      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 100, sessionOnError: false, rcVersion: 3 });
    });

    it('hands the custom bag over as a copy', async () => {
      fetchMock.mockResolvedValue(ok(configurationBody({ custom: { allowList: ['a', 'b'], level: 2 } })));
      const configuration = await start();

      const custom = configuration.getCustom()!;
      expect(custom).toEqual({ allowList: ['a', 'b'], level: 2 });
      (custom.allowList as string[]).push('c');

      expect(configuration.getCustom()).toEqual({ allowList: ['a', 'b'], level: 2 });
    });

    it('drops a custom bag that is not an object', async () => {
      fetchMock.mockResolvedValue(ok(configurationBody({ custom: ['a'] })));

      const configuration = await start();

      expect(configuration.getCustom()).toBeUndefined();
      expect(configuration.getSampling().rcVersion).toBe(3);
    });

    it.each([
      ['a body that is not JSON', '<html>captive portal</html>'],
      ['a JSON array', '[]'],
      ['an unstamped body', JSON.stringify({ version: 4, enabled: true })],
      ['a negative version', JSON.stringify(configurationBody({ version: -1 }))],
      ['a fractional version', JSON.stringify(configurationBody({ version: 1.5 }))],
      ['a version as a string', JSON.stringify(configurationBody({ version: '4' }))],
      ['no kill switch', JSON.stringify(configurationBody({ enabled: 'yes' }))],
      ['a rum bag that is not an object', JSON.stringify(configurationBody({ rum: [] }))],
    ])('refuses %s, keeps what it holds, and retries', async (_, body) => {
      mfs.readFile.mockResolvedValue(storedFile());
      fetchMock.mockResolvedValue(ok(body));

      const configuration = await start();

      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 0, sessionOnError: true, rcVersion: 2 });
      expect(writtenFiles()).toEqual([]);
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0] * 1.2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('refuses a schema it does not know without retrying, and says so', async () => {
      fetchMock.mockResolvedValue(ok(configurationBody({ schema_version: 2 })));

      const configuration = await start();

      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 100, sessionOnError: false });
      expect(displayWarn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS[1] * 2);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Asked again at the next session, answered the same way: not said again.
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(displayWarn).toHaveBeenCalledTimes(1);
    });

    it('ignores an older version arriving late', async () => {
      mfs.readFile.mockResolvedValue(storedFile({ version: 5 }));
      fetchMock.mockResolvedValue(ok(configurationBody({ version: 4, rum: { sessionSampleRate: 100 } })));

      const configuration = await start();

      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 0, sessionOnError: true, rcVersion: 5 });
      expect(writtenFiles()).toEqual([]);
    });
  });

  describe('cache on disk', () => {
    it('writes the configuration with its ETag, the SDK version and who it was for', async () => {
      fetchMock.mockResolvedValue(ok(configurationBody({ custom: { flag: 1 } })));

      await start();

      expect(writtenFiles()).toEqual([
        {
          format: 1,
          sdkVersion: 'test',
          identity: JSON.stringify(['http://proxy.test', 'test-app-id', 'prod', '1.2.3']),
          version: 3,
          values: { sessionSampleRate: 25, sessionOnError: true },
          custom: { flag: 1 },
          etag: '"tag-3"',
        },
      ]);
      expect(renameSync).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), FILE_PATH);
    });

    it('applies what the previous launch kept before the network answers', async () => {
      mfs.readFile.mockResolvedValue(storedFile());
      fetchMock.mockReturnValue(new Promise(() => undefined));

      const configuration = await start();

      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 0, sessionOnError: true, rcVersion: 2 });
      expect(configuration.getCustom()).toEqual({ flag: 'cached' });
    });

    it.each([
      ['another env', { identity: JSON.stringify(['http://proxy.test', 'test-app-id', 'staging', '1.2.3']) }],
      ['another app version', { identity: JSON.stringify(['http://proxy.test', 'test-app-id', 'prod', '1.2.2']) }],
      ['another application', { identity: JSON.stringify(['http://proxy.test', 'other-app', 'prod', '1.2.3']) }],
      ['another file format', { format: 2 }],
      ['a rate out of range', { values: { sessionSampleRate: 200 } }],
      ['a switch that is not a boolean', { values: { sessionOnError: 'true' } }],
      ['no version', { version: undefined }],
    ])('ignores a file written for %s, and asks without a version or an ETag', async (_, overrides) => {
      mfs.readFile.mockResolvedValue(storedFile(overrides));
      fetchMock.mockReturnValue(new Promise(() => undefined));

      const configuration = await start();

      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 100, sessionOnError: false });
      expect(configuration.getCustom()).toBeUndefined();
      expect(requestedUrl().searchParams.has('applied_version')).toBe(false);
      expect(requestHeaders()).toEqual({});
    });

    it('ignores a file that is not JSON', async () => {
      mfs.readFile.mockResolvedValue('{not json');
      fetchMock.mockReturnValue(new Promise(() => undefined));

      const configuration = await start();

      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 100, sessionOnError: false });
    });

    describe('304', () => {
      it('keeps what it holds, and writes nothing', async () => {
        mfs.readFile.mockResolvedValue(storedFile());
        fetchMock.mockResolvedValue(new Response(null, { status: 304 }));

        const configuration = await start();

        expect(configuration.getSampling()).toEqual({ sessionSampleRate: 0, sessionOnError: true, rcVersion: 2 });
        expect(writtenFiles()).toEqual([]);
        await vi.advanceTimersByTimeAsync(RETRY_DELAYS[1] * 2);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it('retries when it holds nothing a 304 could refer to', async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 304 }));

        await start();
        await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0] * 1.2);

        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
    });

    describe('after an SDK upgrade', () => {
      it('keeps the values another SDK version wrote, but does not send its ETag', async () => {
        mfs.readFile.mockResolvedValue(storedFile({ sdkVersion: 'older' }));
        fetchMock.mockReturnValue(new Promise(() => undefined));

        const configuration = await start();

        expect(configuration.getSampling()).toEqual({ sessionSampleRate: 0, sessionOnError: true, rcVersion: 2 });
        expect(requestedUrl().searchParams.get('applied_version')).toBe('2');
        expect(requestHeaders()).toEqual({});
      });

      it('replaces them with the full answer, read by this version, and rewrites the file as its own', async () => {
        // The older SDK did not read the switch, so its file has none.
        mfs.readFile.mockResolvedValue(storedFile({ sdkVersion: 'older', values: { sessionSampleRate: 0 } }));
        fetchMock.mockResolvedValue(
          ok(configurationBody({ version: 2, rum: { sessionSampleRate: 0, sessionOnError: true } }))
        );

        const configuration = await start();

        expect(configuration.getSampling()).toEqual({ sessionSampleRate: 0, sessionOnError: true, rcVersion: 2 });
        expect(writtenFiles()).toEqual([expect.objectContaining({ sdkVersion: 'test', etag: '"tag-3"' })]);
        // Its own ETag from now on.
        eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
        await vi.advanceTimersByTimeAsync(0);
        expect(requestHeaders(1)).toEqual({ 'If-None-Match': '"tag-3"' });
      });
    });
  });

  describe('offline and failures', () => {
    it('keeps the init values when the network is down, retries twice, then waits for the next session', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      const configuration = await start();
      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 100, sessionOnError: false });

      await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0] - 1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS[1]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(10 * RETRY_DELAYS[1]);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('spreads the retries by ±20%', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      // Drawn as each retry is scheduled: the lowest spread for the first, the highest for the second.
      const random = vi.spyOn(Math, 'random').mockReturnValue(0);
      await start();
      random.mockReturnValue(0.999);

      await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0] * 0.8);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(RETRY_DELAYS[1] * 1.19);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS[1] * 0.01);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('keeps what it holds offline', async () => {
      mfs.readFile.mockResolvedValue(storedFile());
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      const configuration = await start();

      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 0, sessionOnError: true, rcVersion: 2 });
      expect(writtenFiles()).toEqual([]);
    });

    it('gives up on a request that does not answer in time, and retries', async () => {
      fetchMock.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          })
      );
      await start();

      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT);
      expect((fetchMock.mock.calls[0][1]!.signal as AbortSignal).aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0] * 1.2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([500, 503, 429])('retries on %s', async (status) => {
      fetchMock.mockResolvedValue(new Response('', { status }));

      await start();
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0] * 1.2);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([401, 403, 404])('does not retry on %s', async (status) => {
      fetchMock.mockResolvedValue(new Response('', { status }));

      await start();
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS[1] * 2);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('stops: cancels the request in flight and any retry, and applies nothing', async () => {
      let answer!: (response: Response) => void;
      fetchMock.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      const configuration = await start();

      configuration.stop();
      answer(ok(configurationBody()));
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS[1] * 2);

      expect((fetchMock.mock.calls[0][1]!.signal as AbortSignal).aborted).toBe(true);
      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 100, sessionOnError: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('activation', () => {
    it('tells the session owner about a new version that applies at once, once it is in force', async () => {
      fetchMock.mockResolvedValue(ok(configurationBody({ activation: 'immediate' })));
      let samplingWhenTold: unknown;
      onImmediateChange.mockImplementation(() => (samplingWhenTold = remote!.getSampling()));

      await start();

      expect(onImmediateChange).toHaveBeenCalledTimes(1);
      expect(samplingWhenTold).toEqual({ sessionSampleRate: 25, sessionOnError: true, rcVersion: 3 });
    });

    it('does not tell it about a change for the next session', async () => {
      fetchMock.mockResolvedValue(ok(configurationBody({ activation: 'next_session' })));

      const configuration = await start();

      expect(configuration.getSampling().sessionSampleRate).toBe(25);
      expect(onImmediateChange).not.toHaveBeenCalled();
    });

    it('reads an absent or unknown activation as the next session', async () => {
      fetchMock.mockResolvedValue(ok(configurationBody({ activation: undefined })));

      await start();

      expect(onImmediateChange).not.toHaveBeenCalled();
    });

    it('does not tell it again about the version it already holds', async () => {
      mfs.readFile.mockResolvedValue(storedFile({ version: 3, sdkVersion: 'older' }));
      fetchMock.mockResolvedValue(ok(configurationBody({ activation: 'immediate' })));

      await start();

      expect(onImmediateChange).not.toHaveBeenCalled();
    });

    it('tells it about a higher version', async () => {
      mfs.readFile.mockResolvedValue(storedFile({ version: 2 }));
      fetchMock.mockResolvedValue(ok(configurationBody({ activation: 'immediate' })));

      await start();

      expect(onImmediateChange).toHaveBeenCalledTimes(1);
    });
  });
});

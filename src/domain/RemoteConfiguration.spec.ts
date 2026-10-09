import { mockFs, createTestConfiguration } from '../mocks.specUtil';
vi.mock('node:fs/promises');
const { writeFileSync, renameSync, unlinkSync, readdirSync } = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(() => []),
}));
vi.mock('node:fs', () => ({ writeFileSync, renameSync, unlinkSync, readdirSync }));
const { appListeners } = vi.hoisted(() => ({ appListeners: new Map<string, () => void>() }));
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data'),
    on: vi.fn((event: string, listener: () => void) => appListeners.set(event, listener)),
    removeListener: vi.fn((event: string, listener: () => void) => {
      if (appListeners.get(event) === listener) {
        appListeners.delete(event);
      }
    }),
  },
}));
vi.mock('../tools/display', () => ({ displayError: vi.fn(), displayWarn: vi.fn() }));

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { Configuration } from '../config';
import { EventKind, EventManager, LifecycleKind } from '../event';
import { displayWarn } from '../tools/display';
import {
  DEFAULT_TTL,
  MIN_TTL,
  REMOTE_CONFIGURATION_FILE_NAME,
  REQUEST_TIMEOUT,
  RETRY_DELAYS,
  RemoteConfiguration,
} from './RemoteConfiguration';
import { createFormatHooks } from '../assembly';
import { SessionManager, TrackingType, type Session } from './session';

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
    session = undefined as unknown as Partial<Session>;
    appListeners.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    mfs.reset();
  });

  /** The session owner: a session drawn under the configuration in force, unless a test says otherwise. */
  let session: Partial<Session>;

  async function start(): Promise<RemoteConfiguration> {
    remote = await RemoteConfiguration.init(config);
    session ??= { rcVersion: remote.getSampling().rcVersion };
    remote.start(eventManager, { getSession: () => session as Session, applySamplingChange: onImmediateChange });
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
      fetchMock.mockImplementation(() => Promise.resolve(ok(configurationBody())));

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
      fetchMock.mockImplementation(() => Promise.resolve(ok(configurationBody())));

      await start();

      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(`${url.origin}${url.pathname}`).toBe('https://intake.example.test/api/v2/rum/config');
      expect([...url.searchParams.keys()]).toEqual(['client_token', 'sdk', 'sdk_version']);
    });

    it('reports the version it holds, and sends its ETag', async () => {
      mfs.readFile.mockResolvedValue(storedFile());
      fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 304 })));

      await start();

      expect(requestedUrl().searchParams.get('applied_version')).toBe('2');
      expect(requestHeaders()).toEqual({ 'If-None-Match': '"tag-2"' });
    });

    it('does not block: start returns while the request is still pending', async () => {
      fetchMock.mockReturnValue(new Promise(() => undefined));
      remote = await RemoteConfiguration.init(config);

      remote.start(eventManager, { getSession: () => ({}) as Session, applySamplingChange: onImmediateChange });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(remote.getSampling()).toEqual({ sessionSampleRate: 100, sessionOnError: false });
    });

    it('asks again whenever a new session starts', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(ok(configurationBody())));
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
      fetchMock.mockImplementation(() => Promise.resolve(ok(configurationBody())));

      const configuration = await start();

      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 25, sessionOnError: true, rcVersion: 3 });
    });

    it('keeps the init value of a knob the console did not set', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(ok(configurationBody({ rum: { sessionOnError: true } }))));

      const configuration = await start();

      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 100, sessionOnError: true, rcVersion: 3 });
    });

    it.each([
      ['absent', undefined],
      ['null', null],
    ])('reads a %s rum bag as empty', async (_, rum) => {
      fetchMock.mockImplementation(() => Promise.resolve(ok(configurationBody({ rum }))));

      const configuration = await start();

      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 100, sessionOnError: false, rcVersion: 3 });
    });

    it('drops the values and custom while the kill switch is off, and keeps the version', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(ok(configurationBody({ enabled: false, custom: { flag: true } })))
      );

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
      fetchMock.mockImplementation(() => Promise.resolve(ok(configurationBody({ rum }))));

      const configuration = await start();

      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 100, sessionOnError: false, rcVersion: 3 });
    });

    it('hands the custom bag over as a copy', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(ok(configurationBody({ custom: { allowList: ['a', 'b'], level: 2 } })))
      );
      const configuration = await start();

      const custom = configuration.getCustom()!;
      expect(custom).toEqual({ allowList: ['a', 'b'], level: 2 });
      (custom.allowList as string[]).push('c');

      expect(configuration.getCustom()).toEqual({ allowList: ['a', 'b'], level: 2 });
    });

    it('hands over keys like __proto__ as plain keys, without touching any prototype, from the network', async () => {
      const raw =
        '{"schema_version":1,"version":3,"enabled":true,"activation":"next_session","rum":{},' +
        '"custom":{"__proto__":{"polluted":true},"nested":{"list":[{"__proto__":{"polluted":true}}],"constructor":{"prototype":{"polluted":true}}}}}';
      fetchMock.mockResolvedValueOnce(ok(raw));
      const configuration = await start();

      const custom = configuration.getCustom()!;

      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.getPrototypeOf(custom)).toBe(Object.prototype);
      expect(Object.keys(custom)).toEqual(['__proto__', 'nested']);
      expect(Object.getOwnPropertyDescriptor(custom, '__proto__')?.value).toEqual({ polluted: true });
      const nested = custom.nested as { list: object[] };
      expect(Object.keys(nested.list[0])).toEqual(['__proto__']);
    });

    it('hands over keys like __proto__ as plain keys, without touching any prototype, from disk', async () => {
      mfs.readFile.mockResolvedValue(
        storedFile().replace(
          '"custom":{"flag":"cached"}',
          '"custom":{"__proto__":{"polluted":true},"a":{"__proto__":{"polluted":true}}}'
        )
      );
      fetchMock.mockReturnValue(new Promise(() => undefined));
      const configuration = await start();

      const custom = configuration.getCustom()!;

      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.keys(custom)).toEqual(['__proto__', 'a']);
      expect(Object.keys(custom.a as object)).toEqual(['__proto__']);
    });

    it('drops a custom bag that is not an object', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(ok(configurationBody({ custom: ['a'] }))));

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
      fetchMock.mockImplementation(() => Promise.resolve(ok(body)));

      const configuration = await start();

      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 0, sessionOnError: true, rcVersion: 2 });
      expect(writtenFiles()).toEqual([]);
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0] * 1.2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('refuses a schema it does not know without retrying, and says so', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(ok(configurationBody({ schema_version: 2 }))));

      const configuration = await start();

      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 100, sessionOnError: false });
      expect(displayWarn).toHaveBeenCalledTimes(1);
      expect(displayWarn).toHaveBeenCalledWith(expect.stringContaining('unsupported schema_version 2 (SDK test)'));
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
      fetchMock.mockImplementation(() =>
        Promise.resolve(ok(configurationBody({ version: 4, rum: { sessionSampleRate: 100 } })))
      );

      const configuration = await start();

      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 0, sessionOnError: true, rcVersion: 5 });
      expect(writtenFiles()).toEqual([]);
    });
  });

  describe('cache on disk', () => {
    it('writes the configuration with its ETag, the SDK version and who it was for', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(ok(configurationBody({ custom: { flag: 1 } }))));

      await start();

      expect(writtenFiles()).toEqual([
        {
          format: 1,
          sdkVersion: 'test',
          identity: JSON.stringify(['http://proxy.test', 'test-app-id', 'prod', '1.2.3']),
          version: 3,
          values: { sessionSampleRate: 25, sessionOnError: true },
          custom: { flag: 1 },
          activation: 'next_session',
          ttl: 600,
          refreshOnForeground: false,
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

    it('reads a kept version 0 as no configuration, whatever it holds', async () => {
      mfs.readFile.mockResolvedValue(storedFile({ version: 0, values: { sessionSampleRate: 0 } }));
      fetchMock.mockReturnValue(new Promise(() => undefined));

      const configuration = await start();

      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 100, sessionOnError: false });
      expect(configuration.getCustom()).toBeUndefined();
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
        fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 304 })));

        const configuration = await start();

        expect(configuration.getSampling()).toEqual({ sessionSampleRate: 0, sessionOnError: true, rcVersion: 2 });
        expect(writtenFiles()).toEqual([]);
        await vi.advanceTimersByTimeAsync(RETRY_DELAYS[1] * 2);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it('retries when it holds nothing a 304 could refer to', async () => {
        fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 304 })));

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
        fetchMock.mockImplementation(() =>
          Promise.resolve(ok(configurationBody({ version: 2, rum: { sessionSampleRate: 0, sessionOnError: true } })))
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
      await vi.advanceTimersByTimeAsync(DEFAULT_TTL - 1000);
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
      fetchMock.mockImplementation(() => Promise.resolve(new Response('', { status })));

      await start();
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0] * 1.2);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([401, 403, 404])('does not retry on %s', async (status) => {
      fetchMock.mockImplementation(() => Promise.resolve(new Response('', { status })));

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
      fetchMock.mockImplementation(() => Promise.resolve(ok(configurationBody({ activation: 'immediate' }))));
      let samplingWhenTold: unknown;
      onImmediateChange.mockImplementation(() => (samplingWhenTold = remote!.getSampling()));

      await start();

      expect(onImmediateChange).toHaveBeenCalledTimes(1);
      expect(samplingWhenTold).toEqual({ sessionSampleRate: 25, sessionOnError: true, rcVersion: 3 });
    });

    it('does not tell it about a change for the next session', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(ok(configurationBody({ activation: 'next_session' }))));

      const configuration = await start();

      expect(configuration.getSampling().sessionSampleRate).toBe(25);
      expect(onImmediateChange).not.toHaveBeenCalled();
    });

    it('reads an absent or unknown activation as the next session', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(ok(configurationBody({ activation: undefined }))));

      await start();

      expect(onImmediateChange).not.toHaveBeenCalled();
    });

    it('does not tell it again about the version it already holds, unchanged', async () => {
      mfs.readFile.mockResolvedValue(
        storedFile({ version: 3, sdkVersion: 'older', values: { sessionSampleRate: 25, sessionOnError: true } })
      );
      fetchMock.mockImplementation(() => Promise.resolve(ok(configurationBody({ activation: 'immediate' }))));

      await start();

      expect(onImmediateChange).not.toHaveBeenCalled();
    });

    it('tells it about the version it already holds when this SDK reads different values in it', async () => {
      // An older SDK did not read the switch: same version, values this SDK reads differently.
      mfs.readFile.mockResolvedValue(
        storedFile({ version: 3, sdkVersion: 'older', values: { sessionSampleRate: 25 } })
      );
      fetchMock.mockImplementation(() => Promise.resolve(ok(configurationBody({ activation: 'immediate' }))));
      let samplingWhenTold: unknown;
      onImmediateChange.mockImplementation(() => (samplingWhenTold = remote!.getSampling()));

      await start();

      expect(onImmediateChange).toHaveBeenCalledTimes(1);
      expect(samplingWhenTold).toEqual({ sessionSampleRate: 25, sessionOnError: true, rcVersion: 3 });
    });

    it('does not tell it about the version it already holds with different values for the next session', async () => {
      mfs.readFile.mockResolvedValue(
        storedFile({ version: 3, sdkVersion: 'older', values: { sessionSampleRate: 25 } })
      );
      fetchMock.mockImplementation(() => Promise.resolve(ok(configurationBody({ activation: 'next_session' }))));

      await start();

      expect(onImmediateChange).not.toHaveBeenCalled();
    });

    it('tells it about a higher version', async () => {
      mfs.readFile.mockResolvedValue(storedFile({ version: 2 }));
      fetchMock.mockImplementation(() => Promise.resolve(ok(configurationBody({ activation: 'immediate' }))));

      await start();

      expect(onImmediateChange).toHaveBeenCalledTimes(1);
    });
  });

  describe('version 0: an application with nothing published', () => {
    it('applies nothing a version 0 answer carries: it is no configuration', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          ok(configurationBody({ version: 0, enabled: true, rum: { sessionSampleRate: 0 }, custom: { a: 1 } }))
        )
      );

      const configuration = await start();

      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 100, sessionOnError: false });
      expect(configuration.getCustom()).toBeUndefined();
    });

    it('reports no version for what it draws, and asks again without one', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(ok(configurationBody({ version: 0, enabled: false, rum: {} })))
      );

      const configuration = await start();
      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 100, sessionOnError: false });

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
      await vi.advanceTimersByTimeAsync(0);
      expect(requestedUrl(1).searchParams.has('applied_version')).toBe(false);
      // The ETag still saves the body.
      expect(requestHeaders(1)).toEqual({ 'If-None-Match': '"tag-3"' });
    });
  });

  describe('refresh when the user comes back (refresh_on_foreground)', () => {
    function focus() {
      appListeners.get('browser-window-focus')?.();
    }

    it('asks nothing without a trigger, however long the application runs', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(ok(configurationBody({ ttl: 60, refresh_on_foreground: true })))
      );
      await start();

      await vi.advanceTimersByTimeAsync(DEFAULT_TTL * 10);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('asks again, conditionally, on focus once what it holds is ttl old, when the operator allows it', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(ok(configurationBody({ ttl: 120, refresh_on_foreground: true })))
      );
      await start();
      await vi.advanceTimersByTimeAsync(120_000);

      focus();
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(requestHeaders(1)).toEqual({ 'If-None-Match': '"tag-3"' });
      expect(requestedUrl(1).searchParams.get('applied_version')).toBe('3');
    });

    it('asks nothing on focus when the operator does not allow it', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(ok(configurationBody({ ttl: 120, refresh_on_foreground: false })))
      );
      await start();
      await vi.advanceTimersByTimeAsync(DEFAULT_TTL * 2);

      focus();
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('asks nothing on focus before the ttl has passed', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(ok(configurationBody({ ttl: 120, refresh_on_foreground: true })))
      );
      await start();
      await vi.advanceTimersByTimeAsync(120_000 - 1);

      focus();
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('measures the ttl from the last request that ended, including a new session one', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(ok(configurationBody({ ttl: 120, refresh_on_foreground: true })))
      );
      await start();
      await vi.advanceTimersByTimeAsync(100_000);
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
      await vi.advanceTimersByTimeAsync(100_000);

      focus();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(20_000);
      focus();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it.each([
      ['below the floor', 5, MIN_TTL],
      ['missing', undefined, DEFAULT_TTL],
      ['not a number', '120', DEFAULT_TTL],
      ['zero', 0, DEFAULT_TTL],
    ])('uses a sane ttl when the one given is %s', async (_, ttl, expected) => {
      fetchMock.mockImplementation(() => Promise.resolve(ok(configurationBody({ ttl, refresh_on_foreground: true }))));
      await start();

      await vi.advanceTimersByTimeAsync(expected - 1);
      focus();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      focus();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('never has two requests in flight', async () => {
      fetchMock.mockResolvedValueOnce(ok(configurationBody({ ttl: 60, refresh_on_foreground: true })));
      fetchMock.mockReturnValue(new Promise(() => undefined));
      await start();
      await vi.advanceTimersByTimeAsync(60_000);

      focus();
      focus();
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('neither cancels a pending retry nor re-arms the backoff, so focus cannot outpace it', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      fetchMock.mockResolvedValueOnce(ok(configurationBody({ ttl: 60, refresh_on_foreground: true })));
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      await start();
      await vi.advanceTimersByTimeAsync(60_000);

      // A refresh that fails: a retry is now pending 5 s out.
      focus();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      focus();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // The two retries, then silence however often focus comes back within the ttl.
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0] + RETRY_DELAYS[1]);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      for (let i = 0; i < 5; i += 1) {
        await vi.advanceTimersByTimeAsync(10_000);
        focus();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(4);

      // Once the ttl has passed, one more ask, and no fresh round of retries behind it.
      await vi.advanceTimersByTimeAsync(10_000);
      focus();
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0] + RETRY_DELAYS[1]);
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it('delivers an immediate stop to the running session', async () => {
      fetchMock.mockResolvedValueOnce(ok(configurationBody({ ttl: 60, refresh_on_foreground: true })));
      await start();
      fetchMock.mockResolvedValueOnce(
        ok(configurationBody({ version: 4, activation: 'immediate', rum: { sessionSampleRate: 0 } }), '"tag-4"')
      );
      await vi.advanceTimersByTimeAsync(60_000);

      focus();
      await vi.advanceTimersByTimeAsync(0);

      expect(onImmediateChange).toHaveBeenCalledTimes(1);
      expect(remote!.getSampling()).toEqual({ sessionSampleRate: 0, sessionOnError: false, rcVersion: 4 });
    });

    it('keeps the permission and the ttl across a restart, where only a 304 answers', async () => {
      mfs.readFile.mockResolvedValue(storedFile({ ttl: 120, refreshOnForeground: true }));
      fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 304 })));
      await start();

      await vi.advanceTimersByTimeAsync(120_000 - 1);
      focus();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      focus();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('reads a file kept without them as no permission', async () => {
      mfs.readFile.mockResolvedValue(storedFile());
      fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 304 })));
      await start();
      await vi.advanceTimersByTimeAsync(DEFAULT_TTL * 2);

      focus();
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['a ttl that is not a positive whole number', { ttl: -5 }],
      ['a permission that is not a boolean', { refreshOnForeground: 'yes' }],
    ])('ignores a file with %s', async (_, overrides) => {
      mfs.readFile.mockResolvedValue(storedFile(overrides));
      fetchMock.mockReturnValue(new Promise(() => undefined));

      const configuration = await start();

      expect(configuration.getSampling()).toEqual({ sessionSampleRate: 100, sessionOnError: false });
    });

    it('stops listening once stopped', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(ok(configurationBody({ ttl: 60, refresh_on_foreground: true })))
      );
      const configuration = await start();
      expect(appListeners.has('browser-window-focus')).toBe(true);

      configuration.stop();

      expect(appListeners.has('browser-window-focus')).toBe(false);
      expect(appListeners.has('quit')).toBe(false);
    });
  });

  describe('when the application exits', () => {
    function mayExit() {
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.APP_MAY_EXIT });
    }

    function syncWrites(): Record<string, unknown>[] {
      return writeFileSync.mock.calls
        .filter(([filePath]) => (filePath as string).startsWith(`${FILE_PATH}.`))
        .map(([, content]) => JSON.parse(content as string) as Record<string, unknown>);
    }

    it('writes an accepted configuration whose write has not landed before returning, and the next launch draws with it offline', async () => {
      mfs.readFile.mockResolvedValue(storedFile({ version: 8, values: { sessionSampleRate: 100 } }));
      mfs.writeFile.mockReturnValue(new Promise(() => undefined));
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          ok(configurationBody({ version: 9, activation: 'immediate', rum: { sessionSampleRate: 0 } }), '"tag-9"')
        )
      );
      await start();

      mayExit();

      expect(syncWrites()).toEqual([expect.objectContaining({ version: 9, activation: 'immediate', etag: '"tag-9"' })]);
      expect(renameSync).toHaveBeenLastCalledWith(expect.stringMatching(/\.tmp$/), FILE_PATH);

      // Next launch, offline: it reads what the exit wrote.
      remote!.stop();
      mfs.readFile.mockResolvedValue(writeFileSync.mock.calls[writeFileSync.mock.calls.length - 1][1] as string);
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      remote = await RemoteConfiguration.init(config);
      expect(remote.getSampling()).toEqual({ sessionSampleRate: 0, sessionOnError: false, rcVersion: 9 });
    });

    it('writes an accepted configuration whose write has not landed when the application quits, even past every exit notice', async () => {
      // `app.exit()` skips the quit events but reaches `quit`; a fetch can also land after `will-quit`.
      mfs.writeFile.mockReturnValue(new Promise(() => undefined));
      fetchMock.mockResolvedValueOnce(
        ok(configurationBody({ version: 9, activation: 'immediate', rum: { sessionSampleRate: 0 } }), '"tag-9"')
      );
      await start();

      appListeners.get('quit')!();

      expect(syncWrites()).toEqual([expect.objectContaining({ version: 9 })]);
      // Nothing left to write: the notice the process exit sends finds nothing more.
      mayExit();
      expect(syncWrites()).toHaveLength(1);
    });

    it('still writes at exit a configuration whose asynchronous write failed', async () => {
      mfs.writeFile.mockRejectedValue(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
      fetchMock.mockResolvedValueOnce(ok(configurationBody({ version: 9 }), '"tag-9"'));
      await start();

      mayExit();

      expect(syncWrites()).toEqual([expect.objectContaining({ version: 9 })]);
    });

    it('keeps it pending when the write at exit fails too, and tries again at the next notice', async () => {
      mfs.writeFile.mockReturnValue(new Promise(() => undefined));
      fetchMock.mockResolvedValueOnce(ok(configurationBody({ version: 9 }), '"tag-9"'));
      await start();
      writeFileSync.mockImplementationOnce(() => {
        throw new Error('EACCES');
      });

      mayExit();
      mayExit();

      expect(writeFileSync).toHaveBeenCalledTimes(2);
    });

    it('writes nothing when what it holds has landed already', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(ok(configurationBody())));
      await start();

      mayExit();

      expect(syncWrites()).toEqual([]);
    });

    it('writes nothing when it holds nothing new since the launch', async () => {
      mfs.readFile.mockResolvedValue(storedFile());
      fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 304 })));
      await start();

      mayExit();

      expect(syncWrites()).toEqual([]);
    });

    it('stops when the application quits: the request in flight is aborted and nothing is asked again', async () => {
      fetchMock.mockReturnValue(new Promise(() => undefined));
      await start();

      appListeners.get('quit')!();
      await vi.advanceTimersByTimeAsync(DEFAULT_TTL * 2);

      expect((fetchMock.mock.calls[0][1]!.signal as AbortSignal).aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('a session resumed from before an immediate configuration the previous launch kept', () => {
    const SESSION_PATH = '/mock/user/data/_dd_s';
    let manager: SessionManager | undefined;

    afterEach(() => {
      manager?.stop();
      manager = undefined;
    });

    /** What a launch that ended before its session file was deleted leaves behind. */
    async function restart(resumed: Record<string, unknown>, kept: Record<string, unknown>): Promise<SessionManager> {
      const now = Date.now();
      mfs.access.mockResolvedValue(undefined);
      mfs.readFile.mockImplementation((filePath: string) => {
        if (filePath === SESSION_PATH) {
          return Promise.resolve(JSON.stringify({ id: 'resumed', created: now, lastActivity: now, ...resumed }));
        }
        if (filePath === FILE_PATH) {
          return Promise.resolve(storedFile(kept));
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      remote = await RemoteConfiguration.init(config);
      const configuration = remote;
      manager = await SessionManager.start(eventManager, createFormatHooks(), () => configuration.getSampling());
      expect(manager.getSession()).toMatchObject({ id: 'resumed', status: 'active' });
      remote.applyKept(manager);
      return manager;
    }

    const STOP = { version: 9, values: { sessionSampleRate: 0 }, activation: 'immediate' };

    it.each([
      { title: 'drawn under an older version', resumed: { rcVersion: 8 } },
      { title: 'drawn under no version at all', resumed: {} },
    ])('ends a collected session $title, before anything is fetched', async ({ resumed }) => {
      const sessions = await restart({ trackingType: TrackingType.TRACKED, sampleRate: 100, ...resumed }, STOP);

      expect(sessions.getSession().status).toBe('expired');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('leaves it when the kept configuration applies to the next session', async () => {
      const sessions = await restart(
        { trackingType: TrackingType.TRACKED, sampleRate: 100, rcVersion: 8 },
        { ...STOP, activation: 'next_session' }
      );

      expect(sessions.getSession().status).toBe('active');
    });

    it('leaves it when it was drawn under that very version, as this SDK reads it', async () => {
      const sessions = await restart({ trackingType: TrackingType.NOT_TRACKED, sampleRate: 0, rcVersion: 9 }, STOP);

      expect(sessions.getSession().status).toBe('active');
    });

    it('ends it when it was drawn under the same version read differently, before an upgrade', async () => {
      // Drawn at rate 0 by an SDK that did not read the switch; this one reads it on.
      const sessions = await restart(
        { trackingType: TrackingType.NOT_TRACKED, sampleRate: 0, rcVersion: 9 },
        { ...STOP, values: { sessionSampleRate: 0, sessionOnError: true } }
      );

      expect(sessions.getSession().status).toBe('expired');
    });

    it('leaves a session drawn under a newer version than what was kept: the kept one is the older', async () => {
      // The newer configuration's write was lost; the session drawn under it was saved.
      const sessions = await restart({ trackingType: TrackingType.TRACKED, sampleRate: 100, rcVersion: 10 }, STOP);

      expect(sessions.getSession().status).toBe('active');
    });

    it('leaves a same-version session alone when what was kept applies to the next session', async () => {
      const sessions = await restart(
        { trackingType: TrackingType.NOT_TRACKED, sampleRate: 0, rcVersion: 9 },
        { ...STOP, values: { sessionSampleRate: 0, sessionOnError: true }, activation: 'next_session' }
      );

      expect(sessions.getSession().status).toBe('active');
    });

    it('leaves an on-error session while the switch stays on', async () => {
      const sessions = await restart(
        { trackingType: TrackingType.TRACKED_ON_ERROR, sampleRate: 0, rcVersion: 8 },
        { ...STOP, values: { sessionSampleRate: 0, sessionOnError: true } }
      );

      expect(sessions.getSession().status).toBe('active');
    });

    it('ends an on-error session when the kept configuration turned the switch off', async () => {
      const sessions = await restart(
        { trackingType: TrackingType.TRACKED_ON_ERROR, sampleRate: 0, rcVersion: 8 },
        { ...STOP, values: { sessionSampleRate: 0, sessionOnError: false } }
      );

      expect(sessions.getSession().status).toBe('expired');
    });
  });
});

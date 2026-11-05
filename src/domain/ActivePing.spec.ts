import { mockFs, createTestConfiguration } from '../mocks.specUtil';
vi.mock('node:fs/promises');
const { writeFileSync, renameSync, unlinkSync, readdirSync } = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(() => []),
}));
vi.mock('node:fs', () => ({ writeFileSync, renameSync, unlinkSync, readdirSync }));
const { appListeners, focusedWindow } = vi.hoisted(() => ({
  appListeners: new Map<string, () => void>(),
  focusedWindow: { current: null as object | null },
}));
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
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => focusedWindow.current),
  },
}));
vi.mock('../tools/display', () => ({ displayError: vi.fn(), displayWarn: vi.fn() }));

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { ONE_HOUR, ONE_SECOND } from '@flashcatcloud/browser-core';
import type { Configuration } from '../config';
import { EventKind, EventManager, LifecycleKind } from '../event';
import { ACTIVE_PING_FILE_NAME, ActivePing } from './ActivePing';
import type { User } from './UserContext';

const mfs = mockFs();
const FILE_PATH = `/mock/user/data/${ACTIVE_PING_FILE_NAME}`;
const ANONYMOUS_ID = '123e4567-e89b-12d3-a456-426614174000';

function accepted() {
  return new Response(null, { status: 202 });
}

function refused() {
  return new Response(null, { status: 400 });
}

function localDay(time: number) {
  const date = new Date(time);
  const month = `0${date.getMonth() + 1}`.slice(-2);
  const day = `0${date.getDate()}`.slice(-2);
  return `${date.getFullYear()}-${month}-${day}`;
}

/** What an earlier launch would have kept for one undelivered report. */
function storedFile(pendingFirstAttemptAt: number) {
  return JSON.stringify({
    format: 2,
    day: localDay(pendingFirstAttemptAt),
    sent: [],
    pending: [
      {
        combination: `${encodeURIComponent(ANONYMOUS_ID)}||`,
        report: {
          service: 'test-service',
          build_version: '',
          sdk_version: '0.0.0-test',
          usr: { anonymous_id: ANONYMOUS_ID },
          os: { name: 'Earlier OS', version: '1' },
          device: { type: 'Desktop', model: '', brand: '' },
        },
        firstAttemptAt: pendingFirstAttemptAt,
      },
    ],
  });
}

/** What an earlier day would have kept for one undelivered user report. */
function storedUserFile(pendingFirstAttemptAt: number) {
  return JSON.stringify({
    format: 2,
    day: localDay(pendingFirstAttemptAt),
    sent: [],
    pending: [
      {
        combination: `${encodeURIComponent(ANONYMOUS_ID)}|user-42|1.2.3`,
        report: {
          service: 'test-service',
          build_version: '',
          sdk_version: '0.0.0-test',
          usr: { anonymous_id: ANONYMOUS_ID, id: 'user-42' },
          os: { name: 'Earlier OS', version: '1' },
          device: { type: 'Desktop', model: '', brand: '' },
        },
        firstAttemptAt: pendingFirstAttemptAt,
      },
    ],
  });
}

describe('ActivePing', () => {
  let fetchMock: Mock<typeof fetch>;
  let eventManager: EventManager;
  let config: Configuration;
  let activePing: ActivePing | undefined;
  let currentUser: User | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue(accepted());
    vi.stubGlobal('fetch', fetchMock);
    mfs.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mfs.writeFile.mockResolvedValue(undefined);
    mfs.stat.mockResolvedValue({ size: 1024 });
    eventManager = new EventManager();
    currentUser = undefined;
    focusedWindow.current = null;
    config = createTestConfiguration({
      proxy: 'http://proxy.test',
      clientToken: 'pub-token',
      applicationId: 'test-app-id',
      env: 'prod',
      version: '1.2.3',
    });
  });

  afterEach(() => {
    activePing?.stop();
    activePing = undefined;
    appListeners.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    mfs.reset();
  });

  async function start(): Promise<ActivePing> {
    activePing = await ActivePing.init(config, ANONYMOUS_ID, () => currentUser);
    activePing.start(eventManager);
    await vi.advanceTimersByTimeAsync(0);
    return activePing;
  }

  function focusWindow() {
    appListeners.get('browser-window-focus')!();
  }

  function payloadOf(call = 0): Record<string, unknown> {
    return JSON.parse(fetchMock.mock.calls[call][1]?.body as string) as Record<string, unknown>;
  }

  function requestedUrl(call = 0): URL {
    const outer = new URL(fetchMock.mock.calls[call][0] as string);
    return new URL(outer.searchParams.get('ddforward')!, 'http://inner.test');
  }

  it('waits for the foreground, then reports the device once for the day', async () => {
    await start();
    expect(fetchMock).not.toHaveBeenCalled();

    focusWindow();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = requestedUrl();
    expect(url.pathname).toBe('/api/v2/rum/active');
    expect(url.searchParams.get('dd-api-key')).toBe('pub-token');
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>)['DD-API-KEY']).toBe('pub-token');
    const payload = payloadOf();
    expect(payload).toEqual(
      expect.objectContaining({
        service: 'test-service',
        env: 'prod',
        version: '1.2.3',
        build_version: '',
        usr: { anonymous_id: ANONYMOUS_ID },
        age_ms: 0,
      })
    );
    expect((payload.os as { name: string }).name).toEqual(expect.any(String));
    expect((payload.device as { type: string }).type).toBe('Desktop');

    focusWindow();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports at start when a window already has focus', async () => {
    focusedWindow.current = {};

    await start();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports again when a user logs in', async () => {
    await start();
    focusWindow();
    await vi.advanceTimersByTimeAsync(0);

    currentUser = { id: 'user-42' };
    eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.USER_CHANGED });
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(payloadOf(1)).toEqual(expect.objectContaining({ usr: { anonymous_id: ANONYMOUS_ID, id: 'user-42' } }));
  });

  it('keeps a login that starts and ends while an earlier report is in flight', async () => {
    let answer!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        })
    );
    await start();
    focusWindow();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The whole login happens while the anonymous report is still unanswered. Recording
    // the user only when the network replies would lose them for the day entirely.
    currentUser = { id: 'user-42' };
    eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.USER_CHANGED });
    currentUser = undefined;
    eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.USER_CHANGED });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    answer(accepted());
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(payloadOf(1)).toEqual(expect.objectContaining({ usr: { anonymous_id: ANONYMOUS_ID, id: 'user-42' } }));
  });

  it('reports the new day when a window stays in use across midnight', async () => {
    vi.setSystemTime(new Date('2026-11-02T23:59:00'));
    await start();
    focusWindow();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-11-03T00:01:00'));
    eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(payloadOf(1)).toEqual(expect.objectContaining({ usr: { anonymous_id: ANONYMOUS_ID } }));
  });

  it("records today's user activity behind yesterday's undelivered report for the same user", async () => {
    let answer!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        })
    );
    vi.setSystemTime(new Date('2026-11-03T00:01:00'));
    mfs.readFile.mockResolvedValue(storedUserFile(new Date('2026-11-02T23:59:00').getTime()));
    currentUser = { id: 'user-42' };
    focusedWindow.current = {};

    await start();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    currentUser = undefined;
    eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.USER_CHANGED });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    answer(accepted());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(payloadOf(1)).toEqual(expect.objectContaining({ usr: { anonymous_id: ANONYMOUS_ID, id: 'user-42' } }));
    expect(payloadOf(2)).toEqual(expect.objectContaining({ usr: { anonymous_id: ANONYMOUS_ID } }));
  });

  it('does not create a new-day report when an old request merely completes after midnight', async () => {
    let answer!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        })
    );
    vi.setSystemTime(new Date('2026-11-02T23:59:00'));
    focusedWindow.current = {};

    await start();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-11-03T00:01:00'));
    answer(accepted());
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not ask again on the same day after the intake refuses a report, but asks again the next day', async () => {
    vi.setSystemTime(new Date('2026-11-02T23:59:00'));
    fetchMock.mockResolvedValueOnce(refused());
    focusedWindow.current = {};

    await start();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The intake has answered about this report itself; re-asking on every focus or user
    // change for the rest of the day would get the same answer (the Browser SDK's rule).
    focusWindow();
    await vi.advanceTimersByTimeAsync(0);
    eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.USER_CHANGED });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-11-03T00:01:00'));
    eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the in-flight report when newer combinations overflow the queue', async () => {
    let answer!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        })
    );
    focusedWindow.current = {};

    await start();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Ten more combinations arrive while the first report is still unanswered; the queue
    // cap must not throw away the report that is already on the wire.
    for (let i = 1; i <= 10; i += 1) {
      currentUser = { id: `user-${i}` };
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.USER_CHANGED });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    answer(new Response(null, { status: 500 }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10 * ONE_SECOND);

    // The failed first report is retried before the queued users go out; the queue then
    // drains. One of the ten queued users is what the cap gives up instead of the original.
    expect(payloadOf(1)).toEqual(expect.objectContaining({ usr: { anonymous_id: ANONYMOUS_ID } }));
    expect(payloadOf(2)).toEqual(expect.objectContaining({ usr: { anonymous_id: ANONYMOUS_ID, id: 'user-1' } }));
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });

  it('retries a failed report under the same event id', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 })).mockResolvedValue(accepted());
    await start();
    focusWindow();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10 * ONE_SECOND);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(payloadOf(1).usr).toEqual(payloadOf(0).usr);
    expect(payloadOf(1).age_ms).toBeGreaterThan(0);
  });

  it('delivers what an earlier launch left behind, focus or not, with its age as age_ms', async () => {
    const firstAttemptAt = Date.now() - ONE_HOUR;
    mfs.readFile.mockResolvedValue(storedFile(firstAttemptAt));

    await start();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(payloadOf()).toEqual(
      expect.objectContaining({ usr: { anonymous_id: ANONYMOUS_ID }, age_ms: ONE_HOUR, sdk_version: '0.0.0-test' })
    );
  });

  it('keeps the report on disk before it is accepted, and clears it after', async () => {
    let answer: ((response: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        })
    );
    await start();
    focusWindow();
    await vi.advanceTimersByTimeAsync(0);

    const writtenWhileInFlight = mfs.writeFile.mock.calls
      .filter(([filePath]) => (filePath as string).startsWith(`${FILE_PATH}.`))
      .map(([, content]) => JSON.parse(content as string) as { pending: unknown[] });
    expect(writtenWhileInFlight[writtenWhileInFlight.length - 1]?.pending.length).toBe(1);

    answer!(accepted());
    await vi.advanceTimersByTimeAsync(0);

    const writtenAfter = mfs.writeFile.mock.calls
      .filter(([filePath]) => (filePath as string).startsWith(`${FILE_PATH}.`))
      .map(([, content]) => JSON.parse(content as string) as { pending: unknown[]; sent: unknown[] });
    expect(writtenAfter[writtenAfter.length - 1]?.pending).toEqual([]);
    expect(writtenAfter[writtenAfter.length - 1]?.sent.length).toBe(1);
  });
});

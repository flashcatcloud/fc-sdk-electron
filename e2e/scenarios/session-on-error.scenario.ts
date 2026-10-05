import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RumErrorEvent, RumViewEvent } from '@flashcatcloud/electron-sdk';
import {
  test,
  expect,
  launchAppManually,
  createUserDataDir,
  cleanupUserDataDir,
  waitForCrashDump,
  ensureProcessGone,
} from '../lib/helpers';
import type { Intake } from '../lib/intake';
import type { MainPage } from '../lib/mainPage';

/** "Only error sessions": nothing is drawn by the plain rate, every session is kept on error. */
const ON_ERROR_ONLY = { sessionSampleRate: 0, sessionOnError: true };
/** Comfortably past the release jitter, which is at most 3 s. */
const RELEASE_WAIT = 3_500;

interface SessionEvent {
  type: string;
  date: number;
  session: { id: string; sampled_for_error?: boolean };
  view: { id: string; is_active?: boolean };
  _dd?: { configuration?: { session_sample_rate?: number } };
}

/** Every RUM event received, telemetry aside: telemetry is not session data and is never withheld. */
function rumEvents(intake: Intake): SessionEvent[] {
  return intake
    .getAllEvents()
    .map((event) => event.body as SessionEvent)
    .filter((body) => body.type !== 'telemetry');
}

/** Waits past the jitter, then flushes: the flush resolves once every pending batch is uploaded. */
async function settle(mainPage: MainPage, waitMs = RELEASE_WAIT) {
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  await mainPage.flushTransport();
}

/**
 * Optional evidence dump: with `FC_E2E_CAPTURE_DIR` set, every event the fake intake received is
 * written there per scenario, so a run can be inspected after the fact.
 */
test.afterEach(async ({ intake }, testInfo) => {
  const captureDir = process.env.FC_E2E_CAPTURE_DIR;
  if (!captureDir) {
    return;
  }
  await mkdir(captureDir, { recursive: true });
  const fileName = `${testInfo.titlePath
    .slice(1)
    .join(' - ')
    .replace(/[^\w.-]+/g, '_')}.json`;
  await writeFile(join(captureDir, fileName), JSON.stringify(intake.getAllEvents(), null, 2));
});

test.describe('sessionOnError', () => {
  test.use({ sdkConfig: ON_ERROR_ONLY, rumBrowserSdk: {} });
  // Each scenario sleeps past the release jitter more than once, which leaves little of the default
  // budget for a loaded machine.
  test.describe.configure({ timeout: 60_000 });

  test('uploads nothing for a session that never reports an error', async ({ intake, mainPage, testServer }) => {
    await mainPage.generateActivity();
    await mainPage.mainFetch(testServer.urlFor(200));
    await settle(mainPage);

    expect(rumEvents(intake)).toEqual([]);
  });

  test('releases the history of the main process and the renderer once an error is reported', async ({
    intake,
    mainPage,
    testServer,
  }) => {
    // Before the error: a renderer click (action) and a main-process request (resource).
    await mainPage.generateActivity();
    await mainPage.mainFetch(testServer.urlFor(200));
    await settle(mainPage);
    expect(rumEvents(intake)).toEqual([]);

    await mainPage.generateManualError();
    await settle(mainPage);

    const events = rumEvents(intake);
    const types = new Set(events.map((event) => event.type));
    // A loaded machine can add a renderer long task, which is released along with the rest.
    for (const type of ['view', 'action', 'resource', 'error']) {
      expect(types).toContain(type);
    }

    const sessionIds = new Set(events.map((event) => event.session.id));
    expect(sessionIds.size).toBe(1);

    // Both the main-process view and the renderer view, each marked as kept on error.
    const views = events.filter((event) => event.type === 'view');
    expect(new Set(views.map((view) => view.view.id)).size).toBeGreaterThanOrEqual(2);
    for (const view of views) {
      expect(view.session.sampled_for_error).toBe(true);
    }
    // One session standing for itself, on every event of both processes.
    for (const event of events) {
      expect(event._dd?.configuration?.session_sample_rate).toBe(0);
    }
    // The first view to arrive is the earliest one: the backend builds the session from it.
    const firstView = views[0];
    expect(Math.min(...views.map((view) => view.date))).toBe(firstView.date);

    const telemetry = intake
      .getAllEvents()
      .map((event) => event.body as { type: string; telemetry?: { message?: string } })
      .filter((body) => body.type === 'telemetry' && body.telemetry?.message === 'Error session event buffer released');
    expect(telemetry).toHaveLength(1);
    expect(intake.getProtocolViolations()).toEqual([]);

    // After the release, events flow as they happen.
    intake.clear();
    await mainPage.mainFetch(testServer.urlFor(200));
    await settle(mainPage, 0);
    expect(rumEvents(intake).some((event) => event.type === 'resource')).toBe(true);
  });

  test('is released by a renderer error, and not by one the renderer beforeSend dropped', async ({
    intake,
    mainPage,
    electronApp,
  }) => {
    const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);
    await bridgeWindow.generateError('dropped-by-beforeSend');
    await settle(mainPage);
    expect(rumEvents(intake)).toEqual([]);

    await bridgeWindow.generateError('kept renderer error');
    await settle(mainPage);

    const errors = rumEvents(intake).filter((event) => event.type === 'error') as unknown as RumErrorEvent[];
    expect(errors.map((error) => error.error.message)).toEqual([expect.stringContaining('kept renderer error')]);
    expect(rumEvents(intake).some((event) => event.type === 'view' && event.session.sampled_for_error)).toBe(true);
  });

  test('throws away a session that ends without an error, stragglers included', async ({
    intake,
    mainPage,
    testServer,
  }) => {
    await mainPage.generateActivity();
    await mainPage.mainFetch(testServer.urlFor(200));
    const bridgeSessionBefore = await mainPage.getBridgeSessionId();
    await mainPage.stopSession();
    await settle(mainPage);
    expect(rumEvents(intake)).toEqual([]);

    // The next session is kept on error too; its error releases it, and only it.
    await mainPage.generateActivity();
    await mainPage.generateManualError();
    await settle(mainPage);

    const sessionIds = new Set(rumEvents(intake).map((event) => event.session.id));
    expect(sessionIds.size).toBe(1);
    expect(sessionIds.has(bridgeSessionBefore)).toBe(false);
  });

  test('reports the end of a session that was released', async ({ intake, mainPage }) => {
    await mainPage.generateManualError();
    await settle(mainPage);
    intake.clear();

    await mainPage.stopSession();
    await settle(mainPage, 500);

    const views = rumEvents(intake).filter((event) => event.type === 'view');
    expect(views.some((view) => view.view.is_active === false && view.session.sampled_for_error)).toBe(true);
  });

  test('releases at once on an uncaught exception in the main process', async ({ intake, mainPage }) => {
    await mainPage.generateActivity();
    await mainPage.generateUncaughtException();
    // No wait for the jitter: whatever the session's delay, it does not apply here.
    await settle(mainPage, 200);

    const events = rumEvents(intake);
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(events.some((event) => event.type === 'action')).toBe(true);
    test.info().annotations.push({
      type: 'release-delay',
      description: `jitter this session would otherwise wait: ${computeReleaseDelay(events[0].session.id)} ms`,
    });
  });
});

test.describe('sessionOnError, negative controls', () => {
  test.use({ rumBrowserSdk: {} });

  test('a session drawn by the plain rate reports as it happens, unmarked, with its rate', async ({
    intake,
    mainPage,
  }) => {
    await mainPage.generateActivity();
    await settle(mainPage, 0);

    const views = rumEvents(intake).filter((event) => event.type === 'view');
    expect(views.length).toBeGreaterThan(0);
    for (const view of views) {
      expect(view.session.sampled_for_error).toBeUndefined();
      expect(view._dd?.configuration?.session_sample_rate).toBe(100);
    }
    expect(await mainPage.getBridgeSessionId()).not.toBe('');
  });

  test.describe('without sessionOnError', () => {
    test.use({ sdkConfig: { sessionSampleRate: 0 } });

    test('a session the draw did not keep uploads nothing, errors included, and renderers see no session', async ({
      intake,
      mainPage,
    }) => {
      await mainPage.generateActivity();
      await mainPage.generateManualError();
      await settle(mainPage);

      expect(rumEvents(intake)).toEqual([]);
      // What keeps the renderer's own Session Replay from recording it.
      expect(await mainPage.getBridgeSessionId()).toBe('');
    });
  });
});

for (const { title, config, reported } of [
  { title: 'reports the crash of a withheld session, with its view', config: ON_ERROR_ONLY, reported: true },
  {
    title: 'does not report the crash of a session the draw did not keep',
    config: { sessionSampleRate: 0 },
    reported: false,
  },
]) {
  test.describe('sessionOnError, native crash', () => {
    // The app every scenario gets launched anyway runs with the same sampling, so it uploads nothing
    // that could be mistaken for what the crashed app reports.
    test.use({ sdkConfig: config });

    test(title, async ({ intake, sdkConfig }) => {
      test.setTimeout(90_000);
      const userDataDir = await createUserDataDir();

      const first = await launchAppManually(intake, userDataDir, 'await', sdkConfig);
      await first.mainPage.flushTransport();
      const crashedPid = first.electronApp.process().pid;
      first.mainPage.crash();
      await waitForCrashDump(userDataDir);
      await ensureProcessGone(crashedPid);
      // Nothing of the crashed launch was uploaded: the session never reported an error there.
      expect(rumEvents(intake)).toEqual([]);

      const second = await launchAppManually(intake, userDataDir, 'await', sdkConfig);
      try {
        await second.mainPage.flushTransport();
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        await settle(second.mainPage);

        const events = rumEvents(intake);
        const crashes = events.filter(
          (event) => event.type === 'error' && (event as unknown as RumErrorEvent).error.is_crash
        );
        if (!reported) {
          expect(events).toEqual([]);
          return;
        }
        expect(crashes).toHaveLength(1);
        const crash = crashes[0];
        expect(crash._dd?.configuration?.session_sample_rate).toBe(0);
        const crashedView = events.find((event) => event.type === 'view' && event.view.id === crash.view.id) as
          | (SessionEvent & RumViewEvent)
          | undefined;
        expect(crashedView).toBeDefined();
        expect(crashedView!.session.sampled_for_error).toBe(true);
        expect(crashedView!.view.is_active).toBe(false);
        expect(crashedView!.session.id).toBe(crash.session.id);
        expect(intake.getProtocolViolations()).toEqual([]);
      } finally {
        await second.electronApp.close();
        await cleanupUserDataDir(userDataDir);
      }
    });
  });
}

/** Same hash as the SDK's, to report which delay the immediate release skipped. */
function computeReleaseDelay(sessionId: string) {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i += 1) {
    hash = Math.imul(hash, 31) + sessionId.charCodeAt(i);
  }
  return Math.abs(hash) % 3000;
}

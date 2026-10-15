import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import type { InitConfiguration } from '@flashcatcloud/electron-sdk';
import { test, expect, launchAppManually, createUserDataDir, cleanupUserDataDir } from '../lib/helpers';
import type { Intake } from '../lib/intake';
import type { MainPage } from '../lib/mainPage';

/**
 * Remote configuration, end to end, against the fake intake's config endpoint — never a real one:
 * a fake configuration version reported to a real backend would show up in the console's version
 * statistics.
 *
 * Every scenario comes with a negative control: the same steps under a configuration that differs
 * only in what the scenario claims makes the difference.
 */

/** Comfortably past the release jitter of an on-error session, which is at most 3 s. */
const RELEASE_WAIT = 3_500;
/**
 * How long a negative control watches for something that must not happen — a request, a session
 * ending. Only an absence needs it: everything that does happen is waited for by what it shows.
 */
const ABSENCE_WAIT = 1_000;
/**
 * How long an answer may take to be applied: more than one request that hangs until the SDK's 10 s
 * timeout and the first retry after it, about 5 s (±20%), with slack for a loaded machine.
 */
const APPLY_TIMEOUT = 25_000;

interface SessionEvent {
  type: string;
  date: number;
  session: { id: string; sampled_for_error?: boolean };
  view: { id: string; is_active?: boolean };
  _dd?: { configuration?: { session_sample_rate?: number; rc_version?: number } };
}

/** A response the way the real endpoint writes it. */
function configuration(
  version: number,
  activation: 'immediate' | 'next_session',
  rum: { sessionSampleRate?: number; sessionOnError?: boolean },
  ttl = 600,
  refreshOnForeground = false,
  /** What tells this answer apart once applied: it rides in `custom`, which the app can read. */
  marker = `v${version}`
) {
  return {
    body: {
      schema_version: 1,
      version,
      ttl,
      enabled: true,
      activation,
      refresh_on_foreground: refreshOnForeground,
      rum,
      custom: { scenario: 'e2e', marker },
    },
  };
}

/** Every RUM event received — of one session only, when given: an ended session's final view update may still arrive. */
function rumEvents(intake: Intake, sessionId?: string): SessionEvent[] {
  return intake
    .getAllEvents()
    .map((event) => event.body as SessionEvent)
    .filter((body) => body.type !== 'telemetry' && (sessionId === undefined || body.session.id === sessionId));
}

async function settle(mainPage: MainPage, waitMs = RELEASE_WAIT) {
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  await mainPage.flushTransport();
}

/**
 * Waits until the main process holds the answer carrying `marker`, so that what follows cannot race
 * the request still in flight — and not an earlier answer kept on disk. The answer travels back over
 * the same IPC channel as the session pushes, behind them, so by the time it is seen the renderer
 * has also heard of any session the answer ended.
 */
async function waitForApplied(mainPage: MainPage, marker: string, timeout = APPLY_TIMEOUT) {
  const deadline = Date.now() + timeout;
  while ((await mainPage.getRemoteConfig())?.marker !== marker) {
    if (Date.now() >= deadline) {
      throw new Error(`No configuration applied within ${timeout}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test.afterEach(async ({ intake }, testInfo) => {
  const captureDir = process.env.FC_E2E_CAPTURE_DIR;
  if (!captureDir) {
    return;
  }
  await mkdir(captureDir, { recursive: true });
  const fileName = `remote-config - ${testInfo.titlePath
    .slice(1)
    .join(' - ')
    .replace(/[^\w.-]+/g, '_')}.json`;
  await writeFile(
    join(captureDir, fileName),
    JSON.stringify({ configRequests: intake.getConfigRequests(), events: intake.getAllEvents() }, null, 2)
  );
});

test.describe('remote configuration', () => {
  test.describe.configure({ timeout: 60_000 });

  test.describe('the request', () => {
    test.use({
      sdkConfig: { remoteConfigurationEnabled: true },
      remoteConfig: configuration(1, 'next_session', {}),
    });

    test('asks once at init and again at each new session, saying who it is and what it runs', async ({
      intake,
      mainPage,
    }) => {
      const [first] = await intake.waitForConfigRequests(1);
      expect(first.params).toEqual({
        client_token: 'test-client-token',
        sdk: 'electron',
        sdk_version: expect.any(String),
        env: 'test',
        app_version: '1.0.0',
      });

      await waitForApplied(mainPage, 'v1');
      expect(await mainPage.getRemoteConfig()).toEqual({ scenario: 'e2e', marker: 'v1' });
      await mainPage.renewSession();
      const [, second] = await intake.waitForConfigRequests(2);
      expect(second.params.applied_version).toBe('1');
      // Its ETag, sent back: an unchanged configuration costs a 304.
      expect(second.headers['if-none-match']).toMatch(/^".+"$/);
    });
  });

  test.describe('without remoteConfigurationEnabled (control)', () => {
    test.use({ remoteConfig: configuration(1, 'immediate', { sessionSampleRate: 0 }) });

    test('asks nothing, and a rate of 0 published for it changes nothing', async ({ intake, mainPage }) => {
      await new Promise((resolve) => setTimeout(resolve, ABSENCE_WAIT));

      expect(intake.getConfigRequests()).toEqual([]);
      expect(await mainPage.getBridgeSessionId()).not.toBe('');
    });
  });

  test.describe('rate 0 with sessionOnError, immediate (§7.1)', () => {
    test.use({
      // "Only error sessions" at init too: the session the configuration finds is an on-error one.
      sdkConfig: { sessionSampleRate: 0, sessionOnError: true, remoteConfigurationEnabled: true },
      remoteConfig: configuration(1, 'immediate', { sessionSampleRate: 0, sessionOnError: true }),
    });

    test('leaves the on-error session running, and its error releases what it held', async ({ intake, mainPage }) => {
      await waitForApplied(mainPage, 'v1');
      const sessionId = await mainPage.getBridgeSessionId();
      expect(sessionId).not.toBe('');
      await settle(mainPage, 0);
      expect(rumEvents(intake)).toEqual([]);

      await mainPage.generateManualError();
      await settle(mainPage);

      const events = rumEvents(intake);
      expect(events.some((event) => event.type === 'error')).toBe(true);
      expect(new Set(events.map((event) => event.session.id))).toEqual(new Set([sessionId]));
      // The session the launch opened with: its view predates the request, and no other session was
      // ever drawn, or it would have asked again.
      expect(intake.getConfigRequests()).toHaveLength(1);
      const views = events.filter((event) => event.type === 'view');
      expect(Math.min(...views.map((view) => view.date))).toBeLessThan(intake.getConfigRequests()[0].timestamp);
      for (const view of views) {
        expect(view.session.sampled_for_error).toBe(true);
      }
      for (const event of events) {
        expect(event._dd?.configuration?.session_sample_rate).toBe(0);
        // Drawn before any configuration was delivered: there is no version it was drawn under.
        expect(event._dd?.configuration?.rc_version).toBeUndefined();
      }
      expect(intake.getProtocolViolations()).toEqual([]);
    });
  });

  test.describe('rate 0 with sessionOnError turned off, immediate (control for §7.1)', () => {
    test.use({
      sdkConfig: { sessionSampleRate: 0, sessionOnError: true, remoteConfigurationEnabled: true },
      remoteConfig: configuration(1, 'immediate', { sessionSampleRate: 0, sessionOnError: false }),
    });

    test('ends the on-error session, and an error then releases nothing', async ({ intake, mainPage }) => {
      await waitForApplied(mainPage, 'v1');

      expect(await mainPage.getBridgeSessionId()).toBe('');
      await mainPage.generateManualError();
      await settle(mainPage);
      expect(rumEvents(intake)).toEqual([]);
    });
  });

  test.describe('rate 0, immediate: the emergency stop', () => {
    test.use({
      sdkConfig: { remoteConfigurationEnabled: true },
      remoteConfig: configuration(2, 'immediate', { sessionSampleRate: 0 }),
    });

    test('ends the drawn session, and the next one is not collected', async ({ intake, mainPage, testServer }) => {
      await waitForApplied(mainPage, 'v2');
      expect(await mainPage.getBridgeSessionId()).toBe('');
      await settle(mainPage, 0);
      const ended = rumEvents(intake).filter((event) => event.type === 'view');
      expect(ended.length).toBeGreaterThan(0);
      // The view of the session that ended reports it as over.
      expect(ended.some((view) => view.view.is_active === false)).toBe(true);
      const endedSessionId = ended[0].session.id;

      intake.clear();
      await mainPage.generateActivity();
      await mainPage.mainFetch(testServer.urlFor(200));
      await settle(mainPage, 0);

      expect(await mainPage.getBridgeSessionId()).toBe('');
      expect(rumEvents(intake).filter((event) => event.session.id !== endedSessionId)).toEqual([]);
    });
  });

  test.describe('rate 0, next session (control for the emergency stop)', () => {
    test.use({
      sdkConfig: { remoteConfigurationEnabled: true },
      remoteConfig: configuration(2, 'next_session', { sessionSampleRate: 0 }),
    });

    test('leaves the drawn session collecting', async ({ intake, mainPage, testServer }) => {
      await waitForApplied(mainPage, 'v2');
      const sessionId = await mainPage.getBridgeSessionId();
      expect(sessionId).not.toBe('');

      await mainPage.mainFetch(testServer.urlFor(200));
      await settle(mainPage, 0);

      const resources = rumEvents(intake).filter((event) => event.type === 'resource');
      expect(resources.length).toBeGreaterThan(0);
      for (const resource of resources) {
        expect(resource.session.id).toBe(sessionId);
        expect(resource._dd?.configuration?.session_sample_rate).toBe(100);
      }
    });
  });

  test.describe('refresh when the user comes back (refresh_on_foreground)', () => {
    test.use({ sdkConfig: { remoteConfigurationEnabled: true } });

    /**
     * The user coming back, as the SDK hears it. Emitted on `app` rather than produced by focusing a
     * window: the test windows are hidden, and real focus is not reliable on a headless runner.
     */
    async function focusApp(electronApp: ElectronApplication) {
      await electronApp.evaluate(({ app, BrowserWindow }) => {
        app.emit('browser-window-focus', {}, BrowserWindow.getAllWindows()[0]);
      });
    }

    /** Publishes an emergency stop, then lets `waitMs` pass, then the user comes back. */
    async function stopThenFocus(intake: Intake, electronApp: ElectronApplication, waitMs: number) {
      intake.setRemoteConfig(configuration(2, 'immediate', { sessionSampleRate: 0 }, 1, true));
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      await focusApp(electronApp);
    }

    for (const { title, allowed, waitMs, refreshed } of [
      {
        title: 'delivers an emergency stop to the running session once the ttl has passed',
        allowed: true,
        // 1 s asks for less than the SDK allows: it honours its 60 s floor.
        waitMs: 61_000,
        refreshed: true,
      },
      {
        title: 'asks nothing when the operator does not allow it (control)',
        allowed: false,
        waitMs: 61_000,
        refreshed: false,
      },
      { title: 'asks nothing before the ttl has passed (control)', allowed: true, waitMs: 1_000, refreshed: false },
    ]) {
      test.describe(title, () => {
        test.use({ remoteConfig: configuration(1, 'next_session', {}, 1, allowed) });

        test('on focus', async ({ intake, mainPage, electronApp }) => {
          test.setTimeout(120_000);
          await waitForApplied(mainPage, 'v1');
          const sessionId = await mainPage.getBridgeSessionId();
          expect(sessionId).not.toBe('');

          await stopThenFocus(intake, electronApp, waitMs);
          if (refreshed) {
            await waitForApplied(mainPage, 'v2');
          } else {
            await new Promise((resolve) => setTimeout(resolve, ABSENCE_WAIT));
          }

          const requests = intake.getConfigRequests();
          if (refreshed) {
            expect(requests).toHaveLength(2);
            expect(requests[1].params.applied_version).toBe('1');
            expect(requests[1].headers['if-none-match']).toMatch(/^".+"$/);
            expect(await mainPage.getBridgeSessionId()).toBe('');
          } else {
            expect(requests).toHaveLength(1);
            expect(await mainPage.getBridgeSessionId()).toBe(sessionId);
          }
        });
      });
    }
  });

  test.describe('the kill switch (enabled: false)', () => {
    test.use({ sdkConfig: { remoteConfigurationEnabled: true } });

    /** An emergency stop, published with the kill switch in the given position. */
    function stop(enabled: boolean) {
      const { body } = configuration(5, 'immediate', { sessionSampleRate: 0 }, 1, true);
      return { body: { ...body, enabled } };
    }

    test.describe('off', () => {
      test.use({ remoteConfig: stop(false) });

      test('applies none of the values, yet honours when to ask again', async ({ intake, mainPage, electronApp }) => {
        test.setTimeout(120_000);
        await intake.waitForConfigRequests(1);
        const sessionId = await mainPage.getBridgeSessionId();
        expect(sessionId).not.toBe('');

        // Past the ttl floor: the stop would long have ended the session if it applied.
        await new Promise((resolve) => setTimeout(resolve, 61_000));
        expect(await mainPage.getBridgeSessionId()).toBe(sessionId);
        expect(await mainPage.getRemoteConfig()).toBeUndefined();

        // The answer's ttl and refresh_on_foreground are kept all the same: focus asks again.
        await electronApp.evaluate(({ app, BrowserWindow }) => {
          app.emit('browser-window-focus', {}, BrowserWindow.getAllWindows()[0]);
        });
        const [, second] = await intake.waitForConfigRequests(2);
        expect(second.params.applied_version).toBe('5');
        expect(second.headers['if-none-match']).toMatch(/^".+"$/);
        expect(await mainPage.getBridgeSessionId()).toBe(sessionId);
      });
    });

    test.describe('on (control)', () => {
      test.use({ remoteConfig: stop(true) });

      test('applies the stop at once', async ({ mainPage }) => {
        await waitForApplied(mainPage, 'v5');

        expect(await mainPage.getBridgeSessionId()).toBe('');
      });
    });
  });

  test.describe('next session (deferred)', () => {
    test.use({
      sdkConfig: { remoteConfigurationEnabled: true },
      remoteConfig: configuration(3, 'next_session', { sessionSampleRate: 0, sessionOnError: true }),
    });

    test('keeps the current session as drawn, and draws the next one under the new values', async ({
      intake,
      mainPage,
      testServer,
    }) => {
      await waitForApplied(mainPage, 'v3');
      const current = await mainPage.getBridgeSessionId();
      await mainPage.mainFetch(testServer.urlFor(200));
      await settle(mainPage, 0);
      const before = rumEvents(intake);
      expect(before.some((event) => event.type === 'resource')).toBe(true);
      for (const event of before) {
        expect(event.session.id).toBe(current);
        expect(event._dd?.configuration?.session_sample_rate).toBe(100);
        expect(event._dd?.configuration?.rc_version).toBeUndefined();
      }

      intake.clear();
      await mainPage.renewSession();
      const next = await mainPage.getBridgeSessionId();
      expect(next).not.toBe('');
      expect(next).not.toBe(current);
      await mainPage.mainFetch(testServer.urlFor(200));
      await settle(mainPage);
      // An on-error session: nothing until it errors.
      expect(rumEvents(intake, next)).toEqual([]);

      await mainPage.generateManualError();
      await settle(mainPage);
      const after = rumEvents(intake, next);
      expect(after.some((event) => event.type === 'error')).toBe(true);
      for (const event of after) {
        expect(event.session.id).toBe(next);
        expect(event._dd?.configuration?.session_sample_rate).toBe(0);
        expect(event._dd?.configuration?.rc_version).toBe(3);
      }
      expect(intake.getProtocolViolations()).toEqual([]);
    });
  });

  test.describe('next session without a configuration (control for deferred)', () => {
    // Nothing published: the endpoint answers version 0, switched off.
    test.use({ sdkConfig: { remoteConfigurationEnabled: true } });

    test('draws the next session under the init values, and reports no version 0', async ({
      intake,
      mainPage,
      testServer,
    }) => {
      await intake.waitForConfigRequests(1);
      await mainPage.renewSession();
      const [, second] = await intake.waitForConfigRequests(2);
      expect(second.params.applied_version).toBeUndefined();
      expect(second.headers['if-none-match']).toMatch(/^".+"$/);
      await mainPage.mainFetch(testServer.urlFor(200));
      await settle(mainPage, 0);

      const resources = rumEvents(intake).filter((event) => event.type === 'resource');
      expect(resources.length).toBeGreaterThan(0);
      for (const resource of resources) {
        expect(resource._dd?.configuration?.session_sample_rate).toBe(100);
        expect(resource._dd?.configuration?.rc_version).toBeUndefined();
      }
    });
  });

  test.describe('sessionOnError turned on for a session drawn at rate 0, immediate', () => {
    test.use({
      sdkConfig: { sessionSampleRate: 0, remoteConfigurationEnabled: true },
      remoteConfig: configuration(4, 'immediate', { sessionOnError: true }),
    });

    test('ends the session so the next activity draws again, as an on-error session', async ({ intake, mainPage }) => {
      await waitForApplied(mainPage, 'v4');
      expect(await mainPage.getBridgeSessionId()).toBe('');

      await mainPage.generateActivity();
      const redrawn = await mainPage.getBridgeSessionId();
      expect(redrawn).not.toBe('');

      await mainPage.generateManualError();
      await settle(mainPage);
      const events = rumEvents(intake);
      expect(events.some((event) => event.type === 'error')).toBe(true);
      for (const event of events) {
        expect(event.session.id).toBe(redrawn);
        expect(event._dd?.configuration?.session_sample_rate).toBe(0);
        expect(event._dd?.configuration?.rc_version).toBe(4);
      }
      expect(events.filter((event) => event.type === 'view').every((view) => view.session.sampled_for_error)).toBe(
        true
      );
    });
  });

  test.describe('sessionOnError turned on for a session drawn at rate 0, next session (control)', () => {
    test.use({
      sdkConfig: { sessionSampleRate: 0, remoteConfigurationEnabled: true },
      remoteConfig: configuration(4, 'next_session', { sessionOnError: true }),
    });

    test('keeps the session it has, which collects nothing', async ({ intake, mainPage }) => {
      await waitForApplied(mainPage, 'v4');

      await mainPage.generateActivity();
      expect(await mainPage.getBridgeSessionId()).toBe('');
      await mainPage.generateManualError();
      await settle(mainPage);
      expect(rumEvents(intake)).toEqual([]);
    });
  });
});

test.describe('remote configuration kept for the next launch', () => {
  // The app every test launches anyway collects nothing, so all events come from the launches below.
  test.use({ sdkConfig: { sessionSampleRate: 0 } });
  test.describe.configure({ timeout: 90_000 });

  const ENABLED: Partial<InitConfiguration> = { remoteConfigurationEnabled: true };

  /** Launch one: receives the configuration, keeps it, ends its session so the next launch draws anew. */
  async function receiveAndKeep(intake: Intake, userDataDir: string) {
    intake.setRemoteConfig(configuration(5, 'next_session', { sessionSampleRate: 0, sessionOnError: true }));
    const first = await launchAppManually(intake, userDataDir, 'await', ENABLED);
    try {
      await intake.waitForConfigRequests(1);
      await waitForFile(join(userDataDir, '_fc_remote_config'));
      await first.mainPage.stopSession();
    } finally {
      await first.electronApp.close();
    }
    intake.clear();
    // Offline from now on, as far as the configuration is concerned.
    intake.setRemoteConfig({ reset: true });
  }

  test('draws the first session of a cold start, while offline, with the configuration kept on disk', async ({
    intake,
    testServer,
  }) => {
    const userDataDir = await createUserDataDir();
    try {
      await receiveAndKeep(intake, userDataDir);

      const second = await launchAppManually(intake, userDataDir, 'await', ENABLED);
      try {
        await intake.waitForConfigRequests(1);
        expect(intake.getConfigRequests()[0].params.applied_version).toBe('5');
        // On-error, as kept: collected, so the bridge answers it, but nothing leaves without an error.
        const sessionId = await second.mainPage.getBridgeSessionId();
        expect(sessionId).not.toBe('');
        await second.mainPage.mainFetch(testServer.urlFor(200));
        await settle(second.mainPage);
        expect(rumEvents(intake, sessionId)).toEqual([]);

        await second.mainPage.generateManualError();
        await settle(second.mainPage);
        const events = rumEvents(intake, sessionId);
        expect(events.some((event) => event.type === 'error')).toBe(true);
        for (const event of events) {
          expect(event._dd?.configuration?.session_sample_rate).toBe(0);
          expect(event._dd?.configuration?.rc_version).toBe(5);
        }
      } finally {
        await second.electronApp.close();
      }
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('draws it under the init values when nothing was kept (control)', async ({ intake, testServer }) => {
    const userDataDir = await createUserDataDir();
    try {
      await receiveAndKeep(intake, userDataDir);
      await rm(join(userDataDir, '_fc_remote_config'));

      const second = await launchAppManually(intake, userDataDir, 'await', ENABLED);
      try {
        await intake.waitForConfigRequests(1);
        expect(intake.getConfigRequests()[0].params.applied_version).toBeUndefined();
        const sessionId = await second.mainPage.getBridgeSessionId();
        await second.mainPage.mainFetch(testServer.urlFor(200));
        await settle(second.mainPage, 0);

        const resources = rumEvents(intake, sessionId).filter((event) => event.type === 'resource');
        expect(resources.length).toBeGreaterThan(0);
        for (const resource of resources) {
          expect(resource._dd?.configuration?.session_sample_rate).toBe(100);
          expect(resource._dd?.configuration?.rc_version).toBeUndefined();
        }
      } finally {
        await second.electronApp.close();
      }
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });
});

test.describe('remote configuration and a launch that ended before it was obeyed', () => {
  test.use({ sdkConfig: { sessionSampleRate: 0 } });
  test.describe.configure({ timeout: 90_000 });

  const ENABLED: Partial<InitConfiguration> = { remoteConfigurationEnabled: true };
  const KEPT = '_fc_remote_config';

  /** Launch one: receives `served`, keeps it on disk, and leaves its session to be resumed. */
  async function firstLaunch(intake: Intake, userDataDir: string, served: ReturnType<typeof configuration>) {
    intake.setRemoteConfig(served);
    const first = await launchAppManually(intake, userDataDir, 'await', ENABLED);
    try {
      await waitForApplied(first.mainPage, (served.body.custom as { marker: string }).marker);
      await waitForFile(join(userDataDir, KEPT));
      return await first.mainPage.getBridgeSessionId();
    } finally {
      await first.electronApp.close();
      intake.clear();
    }
  }

  /** Rewrites the kept configuration as a launch that ended mid-way could have left it. */
  async function editKept(userDataDir: string, edit: Record<string, unknown>) {
    const filePath = join(userDataDir, KEPT);
    const kept = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    await writeFile(filePath, JSON.stringify({ ...kept, ...edit }));
  }

  for (const { title, activation, ends } of [
    {
      title: 'ends a resumed session drawn before an immediate stop it kept, offline',
      activation: 'immediate',
      ends: true,
    },
    {
      title: 'leaves it when what it kept applies to the next session (control)',
      activation: 'next_session',
      ends: false,
    },
  ]) {
    test(title, async ({ intake }) => {
      const userDataDir = await createUserDataDir();
      try {
        const resumed = await firstLaunch(intake, userDataDir, configuration(1, 'next_session', {}));
        expect(resumed).not.toBe('');
        // The stop arrived and was kept, but the session file outlived it.
        await editKept(userDataDir, { version: 2, values: { sessionSampleRate: 0 }, activation });
        intake.setRemoteConfig({ reset: true });

        const second = await launchAppManually(intake, userDataDir, 'await', ENABLED);
        try {
          expect(await second.mainPage.getBridgeSessionId()).toBe(ends ? '' : resumed);
        } finally {
          await second.electronApp.close();
        }
      } finally {
        await cleanupUserDataDir(userDataDir);
      }
    });
  }

  for (const { title, served, redrawn } of [
    {
      title: 'redraws a session when the same version, read by this SDK, turns the switch on immediately',
      served: configuration(7, 'immediate', { sessionSampleRate: 0, sessionOnError: true }, 600, false, 'second'),
      redrawn: true,
    },
    {
      title: 'leaves it when the same version reads the same (control)',
      served: configuration(7, 'immediate', { sessionSampleRate: 0 }, 600, false, 'second'),
      redrawn: false,
    },
  ]) {
    test(title, async ({ intake }) => {
      const userDataDir = await createUserDataDir();
      try {
        await firstLaunch(intake, userDataDir, configuration(7, 'next_session', { sessionSampleRate: 0 }));
        // As an SDK that did not read the switch would have kept version 7; and a fresh session to draw.
        await editKept(userDataDir, { sdkVersion: 'older' });
        await rm(join(userDataDir, '_dd_s'), { force: true });
        intake.setRemoteConfig(served);

        const second = await launchAppManually(intake, userDataDir, 'await', ENABLED);
        try {
          // The answer of this launch, not the one kept on disk.
          await waitForApplied(second.mainPage, 'second');
          // Drawn at rate 0 from what was kept: nothing collected.
          expect(await second.mainPage.getBridgeSessionId()).toBe('');
          // Asked unconditionally: the ETag another SDK version kept is not sent.
          expect(intake.getConfigRequests()[0].headers['if-none-match']).toBeUndefined();

          await second.mainPage.generateActivity();
          const sessionId = await second.mainPage.getBridgeSessionId();
          if (redrawn) {
            expect(sessionId).not.toBe('');
          } else {
            expect(sessionId).toBe('');
          }
        } finally {
          await second.electronApp.close();
        }
      } finally {
        await cleanupUserDataDir(userDataDir);
      }
    });
  }
});

async function waitForFile(filePath: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      await stat(filePath);
      return;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`${filePath} did not appear within ${timeout}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

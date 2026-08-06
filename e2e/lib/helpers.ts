import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { basename, join } from 'node:path';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Intake } from './intake';
import { TestServer } from './testServer';
import { MainPage } from './mainPage';
import type { InitConfiguration } from '@flashcatcloud/electron-sdk';

// Get electron executable path from the app's node_modules
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require(join(__dirname, '../app/node_modules/electron')) as string;

// Variables forwarded to the Electron child process. Keep this list minimal:
// system essentials for the binary to launch, plus the few flags the test app
// and Playwright themselves read. Anything else is intentionally dropped to avoid
// leaking variables that change behavior (e.g. OTEL_TRACES_EXPORTER=otlp would
// make dd-trace switch off the experimental electron exporter the SDK relies on).
const HOST_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'DISPLAY',
  'XAUTHORITY',
  'CI',
  'PWDEBUG',
];

export interface TestFixtures {
  electronApp: ElectronApplication;
  window: Page;
  mainPage: MainPage;
  intake: Intake;
  testServer: TestServer;
  rumBrowserSdk: Record<string, unknown> | null;
}

/**
 * Custom Playwright test with Electron app fixtures.
 * Automatically launches the app before each test and closes it after.
 */
export const test = base.extend<TestFixtures>({
  intake: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const intake = new Intake();
      await intake.start();
      await use(intake);
      await intake.stop();
    },
    { option: true },
  ],

  testServer: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const testServer = new TestServer();
      await testServer.start();
      await use(testServer);
      await testServer.stop();
    },
    { option: true },
  ],

  electronApp: async ({ intake, rumBrowserSdk }, use) => {
    const userDataDir = await createUserDataDir();
    const electronApp = await launchApp(intake, userDataDir, rumBrowserSdk);
    await use(electronApp);
    await electronApp.close();
    await cleanupUserDataDir(userDataDir);
  },

  window: [
    async ({ electronApp }, use) => {
      const { window } = await waitForWindowLoaded(electronApp);
      await use(window);
    },
    { auto: true },
  ],

  mainPage: async ({ window }, use) => {
    await use(new MainPage(window));
  },

  rumBrowserSdk: [null, { option: true }],
});

async function launchApp(
  intake: Intake,
  userDataDir: string,
  rumBrowserSdk: Record<string, unknown> | null = null
): Promise<ElectronApplication> {
  const env: Record<string, string> = {};
  for (const key of HOST_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  const electronSdkConfig: InitConfiguration = {
    // `site` is deliberately omitted: it is optional and resolves to DEFAULT_SITE. Leaving it out
    // keeps the default-resolution path under test. It is unused here anyway — `proxy` decides
    // both the upload URL and the origin the SDK excludes its own intake traffic on.
    //
    // The host has to be written the same way `TestServer` writes it. Pointing the intake at
    // `localhost` while the test server answered on `127.0.0.1` made the two look like different
    // hosts, which is what let a host-only exclusion pass every scenario in this suite while it
    // dropped application traffic in any deployment where the intake shares a host with it.
    proxy: `http://127.0.0.1:${intake.getPort()}`,
    clientToken: 'test-client-token',
    service: 'e2e-test-app',
    applicationId: 'e2e-test-app-id',
    env: 'test',
    version: '1.0.0',
    telemetrySampleRate: 100,
    defaultPrivacyLevel: 'mask',
    allowedWebViewHosts: [],
  };
  env.FC_ELECTRON_SDK_CONFIG = JSON.stringify(electronSdkConfig);

  if (rumBrowserSdk !== null) {
    env.FC_RUM_BROWSER_SDK = JSON.stringify({
      applicationId: 'blank',
      clientToken: 'blank',
      // No `site`: the FlashCat browser SDK's public `init` omits it from its configuration type.
      service: 'e2e-main-window',
      sessionSampleRate: 100,
      trackUserInteractions: true,
      ...rumBrowserSdk,
    });
  }

  return electron.launch({
    executablePath: electronPath,
    args: [join(__dirname, '../app/dist/main.js'), `--user-data-dir=${userDataDir}`],
    env,
  });
}

async function waitForWindowLoaded(electronApp: ElectronApplication): Promise<{ window: Page }> {
  const window = await electronApp.firstWindow();
  window.on('console', (msg) => console.log('Browser console:', msg.text()));
  await window.waitForLoadState('load');
  await window.waitForTimeout(500);
  return { window };
}

export async function launchAppManually(
  intake: Intake,
  userDataDir: string
): Promise<{ electronApp: ElectronApplication; window: Page; mainPage: MainPage }> {
  const electronApp = await launchApp(intake, userDataDir);
  const { window } = await waitForWindowLoaded(electronApp);
  return { electronApp, window, mainPage: new MainPage(window) };
}

export async function createUserDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'electron-sdk-e2e-'));
}

/**
 * Waits until a native crash has been fully written to disk.
 *
 * This — not the crashed process going away — is what a relaunch needs: the SDK reports crashes by
 * scanning `app.getPath('crashDumps')` at startup, and Crashpad takes a few seconds to produce the
 * minidump. Returns the dump path.
 */
export async function waitForCrashDump(userDataDir: string, timeout = 30_000): Promise<string> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const dumpPath = await findCrashDump(userDataDir);
    if (dumpPath !== undefined) {
      return dumpPath;
    }
    if (Date.now() >= deadline) {
      throw new Error(`No crash dump appeared under ${userDataDir} within ${timeout}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function findCrashDump(userDataDir: string): Promise<string | undefined> {
  // Electron points `crashDumps` at `<userData>/Crashpad`, but scan the whole user data directory
  // so this does not depend on the per-platform layout underneath.
  let entries;
  try {
    entries = await readdir(userDataDir, { recursive: true, withFileTypes: true });
  } catch {
    // The directory can be swept while Crashpad reorganizes its database; retry on the next tick.
    return undefined;
  }
  for (const entry of entries) {
    // Crashpad writes a dump under `new/` and renames it into `pending/` once complete, so a dump
    // still in `new/` is not readable yet.
    if (entry.isFile() && entry.name.endsWith('.dmp') && basename(entry.parentPath) !== 'new') {
      return join(entry.parentPath, entry.name);
    }
  }
  return undefined;
}

/**
 * Makes sure a crashed process is gone before the test relaunches the app.
 *
 * `process.crash()` raises SIGABRT. macOS tears the process down within a second, but on Linux CI
 * runners the aborting Electron process has been observed alive more than two minutes after its
 * minidump was written, blocked writing to the Crashpad handler pipe. Waiting on Playwright's
 * `close` event therefore hangs the test, so poll the process id directly and SIGKILL it once the
 * grace period elapses.
 *
 * Best effort by design: the relaunch only needs the crash dump, which is already on disk by the
 * time this runs, so a process that survives even SIGKILL is reported and then left behind rather
 * than failing the test.
 */
export async function ensureProcessGone(pid: number | undefined, grace = 5_000): Promise<void> {
  if (pid === undefined || (await waitForProcessGone(pid, grace))) {
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already reaped between the last poll and here.
    return;
  }
  if (!(await waitForProcessGone(pid, grace))) {
    console.warn(`Crashed process ${pid} is still alive after SIGKILL; continuing anyway.`);
  }
}

async function waitForProcessGone(pid: number, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      // Signal 0 performs the permission and existence checks without sending anything.
      process.kill(pid, 0);
    } catch (error) {
      // ESRCH means no such process. EPERM means it is still there, just not ours to signal.
      return (error as NodeJS.ErrnoException).code !== 'EPERM';
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function cleanupUserDataDir(userDataDir: string): Promise<void> {
  await rm(userDataDir, { recursive: true, force: true });
}

export { expect } from '@playwright/test';

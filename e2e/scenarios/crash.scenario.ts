import {
  test,
  expect,
  launchAppManually,
  createUserDataDir,
  cleanupUserDataDir,
  waitForCrashDump,
  ensureProcessGone,
} from '../lib/helpers';
import type { RumErrorEvent, RumViewEvent } from '@flashcatcloud/electron-sdk';

test('emits a crash error event after a native crash', async ({ intake }) => {
  // Two app launches plus the wait for Crashpad to write the minidump do not fit the default
  // per-test budget, and the crashed process gets a grace period on top of that.
  test.setTimeout(90_000);

  const userDataDir = await createUserDataDir();

  // Phase 1: Launch and crash
  const { electronApp: firstElectronApp, mainPage: firstMainPage } = await launchAppManually(intake, userDataDir);
  await firstMainPage.flushTransport();
  const viewEvents = await intake.getEventsByType('view');
  const sessionId = (viewEvents[0].body as RumViewEvent).session.id;

  // Read the process id while Playwright still exposes the handle: it is gone once the app closes.
  const crashedPid = firstElectronApp.process().pid;

  firstMainPage.crash();
  // Synchronize on the minidump landing on disk, not on the crashed process exiting: the dump is
  // what phase 2 reads, and on Linux the aborting process can outlive it by minutes. Wait for the
  // dump first — reaping the process earlier would cut Crashpad off before it writes.
  await waitForCrashDump(userDataDir);
  await ensureProcessGone(crashedPid);
  intake.clear();

  // Phase 2: Relaunch and verify crash event
  const { electronApp: secondElectronApp, mainPage: secondMainPage } = await launchAppManually(intake, userDataDir);
  try {
    await secondMainPage.flushTransport();
    // increase timeout to account for crash dump processing
    const errorEvents = await intake.getEventsByType('error', { timeout: 15_000 });
    expect(errorEvents).toHaveLength(1);

    const error = errorEvents[0].body as RumErrorEvent;
    expect(error.session.id).toBe(sessionId);
    expect(error.error.is_crash).toBe(true);
    expect(error.error.source).toBe('source');
    expect(error.error.handling).toBe('unhandled');
    expect(error.error.category).toBe('Exception');
    expect(error.error.stack).toBeTruthy();
    expect(error.error.threads).toBeDefined();
    expect(error.error.binary_images).toBeDefined();
    expect(error.error.meta).toBeDefined();
  } finally {
    await secondElectronApp.close();
    await cleanupUserDataDir(userDataDir);
  }
});

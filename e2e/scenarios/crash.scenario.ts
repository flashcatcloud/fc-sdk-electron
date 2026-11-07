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
    // The crash time comes from the dump file's `fs.Stats`, which is fractional. The intake
    // decodes `date` into an int64 and Go drops the event on a fractional number, without any
    // sign of it on this side — so assert the type, not just the presence.
    expect(Number.isInteger(error.date)).toBe(true);
    expect(intake.getProtocolViolations()).toEqual([]);
    expect(error.session.id).toBe(sessionId);
    expect(error.error.is_crash).toBe(true);
    expect(error.error.source).toBe('source');
    expect(error.error.handling).toBe('unhandled');
    expect(error.error.category).toBe('Exception');
    expect(error.error.stack).toBeTruthy();
    expect(error.error.threads).toBeDefined();
    expect(error.error.binary_images).toBeDefined();
    expect(error.error.meta).toBeDefined();

    // The exception type is the processor's name for the fault, e.g.
    // `EXC_BAD_ACCESS / KERN_INVALID_ADDRESS` on macOS or `SIGSEGV` on Linux. `unknown 0x… / 0x…`
    // is what it falls back to when the minidump carries no real exception record — which is a
    // property of how the process died, not a gap in the SDK. `process.crash()` faults for real
    // (it writes through a null pointer), so it must produce a named type here.
    expect(error.error.type).toBeTruthy();
    expect(error.error.type).not.toMatch(/^unknown 0x/);
    expect(error.error.meta!.exception_codes).toMatch(/^0x[\da-f]{16}$/);
  } finally {
    await secondElectronApp.close();
    await cleanupUserDataDir(userDataDir);
  }
});

test('reports a crash that happened after the session had ended in a session of its own', async ({ intake }) => {
  test.setTimeout(90_000);

  const userDataDir = await createUserDataDir();

  // Phase 1: end the session — as inactivity would, with nothing renewing it — then crash.
  const { electronApp: firstElectronApp, mainPage: firstMainPage } = await launchAppManually(intake, userDataDir);
  await firstMainPage.flushTransport();
  const endedSessionId = ((await intake.getEventsByType('view'))[0].body as RumViewEvent).session.id;
  await firstMainPage.stopSessionWithoutInput();
  await firstMainPage.flushTransport();

  const crashedPid = firstElectronApp.process().pid;
  firstMainPage.crashWithoutInput();
  await waitForCrashDump(userDataDir);
  await ensureProcessGone(crashedPid);
  intake.clear();

  // Phase 2: relaunch; the crash comes in a session drawn for it, with a view to build it from.
  const { electronApp: secondElectronApp, mainPage: secondMainPage } = await launchAppManually(intake, userDataDir);
  try {
    await secondMainPage.flushTransport();
    const errorEvents = await intake.getEventsByType('error', { timeout: 15_000 });
    expect(errorEvents).toHaveLength(1);
    const crash = errorEvents[0].body as RumErrorEvent;
    expect(crash.error.is_crash).toBe(true);
    expect(crash.session.id).not.toBe(endedSessionId);

    const views = (await intake.getEventsByType('view')).map((event) => event.body as RumViewEvent);
    const crashView = views.find((view) => view.view.id === crash.view.id);
    expect(crashView).toMatchObject({ session: { id: crash.session.id }, view: { error: { count: 1 } } });
    // The relaunch has its own session; the crash's is not it.
    expect(views.some((view) => view.session.id !== crash.session.id)).toBe(true);
    expect(intake.getProtocolViolations()).toEqual([]);
  } finally {
    await secondElectronApp.close();
    await cleanupUserDataDir(userDataDir);
  }
});

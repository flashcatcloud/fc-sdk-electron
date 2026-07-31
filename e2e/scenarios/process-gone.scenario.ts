/**
 * `ProcessGoneCollection` — terminations Crashpad writes no minidump for.
 *
 * This collection did not exist when the upstream suite was written. It reports
 * `render-process-gone` / `child-process-gone` for the dump-less exit reasons (`killed`,
 * `abnormal-exit`, `launch-failed`, …); the reasons that *do* produce a dump are left to
 * `CrashCollection` so the same incident is not reported twice.
 *
 * A SIGKILL on the renderer is the reliable way to reach the dump-less path: the signal cannot be
 * caught, so no dump is written, and Electron reports the reason as `killed`. The kill targets a
 * secondary bridge window so the window driving the test stays alive.
 *
 * `child-process-gone` (GPU / Utility / Zygote) shares the same emit path but has no reliable
 * trigger from inside the app, so it is covered by unit tests only.
 */
import { test, expect } from '../lib/helpers';
import type { RumErrorEvent, RumViewEvent } from '@flashcatcloud/electron-sdk';

const isProcessGone = (event: { body: unknown }) => (event.body as RumErrorEvent).error.type === 'RenderProcessGone';

test('emits an error event when a renderer process is killed', async ({ electronApp, mainPage, intake }) => {
  await mainPage.flushTransport();
  const mainViewEvents = await intake.getEventsByType('view');
  const mainView = mainViewEvents[0].body as RumViewEvent;

  const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);
  // Let the bridge window report its view so the renderer registry can attribute the termination.
  await bridgeWindow.page.waitForTimeout(500);
  await mainPage.flushTransport();

  await mainPage.killBridgeWindowRenderer();
  await mainPage.flushTransport();

  const errorEvents = await intake.waitForEventCount('error', 1, { predicate: isProcessGone });
  const error = errorEvents[0].body as RumErrorEvent;

  expect(error.error.message).toBe('Renderer process gone: killed');
  expect(error.error.source).toBe('source');
  expect(error.error.handling).toBe('unhandled');
  expect(error.error.category).toBe('Exception');
  // Never a crash of the host app — the backend escalates every `is_crash` error to a critical alert.
  expect(error.error.is_crash).toBe(false);
  expect(error.error.meta?.process).toBe('renderer');
  expect(error.error.meta?.exit_reason).toBe('killed');
  expect(error.error.meta?.exit_code).toBeDefined();
  expect(error.error.meta?.url).toContain('bridge-window.html');

  // The main process cannot unwind a process that is already gone.
  expect(error.error.stack).toBeUndefined();

  // Attributed to the main-process session, and to the renderer's own view through `container`.
  expect(error.session.id).toBe(mainView.session.id);
  expect(error.container?.source).toBe('electron');
  expect(error.container?.view.id).toBeDefined();
  expect(error.container?.view.id).not.toBe(mainView.view.id);
});

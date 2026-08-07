import { test, expect, launchAppManually, createUserDataDir, cleanupUserDataDir } from '../lib/helpers';
import type { Page } from '@playwright/test';
import type { RumViewEvent } from '@flashcatcloud/electron-sdk';

/**
 * What an application does between `init()` and its first window.
 *
 * The bridge preload asks the main process for its configuration over a *synchronous* IPC channel,
 * and Electron leaves a synchronous request that no `ipcMain` listener answers blocked forever —
 * registering a listener afterwards does not release it. A renderer that starts before the SDK is
 * ready would therefore hang before running a single line of the page, which is a monitoring SDK
 * bricking the application it monitors. These cases pin that down: whatever the order, the window
 * loads, and once the SDK is up the bridge carries the real identifiers.
 */

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

interface BridgeWindow {
  DatadogEventBridge?: {
    getSessionId: () => string;
    getAnonymousId: () => string;
  };
}

/** Reads the bridge the way the Browser SDK does: from the page's own world. */
function readBridge(page: Page): Promise<{ sessionId: string; anonymousId: string } | null> {
  return page.evaluate(() => {
    const bridge = (globalThis as unknown as BridgeWindow).DatadogEventBridge;
    return bridge ? { sessionId: bridge.getSessionId(), anonymousId: bridge.getAnonymousId() } : null;
  });
}

test('a window opened before the SDK is ready loads, and picks the identifiers up', async ({ intake }) => {
  const userDataDir = await createUserDataDir();
  // Reaching this line at all is half the assertion: the fixture waits for the window's `load`
  // state, which a deadlocked renderer never reaches.
  const { electronApp, window, mainPage } = await launchAppManually(intake, userDataDir, 'race');

  try {
    expect(await window.title()).toBeTruthy();

    // The window loaded holding the unconfigured placeholder — the app only calls `init()` once
    // this window has finished loading. Nothing but the catch-up push can fill these in.
    await expect.poll(async () => (await readBridge(window))?.anonymousId, { timeout: 15_000 }).toMatch(UUID_PATTERN);

    await mainPage.flushTransport();
    const mainView = (await intake.getEventsByType('view'))[0].body as RumViewEvent;
    const bridge = await readBridge(window);

    // One device, one session: what the late-arriving push gave this renderer has to be what the
    // main process stamps on its own events, or the two halves count as different users.
    expect(bridge?.anonymousId).toBe(mainView.usr?.anonymous_id);
    expect(bridge?.sessionId).toBe(mainView.session.id);
  } finally {
    await electronApp.close();
    await cleanupUserDataDir(userDataDir);
  }
});

test('a window loads normally when init() never runs', async ({ intake }) => {
  const userDataDir = await createUserDataDir();
  // The case an application hits by forgetting `init()`, or by having its configuration rejected —
  // `init()` returns false on an invalid client token, and never constructs the bridge handler.
  // Monitoring is off, but the application must be untouched.
  const { electronApp, window } = await launchAppManually(intake, userDataDir, 'skip');

  try {
    expect(await window.title()).toBeTruthy();

    const bridge = await readBridge(window);
    expect(bridge).not.toBeNull();
    expect(bridge?.sessionId).toBe('');
    expect(bridge?.anonymousId).toBe('');
  } finally {
    await electronApp.close();
    await cleanupUserDataDir(userDataDir);
  }
});

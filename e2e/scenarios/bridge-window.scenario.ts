import { test, expect } from '../lib/helpers';
import type { RumViewEvent, RumErrorEvent, TelemetryErrorEvent } from '@flashcatcloud/electron-sdk';

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

function isBridgeView(event: { body: unknown }): boolean {
  return (event.body as RumViewEvent).view.url !== 'electron://main-process';
}

test.describe('bridge window — file:// window', () => {
  test('renderer RUM view events arrive at the intake via the bridge', async ({ electronApp, mainPage, intake }) => {
    // Flush the initial main-process view
    await mainPage.flushTransport();
    await intake.getEventsByType('view');

    await mainPage.openBridgeFileWindow(electronApp);
    await mainPage.flushTransport();

    const bridgeViews = await intake.waitForEventCount('view', 1, { predicate: isBridgeView });
    const view = bridgeViews[0].body as RumViewEvent;

    expect(view.view.url).toContain('bridge-window.html');
    expect(view.session.id).toBeDefined();
  });
});

test.describe('bridge window — http:// window', () => {
  test('renderer RUM view events arrive at the intake via the bridge', async ({ electronApp, mainPage, intake }) => {
    await mainPage.flushTransport();
    await intake.getEventsByType('view');

    await mainPage.openBridgeHttpWindow(electronApp);
    await mainPage.flushTransport();

    const bridgeViews = await intake.waitForEventCount('view', 1, { predicate: isBridgeView });
    const view = bridgeViews[0].body as RumViewEvent;

    expect(view.view.url).toMatch(/^http:\/\/localhost:\d+/);
    expect(view.session.id).toBeDefined();
  });
});

test.describe('bridge window — contextIsolation: false', () => {
  test('renderer RUM view events arrive when contextIsolation is disabled', async ({
    electronApp,
    mainPage,
    intake,
  }) => {
    await mainPage.flushTransport();
    await intake.getEventsByType('view');

    await mainPage.openBridgeFileWindowNoIsolation(electronApp);
    await mainPage.flushTransport();

    const bridgeViews = await intake.waitForEventCount('view', 1, { predicate: isBridgeView });
    const view = bridgeViews[0].body as RumViewEvent;

    expect(view.view.url).toContain('bridge-window.html');
    expect(view.session.id).toBeDefined();
  });
});

test.describe('bridge window — event types', () => {
  test('renderer view events have correct attributes', async ({ electronApp, mainPage, intake }) => {
    await mainPage.flushTransport();
    const mainViewEvents = await intake.getEventsByType('view');
    const mainView = mainViewEvents[0].body as RumViewEvent;

    await mainPage.openBridgeFileWindow(electronApp);
    await mainPage.flushTransport();

    const bridgeViews = await intake.waitForEventCount('view', 1, { predicate: isBridgeView });
    const view = bridgeViews[0].body as RumViewEvent;

    // Session attributes come from the main process (assembly hooks)
    expect(view.session.id).toBe(mainView.session.id);
    expect(view.application.id).toBe('e2e-test-app-id');
    expect(view.service).toBe('e2e-renderer');

    // View attributes come from the renderer's browser-rum
    expect(view.view.id).toBeDefined();
    expect(view.view.id).not.toBe(mainView.view.id);

    // `source` stays `browser` — the renderer assembled the event. The reliable proof that the
    // bridge is doing the work (rather than browser-rum falling back to a direct upload) is
    // `container.source` plus the shared session id asserted above.
    expect(view.source).toBe('browser');
    expect(view.container?.source).toBe('electron');
    expect(view.container?.view.id).toBe(mainView.view.id);
  });

  test('renderer error events are captured with correct attributes', async ({ electronApp, mainPage, intake }) => {
    await mainPage.flushTransport();
    const mainViewEvents = await intake.getEventsByType('view');
    const mainView = mainViewEvents[0].body as RumViewEvent;

    const bridgeWindowPage = await mainPage.openBridgeFileWindow(electronApp);

    // Throw an error in the renderer — browser-rum captures it via the bridge
    const errorMessage = 'renderer test error';
    await bridgeWindowPage.generateError(errorMessage);
    await mainPage.flushTransport();

    const errorEvents = await intake.waitForEventCount('error', 1, {
      timeout: 10_000,
      predicate: (e) => (e.body as RumErrorEvent).error.message === errorMessage,
    });
    const error = errorEvents[0].body as RumErrorEvent;

    expect(error.error.source).toBe('source');
    // Session from main process
    expect(error.session.id).toBe(mainView.session.id);
  });

  test('renderer resource events are captured', async ({ electronApp, mainPage, intake }) => {
    // Use http:// window so fetch works (file:// has CORS restrictions)
    const bridgeWindowPage = await mainPage.openBridgeHttpWindow(electronApp);

    await bridgeWindowPage.generateResource();
    await mainPage.flushTransport();

    const resourceEvents = await intake.getEventsByType('resource');
    expect(resourceEvents.length).toBeGreaterThanOrEqual(1);
  });
});

test.describe('bridge window — identifiers', () => {
  test('the bridge answers with the identifiers the main process owns', async ({ electronApp, mainPage, intake }) => {
    await mainPage.flushTransport();
    const mainView = (await intake.getEventsByType('view'))[0].body as RumViewEvent;

    const bridgeWindowPage = await mainPage.openBridgeFileWindow(electronApp);

    expect(await bridgeWindowPage.getSessionId()).toBe(mainView.session.id);
    expect(await bridgeWindowPage.getAnonymousId()).toMatch(UUID_PATTERN);
    // One device, one id: what the bridge hands the renderer is what the main process stamps on
    // its own events, so both halves of a session count as the same user.
    expect(await bridgeWindowPage.getAnonymousId()).toBe(mainView.usr?.anonymous_id);
  });

  test("the SDK's bridge is the one the page sees, not dd-trace's", async ({ electronApp, mainPage }) => {
    // With context isolation off, both scripts would write to the same `window`, so the bridge the
    // page ends up with is whichever ran last. Identifiers only the SDK's script knows about prove
    // dd-trace's was superseded rather than merely outrun.
    const bridgeWindowPage = await mainPage.openBridgeFileWindowNoIsolation(electronApp);

    expect(await bridgeWindowPage.getAnonymousId()).toMatch(UUID_PATTERN);
  });

  test('the same anonymous id is served to every renderer', async ({ electronApp, mainPage }) => {
    const firstWindow = await mainPage.openBridgeFileWindow(electronApp);
    const secondWindow = await mainPage.openBridgeHttpWindow(electronApp);

    expect(await secondWindow.getAnonymousId()).toBe(await firstWindow.getAnonymousId());
  });

  test('the bridge still declares no capability — the renderer keeps owning its recorder', async ({
    electronApp,
    mainPage,
  }) => {
    const bridgeWindowPage = await mainPage.openBridgeFileWindow(electronApp);

    await expect(bridgeWindowPage.getCapabilities()).resolves.toBe('[]');
  });
});

test.describe('bridge window — session expiry', () => {
  test('an expired session is reported to renderers as no session at all', async ({ electronApp, mainPage }) => {
    const bridgeWindowPage = await mainPage.openBridgeFileWindow(electronApp);
    expect(await bridgeWindowPage.getSessionId()).toMatch(UUID_PATTERN);

    await mainPage.stopSession();

    // An empty answer, never the id the session had a moment ago. The renderer's Browser SDK reads
    // it as "the host has no session right now" and stops attributing data — Session Replay
    // segments in particular, which it uploads itself rather than handing to the main process, so
    // nothing here could discard them after the fact.
    await expect.poll(() => bridgeWindowPage.getSessionId()).toBe('');
  });
});

test.describe('bridge window — session renewal', () => {
  // Renewal is driven by a real click in the main window, which only becomes an end-user activity
  // once browser-rum runs there.
  test.use({ rumBrowserSdk: {} });

  test('a renewed session id reaches renderers that are already open', async ({ electronApp, mainPage, intake }) => {
    const bridgeWindowPage = await mainPage.openBridgeFileWindow(electronApp);
    const firstSessionId = await bridgeWindowPage.getSessionId();
    expect(firstSessionId).toMatch(UUID_PATTERN);

    await mainPage.renewSession();
    await mainPage.generateTelemetryError();
    await mainPage.flushTransport();

    const telemetryEvents = await intake.getEventsByType('telemetry');
    const renewedSessionId = (telemetryEvents[telemetryEvents.length - 1].body as TelemetryErrorEvent).session?.id;
    expect(renewedSessionId).toMatch(UUID_PATTERN);
    expect(renewedSessionId).not.toBe(firstSessionId);

    // The renderer never asks for it: the main process pushes it over the identity channel.
    await expect.poll(() => bridgeWindowPage.getSessionId()).toBe(renewedSessionId);
  });
});

import { test, expect } from '../lib/helpers';
import type { TelemetryErrorEvent } from '@flashcatcloud/electron-sdk';

test.use({ rumBrowserSdk: {} });

test('new session id is generated when renewing a session', async ({ mainPage, intake }) => {
  await mainPage.generateTelemetryError();
  await mainPage.flushTransport();

  const firstEvents = await intake.getEventsByType('telemetry');
  const firstSessionId = (firstEvents[0].body as TelemetryErrorEvent).session?.id;
  expect(firstSessionId).toMatch(/^[0-9a-f-]+$/);

  await mainPage.renewSession();
  await mainPage.generateTelemetryError();
  await mainPage.flushTransport();

  const allEvents = await intake.waitForEventCount('telemetry', 2);
  const secondSessionId = (allEvents[1].body as TelemetryErrorEvent).session?.id;
  expect(secondSessionId).toMatch(/^[0-9a-f-]+$/);

  expect(secondSessionId).not.toBe(firstSessionId);
});

/**
 * Renewal must not depend on what a renderer chooses to report.
 *
 * With `trackUserInteractions` off the Browser SDK records no click actions at all, so a host that
 * renewed from those would never renew again after its first timeout — and the application would
 * go quiet for good, with nothing in the configuration hinting at why.
 */
test.describe('renewal when the renderer reports no actions', () => {
  test.use({ rumBrowserSdk: { trackUserInteractions: false } });

  test('a click still renews the session', async ({ mainPage, intake }) => {
    await mainPage.generateTelemetryError();
    await mainPage.flushTransport();
    const firstSessionId = ((await intake.getEventsByType('telemetry'))[0].body as TelemetryErrorEvent).session?.id;
    expect(firstSessionId).toMatch(/^[0-9a-f-]+$/);

    await mainPage.renewSession();
    await mainPage.generateTelemetryError();
    await mainPage.flushTransport();

    const allEvents = await intake.waitForEventCount('telemetry', 2);
    const secondSessionId = (allEvents[1].body as TelemetryErrorEvent).session?.id;
    expect(secondSessionId).toMatch(/^[0-9a-f-]+$/);
    expect(secondSessionId).not.toBe(firstSessionId);
  });
});

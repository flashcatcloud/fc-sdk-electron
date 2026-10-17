/**
 * The wire contract between the SDK and the FlashCat intake.
 *
 * FlashCat's ingest differs from Datadog's on three points, and each one was a real bug during the
 * fork: it answers `400` to a JSON-array body, `400` to `application/json`, and 404s any track
 * other than `/api/v2/rum`. The SDK retries a failed upload forever, so a breach is invisible in
 * the RUM data — the batch simply never lands. Every other scenario relies on this one to prove
 * that the events it asserts on were actually accepted.
 */
import { test, expect } from '../lib/helpers';

test('uploads to /api/v2/rum as newline-delimited JSON with a text/plain content type', async ({
  mainPage,
  intake,
}) => {
  await mainPage.flushTransport();
  // Several event types in one batch, so a multi-line NDJSON body is exercised rather than a
  // single-line one — a JSON array body only fails to parse once there is more than one event.
  await mainPage.generateManualError();
  await mainPage.startOperation('checkout');
  await mainPage.succeedOperation('checkout');
  await mainPage.flushTransport();

  const events = await intake.waitForEventCount('vital', 2);

  expect(intake.getProtocolViolations()).toEqual([]);
  expect(events[0].headers['content-type']).toBe('text/plain;charset=UTF-8');
  expect(events[0].headers['dd-api-key']).toBe('test-client-token');
  // The intake reads the environment from the request's tags, not from the events.
  expect(events[0].params.ddtags).toBe('env:test');
  expect(events[0].headers['user-agent']).toBeTruthy();

  // Every event arrived as its own JSON object, not wrapped in an array.
  for (const event of intake.getAllEvents()) {
    expect(Array.isArray(event.body)).toBe(false);
    expect(typeof event.body).toBe('object');
  }
});

test('flags a value the real intake would fail to decode into an integer, and nothing else', async ({ intake }) => {
  // Straight to the fake intake, bypassing the SDK: this pins the oracle itself, not the bridge
  // in front of it. Each line is one event, as the SDK sends them.
  const events = [
    { type: 'error', date: '1700000000000', error: { message: 'string date' } },
    { type: 'view', date: 1700000000000, view: { id: 'v', custom_timings: { boot: 1.5 } } },
    { type: 'view', date: 1700000000000, view: { id: 'v', custom_timings: { boot: 15 } } },
    { type: 'error', date: 1700000000000, error: { message: 'priced' }, context: { price: 19.99 } },
  ];
  const response = await fetch(`http://127.0.0.1:${intake.getPort()}/api/v2/rum?ddforward=%2Fapi%2Fv2%2Frum`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
    body: events.map((event) => JSON.stringify(event)).join('\n'),
  });

  expect(response.status).toBe(202);
  expect(intake.getProtocolViolations().map((violation) => `${violation.reason}: ${violation.detail}`)).toEqual([
    'value the intake cannot decode into an integer: unknown/error → date = "1700000000000"',
    'value the intake cannot decode into an integer: unknown/view → view.custom_timings.boot = 1.5',
  ]);
  intake.clear();
});

/**
 * Main-process HTTP calls surface as RUM `resource` events.
 *
 * The upstream version of this file also asserted that each resource had a matching span on the
 * `spans` track. FlashCat exposes no `/api/v2/spans` intake, so the SPANS track was removed from
 * `Transport` — see the comment there. Trace correlation is still asserted through the
 * `_dd.trace_id` / `_dd.span_id` the resource event carries, and `intake-contract.scenario.ts`
 * asserts that nothing is ever POSTed to a span endpoint.
 */
import { test, expect } from '../lib/helpers';
import type { RumResourceEvent, RumViewEvent } from '@flashcatcloud/electron-sdk';

test('emits a resource event for a main-process fetch', async ({ mainPage, intake, testServer }) => {
  await mainPage.flushTransport();
  const viewEvents = await intake.getEventsByType('view');
  const view = viewEvents[0].body as RumViewEvent;

  const url = testServer.urlFor(200);
  await mainPage.mainFetch(url);
  await mainPage.flushTransport();

  const resourceEvents = await intake.getEventsByType('resource');
  expect(resourceEvents).toHaveLength(1);

  const resource = resourceEvents[0].body as RumResourceEvent;
  // The date is derived from a dd-trace span start, which is a nanosecond count that is not a
  // whole number of milliseconds. The intake decodes `date` into an int64 and Go drops the event
  // on a fractional number — silently, since the `202` is sent before decoding.
  expect(Number.isInteger(resource.date)).toBe(true);
  expect(intake.getProtocolViolations()).toEqual([]);
  expect(resource.resource.method).toBe('GET');
  expect(resource.resource.status_code).toBe(200);
  expect(resource.resource.url).toBe(url);
  expect(resource.application.id).toBe(view.application.id);
  expect(resource.session.id).toBe(view.session.id);
  expect(resource.view.id).toBe(view.view.id);
  expect(resource._dd.trace_id).toBeDefined();
  expect(resource._dd.span_id).toBeDefined();
});

test('emits a resource event for a main-process http.request', async ({ mainPage, intake, testServer }) => {
  await mainPage.flushTransport();
  const viewEvents = await intake.getEventsByType('view');
  const view = viewEvents[0].body as RumViewEvent;

  const url = testServer.urlFor(404);
  await mainPage.mainHttpRequest(url);
  await mainPage.flushTransport();

  const resourceEvents = await intake.getEventsByType('resource');
  expect(resourceEvents).toHaveLength(1);

  const resource = resourceEvents[0].body as RumResourceEvent;
  expect(resource.resource.method).toBe('GET');
  expect(resource.resource.status_code).toBe(404);
  expect(resource.resource.url).toBe(url);
  expect(resource.application.id).toBe(view.application.id);
  expect(resource.session.id).toBe(view.session.id);
  expect(resource.view.id).toBe(view.view.id);
  expect(resource._dd.trace_id).toBeDefined();
  expect(resource._dd.span_id).toBeDefined();
});

test('emits a resource event for a main-process net.request', async ({ mainPage, intake, testServer }) => {
  await mainPage.flushTransport();
  const viewEvents = await intake.getEventsByType('view');
  const view = viewEvents[0].body as RumViewEvent;

  const url = testServer.urlFor(500);
  await mainPage.mainNetRequest(url);
  await mainPage.flushTransport();

  const resourceEvents = await intake.getEventsByType('resource');
  expect(resourceEvents).toHaveLength(1);

  const resource = resourceEvents[0].body as RumResourceEvent;
  expect(resource.resource.method).toBe('GET');
  expect(resource.resource.status_code).toBe(500);
  expect(resource.resource.url).toBe(url);
  expect(resource.application.id).toBe(view.application.id);
  expect(resource.session.id).toBe(view.session.id);
  expect(resource.view.id).toBe(view.view.id);
  expect(resource._dd.trace_id).toBeDefined();
  expect(resource._dd.span_id).toBeDefined();
});

/**
 * Guard for partial flushing, not an observation.
 *
 * dd-trace only hands a trace to its exporter once every span it started has finished, so one
 * request that never comes back used to withhold the resource events of every sibling request made
 * from the same IPC handler — silently and for the rest of the process' life. `flushMinSpans: 1`
 * (see `src/entries/instrument.ts`) is what lets the finished ones leave on their own. Drop it and
 * this test times out waiting for the resource event.
 */
test('emits the resource event of a completed request whose sibling never returns', async ({
  mainPage,
  intake,
  testServer,
}) => {
  await mainPage.flushTransport();
  await intake.getEventsByType('view');

  const url = testServer.urlFor(200);
  const status = await mainPage.mainFetchWithPendingSibling(url, testServer.urlForHang());
  expect(status).toBe(200);
  await mainPage.flushTransport();

  const resourceEvents = await intake.getEventsByType('resource');
  expect(resourceEvents).toHaveLength(1);

  const resource = resourceEvents[0].body as RumResourceEvent;
  expect(resource.resource.url).toBe(url);
  expect(resource.resource.status_code).toBe(200);
  expect(intake.getProtocolViolations()).toEqual([]);
});

test('does not emit a resource event for SDK intake traffic', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  await intake.getEventsByType('view');

  const intakeUrl = `http://localhost:${intake.getPort()}/api/v2/rum`;
  await mainPage.mainHttpRequest(intakeUrl);
  await mainPage.flushTransport();

  await intake.assertNoNewEvents('resource');
});

/**
 * IPC spans — the SPANS track is intentionally not uploaded.
 *
 * Upstream, `mainPing()` produced an `electron.main.handle` span that was asserted on the
 * `spans` track. FlashCat exposes no `/api/v2/spans` intake, so `Transport` registers the RUM
 * track only and span envelopes are dropped before transport. dd-trace still runs — HTTP spans
 * become RUM `resource` events (see `resource.scenario.ts`) — but non-HTTP spans such as IPC
 * handlers have no observable output today.
 *
 * This file therefore pins the *decision* rather than the removed capability: exercising IPC must
 * not produce any upload to a track that does not exist, and must not disturb RUM collection. If
 * a spans intake ships later, restore the upstream assertions from `bd4ff29`.
 */
import { test, expect } from '../lib/helpers';
import type { RumViewEvent } from '@flashcatcloud/electron-sdk';

test('an instrumented IPC call produces no upload outside the RUM track', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  const viewEvents = await intake.getEventsByType('view');
  const view = viewEvents[0].body as RumViewEvent;

  expect(await mainPage.mainPing()).toBe('pong');
  await mainPage.flushTransport();

  // Any POST to a path other than /api/v2/rum is recorded as a protocol violation by the intake.
  expect(intake.getProtocolViolations()).toEqual([]);

  // RUM collection is unaffected: the view is still the only view event.
  const viewsAfter = await intake.getEventsByType('view');
  expect(viewsAfter).toHaveLength(1);
  expect((viewsAfter[0].body as RumViewEvent).view.id).toBe(view.view.id);
});

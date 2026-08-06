import { test, expect } from '../lib/helpers';
import type { RumErrorEvent, RumViewEvent } from '@flashcatcloud/electron-sdk';

const ALICE = { id: 'e2e-user-alice', name: 'Alice', email: 'alice@example.com' };

const isMainProcessView = (event: { body: unknown }) =>
  (event.body as RumViewEvent).view.url === 'electron://main-process';

const isBridgeView = (event: { body: unknown }) => (event.body as RumViewEvent).view.url !== 'electron://main-process';

/** The bridge hands the identity over as JSON; `'{}'` means nobody is logged in. */
const parseBridgeUser = (json: string) => JSON.parse(json) as Record<string, string>;

test.describe('setUser — main process events', () => {
  test('reports no usr.id until the application identifies the user', async ({ mainPage, intake }) => {
    await mainPage.flushTransport();

    const view = (await intake.getEventsByType('view')).find(isMainProcessView)!.body as RumViewEvent;

    // The device is known, the person is not. `usr.id` has to be absent rather than backfilled
    // with the anonymous id: unique users are counted off
    // `COALESCE(NULLIF(usr_anonymous_id, ''), NULLIF(usr_id, ''))`.
    expect(view.usr?.anonymous_id).toBeTruthy();
    expect(view.usr?.id).toBeUndefined();
  });

  test('attaches the identity to subsequent events, alongside the anonymous id', async ({ mainPage, intake }) => {
    await mainPage.flushTransport();
    const before = (await intake.getEventsByType('view')).find(isMainProcessView)!.body as RumViewEvent;
    const anonymousId = before.usr?.anonymous_id;

    await mainPage.setUser(ALICE);
    await mainPage.generateManualError();
    await mainPage.flushTransport();

    const error = (await intake.waitForEventCount('error', 1))[0].body as RumErrorEvent;
    expect(error.usr?.id).toBe(ALICE.id);
    expect(error.usr?.name).toBe(ALICE.name);
    expect(error.usr?.email).toBe(ALICE.email);
    // Both identifiers travel together — this is the pair the backend counts on.
    expect(error.usr?.anonymous_id).toBe(anonymousId);
  });

  test('reads back the identity it was given', async ({ mainPage }) => {
    await mainPage.setUser(ALICE);

    expect(await mainPage.getUser()).toEqual(ALICE);
  });

  test('removes usr.id on logout without disturbing the anonymous id', async ({ mainPage, intake }) => {
    await mainPage.setUser(ALICE);
    await mainPage.generateManualError();
    await mainPage.flushTransport();
    const identified = (await intake.waitForEventCount('error', 1))[0].body as RumErrorEvent;

    await mainPage.clearUser();
    await mainPage.generateManualError();
    await mainPage.flushTransport();

    const errors = await intake.waitForEventCount('error', 2);
    const afterLogout = errors[errors.length - 1].body as RumErrorEvent;

    expect(await mainPage.getUser()).toBeFalsy();
    // Absent, not empty: `NULLIF(usr_id, '')` treats the two differently.
    expect(afterLogout.usr).not.toHaveProperty('id');
    expect(afterLogout.usr?.anonymous_id).toBe(identified.usr?.anonymous_id);
  });

  test('ignores a call without an id, keeping the identity already in force', async ({ mainPage }) => {
    await mainPage.setUser(ALICE);

    await mainPage.setUser({ name: 'Nobody' } as unknown as typeof ALICE);

    expect(await mainPage.getUser()).toEqual(ALICE);
  });
});

test.describe('setUser — renderer events over the bridge', () => {
  test('stamps the main process identity on bridged renderer events', async ({ electronApp, mainPage, intake }) => {
    await mainPage.flushTransport();
    await intake.getEventsByType('view');

    await mainPage.setUser(ALICE);
    await mainPage.openBridgeFileWindow(electronApp);
    await mainPage.flushTransport();

    const view = (await intake.waitForEventCount('view', 1, { predicate: isBridgeView }))[0].body as RumViewEvent;

    expect(view.container?.source).toBe('electron');
    expect(view.usr?.id).toBe(ALICE.id);
  });

  test('serves the identity to the renderer through the bridge', async ({ electronApp, mainPage }) => {
    await mainPage.setUser(ALICE);

    const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);

    expect(parseBridgeUser(await bridgeWindow.getUser())).toEqual(ALICE);
  });

  test('pushes a later identity change to an already open renderer', async ({ electronApp, mainPage }) => {
    const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);
    expect(await bridgeWindow.getUser()).toBe('{}');

    await mainPage.setUser(ALICE);

    await expect.poll(async () => parseBridgeUser(await bridgeWindow.getUser())).toEqual(ALICE);
  });

  test('pushes a logout to an already open renderer', async ({ electronApp, mainPage }) => {
    await mainPage.setUser(ALICE);
    const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);

    await mainPage.clearUser();

    await expect.poll(async () => bridgeWindow.getUser()).toBe('{}');
  });
});

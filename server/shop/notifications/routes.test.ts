import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { httpClient, json } from '../../test/http';
import type { HttpClient } from '../../test/http';
import type { NotificationSettings } from './repo';

/**
 * `/api/shop/admin/notification-settings` — who the shop emails when an order
 * is paid, driven through the REAL app: router, origin guard, session
 * middleware, the domain gate and `shopApp()`'s `onError`.
 *
 * THROUGH `createApp()` AND NOT A TEST APP, per CLAUDE.md §2. The gate is the
 * half most worth driving for real here: without the
 * `/api/shop/admin/notification-settings` entry in `permissions.ts` this prefix
 * falls through to the `/api/shop/admin/` catch-all, which is `danger` — the
 * screen would then work for the same two roles by accident and nothing would
 * say so until somebody widened `danger` for an unrelated reason.
 */

let ctx: TestCtx;
let http: HttpClient;

beforeAll(async () => {
  ctx = await freshDb();
  http = httpClient(ctx.db);
});

afterAll(async () => {
  await ctx?.close();
});

const PATH = '/api/shop/admin/notification-settings';

beforeEach(async () => {
  http.clearCookies();
  await ctx.db.execute(sql`
    UPDATE shop_notification_settings
       SET order_recipients = '{}', notify_team = true, notify_on_order = true,
           revision = 1, updated_by = NULL
     WHERE id = 'main'`);
});

interface Payload {
  settings: NotificationSettings;
}

async function read(): Promise<NotificationSettings> {
  const res = await http.get(PATH);
  expect(res.status).toBe(200);
  return (await json<Payload>(res)).settings;
}

describe('the guard', () => {
  it('401s without a session', async () => {
    expect((await http.get(PATH)).status).toBe(401);
    expect((await http.patch(PATH, { expectedRevision: 1, notifyTeam: false })).status).toBe(401);
  });

  /*
   * `settings` is granted to the owner and developers only (shared/roles.ts).
   * Support and supply chain hold `orders` — they RECEIVE these emails — and
   * deciding who else does is not a thing they get to change.
   */
  it('403s every role that does not hold `settings`', async () => {
    for (const who of ['writer', 'supply', 'support', 'marketing']) {
      http.clearCookies();
      await http.signIn({ email: `${who}@test.local` });
      expect((await http.get(PATH)).status).toBe(403);
      expect((await http.patch(PATH, { expectedRevision: 1, notifyTeam: false })).status).toBe(
        403,
      );
    }
  });

  it('lets a developer in — owner-grade everywhere except about each other', async () => {
    await http.signIn({ email: 'developer@test.local' });
    expect((await http.get(PATH)).status).toBe(200);
  });
});

describe('GET', () => {
  it('answers the seeded row: switched on, nobody typed in', async () => {
    await http.signIn({ email: 'owner@test.local' });
    expect(await read()).toMatchObject({
      orderRecipients: [],
      notifyTeam: true,
      notifyOnOrder: true,
      revision: 1,
      updatedBy: null,
    });
  });
});

describe('PATCH', () => {
  beforeEach(async () => {
    await http.signIn({ email: 'owner@test.local' });
  });

  it('stores a list and moves the revision', async () => {
    const res = await http.patch(PATH, {
      expectedRevision: 1,
      orderRecipients: ['ops@plaspool.com'],
    });
    expect(res.status).toBe(200);
    const { settings } = await json<Payload>(res);
    expect(settings.orderRecipients).toEqual(['ops@plaspool.com']);
    expect(settings.revision).toBe(2);
    expect(settings.updatedBy).toBe(ctx.users.owner.id);
  });

  it('changes only what it names', async () => {
    await http.patch(PATH, { expectedRevision: 1, orderRecipients: ['ops@plaspool.com'] });
    await http.patch(PATH, { expectedRevision: 2, notifyOnOrder: false });
    expect(await read()).toMatchObject({
      orderRecipients: ['ops@plaspool.com'],
      notifyTeam: true,
      notifyOnOrder: false,
    });
  });

  /*
   * ═════════════════════════════════════════════════════════════════════════
   * CLEARING THE LIST IS A SAVE. `servedRegions` one directory over 400s on
   * exactly this body, because there an empty list would shut the shop. Here
   * it means "just the team", which is what most shops mean.
   * ═════════════════════════════════════════════════════════════════════════
   */
  it('accepts an empty list rather than refusing it', async () => {
    await http.patch(PATH, { expectedRevision: 1, orderRecipients: ['ops@plaspool.com'] });
    const res = await http.patch(PATH, { expectedRevision: 2, orderRecipients: [] });
    expect(res.status).toBe(200);
    expect((await read()).orderRecipients).toEqual([]);
  });

  it('trims, and drops a second spelling of the same address', async () => {
    const res = await http.patch(PATH, {
      expectedRevision: 1,
      orderRecipients: ['  Ops@Plaspool.com  ', 'ops@plaspool.com', 'packing@plaspool.com'],
    });
    expect(res.status).toBe(200);
    expect((await json<Payload>(res)).settings.orderRecipients).toEqual([
      'Ops@Plaspool.com',
      'packing@plaspool.com',
    ]);
  });

  /* A 400 naming the field, not a CHECK violation surfacing as a 500. */
  it('refuses something that is not plausibly an address', async () => {
    const res = await http.patch(PATH, {
      expectedRevision: 1,
      orderRecipients: ['Jane Okafor'],
    });
    expect(res.status).toBe(400);
    expect((await read()).orderRecipients).toEqual([]);
  });

  /* Two settings tabs must not quietly overwrite each other. */
  it('409s a save based on a revision somebody else has already moved', async () => {
    expect((await http.patch(PATH, { expectedRevision: 1, notifyTeam: false })).status).toBe(200);
    const stale = await http.patch(PATH, { expectedRevision: 1, notifyTeam: true });
    expect(stale.status).toBe(409);
    expect((await read()).notifyTeam).toBe(false);
  });

  it('refuses a key it has never heard of', async () => {
    expect(
      (await http.patch(PATH, { expectedRevision: 1, notifyOnOrders: false })).status,
    ).toBe(400);
  });

  it('refuses a save with no expectedRevision at all', async () => {
    expect((await http.patch(PATH, { notifyTeam: false })).status).toBe(400);
  });

  /*
   * ═════════════════════════════════════════════════════════════════════════
   * THE EMPTY ROW A LIST EDITOR LEAVES BEHIND IS A SAVE, NOT A 400.
   *
   * A list editor gives an operator a blank field the moment they press "add
   * another", and half the time they change their mind and press Save with it
   * still there. `normalizeRecipients` drops it on purpose — its own comment
   * says refusing it would make the screen unsavable for a reason the operator
   * cannot see — and that decision is only reachable if the request schema lets
   * the blank string through. It did not: `RECIPIENT` carried a `.min(3)`, and
   * Zod applies `.trim()` BEFORE `.min()`, so the empty row was a 400 on the
   * whole save before the repo ever ran. The floor is gone; this is the test
   * that keeps it gone.
   * ═════════════════════════════════════════════════════════════════════════
   */
  it('drops a blank entry rather than refusing the whole save', async () => {
    const res = await http.patch(PATH, {
      expectedRevision: 1,
      orderRecipients: ['ops@plaspool.com', ''],
    });
    expect(res.status).toBe(200);
    expect((await json<Payload>(res)).settings.orderRecipients).toEqual(['ops@plaspool.com']);
    /* Read back, because what the response says and what the column holds are
       two different claims and the CHECK forbids an empty element. */
    expect((await read()).orderRecipients).toEqual(['ops@plaspool.com']);
  });

  /* The ceiling is there so a megabyte of text never reaches the repo. There is
     no floor to go with it — see `RECIPIENT` in routes.ts — so `"  a  "` is
     refused by the repo's plausible-address check instead, which is the same
     400 reached by the rule that lets the blank row above through. */
  it('refuses an address that is one character, and a list of 51', async () => {
    expect((await http.patch(PATH, { expectedRevision: 1, orderRecipients: ['  a  '] })).status)
      .toBe(400);
    const many = Array.from({ length: 51 }, (_, i) => `ops${i}@plaspool.com`);
    expect((await http.patch(PATH, { expectedRevision: 1, orderRecipients: many })).status).toBe(
      400,
    );
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SEED_PASSWORD, freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { httpClient, json } from '../../test/http';
import type { HttpClient } from '../../test/http';
import { resetOrderTables } from '../orders/test/harness';
import { CHECKOUT, checkoutCompleted, insertEvents } from '../orders/test/fixtures';

/**
 * THE SHAPE OF `GET /api/shop/admin/orders`, ASSERTED WHERE IT IS DECIDED.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT COVERED BY THE SUITE THAT ALREADY
 * TESTS THIS ROUTE.
 *
 * The order list on the admin screen went down in production and stayed down.
 * The client had declared the response `Page<ShopOrder>` — flat orders — while
 * the server has only ever sent `{ items: [{ order, lines }] }`; `shopFetch<T>`
 * is an unchecked assertion, so nothing anywhere compared the two names to the
 * bytes. The screen read `placedAt` off the wrapper, got `undefined`, handed it
 * to `Intl.DateTimeFormat.format`, and the `RangeError` took the whole route to
 * its error boundary. Eleven client tests passed throughout, because their
 * fixture was flat too: a fixture and a client type that agree with each other
 * and with nothing else.
 *
 * `src/routes/ShopOrders.test.tsx` fixed the client half by replaying a VERBATIM
 * CAPTURE of the production response, and it pins the screen hard. What it
 * cannot do — and what its comment used to claim it did — is fail when the
 * SERVER moves. A capture is a static file. Its shape assertions compare it to
 * string literals, which is to say to itself, so the route could be rewritten
 * tomorrow and that file would go on passing against yesterday's bytes.
 *
 * THIS IS THE OTHER HALF, AND IT IS THE HALF CLAUDE.md §2 ASKS FOR BY NAME:
 * "Anything money-adjacent needs a test through the real `createApp()`." Every
 * request below goes through `httpClient`, which builds the deployed app —
 * router, origin guard, session middleware, error handler, the real mounting of
 * the orders router under `/api/shop` — so what is asserted is the payload a
 * browser would receive rather than a payload a repository function returns.
 * The order it reads is not seeded by hand either: a `checkout.completed` row
 * goes into `commerce_events` and `POST /api/shop/admin/sweep` drains it, which
 * is the production write path (CLAUDE.md §6), driven the production way.
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT is anything about how the list is
 * ordered, paged, filtered or aggregated. `server/shop/orders/routes.test.ts`
 * and `server/shop/admin/routes.test.ts` own all of that and own it in detail.
 * The single question here is the one that cost a day of the shop being
 * unreadable: WHERE IN THE PAYLOAD DOES AN ORDER LIVE. A test that also asserted
 * the interesting behaviour would fail for interesting reasons and stop being
 * read as the answer to that question.
 * ═══════════════════════════════════════════════════════════════════════════
 */

let ctx: TestCtx;
let owner: HttpClient;

beforeAll(async () => {
  ctx = await freshDb();
  /*
   * Logged in ONCE, as `server/shop/admin/routes.test.ts` explains: login is
   * rate limited per (ip, email) in Postgres rather than in module memory, so a
   * suite that logs in per test starts answering 429 and every later case fails
   * with a status that has nothing to do with what it was asserting.
   */
  owner = httpClient(ctx.db);
  const login = await owner.post('/api/auth/login', {
    email: ctx.users.owner.email,
    password: SEED_PASSWORD,
  });
  expect(login.status).toBe(200);
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await resetOrderTables(ctx.db);
});

/**
 * One real order, written the way production writes one.
 *
 * NOT AN `INSERT INTO shop_orders`. The columns this test reads back are the
 * ones the consumer chooses when it copies a frozen checkout — `placed_at` above
 * all — and a hand-built row is a second author's opinion of what belongs in
 * them. The event goes in, the sweep route drains it, and the order that comes
 * out is the consumer's own.
 */
async function placeOneOrder(): Promise<void> {
  await insertEvents(ctx.db, [checkoutCompleted()]);
  const swept = await owner.post('/api/shop/admin/sweep', {});
  expect(swept.status).toBe(200);
}

/** The page, as a browser would parse it: no type asserted over the wire. */
interface ListBody {
  items: Record<string, unknown>[];
  nextCursor: unknown;
}

describe('GET /api/shop/admin/orders, through the real app', () => {
  it('nests each order under `order`, with its lines beside it — never flat', async () => {
    await placeOneOrder();

    const res = await owner.get('/api/shop/admin/orders');
    expect(res.status).toBe(200);
    const page = await json<ListBody>(res);

    expect(Array.isArray(page.items)).toBe(true);
    expect(page.items).toHaveLength(1);

    /*
     * EXACTLY THESE TWO KEYS, not "at least". `toEqual` on the sorted key list
     * rather than two `toHaveProperty` calls, because the defect this guards
     * against is a THIRD shape appearing — a route that starts spreading the
     * order up to the top level "for convenience" would satisfy every
     * property-exists assertion while giving the client two places to read
     * `placedAt` from and no reason to prefer either.
     */
    const row = page.items[0];
    expect(Object.keys(row).sort()).toEqual(['lines', 'order']);

    /*
     * THE TWO FIELDS THAT ACTUALLY DIED, NAMED. `placedAt` is what reached
     * `Intl.DateTimeFormat` as `undefined`, and `orderNumber` is what the first
     * column of the list renders. Asserting their ABSENCE at the top level is
     * what makes this test the one that would have caught the outage: a flat
     * payload passes every assertion above it and fails here.
     */
    expect(row).not.toHaveProperty('placedAt');
    expect(row).not.toHaveProperty('orderNumber');

    const order = row.order as Record<string, unknown>;
    // A NUMBER, not a bigint-shaped string. PGlite is configured to hand int8
    // back as a string exactly as Neon does, so this assertion is real here.
    expect(typeof order.placedAt).toBe('number');
    expect(Number.isFinite(order.placedAt as number)).toBe(true);
    expect(order.checkoutId).toBe(CHECKOUT);

    // `lines` beside the order and not inside it: the list aggregates them in
    // the same statement that fetches the page, and `fulfilledQty` is the only
    // fulfilment signal this endpoint carries.
    const lines = row.lines as Record<string, unknown>[];
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(typeof line.fulfilledQty).toBe('number');
  });

  it('carries `nextCursor` on the page, not on the rows', async () => {
    // The client's `Page<T>` reads this at the top level. It is `null` rather
    // than absent on a short page — "no more" is an answer, and an omitted key
    // would make "the server did not say" indistinguishable from it.
    await placeOneOrder();

    const page = await json<ListBody>(await owner.get('/api/shop/admin/orders'));

    expect(Object.keys(page).sort()).toEqual(['items', 'nextCursor']);
    expect(page.nextCursor).toBeNull();
  });

  it('sends the same wrapper for an empty list, not a bare array', async () => {
    /*
     * The empty page is where a shape regression is easiest to ship unnoticed:
     * a route that returned `[]` here would satisfy every screen that only ever
     * renders `items.map(...)` on a store with no orders yet, and break on the
     * first sale.
     */
    const page = await json<ListBody>(await owner.get('/api/shop/admin/orders'));

    expect(Array.isArray(page)).toBe(false);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

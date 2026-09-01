/**
 * The cron entry point, and the two things about it that are easy to get wrong
 * in a way nothing notices.
 *
 * ═══ WHAT VERCEL ACTUALLY DOES (docs, read rather than remembered) ═══
 * - It issues an **HTTP GET** to the path in `vercel.json`. Not POST.
 * - It sends `Authorization: Bearer $CRON_SECRET` **only if** that environment
 *   variable is set on the project.
 * - **Hobby plans are limited to once per day.** A more frequent expression
 *   FAILS DEPLOYMENT: "Hobby accounts are limited to daily cron jobs."
 * - Hobby invocations land anywhere inside the named hour (±59 min).
 * - "If you create a cron job for a path that doesn't exist, it generates a 404
 *   error. However, Vercel still executes your cron job." — i.e. a typo'd path
 *   is a job that runs forever and does nothing, with a green tick beside it.
 * - Delivery is best effort and MAY DUPLICATE, so the work must be idempotent.
 *
 * Three of those five are silent failures, so three of them get a test here.
 */
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDb, resetShopTables } from './test/harness';
import { resetOrderTables } from '../orders/test/harness';
import { httpClient, json } from '../../test/http';
import { createApp } from '../../index';
import { CRON_PATH } from './routes/checkout';
import { checkoutCompleted, insertEvents, CHECKOUT } from '../orders/test/fixtures';
import { readOrderByCheckout } from '../orders/repo/orders';
import type { HttpClient } from '../../test/http';
import type { TestCtx } from './test/harness';

let ctx: TestCtx;
let client: HttpClient;

const SECRET = 'a-test-cron-secret-at-least-16-chars';

beforeAll(async () => {
  ctx = await freshDb();
});
afterAll(() => ctx.close());

beforeEach(async () => {
  await resetShopTables(ctx.db);
  // Orders' tables too, now that this cron drives Orders' consumer: its
  // consumption ledger outlives `resetShopTables` and would make the second test
  // in a file find every event already handled.
  await resetOrderTables(ctx.db);
  await ctx.db.execute(sql`TRUNCATE shop_products, shop_inventory_holds CASCADE`);
  process.env.CRON_SECRET = SECRET;
  client = httpClient(ctx.db);
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

describe('the cron endpoint', () => {
  it('runs maintenance for a GET carrying the right bearer token', async () => {
    /*
     * GET, AND THAT IS THE PLATFORM'S CHOICE RATHER THAN A DESIGN ONE. A GET
     * that mutates is not something to be pleased about, but Vercel issues only
     * GET for a cron and an endpoint it cannot invoke is an endpoint that does
     * nothing. The `Authorization` check is what stands in for the safety a
     * POST would have had — and note that `originGuard` lets every GET through
     * (`SAFE_METHODS`), so this token is the ONLY thing in front of it.
     */
    const res = await client.get(CRON_PATH, bearer(SECRET));

    expect(res.status).toBe(200);
    expect(await json<{ drain: unknown; sweep: unknown }>(res)).toEqual({
      drain: { scanned: 0, applied: 0, ignored: 0, parked: 0, abandoned: 0 },
      sweep: { released: 0, failed: 0 },
      // ONE pass, because the outbox was already empty — the loop's only clean
      // exit. `exhausted` false means it finished the work, not the budget.
      passes: 1,
      exhausted: false,
      /*
       * THE SECOND HALF OF THE SAME CRON (admin#29), and it is asserted here
       * rather than only in its own block below because this is the test that
       * pins the WHOLE response shape. Zero of everything on an empty outbox,
       * and ONE pass — `drainCommerceEvents` stops the moment a pass makes no
       * progress, which on an empty table is the first one.
       */
      events: { applied: 0, ignored: 0, parked: 0, passes: 1 },
    });
  });

  it('401s a GET with no Authorization header at all', async () => {
    expect((await client.get(CRON_PATH)).status).toBe(401);
  });

  it('401s a GET with the wrong token', async () => {
    expect((await client.get(CRON_PATH, bearer('not-the-secret'))).status).toBe(401);
  });

  it('401s a token of a different LENGTH, without leaking which', async () => {
    // The comparison is length-guarded before it is timing-safe, and both
    // answers are the same 401 with the same body.
    const short = await client.get(CRON_PATH, bearer('short'));
    const long = await client.get(CRON_PATH, bearer(`${SECRET}-and-more`));
    expect(short.status).toBe(401);
    expect(long.status).toBe(401);
    // The `error` alone, not the whole body: every response carries its own
    // `requestId`, which is the one field that is SUPPOSED to differ.
    expect((await json<{ error: string }>(short)).error).toBe('unauthenticated');
    expect((await json<{ error: string }>(long)).error).toBe('unauthenticated');
  });

  it('FAILS CLOSED when CRON_SECRET is not configured', async () => {
    /*
     * THE ONE THAT WOULD HAVE BEEN A PUBLIC ENDPOINT. Vercel sends the
     * `Authorization` header only when `CRON_SECRET` is set on the project. A
     * check written as "if a secret is configured, compare it" therefore lets
     * EVERY request through on a deployment that has not set one — which is the
     * default state of a new project, and of every preview deployment.
     *
     * `originGuard` waves GET through from any origin, so on such a deployment
     * this path would be an unauthenticated way for a stranger to make the shop
     * call `CatalogPort` a few hundred times.
     */
    delete process.env.CRON_SECRET;

    expect((await client.get(CRON_PATH)).status).toBe(401);
    expect((await client.get(CRON_PATH, bearer(''))).status).toBe(401);
    expect((await client.get(CRON_PATH, bearer(SECRET))).status).toBe(401);
  });

  it('does not accept a session cookie in place of the token', async () => {
    // A signed-in writer is not a cron. Keeping the two credentials separate is
    // what stops a leaked session becoming a way to drive maintenance, and what
    // stops the cron token becoming a general-purpose admin credential.
    await client.signIn({ email: 'owner@test.local' });
    expect((await client.get(CRON_PATH)).status).toBe(401);
  });

  it('still lets an operator run it by hand with a session, over POST', async () => {
    await client.signIn({ email: 'owner@test.local' });
    expect((await client.post(CRON_PATH)).status).toBe(200);
  });

  it('is idempotent, because cron delivery may duplicate a run', async () => {
    // Vercel: "Cron delivery can also occasionally invoke the same scheduled run
    // more than once." Both halves are already idempotent — the consumption
    // ledger and the `state = 'held'` guards — and this asserts it at the edge.
    const first = await client.get(CRON_PATH, bearer(SECRET));
    const second = await client.get(CRON_PATH, bearer(SECRET));
    expect(first.status).toBe(200);
    expect(await json(second)).toEqual(await json(first));
  });
});

describe('vercel.json actually points at this route', () => {
  const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
    crons?: Array<{ path: string; schedule: string }>;
  };

  it('declares a cron for the maintenance path', () => {
    expect(config.crons ?? []).toContainEqual(
      expect.objectContaining({ path: CRON_PATH }),
    );
  });

  it('names a path the application ACTUALLY REGISTERS', () => {
    /*
     * THE SILENT FAILURE THIS EXISTS FOR. Vercel's own documentation: "If you
     * create a cron job for a path that doesn't exist, it generates a 404 error.
     * However, Vercel still executes your cron job." So a typo — or a route
     * renamed six months from now — leaves a scheduled job that fires on time,
     * forever, and does nothing, with a green tick beside it in the dashboard.
     *
     * Checked against the router's own table rather than against a string.
     *
     * WIDENED FROM `shopApp()` TO THE WHOLE APP when the email drain became the
     * second cron. `vercel.json` is one list for the whole deployment, and this
     * loop walks all of it — so while the registered set came from the shop
     * sub-app alone, the blog-side entry below was a guaranteed failure here and
     * the only way to add it was to make this assertion less true. A test that
     * has to be weakened to let a correct change land is a test aimed at the
     * wrong table. `createApp().routes` already carries full `/api/...` paths,
     * which is why the `/api/shop` prefix this used to splice on is gone.
     */
    const registered = new Set(createApp().routes.map((r) => `${r.method} ${r.path}`));
    for (const cron of config.crons ?? []) {
      expect(registered, cron.path).toContain(`GET ${cron.path}`);
    }
  });

  it('uses a schedule the HOBBY plan will actually deploy', () => {
    /*
     * Hobby is limited to once per day and a more frequent expression FAILS THE
     * DEPLOYMENT: "Hobby accounts are limited to daily cron jobs. This cron
     * expression would run more than once per day." That is a build error rather
     * than a runtime one, so it is not silent — but it is discovered at deploy
     * time, by whoever is deploying, which is the worst moment to find it.
     *
     * Once per day means: a single fixed minute and a single fixed hour. Any
     * `*`, list, range or step in either of the first two fields runs more often.
     */
    for (const cron of config.crons ?? []) {
      const [minute, hour] = cron.schedule.split(' ');
      expect(minute, `${cron.path} minute`).toMatch(/^\d{1,2}$/);
      expect(hour, `${cron.path} hour`).toMatch(/^\d{1,2}$/);
      expect(Number(minute)).toBeLessThan(60);
      expect(Number(hour)).toBeLessThan(24);
    }
  });
});

/**
 * THE COMMERCE OUTBOX'S ONLY SCHEDULED DRAIN (admin#29).
 *
 * `vercel.json` is at the Hobby ceiling of two crons and both slots are taken
 * (`server/routes/email.ts`: "Two crons is also the Hobby ceiling; a third needs
 * a plan, not a config line"), so Orders' sweep is folded into this cron rather
 * than given one of its own — which is why the `vercel.json` assertions above
 * still pass with no entry added.
 *
 * Before this, NOTHING drained `commerce_events` for Orders in a deployment.
 * `orders/routes.ts` offered a `/admin/sweep` route and said of it "NOTHING
 * SCHEDULES IT YET"; production proved it, with every row sitting at
 * `processed_at = NULL, attempts = 0` — including a real customer's capture.
 *
 * THIS IS THE BACKSTOP, NOT THE PRIMARY PATH: the capture drains inline, and an
 * external cron service calls `GET /api/shop/admin/sweep` by the minute. A daily
 * run with ±59 minutes of jitter earns its place as the one caller that still
 * runs when both of those have stopped.
 *
 * Driven through `createApp()`, so it fails if `server/shop/app.ts` ever stops
 * handing `sweepEvents` to the cart router.
 */
describe('the cron drains the commerce outbox as well (admin#29)', () => {
  it('turns a pending checkout.completed into an order', async () => {
    await insertEvents(ctx.db, [checkoutCompleted()]);
    expect(await readOrderByCheckout(ctx.db, CHECKOUT)).toBeNull();

    const res = await client.get(CRON_PATH, bearer(SECRET));

    expect(res.status).toBe(200);
    const body = await json<{ events: { applied: number; passes: number } | null }>(res);
    expect(body.events).not.toBeNull();
    expect(body.events?.applied).toBe(1);

    const read = await readOrderByCheckout(ctx.db, CHECKOUT);
    expect(read).not.toBeNull();
    expect(read?.order.status).toBe('pending');
  });

  it('is still idempotent with the second half attached', async () => {
    // Cron delivery may duplicate. The consumption ledger is keyed on
    // `(consumer, event_id)`, so the second run finds nothing left to apply —
    // and must not raise, double-create, or report work it did not do.
    await insertEvents(ctx.db, [checkoutCompleted()]);

    const first = await json<{ events: { applied: number } }>(
      await client.get(CRON_PATH, bearer(SECRET)),
    );
    const second = await json<{ events: { applied: number } }>(
      await client.get(CRON_PATH, bearer(SECRET)),
    );

    expect(first.events.applied).toBe(1);
    expect(second.events.applied).toBe(0);

    const orders = await ctx.db.execute(sql`
      SELECT count(*)::int AS n FROM shop_orders WHERE checkout_id = ${CHECKOUT}`);
    expect(Number(orders.rows[0]?.n)).toBe(1);
  });
});

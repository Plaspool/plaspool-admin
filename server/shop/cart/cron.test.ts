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
import { freshDb, resetShopTables, SEED_PASSWORD } from './test/harness';
import { httpClient, json } from '../../test/http';
import { shopApp } from '../app';
import { CRON_PATH } from './routes/checkout';
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
    await client.post('/api/auth/login', {
      email: 'owner@test.local',
      password: SEED_PASSWORD,
    });
    expect((await client.get(CRON_PATH)).status).toBe(401);
  });

  it('still lets an operator run it by hand with a session, over POST', async () => {
    await client.post('/api/auth/login', {
      email: 'owner@test.local',
      password: SEED_PASSWORD,
    });
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
     */
    const registered = new Set(
      shopApp().routes.map((r) => `${r.method} /api/shop${r.path}`),
    );
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

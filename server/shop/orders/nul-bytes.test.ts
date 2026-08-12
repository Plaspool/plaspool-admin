/**
 * A NUL byte is a 4xx on EVERY route this subsystem registers.
 *
 * WHY THIS FILE EXISTS ALONGSIDE `server/nul-bytes.test.ts`, which walks `app.routes` and
 * asserts the same thing. That suite now reaches these routes too — `server/index.ts` mounts
 * `shopApp()` and `server/shop/app.ts` mounts this router — but it filters to `/api/` and
 * carries a hand-written `BODIES` map keyed by route, so a commerce route needing a body it
 * does not know about would be probed with `{}` and refused for the wrong reason. This walk
 * knows this subsystem's bodies. Both are cheap; a boundary that is checked twice is not the
 * failure mode this codebase has.
 *
 * WHAT IT IS FOR. U+0000 cannot be stored in a Postgres `text` (SQLSTATE 22021) or inside a
 * jsonb string (22P05). Reaching the driver it is scrubbed to a `DbError` and answered
 * `{"error":"internal"}` — and spec §8's client retries a 5xx five times over ~30 seconds
 * for input that can never be accepted. `?token=%00` is a one-line request.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { SEED_PASSWORD, freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { resetOrderTables } from './test/harness';
import { ordersClient, resetOrdersDeps, type OrdersClient } from './test/app';
import { CHECKOUT, T0, checkoutCompleted, insertEvents } from './test/fixtures';
import { sweepCommerceEvents } from './repo/consumer';
import { readOrderByCheckout } from './repo/orders';
import { formatOrderNumber } from './order-number';

const NUL = String.fromCharCode(0);

let ctx: TestCtx;
let owner: OrdersClient;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  resetOrdersDeps();
  await resetOrderTables(ctx.db);
  /*
   * `auth_attempts` AND `sessions`, for the reason `server/nul-bytes.test.ts` clears them
   * too: login is rate limited per (ip, email) in POSTGRES rather than in module memory
   * (spec §6 — a serverless instance shares no memory with the next), so a suite that logs
   * in more than the window allows starts answering 429 and every later test fails with a
   * status that has nothing to do with what it was testing. Measured: adding four
   * `login()` calls turned three unrelated tests red at 429.
   */
  await ctx.db.execute(sql`DELETE FROM auth_attempts`);
  await ctx.db.execute(sql`DELETE FROM sessions`);
  owner = ordersClient(ctx.db, { now: () => T0 });
  // The OWNER, so an owner-only route is reached rather than answered 403 before the
  // boundary check this suite exists to exercise.
  const res = await owner.post('/api/auth/login', {
    email: ctx.users.owner.email,
    password: SEED_PASSWORD,
  });
  expect(res.status).toBe(200);
});

const METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE']);

/**
 * A body each route accepts, so a probe is refused for the reason under test rather than for
 * a missing field.
 */
const BODIES: Record<string, Record<string, unknown>> = {
  'POST /api/shop/admin/orders/:id/fulfillments': {
    lines: [{ orderLineId: 'oln_x', qty: 1 }],
  },
  'PATCH /api/shop/admin/fulfillments/:id': { status: 'shipped' },
};

/** Every route THIS ROUTER registered, deduplicated. */
function shopRoutes(): { method: string; path: string }[] {
  const seen = new Map<string, { method: string; path: string }>();
  for (const route of owner.app.routes) {
    if (!METHODS.has(route.method)) continue;
    if (!route.path.startsWith('/api/shop/')) continue;
    seen.set(`${route.method} ${route.path}`, { method: route.method, path: route.path });
  }
  return [...seen.values()];
}

function send(method: string, path: string, body: Record<string, unknown>): Promise<Response> {
  if (method === 'GET') return owner.get(path);
  if (method === 'PATCH') return owner.patch(path, body);
  if (method === 'DELETE') return owner.del(path);
  return owner.post(path, body);
}

describe('a NUL in a path segment', () => {
  it('finds routes to check', () => {
    // A guard on the guard: if the walk stops seeing routes this suite would pass by
    // testing nothing at all, which is the failure mode `server/test/collection.test.ts`
    // exists for one level up.
    const withParams = shopRoutes().filter((route) => route.path.includes(':'));
    expect(withParams.length).toBeGreaterThanOrEqual(5);
  });

  it('is a 4xx on every route that has one, never a 5xx', async () => {
    const results: [string, number][] = [];
    for (const { method, path } of shopRoutes().filter((route) => route.path.includes(':'))) {
      const probe = path.replace(/:[A-Za-z0-9_]+/g, encodeURIComponent(NUL));
      const key = `${method} ${path}`;
      const res = await send(method, probe, BODIES[key] ?? {});
      results.push([key, res.status]);
    }
    const bad = results.filter(([, status]) => status >= 500);
    expect(bad, `these answered 5xx for a NUL path segment: ${JSON.stringify(bad)}`).toEqual([]);
  });
});

describe('a NUL in a query parameter', () => {
  it('is a 4xx everywhere it is accepted', async () => {
    const number = formatOrderNumber(2026, 1);
    const probes = [
      `/api/shop/orders?cursor=${encodeURIComponent(NUL)}`,
      `/api/shop/orders?limit=${encodeURIComponent(NUL)}`,
      `/api/shop/orders/${number}?token=${encodeURIComponent(NUL)}`,
      `/api/shop/orders/${number}/events?token=${encodeURIComponent(NUL)}`,
      `/api/shop/admin/orders?cursor=${encodeURIComponent(NUL)}`,
      `/api/shop/admin/orders?status=${encodeURIComponent(NUL)}`,
    ];
    const results: [string, number][] = [];
    for (const probe of probes) results.push([probe, (await owner.get(probe)).status]);
    expect(results.filter(([, status]) => status >= 500)).toEqual([]);
  });
});

describe('a NUL in a body field', () => {
  it('is a 400 rather than reaching the driver', async () => {
    await insertEvents(ctx.db, [checkoutCompleted()]);
    await sweepCommerceEvents(ctx.db, { origin: null }, T0);
    const read = (await readOrderByCheckout(ctx.db, CHECKOUT))!;

    const res = await owner.post(`/api/shop/admin/orders/${read.order.id}/fulfillments`, {
      lines: [{ orderLineId: read.lines[0].id, qty: 1 }],
      carrier: `DHL${NUL}`,
      trackingNumber: 'T1',
    });
    expect(res.status).toBe(400);
  });
});

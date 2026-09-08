/**
 * The domain gate (migration 0680), driven through the REAL app.
 *
 * The property under test is the TABLE ITSELF: each role reaches the surfaces
 * `shared/roles.ts` grants it and is 403'd off the rest, and the gate never
 * touches a customer request. A unit test over `domainFor` would prove the
 * prefix list; only the real stack proves the prefixes match what is mounted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../test/harness';
import type { TestCtx } from '../test/harness';
import { httpClient } from '../test/http';
import type { HttpClient } from '../test/http';
import type { AuthUser } from '../../shared/types';

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM auth_attempts`);
  await ctx.db.execute(sql`DELETE FROM sessions`);
});

async function login(user: AuthUser): Promise<HttpClient> {
  const c = httpClient(ctx.db);
  await c.signIn(user);
  return c;
}

/** GET probes per domain — reads, so a 200/404 means "allowed through the
 * gate" and a 403 means the gate refused. Every path here is a real mount. */
const PROBES: Record<string, string> = {
  products: '/api/shop/admin/products',
  addOns: '/api/shop/admin/add-ons',
  orders: '/api/shop/admin/orders',
  outbox: '/api/shop/admin/emails',
  customers: '/api/shop/admin/customers',
  analytics: '/api/shop/admin/stats',
  settings: '/api/shop/admin/shipping-zones',
  /* A SECOND `settings` PREFIX, and it earns its row: the courier surface is a
   * mount of its own (migration 0980), so only driving it proves its rule is in
   * the table rather than falling through to the admin catch-all. */
  courier: '/api/shop/admin/logistics/settings',
  marketing: '/api/marketing/discounts',
  emailMarketing: '/api/admin/email/templates',
  content: '/api/posts',
  team: '/api/users',
};

async function probe(c: HttpClient, path: string): Promise<number> {
  return (await c.get(path)).status;
}

describe('the domain gate', () => {
  it('a content writer holds products and the blog, and nothing money-adjacent', async () => {
    const c = await login(ctx.users.writer);
    expect(await probe(c, PROBES.products)).toBe(200);
    expect(await probe(c, PROBES.addOns)).toBe(200);
    expect(await probe(c, PROBES.content)).toBe(200);
    expect(await probe(c, PROBES.orders)).toBe(403);
    expect(await probe(c, PROBES.outbox)).toBe(403);
    expect(await probe(c, PROBES.customers)).toBe(403);
    expect(await probe(c, PROBES.analytics)).toBe(403);
    expect(await probe(c, PROBES.settings)).toBe(403);
    expect(await probe(c, PROBES.courier)).toBe(403);
    expect(await probe(c, PROBES.marketing)).toBe(403);
    expect(await probe(c, PROBES.team)).toBe(403);
  });

  it('supply chain reaches stock and parcels, not campaigns or settings', async () => {
    const c = await login(ctx.users.supplyChain);
    expect(await probe(c, PROBES.products)).toBe(200);
    expect(await probe(c, PROBES.orders)).toBe(200);
    expect(await probe(c, PROBES.outbox)).toBe(200);
    expect(await probe(c, PROBES.analytics)).toBe(200);
    expect(await probe(c, PROBES.marketing)).toBe(403);
    expect(await probe(c, PROBES.settings)).toBe(403);
    /* Packs the parcels, does not choose the courier — the read that says which
     * one is on lives outside the admin prefix and is tested with the routes. */
    expect(await probe(c, PROBES.courier)).toBe(403);
    expect(await probe(c, PROBES.content)).toBe(403);
    expect(await probe(c, PROBES.team)).toBe(403);
  });

  it('support reaches orders and customers, not the catalog', async () => {
    const c = await login(ctx.users.support);
    expect(await probe(c, PROBES.orders)).toBe(200);
    expect(await probe(c, PROBES.customers)).toBe(200);
    expect(await probe(c, PROBES.analytics)).toBe(200);
    expect(await probe(c, PROBES.products)).toBe(403);
    expect(await probe(c, PROBES.addOns)).toBe(403);
    expect(await probe(c, PROBES.marketing)).toBe(403);
    expect(await probe(c, PROBES.content)).toBe(403);
  });

  it('marketing reaches campaigns, broadcasts and customers, not orders', async () => {
    const c = await login(ctx.users.marketing);
    expect(await probe(c, PROBES.marketing)).toBe(200);
    expect(await probe(c, PROBES.emailMarketing)).toBe(200);
    expect(await probe(c, PROBES.customers)).toBe(200);
    expect(await probe(c, PROBES.orders)).toBe(403);
    expect(await probe(c, PROBES.products)).toBe(403);
    expect(await probe(c, PROBES.settings)).toBe(403);
  });

  it('a developer passes everywhere the owner does', async () => {
    for (const user of [ctx.users.developer, ctx.users.owner]) {
      const c = await login(user);
      for (const path of Object.values(PROBES)) {
        expect(await probe(c, path), `${user.role} on ${path}`).toBe(200);
      }
      await ctx.db.execute(sql`DELETE FROM auth_attempts`);
    }
  });

  it('returns are order-side work: support drives them, marketing does not own them', async () => {
    const supportC = await login(ctx.users.support);
    expect(await probe(supportC, '/api/marketing/returns')).toBe(200);
    const writerC = await login(ctx.users.writer);
    expect(await probe(writerC, '/api/marketing/returns')).toBe(403);
  });

  it('the admin catch-all is closed: an unrolled role cannot reach a future admin route', async () => {
    /* `/api/shop/admin/audit` is named (analytics); probe a path only the
     * catch-all covers to pin the default-deny. The route itself 404s for an
     * owner — the assertion is that a writer is refused BEFORE routing. */
    const writer = await login(ctx.users.writer);
    expect((await writer.get('/api/shop/admin/some-future-surface')).status).toBe(403);
    const owner = await login(ctx.users.owner);
    expect((await owner.get('/api/shop/admin/some-future-surface')).status).toBe(404);
  });

  it('the gate never touches an anonymous or customer request', async () => {
    const c = httpClient(ctx.db);
    /* Anonymous on an admin surface: the route's own guard answers 401 — a
     * 403 here would mean the gate fired without a user. */
    expect((await c.get('/api/shop/admin/orders')).status).toBe(401);
    /* The public storefront read is untouched. */
    expect((await c.get('/api/shop/products')).status).toBe(200);
  });
});

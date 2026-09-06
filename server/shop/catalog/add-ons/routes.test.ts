import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../../test/harness';
import type { TestCtx } from '../../../test/harness';
import { httpClient, json } from '../../../test/http';
import type { HttpClient } from '../../../test/http';

let ctx: TestCtx;
let http: HttpClient;
const BASE = '/api/shop/admin/add-ons';

const RULES = [
  { when: [{ attribute: 'item_count', op: 'between', min: 1, max: 4 }], then: 'ask' },
  { when: [{ attribute: 'item_count', op: 'gte', value: 5 }], then: 'include', amountMinor: 0 },
];

beforeAll(async () => {
  ctx = await freshDb();
  http = httpClient(ctx.db);
});
afterAll(() => ctx?.close());
beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM shop_add_ons`);
  await http.signIn({ email: 'owner@test.local' });
});

async function create(body: Record<string, unknown> = {}) {
  const res = await http.post(BASE, { title: 'Gift box', priceMinor: 150_000, rules: RULES, ...body });
  return { status: res.status, body: await json<Record<string, any>>(res) };
}

describe('/admin/add-ons', () => {
  it('needs a session', async () => {
    http.clearCookies();
    expect((await http.get(BASE)).status).toBe(401);
  });

  it('creates a draft in the store currency and lists it', async () => {
    const { status, body } = await create();
    expect(status).toBe(201);
    expect(body.addOn).toMatchObject({ title: 'Gift box', status: 'draft', currency: 'NGN', priceMinor: 150_000, revision: 1, rules: RULES });
    const list = await json<{ items: any[] }>(await http.get(BASE));
    expect(list.items.map((a) => a.id)).toEqual([body.addOn.id]);
    const one = await json<{ addOn: any }>(await http.get(`${BASE}/${body.addOn.id}`));
    expect(one.addOn.id).toBe(body.addOn.id);
  });

  it('refuses a bad body with the field path, never a 500', async () => {
    expect((await create({ rules: [] })).status).toBe(400);
    expect((await create({ priceMinor: -1 })).status).toBe(400);
    expect((await create({ title: '' })).status).toBe(400);
    expect((await create({ rules: [{ when: [{ attribute: 'nope', op: 'eq', value: 1 }], then: 'ask' }] })).status).toBe(400);
    expect((await create({ surprise: true })).status).toBe(400);
    const unknownImage = await create({ imageId: 'img_missing' });
    expect(unknownImage.status).toBe(400);
    expect(unknownImage.body.detail).toBe('imageId');
  });

  it('patches under CAS, moves status, and reports a stale write with the current row', async () => {
    const { body } = await create();
    const id = body.addOn.id as string;
    const saved = await http.patch(`${BASE}/${id}`, { baseRevision: 1, patch: { status: 'active', description: '  ' } });
    expect(saved.status).toBe(200);
    const savedBody = await json<{ addOn: any }>(saved);
    expect(savedBody.addOn.status).toBe('active');
    expect(savedBody.addOn.description).toBeNull();
    expect(savedBody.addOn.revision).toBe(2);
    const stale = await http.patch(`${BASE}/${id}`, { baseRevision: 1, patch: { title: 'Old' } });
    expect(stale.status).toBe(409);
    expect(await json(stale)).toMatchObject({ error: 'stale_write', expected: 1, actual: 2, addOn: { id, revision: 2 } });
    expect((await http.patch(`${BASE}/ado_missing`, { baseRevision: 1, patch: { title: 'x' } })).status).toBe(404);
  });

  it('filters the list by status', async () => {
    await create({ status: 'active' });
    await create();
    const active = await json<{ items: any[] }>(await http.get(`${BASE}?status=active`));
    expect(active.items.length).toBe(1);
    expect((await http.get(`${BASE}?status=nope`)).status).toBe(400);
  });
});

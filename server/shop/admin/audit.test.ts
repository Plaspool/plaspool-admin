/**
 * The audit surface, over two sources that were already durable.
 *
 * The properties worth pinning are the ones a hand-rolled version gets wrong:
 * the two halves interleave by time rather than appearing in blocks, a price
 * entry knows what the price WAS, and the keyset does not drop a row when two
 * changes land in the same millisecond — which is ordinary, because one click
 * on a six-variant product writes six rows inside one request.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { listAudit } from './audit';
import { createProduct } from '../catalog/products';
import { createVariant } from '../catalog/variants';
import { setPrice } from '../catalog/prices';
import { adjustInventory } from '../catalog/inventory';
import type { AuthUser } from '../../../shared/types';

let ctx: TestCtx;
let actor: AuthUser;
let variantId: string;
let productId: string;

beforeAll(async () => {
  ctx = await freshDb();
});
afterAll(() => ctx.close());

beforeEach(async () => {
  await ctx.db.execute(sql`
    TRUNCATE shop_products, shop_variants, shop_inventory, shop_prices,
             commerce_events CASCADE`);
  const seeded = await ctx.db.execute(sql`SELECT id, email, display_name FROM users LIMIT 1`);
  actor = {
    id: String(seeded.rows[0].id),
    email: String(seeded.rows[0].email),
    displayName: String(seeded.rows[0].display_name),
    role: 'owner',
  };
  const product = await createProduct(ctx.db, actor, { title: 'Enamel Mug' });
  productId = product.id;
  const variant = await createVariant(ctx.db, product.id, { optionValues: { Colour: 'Blue' } }, actor);
  variantId = variant.id;
});

describe('what it collects', () => {
  it('records a stock change with its reason and who made it', async () => {
    await adjustInventory(ctx.db, variantId, 12, 'Delivery arrived from the distributor', actor);

    const page = await listAudit(ctx.db);
    const stock = page.items.filter((i) => i.kind === 'stock');
    expect(stock).toHaveLength(1);
    expect(stock[0]).toMatchObject({
      kind: 'stock',
      delta: 12,
      onHand: 12,
      reason: 'Delivery arrived from the distributor',
      actor: actor.displayName,
      sku: 'ENAMEL-BLUE',
      productTitle: 'Enamel Mug',
    });
    expect(stock[0].optionValues).toEqual({ Colour: 'Blue' });
  });

  it('records what a price WAS, not only what it became', async () => {
    /*
     * THE DIFFERENCE IS THE WHOLE POINT. A row saying "22,000" is a fact; a row
     * saying "18,500 -> 22,000" is the one somebody can act on, and the only
     * place the previous number exists is the previous row.
     */
    await setPrice(ctx.db, variantId, { amount: 1_850_000, currency: 'NGN' }, 'Opening price');
    await new Promise((r) => setTimeout(r, 2));
    await setPrice(ctx.db, variantId, { amount: 2_200_000, currency: 'NGN' }, 'Distributor raised the price');

    const page = await listAudit(ctx.db, { kind: 'price' });
    expect(page.items).toHaveLength(2);
    // Newest first.
    expect(page.items[0]).toMatchObject({
      amount: 2_200_000,
      previousAmount: 1_850_000,
      reason: 'Distributor raised the price',
      currency: 'NGN',
    });
    // The first price this variant ever had has nothing before it.
    expect(page.items[1]).toMatchObject({ amount: 1_850_000, previousAmount: null });
  });

  it('leaves the reason null rather than inventing one', async () => {
    // Every price written before migration 0009 has none, and a caller may
    // decline to say. "No reason recorded" is true; an empty string is not.
    await setPrice(ctx.db, variantId, { amount: 500, currency: 'NGN' });

    const page = await listAudit(ctx.db, { kind: 'price' });
    expect(page.items[0].reason).toBeNull();
  });

  it('says nothing about who changed a price, because nothing records it', async () => {
    // `shop_prices` has no actor column. Guessing one would be a fact invented
    // by the audit view, which is the one thing an audit view may not do.
    await setPrice(ctx.db, variantId, { amount: 500, currency: 'NGN' }, 'Why');
    const page = await listAudit(ctx.db, { kind: 'price' });
    expect(page.items[0].actor).toBeNull();
  });
});

describe('ordering and paging', () => {
  it('interleaves the two sources by time rather than listing them in blocks', async () => {
    await setPrice(ctx.db, variantId, { amount: 100, currency: 'NGN' }, 'first');
    await new Promise((r) => setTimeout(r, 2));
    await adjustInventory(ctx.db, variantId, 5, 'then stock', actor);
    await new Promise((r) => setTimeout(r, 2));
    await setPrice(ctx.db, variantId, { amount: 200, currency: 'NGN' }, 'then price again');

    const page = await listAudit(ctx.db);
    expect(page.items.map((i) => i.kind)).toEqual(['price', 'stock', 'price']);
  });

  it('pages without dropping or repeating a row', async () => {
    for (let i = 0; i < 7; i += 1) {
      await adjustInventory(ctx.db, variantId, 1, `move ${i}`, actor);
    }

    const first = await listAudit(ctx.db, { limit: 3 });
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();

    const second = await listAudit(ctx.db, { limit: 3, cursor: first.nextCursor! });
    const third = await listAudit(ctx.db, { limit: 3, cursor: second.nextCursor! });

    const seen = [...first.items, ...second.items, ...third.items].map((i) => i.id);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(third.nextCursor).toBeNull();
  });

  it('survives several changes inside the same millisecond', async () => {
    /*
     * A click on a six-variant product writes six rows in one request, so equal
     * timestamps are the ordinary case rather than a corner. The cursor carries
     * the id as well as the instant for exactly this.
     */
    const at = Date.now();
    for (let i = 0; i < 5; i += 1) {
      await ctx.db.execute(sql`
        INSERT INTO commerce_events (id, type, subject_id, payload, occurred_at)
        VALUES (${`evt_same_${i}`}, 'catalog.inventory.adjusted', ${variantId},
                ${sql`${JSON.stringify({ variantId, delta: 1, onHand: i, reason: 'same ms', actorId: actor.id })}::jsonb`},
                ${at})`);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const res: Awaited<ReturnType<typeof listAudit>> = await listAudit(ctx.db, {
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...res.items.map((i) => i.id));
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter((id) => id.startsWith('evt_same_'))).toHaveLength(5);
  });
});

describe('filters', () => {
  it('narrows to one variant', async () => {
    const other = await createVariant(ctx.db, productId, { optionValues: { Colour: 'Red' } }, actor);
    await adjustInventory(ctx.db, variantId, 1, 'blue', actor);
    await adjustInventory(ctx.db, other.id, 1, 'red', actor);

    const page = await listAudit(ctx.db, { variantId });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].reason).toBe('blue');
  });

  it('narrows to one kind', async () => {
    await adjustInventory(ctx.db, variantId, 1, 'stock', actor);
    await setPrice(ctx.db, variantId, { amount: 1, currency: 'NGN' }, 'price');

    expect((await listAudit(ctx.db, { kind: 'stock' })).items).toHaveLength(1);
    expect((await listAudit(ctx.db, { kind: 'price' })).items).toHaveLength(1);
    expect((await listAudit(ctx.db)).items).toHaveLength(2);
  });
});

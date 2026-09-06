import { sql } from 'drizzle-orm';
import type { Db } from '../../../db/client';
import { publicImageUrl } from '../../../repo/public-projection';
import { evaluateAddOns, factsFrom } from '../../../../shared/commerce/add-ons';
import type { AddOnCartInput, AddOnOffer, AddOnPort, AddOnRecord } from '../../../../shared/commerce/add-ons';
import { listAddOns } from './repo';

/**
 * The real AddOnPort (spec §4). Consumed by Cart through ShopCartDeps.addOns;
 * wired in server/shop/app.ts. Two reads and a pure function: the active
 * add-ons, then category and tags for the cart's products — the facts Cart
 * may not read for itself (contract §2) — then evaluateAddOns.
 */
async function productFacts(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, { category: string; tags: string[] }>> {
  const out = new Map<string, { category: string; tags: string[] }>();
  if (ids.length === 0) return out;
  const res = await db.execute(sql`
    SELECT id, category, tags FROM shop_products
     WHERE id = ANY(${sql.param(ids as string[])}::text[])`);
  for (const row of res.rows) {
    out.set(String(row.id), {
      category: String(row.category),
      tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    });
  }
  return out;
}

export const addOnPort: AddOnPort<Db> = {
  async offers(db: Db, input: AddOnCartInput): Promise<AddOnOffer[]> {
    const active = await listAddOns(db, 'active');
    if (active.length === 0) return [];
    const products = await productFacts(db, [...new Set(input.lines.map((l) => l.productId))]);
    const records: AddOnRecord[] = active.map((a) => ({
      id: a.id,
      title: a.title,
      description: a.description,
      imageUrl: a.imageId === null || a.imageId === '' ? null : publicImageUrl(a.imageId),
      priceMinor: a.priceMinor,
      currency: a.currency,
      rules: a.rules,
    }));
    return evaluateAddOns(records, factsFrom(input, products));
  },
};

import { sql } from 'drizzle-orm';
import type { Db } from '../../../db/client';

/**
 * A REAL PURCHASE, built out of real rows — the fixture every review test now
 * needs, because the intake gates on one (brief §2).
 *
 * WHY IT WRITES SQL INSTEAD OF DRIVING THE CHECKOUT. An order arrives in
 * production through a Paystack capture, an outbox event and the orders
 * consumer, and making a review test walk that whole pipeline would couple this
 * subsystem's suite to three others: a change to the checkout payload would
 * redden reviews. What the gate actually reads is four tables, so that is what
 * this builds, with the columns spelled out rather than inherited from a helper
 * that might drift.
 *
 * AND WHY THAT IS A RISK WORTH NAMING. This file knows the shape of tables it
 * does not own. If a later migration adds a NOT NULL column to `shop_orders`,
 * `shop_order_lines`, `shop_products` or `shop_variants`, THIS is what breaks
 * first, and the failure will look like a reviews bug. It is not; it is this
 * fixture needing the new column. The alternative — a fixture that never
 * touches the real defaults — is the trap §2 of CLAUDE.md is about, so the
 * brittleness is the price and it is the right way round.
 */

export interface PurchaseFixture {
  productId: string;
  variantId: string;
  orderId: string;
}

let seq = 0;

/**
 * Give somebody a paid order containing one variant of `slug`.
 *
 * Exactly one of `customerId` / `email` is enough — both halves of the
 * ownership rule are exercised by passing one or the other, which is the point:
 * a guest order carries a NULL `customer_id` and is owned by its email alone.
 */
export async function givePurchase(
  db: Db,
  opts: {
    slug: string;
    customerId?: string | null;
    email?: string;
    /** Defaults to `paid`. Pass `pending` or `cancelled` to prove they do not
     *  count, and `refunded` to prove it does. */
    status?: string;
    /** Reuse a product that already exists, so two orders can name one slug. */
    productId?: string;
  } = { slug: 'pla-basic' },
): Promise<PurchaseFixture> {
  seq += 1;
  const n = String(seq).padStart(4, '0');
  const orderId = `ord_test${n}`;
  const variantId = `var_test${n}`;
  const now = 1_700_000_000_000 + seq;

  let productId = opts.productId;
  if (!productId) {
    productId = `prd_test${n}`;
    /* `author_id` is a real FK into `users`, so it takes whichever seeded user
       exists rather than a made-up uuid. `category` and `revision` are NOT NULL
       with no default and are the two columns this fixture forgot on its first
       run — see the header about exactly this brittleness. */
    await db.execute(sql`
      INSERT INTO shop_products
        (id, slug, title, description, description_text, status, category,
         created_at, updated_at, author_id, revision)
      VALUES (${productId}, ${opts.slug}, ${'Test ' + opts.slug},
              ${JSON.stringify({ type: 'doc', content: [] })}::jsonb, ${''},
              'active', 'test', ${now}, ${now},
              (SELECT id FROM users ORDER BY created_at LIMIT 1), 1)
      ON CONFLICT (slug) DO NOTHING`);
    /* The slug may already exist from an earlier call in the same file; take
       whichever id actually holds it rather than the one just generated. */
    const found = await db.execute(sql`
      SELECT id FROM shop_products WHERE slug = ${opts.slug}`);
    productId = String(found.rows[0]!.id);
  }

  await db.execute(sql`
    INSERT INTO shop_variants
      (id, product_id, sku, option_values, position, status, created_at, updated_at)
    VALUES (${variantId}, ${productId}, ${'SKU-' + n}, ${'{}'}::jsonb, ${seq},
            'active', ${now}, ${now})`);

  const address = JSON.stringify({
    name: 'Test Buyer',
    line1: '1 Test Road',
    city: 'Abuja',
    region: 'Abuja',
    country: 'NG',
    postcode: '900001',
  });

  await db.execute(sql`
    INSERT INTO shop_orders
      (id, order_number, customer_id, email, currency, subtotal, shipping_total,
       tax_total, grand_total, status, shipping_address, billing_address,
       placed_at, revision, source_event_id, checkout_id)
    VALUES (${orderId}, ${'2026-00' + n + '-T'}, ${opts.customerId ?? null}::text,
            ${opts.email ?? 'buyer@example.com'}, 'NGN',
            100000, 0, 0, 100000, ${opts.status ?? 'paid'},
            ${address}::jsonb, ${address}::jsonb, ${now}, 1,
            ${'evt_test' + n}, ${'chk_test' + n})`);

  await db.execute(sql`
    INSERT INTO shop_order_lines
      (id, order_id, line_no, variant_id, sku, title, option_values, qty,
       unit_amount, line_total)
    VALUES (${'orl_test' + n}, ${orderId}, 0, ${variantId}, ${'SKU-' + n},
            ${'Test ' + opts.slug}, ${'{}'}::jsonb, 1, 100000, 100000)`);

  return { productId, variantId, orderId };
}

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import type { Db } from '../../db/client';
import { resetOrderTables } from '../orders/test/harness';
import { seedOrder } from './test/seed';
import { basketFor, listProspects, sendsFor } from './prospects';

/**
 * People who have not bought, and the baskets they left.
 *
 * THE CENTRAL PROPERTY OF THIS FILE IS THAT AN ADDRESS IS RESOLVED THE WAY
 * PRODUCTION RESOLVES IT — `lower(COALESCE(shop_carts.email,
 * shop_customers.email))` — AND THAT BOTH HALVES ARE EXERCISED. A signed-in
 * shopper who has not reached the checkout contact step has an address only
 * through the customer join; a guest who HAS reached it has one only on the
 * cart. Measured on production 2026-09-08: 19 carts carried lines, 6 resolved
 * to an address and 13 resolved to none at all. A query that read only
 * `shop_carts.email` would list a fraction of a fraction and look fine.
 *
 * The second property is that the LIST and the BASKET agree, because they are
 * two consumers of one answer — see the last case in this file. The third is
 * that prices are quoted LIVE from `shop_prices`: `shop_cart_lines` stores no
 * price on purpose, so nothing here can be read off the line.
 *
 * Nothing is mocked. The tables are the real ones, built by the real
 * migrations, and every constraint still applies — a seed that writes a state
 * the schema forbids fails loudly rather than producing a corpus production
 * could never contain.
 */

/** A fixed clock, as `./test/seed.ts` has one, so no assertion depends on today. */
const S0 = 1_780_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await resetOrderTables(ctx.db);
  /*
   * DELETE and not TRUNCATE, for the reason `customers.test.ts` gives: TRUNCATE
   * refuses a table another one references unless every referencing table is
   * named in the same statement, and `shop_carts.customer_id`,
   * `shop_variants.product_id` and `email_broadcast_recipients.subscriber_id`
   * all reference tables emptied here. Every one of those FKs cascades, so
   * deleting the four parents empties their children with them.
   */
  await ctx.db.execute(sql`DELETE FROM shop_carts`);
  await ctx.db.execute(sql`DELETE FROM shop_products`);
  await ctx.db.execute(sql`DELETE FROM shop_customers`);
  await ctx.db.execute(sql`DELETE FROM email_broadcasts`);
  await ctx.db.execute(sql`DELETE FROM email_subscribers`);
});

// ----------------------------------------------------------------- seeding

interface SeedVariantSpec {
  id: string;
  sku: string;
  /**
   * Written to `shop_prices`, which is where a price lives — never on the
   * variant. `null` writes NO price row at all, which is the state the LEFT
   * join in both statements exists for: a variant nobody has priced yet.
   */
  priceMinor: number | null;
  /** The PRODUCT's title. A basket line is titled by the product, not the SKU. */
  productTitle: string;
  imageId?: string | null;
  coverImageId?: string | null;
  currency?: string;
}

interface SeedCartSpec {
  id: string;
  customerId?: string | null;
  email?: string | null;
  status?: 'open' | 'converting' | 'converted' | 'abandoned';
  updatedAt?: number;
  currency?: string;
  expiresAt?: number;
}

interface SeedSpec {
  customer?: { id: string; email: string; displayName?: string };
  cart: SeedCartSpec;
  extraCarts?: SeedCartSpec[];
  lines: Array<{ cartId?: string; variantId: string; qty: number }>;
  variants: SeedVariantSpec[];
}

/** One product, one variant, one current price — the shape a cart line points at. */
async function seedVariant(db: Db, v: SeedVariantSpec): Promise<void> {
  const productId = `prd_${v.id}`;
  await db.execute(sql`
    INSERT INTO shop_products (id, slug, title, description, description_text,
                               status, category, cover_image_id,
                               created_at, updated_at, author_id, revision)
    VALUES (${productId}, ${productId}, ${v.productTitle},
            ${'{"type":"doc","content":[]}'}::jsonb, ${''},
            'active', 'test', ${v.coverImageId ?? null}, ${S0}, ${S0},
            (SELECT id FROM users ORDER BY created_at LIMIT 1), 1)`);
  await db.execute(sql`
    INSERT INTO shop_variants (id, product_id, sku, option_values, position,
                               status, image_id, created_at, updated_at)
    VALUES (${v.id}, ${productId}, ${v.sku}, ${'{"Colour":"Red"}'}::jsonb, 0,
            'active', ${v.imageId ?? null}, ${S0}, ${S0})`);
  /* `effective_to` left NULL: that is what "current" means, and the partial
     unique index `shop_prices_current_uq` is what makes it at most one. */
  if (v.priceMinor !== null) {
    await db.execute(sql`
      INSERT INTO shop_prices (id, variant_id, amount, currency, effective_from, created_at)
      VALUES (${`prc_${v.id}`}, ${v.id}, ${v.priceMinor}, ${v.currency ?? 'NGN'},
              ${S0}, ${S0})`);
  }
}

async function insertCart(db: Db, c: SeedCartSpec): Promise<void> {
  const updatedAt = c.updatedAt ?? S0;
  await db.execute(sql`
    INSERT INTO shop_carts (id, customer_id, currency, status, email,
                            created_at, updated_at, expires_at, revision)
    VALUES (${c.id}, ${c.customerId ?? null}, ${c.currency ?? 'NGN'},
            ${c.status ?? 'open'}, ${c.email ?? null},
            ${updatedAt}, ${updatedAt}, ${c.expiresAt ?? updatedAt + DAY}, 1)`);
}

/** The `basketFor` fixture. `beforeEach` has already emptied every table. */
async function seed(spec: SeedSpec): Promise<Db> {
  const db = ctx.db;
  if (spec.customer) {
    await db.execute(sql`
      INSERT INTO shop_customers (id, email, display_name, created_at)
      VALUES (${spec.customer.id}, ${spec.customer.email},
              ${spec.customer.displayName ?? null}, ${S0})`);
  }
  for (const v of spec.variants) await seedVariant(db, v);
  for (const c of [spec.cart, ...(spec.extraCarts ?? [])]) await insertCart(db, c);
  for (const line of spec.lines) {
    const cartId = line.cartId ?? spec.cart.id;
    await db.execute(sql`
      INSERT INTO shop_cart_lines (id, cart_id, variant_id, qty, added_at)
      VALUES (${`ln_${cartId}_${line.variantId}`}, ${cartId}, ${line.variantId},
              ${line.qty}, ${S0})`);
  }
  return db;
}

/** The `listProspects` fixture: an empty shop the `give*` helpers fill in. */
async function seedShop(): Promise<Db> {
  return ctx.db;
}

let baskets = 0;

/** A cart with one line. `null` is the pure guest whose address is unknowable. */
async function giveBasket(db: Db, email: string | null): Promise<void> {
  baskets += 1;
  const tag = `b${baskets}`;
  await seedVariant(db, {
    id: `var_${tag}`,
    sku: `SKU-${tag}`,
    priceMinor: 100_000,
    productTitle: `Product ${tag}`,
  });
  await insertCart(db, { id: `cart_${tag}`, email, updatedAt: S0 + baskets * 1000 });
  await db.execute(sql`
    INSERT INTO shop_cart_lines (id, cart_id, variant_id, qty, added_at)
    VALUES (${`ln_${tag}`}, ${`cart_${tag}`}, ${`var_${tag}`}, 1, ${S0})`);
}

let accounts = 0;

async function giveAccount(db: Db, email: string): Promise<void> {
  accounts += 1;
  await db.execute(sql`
    INSERT INTO shop_customers (id, email, display_name, created_at)
    VALUES (${`cus_a${accounts}`}, ${email}, ${'Ada L.'}, ${S0})`);
}

async function upsertSubscriber(
  db: Db,
  email: string,
  o: { consentAt?: number; unsubscribedAt?: number },
): Promise<void> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO email_subscribers (id, email, source, consent_at, unsubscribed_at,
                                   token, created_at)
    VALUES (${id}, ${email.toLowerCase()}, 'customer', ${o.consentAt ?? null},
            ${o.unsubscribedAt ?? null}, ${`tok_${id}`}, ${S0})
    ON CONFLICT (email) DO UPDATE
       SET consent_at      = COALESCE(EXCLUDED.consent_at, email_subscribers.consent_at),
           unsubscribed_at = COALESCE(EXCLUDED.unsubscribed_at,
                                      email_subscribers.unsubscribed_at)`);
}

async function giveSubscription(db: Db, email: string): Promise<void> {
  await upsertSubscriber(db, email, { consentAt: S0 });
}

/**
 * Creates the row if there is none, because that is the real sequence: somebody
 * enrolled by a send can opt out without ever having subscribed by hand.
 */
async function unsubscribe(db: Db, email: string): Promise<void> {
  await upsertSubscriber(db, email, { unsubscribedAt: S0 + 1000 });
}

async function placeOrder(db: Db, email: string): Promise<void> {
  await seedOrder(db, { email });
}

let broadcasts = 0;

/** One finished send. Both bodies are non-empty because the schema insists. */
async function seedBroadcast(db: Db): Promise<string> {
  broadcasts += 1;
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO email_broadcasts (id, subject, html, text, status, created_at)
    VALUES (${id}::uuid, ${`Broadcast ${broadcasts}`}, ${'<p>hi</p>'}, ${'hi'},
            'sent', ${S0})`);
  return id;
}

/**
 * One row in the per-recipient queue, found by address rather than by id so a
 * test does not have to thread subscriber ids around.
 *
 * `RETURNING id`, AND THE ASSERTION BELOW IT, because the insert is an
 * `INSERT … SELECT`: with no matching subscriber it writes nothing, succeeds,
 * and leaves a test that proves the field is null for the wrong reason.
 */
async function seedRecipient(
  db: Db,
  broadcastId: string,
  email: string,
  o: { status: 'pending' | 'sent'; sentAt?: number },
): Promise<void> {
  const res = await db.execute(sql`
    INSERT INTO email_broadcast_recipients (id, broadcast_id, subscriber_id, status, sent_at)
    SELECT ${randomUUID()}::uuid, ${broadcastId}::uuid, s.id, ${o.status}::text,
           ${o.sentAt ?? null}::bigint
      FROM email_subscribers s
     WHERE s.email = ${email.toLowerCase()}
    RETURNING id`);
  expect(res.rows).toHaveLength(1);
}

// ------------------------------------------------------------------- tests

describe('basketFor', () => {
  it('reads the cart through the customer when the cart carries no email', async () => {
    // A signed-in shopper who has not reached the checkout contact step: the
    // address exists only on shop_customers. Production's own census used
    // COALESCE(cart.email, customer.email) and this is that half.
    const db = await seed({
      customer: { id: 'cus_1', email: 'ada@example.test' },
      cart: { id: 'cart_1', customerId: 'cus_1', email: null, status: 'open' },
      lines: [{ variantId: 'var_1', qty: 2 }],
      variants: [{ id: 'var_1', sku: 'PLA-RED', priceMinor: 250_000, productTitle: 'PLA Basic' }],
    });
    const basket = await basketFor(db, 'ada@example.test');
    expect(basket?.lines).toHaveLength(1);
    expect(basket?.lines[0].unitMinor).toBe(250_000);
    expect(basket?.lines[0].lineMinor).toBe(500_000);
    expect(basket?.totalMinor).toBe(500_000);
  });

  it('folds the address, so ADA@Example.test is the same basket', async () => {
    const db = await seed({
      cart: { id: 'cart_1', email: 'ADA@Example.test', status: 'open' },
      lines: [{ variantId: 'var_1', qty: 1 }],
      variants: [{ id: 'var_1', sku: 'A', priceMinor: 100, productTitle: 'A' }],
    });
    expect(await basketFor(db, 'ada@example.test')).not.toBeNull();
  });

  it('prefers the most recently updated open or converting cart', async () => {
    const db = await seed({
      cart: { id: 'old', email: 'ada@example.test', status: 'open', updatedAt: 1000 },
      extraCarts: [
        { id: 'new', email: 'ada@example.test', status: 'converting', updatedAt: 2000 },
      ],
      lines: [
        { cartId: 'old', variantId: 'var_1', qty: 1 },
        { cartId: 'new', variantId: 'var_1', qty: 3 },
      ],
      variants: [{ id: 'var_1', sku: 'A', priceMinor: 100, productTitle: 'A' }],
    });
    const basket = await basketFor(db, 'ada@example.test');
    expect(basket?.cartId).toBe('new');
    expect(basket?.status).toBe('converting');
  });

  it('is null for a converted cart — that is an order, not a basket', async () => {
    const db = await seed({
      cart: { id: 'cart_1', email: 'ada@example.test', status: 'converted' },
      lines: [{ variantId: 'var_1', qty: 1 }],
      variants: [{ id: 'var_1', sku: 'A', priceMinor: 100, productTitle: 'A' }],
    });
    expect(await basketFor(db, 'ada@example.test')).toBeNull();
  });

  it('falls back to the product cover when the variant has no image of its own', async () => {
    const db = await seed({
      cart: { id: 'cart_1', email: 'ada@example.test', status: 'open' },
      lines: [{ variantId: 'var_1', qty: 1 }],
      variants: [
        {
          id: 'var_1',
          sku: 'A',
          priceMinor: 100,
          productTitle: 'A',
          imageId: null,
          coverImageId: 'asset:img_cover',
        },
      ],
    });
    const basket = await basketFor(db, 'ada@example.test');
    // normalizeBlobId strips the historical `asset:` prefix; a URL built from
    // the prefixed form 404s on a live product.
    expect(basket?.lines[0].imageId).toBe('img_cover');
  });

  it('is null for an address nobody has, rather than throwing', async () => {
    // The email drain calls this per recipient and a miss is ordinary: they
    // bought, emptied it, or were never reachable in the first place.
    const db = await seedShop();
    expect(await basketFor(db, 'nobody@example.test')).toBeNull();
    expect(await basketFor(db, '   ')).toBeNull();
  });
});

/**
 * Gives `seedRecipient` a `skipped` status and a `last_error`, which its own
 * `o` shape (built for `lastNudgeAt`, which only ever cares about `sent`)
 * does not carry. A second insert helper rather than widening that one, so a
 * change here cannot alter what `listProspects`'s own tests seed.
 */
async function seedSkippedRecipient(
  db: Db,
  broadcastId: string,
  email: string,
  lastError: string,
): Promise<void> {
  const res = await db.execute(sql`
    INSERT INTO email_broadcast_recipients (id, broadcast_id, subscriber_id, status, last_error)
    SELECT ${randomUUID()}::uuid, ${broadcastId}::uuid, s.id, 'skipped', ${lastError}
      FROM email_subscribers s
     WHERE s.email = ${email.toLowerCase()}
    RETURNING id`);
  expect(res.rows).toHaveLength(1);
}

describe('sendsFor', () => {
  it('is empty for somebody never mailed', async () => {
    const db = ctx.db;
    expect(await sendsFor(db, 'nobody@example.test')).toEqual([]);
  });

  it('orders newest broadcast first, and folds the address', async () => {
    const db = ctx.db;
    await giveSubscription(db, 'ada@example.test');
    const older = await seedBroadcast(db);
    const newer = await seedBroadcast(db);
    await seedRecipient(db, older, 'ada@example.test', { status: 'sent', sentAt: S0 });
    await seedRecipient(db, newer, 'ada@example.test', { status: 'sent', sentAt: S0 + DAY });

    // Folded exactly like basketFor: a padded, mixed-case lookup finds the
    // same history a plain one finds.
    const sends = await sendsFor(db, '  ADA@Example.test ');
    expect(sends.map((s) => s.broadcastId)).toEqual([newer, older]);
    expect(sends[0].status).toBe('sent');
    expect(sends[0].sentAt).toBe(S0 + DAY);
  });

  it('carries a skipped row and its reason, with no sentAt', async () => {
    const db = ctx.db;
    await giveSubscription(db, 'ada@example.test');
    const broadcastId = await seedBroadcast(db);
    await seedSkippedRecipient(db, broadcastId, 'ada@example.test', 'basket_empty');

    const sends = await sendsFor(db, 'ada@example.test');
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      status: 'skipped',
      sentAt: null,
      lastError: 'basket_empty',
    });
  });

  it('is null-safe for a blank address', async () => {
    const db = ctx.db;
    expect(await sendsFor(db, '   ')).toEqual([]);
  });
});

describe('listProspects', () => {
  it('the basket tab excludes anybody who has ever ordered', async () => {
    const db = await seedShop();
    await giveBasket(db, 'buyer@example.test');
    await placeOrder(db, 'buyer@example.test');
    await giveBasket(db, 'lead@example.test');
    const page = await listProspects(db, { tab: 'basket' });
    expect(page.items.map((p) => p.email)).toEqual(['lead@example.test']);
  });

  it('counts baskets with no address at all rather than listing them', async () => {
    const db = await seedShop();
    await giveBasket(db, null); // a pure guest, unreachable
    await giveBasket(db, 'lead@example.test');
    const page = await listProspects(db, { tab: 'basket' });
    expect(page.items).toHaveLength(1);
    expect(page.unreachableBaskets).toBe(1);
  });

  it('is one row per address even when somebody is all three things', async () => {
    const db = await seedShop();
    await giveAccount(db, 'ada@example.test');
    await giveBasket(db, 'ada@example.test');
    await giveSubscription(db, 'ada@example.test');
    const page = await listProspects(db, { tab: 'all' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      hasBasket: true,
      hasAccount: true,
      isSubscriber: true,
    });
  });

  it('reports an unsubscribed person as unsubscribed rather than hiding them', async () => {
    const db = await seedShop();
    await giveBasket(db, 'gone@example.test');
    await unsubscribe(db, 'gone@example.test');
    const page = await listProspects(db, { tab: 'basket' });
    expect(page.items[0].subscribeState).toBe('unsubscribed');
  });

  it('separates never asked from subscribed, because they are mailed differently', async () => {
    // `email_subscribers.consent_at` absent is NOT suppression — an address an
    // operator added has no consent timestamp and is still mailable. Collapsing
    // the two would lose the difference between "never asked" and "asked to stop".
    const db = await seedShop();
    await giveBasket(db, 'asked@example.test');
    await giveSubscription(db, 'asked@example.test');
    await giveBasket(db, 'never@example.test');

    const page = await listProspects(db, { tab: 'basket' });
    const states = new Map(page.items.map((p) => [p.email, p.subscribeState]));
    expect(states.get('asked@example.test')).toBe('subscribed');
    expect(states.get('never@example.test')).toBe('never_asked');
  });

  it('keeps the tabs apart: an account holder with a basket is on the basket tab only', async () => {
    const db = await seedShop();
    await giveAccount(db, 'both@example.test');
    await giveBasket(db, 'both@example.test');
    await giveAccount(db, 'account-only@example.test');

    expect((await listProspects(db, { tab: 'basket' })).items.map((p) => p.email)).toEqual([
      'both@example.test',
    ]);
    expect((await listProspects(db, { tab: 'account' })).items.map((p) => p.email)).toEqual([
      'account-only@example.test',
    ]);
  });

  it('pages by last seen, newest first, without skipping or repeating anybody', async () => {
    // The failure this guards is silent: `server/repo/cursor.ts` measured a
    // cursor spent against the wrong column returning 2 of 8 rows and saying
    // nothing. Three baskets, one at a time, must be the same three.
    const db = await seedShop();
    await giveBasket(db, 'one@example.test');
    await giveBasket(db, 'two@example.test');
    await giveBasket(db, 'three@example.test');

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 3; i += 1) {
      const page = await listProspects(db, { tab: 'basket', limit: 1, cursor });
      expect(page.items).toHaveLength(1);
      seen.push(page.items[0].email);
      cursor = page.nextCursor ?? undefined;
    }
    // `giveBasket` stamps each cart a second later than the last, so newest first
    // is the reverse of the order they were created in.
    expect(seen).toEqual(['three@example.test', 'two@example.test', 'one@example.test']);
    expect(cursor).toBeUndefined();
    expect(new Set(seen).size).toBe(3);
  });

  it('the list and the basket agree, because they are one answer', async () => {
    // The whole point of this module. A second query written for the email would
    // be a second answer to "what is in their basket", and the only person who
    // would ever see both is the recipient.
    //
    // THE PADDING ON THE STORED ADDRESS IS NOT DECORATION. Nothing on the write
    // path trims — `setCheckoutContact` stores `a.email` verbatim and `str()`
    // strips NUL and nothing else — so '  Ada@Example.test ' is a state
    // production can hold. The list prints the FOLDED address, and the contract
    // Tasks 4 and 6 rely on is that handing that string straight back to
    // `basketFor` finds this basket. Folded on one side only, the row said
    // "5 items, ₦8,000" while the basket read as empty.
    const db = await seed({
      cart: { id: 'cart_1', email: '  Ada@Example.test ', status: 'open' },
      lines: [
        { variantId: 'var_1', qty: 2 },
        { variantId: 'var_2', qty: 3 },
      ],
      variants: [
        { id: 'var_1', sku: 'A', priceMinor: 250_000, productTitle: 'PLA Basic' },
        { id: 'var_2', sku: 'B', priceMinor: 100_000, productTitle: 'PLA Silk' },
      ],
    });

    const row = (await listProspects(db, { tab: 'basket' })).items[0];
    expect(row.email).toBe('ada@example.test');

    const basket = await basketFor(db, row.email);
    expect(basket?.totalMinor).toBe(800_000);
    expect(row.basketMinor).toBe(basket?.totalMinor);
    expect(row.basketItems).toBe(basket?.lines.reduce((n, l) => n + l.qty, 0));
    expect(row.currency).toBe(basket?.currency);
  });

  it('folds a padded address onto one person, whichever table carries the padding', async () => {
    // `email_subscribers_email_ck` asks only that the address equal its own
    // `lower()`, which '  ada@example.test' does — so a padded row and a bare
    // one are two rows the unique index is perfectly happy with, and the fold
    // has to make them one. The same goes for `shop_customers_email_uq`, which
    // is unique over the RAW address.
    const db = await seedShop();
    await giveBasket(db, ' ADA@Example.test ');
    await giveAccount(db, '  ada@example.test');
    await giveSubscription(db, 'ada@example.test  ');
    await giveSubscription(db, 'ada@example.test');

    const page = await listProspects(db, { tab: 'all' });
    expect(page.items.map((p) => p.email)).toEqual(['ada@example.test']);
    expect(page.items[0]).toMatchObject({
      hasBasket: true,
      hasAccount: true,
      isSubscriber: true,
      subscribeState: 'subscribed',
    });
  });

  it('counts a basket whose address is only whitespace as unreachable', async () => {
    // `NULLIF(c.email, '')` does not catch '   ', `picked`'s `email <> ''` does
    // not catch it, and the unreachable count's `= ''` does not either. Without
    // the trim this is a listed — and mailable — prospect whose address is
    // three spaces, which is exactly the population that count exists to keep
    // off the screen.
    const db = await seedShop();
    await giveBasket(db, '   ');
    await giveBasket(db, 'lead@example.test');

    const page = await listProspects(db, { tab: 'basket' });
    expect(page.items.map((p) => p.email)).toEqual(['lead@example.test']);
    expect(page.unreachableBaskets).toBe(1);
  });

  it('keeps a line whose variant has no price, at zero, rather than dropping it', async () => {
    // `LEFT JOIN shop_prices`, in `basketFor` AND in the list's `baskets` CTE.
    // `INNER` is the more natural thing to write and is a one-word edit in two
    // places: the line would vanish from the basket and its units from the
    // row's count, which is precisely the item-count disagreement the LEFT join
    // was chosen to prevent.
    const db = await seed({
      cart: { id: 'cart_1', email: 'ada@example.test', status: 'open' },
      lines: [
        { variantId: 'var_1', qty: 2 },
        { variantId: 'var_2', qty: 3 },
      ],
      variants: [
        { id: 'var_1', sku: 'PRICED', priceMinor: 250_000, productTitle: 'PLA Basic' },
        { id: 'var_2', sku: 'UNPRICED', priceMinor: null, productTitle: 'PLA Silk' },
      ],
    });

    const basket = await basketFor(db, 'ada@example.test');
    expect(basket?.lines.map((l) => l.sku)).toEqual(['PRICED', 'UNPRICED']);
    expect(basket?.lines[1].unitMinor).toBe(0);
    expect(basket?.lines[1].lineMinor).toBe(0);
    expect(basket?.totalMinor).toBe(500_000);

    const row = (await listProspects(db, { tab: 'basket' })).items[0];
    expect(row.basketItems).toBe(5);
    expect(row.basketItems).toBe(basket?.lines.reduce((n, l) => n + l.qty, 0));
    expect(row.basketMinor).toBe(basket?.totalMinor);
  });

  it('shows when a broadcast last reached somebody, and ignores one still queued', async () => {
    // Nothing else in this file seeds a send, so `lastNudgeAt` hardcoded to
    // null passed every other assertion here — a wrong table, a wrong status
    // literal or a wrong join column would have been invisible until Task 6.
    const db = await seedShop();
    await giveBasket(db, 'mailed@example.test');
    await giveSubscription(db, 'mailed@example.test');
    await giveBasket(db, 'queued@example.test');
    await giveSubscription(db, 'queued@example.test');

    // TWO broadcasts, because `email_broadcast_recipients_dedupe_uq` is
    // (broadcast_id, subscriber_id): one person can be in a send only once, so
    // proving the later send wins takes a second one.
    const older = await seedBroadcast(db);
    const newer = await seedBroadcast(db);
    await seedRecipient(db, older, 'mailed@example.test', {
      status: 'sent',
      sentAt: S0 + DAY,
    });
    await seedRecipient(db, newer, 'mailed@example.test', {
      status: 'sent',
      sentAt: S0 + 3 * DAY,
    });
    // Queued and not sent. An enqueued recipient is not a nudge until it lands,
    // and a drain that crashes leaves rows in exactly this state.
    await seedRecipient(db, newer, 'queued@example.test', { status: 'pending' });

    const page = await listProspects(db, { tab: 'basket' });
    const nudged = new Map(page.items.map((p) => [p.email, p.lastNudgeAt]));
    expect(nudged.get('mailed@example.test')).toBe(S0 + 3 * DAY);
    expect(nudged.get('queued@example.test')).toBeNull();
  });

  it('finds somebody by part of their address', async () => {
    const db = await seedShop();
    await giveBasket(db, 'ada@example.test');
    await giveBasket(db, 'grace@example.test');

    const page = await listProspects(db, { tab: 'basket', query: 'ADA@' });
    expect(page.items.map((p) => p.email)).toEqual(['ada@example.test']);
  });
});

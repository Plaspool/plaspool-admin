import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb, resetShopTables } from '../test/harness';
import { fakeCatalog } from '../test/fake-catalog';
import type { CartFakeCatalog } from '../test/fake-catalog';
import { addLine, createCart, getCart, setLineQty, listLines } from '../cart/repo';
import { freezeCheckout, previewCheckout, putAddresses, setShipping, thawCheckout, frozenTotals } from './repo';
import { setAddOnChoice } from './add-ons';
import type { CheckoutConfig } from './repo';
import type { ShippingZone } from './shipping';
import { CartPreconditionError, CartStaleWriteError, NotImplementedError } from '../errors';
import type { Db } from '../../../db/client';
import type { AddOnCartInput, AddOnOffer, AddOnPort } from '../../../../shared/commerce/add-ons';

/**
 * Add-ons on a cart (spec §6): offers ride the preview, an answer is stored on
 * the cart under CAS, an unanswered ask is priced as declined, an include beats
 * a stale answer, and the freeze writes the result into the frozen totals.
 * The PORT IS A FAKE — the rules are proved in catalog/add-ons; what is
 * unproven until here is what Cart does with each answer.
 */
let db: Db;
let close: () => Promise<void>;
let catalog: CartFakeCatalog;

const CURRENCY = 'GBP';
const ZONES: readonly ShippingZone[] = [
  { id: 'domestic', label: 'UK', countries: ['GB'], taxRateBps: 2000, taxLabel: 'VAT', shippingTaxable: false, options: [{ id: 'standard', label: 'Standard', amountMinor: 400 }], fallback: true },
];
const UK = { name: 'A Shopper', line1: '1 High Street', line2: null, city: 'London', region: 'London', postalCode: 'E1 6AN', countryCode: 'GB', phone: null };

/** Asks up to 4 items, includes free from 5 — the demo, as a port answer. */
let seen: AddOnCartInput[] = [];
const box = (input: AddOnCartInput): AddOnOffer[] => {
  const qty = input.lines.reduce((n, l) => n + l.qty, 0);
  const base = { id: 'ado_box', title: 'Gift box', description: null, imageUrl: null, price: { amount: 1500, currency: CURRENCY }, units: 1, basis: 'order' as const };
  if (qty >= 5) return [{ ...base, unitAmount: { amount: 0, currency: CURRENCY }, amount: { amount: 0, currency: CURRENCY }, mode: 'include', choice: null }];
  if (qty >= 1) return [{ ...base, unitAmount: { amount: 1500, currency: CURRENCY }, amount: { amount: 1500, currency: CURRENCY }, mode: 'ask', choice: input.choices?.ado_box ?? null }];
  return [];
};
const port: AddOnPort<Db> = {
  async offers(_db, input) {
    seen.push(input);
    return box(input);
  },
};

const config = (withPort = true): CheckoutConfig => ({ zones: ZONES, storeCurrency: CURRENCY, ...(withPort ? { addOns: port } : {}) });

async function readyCart(qty = 2) {
  const cart = await createCart(db, { currency: CURRENCY, customerId: null });
  await addLine(db, { cartId: cart.id, variantId: 'var_tee', qty });
  await putAddresses(db, config(), { cartId: cart.id, shipping: UK, billing: null });
  await setShipping(db, config(), { cartId: cart.id, optionId: 'standard' });
  return (await getCart(db, cart.id))!;
}

const stored = async (cartId: string) =>
  (await db.execute(sql`SELECT add_on_choices FROM shop_carts WHERE id = ${cartId}`)).rows[0]?.add_on_choices ?? null;

beforeAll(async () => {
  ({ db, close } = await migratedDb());
  catalog = fakeCatalog([{ variantId: 'var_tee', productId: 'prd_tee', sku: 'TEE', title: 'Tee', price: { amount: 2000, currency: CURRENCY }, onHand: 50, weightGrams: 200 }]);
});
afterAll(() => close());
beforeEach(async () => {
  await resetShopTables(db);
  seen = [];
});

describe('the preview', () => {
  it('reports the offers and prices an unanswered ask as declined', async () => {
    const cart = await readyCart(2);
    const preview = await previewCheckout(db, catalog, config(), { cartId: cart.id });
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.addOns).toEqual([expect.objectContaining({ id: 'ado_box', mode: 'ask', choice: null })]);
    expect(preview.totals.addOns).toEqual([]);
    expect(preview.totals.grandTotal.amount).toBe(4000 + 400 + 800);
    // The port was handed the cart's facts, subtotal after the ladder included.
    expect(seen[0]).toMatchObject({ currency: CURRENCY, subtotalMinor: 4000, signedIn: false, hasDiscountCode: false, address: { country: 'GB', region: 'London' }, shippingOptionId: 'standard' });
    expect(seen[0]?.lines[0]).toMatchObject({ productId: 'prd_tee', sku: 'TEE', qty: 2, weightGrams: 200, lineTotalMinor: 4000 });
  });

  it('answers no offers and no addOns key at all without a port', async () => {
    const cart = await readyCart(2);
    const preview = await previewCheckout(db, catalog, config(false), { cartId: cart.id });
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.addOns).toEqual([]);
    expect(preview.totals.addOnTotal.amount).toBe(0);
  });
});

describe('the choice', () => {
  it('stores an answer under CAS and prices it on the next read', async () => {
    const cart = await readyCart(2);
    const result = await setAddOnChoice(db, catalog, config(), { cartId: cart.id, addOnId: 'ado_box', choice: 'accepted', baseRevision: cart.revision, now: 1 });
    expect(result.ok && result.offers[0]?.choice).toBe('accepted');
    expect(result.ok && result.cart.revision).toBe(cart.revision + 1);
    expect(await stored(cart.id)).toEqual({ ado_box: 'accepted' });
    const preview = await previewCheckout(db, catalog, config(), { cartId: cart.id });
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.totals.addOns).toEqual([{ id: 'ado_box', title: 'Gift box', mode: 'chosen', listPrice: { amount: 1500, currency: CURRENCY }, unitAmount: { amount: 1500, currency: CURRENCY }, units: 1, basis: 'order', amount: { amount: 1500, currency: CURRENCY } }]);
    expect(preview.totals.grandTotal.amount).toBe(4000 + 400 + 800 + 1500);
  });

  it('overwrites, refuses a stale revision, and refuses a frozen cart', async () => {
    const cart = await readyCart(2);
    await setAddOnChoice(db, catalog, config(), { cartId: cart.id, addOnId: 'ado_box', choice: 'accepted', now: 1 });
    await setAddOnChoice(db, catalog, config(), { cartId: cart.id, addOnId: 'ado_box', choice: 'declined', now: 2 });
    expect(await stored(cart.id)).toEqual({ ado_box: 'declined' });
    await expect(setAddOnChoice(db, catalog, config(), { cartId: cart.id, addOnId: 'ado_box', choice: 'accepted', baseRevision: 1, now: 3 })).rejects.toBeInstanceOf(CartStaleWriteError);
    const frozen = await freezeCheckout(db, catalog, config(), { cartId: cart.id });
    expect(frozen.ok).toBe(true);
    await expect(setAddOnChoice(db, catalog, config(), { cartId: cart.id, addOnId: 'ado_box', choice: 'accepted', now: 4 })).rejects.toBeInstanceOf(CartPreconditionError);
  });

  it('refuses an add-on that is not an ask offer, and 501s without a port', async () => {
    const cart = await readyCart(5);
    expect(await setAddOnChoice(db, catalog, config(), { cartId: cart.id, addOnId: 'ado_box', choice: 'accepted', now: 1 })).toEqual({ ok: false, reason: 'not_offered' });
    expect(await setAddOnChoice(db, catalog, config(), { cartId: cart.id, addOnId: 'ado_nope', choice: 'accepted', now: 1 })).toEqual({ ok: false, reason: 'not_offered' });
    await expect(setAddOnChoice(db, catalog, config(false), { cartId: cart.id, addOnId: 'ado_box', choice: 'accepted', now: 1 })).rejects.toBeInstanceOf(NotImplementedError);
  });
});

describe('the freeze', () => {
  it('writes an accepted add-on into the frozen totals, and an include beats a stale answer', async () => {
    const cart = await readyCart(2);
    await setAddOnChoice(db, catalog, config(), { cartId: cart.id, addOnId: 'ado_box', choice: 'declined', now: 1 });
    // The shopper adds three more: the include rule now decides, the decline is inert.
    const line = (await listLines(db, cart.id))[0]!;
    await setLineQty(db, { cartId: cart.id, lineId: line.id, qty: 5 });
    const frozen = await freezeCheckout(db, catalog, config(), { cartId: cart.id });
    if (!frozen.ok) throw new Error(frozen.reason);
    expect(frozen.totals.addOns).toEqual([expect.objectContaining({ id: 'ado_box', mode: 'included', amount: { amount: 0, currency: CURRENCY } })]);
    expect((await frozenTotals(db, cart.id)).addOns.length).toBe(1);
    expect(await stored(cart.id)).toEqual({ ado_box: 'declined' });
  });

  it('a thaw keeps the answers, and the re-freeze reads them again', async () => {
    const cart = await readyCart(2);
    await setAddOnChoice(db, catalog, config(), { cartId: cart.id, addOnId: 'ado_box', choice: 'accepted', now: 1 });
    const first = await freezeCheckout(db, catalog, config(), { cartId: cart.id });
    if (!first.ok) throw new Error(first.reason);
    expect(first.totals.addOnTotal.amount).toBe(1500);
    await thawCheckout(db, { ...config(), payments: { async intentsFor() { return []; }, async cancel() {} } } as CheckoutConfig, { cartId: cart.id });
    expect(await stored(cart.id)).toEqual({ ado_box: 'accepted' });
    const second = await freezeCheckout(db, catalog, config(), { cartId: cart.id });
    if (!second.ok) throw new Error(second.reason);
    expect(second.totals.addOnTotal.amount).toBe(1500);
  });
});

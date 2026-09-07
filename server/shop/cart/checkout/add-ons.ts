import { sql } from 'drizzle-orm';
import type { Db } from '../../../db/client';
import { NotFoundError } from '../../../repo/errors';
import { CartPreconditionError, CartStaleWriteError, NotImplementedError } from '../errors';
import { getCart, listLines } from '../cart/repo';
import type { Cart, CartLine } from '../cart/repo';
import { computeTotals } from '../totals/compute';
import { getAddress } from './repo';
import { unknownZoneTaxRate } from './shipping';
import type { CatalogPort, VariantQuote } from '../catalog-port';
import type { CheckoutConfig } from './repo';
import type { AddressSnapshot } from '../../../../shared/commerce/events';
import type { FrozenAddOn } from '../../../../shared/commerce/ports';
import type { AddOnChoice, AddOnOffer, AddOnPort } from '../../../../shared/commerce/add-ons';

/**
 * Cart's half of add-ons (spec §6): turn quotes into the port's input, the
 * port's offers into what the totals engine charges, and store an answer.
 *
 * ONE PLACE FOR "WHAT IS APPLIED". priceCart, the cart view and the choice
 * route all need it, and three copies would disagree the first time one of
 * them was edited: an include is applied, an accepted ask is applied, and an
 * unanswered ask is NOT — owner's decision, 2026-09-06 — so the freeze never
 * refuses over an add-on.
 */
export interface QuotedLine {
  line: CartLine;
  quote: VariantQuote | null;
}

/** Σ lineTotal after the bulk ladder — the subtotal the rules compare against. */
export function subtotalOf(currency: string, quotes: readonly QuotedLine[]): number {
  const res = computeTotals({
    currency,
    lines: quotes.map(({ line, quote }) => ({
      variantId: line.variantId,
      productId: quote?.productId ?? line.variantId,
      qty: line.qty,
      unit: quote ? { amount: quote.price.amount, currency: quote.price.currency } : null,
      bulkTiers: quote?.bulkTiers ?? [],
    })),
    shipping: null,
    tax: unknownZoneTaxRate(),
    adjustments: [],
  });
  return res.ok ? res.totals.subtotal.amount : 0;
}

/**
 * THREE OFFER MODES, THREE ORDER MODES, AND THEY DO NOT LINE UP ONE TO ONE.
 * An `opt_out` add-on the shopper LEFT ALONE is `included` at ₦0 — the box is
 * in the price and the packer still has to put one in — while one they took
 * out is `removed` at a negative amount. Only a declined `opt_out` is ever
 * negative, which is what makes "did this order pay money back" a mode check
 * rather than a sign check.
 */
export function toFrozenAddOn(offer: AddOnOffer): FrozenAddOn {
  const mode =
    offer.mode === 'ask'
      ? 'chosen'
      : offer.mode === 'include'
        ? 'included'
        : offer.choice === 'declined'
          ? 'removed'
          : 'included';
  return {
    id: offer.id,
    title: offer.title,
    mode,
    listPrice: offer.price,
    unitAmount: offer.unitAmount,
    units: offer.units,
    basis: offer.basis,
    amount: offer.amount,
  };
}

export async function evaluateCartAddOns(
  db: Db,
  port: AddOnPort<Db> | undefined,
  a: { cart: Cart; quotes: readonly QuotedLine[]; address: AddressSnapshot | null; subtotalMinor: number },
): Promise<{ offers: AddOnOffer[]; applied: FrozenAddOn[] }> {
  if (!port) return { offers: [], applied: [] };
  const offers = await port.offers(db, {
    currency: a.cart.currency,
    lines: a.quotes.map(({ line, quote }) => ({
      productId: quote?.productId ?? line.variantId,
      variantId: line.variantId,
      sku: quote?.sku ?? '',
      qty: line.qty,
      weightGrams: quote?.weightGrams ?? null,
      lineTotalMinor: quote ? quote.price.amount * line.qty : 0,
    })),
    subtotalMinor: a.subtotalMinor,
    address: a.address
      ? { country: a.address.countryCode, region: a.address.region ?? null, district: a.address.district ?? null }
      : null,
    shippingOptionId: a.cart.shippingOptionId,
    signedIn: a.cart.customerId !== null,
    hasDiscountCode: a.cart.discountCode !== null,
    choices: a.cart.addOnChoices,
  });
  /*
   * An `opt_out` add-on is ALWAYS applied, whichever way it went: kept, it
   * belongs on the order at ₦0 so the packer knows to put a box in; removed,
   * it belongs on the order as the negative that paid the shopper back. It is
   * the one mode with nothing to leave off.
   */
  const applied = offers
    .filter((o) => o.mode === 'include' || o.mode === 'opt_out' || o.choice === 'accepted')
    .map(toFrozenAddOn);
  return { offers, applied };
}

/** The offers as they stand for this cart, from a fresh read of its lines. */
async function currentOffers(db: Db, catalog: CatalogPort, port: AddOnPort<Db>, cart: Cart) {
  const lines = await listLines(db, cart.id);
  const quotes: QuotedLine[] = await Promise.all(
    lines.map(async (line) => ({ line, quote: await catalog.quote(db, line.variantId) })),
  );
  const address = await getAddress(db, cart.id, 'shipping');
  return evaluateCartAddOns(db, port, { cart, quotes, address, subtotalMinor: subtotalOf(cart.currency, quotes) });
}

export type AddOnChoiceOutcome =
  | { ok: true; cart: Cart; offers: AddOnOffer[] }
  /** Not an ask offer for this cart right now — unknown id included. */
  | { ok: false; reason: 'not_offered' };

/**
 * Record the shopper's answer. Open cart only; CAS on revision; the statement
 * merges one key into the jsonb so two answers cannot clobber each other.
 */
export async function setAddOnChoice(
  db: Db,
  catalog: CatalogPort,
  config: CheckoutConfig,
  a: { cartId: string; addOnId: string; choice: AddOnChoice; baseRevision?: number; now: number },
): Promise<AddOnChoiceOutcome> {
  const cart = await getCart(db, a.cartId);
  if (!cart) throw new NotFoundError(a.cartId);
  const snap = { id: cart.id, status: cart.status, revision: cart.revision, currency: cart.currency };
  if (cart.status !== 'open') throw new CartPreconditionError('add_on_choice', snap);
  if (!config.addOns) throw new NotImplementedError('add_ons');

  const { offers } = await currentOffers(db, catalog, config.addOns, cart);
  const offer = offers.find((o) => o.id === a.addOnId);
  /* `include` is the only mode with no question in it. `opt_out` takes an
   * answer for the same reason `ask` does — the shopper is choosing — it is
   * just that its default is yes rather than no. */
  if (!offer || offer.mode === 'include') return { ok: false, reason: 'not_offered' };

  const base = a.baseRevision ?? cart.revision;
  const res = await db.execute(sql`
    UPDATE shop_carts
       SET add_on_choices = coalesce(add_on_choices, '{}'::jsonb)
                            || jsonb_build_object(${a.addOnId}::text, ${a.choice}::text),
           revision = revision + 1,
           updated_at = ${a.now}
     WHERE id = ${a.cartId} AND revision = ${base} AND status = 'open'
    RETURNING revision`);
  if (res.rows.length === 0) {
    const after = await getCart(db, a.cartId);
    if (!after) throw new NotFoundError(a.cartId);
    const afterSnap = { id: after.id, status: after.status, revision: after.revision, currency: after.currency };
    if (after.status !== 'open') throw new CartPreconditionError('add_on_choice', afterSnap);
    throw new CartStaleWriteError(base, after.revision, afterSnap);
  }

  const after = (await getCart(db, a.cartId))!;
  const fresh = await currentOffers(db, catalog, config.addOns, after);
  return { ok: true, cart: after, offers: fresh.offers };
}

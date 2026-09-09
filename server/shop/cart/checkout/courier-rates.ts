import { money } from '../../../../shared/commerce/money';
import type { AddressSnapshot } from '../../../../shared/commerce/events';
import type { ShippingQuote } from '../../../../shared/commerce/ports';
import type { Db } from '../../../db/client';
import { resolveLogisticsDeps } from '../../logistics/deps';
import type { ParcelInput, ParcelLine, ProviderId } from '../../logistics/port';
import { activeCourier, getLogisticsSettings } from '../../logistics/repo';
import { declaredValueMinor } from '../../logistics/weights';
import type { CartLine } from '../cart/repo';
import type { CatalogPort } from '../catalog-port';

/**
 * DELIVERY PRICED BY THE COURIER, WHEN ONE IS SWITCHED ON.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS THE ONLY PLACE A NETWORK CALL ENTERS PRICING, AND IT CAN ALWAYS BE
 * DECLINED. Every function here answers `null` for "no courier price" — no
 * courier selected, none configured, or the courier refused/timed out — and
 * every caller reads `null` as "use the hand-set zone and district rates,
 * exactly as before". A shop whose courier is down keeps selling at the
 * owner's own numbers rather than showing an empty delivery step.
 *
 * That fallback is the whole reason `shop_shipping_zones` and
 * `shop_delivery_areas` stay: they are no longer the price when Fez is on,
 * they are the price when Fez cannot be reached.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY NOT INSIDE THE TOTALS ENGINE: `checkout/shipping.ts` says a `zoneFor()`
 * that queried a table would put a database inside the one function that must
 * not have one. That rule is about `compute.ts`, which is pure and stays pure.
 * This module runs BEFORE it and hands the result in as an option, which is the
 * same seam the zone rows already arrive through.
 */

/**
 * ₦1,000. The courier's price is rounded UP to the next multiple of this
 * before a shopper ever sees it (the owner's call, 2026-09-09).
 *
 * ROUNDED UP, NEVER TO NEAREST: the rounding is also the margin. Fez's number
 * is what the shop PAYS, so a price rounded down is a loss taken silently on
 * every order in that band, and the amount lost would be invisible in exactly
 * the way the flat ₦3,000 was.
 */
export const ROUND_UP_TO_MINOR = 100_000;

/**
 * What one unit weighs when the catalogue does not say (the owner's rule,
 * 2026-09-09): **per unit, so weight tracks quantity.**
 *
 * `weights.ts#totalGrams` counts an unknown weight as ZERO, which is right for
 * the booking screen — it can show the operator which lines to go and fill in.
 * It is wrong here, because nobody is watching: a four-spool order would weigh
 * in at Fez's 1 kg floor, quote in the 0–5 kg band, and the shop would pay the
 * difference on a parcel it had already sold. One kilogram per unit keeps the
 * estimate on the safe side of that and makes a heavy basket cost more, which
 * is the only property that actually has to hold.
 *
 * IT IS A FLOOR UNDER A GUESS, NOT A SUBSTITUTE FOR THE REAL FIGURE. A variant
 * with `weight_grams` set always uses its own weight; this constant only ever
 * fills a hole. Filling those holes in the catalogue makes every quote tighter.
 */
export const DEFAULT_ITEM_GRAMS = 1000;

/** How long a courier's answer for one (state, kg) may be reused. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * HOW LONG A SHOPPER WAITS FOR A COURIER BEFORE THE FLAT RATE ANSWERS.
 *
 * SHORTER THAN THE CLIENTS' OWN 8s ON PURPOSE, because this is the one call
 * path where somebody is watching a spinner. Terminal drafts a shipment and
 * then rates several carriers, and was measured timing out at 8s against its
 * sandbox (2026-09-09); Fez posts one small body and answers well inside
 * this. Waiting the client's full budget only to fall back anyway spends
 * eight seconds of a checkout to reach the same number.
 */
const QUOTE_DEADLINE_MS = 4_000;

class QuoteTimeout extends Error {
  constructor() {
    super(`no answer within ${QUOTE_DEADLINE_MS}ms`);
  }
}

/**
 * The option id a courier-priced delivery carries: the provider, then the
 * price it was quoted at, in minor units — `fez:400000`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE AMOUNT IS IN THE ID BECAUSE THE CART STORES NOTHING ELSE, and the freeze
 * re-derives an option from its id (`priceCheckout`). A zone option can be
 * re-derived because its price sits in a table; a courier's cannot, so the id
 * carries it and the number the shopper agreed to is the number that is
 * charged — no second call to Fez at the payment step, and nothing to drift.
 * It is the same decision `putAddresses` already made about the zone: "stored,
 * not re-derived at freeze time. Deriving it twice is two chances to derive it
 * differently."
 *
 * **NEVER TRUST AN AMOUNT THAT ARRIVED OVER HTTP.** `setShipping` takes an
 * `optionId` from the request body, so a shopper could post `fez:1`. It
 * therefore reads only the PREFIX off what it is given, quotes for itself, and
 * writes its own id. Nothing downstream parses an id the server did not write.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function courierOptionId(provider: ProviderId, amountMinor: number): string {
  return `${provider}:${amountMinor}`;
}

/** The amount in a server-written courier option id, or `null` for any other id. */
export function amountFromCourierOptionId(optionId: string): number | null {
  const m = /^(fez|terminal):(\d+)$/.exec(optionId);
  return m ? Number(m[2]) : null;
}

/** Whether an id names a courier-priced option at all — prefix only, no amount. */
export function isCourierOptionId(optionId: string): boolean {
  return /^(fez|terminal):/.test(optionId);
}

/** Up to the next whole ₦1,000. Already-round amounts are left alone. */
export function roundUp(amountMinor: number, to = ROUND_UP_TO_MINOR): number {
  return Math.ceil(amountMinor / to) * to;
}

/**
 * Grams for the whole basket, with `DEFAULT_ITEM_GRAMS` standing in for every
 * unit the catalogue cannot weigh. The box itself is added once.
 */
function basketGrams(
  lines: readonly CartLine[],
  weights: Map<string, number | null>,
  packagingKg: number,
): number {
  const goods = lines.reduce((sum, line) => {
    const known = weights.get(line.variantId);
    return sum + (known == null ? DEFAULT_ITEM_GRAMS : known) * line.qty;
  }, 0);
  return goods + Math.round(packagingKg * 1000);
}

const cache = new Map<string, { amountMinor: number; eta?: string; at: number }>();

/**
 * The courier's price for this basket to this address, rounded up — or `null`
 * to mean "price it by hand", which is every failure this can have.
 *
 * `taxable` IS THE ZONE'S ANSWER, NOT THE COURIER'S. Whether delivery is taxed
 * is a fact about the jurisdiction, and the zone rows already carry it; a
 * courier knows what it charges and nothing about VAT.
 */
export async function courierShippingOptions(
  db: Db,
  a: {
    lines: readonly CartLine[];
    address: AddressSnapshot;
    currency: string;
    taxable: boolean;
    /**
     * TITLE, SKU, PRICE AND WEIGHT PER LINE, all four of which a courier
     * wants and none of which Cart owns. Terminal refuses a parcel whose
     * items have no description or no value (both measured against its
     * sandbox, 2026-09-09); Fez reads only the weight. Asking Catalog once
     * per line is what `priceCheckout` already does a few lines further on.
     */
    catalog: CatalogPort;
  },
): Promise<ShippingQuote[] | null> {
  if (a.lines.length === 0) return null;

  let provider: ProviderId;
  try {
    const setting = await activeCourier(db);
    if (setting === 'manual') return null;
    provider = setting;
  } catch {
    return null;
  }

  const deps = resolveLogisticsDeps();
  const adapter = deps.providerFor(provider);
  if (!adapter) return null;

  try {
    const settings = await getLogisticsSettings(db);
    const quotes = await Promise.all(
      a.lines.map((line) => a.catalog.quote(db, line.variantId).then((q) => ({ line, q }))),
    );
    const weights = new Map(quotes.map(({ line, q }) => [line.variantId, q?.weightGrams ?? null]));
    const grams = basketGrams(a.lines, weights, settings.packaging.weightKg);

    /* The courier's own banding is coarser than this, so a cache keyed on whole
       kilograms answers most repeat baskets to the same state without a call. */
    const kg = Math.max(1, Math.ceil(grams / 1000));
    const key = `${provider}:${(a.address.region ?? a.address.city).toLowerCase()}:${kg}`;
    const hit = cache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < CACHE_TTL_MS) {
      return [toQuote(provider, hit.amountMinor, hit.eta, a.currency, a.taxable)];
    }

    const items: ParcelLine[] = quotes.map(({ line, q }) => ({
      orderLineId: line.id,
      variantId: line.variantId,
      /* TERMINAL REFUSES A PARCEL WHOSE ITEMS CARRY NO DESCRIPTION OR NO
         VALUE — "1 or more of your items is missing a description", then
         "...has an invalid value" — where Fez reads neither. Both measured
         against Terminal's sandbox, 2026-09-09. The fallbacks below are for
         a variant Catalog cannot resolve at all, which is rare and must not
         cost the shopper a delivery price. */
      title: q?.title || 'Item',
      sku: q?.sku || line.variantId,
      qty: line.qty,
      unitMinor: q?.price.amount ?? 0,
      /* The SAME substitution `basketGrams` made, so the adapter's own total
         agrees with the one this cache was keyed on. */
      weightGrams: q?.weightGrams ?? DEFAULT_ITEM_GRAMS,
    }));

    const input: ParcelInput = {
      /* NO FULFILMENT EXISTS YET — there is no order. Both fields are read by
         `book()` and by nothing on the quote path (Fez posts state and weight;
         Terminal posts addresses and parcels), so a quote for a basket names
         the basket. */
      fulfillmentId: 'quote',
      orderNumber: 'quote',
      to: {
        name: a.address.name,
        phone: a.address.phone,
        email: null,
        line1: a.address.line1,
        line2: a.address.line2,
        city: a.address.city,
        region: a.address.region ?? '',
        postalCode: a.address.postalCode,
        countryCode: a.address.countryCode,
        /* Optional on the snapshot (absent on every address written before 1020)
           and `null` on the wire mean the same thing to every adapter. */
        routingCity: a.address.routingCity ?? null,
      },
      from: settings.shipFrom,
      items,
      valueMinor: declaredValueMinor(items),
      packaging: settings.packaging,
      packagingRef: settings.terminalPackagingId,
    };

    /* The courier's own client has a timeout; this one bounds the SHOPPER's
       wait, whichever courier is on and whatever it was built with. */
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      adapter.quote(input),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new QuoteTimeout()), QUOTE_DEADLINE_MS);
      }),
    ]).finally(() => clearTimeout(deadline));
    const cheapest = result.options.reduce<(typeof result.options)[number] | null>(
      (best, o) => (best == null || o.amountMinor < best.amountMinor ? o : best),
      null,
    );
    if (!cheapest) return null;

    const amountMinor = roundUp(cheapest.amountMinor);
    cache.set(key, { amountMinor, eta: cheapest.eta, at: now });
    return [toQuote(provider, amountMinor, cheapest.eta, a.currency, a.taxable)];
  } catch (err) {
    /* EVERY refusal lands here on purpose — bad credentials, a state the courier
       does not serve, a timeout, a 500. The shopper gets the owner's hand-set
       rate and the checkout keeps working; nothing about a courier's bad
       afternoon should be able to stop the shop taking money.
       BUT IT IS SAID OUT LOUD. A silent fallback is indistinguishable from a
       working courier — the shop would quietly sell delivery at a flat rate it
       thought it had stopped using, which is the failure this whole change
       exists to end. One line in the function log is what makes "Fez priced it"
       and "Fez was down" different events. */
    console.warn(
      `[courier-rates] ${provider} did not quote; falling back to the hand-set rate:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * THE ESTIMATE IS ITS OWN FIELD AND NOT PART OF THE LABEL, so a storefront can
 * style it apart from the courier's name — and so nothing has to parse a
 * display string to get at it. It was glued into the label first; a label that
 * two different reads of the same option word differently is a label somebody
 * eventually writes a regex against.
 */
function toQuote(
  provider: ProviderId,
  amountMinor: number,
  eta: string | undefined,
  currency: string,
  taxable: boolean,
): ShippingQuote {
  return {
    id: courierOptionId(provider, amountMinor),
    label: COURIER_LABEL[provider],
    amount: money(amountMinor, currency),
    taxable,
    ...(eta ? { eta } : {}),
  };
}

/** What the shopper sees. Not `PROVIDER_LABEL` from the admin: that file is UI. */
const COURIER_LABEL: Record<ProviderId, string> = {
  fez: 'Fez Delivery',
  terminal: 'Courier delivery',
};

/** Clears the memo. For a settings change that should take effect at once. */
export function resetCourierRateCache(): void {
  cache.clear();
}

/** The shopper-facing name behind a stored courier option id. */
export function courierLabel(optionId: string): string {
  return optionId.startsWith('terminal:') ? COURIER_LABEL.terminal : COURIER_LABEL.fez;
}

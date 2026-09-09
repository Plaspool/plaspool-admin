import { sql } from 'drizzle-orm';
import { toEpochMs } from '../../../db/client';
import type { Db } from '../../../db/client';
import { BadRequestError, NotFoundError } from '../../../repo/errors';
import { CartPreconditionError, CartStaleWriteError, NotImplementedError } from '../errors';
import { newId } from '../ids';
import { CART_TTL_MS, canTransition, getCart, listLines, updateCartFields } from '../cart/repo';
import type { Cart } from '../cart/repo';
import { paymentStatusRank } from '../../../../shared/commerce/ports';
import type { CheckoutPaymentsPort } from '../payments-port';
import { heldReservations, reserveForCheckout } from '../reservations/repo';
import { computeTotals, parseFrozenTotals } from '../totals/compute';
import {
  shippingOptionById,
  shippingOptionsFor,
  taxRateFor,
  unknownZoneTaxRate,
  zoneFor,
} from './shipping';
import type { ShippingZone } from './shipping';
import { DEFAULT_DELIVERY_RULES, serviceRefusal } from '../../settings/repo';
import type { DeliveryRules } from '../../settings/repo';
import type { CatalogPort } from '../catalog-port';
import {
  amountFromCourierOptionId,
  courierLabel,
  courierShippingOptions,
  isCourierOptionId,
} from './courier-rates';
import { money } from '../../../../shared/commerce/money';
import type { Reservation, Shortfall } from '../reservations/repo';
import type { TotalsInputLine } from '../totals/compute';
import type {
  AddressLocation,
  AddressSnapshot,
  CheckoutCompletedLine,
  CheckoutCompletedPayload,
} from '../../../../shared/commerce/events';
import type { FrozenTotals, ShippingQuote } from '../../../../shared/commerce/ports';
import type {
  PointsRedemptionPort,
  RedemptionQuote,
} from '../../../../shared/marketing/redemption';
import type {
  DiscountCodePort,
  DiscountRejection,
} from '../../../../shared/marketing/discounts';
import type { CodeDiscount } from '../../../../shared/commerce/ports';
import { evaluateCartAddOns } from './add-ons';
import type { AddOnOffer, AddOnPort } from '../../../../shared/commerce/add-ons';

/**
 * Checkout — a state machine over the cart (brief §5).
 *
 * `open → converting → converted`, plus `abandoned`. There is no separate
 * checkout aggregate and no `shop_checkouts` table: `checkoutId` IS the cart id,
 * so `CheckoutPort.totals(db, checkoutId)` and every route below take the same
 * value. A second identity would need a mapping whose only job is to be got
 * wrong.
 *
 * ═══ WHAT FREEZING MEANS, AND WHY IT IS A ONE-WAY DOOR ═══
 *
 * `freezeCheckout` runs the pure totals engine ONCE, writes the result to
 * `shop_carts.frozen_totals`, and moves the cart to `converting` in the same
 * statement. From that instant the number is the price: `frozenTotals()` reads
 * the column and never re-runs the engine, so a price change, a tax-table edit
 * or a shipping re-quote between freeze and capture cannot move what the
 * customer is charged. `repo.test.ts` doubles the price under a frozen checkout
 * and asserts the total does not move.
 *
 * Everything the cart can still be edited through is guarded on
 * `status = 'open'`, so a frozen checkout's addresses and lines are immutable by
 * construction rather than by convention.
 */

export interface CheckoutConfig {
  zones: readonly ShippingZone[];
  /**
   * How addresses are collected and which regions are served — the
   * `shop_delivery_settings` singleton (migration 0760), loaded per request
   * beside the zones so a switch the owner flips reaches the next checkout
   * call rather than the next deploy.
   *
   * OPTIONAL, AND ABSENT MEANS `DEFAULT_DELIVERY_RULES` — district mode, no
   * region restriction, which is the behaviour every total in this file had
   * before the settings row existed. That is what makes this additive: a
   * caller that never heard of delivery settings prices exactly as it did.
   */
  rules?: DeliveryRules;
  storeCurrency: string;
  /**
   * SpoolPoints, if this deployment wired them (admin#2). See
   * `ShopCartDeps.redemption` for why it is a factory rather than a port, and
   * `freezeCheckout` for what it does with it. Absent is the ordinary case and
   * means no adjustment — the behaviour every total in this file had before.
   */
  redemption?: (db: Db) => PointsRedemptionPort;
  /**
   * Discount codes, if this deployment wired them (admin#100 Part B). A factory
   * over the request's handle, for the reason `redemption` is one.
   *
   * ABSENT MEANS THE FEATURE IS OFF, and the cart view stops advertising it —
   * `discountCodesEnabled` is derived from this and nothing else, so a
   * storefront never renders a field whose route would 501.
   */
  discounts?: (db: Db) => DiscountCodePort;
  /** Checkout add-ons (spec 2026-09-06). Absent means none are offered and nothing is charged. */
  addOns?: AddOnPort<Db>;
  /**
   * PAYMENTS, read-only but for one narrow cancel — the port that lets
   * `thawCheckout` open the freeze's one-way door. See
   * `server/shop/cart/payments-port.ts` for why the door needed a handle and
   * why this is the only fact Cart cannot answer for itself.
   *
   * ABSENT REFUSES — IT DOES NOT PRETEND, and that is the opposite of the
   * defaults above it. `rules`, `redemption` and `discounts` all have an absent
   * meaning that is a correct, weaker behaviour. There is no correct weaker
   * behaviour for "unfreeze a checkout without checking whether it was paid":
   * the choice is between refusing and risking a second charge. So a
   * deployment that forgets to wire this keeps answering the 409 it answers
   * today, which is a bug, rather than reopening paid carts, which is money.
   */
  payments?: CheckoutPaymentsPort;
}

// -------------------------------------------------------------------- thawing

/**
 * All a thaw actually consults — the payments port and nothing else.
 *
 * NARROWER THAN `CheckoutConfig` ON PURPOSE, and the narrowing is what lets the
 * CART surface share this. `loadConfig` in `routes/checkout.ts` reads the zones
 * table and the delivery settings on every call; a line write needs neither,
 * and making `POST /cart/lines` pay for two queries so it could satisfy a type
 * would put a round trip on the shop's hottest path to buy nothing.
 *
 * A full `CheckoutConfig` still satisfies it, so every existing caller passes
 * exactly what it passed before and no checkout call site changed.
 */
export type ThawDeps = Pick<CheckoutConfig, 'payments'>;

/**
 * `authorized` and everything above it on the payment ladder.
 *
 * THE BAR IS `authorized`, NOT `captured`, and the gap between them is the
 * whole reason this constant is named rather than inlined. `authorized` means
 * the customer finished the payment flow and the money is committed even though
 * the capture has not been recorded yet; reopening on that would be reopening a
 * cart that is about to become an order. `paymentStatusRank` puts `failed` and
 * `cancelled` BELOW `authorized` on purpose (see its comment), so both of those
 * fall the other side of this line and do not block a shopper's recovery —
 * which is exactly right, because "we stopped expecting money" is the state a
 * back-out produces.
 */
const COMMITTED_RANK = paymentStatusRank('authorized');

/** What `cancelIntent` will actually move. Anything at or above this rank is
 *  already settled one way or another and is left alone. */
const CANCELLABLE_BELOW_RANK = paymentStatusRank('cancelled');

/**
 * Unfreeze a checkout: `converting → open`, and give the shopper their basket
 * back.
 *
 * ═══ THE HANDLE ON THE INSIDE OF THE ONE-WAY DOOR ═══
 *
 * `freezeCheckout`'s header calls the freeze a one-way door and means it. What
 * it did not say is that the door had no handle: `converting → open` sat in the
 * transition allow-list from the beginning, with a comment promising "a
 * customer who backs out of checkout gets their basket back rather than a cart
 * they can never edit again", and `setCartStatus` was never once called with it
 * outside a test. `routes/cart.ts` asserted the same thing in prose — "a
 * payment that fails sends it back to `open`" — and nothing did.
 *
 * The cost was total and silent. A shopper who reached the Paystack page and
 * did not pay — closed the tab, was declined, changed their mind about the
 * address — got `409 precondition_failed / update_cart` from every subsequent
 * address or shipping edit, for ever, and `LIVE_STATUSES` kept handing the same
 * dead cart back to the cookie. This function is that promised edge.
 *
 * ═══ WHAT IT CLEARS, AND WHY CLEARING IS NOT OPTIONAL ═══
 *
 * `frozenTotals()` reads `frozen_totals` with NO STATUS GUARD, and
 * `createIntent` prices a payment from it. Flipping the status alone would
 * leave an `open`, freely editable cart whose stale frozen total is still
 * chargeable — a shopper could thaw, change their address into a different
 * shipping zone, and still be billed the old number. So the freeze's OUTPUTS go
 * with the status, in the same statement, and `frozenTotals()` then throws
 * until a new freeze runs. That is fail-closed: the failure mode of clearing
 * too much is "you must press Pay again", and of clearing too little is "you
 * were charged the wrong amount".
 *
 * `discount_code` is deliberately KEPT. It is an INPUT the shopper typed on an
 * open cart, like their lines and their address, not an output of the freeze —
 * and making somebody re-enter a promo code because their card was declined is
 * the small cruelty this whole function exists to remove.
 *
 * ═══ IDEMPOTENT, BECAUSE THE CALLER IS A RETRY ═══
 *
 * An already-open cart returns unchanged rather than raising. The storefront
 * calls this from a "change my details" button that a shopper can press twice,
 * and from a page that may have reloaded after the first call succeeded.
 */
export async function thawCheckout(
  db: Db,
  config: ThawDeps,
  a: { cartId: string; baseRevision?: number },
): Promise<Cart> {
  const cart = await getCart(db, a.cartId);
  if (!cart) throw new NotFoundError(a.cartId);
  if (cart.status === 'open') return cart;

  // `converted` and `abandoned` are terminal and the allow-list says so. A
  // converted cart is an ORDER — reopening it would be un-selling something.
  if (!canTransition(cart.status, 'open')) {
    throw new CartPreconditionError('cancel_checkout', snapshotOf(cart));
  }

  /*
   * NO PORT, NO THAW. `CheckoutConfig.payments` states the reasoning: this is
   * the one dependency in this file whose absence must refuse rather than
   * degrade, because the weaker behaviour would be reopening carts that were
   * paid for. 501 rather than 500 — permanent, named, and outside the client
   * retry policy (`cart/errors.ts`), so a misconfigured deployment is legible
   * in a log instead of being an anonymous failure retried for thirty seconds.
   */
  const port = config.payments;
  if (!port) throw new NotImplementedError('checkout_cancel');

  const intents = await port.intentsFor(db, a.cartId);
  /*
   * MONEY MOVED — REFUSED, AND THIS IS THE GUARD THE WHOLE PORT EXISTS FOR.
   *
   * A capture normally drives `converting → converted` inline, so a
   * `converting` cart is USUALLY unpaid. `completeCheckoutForIntent` documents
   * three ways that inline completion does not happen while the capture is
   * still recorded — an unwired port, an unknown exception, a lost race — and
   * each leaves a PAID cart at `converting`, indistinguishable from this
   * function's target by anything Cart can see on its own.
   *
   * Such a cart needs the sweep, which will complete it, not a thaw. Reopening
   * it and re-freezing at a new total would build the order from numbers the
   * customer was never charged.
   */
  if (intents.some((intent) => paymentStatusRank(intent.status) >= COMMITTED_RANK)) {
    throw new CartPreconditionError('checkout_paid', snapshotOf(cart));
  }

  /*
   * CANCEL FIRST, THEN REOPEN. The order matters in only one direction: a crash
   * between the two leaves cancelled intents on a still-frozen cart, which the
   * next attempt fixes and which charges nobody. The reverse order would leave
   * a live payment page pointed at a cart whose total is about to move.
   *
   * Paystack cannot be told (`cancelIntent`: it has no endpoint that cancels an
   * uncompleted transaction), so a shopper who kept the old tab can still pay
   * it. That is recorded as an anomaly by the rank ladder rather than lost, and
   * refusing to hold money we took would be the worse answer.
   */
  for (const intent of intents) {
    if (paymentStatusRank(intent.status) < CANCELLABLE_BELOW_RANK) {
      await port.cancel(db, intent.id);
    }
  }

  const now = Date.now();
  const base = a.baseRevision ?? cart.revision;
  /*
   * `status = 'converting'` IS IN THE PREDICATE, not only in the allow-list
   * check above — same discipline as `setCartStatus`, and for the same reason:
   * the allow-list ran against a row that has already been read, so on its own
   * it is exactly the stale pre-check the CAS rules forbid. A NULL bind needs
   * its cast or Postgres raises 42P18 (§5).
   */
  const res = await db.execute(sql`
    UPDATE shop_carts
       SET status = 'open',
           frozen_totals = ${null}::jsonb,
           frozen_lines = ${null}::jsonb,
           frozen_at = ${null}::bigint,
           redemption_points = ${null}::integer,
           redemption_email = ${null}::text,
           revision = revision + 1,
           updated_at = ${now},
           expires_at = ${now + CART_TTL_MS}
     WHERE id = ${a.cartId} AND revision = ${base} AND status = 'converting'
    RETURNING revision`);

  if (res.rows.length === 0) {
    const after = await getCart(db, a.cartId);
    if (!after) throw new NotFoundError(a.cartId);
    // Somebody else already thawed it — the shopper's other tab, or their
    // second press. That is the outcome this caller wanted, not a conflict.
    if (after.status === 'open') return after;
    if (after.status !== 'converting') {
      throw new CartPreconditionError('cancel_checkout', snapshotOf(after));
    }
    throw new CartStaleWriteError(base, after.revision, snapshotOf(after));
  }

  const after = await getCart(db, a.cartId);
  if (!after) throw new NotFoundError(a.cartId);
  return after;
}

/**
 * Make the cart writable for an edit that is guarded on `status = 'open'`, and
 * report which revision the edit must now chain off.
 *
 * ═══ WHY THE REVISION COMES BACK ═══
 *
 * The thaw is itself a write, so it bumps `revision`. The caller's
 * `baseRevision` — the shopper's optimistic token, taken before any of this —
 * is spent HERE, on the thaw's own CAS, and is stale by the time the address
 * write runs. Handing it on unchanged would answer a successful recovery with
 * `409 stale_write`, which is the same dead end this function was written to
 * remove, one step further along. So the edit chains off the revision the thaw
 * produced: the shopper's token is still checked exactly once, at the first
 * write that consumes it.
 *
 * A cart that is already `open` returns the caller's own value untouched, so
 * the ordinary checkout path — which is every checkout that has not been
 * frozen — reaches `updateCartFields` with precisely what it had before this
 * function existed, and consults Payments not at all.
 *
 * ═══ EXPORTED, BECAUSE THE BASKET NEEDS THE SAME SENTENCE ═══
 *
 * `routes/cart.ts` calls this before each of its three line writes. Adding,
 * removing or re-quantifying an item is backing out of payment just as much as
 * correcting an address is — and until it did, a shopper who abandoned at
 * Paystack and came back to the cart drawer had no recovery anywhere in the
 * application: the line writes 409'd for ever, `LIVE_STATUSES` kept handing the
 * frozen basket back to the cookie, and `POST /cart` returned that same cart
 * rather than a fresh one. See `routes/cart.ts` for the two storefront triggers
 * that miss the journey and why they cannot simply be widened.
 *
 * SHARED RATHER THAN REIMPLEMENTED so the money guard is impossible to omit:
 * every caller inherits the `checkout_paid` refusal and the intent cancellation
 * from one place. A cart route that flipped the status itself would be one
 * `git grep` away from reopening a paid order.
 */
export async function makeEditable(
  db: Db,
  config: ThawDeps,
  a: { cartId: string; baseRevision?: number },
): Promise<number | undefined> {
  const cart = await getCart(db, a.cartId);
  if (!cart) throw new NotFoundError(a.cartId);
  /*
   * ONLY `converting` IS THAWED. `converted` and `abandoned` fall through
   * untouched so the guarded write refuses them exactly as it always has —
   * changing what THOSE answer is a separate decision from giving an unpaid
   * checkout its basket back, and this function is not the place to make it.
   */
  if (cart.status !== 'converting') return a.baseRevision;
  const thawed = await thawCheckout(db, config, a);
  return thawed.revision;
}

/** The four fields a 409 hands back so a client can re-render without a second
 *  request — `CartSnapshot`, built the one way rather than inline per site. */
function snapshotOf(cart: Cart) {
  return {
    id: cart.id,
    status: cart.status,
    revision: cart.revision,
    currency: cart.currency,
  };
}

// ------------------------------------------------------------------ addresses

export type AddressKind = 'shipping' | 'billing';

const COUNTRY = /^[A-Z]{2}$/;

function assertAddress(a: AddressSnapshot): void {
  if (!COUNTRY.test(a.countryCode)) throw new BadRequestError('countryCode');
  if (!a.name.trim()) throw new BadRequestError('name');
  if (!a.line1.trim()) throw new BadRequestError('line1');
  if (!a.city.trim()) throw new BadRequestError('city');
}

/**
 * MICRO-DEGREES BACK TO DEGREES (migration 0780), and this is the only place
 * that knows the column is scaled. Divided rather than multiplied because
 * integer/1e6 is exact for every value the column can hold, while the outbound
 * `Math.round(x * 1e6)` is where the one rounding happens.
 *
 * The `location_ck` constraint pairs lat, lng, source and capturedAt, so a
 * non-null latitude guarantees the other three — the casts below are total
 * rather than hopeful.
 */
function rowToLocation(row: Record<string, unknown>): AddressLocation | null {
  if (row.location_lat_e6 == null) return null;
  return {
    lat: Number(row.location_lat_e6) / 1e6,
    lng: Number(row.location_lng_e6) / 1e6,
    accuracyM: row.location_accuracy_m == null ? null : Number(row.location_accuracy_m),
    source: String(row.location_source) === 'pin' ? 'pin' : 'device',
    /* `toEpochMs` rather than `Number`, though the CHECK above already makes a
     * null unreachable here: `Number(null)` is 0, which is finite, is a valid
     * timestamp and renders as 1 January 1970 — so if that constraint were ever
     * dropped the failure would be a plausible wrong date instead of a throw. */
    capturedAt: toEpochMs(row.location_captured_at),
  };
}

function rowToAddress(row: Record<string, unknown>): AddressSnapshot {
  return {
    name: String(row.name),
    line1: String(row.line1),
    line2: row.line2 == null ? null : String(row.line2),
    city: String(row.city),
    region: row.region == null ? null : String(row.region),
    postalCode: row.postal_code == null ? null : String(row.postal_code),
    countryCode: String(row.country_code),
    phone: row.phone == null ? null : String(row.phone),
    district: row.district == null ? null : String(row.district),
    /* The courier's delivery zone (migration 1020), beside the city the
     * customer typed and never instead of it. Null on every address written
     * before 1020, which is what makes the couriers' fallback to `city` the
     * whole of today's behaviour. */
    routingCity: row.routing_city == null ? null : String(row.routing_city),
    location: rowToLocation(row),
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS LIST AND THE TWO IN `putAddresses` MOVE TOGETHER. NOTHING TYPECHECKS
 * THEM.
 *
 * A column missing HERE makes `rowToAddress` read `undefined` and quietly write
 * `null` into the frozen event — the address is stored correctly and the order
 * carries a hole. A column missing from the INSERT list never gets written at
 * all. A column missing from the `ON CONFLICT DO UPDATE SET` list is worse than
 * either: the first submission's value SURVIVES a correction, so the parcel
 * ships to an address the customer has since changed (migration 0780's header
 * argues this at length). `repo.test.ts`'s `routing city` suite pins all three
 * separately, because one happy-path round trip passes with two of them wrong.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const ADDRESS_COLUMNS = sql`name, line1, line2, city, region, postal_code, country_code,
                            phone, district, routing_city, location_lat_e6, location_lng_e6,
                            location_accuracy_m, location_source, location_captured_at`;

export async function getAddress(
  db: Db,
  cartId: string,
  kind: AddressKind,
): Promise<AddressSnapshot | null> {
  const res = await db.execute(sql`
    SELECT ${ADDRESS_COLUMNS}
      FROM shop_addresses WHERE cart_id = ${cartId} AND kind = ${kind}`);
  return res.rows[0] ? rowToAddress(res.rows[0]) : null;
}

// ----------------------------------------------------------------- districts

/**
 * What `shop_delivery_areas` says about one district (migration 0300), reduced
 * to the two facts checkout acts on.
 *
 * NO DISTRICT AND NO ROW ARE THE SAME ANSWER — `{ refused: false, rateMinor:
 * null }`, meaning "price at the state's zone", which is the live behaviour
 * before districts existed. The table stores opinions, not places; a district
 * nobody has priced is not an error and must not become one here.
 *
 * `delivers = false` MEANS REFUSED, per the owner's decision: a switched-off
 * district is a place the shop does not go, not a place at the default rate.
 */
interface DistrictRuling {
  refused: boolean;
  /** `null` means NO OVERRIDE: price from the state's zone. Never "free". */
  rateMinor: number | null;
}

const ZONE_RATE: DistrictRuling = { refused: false, rateMinor: null };

/** `config.rules`, or the pre-0760 behaviour for a caller that has none. */
function rulesOf(config: CheckoutConfig): DeliveryRules {
  return config.rules ?? DEFAULT_DELIVERY_RULES;
}

/**
 * Will the shop deliver here at all — and if not, WHICH fact refused it?
 * `'country'` (migration 1060), `'region'` (0760), or `null` for yes.
 *
 * CHECKED WHEREVER THE DISTRICT REFUSAL IS CHECKED — the address, the options,
 * the shipping choice and the freeze — because it is the same kind of fact and
 * carries the same hazard. `putAddresses` refuses at the door where the message
 * is cheapest, and the freeze refuses again because an owner can NARROW either
 * list while a cart sits at the payment step. A cart addressed before that
 * moment would otherwise sail through to a charge for a delivery the shop has
 * just said it will not make, and the answer after the freeze is a refund.
 *
 * THE RULE ITSELF LIVES IN `settings/repo.ts`, not here — including the one
 * about a region list stopping at the border — so the four call sites below
 * cannot disagree with each other about it.
 */
function serviceRefusalFor(
  config: CheckoutConfig,
  address: AddressSnapshot,
): 'country' | 'region' | null {
  return serviceRefusal(rulesOf(config), address.countryCode, address.region);
}

/** The wire code for a refusal, so every call site names it the same way. */
function refusalError(reason: 'country' | 'region'): BadRequestError {
  return new BadRequestError(
    reason === 'country' ? 'outside_service_country' : 'outside_service_region',
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SIMPLE MODE SHORT-CIRCUITS TO THE ZONE RATE — AND THAT IS THE WHOLE REASON
 * `address_mode` TOUCHES THE MONEY PATH AT ALL.
 *
 * A district only ever reaches this function because it is STORED on the
 * address row, and a stored district outlives the switch that stopped
 * collecting it. Without this branch, a cart whose address was captured on
 * Monday under the district form would still be priced — or REFUSED — by that
 * district at Friday's freeze, while the shopper looks at a form that never
 * asked. They would watch the number move after they had already seen it,
 * which is the exact failure freezing exists to prevent, arrived at from the
 * other side.
 *
 * It is checked BEFORE the query rather than after, so simple mode also costs
 * one round trip less per checkout call than district mode does.
 * ═══════════════════════════════════════════════════════════════════════════
 */
async function districtRuling(
  db: Db,
  config: CheckoutConfig,
  district: string | null,
): Promise<DistrictRuling> {
  if (rulesOf(config).addressMode === 'simple') return ZONE_RATE;
  if (district == null) return ZONE_RATE;
  const res = await db.execute(sql`
    SELECT delivers, rate_minor FROM shop_delivery_areas WHERE area_key = ${district}`);
  const row = res.rows[0];
  if (!row) return ZONE_RATE;
  if (!row.delivers) return { refused: true, rateMinor: null };
  /* `rate_minor` is `bigint`, which the drivers disagree about (Neon answers a
   * string, PGlite a number) — and `Number(null)` is 0, the one wrong answer
   * available. Null check FIRST, cast second, exactly as `delivery-areas-repo`
   * does. */
  const raw = row.rate_minor;
  return { refused: false, rateMinor: raw == null ? null : Number(raw) };
}

/**
 * A zone option, re-priced at the district's flat rate.
 *
 * THE OVERRIDE REPLACES THE AMOUNT AND NOTHING ELSE. The option's id, label and
 * taxability still come from the zone: the district table stores one number,
 * not a shipping catalogue, and an owner pricing Gwarinpa is answering "what
 * does delivery there cost", not designing new delivery methods for it.
 */
function districtPriced(option: ShippingQuote, ruling: DistrictRuling): ShippingQuote {
  if (ruling.rateMinor == null) return option;
  return { ...option, amount: { ...option.amount, amount: ruling.rateMinor } };
}

/**
 * Put the shipping and (optionally) billing addresses, and record the zone.
 *
 * THE ZONE IS STORED, not re-derived at freeze time. Deriving it twice is two
 * chances to derive it differently, and the second derivation would happen after
 * the customer has seen a delivery price — which is exactly when a number moving
 * loses a sale. `updateCartFields` carries the `status = 'open'` guard and the
 * CAS, so an address cannot be changed once a total has been frozen from it.
 *
 * `ON CONFLICT (cart_id, kind)` rather than delete-then-insert: one statement,
 * and a partly-applied address change is not a state this can reach.
 */
export async function putAddresses(
  db: Db,
  config: CheckoutConfig,
  a: {
    cartId: string;
    shipping: AddressSnapshot;
    billing: AddressSnapshot | null;
    baseRevision?: number;
  },
): Promise<{ zone: string }> {
  assertAddress(a.shipping);
  if (a.billing) assertAddress(a.billing);

  // THE REFUSAL COMES BEFORE ANY WRITE. An address the shop will not deliver to
  // is refused at the door rather than stored and failed later: a customer told
  // "we do not deliver to Gwarinpa" while the form is still in front of them
  // can pick another address; one told at the freeze has typed everything
  // twice. (The freeze still checks — the owner can switch a district off
  // between the two moments — but this is where the message is cheapest.)
  // Only the SHIPPING district is ruled on: a billing address is where the
  // card lives, not where the parcel goes.
  const ruling = await districtRuling(db, config, a.shipping.district ?? null);
  if (ruling.refused) throw new BadRequestError('outside_delivery_area');

  /*
   * AND THE REGION RESTRICTION, WHICH IS THE OTHER HALF OF SIMPLE MODE.
   *
   * A switched-off district is the only way this shop could previously say "we
   * do not go there", and simple mode stops collecting the district — so
   * without this, turning the switch on silently promises delivery anywhere
   * the catch-all zone reaches, which is all of Nigeria. `served_regions` is
   * how that is said instead, and it is enforced here for the same reason the
   * district refusal is: while the form is still in front of the customer.
   *
   * IT APPLIES IN BOTH MODES, deliberately. It is a statement about where the
   * shop delivers, not about which form is on screen, and a restriction that
   * evaporated when the owner switched back to districts would be a trap.
   * `null` — the seeded value — means no restriction and no behaviour change.
   *
   * ITS OWN ERROR CODE, not `outside_delivery_area`: the storefront's message
   * for that one names a district the customer picked from a list, and there
   * is no list here. "We don't deliver to Kano yet" and "we don't deliver to
   * Gwarinpa" need different sentences and different next steps.
   */
  const addressRefusal = serviceRefusalFor(config, a.shipping);
  if (addressRefusal) throw refusalError(addressRefusal);

  const zone = zoneFor(config.zones, a.shipping.countryCode, a.shipping.region);
  /*
   * A FROZEN CHECKOUT IS THAWED HERE RATHER THAN REFUSED — and the position of
   * this line, AFTER both refusals and BEFORE any write, is the whole of what
   * makes it safe. An address the shop will not deliver to still costs nothing
   * and changes nothing; only an address that is going to be stored reopens the
   * cart. `makeEditable` is a no-op for the ordinary open cart.
   *
   * Editing a delivery address IS backing out of payment, said in the only
   * vocabulary a checkout form has. Refusing it — which is what happened until
   * this line existed — told a shopper who had simply mistyped their street
   * that their basket was permanently unusable.
   */
  const base = await makeEditable(db, config, a);
  // The cart write goes FIRST because it carries the CAS and the state guard: if
  // the cart is not open, or has moved on, no address is written at all.
  await updateCartFields(db, {
    cartId: a.cartId,
    baseRevision: base,
    fields: { taxZone: zone.id },
  });

  for (const [kind, address] of [
    ['shipping', a.shipping],
    ['billing', a.billing],
  ] as const) {
    if (!address) continue;
    /*
     * THE PIN IS WRITTEN WHOLE OR NOT AT ALL, and the five columns move
     * together on the UPDATE branch too — so re-submitting the form without
     * sharing a location CLEARS a pin shared on the previous attempt rather
     * than leaving a stale one attached to an address that has since changed.
     * `shop_addresses_location_ck` would refuse a half-written pin anyway; this
     * is what stops one ever being attempted.
     */
    const loc = address.location ?? null;
    await db.execute(sql`
      INSERT INTO shop_addresses (id, cart_id, kind, name, line1, line2, city, region,
                                  postal_code, country_code, phone, district, routing_city,
                                  location_lat_e6, location_lng_e6, location_accuracy_m,
                                  location_source, location_captured_at)
      VALUES (${newId('address')}, ${a.cartId}, ${kind}, ${address.name}, ${address.line1},
              ${address.line2}, ${address.city}, ${address.region}, ${address.postalCode},
              ${address.countryCode}, ${address.phone}, ${address.district ?? null},
              ${address.routingCity ?? null}::text,
              ${loc === null ? null : Math.round(loc.lat * 1e6)}::integer,
              ${loc === null ? null : Math.round(loc.lng * 1e6)}::integer,
              ${loc === null || loc.accuracyM === null ? null : Math.round(loc.accuracyM)}::integer,
              ${loc === null ? null : loc.source}::text,
              ${loc === null ? null : loc.capturedAt}::bigint)
      ON CONFLICT (cart_id, kind) DO UPDATE
        SET name = EXCLUDED.name, line1 = EXCLUDED.line1, line2 = EXCLUDED.line2,
            city = EXCLUDED.city, region = EXCLUDED.region,
            postal_code = EXCLUDED.postal_code, country_code = EXCLUDED.country_code,
            phone = EXCLUDED.phone, district = EXCLUDED.district,
            /* CLEARED BY A SUBMISSION THAT NAMES NONE, like the pin above and
             * for the same reason: leaving the abandoned zone attached to an
             * address the customer has since corrected ships the parcel
             * somewhere they did not ask for. */
            routing_city = EXCLUDED.routing_city,
            location_lat_e6 = EXCLUDED.location_lat_e6,
            location_lng_e6 = EXCLUDED.location_lng_e6,
            location_accuracy_m = EXCLUDED.location_accuracy_m,
            location_source = EXCLUDED.location_source,
            location_captured_at = EXCLUDED.location_captured_at`);
  }

  return { zone: zone.id };
}

// ------------------------------------------------------------------- shipping

export async function shippingOptionsForCart(
  db: Db,
  config: CheckoutConfig,
  cartId: string,
): Promise<ShippingQuote[]> {
  const address = await getAddress(db, cartId, 'shipping');
  // NO OPTIONS WITHOUT AN ADDRESS. A shop that shows domestic delivery prices
  // before it knows the destination shows a number that goes up at the last
  // step, which is when a customer abandons.
  if (!address) return [];
  // AND NONE TO A REFUSED DISTRICT. `putAddresses` already refuses these, but
  // the owner can switch a district off while a cart is mid-checkout; an empty
  // list is the honest answer, and the freeze backs it with a hard refusal.
  const ruling = await districtRuling(db, config, address.district ?? null);
  if (ruling.refused) return [];
  // AND NONE OUTSIDE THE SERVED REGIONS, for the same reason: the restriction
  // can be added while a cart is mid-checkout, and an empty list is the honest
  // answer until the shopper changes the address.
  if (serviceRefusalFor(config, address)) return [];
  const zone = zoneFor(config.zones, address.countryCode, address.region);
  /* THE COURIER PRICES DELIVERY WHENEVER ONE IS SWITCHED ON, and the zone and
     district rates below become what the shop charges when it cannot be reached
     — `null` is every failure a courier can have (`courier-rates.ts`). */
  const courier = await courierShippingOptions(db, {
    lines: await listLines(db, cartId),
    address,
    currency: config.storeCurrency,
    taxable: zone.shippingTaxable,
  });
  if (courier) return courier;
  return shippingOptionsFor(zone, config.storeCurrency).map((option) =>
    districtPriced(option, ruling),
  );
}

export async function setShipping(
  db: Db,
  config: CheckoutConfig,
  a: { cartId: string; optionId: string; baseRevision?: number },
): Promise<ShippingQuote> {
  const address = await getAddress(db, a.cartId, 'shipping');
  if (!address) throw new BadRequestError('shipping_address');
  const ruling = await districtRuling(db, config, address.district ?? null);
  if (ruling.refused) throw new BadRequestError('outside_delivery_area');
  const shippingRefusal = serviceRefusalFor(config, address);
  if (shippingRefusal) throw refusalError(shippingRefusal);
  const zone = zoneFor(config.zones, address.countryCode, address.region);

  /* A COURIER OPTION IS RE-QUOTED HERE, NEVER READ OFF THE REQUEST. Its id
     carries the amount, and this one arrived over HTTP — so the only thing
     trusted from it is that the shopper meant the courier. The price written to
     the cart is the one this server has just been quoted itself. */
  let option: ShippingQuote | null;
  if (isCourierOptionId(a.optionId)) {
    const courier = await courierShippingOptions(db, {
      lines: await listLines(db, a.cartId),
      address,
      currency: config.storeCurrency,
      taxable: zone.shippingTaxable,
    });
    option = courier?.[0] ?? null;
  } else {
    option = shippingOptionById(zone, config.storeCurrency, a.optionId);
  }
  // An option from ANOTHER zone is refused rather than honoured: accepting the
  // UK next-day price for a parcel to France is a real loss on every order.
  if (!option) throw new BadRequestError('shipping_option');

  /* Thawed for the same reason `putAddresses` is, and in the same position —
   * after every refusal, before the first write. Choosing a different delivery
   * speed after seeing the payment page is backing out of it. */
  const base = await makeEditable(db, config, a);
  await updateCartFields(db, {
    cartId: a.cartId,
    baseRevision: base,
    fields: { shippingOptionId: option.id },
  });
  // Re-priced on the way OUT, not on the way in: the cart stores the option ID
  // and the freeze re-derives the amount, so what matters is that the number
  // shown here is the number the freeze will reach — same ruling, same result.
  /* A COURIER'S PRICE IS ALREADY THE PRICE. The district override exists to
     correct a zone's flat rate for one area; a quote for this exact basket to
     this exact state is not a flat rate and has nothing to correct. */
  return isCourierOptionId(option.id) ? option : districtPriced(option, ruling);
}

// ---------------------------------------------------------------------- start

export type StartOutcome =
  | { ok: true; reservations: Reservation[] }
  | { ok: false; reason: 'empty_cart' }
  | { ok: false; reason: 'insufficient'; shortfalls: Shortfall[] };

/**
 * Take holds for the cart's lines. Leaves the cart OPEN (brief §6).
 *
 * The cart stays open because addresses and shipping are still to come and every
 * cart-field write is guarded on `status = 'open'` — moving to `converting` here
 * would make the customer's next legitimate step a precondition failure.
 */
export async function startCheckout(
  db: Db,
  catalog: CatalogPort,
  a: { cartId: string },
): Promise<StartOutcome> {
  const cart = await getCart(db, a.cartId);
  if (!cart) throw new NotFoundError(a.cartId);
  const lines = await listLines(db, a.cartId);
  // Reserving nothing and calling it success is how a customer reaches payment
  // with an empty basket.
  if (lines.length === 0) return { ok: false, reason: 'empty_cart' };

  const result = await reserveForCheckout(db, catalog, {
    cartId: a.cartId,
    lines: lines.map((line) => ({ variantId: line.variantId, qty: line.qty })),
  });
  if (!result.ok) return { ok: false, reason: 'insufficient', shortfalls: result.shortfalls };
  return { ok: true, reservations: result.reservations };
}

// --------------------------------------------------------------------- freeze

/**
 * ONE LIST OF REFUSALS, NOT THREE. The freeze, the preview and `priceCart` all
 * refuse for exactly the same reasons — they run the same arithmetic — and this
 * used to restate them, which meant a new reason had to be added in three
 * places or one caller could not report it. `PricingRefusal` is that list; each
 * arm is documented where it is declared, on `PriceOutcome`.
 */
export type FreezeOutcome = { ok: true; totals: FrozenTotals } | PricingRefusal;

/**
 * What the freeze decided about SpoolPoints, or null for the ordinary cart.
 *
 * The email is carried BESIDE the quote rather than re-derived later: it is the
 * wallet the quote was taken against, and migration 0260's header explains why
 * the receipt address is not a safe substitute for it.
 */
interface FrozenRedemption {
  email: string;
  quote: RedemptionQuote;
}

/**
 * Quote the customer's points against this cart, or answer null.
 *
 * SIGNED-IN ONLY, AND THAT IS A CONSTRAINT RATHER THAN A POLICY. Balances are
 * email-keyed, and `shop_carts.email` is not written until the PAYMENT step
 * (`setCheckoutContact`, called from `payments/intents.ts`) — which runs after
 * this function. A guest genuinely has no address to look a balance up by at the
 * moment the total is decided, and frozen totals are never recomputed, so there
 * is no later point at which a guest's discount could be applied. Offering
 * points to guests means collecting contact before the freeze, which is a change
 * to the checkout flow and not to this file.
 *
 * `cart.customerId` IS THE SIGNAL, NOT THE SESSION COOKIE. This is a repo
 * function with no request in scope, and the cart was already adopted onto the
 * customer by `cart.ts`'s read path — so the row itself carries the answer.
 *
 * EVERY FAILURE ANSWERS NULL, INCLUDING A THROWN ONE. `quote()` is a pure read
 * whose whole purpose is to decide whether a widget exists; spec D9 models "no
 * widget" as null rather than as an error precisely so a checkout does not break
 * when a customer has four points. Extending that to a marketing subsystem that
 * is down means the worst case is a cart priced without a discount — which is
 * the price the shop charged yesterday — rather than a customer who cannot pay
 * at all. The alternative fails the freeze, and the freeze is the step
 * immediately before money.
 */
async function quoteRedemption(
  db: Db,
  config: CheckoutConfig,
  cart: { customerId: string | null; currency: string },
  cartTotalMinor: number,
  pointsRequested: number | undefined,
): Promise<FrozenRedemption | null> {
  /*
   * NO REQUEST, NO REDEMPTION — and this is the opt-in, stated once, here.
   *
   * `quote()` reads an omitted `pointsRequested` as "as much as the rules
   * allow". That is correct for the port and wrong as a shop default: passing
   * the omission through would spend a signed-in customer's entire balance on
   * their next checkout without anyone having asked them. The number arrives
   * from the storefront's widget, or it does not arrive and nothing is spent.
   */
  if (pointsRequested === undefined) return null;
  if (!config.redemption || !cart.customerId) return null;
  try {
    const email = await customerEmail(db, cart.customerId);
    if (!email) return null;
    const quote = await config.redemption(db).quote({
      email,
      customerId: cart.customerId,
      currency: cart.currency,
      cartTotalMinor,
      pointsRequested,
    });
    if (!quote || quote.points <= 0) return null;
    return { email, quote };
  } catch {
    return null;
  }
}

/**
 * Everything the pricing pass decided, for the caller that will store it.
 *
 * The failure arms are `FreezeOutcome`'s failure arms exactly, which is what
 * lets `freezeCheckout` return one of these unchanged.
 */
type PriceOutcome =
  | {
      ok: true;
      totals: FrozenTotals;
      frozenLines: StoredCheckoutLine[];
      redemption: FrozenRedemption | null;
      offers: AddOnOffer[];
    }
  | { ok: false; reason: 'empty_cart' }
  | { ok: false; reason: 'no_shipping_address' }
  | { ok: false; reason: 'outside_delivery_area' }
  /** The address's region is outside `served_regions` (migration 0760). Its own
   *  reason rather than `outside_delivery_area`: the storefront's message for
   *  that one names a district the customer picked from a list, and in simple
   *  mode there is no list. */
  | { ok: false; reason: 'outside_service_region' }
  /** The address's country is outside `served_countries` (migration 1060). Its
   *  own reason for the same reason again: "we don't ship to Canada" and "we
   *  don't deliver to Kano yet" are different sentences with different next
   *  steps, and only one of them is fixed by editing the address. */
  | { ok: false; reason: 'outside_service_country' }
  | { ok: false; reason: 'unresolved_lines'; variantIds: string[] }
  /**
   * The cart's discount code no longer applies (admin#100 Part B).
   *
   * REFUSED RATHER THAN PRICED WITHOUT IT, and that is the whole decision. An
   * owner can disable a campaign while a cart sits at the payment step; pricing
   * on without the code would charge the shopper MORE than the screen showed
   * them, silently, which is the one outcome a checkout must never produce.
   * `discountReason` is the port's own reason, so the storefront can say "that
   * code expired" and offer the new total rather than "something went wrong".
   */
  | { ok: false; reason: 'discount_rejected'; discountReason: DiscountRejection }
  | {
      ok: false;
      reason: 'currency_mismatch';
      expected: string;
      found: Array<{ where: string; currency: string }>;
    };

/**
 * PRICE THE CART. The arithmetic, and nothing else — no write, no clock.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE PRICING PATH, TWO CALLERS, AND THAT IS THE WHOLE REASON THIS FUNCTION IS
 * SEPARATE FROM `freezeCheckout` (admin#100 Part A).
 *
 * `previewCheckout` shows a shopper a discount and a total; `freezeCheckout`
 * then charges them. If those two numbers came from two pieces of arithmetic
 * they would agree today and diverge the first time somebody edited one of
 * them — and the shopper would find out at the payment step, having already
 * been shown a smaller figure. Sharing this function makes that divergence
 * unrepresentable rather than merely tested; `preview.test.ts` drives both
 * callers against one cart and compares the whole `FrozenTotals`.
 *
 * WHAT IS DELIBERATELY NOT HERE: the status guard, the `UPDATE`, and the clock.
 * They belong to the freeze alone. A preview must be able to re-price a cart
 * that is already `converting` — a shopper reloading the payment step — and a
 * read has no business refusing that.
 *
 * Every input to `computeTotals` is gathered HERE and passed in: this function
 * has the database, and the engine has neither it nor a clock. That separation
 * is the whole design — see `totals/compute.ts`.
 * ═══════════════════════════════════════════════════════════════════════════
 */
async function priceCart(
  db: Db,
  catalog: CatalogPort,
  config: CheckoutConfig,
  cart: Cart,
  redeemPoints: number | undefined,
  /* For the discount code's schedule, and nothing else — the totals engine is
     still clockless, which is the property `compute.ts` exists to keep. */
  now: number,
): Promise<PriceOutcome> {
  const lines = await listLines(db, cart.id);
  if (lines.length === 0) return { ok: false, reason: 'empty_cart' };

  const address = await getAddress(db, cart.id, 'shipping');
  if (!address) return { ok: false, reason: 'no_shipping_address' };

  // RULED ON AGAIN AT THE MONEY MOMENT, not trusted from `putAddresses`: the
  // owner can switch a district off while this cart sits at the payment step,
  // and the freeze is the last instant a refusal costs nothing. After it, the
  // answer would be a refund.
  const districts = await districtRuling(db, config, address.district ?? null);
  if (districts.refused) return { ok: false, reason: 'outside_delivery_area' };
  // AND WHERE THE SHOP SHIPS, ruled on again for the identical reason: an owner
  // can narrow the country or region list while this cart sits at the payment
  // step, and the freeze is the last instant a refusal costs nothing rather
  // than a refund.
  const refusal = serviceRefusalFor(config, address);
  if (refusal) {
    return {
      ok: false,
      reason: refusal === 'country' ? 'outside_service_country' : 'outside_service_region',
    };
  }

  const zone = zoneFor(config.zones, address.countryCode, address.region);

  /* A COURIER-PRICED OPTION CARRIES ITS OWN AMOUNT in the id `setShipping`
     wrote (`courier-rates.ts`), and that is what makes this re-derivable with
     no second call to the courier at the payment step. The alternative —
     re-quoting here — would put a network call in the money path and let the
     number move after the shopper had agreed to it, which is the exact drift
     `putAddresses` stores the zone to avoid. */
  const storedOptionId = cart.shippingOptionId;
  const courierMinor = storedOptionId ? amountFromCourierOptionId(storedOptionId) : null;
  let chosen: ShippingQuote | null = null;
  if (storedOptionId && courierMinor != null) {
    chosen = {
      id: storedOptionId,
      label: courierLabel(storedOptionId),
      amount: money(courierMinor, config.storeCurrency),
      taxable: zone.shippingTaxable,
    };
  } else if (storedOptionId) {
    chosen = shippingOptionById(zone, config.storeCurrency, storedOptionId);
  }
  // The district's flat rate replaces the zone amount HERE, before the totals
  // engine runs — so the frozen number, the only number ever charged, is the
  // district one. `setShipping` showed the customer this same figure. A
  // courier's own quote is left alone, for the reason `setShipping` gives.
  const shipping =
    chosen == null ? null : courierMinor != null ? chosen : districtPriced(chosen, districts);

  /*
   * ONE `quote` PER LINE, and the result is carried forward rather than
   * re-fetched. An unresolvable variant becomes `unit: null`, which the totals
   * engine REFUSES rather than dropping — a cart showing three items and a total
   * covering two is a charge the customer never agreed to.
   */
  const quotes = await Promise.all(
    lines.map((line) => catalog.quote(db, line.variantId).then((q) => ({ line, quote: q }))),
  );

  const totalsLines: TotalsInputLine[] = quotes.map(({ line, quote }) => ({
    variantId: line.variantId,
    /* Falls back to the VARIANT id, never to '': an unresolvable line is refused
       by the engine before the ladder is consulted, but a shared '' would group
       every unresolvable line into one phantom product on the way there. */
    productId: quote?.productId ?? line.variantId,
    qty: line.qty,
    unit: quote ? { amount: quote.price.amount, currency: quote.price.currency } : null,
    /* Frozen with the totals, so the ladder that applied at checkout is the one
       on the invoice even if the admin edits it an hour later. */
    bulkTiers: quote?.bulkTiers ?? [],
  }));

  /*
   * THE GOODS, CAPTURED FROM THE SAME `quote` CALLS THAT PRODUCED THE PRICES.
   *
   * `FrozenTotals.lines` is money-only by design — the totals engine is pure and
   * must not need a product title to do arithmetic — but an order line needs a
   * SKU, a title and an option tuple, and Catalog may rename or discontinue the
   * variant tomorrow. Re-quoting at completion time would reintroduce exactly
   * the drift freezing exists to prevent, so both halves are frozen at the same
   * instant, from the same reads, into the same statement.
   */
  // `StoredCheckoutLine`, not `CheckoutCompletedLine`: `unitAmount` and
  // `lineTotal` are joined on from the frozen totals when the event is built, and
  // storing a second copy of two numbers is a second copy that can disagree.
  const frozenLines: StoredCheckoutLine[] = quotes.map(({ line, quote }) => ({
    variantId: line.variantId,
    productId: quote?.productId ?? '',
    sku: quote?.sku ?? '',
    title: quote?.title ?? '',
    optionValues: quote?.optionValues ?? {},
    qty: line.qty,
    unit: quote
      ? { amount: quote.price.amount, currency: quote.price.currency }
      : { amount: 0, currency: cart.currency },
    weightGrams: quote?.weightGrams ?? null,
  }));

  const tax = cart.taxZone ? taxRateFor(zone) : unknownZoneTaxRate();

  /*
   * THE DISCOUNT CODE, RE-JUDGED HERE AND NOT TRUSTED FROM WHEN IT WAS APPLIED
   * — the same argument the district ruling makes twenty lines up, and for the
   * same reason: the owner can switch a campaign off while this cart sits at the
   * payment step, and this is the last instant a refusal costs nothing.
   *
   * A DEAD CODE REFUSES. See `PriceOutcome`'s arm for why that beats pricing
   * without it.
   *
   * NO PORT MEANS NO CODE CAN BE HONOURED. If a deployment has a code on a cart
   * and no way to judge it, the only safe answers are "refuse" and "charge more
   * than we showed" — so it refuses, as `not_found`, which is also what the
   * shopper would be told if the row really had gone.
   */
  let discount: CodeDiscount | null = null;
  if (cart.discountCode) {
    if (!config.discounts) {
      return { ok: false, reason: 'discount_rejected', discountReason: 'not_found' };
    }
    const judged = await config.discounts(db).validate({
      code: cart.discountCode,
      currency: cart.currency,
      now,
    });
    if (!judged.ok) {
      return { ok: false, reason: 'discount_rejected', discountReason: judged.reason };
    }
    discount = judged.discount;
  }

  /*
   * PRICED ONCE WITHOUT POINTS, THEN — IF THERE ARE ANY — ONCE MORE WITH THEM.
   *
   * `max_redeem_bps` is "how much of an ORDER may be paid for in points", so the
   * number it is a share of has to be the undiscounted grand total. Quoting
   * against an already-discounted figure would let each pass discount the last
   * one's output, which is a cap that moves every time it is applied.
   *
   * TWO PASSES OF A PURE FUNCTION, not two trips to the database. `computeTotals`
   * has no handle and no clock (see the header) — the second pass re-adds the
   * same line quotes that are already in hand, so what it costs is arithmetic.
   */
  const undiscounted = computeTotals({
    currency: cart.currency,
    lines: totalsLines,
    shipping,
    // A cart with no address yet would have had no shipping either; the named
    // zero-rate exists so a preview never shows a domestic VAT figure it will
    // then change.
    tax,
    adjustments: [],
    /* NO CODE IN THIS PASS, DELIBERATELY. This total exists for one purpose —
       to be the number `max_redeem_bps` is a share of — and the owner settled
       on 2026-09-02 that the cap measures the UNDISCOUNTED order. Feeding the
       code in here would make a shopper's points worth less on a coded order
       and would let each discount move the other's base, which is a cap that
       changes depending on the order the two were applied in. */
    discount: null,
  });

  /*
   * THE ADD-ONS, evaluated on the subtotal the ladder left, before points are
   * quoted — so a charged add-on is inside the base the points cap measures.
   * An unanswered ask is not in `applied` (owner: skip, never refuse).
   */
  const addOns = await evaluateCartAddOns(db, config.addOns, {
    cart,
    quotes,
    address,
    subtotalMinor: undiscounted.ok ? undiscounted.totals.subtotal.amount : 0,
  });
  const base =
    addOns.applied.length > 0
      ? computeTotals({
          currency: cart.currency,
          lines: totalsLines,
          shipping,
          tax,
          adjustments: [],
          discount: null,
          addOns: addOns.applied,
        })
      : undiscounted;

  const redemption = base.ok
    ? await quoteRedemption(db, config, cart, base.totals.grandTotal.amount, redeemPoints)
    : null;

  /*
   * THE REAL PASS: both discounts, at their own points in the pipeline. The
   * code reduces the taxable base (step 1c of `compute.ts`); the points come
   * off after tax, as an `Adjustment`, because they are a payment instrument
   * rather than a reduction in what the goods cost.
   *
   * Skipped entirely when there is neither, so an ordinary cart is still priced
   * exactly once — `undiscounted` is already that answer.
   */
  const computed =
    redemption || discount
      ? computeTotals({
          currency: cart.currency,
          lines: totalsLines,
          shipping,
          tax,
          adjustments: redemption ? [redemption.quote.adjustment] : [],
          discount,
          addOns: addOns.applied,
        })
      : base;

  if (!computed.ok) {
    if (computed.reason === 'unresolved_lines') {
      return { ok: false, reason: 'unresolved_lines', variantIds: computed.variantIds };
    }
    if (computed.reason === 'currency_mismatch') {
      return {
        ok: false,
        reason: 'currency_mismatch',
        expected: computed.expected,
        found: computed.found,
      };
    }
    // `bad_currency` means the CART's own currency column is not ISO-4217, which
    // no ordinary path can produce — the CHECK in migration 0120 refuses it. A
    // corrupt row, then, and a 500 is the honest answer.
    throw new Error(`cart ${cart.id} has an unusable currency`);
  }

  return { ok: true, totals: computed.totals, frozenLines, redemption, offers: addOns.offers };
}

/**
 * Price the cart once, store the answer, and close the door.
 *
 * The arithmetic is `priceCart`'s, shared with the preview so the number a
 * shopper was shown is the number they are charged. What is added here is the
 * one-way part: the status guard, the clock, and the single `UPDATE`.
 */
export async function freezeCheckout(
  db: Db,
  catalog: CatalogPort,
  config: CheckoutConfig,
  a: { cartId: string; baseRevision?: number; redeemPoints?: number },
): Promise<FreezeOutcome> {
  const cart = await getCart(db, a.cartId);
  if (!cart) throw new NotFoundError(a.cartId);
  if (cart.status !== 'open') {
    throw new CartPreconditionError('freeze', {
      id: cart.id,
      status: cart.status,
      revision: cart.revision,
      currency: cart.currency,
    });
  }

  // Read once, before pricing, so the discount code's window and the row's
  // `updated_at` are judged against the same instant.
  const now = Date.now();
  const priced = await priceCart(db, catalog, config, cart, a.redeemPoints, now);
  if (!priced.ok) return priced;
  const { totals, frozenLines, redemption } = priced;

  const base = a.baseRevision ?? cart.revision;
  const res = await db.execute(sql`
    UPDATE shop_carts
       SET status = 'converting',
           frozen_totals = ${JSON.stringify(totals)}::jsonb,
           frozen_lines = ${JSON.stringify(frozenLines)}::jsonb,
           frozen_at = ${now},
           /*
            * THE POINT COUNT GOES DOWN IN THE SAME STATEMENT AS THE DISCOUNT IT
            * PAID FOR (migration 0260). Written apart, a crash between the two
            * writes would leave a total the customer is charged and no record of
            * what bought it — or a debit owed against a discount nobody got.
            *
            * Bare NULL binds need an explicit cast or Postgres raises 42P18
            * (§5); these are cast at the parameter rather than left to
            * inference for that reason.
            */
           redemption_points = ${redemption?.quote.points ?? null}::integer,
           redemption_email = ${redemption?.email ?? null}::text,
           revision = revision + 1,
           updated_at = ${now}
     WHERE id = ${a.cartId} AND revision = ${base} AND status = 'open'
    RETURNING revision`);

  if (res.rows.length === 0) {
    const after = await getCart(db, a.cartId);
    if (!after) throw new NotFoundError(a.cartId);
    const snap = {
      id: after.id,
      status: after.status,
      revision: after.revision,
      currency: after.currency,
    };
    if (after.status !== 'open') throw new CartPreconditionError('freeze', snap);
    throw new CartStaleWriteError(base, after.revision, snap);
  }

  return { ok: true, totals };
}

// -------------------------------------------------------------------- preview

/**
 * The refusals, named once so the preview and the freeze cannot drift apart —
 * and exported so the two ROUTES can share one mapping onto the error table.
 * Structurally identical to `FreezeOutcome`'s failure arms by construction.
 */
export type PricingRefusal = Extract<PriceOutcome, { ok: false }>;

/**
 * What a preview reports about the shopper's points.
 *
 * `pointsApplied` IS THE CLAMP, MADE VISIBLE (storefront#112). `quote()` already
 * reduces a request to what the rules allow — the balance, `min_redeem_points`,
 * and `max_redeem_bps` as a share of the order — and returning only the discount
 * would let a storefront say "5,000,000 points spent" beside a £5 reduction. The
 * number that was actually spent is the one the customer is owed a sight of, so
 * it is reported separately from the money rather than inferred from it.
 *
 * `discountMinor` IS POSITIVE. The `Adjustment` on the wire is negative because
 * it is summed into a total; this field is read out loud as "£5.00 off", and a
 * storefront that has to remember to negate a field will one day forget.
 */
export interface PreviewRedemption {
  /** How many points the rules actually spent — never how many were asked for. */
  pointsApplied: number;
  /** The discount those points bought, in minor units, as a positive number. */
  discountMinor: number;
  /** What the balance would be afterwards, for the widget's copy. */
  balanceAfter: number;
}

export type PreviewOutcome =
  | { ok: true; totals: FrozenTotals; redemption: PreviewRedemption | null; addOns: AddOnOffer[] }
  | PricingRefusal;

/**
 * Price the cart AS THE FREEZE WOULD, and write nothing (admin#100 Part A).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS. `quote()` has been correct since admin#2 and unreachable
 * over HTTP the whole time: its only caller is inside `freezeCheckout`, and
 * freezing is the one-way step on the way to payment. So a storefront could not
 * tell a shopper what their points were worth until after the point of no
 * return, and the widget said so — "your discount is applied on the next
 * screen, before you pay" was an honest workaround for a missing endpoint.
 *
 * THE ONLY THING IT ADDS TO `priceCart` IS A SHAPE. Every rule — the switch, the
 * currency match, the minimum, the balance, the cap — is `quote()`'s, and the
 * arithmetic is the freeze's own. That is the point: see `priceCart`.
 *
 * IT WRITES NOTHING, RESERVES NOTHING, FREEZES NOTHING. There is no `UPDATE`
 * here and no clock, and `quote()` reserves nothing by construction (spec D9) —
 * a preview a shopper never acts on must leave no trace, or an abandoned tab
 * would strand a balance.
 *
 * NO `baseRevision`. That parameter exists to make a WRITE fail when the cart
 * moved underneath it; a read has nothing to lose the race for. A preview of a
 * cart that has since changed is simply a stale number, and the freeze — which
 * does take one — is where that is caught.
 *
 * A NON-`open` CART IS PRICED, NOT REFUSED, which is the one place this is more
 * permissive than the freeze. A shopper who reloads the payment step on a
 * `converting` cart is asking a question, not trying to change anything.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export async function previewCheckout(
  db: Db,
  catalog: CatalogPort,
  config: CheckoutConfig,
  a: { cartId: string; redeemPoints?: number },
): Promise<PreviewOutcome> {
  const cart = await getCart(db, a.cartId);
  if (!cart) throw new NotFoundError(a.cartId);

  const priced = await priceCart(db, catalog, config, cart, a.redeemPoints, Date.now());
  if (!priced.ok) return priced;

  const { quote } = priced.redemption ?? {};
  return {
    ok: true,
    totals: priced.totals,
    redemption: quote
      ? {
          pointsApplied: quote.points,
          // The adjustment is negative; this field is read as "£5.00 off".
          discountMinor: Math.abs(quote.adjustment.amount.amount),
          balanceAfter: quote.balanceAfter,
        }
      : null,
    addOns: priced.offers,
  };
}

// ------------------------------------------------------------------ discounts

export type ApplyDiscountOutcome =
  | { ok: true; discount: CodeDiscount }
  | { ok: false; reason: DiscountRejection };

/**
 * Put a discount code on the cart (admin#100 Part B, storefront#113).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT STORES THE ROW'S SPELLING, NOT THE SHOPPER'S. `validate()` normalises and
 * hands back the code as the model holds it, so `welcome10` and ` WeLcOmE10 `
 * both persist as `WELCOME10` — and the freeze's re-read therefore asks about
 * exactly the string the model can match.
 *
 * IT VALIDATES BEFORE IT WRITES, so a rejected code leaves no trace. A cart
 * carrying a code that never applied would price identically and then refuse at
 * the freeze, which is a dead end reached one screen too late.
 *
 * ONLY ON AN OPEN CART. Every cart-field write in this file is guarded on
 * `status = 'open'`; a frozen checkout's price is struck, and a code applied
 * after it would be a discount the customer is not charged.
 *
 * NOTHING IS RESERVED. Two shoppers can both hold the last use of a capped
 * code — see `discountPort`'s header for why that is the right trade for a
 * marketing budget, and where it is settled instead.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export async function applyDiscount(
  db: Db,
  config: CheckoutConfig,
  a: { cartId: string; code: string; baseRevision?: number; now: number },
): Promise<ApplyDiscountOutcome> {
  const cart = await getCart(db, a.cartId);
  if (!cart) throw new NotFoundError(a.cartId);
  if (cart.status !== 'open') {
    throw new CartPreconditionError('apply_discount', {
      id: cart.id,
      status: cart.status,
      revision: cart.revision,
      currency: cart.currency,
    });
  }
  /* A deployment with no port cannot honour a code, and pretending otherwise
     would put a string on the cart that the freeze then refuses. */
  if (!config.discounts) return { ok: false, reason: 'not_found' };

  const judged = await config.discounts(db).validate({
    code: a.code,
    currency: cart.currency,
    now: a.now,
  });
  if (!judged.ok) return { ok: false, reason: judged.reason };

  await writeDiscountCode(
    db,
    a.cartId,
    judged.discount.code,
    a.baseRevision ?? cart.revision,
    a.now,
  );
  return { ok: true, discount: judged.discount };
}

/**
 * Take the code off the cart.
 *
 * A NO-OP WHEN THERE IS NOTHING TO REMOVE, deliberately: the storefront's
 * "clear" control must not have to know whether a code is applied, and a 409
 * there would be a dead end on the screen whose whole job is to get a shopper
 * out of one. Idempotent, for the reason a DELETE should be.
 */
export async function removeDiscount(
  db: Db,
  a: { cartId: string; baseRevision?: number },
): Promise<void> {
  const cart = await getCart(db, a.cartId);
  if (!cart) throw new NotFoundError(a.cartId);
  if (cart.status !== 'open') {
    throw new CartPreconditionError('remove_discount', {
      id: cart.id,
      status: cart.status,
      revision: cart.revision,
      currency: cart.currency,
    });
  }
  if (cart.discountCode === null) return;
  await writeDiscountCode(db, a.cartId, null, a.baseRevision ?? cart.revision, Date.now());
}

/** The one statement both of the above write, so the CAS and the status guard
 *  are stated once rather than twice with a chance of diverging. */
async function writeDiscountCode(
  db: Db,
  cartId: string,
  code: string | null,
  base: number,
  now: number,
): Promise<void> {
  const res = await db.execute(sql`
    UPDATE shop_carts
       -- A bare NULL bind needs an explicit cast or Postgres raises 42P18 (§5).
       SET discount_code = ${code}::text,
           revision = revision + 1,
           updated_at = ${now}
     WHERE id = ${cartId} AND revision = ${base} AND status = 'open'
    RETURNING revision`);
  if (res.rows.length > 0) return;

  const after = await getCart(db, cartId);
  if (!after) throw new NotFoundError(cartId);
  const snap = {
    id: after.id,
    status: after.status,
    revision: after.revision,
    currency: after.currency,
  };
  if (after.status !== 'open') throw new CartPreconditionError('discount', snap);
  throw new CartStaleWriteError(base, after.revision, snap);
}

/**
 * `CheckoutPort.totals` — READ, never recomputed (contract §5, brief §5).
 *
 * Every amount goes back through `money()` on the way out (`parseFrozenTotals`),
 * so a row corrupted by a hand-run UPDATE or a bad import is refused at the
 * boundary rather than flowing into a charge. Both "not frozen" and "corrupt"
 * answer `NotFoundError` → 404 `gone`, which spec §8's retry policy stops on:
 * neither is something a retry could fix.
 */
export async function frozenTotals(db: Db, checkoutId: string): Promise<FrozenTotals> {
  const res = await db.execute(sql`
    SELECT frozen_totals FROM shop_carts WHERE id = ${checkoutId}`);
  const row = res.rows[0];
  if (!row || row.frozen_totals == null) throw new NotFoundError(checkoutId);
  const parsed = parseFrozenTotals(row.frozen_totals);
  if (!parsed) throw new NotFoundError(checkoutId);
  return parsed;
}

// ------------------------------------------------------------------- contact

/**
 * Record the customer's email against the checkout. Best effort (admin#27).
 *
 * NOT `updateCartFields`, and the difference is the guard. That helper refuses
 * anything but `status = 'open'` — correct for an address, whose whole point is
 * that it cannot change once a total has been frozen from it — but this is
 * called from the PAYMENT step, by which time the cart is `converting`. An email
 * is not an input to any total, so writing it after the freeze changes no number
 * anybody has seen.
 *
 * IT REFUSES SILENTLY RATHER THAN THROWING. A cart that is already `converted`,
 * abandoned or gone matches nothing and this returns; the caller is creating a
 * payment intent, and failing that because a contact detail could not be filed
 * would trade a reconcilable gap for a customer who cannot pay at all.
 *
 * `revision + 1` because every write of any kind moves it (see `cart/repo.ts`) —
 * an A→B→A change has to stay visible, and an exception here would be an
 * exception somebody has to remember.
 */
export async function setCheckoutContact(
  db: Db,
  a: { cartId: string; email: string },
): Promise<void> {
  const now = Date.now();
  await db.execute(sql`
    UPDATE shop_carts
       SET email = ${a.email}, revision = revision + 1, updated_at = ${now}
     WHERE id = ${a.cartId}
       AND status IN ('open', 'converting')
       AND email IS DISTINCT FROM ${a.email}`);
}

// ------------------------------------------------------------------ complete

/**
 * The checkout is done: `converting → converted`, and `checkout.completed`
 * appended IN THE SAME STATEMENT.
 *
 * CONTRACT §6 RULE 1 IS THE WHOLE DESIGN OF THIS FUNCTION: "Write the event in
 * the same transaction as the state change that caused it. An event that can be
 * lost while its cause commits is worse than no event, because the system then
 * believes something happened that nobody will act on."
 *
 * One statement rather than `db.transaction` — the Neon HTTP driver throws
 * unconditionally on `transaction()` while PGlite supports it, so a transaction
 * would pass every test here and 500 in production (spec §4.3a). The event
 * INSERT selects FROM the cart UPDATE, so a transition that matches nothing
 * writes no event. `repo.test.ts` proves that by making the transition
 * impossible and asserting the outbox stays empty.
 *
 * WHO CALLS THIS is the seam contract §7 leaves open — brief §7 says the event
 * is emitted "when the cart freezes and payment is authorised", and Cart has no
 * way to learn the second half. See AMENDMENTS A-007.
 */
export async function completeCheckout(
  db: Db,
  a: { cartId: string; baseRevision?: number },
): Promise<CheckoutCompletedPayload> {
  const cart = await getCart(db, a.cartId);
  if (!cart) throw new NotFoundError(a.cartId);

  const totals = await frozenTotals(db, a.cartId);
  const payload = await buildCompletedPayload(db, a.cartId, totals);
  const now = Date.now();
  const base = a.baseRevision ?? cart.revision;

  const res = await db.execute(sql`
    WITH upd AS (
      UPDATE shop_carts
         SET status = 'converted', revision = revision + 1, updated_at = ${now}
       WHERE id = ${a.cartId} AND revision = ${base} AND status = 'converting'
      RETURNING id
    ), evt AS (
      INSERT INTO commerce_events (id, type, subject_id, payload, occurred_at, attempts)
      SELECT ${newId('event')}, 'checkout.completed', upd.id,
             ${JSON.stringify({ ...payload, occurredAt: now })}::jsonb, ${now}, 0
        FROM upd
      RETURNING id
    )
    SELECT upd.id FROM upd`);

  if (res.rows.length === 0) {
    const after = await getCart(db, a.cartId);
    if (!after) throw new NotFoundError(a.cartId);
    const snap = {
      id: after.id,
      status: after.status,
      revision: after.revision,
      currency: after.currency,
    };
    if (after.status !== 'converting') throw new CartPreconditionError('complete', snap);
    throw new CartStaleWriteError(base, after.revision, snap);
  }

  return { ...payload, occurredAt: now };
}

/**
 * Everything Orders needs, gathered before the write.
 *
 * BUILT FROM THE FROZEN TOTALS PLUS THE CART'S OWN ROWS — never from a fresh
 * `CatalogPort.quote`. The prices in the payload must be the prices that were
 * frozen, and re-quoting here would reintroduce exactly the drift freezing
 * exists to prevent. The product snapshot (`sku`, `title`, `optionValues`,
 * `weightGrams`) is the one thing a cart row does not hold, so it is read from
 * the line's stored variant id at completion time and copied — an order is a
 * record of what was sold, and Catalog may rename the variant tomorrow.
 */
async function buildCompletedPayload(
  db: Db,
  cartId: string,
  totals: FrozenTotals,
): Promise<CheckoutCompletedPayload> {
  const cart = await getCart(db, cartId);
  if (!cart) throw new NotFoundError(cartId);

  /*
   * READ HERE RATHER THAN THROUGH `getCart`. `CART_COLUMNS` is an explicit list
   * for the reason `cart/repo.ts` gives — a column added to it silently joins
   * every cart response — and these two are wanted at exactly one place, which
   * is this one. They ride along with `frozen_lines` because they were written
   * by the same statement that wrote it.
   */
  const stored = await db.execute(sql`
    SELECT frozen_lines, frozen_totals, redemption_points, redemption_email, discount_code
      FROM shop_carts WHERE id = ${cartId}`);
  const frozen = (stored.rows[0]?.frozen_lines ?? []) as StoredCheckoutLine[];

  /*
   * SPOOLPOINTS, CARRIED IN THE PAYLOAD RATHER THAN LOOKED UP BY THE CONSUMER.
   *
   * `shared/commerce/events.ts` requires payloads to be self-sufficient: a
   * consumer reacting to this event must not have to call back into Cart to
   * learn a number, because that is a synchronous cross-subsystem call wearing
   * an event's clothes. Orders cannot read `shop_carts` at all (contract §2), so
   * the count travels or it does not arrive.
   *
   * The CHECK in migration 0260 makes these two columns all-or-nothing, so
   * testing one of them is testing both.
   */
  const points = stored.rows[0]?.redemption_points;
  const redemptionEmail = stored.rows[0]?.redemption_email;
  const redemption =
    points == null || redemptionEmail == null
      ? null
      : { email: String(redemptionEmail), points: Number(points) };

  /*
   * THE DISCOUNT CODE, ON THE SAME TERMS (admin#100 Part B).
   *
   * The AMOUNT comes off the frozen totals rather than being recomputed: it is
   * what the customer was actually charged less, after the clamp, and it is
   * already stored. `discountTotal` is negative there because it is a summand;
   * it goes on the wire POSITIVE because the consumer records "what this code
   * cost the campaign", which is not a summand of anything.
   *
   * A cart with a code but no parseable totals is impossible here — this runs
   * after the freeze, which wrote both — so the fallback is 0 rather than a
   * throw: an event that parks is worse than a reconciliation figure of zero on
   * an order that was charged correctly.
   */
  const code = stored.rows[0]?.discount_code;
  const frozenTotalsRow = parseFrozenTotals(stored.rows[0]?.frozen_totals);
  const discount =
    code == null
      ? null
      : {
          code: String(code),
          amountMinor: Math.abs(frozenTotalsRow?.discountTotal.amount ?? 0),
        };

  /*
   * `unitAmount` AND `lineTotal`, JOINED ON `variantId` FROM THE FROZEN TOTALS.
   *
   * COPIED, NEVER COMPUTED. `unit × qty` would be arithmetic performed after the
   * customer saw a number, which is the one thing freezing exists to prevent —
   * `TotalsLine.lineTotal` is the figure the totals engine produced at freeze
   * time and it is the figure that was charged, so it is the figure that travels.
   * `frozen_lines` is stored without them (it predates this) and is NOT rewritten
   * here: an order is built from the event, and the event carries them.
   *
   * WHY AT ALL: Orders' `parseCheckoutCompleted` requires both names on every
   * line and parks the event naming the missing field otherwise. Emitting
   * `checkout.completed` without them would have turned "no order" into "an event
   * that parks twenty times and is abandoned". See `shared/commerce/events.ts`.
   *
   * A line with no matching totals row falls back to `unit` and a zero total
   * rather than being dropped: a missing line is a silently short order, and
   * a zero that appears on an invoice gets noticed.
   */
  const byVariant = new Map(totals.lines.map((line) => [line.variantId, line]));
  const lines: CheckoutCompletedLine[] = frozen.map((line) => {
    const totalsLine = byVariant.get(line.variantId);
    return {
      ...line,
      unitAmount: totalsLine ? { ...totalsLine.unit } : { ...line.unit },
      lineTotal: totalsLine
        ? { ...totalsLine.lineTotal }
        : { amount: 0, currency: line.unit.currency },
    };
  });

  const held = await heldReservations(db, cartId);

  /*
   * THE EMAIL, WITH THE CUSTOMER ROW AS A FALLBACK.
   *
   * `shop_carts.email` is filled by `setCheckoutContact` at the payment step, so
   * a guest checkout has one by the time this runs. A SIGNED-IN customer who
   * never reached that step — an order completed by hand, say — still has one on
   * `shop_customers`, and reading it is strictly better than emitting `null`:
   * Orders requires the field and parks the event without it, which costs the
   * customer their order to save a join.
   *
   * `''` IS NOT USED AS A FALLBACK. Orders' `min(1)` would reject it just the
   * same, and a park naming `email` is a legible instruction; an empty string on
   * an order is a confirmation sent nowhere and nobody told.
   */
  const email =
    cart.email ?? (cart.customerId ? await customerEmail(db, cart.customerId) : null);

  return {
    checkoutId: cartId,
    customerId: cart.customerId,
    email,
    currency: cart.currency,
    totals,
    lines,
    shippingAddress: await getAddress(db, cartId, 'shipping'),
    billingAddress: await getAddress(db, cartId, 'billing'),
    reservationIds: held.map((reservation) => reservation.id),
    redemption,
    discount,
    occurredAt: 0,
  };
}

/**
 * A row as it sits in `shop_carts.frozen_lines`.
 *
 * `CheckoutCompletedLine` MINUS the two fields `buildCompletedPayload` adds on the
 * way out. Spelled separately rather than reusing the event type because the two
 * are genuinely different things: this is storage written at freeze time, that is
 * a message written at completion time, and typing the stored rows as the event
 * shape is what would let a missing field pass the compiler and park in production.
 */
type StoredCheckoutLine = Omit<CheckoutCompletedLine, 'unitAmount' | 'lineTotal'>;

/** The customer's own email, for a checkout that never recorded one. */
async function customerEmail(db: Db, customerId: string): Promise<string | null> {
  const res = await db.execute(sql`
    SELECT email FROM shop_customers WHERE id = ${customerId}`);
  const email = res.rows[0]?.email;
  return email == null ? null : String(email);
}

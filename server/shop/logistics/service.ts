import type { Db } from '../../db/client';
import type { TemplateSet } from '../../email/system-templates';
import { storefrontOrigin } from '../storefront-url';
import { mintGuestToken } from '../orders/tokens';
import type { AccessLink } from '../orders/mailer';
import { readOrder, settleOrderFulfilled } from '../orders/repo/orders';
import type { OrderRead } from '../orders/repo/orders';
import { deliverFulfillment, readFulfillment, shipFulfillment } from '../orders/repo/fulfillments';
import type { Fulfillment } from '../orders/repo/fulfillments';
import {
  CourierConflictError,
  recordCourierBooking,
  recordCourierCancelled,
  recordCourierDraft,
  recordCourierSnapshot,
  recordCourierSyncError,
} from '../orders/repo/courier';
import { readShippingAddress } from './address';
import type { ResolvedLogisticsDeps } from './deps';
import { LogisticsError, PROVIDER_LABEL } from './port';
import type {
  LogisticsProvider,
  ParcelInput,
  ParcelLine,
  ProviderId,
  QuoteOption,
  QuoteResult,
  TrackResult,
} from './port';
import { getLogisticsSettings, setTerminalPackagingId } from './repo';
import type { LogisticsSettings } from './repo';
import { missingWeights } from './weights';

/**
 * BOOKING A COURIER FOR A PARCEL — the decisions between the HTTP routes and
 * the two things they sit on: the courier port (`port.ts`) and Orders'
 * fulfilment repository (spec §5.2–§5.4).
 *
 * THIS FILE OWNS THE ORDER OF THE REFUSALS AND NOTHING ELSE OWNS IT. Four
 * entry points ask the same questions in the same order — the routes, the two
 * webhook endpoints and the sweep — and if each asked them for itself they
 * would drift: one would call a courier for a parcel already booked, another
 * would quote Terminal for a line with no weight. The routes translate what
 * comes back into status codes and translate nothing else.
 *
 * A REFUSAL IS A RETURN VALUE, NOT A THROW, and the split is deliberate. The
 * five refusals below are ORDINARY answers about state — the shop ships by
 * hand, the parcel is already booked, a line has no weight — and every one of
 * them is something the screen must render rather than something that went
 * wrong. What throws is the courier failing (`LogisticsError`, which the
 * routes map by code) and an address a courier cannot collect at, which is
 * also a `LogisticsError` because `readShippingAddress` is the only thing that
 * can see it.
 *
 * NOTHING HERE WRITES SQL. Every write goes through `orders/repo/courier.ts`
 * or the existing ship/deliver transitions, so the CAS, the timeline rows and
 * the email intents stay exactly what they already were — which is the whole
 * reason a courier's "delivered" sends the same two messages a human pressing
 * the button sends.
 */

export interface MissingWeight {
  orderLineId: string;
  variantId: string;
  sku: string;
  title: string;
}

export interface QuoteResponse {
  provider: 'fez' | 'terminal';
  providerLabel: string;
  weightKg: number;
  /** Terminal's draft shipment id, which `book` must be given back. Null for Fez. */
  quoteRef: string | null;
  note: string | null;
  options: QuoteOption[];
  /**
   * ALWAYS PRESENT, `[]` when every line has a weight. A client that had to
   * tell an absent key from an empty array would tell them apart wrongly, and
   * the difference here is "book it" versus "go and weigh two products".
   */
  missingWeights: MissingWeight[];
}

export type Refusal =
  | {
      refused:
        | 'provider_manual'
        | 'already_booked'
        | 'provider_not_configured'
        /**
         * The parcel has left. Only `cancelParcelCourier` produces it, and it
         * is a refusal rather than a throw for the reason the other four are:
         * "this is already on a van" is an ordinary answer about state that
         * the screen must RENDER, not a failure. Raised as a 409 by
         * `routes.ts#refusal`, exactly like `already_booked`.
         */
        | 'already_shipped';
    }
  | { refused: 'weights_missing'; lines: MissingWeight[] };

export interface CourierUpdateOutcome {
  fulfillment: Fulfillment;
  /** The courier's raw status differed from the one already on the row. */
  changed: boolean;
  transitioned: 'shipped' | 'delivered' | null;
}

/**
 * The courier states a parcel may be (re)booked from. **The JS mirror of
 * `REBOOKABLE` in `orders/repo/courier.ts`**, and it is here to produce a
 * legible refusal rather than to decide anything: the guard in the UPDATE's
 * own WHERE is the authority, because a check made here is made against a
 * snapshot a concurrent booking has already invalidated.
 */
const REBOOKABLE: ReadonlySet<string | null> = new Set([
  null,
  'draft',
  'cancelled',
  'failed',
  'returned',
]);

const asMissing = (line: ParcelLine): MissingWeight => ({
  orderLineId: line.orderLineId,
  variantId: line.variantId,
  sku: line.sku,
  title: line.title,
});

/**
 * ₦6,450.00 from 645000. Still here rather than in a module of its own, because
 * there is no shared money formatter on the server and two call sites in one
 * subsystem do not earn one — `diagnostics.ts` imports this rather than
 * carrying a second copy that could drift.
 */
export function naira(minor: number): string {
  return `₦${(minor / 100).toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * The customer's own order page, for the mails a courier's update sends.
 *
 * THE STOREFRONT'S ORIGIN, NEVER THIS ADMIN'S AND NEVER A `Host` HEADER — the
 * identical rule (and the identical shipped bug) `orders/routes.ts#linkFor`
 * and `server/shop/storefront-url.ts` document at length. There is no request
 * here at all: a webhook and the sweep both arrive without one.
 */
export function accessLinkFor(order: OrderRead, now: number): AccessLink | null {
  const origin = storefrontOrigin();
  if (!origin) return null;
  return {
    origin,
    token: mintGuestToken({ orderNumber: order.order.orderNumber, email: order.order.email }, now),
  };
}

/**
 * What a courier is told about one parcel.
 *
 * THE PARCEL'S LINES AT THE PARCEL'S QUANTITIES, never the order's. A
 * three-parcel order books three collections, and a request built from the
 * order would declare the whole order's weight and value in each of them —
 * which is an insurance figure, so it is money as well as physics.
 *
 * WEIGHTS COME THROUGH THE CATALOG PORT and are read AT QUOTE TIME rather
 * than frozen with the order: a variant weighed after the order was placed is
 * exactly the case the "set weights and re-quote" step exists for. An absent
 * key means an absent variant and is carried as `null`, never as zero — a
 * parcel booked as weightless is a parcel the courier reprices on the doorstep.
 *
 * `routingCity` IS AN OVERRIDE FOR THIS ONE REQUEST — see the three steps at
 * the call site below.
 */
export async function buildParcelInput(
  db: Db,
  deps: ResolvedLogisticsDeps,
  order: OrderRead,
  f: Fulfillment,
  settings: LogisticsSettings,
  routingCity?: string | null,
): Promise<{ input: ParcelInput; missing: ParcelLine[] }> {
  const lines = order.lines.filter((line) => f.lines.some((fl) => fl.orderLineId === line.id));
  const weights = await deps.catalog.weightsFor(db, lines.map((line) => line.variantId));

  const items: ParcelLine[] = lines.map((line) => ({
    orderLineId: line.id,
    variantId: line.variantId,
    title: line.title,
    sku: line.sku,
    qty: f.lines.find((fl) => fl.orderLineId === line.id)?.qty ?? line.qty,
    unitMinor: line.unitAmount,
    weightGrams: weights.get(line.variantId) ?? null,
  }));

  const to = readShippingAddress(order.order.shippingAddress);

  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * WHICH DELIVERY ZONE THE COURIER IS TOLD — THREE STEPS, IN THIS ORDER.
   *
   *   1. `routingCity`, the zone a staff member picked in the booking dialog
   *      from the courier's own list of acceptable names. The way through an
   *      order the courier will not recognise — and PERSISTED NOWHERE: the
   *      shipment goes out priced to a zone the courier accepts, and the
   *      customer's address stays the words they actually typed.
   *   2. else the zone the SHOPPER picked at checkout (migration 1020), which
   *      is null on every order placed before it — which is most of them, and
   *      is why step 1 exists at all.
   *   3. else nothing, and each adapter falls back to the REAL city for itself:
   *      `terminal/adapter.ts` sends `routingCity ?? city`, and Fez reads
   *      neither because Fez validates no city.
   *
   * A BLANK OVERRIDE IS STEP 2, NOT AN EMPTY ZONE. An operator who cleared the
   * box has picked nothing; sending `""` would make the courier refuse an empty
   * city rather than fall back to the one it was going to refuse anyway.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  const zone = routingCity != null && routingCity.trim() !== '' ? routingCity.trim() : null;

  const input: ParcelInput = {
    fulfillmentId: f.id,
    orderNumber: order.order.orderNumber,
    /* The order's address is the fallback for the one field a courier needs to
       notify anybody — plenty of checkouts carry no address-level email. */
    to: { ...to, email: to.email ?? order.order.email, routingCity: zone ?? to.routingCity },
    from: settings.shipFrom,
    items,
    valueMinor: items.reduce((sum, item) => sum + item.unitMinor * item.qty, 0),
    packaging: settings.packaging,
    packagingRef: settings.terminalPackagingId,
  };
  return { input, missing: missingWeights(items) };
}

/** The parcel and the order behind it, or `null` when either is gone. */
async function load(
  db: Db,
  fulfillmentId: string,
): Promise<{ f: Fulfillment; order: OrderRead } | null> {
  const read = await readFulfillment(db, fulfillmentId);
  if (!read) return null;
  const order = await readOrder(db, read.fulfillment.orderId);
  if (!order) return null;
  return { f: read.fulfillment, order };
}

/**
 * Everything a quote or a booking needs, once the four questions have been
 * asked and none of them refused.
 *
 * `providerId` IS CARRIED SEPARATELY FROM `settings.provider`, which is the
 * wider `manual | fez | terminal`. Once `manual` has been refused the courier
 * is one of two, and saying so here is what lets the writes below name it
 * without a cast — the compiler holds the narrowing that the refusal earned.
 */
interface Preflight {
  settings: LogisticsSettings;
  providerId: ProviderId;
  provider: LogisticsProvider;
  f: Fulfillment;
  order: OrderRead;
}

/**
 * The four questions asked before any courier is called, in the one order the
 * screen depends on: which courier, is it wired here, does the parcel exist,
 * is it free to be booked.
 */
async function preflight(
  db: Db,
  deps: ResolvedLogisticsDeps,
  fulfillmentId: string,
): Promise<Preflight | Refusal | null> {
  const settings = await getLogisticsSettings(db);
  if (settings.provider === 'manual') return { refused: 'provider_manual' };

  const providerId: ProviderId = settings.provider;
  const provider = deps.providerFor(providerId);
  if (!provider) return { refused: 'provider_not_configured' };

  const ctx = await load(db, fulfillmentId);
  if (!ctx) return null;
  if (ctx.f.status !== 'pending' || !REBOOKABLE.has(ctx.f.courierState)) {
    return { refused: 'already_booked' };
  }
  return { settings, providerId, provider, f: ctx.f, order: ctx.order };
}

/**
 * What will this parcel cost to send, and by whom.
 *
 * TERMINAL'S DRAFT IS STORED, FEZ'S NOTHING IS. Terminal quotes against a
 * draft shipment it creates, and `book` has to name that same draft — so the
 * id goes on the parcel with `courier_state = 'draft'`, which is a state the
 * repository's own guard lets a later booking overwrite. Fez prices a state
 * and a weight and holds nothing, so a Fez quote leaves the row untouched and
 * a second quote costs nothing.
 *
 * `routingCity` re-asks the price for a DIFFERENT ZONE without touching the
 * order — the second half of the dialog's rescue, after the courier has named
 * the values it would accept.
 */
export async function quoteParcel(
  db: Db,
  deps: ResolvedLogisticsDeps,
  fulfillmentId: string,
  now: number,
  routingCity?: string | null,
): Promise<QuoteResponse | Refusal | null> {
  const pre = await preflight(db, deps, fulfillmentId);
  if (pre === null || 'refused' in pre) return pre;
  const { settings, providerId, provider, f, order } = pre;

  const { input, missing } = await buildParcelInput(db, deps, order, f, settings, routingCity);
  /*
   * THE OWNER'S RULE, AND IT IS CHECKED BEFORE THE COURIER IS CALLED AT ALL.
   * Terminal prices per item by weight, so a line with none is a shipment
   * priced on a guess — and a guess made by us, on a parcel a customer has
   * already paid for. Fez bands 0–5 kg into one price, so a missing weight
   * there is a warning, not a refusal.
   */
  if (providerId === 'terminal' && missing.length > 0) {
    return { refused: 'weights_missing', lines: missing.map(asMissing) };
  }

  let quote: QuoteResult;
  try {
    quote = await provider.quote(input);
  } catch (err) {
    /*
     * A FAILED QUOTE CAN STILL HAVE COST US A RECORD AT THE COURIER, and the
     * quotes most likely to fail are exactly the ones an operator retries — a
     * state Terminal will not deliver to, fixed and quoted again. Every one of
     * those attempts used to mint a fresh packaging record and drop the id on
     * the floor. Cache it, then let the failure carry on unchanged to the route
     * that turns it into the operator's message.
     */
    if (err instanceof LogisticsError && err.packagingRef) {
      await setTerminalPackagingId(db, err.packagingRef);
    }
    throw err;
  }
  /* Terminal creates the packaging record on the first quote; caching it here
     is what stops the next quote creating a second one. */
  if (quote.packagingRef) await setTerminalPackagingId(db, quote.packagingRef);
  if (quote.providerRef) {
    try {
      await recordCourierDraft(db, f.id, {
        provider: providerId,
        providerRef: quote.providerRef,
        now,
      });
    } catch (err) {
      /*
       * SOMEBODY BOOKED IT WHILE WE WERE ASKING THE PRICE — the same race
       * `bookParcel` catches below, one door earlier. `preflight` read the
       * parcel free, Terminal was asked for a draft, and by the time the
       * draft came back another tab (or the operator's second click) had
       * booked it. Left to escape, this was a 500 on a question whose honest
       * answer is the ordinary 409 the screen already knows how to draw.
       */
      if (err instanceof CourierConflictError) return { refused: 'already_booked' };
      throw err;
    }
  }

  return {
    provider: providerId,
    providerLabel: provider.label,
    weightKg: quote.weightKg,
    quoteRef: quote.providerRef,
    note: quote.note,
    options: quote.options,
    missingWeights: missing.map(asMissing),
  };
}

/**
 * Book it. **The one call in this subsystem that spends money.**
 *
 * THE REFUSALS ARE RE-ASKED HERE rather than trusted from the quote, because
 * a quote and a booking are two requests with an operator between them: the
 * courier can have been switched off, the parcel booked from another tab, or
 * a weight deleted since the dialog opened.
 *
 * `routingCity` MUST BE THE ONE THE QUOTE WAS ASKED WITH, and the client sends
 * it back for exactly that reason: this parcel is priced again below (Fez) or
 * booked against a draft built from it (Terminal), and a booking made against
 * a different zone from the one that was quoted is a price nobody agreed to.
 */
export async function bookParcel(
  db: Db,
  deps: ResolvedLogisticsDeps,
  fulfillmentId: string,
  a: {
    optionId: string;
    quoteRef: string | null;
    actorId: string;
    now: number;
    routingCity?: string | null;
  },
): Promise<Fulfillment | Refusal | null> {
  const pre = await preflight(db, deps, fulfillmentId);
  if (pre === null || 'refused' in pre) return pre;
  const { settings, providerId, provider, f, order } = pre;

  const { input, missing } = await buildParcelInput(db, deps, order, f, settings, a.routingCity);
  if (providerId === 'terminal' && missing.length > 0) {
    return { refused: 'weights_missing', lines: missing.map(asMissing) };
  }

  /*
   * TERMINAL BOOKS A RATE ON A DRAFT, so the `quoteRef` the client sends back
   * must be the draft this parcel actually holds. A mismatch means the dialog
   * is quoting a shipment that has since been re-quoted (every quote mints a
   * fresh draft, because weights may have changed) — and booking rate A of
   * last week's draft would ship at a price nobody agreed to. Reported the
   * way the courier's own refusals are, because the operator's next move is
   * the same one: get a fresh quote.
   */
  if (providerId === 'terminal' && (!a.quoteRef || a.quoteRef !== f.providerRef)) {
    throw new LogisticsError(
      'provider_rejected',
      'That quote is no longer current — get a fresh one',
    );
  }

  /*
   * RE-QUOTE FEZ TO LEARN THE PRICE WE ARE ABOUT TO PAY. Fez's booking answer
   * carries no amount at all, and a parcel with no `provider_cost_minor` is a
   * shipping bill nobody can reconcile at the end of the month. Terminal needs
   * no second call: its price is the rate that was chosen, and a second quote
   * there would mint a second draft.
   *
   * `?? options[0]` and not a refusal: Fez offers exactly one option, so an
   * `optionId` from a stale dialog names the same delivery it always did.
   */
  let chosen: QuoteOption | null = null;
  if (providerId === 'fez') {
    const quote = await provider.quote(input);
    chosen = quote.options.find((option) => option.id === a.optionId) ?? quote.options[0] ?? null;
  }

  const booked = await provider.book(input, a.optionId, a.quoteRef, chosen);
  const cost = booked.costMinor ?? chosen?.amountMinor ?? null;

  try {
    return await recordCourierBooking(db, f.id, {
      provider: providerId,
      providerRef: booked.providerRef,
      carrier: booked.carrier,
      trackingNumber: booked.trackingNumber,
      trackingUrl: booked.trackingUrl,
      labelUrl: booked.labelUrl,
      costMinor: cost,
      rawStatus: booked.rawStatus,
      state: booked.state,
      now: a.now,
      actorId: a.actorId,
      message: `Booked with ${booked.carrier}${cost == null ? '' : ` · ${naira(cost)}`} · ${booked.trackingNumber}`,
    });
  } catch (err) {
    /*
     * SOMEBODY GOT THERE FIRST, and the courier has already been asked — which
     * is why this is caught rather than pre-checked. The parcel now carries
     * the other booking; this one is a duplicate the operator has to call off
     * with the courier, and the honest answer is the same 409 a second press
     * of the button gets.
     */
    if (err instanceof CourierConflictError) return { refused: 'already_booked' };
    throw err;
  }
}

/**
 * WHAT A COURIER'S ANSWER DOES TO A PARCEL — one function for all three ways
 * one arrives (a webhook, the refresh button, the sweep), so the three can
 * never disagree about what "delivered" means (spec §5.4).
 *
 * THE TRANSITIONS GO THROUGH THE EXISTING REPO FUNCTIONS, deliberately and
 * without exception. `shipFulfillment` and `deliverFulfillment` carry the
 * lifecycle CAS, the timeline rows and — the part worth the whole design —
 * the email intents written by the SAME statement as the status change. A
 * courier saying "delivered" therefore sends precisely what an operator
 * pressing the button sends, including the review invitation, and there is no
 * second rendering of either message to drift.
 *
 * `picked_up`, `in_transit` AND `delivered` ALL SHIP A PENDING PARCEL. A
 * courier that only ever reports `delivered` (or one whose earlier callbacks
 * we missed) must still produce a shipment email before the delivery one, or
 * the customer's first news of their order is that it has arrived.
 *
 * `returned`, `failed` AND `cancelled` MOVE NO STATUS. The parcel physically
 * happened; what changed is that it came back. The row shows the courier
 * state and the operator decides between booking again and shipping by hand.
 */
export async function applyCourierUpdate(
  db: Db,
  f: Fulfillment,
  u: TrackResult,
  a: { now: number; link: AccessLink | null; templates: TemplateSet; label: string },
): Promise<CourierUpdateOutcome> {
  const message = `${u.carrier ?? f.carrier ?? a.label}: ${u.rawStatus}${
    u.description ? ` — ${u.description}` : ''
  }`;

  /* The snapshot decides "did anything change" inside its own UPDATE, so a
     replayed webhook and an idle poll add nothing to the timeline. */
  const snap = await recordCourierSnapshot(db, f.id, {
    rawStatus: u.rawStatus,
    state: u.state,
    trackingNumber: u.trackingNumber ?? null,
    trackingUrl: u.trackingUrl ?? null,
    labelUrl: u.labelUrl ?? null,
    carrier: u.carrier ?? null,
    now: a.now,
    message,
  });

  let current = snap.fulfillment;
  let transitioned: CourierUpdateOutcome['transitioned'] = null;

  const wantsShipped =
    u.state === 'picked_up' || u.state === 'in_transit' || u.state === 'delivered';
  if (wantsShipped && current.status === 'pending') {
    /* `actorId` is null: a courier is not a teammate, and the timeline should
       not name one for something nobody here pressed. */
    current = await shipFulfillment(db, f.id, a.now, a.link, null, a.templates);
    transitioned = 'shipped';
    /* Opportunistic, exactly as the ship route calls it: its ordinary answer
       is "not yet, there are two parcels left". */
    await settleOrderFulfilled(
      db,
      current.orderId,
      {
        fulfillmentId: current.id,
        carrier: current.carrier,
        trackingNumber: current.trackingNumber,
      },
      a.now,
    );
  }

  if (u.state === 'delivered' && current.status === 'shipped') {
    current = await deliverFulfillment(db, f.id, a.now, null, a.link, a.templates);
    transitioned = 'delivered';
  }

  return { fulfillment: current, changed: snap.changed, transitioned };
}

/**
 * Ask the courier where the parcel is, now.
 *
 * `null` FOR A PARCEL WITH NO BOOKING — which the route answers as a 404,
 * because there is nothing to refresh. Not a refusal: nobody promised there
 * would be a courier on it.
 */
export async function refreshParcel(
  db: Db,
  deps: ResolvedLogisticsDeps,
  fulfillmentId: string,
  a: { now: number; templates: TemplateSet },
): Promise<CourierUpdateOutcome | null> {
  const ctx = await load(db, fulfillmentId);
  if (!ctx || !ctx.f.provider || !ctx.f.providerRef) return null;

  /* The courier that booked it, NOT the one currently switched on: a shop that
     has since moved to Terminal still has Fez parcels in flight. */
  const provider = deps.providerFor(ctx.f.provider);
  if (!provider) {
    throw new LogisticsError(
      'not_configured',
      `${PROVIDER_LABEL[ctx.f.provider]} is not set up on this server`,
    );
  }

  const update = await provider.track(ctx.f.providerRef);
  return applyCourierUpdate(db, ctx.f, update, {
    now: a.now,
    link: accessLinkFor(ctx.order, a.now),
    templates: a.templates,
    label: provider.label,
  });
}

/**
 * Call the courier off.
 *
 * THE COURIER IS TOLD FIRST AND THE ROW IS CLEARED SECOND. The other order
 * would leave a parcel that looks free to rebook while a van is still coming
 * for it; this way a courier that refuses the cancellation leaves the row
 * exactly as it was, which is the truth.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * BUT THE STATE IS CHECKED BEFORE ANY OF THAT, AND THAT CHECK IS THE POINT.
 *
 * `recordCourierCancelled`'s guard is `status = 'pending'`, so a parcel a
 * webhook has just shipped cannot be recorded as cancelled — and with the
 * courier called first, the shipped bug was: a real collection stopped, a
 * customer already holding a shipment email that quotes that waybill, and the
 * operator told `{"error":"internal"}` — that the server had crashed and the
 * cancellation had probably not gone through. Every part of that is wrong,
 * and the expensive part is the van.
 *
 * A PRE-CHECK IS NORMALLY THE ANTI-PATTERN THIS SUBSYSTEM ARGUES AGAINST
 * (`orders/repo/courier.ts`: decide inside the UPDATE's own WHERE, never
 * against a snapshot). It earns its place here because the thing it guards is
 * not a database write but an irreversible call to a third party: the guarded
 * write remains the authority, and the race that lands between the two is
 * caught below rather than pretended away.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export async function cancelParcelCourier(
  db: Db,
  deps: ResolvedLogisticsDeps,
  fulfillmentId: string,
  a: { reason: string; actorId: string; now: number },
): Promise<Fulfillment | Refusal | null> {
  const ctx = await load(db, fulfillmentId);
  /* No booking to call off is a 404, not a refusal: nobody promised there
     would be a courier on this parcel. */
  if (!ctx || !ctx.f.provider || !ctx.f.providerRef) return null;

  /* Asked from a FRESH read (`load` above), and asked before the courier is. */
  if (ctx.f.status !== 'pending') return { refused: 'already_shipped' };

  const provider = deps.providerFor(ctx.f.provider);
  if (!provider) {
    throw new LogisticsError(
      'not_configured',
      `${PROVIDER_LABEL[ctx.f.provider]} is not set up on this server`,
    );
  }

  await provider.cancel(ctx.f.providerRef, a.reason);
  try {
    return await recordCourierCancelled(db, ctx.f.id, {
      now: a.now,
      actorId: a.actorId,
      /* The reason is optional here as everywhere else in this admin (owner's
         call, 2026-09-03), so a blank one must still read as a sentence. */
      message: `Courier cancelled${a.reason ? `: ${a.reason}` : ''}`,
    });
  } catch (err) {
    if (!(err instanceof CourierConflictError)) throw err;
    /*
     * THE CHECK AND THE WRITE ARE TWO STATEMENTS, so a webhook can still land
     * between them — and when it does, THE COURIER HAS ALREADY BEEN
     * CANCELLED. That is the one fact the row must not lose: the parcel now
     * says `shipped` with a waybill on it that no van is coming for, and only
     * a human can reconcile that.
     *
     * So the outcome is recorded rather than swallowed. `provider_last_error`
     * is where this subsystem already puts "the courier and this row disagree"
     * — it renders on the parcel row as "Courier problem: …" — and it moves
     * no status, which is right: nothing about the parcel's own lifecycle
     * changed. The answer to the operator is the same `already_shipped` the
     * pre-check gives, because their next move is identical: refresh and look.
     */
    await recordCourierSyncError(db, ctx.f.id, {
      now: a.now,
      message: `Cancelled at ${provider.label}, but this parcel had already shipped — no collection is coming for waybill ${ctx.f.providerRef}.`,
    });
    return { refused: 'already_shipped' };
  }
}

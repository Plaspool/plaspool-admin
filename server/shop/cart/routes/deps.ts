import { unavailableCatalog } from '../catalog-port';
import { DEFAULT_SHIPPING_ZONES, DEFAULT_STORE_CURRENCY } from '../checkout/shipping';
import { SHOP_SESSION_TTL_MS } from '../identity/customers';
import type { Db } from '../../../db/client';
import type { CatalogPort } from '../catalog-port';
import type { CheckoutPaymentsPort } from '../payments-port';
import type { ShippingZone } from '../checkout/shipping';
import type { PointsRedemptionPort } from '../../../../shared/marketing/redemption';
import type { DiscountCodePort } from '../../../../shared/marketing/discounts';
import type { AddOnPort } from '../../../../shared/commerce/add-ons';

/**
 * Everything the shop routes need that is not a database handle.
 *
 * INJECTED, EXACTLY AS `AppDeps` INJECTS `db` AND `origins`, and for the same
 * two reasons `server/index.ts` gives: a suite must be able to build the app
 * over its own PGlite and its own fakes, and importing this module must not
 * demand a configured environment. Every field has a default that is either
 * correct or that refuses — never one that pretends.
 */
export interface ShopCartDeps {
  /**
   * Catalog. Defaults to `unavailableCatalog()`, which THROWS on every method.
   *
   * A deployment with no Catalog cannot price a cart, so a default that answered
   * would be a shop quoting prices it invented. Cart's own suites inject the
   * fake (`test/fake-catalog.ts`); production injects the real port when
   * Catalog mounts the shop app.
   */
  catalog: CatalogPort;

  /**
   * The storefront identity bridge's shared secret. NO DEFAULT — absent means
   * the exchange route answers 501, exactly the discipline `deliverMagicLink`
   * established before it: a default that pretended would be an
   * account-takeover primitive, and it would have passed every test.
   */
  bridgeSecret?: string;

  /** How long a redeemed customer session lasts. Matches the row's own TTL. */
  sessionTtlMs: number;

  /** The one store currency (contract §13: no multi-currency in v1). */
  storeCurrency: string;

  /** Shipping options and the flat tax rate per zone (contract §13). */
  zones: readonly ShippingZone[];

  /**
   * DRAIN `commerce_events` FOR THE OTHER CONSUMERS AS PART OF THIS CRON
   * (admin#29).
   *
   * `vercel.json` IS AT THE HOBBY CRON CEILING — `server/routes/email.ts` states
   * it plainly: "Two crons is also the Hobby ceiling; a third needs a plan, not
   * a config line." Both slots are taken. So the scheduled backstop for the
   * commerce outbox is folded into the cron that already exists, already
   * authenticates and already fails closed, rather than added beside it. The
   * cron count stays at two and `cron.test.ts` keeps passing without an edit to
   * `vercel.json` at all.
   *
   * INJECTED, NOT IMPORTED. Cart drains this outbox for its OWN consumer
   * (`runCartMaintenance`); Orders drains it for its own. Two consumers, two
   * ledgers, one table — and Cart importing Orders to run the other one would be
   * the cross-subsystem coupling the ports exist to prevent. `server/shop/app.ts`
   * is the composition point and hands this in.
   *
   * Absent means the cart half runs alone, which is what every Cart-only suite
   * wants and is exactly the behaviour this cron had before.
   */
  sweepEvents?: (db: Db, origin: string | null) => Promise<CommerceSweepCounts>;

  /**
   * SPEND SPOOLPOINTS AT THE FREEZE (admin#2). The other half of the seam
   * `server/index.ts` describes; this is the field that comment promised.
   *
   * A FACTORY OVER THE HANDLE, NOT A PORT. `PointsRedemptionPort` is frozen in
   * `shared/marketing/redemption.ts` and takes no database argument on any of
   * its three methods — it was frozen that way because the browser bundle
   * compiles it and it therefore cannot name a server-only type. Marketing's
   * implementation closes over a handle instead, and `currentDb(c)` is
   * request-scoped, so what this field can hold is a function of the handle
   * rather than a long-lived object. `server/marketing/redemption/port.ts` says
   * so in its own header; this is the shape it asked for.
   *
   * TYPED FROM `shared/`, INJECTED AT THE COMPOSITION ROOT. Spec D9 forbids
   * `server/shop/**` importing `server/marketing/**` and the reverse, and a
   * type-only import is still an import — but `shared/marketing/redemption.ts`
   * is explicitly "the only thing marketing and the shop may both know about",
   * so naming the interface here breaks nothing. The implementation is injected
   * by `server/index.ts` and by nothing else.
   *
   * ABSENT MEANS TODAY'S BEHAVIOUR: no quote, no adjustment, no debit. Every
   * Cart-only suite gets exactly the totals it got before this landed, which is
   * what makes the wiring safe to add to a shop that is already taking money.
   */
  redemption?: (db: Db) => PointsRedemptionPort;

  /**
   * Discount codes (admin#100 Part B). A factory over the request's handle, for
   * every reason `redemption` above is one — including the type-only import,
   * which reaches `shared/` and never `server/marketing/`.
   *
   * NO DEFAULT, AND ABSENT IS A REAL STATE rather than an oversight: the cart
   * view reports `discountCodesEnabled: false` and the apply route answers 501.
   * A default that pretended would put a code on a cart that the freeze then
   * refused — the shopper would be shown a discount and charged without it.
   */
  discounts?: (db: Db) => DiscountCodePort;

  /**
   * PAYMENTS, for one question and one narrow write: may this frozen checkout
   * be unfrozen, and cancel the intent that was holding it.
   *
   * A PORT AND NOT A FACTORY, unlike the two above it, because
   * `CheckoutPaymentsPort` takes the database handle on every method — it was
   * declared by Cart in `server/shop/cart/payments-port.ts` rather than frozen
   * in `shared/`, so it had no reason to inherit the constraint that made
   * `redemption` a closure.
   *
   * ABSENT REFUSES RATHER THAN DEGRADES — the one field in this interface for
   * which "either correct or refuses" resolves to refuses. `POST
   * /checkout/cancel` answers 501 and an address edit on a frozen cart keeps
   * answering the 409 it answers today. Both are visibly broken; the
   * alternative default reopens carts that were paid for, which is not.
   */
  payments?: CheckoutPaymentsPort;

  /**
   * Checkout add-ons (spec 2026-09-06). A PORT over the handle like payments.
   * ABSENT MEANS NO ADD-ONS ANYWHERE: the cart view sends no addOns, the
   * preview sends [], and the choice route answers 501.
   */
  addOns?: AddOnPort<Db>;

  /**
   * LINK THE GUEST ORDERS AN ARRIVING CUSTOMER ALREADY PLACED (2026-09-08).
   *
   * A guest checkout leaves `shop_orders.customer_id NULL` and keeps only the
   * typed email; the exchange route mints a customer row keyed by a VERIFIED
   * address. Nothing joined the two, so a shopper who bought first and signed
   * in afterwards saw an empty order history — measured on a real order, with
   * both rows present and nothing between them.
   *
   * INJECTED, NOT IMPORTED, for the reason `sweepEvents` gives above:
   * `shop_orders` is ORDERS' table, and Cart reaching into it directly is the
   * cross-subsystem coupling the ports exist to prevent. `server/shop/app.ts`
   * is the composition point and hands Orders' `adoptGuestOrders` in.
   *
   * ABSENT MEANS TODAY'S BEHAVIOUR: the exchange mints the session and adopts
   * nothing, which is what every Cart-only suite expects and what the route did
   * before this landed. It is a convenience, never a credential — a failure to
   * adopt must not cost the customer their sign-in, so the route treats it as
   * best-effort.
   */
  adoptOrders?: (db: Db, customerId: string, email: string) => Promise<number>;
}

/** What the injected commerce drain reports back. Counts only — the per-event
 *  dispositions belong in Orders' own `/admin/sweep` response, not in a cron's. */
export interface CommerceSweepCounts {
  applied: number;
  ignored: number;
  parked: number;
  passes: number;
}

export function resolveShopCartDeps(partial: Partial<ShopCartDeps> = {}): ShopCartDeps {
  return {
    catalog: partial.catalog ?? unavailableCatalog(),
    bridgeSecret: partial.bridgeSecret,
    sessionTtlMs: partial.sessionTtlMs ?? SHOP_SESSION_TTL_MS,
    storeCurrency: partial.storeCurrency ?? DEFAULT_STORE_CURRENCY,
    zones: partial.zones ?? DEFAULT_SHIPPING_ZONES,
    sweepEvents: partial.sweepEvents,
    redemption: partial.redemption,
    discounts: partial.discounts,
    payments: partial.payments,
    addOns: partial.addOns,
    adoptOrders: partial.adoptOrders,
  };
}

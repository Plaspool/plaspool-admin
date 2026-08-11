import { unavailableCatalog } from '../catalog-port';
import { DEFAULT_SHIPPING_ZONES, DEFAULT_STORE_CURRENCY } from '../checkout/shipping';
import { SHOP_SESSION_TTL_MS } from '../identity/customers';
import type { CatalogPort } from '../catalog-port';
import type { ShippingZone } from '../checkout/shipping';

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
   * Magic-link delivery. NO DEFAULT — absent means the route answers 501.
   *
   * See `routes/customer.ts` for why this is injected rather than defaulted to
   * something that returns the token: a route that hands a session token back in
   * its own response body is an unauthenticated account-takeover primitive, and
   * it would have passed every test written against it.
   */
  deliverMagicLink?: (a: {
    email: string;
    token: string;
    expiresAt: number;
  }) => Promise<void>;

  /** How long a redeemed customer session lasts. Matches the row's own TTL. */
  sessionTtlMs: number;

  /** The one store currency (contract §13: no multi-currency in v1). */
  storeCurrency: string;

  /** Shipping options and the flat tax rate per zone (contract §13). */
  zones: readonly ShippingZone[];
}

export function resolveShopCartDeps(partial: Partial<ShopCartDeps> = {}): ShopCartDeps {
  return {
    catalog: partial.catalog ?? unavailableCatalog(),
    deliverMagicLink: partial.deliverMagicLink,
    sessionTtlMs: partial.sessionTtlMs ?? SHOP_SESSION_TTL_MS,
    storeCurrency: partial.storeCurrency ?? DEFAULT_STORE_CURRENCY,
    zones: partial.zones ?? DEFAULT_SHIPPING_ZONES,
  };
}

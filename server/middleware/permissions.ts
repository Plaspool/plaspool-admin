import type { MiddlewareHandler } from 'hono';
import { ForbiddenError } from './errors';
import { hasDomain, type Domain } from '../../shared/roles';
import type { AppEnv } from '../app-env';

/**
 * THE DOMAIN GATE (migration 0680): which admin ROLE may touch which admin
 * SURFACE, decided in one table over URL prefixes rather than in six roles'
 * worth of edits to forty route files.
 *
 * WHAT IT IS NOT. It is not authentication (the session middleware above it
 * resolves who you are), it is not the per-route guards (`requireAuth`,
 * `requireAdmin`, `requireOwner` still run and still decide anonymous-vs-401
 * and the owner/developer tier), and it is not reachable by customers: it acts
 * ONLY when an ADMIN session resolved. A storefront request carries the shop
 * session or nothing, `c.get('user')` is null, and the request falls through
 * to the route's own rules exactly as before this file existed. That makes the
 * middleware STRICTLY TIGHTENING — it can 403 a signed-in writer where they
 * used to slip through, and can never widen anything.
 *
 * FIRST MATCH WINS, SPECIFIC BEFORE GENERAL, AND THE ADMIN CATCH-ALL IS
 * `danger`. An unmatched `/api/shop/admin/...` route added next month defaults
 * to owner/developer-only rather than to whatever domain happened to sit last
 * in the table — a new money-adjacent route must be OPENED to a role on
 * purpose, never inherited by one.
 *
 * PATHS, NOT ROUTERS, because Hono flattens mounted routers and the mounted
 * paths are the one stable contract (`server/index.ts` documents each mount).
 * The rule list must therefore change when a mount does; the permissions test
 * drives every rule through the real app so a drifted prefix fails loudly.
 */

interface Rule {
  prefix: string;
  domain: Domain;
}

/**
 * ORDERED. `null` domain would mean "skip", but absence does the same — a path
 * matching no rule is left to its route guards (the whole customer surface,
 * `/api/auth/*`, the cron GETs, which carry no session at all).
 */
const RULES: readonly Rule[] = [
  // ── the shop admin surface, specific slices first ─────────────────────────
  { prefix: '/api/shop/admin/orders', domain: 'orders' },
  { prefix: '/api/shop/admin/fulfillments', domain: 'orders' },
  { prefix: '/api/shop/admin/emails', domain: 'orders' },
  { prefix: '/api/shop/admin/customers', domain: 'customers' },
  { prefix: '/api/shop/admin/stats', domain: 'analytics' },
  { prefix: '/api/shop/admin/audit', domain: 'analytics' },
  { prefix: '/api/shop/admin/analytics', domain: 'analytics' },
  { prefix: '/api/shop/admin/payments', domain: 'payments' },
  { prefix: '/api/shop/admin/shipping-zones', domain: 'settings' },
  { prefix: '/api/shop/admin/shipping-options', domain: 'settings' },
  { prefix: '/api/shop/admin/delivery-areas', domain: 'settings' },
  { prefix: '/api/shop/admin/delivery-settings', domain: 'settings' },
  /* Which courier is switched on, the address we ship from, the box we quote
   * against (migration 0990) — settings, beside the zones it prices against.
   * `GET /api/shop/logistics/provider` is deliberately NOT here: it matches no
   * prefix, so every teammate who packs a parcel can read which courier is on
   * while only this admin half is owner-and-developer work. */
  { prefix: '/api/shop/admin/logistics', domain: 'settings' },
  { prefix: '/api/shop/admin/notification-settings', domain: 'settings' },
  /*
   * `orders` AND NOT `settings`, unlike the line above it, because these two
   * prefixes answer different questions for different people. The settings say
   * who the SHOP tells when an order is paid — an owner's decision. These say
   * whether THIS person's own phone buzzes, which belongs to everyone who packs
   * a parcel: making it owner-only would leave the packer, the one actually
   * carrying the phone, unable to turn their own notifications on.
   *
   * It must sit above the `/api/shop/admin/` catch-all below or it inherits
   * `danger` and works for the owner alone, silently.
   */
  { prefix: '/api/shop/admin/push', domain: 'orders' },
  { prefix: '/api/shop/admin/products', domain: 'products' },
  { prefix: '/api/shop/admin/variants', domain: 'products' },
  { prefix: '/api/shop/admin/inventory', domain: 'products' },
  { prefix: '/api/shop/admin/categories', domain: 'products' },
  { prefix: '/api/shop/admin/add-ons', domain: 'products' },
  { prefix: '/api/shop/admin/bulk-tiers', domain: 'products' },
  { prefix: '/api/shop/admin/tags', domain: 'products' },
  /*
   * The sweep stays OUT of the table on purpose: its GET authenticates with
   * the cron bearer and carries no session (the gate never fires), and its
   * POST is `requireAdmin()` at the route — already stricter than any domain.
   */
  { prefix: '/api/shop/admin/sweep', domain: 'danger' },
  // The catch-all AFTER every named slice: a new admin route is closed until
  // somebody adds its rule.
  { prefix: '/api/shop/admin/', domain: 'danger' },

  // Reviews moderation rides the catalog roles. The same prefix serves the
  // customer submit/reactions routes — those arrive with no ADMIN session and
  // the gate ignores them (see the header).
  { prefix: '/api/shop/reviews', domain: 'products' },

  // ── marketing: the operator surface. `/me/*` is the shopper's and matches
  //    no admin session; `/public/*` is mounted above the session middleware
  //    and never reaches this. RETURNS ARE THE EXCEPTION and sit above the
  //    catch-all: a return is order-side customer service — receive, inspect,
  //    award — so it belongs to the roles that hold orders, not to whoever
  //    writes the campaigns. ────────────────────────────────────────────────
  { prefix: '/api/marketing/returns', domain: 'orders' },
  /* Site banners ride the content roles: they live beside posts and featured
   * in the nav, and a writer publishing a banner is publishing site copy. */
  { prefix: '/api/marketing/banners', domain: 'content' },
  { prefix: '/api/marketing/', domain: 'marketing' },
  { prefix: '/api/admin/email/', domain: 'marketing' },

  // ── the blog ──────────────────────────────────────────────────────────────
  { prefix: '/api/posts', domain: 'content' },
  { prefix: '/api/categories', domain: 'content' },
  { prefix: '/api/images', domain: 'content' },
  { prefix: '/api/featured', domain: 'content' },
  { prefix: '/api/revisions', domain: 'content' },
  { prefix: '/api/trash', domain: 'content' },

  // ── the team and the endings ──────────────────────────────────────────────
  { prefix: '/api/users', domain: 'team' },
  { prefix: '/api/invites', domain: 'team' },
  { prefix: '/api/backup', domain: 'danger' },
  { prefix: '/api/export', domain: 'danger' },
  /* `/api/import` restores a POST bundle into the importing writer's own
   * account (`server/routes/revisions.ts` pins the author) — content work,
   * not the full-instance surgery `/api/export` is. */
  { prefix: '/api/import', domain: 'content' },
];

/** Exported for the test that drives every rule through the real app. */
export function domainFor(path: string): Domain | null {
  for (const rule of RULES) {
    if (path.startsWith(rule.prefix)) return rule.domain;
  }
  return null;
}

export function rolePermissions(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('user');
    if (user) {
      const domain = domainFor(c.req.path);
      if (domain && !hasDomain(user.role, domain)) throw new ForbiddenError();
    }
    await next();
  };
}

import { Hono } from 'hono';
import { z } from 'zod';
import { readJson, str } from '../../middleware/errors';
import { requireAdmin, requireAuth } from '../../middleware/session';
import { currentDb, currentUser } from '../../app-env';
import { NotFoundError } from '../../repo/errors';
import { deliveryConfigFor } from './config';
import { getDeliverySettings, patchDeliverySettings } from './repo';
import { activeCourier } from '../logistics/repo';
import type { AppEnv } from '../../app-env';

/**
 * The delivery settings surface — `/admin/delivery-settings` (migration 0760).
 *
 * MOUNTED INTO `shopApp()` AT `'/'`, exactly as `shipping-zones-routes.ts` is,
 * so the paths below are relative to `/api/shop`. Guards attach PER ROUTE,
 * never `use('*', …)`: a blanket guard on a router that `app.route(prefix,
 * router)` flattens applies to paths this file has never heard of and turns a
 * would-be 404 into a 401.
 *
 * THE DOMAIN IS `settings`, which `server/middleware/permissions.ts` grants
 * over this prefix and which only the owner and developers hold. `requireAdmin`
 * on the write is the second lock rather than the only one — the same shape
 * `/admin/delivery-areas` uses, and for the stronger reason: this row can turn
 * off every per-district refusal in the shop at once.
 *
 * THERE IS NO POST AND NO DELETE. The row is a CHECK-pinned singleton seeded by
 * migration 0760 — a shop has one delivery configuration, and a route that
 * could create or remove it would be a route that can leave checkout with none.
 */
export const deliverySettingsRoutes = new Hono<AppEnv>();

const auth = requireAuth();

const DeliverySettingsBody = z
  .object({
    /** Required, as on every settings patch in this codebase. A screen that
     *  could save without one is two tabs quietly overwriting each other. */
    expectedRevision: z.number().int().min(1),
    addressMode: z.enum(['district', 'simple']).optional(),
    locationOffered: z.boolean().optional(),
    /**
     * `.nullable().optional()` IS THE WHOLE CONTRACT AND THE HALVES DIFFER.
     * Absent = leave the restriction as it is. Explicit `null` = clear it, the
     * shop serves every region a zone covers. An array = only these.
     *
     * `.min(1)` PER ELEMENT AND NO EMPTY ARRAY: `[]` reaches the repo, which
     * refuses it as a 400 rather than letting the column's CHECK surface as a
     * 500. "Serve nowhere" and "serve everywhere" are one keystroke apart and
     * only one of them shuts the shop, so the empty list is not a spelling of
     * either.
     */
    servedRegions: z.array(str().min(1).max(120)).max(100).nullable().optional(),
    /**
     * Where the shop ships at all (migration 1060). NOT nullable, unlike
     * `servedRegions`: there is no "no restriction" to express, because a
     * country nobody named falls to the catch-all zone — the bug 0900 fixed.
     *
     * THE SHAPE IS REFUSED HERE, where a bad value can be named to the person
     * who typed it, rather than reaching the column's CHECK as a 500. Two
     * letters, either case: the repo uppercases, so an owner typing `gb` is
     * right. `[]` reaches the repo, which refuses it as a 400 for the same
     * reason `servedRegions` does — closing the shop must not be one keystroke.
     */
    servedCountries: z
      /* Surrounding whitespace is TOLERATED, not refused — the repo trims and
       * uppercases, and a validation error about a stray space is the pedantry
       * `normalizeServedRegions` already declines to commit. The two letters
       * themselves are not negotiable: the column's CHECK and `zoneFor` both
       * demand them, and refusing "Nigeria" here names the field to the person
       * who typed it instead of surfacing a 23514 as a 500. */
      .array(str().regex(/^\s*[A-Za-z]{2}\s*$/))
      .max(250)
      .optional(),
  })
  .strict();

/**
 * READ BY ANY HOLDER OF `settings`, which is the owner and developers.
 *
 * The CONFIG rides along beside the row. The screen needs it to show what the
 * storefront will actually render — the field list, the labels, what turns off
 * — and deriving that in the admin UI would put a second copy of
 * `deliveryConfigFor` in a place nothing tests against the first.
 */
deliverySettingsRoutes.get('/admin/delivery-settings', auth, async (c) => {
  const settings = await getDeliverySettings(currentDb(c));
  /*
   * UNREACHABLE THROUGH ANY ROUTE, and answered rather than invented. Migration
   * 0760 seeds this row and nothing deletes it, so `null` means a hand-run
   * DELETE or a restore from before the migration. The public config route
   * serves a default in the same case because a shopper must still be able to
   * check out; a SETTINGS SCREEN showing invented values the save button cannot
   * write would be a screen that looks fine over a broken deployment.
   */
  if (settings === null) throw new NotFoundError('delivery_settings');
  /* THE ACTIVE COURIER DECIDES WHETHER THE ROUTING-CITY FIELD EXISTS, so the
   * screen must show the form the storefront will actually render — the whole
   * reason the config rides along beside the row. `deliveryConfigFor` stays
   * pure; reading which courier is switched on is this route's job. */
  return c.json({
    settings,
    config: deliveryConfigFor(settings, await activeCourier(currentDb(c))),
  });
});

deliverySettingsRoutes.patch('/admin/delivery-settings', requireAdmin(), async (c) => {
  const { expectedRevision, ...patch } = await readJson(c, DeliverySettingsBody);
  const settings = await patchDeliverySettings(currentDb(c), patch, {
    expectedRevision,
    actorId: currentUser(c).id,
    now: Date.now(),
  });
  return c.json({
    settings,
    config: deliveryConfigFor(settings, await activeCourier(currentDb(c))),
  });
});

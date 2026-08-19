import { Hono } from 'hono';
import { z } from 'zod';
import { pathParam, readJson, str } from '../../../middleware/errors';
import { requireAuth } from '../../../middleware/session';
import { currentDb } from '../../../app-env';
import type { AppEnv } from '../../../app-env';
import {
  createShippingOption,
  createShippingZone,
  deleteShippingOption,
  deleteShippingZone,
  listShippingZones,
  updateShippingOption,
  updateShippingZone,
} from './shipping-zones-repo';
import type { ShippingOptionPatch, ShippingZonePatch } from './shipping-zones-repo';

/**
 * Admin CRUD for shipping zones and their options (admin#19).
 *
 * MOUNTED INTO `shopApp()` AT `'/'`, exactly as `server/shop/admin/routes.ts`
 * and `server/shop/catalog/routes.ts` are — so the paths below are relative to
 * `/api/shop`. `requireAuth()` per route, never `use('*', …)`, for the same
 * reason `server/shop/admin/routes.ts` gives: a blanket guard on a router
 * flattened by `app.route(prefix, router)` applies to paths this file has never
 * heard of and turns a would-be 404 into a 401.
 */
export const shippingZoneRoutes = new Hono<AppEnv>();

const auth = requireAuth();

const ZoneBody = z
  .object({
    label: str().min(1).max(200),
    countries: z.array(str().max(4)).max(20),
    regions: z.array(str().max(200)).max(200),
    taxRateBps: z.number().int().min(0).max(10000),
    taxLabel: str().max(200),
    shippingTaxable: z.boolean(),
    isFallback: z.boolean(),
    position: z.number().int().min(0),
  })
  .strict();

const ZonePatchBody = ZoneBody.partial().strict();

/**
 * ISO-3166-1 alpha-2, uppercase, no surrounding whitespace — the exact shape
 * `zoneFor` compares against (`countryCode.trim().toUpperCase()`,
 * `shipping.ts`). The admin screen already uppercases before it POSTs, which
 * is why a zone built through it always matches; this is the same
 * normalization applied server-side, because the route is reachable directly
 * and a zone stored as `["ng"]` never matches an uppercase `"NG"` — it falls
 * through to the fallback, silently charging the fallback zone's rate to
 * every customer the intended zone was supposed to price.
 */
function normalizeCountries(countries: string[]): string[] {
  return countries.map((c) => c.trim().toUpperCase());
}

const OptionBody = z
  .object({
    zoneId: str().min(1).max(200),
    label: str().min(1).max(200),
    amountMinor: z.number().int().min(0),
    estimate: str().max(400).optional(),
    position: z.number().int().min(0).optional(),
  })
  .strict();

const OptionPatchBody = z
  .object({
    label: str().min(1).max(200).optional(),
    amountMinor: z.number().int().min(0).optional(),
    estimate: str().max(400).optional(),
    position: z.number().int().min(0).optional(),
  })
  .strict();

/** Every zone with its options, for the admin screen. */
shippingZoneRoutes.get('/admin/shipping-zones', auth, async (c) => {
  return c.json({ items: await listShippingZones(currentDb(c)) });
});

shippingZoneRoutes.post('/admin/shipping-zones', auth, async (c) => {
  const body = await readJson(c, ZoneBody);
  const zone = await createShippingZone(currentDb(c), {
    ...body,
    countries: normalizeCountries(body.countries),
  });
  return c.json({ zone }, 201);
});

shippingZoneRoutes.patch('/admin/shipping-zones/:id', auth, async (c) => {
  const body = await readJson(c, ZonePatchBody);
  const patch: ShippingZonePatch = {
    ...body,
    ...(body.countries ? { countries: normalizeCountries(body.countries) } : {}),
  };
  const zone = await updateShippingZone(currentDb(c), pathParam(c, 'id'), patch);
  return c.json({ zone });
});

shippingZoneRoutes.delete('/admin/shipping-zones/:id', auth, async (c) => {
  await deleteShippingZone(currentDb(c), pathParam(c, 'id'));
  return c.json({ ok: true });
});

shippingZoneRoutes.post('/admin/shipping-options', auth, async (c) => {
  const body = await readJson(c, OptionBody);
  const option = await createShippingOption(currentDb(c), {
    zoneId: body.zoneId,
    label: body.label,
    amountMinor: body.amountMinor,
    estimate: body.estimate ?? '',
    position: body.position ?? 0,
  });
  return c.json({ option }, 201);
});

shippingZoneRoutes.patch('/admin/shipping-options/:id', auth, async (c) => {
  const body = await readJson(c, OptionPatchBody);
  const patch: ShippingOptionPatch = { ...body };
  const option = await updateShippingOption(currentDb(c), pathParam(c, 'id'), patch);
  return c.json({ option });
});

shippingZoneRoutes.delete('/admin/shipping-options/:id', auth, async (c) => {
  await deleteShippingOption(currentDb(c), pathParam(c, 'id'));
  return c.json({ ok: true });
});

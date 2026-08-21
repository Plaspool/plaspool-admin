import { Hono } from 'hono';
import { z } from 'zod';
import { pathParam, readJson, str } from '../../../middleware/errors';
import { requireAuth, requireOwner } from '../../../middleware/session';
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
import { listDeliveryAreas, saveDeliveryArea, saveDeliveryAreas } from './delivery-areas-repo';

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

// ═══════════════════════════════════════════════ per-district delivery (0300)

/**
 * DOES THE SHOP GO TO THIS DISTRICT, AND WHAT DOES IT CHARGE.
 *
 * The districts are `marketing_service_areas` and live behind the marketing
 * API; these routes carry only the COMMERCE opinion about them, keyed by the
 * area's stable handle. The admin screen reads both lists and joins them — see
 * `delivery-areas-repo.ts` for why the shop does not read marketing's tables.
 *
 * `requireOwner()` ON THE WRITES, AND THAT DIFFERS FROM THE ZONE ROUTES ABOVE.
 * Whether the shop delivers somewhere, and for how much, is the same class of
 * decision as which districts a van serves — which `MarketingAreas` already
 * makes owner-only (spec D12: the control is ABSENT for a writer, not
 * disabled). A writer reading the rate table is fine and useful; a writer
 * silently switching off a city is not. The read therefore keeps `auth`.
 */
const RATE_MINOR = z.number().int().min(0).max(1_000_000_000);

const DeliveryAreaBody = z
  .object({
    delivers: z.boolean().optional(),
    /*
     * `.nullable().optional()` IS THE WHOLE CONTRACT AND THE TWO HALVES DIFFER.
     * Absent = leave the rate as it is. Explicit `null` = clear the override
     * back to the state's zone rate. A number = override. `.strict()` above
     * means a typo'd key is a 400 rather than a silently ignored no-op.
     */
    rateMinor: RATE_MINOR.nullable().optional(),
    /** CAS. `null` asserts "there is no row for this district yet". */
    expectedRevision: z.number().int().min(0).nullable(),
  })
  .strict();

const DeliveryAreasBulkBody = z
  .object({
    areaKeys: z.array(str().min(1).max(200)).min(1).max(1000),
    delivers: z.boolean().optional(),
    rateMinor: RATE_MINOR.nullable().optional(),
  })
  .strict();

shippingZoneRoutes.get('/admin/delivery-areas', auth, async (c) => {
  return c.json({ items: await listDeliveryAreas(currentDb(c)) });
});

shippingZoneRoutes.put('/admin/delivery-areas/:areaKey', requireOwner(), async (c) => {
  const body = await readJson(c, DeliveryAreaBody);
  const area = await saveDeliveryArea(
    currentDb(c),
    pathParam(c, 'areaKey'),
    { delivers: body.delivers, rateMinor: body.rateMinor },
    body.expectedRevision,
  );
  return c.json({ area });
});

/**
 * "Every district in this state" — one statement, no CAS. The bulk control is
 * an owner deliberately overriding whatever is there; see the repo's note on
 * why failing forty rows because one moved is the worse answer.
 */
shippingZoneRoutes.post('/admin/delivery-areas/bulk', requireOwner(), async (c) => {
  const body = await readJson(c, DeliveryAreasBulkBody);
  const items = await saveDeliveryAreas(currentDb(c), body.areaKeys, {
    delivers: body.delivers,
    rateMinor: body.rateMinor,
  });
  return c.json({ items });
});

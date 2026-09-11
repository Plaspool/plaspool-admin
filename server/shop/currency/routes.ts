import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { pathParam, readJson, str } from '../../middleware/errors';
import { requireAdmin, requireAuth } from '../../middleware/session';
import { currentDb, currentUser } from '../../app-env';
import { BadRequestError, NotFoundError } from '../../repo/errors';
import { exponentOf, isKnownCurrency } from '../../../shared/commerce/currencies';
import { formatMultiplier, parseMultiplier } from '../../../shared/commerce/fx';
import {
  KNOWN_CURRENCIES,
  clearMultiplier,
  notOfferedReason,
  readFxState,
  setEnabledCurrencies,
  setFeedMargin,
  setManualMultiplier,
  setVariantMultiplier,
  variantMultipliersFor,
  type FxState,
} from './state';
import { REFRESH_AFTER_MS, refreshFeedRates, type RateRefresh } from './feed';
import type { AppEnv } from '../../app-env';
import type { Db } from '../../db/client';

/**
 * THE ADMIN HALF OF THE PUBLISHED MULTIPLIERS (1140).
 *
 * TWO PREFIXES, CHOSEN FOR THEIR PERMISSION DOMAINS (`middleware/permissions.ts`):
 * the currency screen lives under `/shop/admin/payments/currency` — what the
 * shop charges in is a payments decision — and a variant's multiplier under
 * `/shop/admin/variants/:id/multipliers`, beside the variant's price, in the
 * products domain. Writes to the currency list and the rates are
 * `requireAdmin()`, exactly as the gateway switch is.
 *
 * EVERY WRITE MOVES `revision` (see `state.ts`), so a storefront that
 * displayed the old numbers is refused at the payment step and re-renders.
 */

const HOUR_MS = 3_600_000;

const Currency = str().regex(/^[A-Za-z]{3}$/).transform((s) => s.toUpperCase());

/** A multiplier as text — twelve fractional digits at most, never a float. */
const MultiplierText = str()
  .max(32)
  .refine((s) => {
    try {
      parseMultiplier(s);
      return true;
    } catch {
      return false;
    }
  }, 'a positive decimal with at most 12 fractional digits');

const PatchCurrencyBody = z
  .object({
    enabled: z.array(Currency).min(1).max(32).optional(),
    /** The owner's margin on the daily rate, in basis points: 300 = 3%. */
    feedMarginBps: z.number().int().min(0).max(5000).optional(),
    revision: z.number().int().min(0),
  })
  .strict()
  .refine((b) => b.enabled !== undefined || b.feedMarginBps !== undefined, 'nothing to change');

const PutRateBody = z.object({ multiplier: MultiplierText }).strict();

const PutVariantMultiplierBody = z.object({ multiplier: MultiplierText }).strict();

/** The currency screen: every currency switched on or known, with why it is or is not offered. */
function settingsView(state: FxState) {
  const codes = [...new Set([state.storeCurrency, ...state.enabled, ...state.rates.keys()])];
  return {
    storeCurrency: state.storeCurrency,
    revision: state.revision,
    stalenessHours: state.stalenessHours,
    feedMarginBps: state.feedMarginBps,
    /** A daily rate is fetched again once it is this old — by the sweep, on its own. */
    refreshAfterHours: REFRESH_AFTER_MS / HOUR_MS,
    fallbackCurrency: state.fallbackCurrency,
    countries: state.countries,
    known: KNOWN_CURRENCIES,
    offered: state.offered,
    currencies: codes.map((code) => {
      const rate = state.rates.get(code);
      const store = code === state.storeCurrency;
      return {
        code,
        exponent: isKnownCurrency(code) ? exponentOf(code) : null,
        store,
        enabled: store || state.enabled.includes(code),
        multiplier: store ? '1.000000000000' : rate ? formatMultiplier(rate.multiplierE12) : null,
        source: store ? null : (rate?.source ?? null),
        updatedAt: store ? null : (rate?.updatedAt ?? null),
        ageHours: store || !rate ? null : Math.floor((state.now - rate.updatedAt) / HOUR_MS),
        gateway: store || state.chargeable.has(code),
        offered: state.offered.includes(code),
        reason: notOfferedReason(state, code),
      };
    }),
  };
}

/** A currency code from the path, uppercased; a 400 naming the field otherwise. */
function codeParam(raw: string): string {
  const parsed = Currency.safeParse(raw);
  if (!parsed.success) throw new BadRequestError('code');
  return parsed.data;
}

async function requireVariant(db: Db, id: string): Promise<void> {
  const res = await db.execute(sql`SELECT 1 FROM shop_variants WHERE id = ${id}`);
  if (!res.rows[0]) throw new NotFoundError(id);
}

export function currencyAdminRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const read = requireAuth();
  const admin = requireAdmin();

  routes.get('/admin/payments/currency', read, async (c) =>
    c.json(settingsView(await readFxState(currentDb(c)))),
  );

  /**
   * Switch currencies on and off, and set the margin on the daily rate. CAS on
   * `revision`; the store currency is always on. A new margin is applied at
   * once: the daily rates are fetched again and rewritten with it.
   */
  routes.patch('/admin/payments/currency', admin, async (c) => {
    const db = currentDb(c);
    const body = await readJson(c, PatchCurrencyBody);
    const state = await readFxState(db);
    let revision = body.revision;
    if (body.enabled !== undefined) {
      const enabled = [...new Set([state.storeCurrency, ...body.enabled])];
      if (enabled.some((code) => !isKnownCurrency(code))) throw new BadRequestError('enabled');
      revision = await setEnabledCurrencies(db, enabled, revision, currentUser(c).id);
    }
    let refresh: RateRefresh | null = null;
    if (body.feedMarginBps !== undefined && body.feedMarginBps !== state.feedMarginBps) {
      await setFeedMargin(db, body.feedMarginBps, revision, currentUser(c).id);
      refresh = await refreshFeedRates(db, { force: true });
    }
    return c.json({ ...settingsView(await readFxState(db)), refresh });
  });

  /**
   * "Refresh rates now". Fetches the daily rate for every switched-on currency
   * that is not set by hand, whatever its age. The sweep does the same on its
   * own every twelve hours; this is for the owner who does not want to wait.
   */
  routes.post('/admin/payments/currency/refresh', admin, async (c) => {
    const db = currentDb(c);
    const refresh = await refreshFeedRates(db, { force: true });
    return c.json({ ...settingsView(await readFxState(db)), refresh });
  });

  /** The owner's own multiplier for a currency. Never goes stale; the feed never overwrites it. */
  routes.put('/admin/payments/currency/:code/multiplier', admin, async (c) => {
    const db = currentDb(c);
    const code = codeParam(pathParam(c, 'code'));
    if (!isKnownCurrency(code)) throw new BadRequestError('code');
    const body = await readJson(c, PutRateBody);
    const state = await readFxState(db);
    if (code === state.storeCurrency) throw new BadRequestError('code');
    await setManualMultiplier(db, code, parseMultiplier(body.multiplier));
    return c.json(settingsView(await readFxState(db)));
  });

  /** Forget a currency's multiplier; the next feed run fills it in again. */
  routes.delete('/admin/payments/currency/:code/multiplier', admin, async (c) => {
    const db = currentDb(c);
    const code = codeParam(pathParam(c, 'code'));
    await clearMultiplier(db, code);
    return c.json(settingsView(await readFxState(db)));
  });

  // ─────────────────────────────────────────────── per-variant multipliers

  routes.get('/admin/variants/:id/multipliers', read, async (c) => {
    const db = currentDb(c);
    const id = pathParam(c, 'id');
    await requireVariant(db, id);
    return c.json({ items: await variantMultipliersFor(db, id) });
  });

  /** A variant's own multiplier for one currency — replaces the currency's on its lines. */
  routes.put('/admin/variants/:id/multipliers/:code', read, async (c) => {
    const db = currentDb(c);
    const id = pathParam(c, 'id');
    const code = codeParam(pathParam(c, 'code'));
    if (!isKnownCurrency(code)) throw new BadRequestError('code');
    const body = await readJson(c, PutVariantMultiplierBody);
    await requireVariant(db, id);
    await setVariantMultiplier(db, id, code, parseMultiplier(body.multiplier), currentUser(c).id);
    return c.json({ items: await variantMultipliersFor(db, id) });
  });

  routes.delete('/admin/variants/:id/multipliers/:code', read, async (c) => {
    const db = currentDb(c);
    const id = pathParam(c, 'id');
    const code = codeParam(pathParam(c, 'code'));
    await requireVariant(db, id);
    await setVariantMultiplier(db, id, code, null, currentUser(c).id);
    return c.json({ items: await variantMultipliersFor(db, id) });
  });

  return routes;
}

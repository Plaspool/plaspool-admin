import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { readJson, str } from '../../middleware/errors';
import { requireAdmin, requireAuth } from '../../middleware/session';
import { currentDb, currentUser } from '../../app-env';
import type { AppEnv } from '../../app-env';
import { adminOrigin } from '../../admin-url';
import { FEZ_LIVE_URL, TERMINAL_LIVE_URL, environmentOf, logisticsEnv } from './config';
import { resolveLogisticsDeps } from './deps';
import { LogisticsError, PROVIDER_LABEL } from './port';
import type { ProviderId, ShipFrom } from './port';
import { getLogisticsSettings, listRecentWebhooks, patchLogisticsSettings } from './repo';
import type { LogisticsSettings } from './repo';

/**
 * The delivery-courier surface — `/admin/logistics/*` and one read for everyone
 * who packs a parcel.
 *
 * MOUNTED INTO `shopApp()` AT `'/'`, exactly as `shipping-zones-routes.ts` and
 * `settings/routes.ts` are, so the paths below are relative to `/api/shop`.
 * GUARDS ATTACH PER ROUTE, never `use('*', …)`: a blanket guard on a router that
 * `app.route(prefix, router)` flattens applies to paths this file has never
 * heard of and turns a would-be 404 into a 401.
 *
 * TWO DOMAINS, ON PURPOSE. `/admin/logistics/*` is `settings` in
 * `server/middleware/permissions.ts` — choosing the courier and the address we
 * ship from is an owner-and-developer decision, beside the shipping zones it
 * prices against. `GET /logistics/provider` is `requireAuth()` and nothing else,
 * because every teammate who opens a parcel needs to know whether the button
 * says "Book with Fez" or "By hand", and gating that on `settings` would blank
 * the screen for the people doing the packing.
 *
 * THERE IS NO POST AND NO DELETE for the settings. The row is a CHECK-pinned
 * singleton seeded by migration 0960; a route that could create or remove it
 * would be a route that can leave the shop with no courier configuration at all.
 */
export const logisticsRoutes = new Hono<AppEnv>();

const auth = requireAuth();

/**
 * `countryCode` IS PINNED TO `NG` and that is a decision, not an oversight. Both
 * couriers are Nigerian and quote domestic parcels; a ship-from in another
 * country would be accepted here and rejected — differently, and much later — by
 * whichever courier was asked to collect from it.
 */
const ShipFromBody = z
  .object({
    name: str().min(1).max(200),
    phone: str().min(3).max(40),
    email: str().email().max(200).optional(),
    line1: str().min(1).max(300),
    line2: str().max(300).optional(),
    city: str().min(1).max(120),
    region: str().min(1).max(120),
    postalCode: str().min(1).max(20),
    countryCode: z.literal('NG'),
  })
  .strict();

const PackagingBody = z
  .object({
    name: str().min(1).max(100),
    lengthCm: z.number().positive().max(500),
    widthCm: z.number().positive().max(500),
    heightCm: z.number().positive().max(500),
    weightKg: z.number().positive().max(100),
  })
  .strict();

const SettingsBody = z
  .object({
    /** Required, as on every settings patch here. A screen that could save
     *  without one is two tabs quietly overwriting each other. */
    expectedRevision: z.number().int().min(1),
    provider: z.enum(['manual', 'fez', 'terminal']).optional(),
    /** Absent leaves the address alone; an explicit `null` clears it. */
    shipFrom: ShipFromBody.nullable().optional(),
    packaging: PackagingBody.optional(),
  })
  .strict();

/**
 * The fields a courier cannot collect without. `email` and `line2` are not on
 * it: both providers treat them as optional and refusing a save over a missing
 * second address line would be pedantry with a shop's dispatch behind it.
 */
export const SHIP_FROM_REQUIRED: (keyof ShipFrom)[] = [
  'name',
  'phone',
  'line1',
  'city',
  'region',
  'postalCode',
];

/** Which required fields are absent or blank. Empty means the address is usable. */
export function shipFromMissing(from: ShipFrom | null): string[] {
  if (!from) return [...SHIP_FROM_REQUIRED];
  return SHIP_FROM_REQUIRED.filter((key) => !from[key] || String(from[key]).trim() === '');
}

/**
 * The origin a courier's webhook must be pointed at.
 *
 * RESOLVED IN THREE STEPS, IN ORDER, and every one of them is judged against
 * `c.get('origins')` — the exact list `originGuard` checked this request
 * against, the same value `POST /api/invites` builds an invite link from, and
 * for the identical reason: this URL is handed to a third party who will then
 * call it, so building it from anything unvalidated would let a caller
 * register an endpoint of their choosing as this admin's courier webhook.
 *
 *   1. The `Origin` header, when it is allow-listed. Every unsafe method
 *      (`POST`, `PATCH`) carries one — `originGuard` refuses the request
 *      otherwise — so this is what a dev host or a preview registers itself
 *      under.
 *   2. Else the request URL's OWN origin (`new URL(c.req.url).origin`), when
 *      THAT is allow-listed. A same-origin browser `GET` carries no `Origin`
 *      header at all — that is what a browser does, not a gap here — so
 *      skipping straight to step 3 whenever the header is missing would make
 *      `GET /admin/logistics/settings` show one host while `POST
 *      …/webhooks/register` from the very same tab registers another. Reading
 *      where the request actually arrived is safe for the identical reason
 *      step 1 is: it is not a value the caller gets to assert.
 *   3. Else the pinned default, `adminOrigin()` — nothing about this request
 *      names an allow-listed origin at all, by header or by arrival.
 *
 * Falling through past step 1 at all — rather than always answering
 * `adminOrigin()` — is what makes the dev host register its own URL instead
 * of production's; step 2 is what makes a GET agree with the POST beside it.
 */
export function webhookBase(c: Context<AppEnv>): string {
  const allowed = c.get('origins') ?? [];

  const headerOrigin = c.req.header('origin');
  if (headerOrigin && allowed.includes(headerOrigin)) return headerOrigin;

  const requestOrigin = new URL(c.req.url).origin;
  if (allowed.includes(requestOrigin)) return requestOrigin;

  return adminOrigin();
}

export const webhookPath = (provider: ProviderId): string =>
  `/api/shop/logistics/${provider}/webhook`;

/**
 * The settings row plus everything the screen needs beside it.
 *
 * COVERAGE AND THE WEBHOOK LOG RIDE ALONG rather than being two more round
 * trips: "78 of 120 variants have no weight" is the reason a courier cannot be
 * switched on, and a screen that has to ask for it separately is a screen that
 * will show the switch without the reason.
 *
 * NO SECRET EVER APPEARS HERE. `configured` is a boolean and `environment` is
 * derived from a base URL; the credentials themselves live only in
 * `config.ts` and never leave it.
 */
async function settingsView(
  c: Context<AppEnv>,
  settings: LogisticsSettings,
): Promise<Record<string, unknown>> {
  const db = currentDb(c);
  const deps = resolveLogisticsDeps();
  const env = logisticsEnv();
  const base = webhookBase(c);

  const [coverage, recentWebhooks] = await Promise.all([
    deps.catalog.weightCoverage(db),
    listRecentWebhooks(db, 10),
  ]);

  return {
    provider: settings.provider,
    shipFrom: settings.shipFrom,
    packaging: settings.packaging,
    revision: settings.revision,
    updatedAt: settings.updatedAt,
    providers: {
      fez: {
        configured: deps.providerFor('fez') !== null,
        environment: environmentOf(env.fez?.baseUrl ?? '', FEZ_LIVE_URL),
        webhookUrl: `${base}${webhookPath('fez')}`,
      },
      terminal: {
        configured: deps.providerFor('terminal') !== null,
        environment: environmentOf(env.terminal?.baseUrl ?? '', TERMINAL_LIVE_URL),
        webhookUrl: `${base}${webhookPath('terminal')}`,
      },
    },
    variantsMissingWeight: coverage.missing,
    variantsTotal: coverage.total,
    recentWebhooks,
  };
}

/**
 * WHICH COURIER IS SWITCHED ON — the one logistics read every teammate gets.
 *
 * Deliberately the narrowest possible answer: the setting and its label, no
 * address, no coverage, no webhook log. A parcel screen needs to know what the
 * button says; it has no business learning the dispatch address from a route
 * that anyone signed in can call.
 */
logisticsRoutes.get('/logistics/provider', auth, async (c) => {
  const settings = await getLogisticsSettings(currentDb(c));
  return c.json({ provider: settings.provider, label: PROVIDER_LABEL[settings.provider] });
});

logisticsRoutes.get('/admin/logistics/settings', auth, async (c) =>
  c.json(await settingsView(c, await getLogisticsSettings(currentDb(c)))),
);

/**
 * REFUSALS COME BEFORE THE WRITE, and they are judged against the state the
 * patch would PRODUCE rather than the one it names.
 *
 * That is the whole reason `nextProvider` and `nextFrom` exist: clearing the
 * address on a shop already switched to Terminal names no provider at all, and
 * a check that only looked at `patch.provider` would let it through and leave
 * the next booking to fail at the courier with a customer waiting.
 */
logisticsRoutes.patch('/admin/logistics/settings', requireAdmin(), async (c) => {
  const db = currentDb(c);
  const { expectedRevision, ...patch } = await readJson(c, SettingsBody);
  const deps = resolveLogisticsDeps();

  const current = await getLogisticsSettings(db);
  const nextProvider = patch.provider ?? current.provider;
  const nextFrom = patch.shipFrom === undefined ? current.shipFrom : patch.shipFrom;

  /* Switching a courier on that this deployment has no credentials for would
     save a setting whose only effect is a 500 on the next booking. */
  if (nextProvider !== 'manual' && deps.providerFor(nextProvider) === null) {
    return c.json({ error: 'provider_not_configured', provider: nextProvider }, 409);
  }

  /*
   * TERMINAL ONLY. Fez collects from an address held in their own portal, so it
   * can be switched on before ours is filled in; Terminal quotes from the
   * ship-from we send it and refuses the shipment without one. Requiring it for
   * both would block the courier that does not need it.
   */
  if (nextProvider === 'terminal') {
    const missing = shipFromMissing(nextFrom);
    if (missing.length > 0) return c.json({ error: 'ship_from_incomplete', missing }, 409);
  }

  const saved = await patchLogisticsSettings(db, patch, {
    expectedRevision,
    actorId: currentUser(c).id,
    now: deps.now(),
  });
  return c.json(await settingsView(c, saved));
});

const RegisterBody = z.object({ provider: z.enum(['fez', 'terminal']) }).strict();

/**
 * Tell a courier where to call us back.
 *
 * A BUTTON RATHER THAN A BOOT STEP: both providers register the URL against an
 * account, so doing it on every cold start would re-register it on every lambda
 * and there would be nothing on screen to say whether it had worked. The URL is
 * derived here, never accepted from the body — see `webhookBase`.
 */
logisticsRoutes.post('/admin/logistics/webhooks/register', requireAdmin(), async (c) => {
  const { provider } = await readJson(c, RegisterBody);
  const adapter = resolveLogisticsDeps().providerFor(provider);
  if (!adapter) return c.json({ error: 'provider_not_configured', provider }, 409);

  try {
    await adapter.registerWebhook(`${webhookBase(c)}${webhookPath(provider)}`);
  } catch (err) {
    /*
     * A courier refusing is not this application failing, and the three ways it
     * can refuse are not one answer either — the operator's next move differs
     * for each, and a single 502 tells them to press the button again for all
     * three (global constraints' error table; 500 is worse still, because the
     * client retries it five times for an answer that cannot change).
     *
     *   not_configured   → 409. This deployment has no credentials for that
     *                      courier. The same body the guard above answers, so
     *                      one cause reads as one thing however it surfaces:
     *                      the fix is an env var, not a retry.
     *   provider_rejected → 422. The courier read the request and declined it.
     *                      Retrying produces the identical refusal, so their
     *                      words go to the screen and the operator changes
     *                      something — usually the URL or the account.
     *   anything else     → 502. The other end was unreachable, timed out or
     *                      answered nonsense. THIS is the retryable one.
     */
    if (err instanceof LogisticsError) {
      if (err.code === 'not_configured') {
        return c.json({ error: 'provider_not_configured', provider }, 409);
      }
      if (err.code === 'provider_rejected') {
        return c.json({ error: 'provider_rejected', message: err.message }, 422);
      }
      return c.json({ error: 'provider_error', message: err.message }, 502);
    }
    throw err;
  }
  return c.json({ ok: true });
});

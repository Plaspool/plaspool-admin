import { sql } from 'drizzle-orm';
import { BadRequestError, NotFoundError, StaleWriteError } from '../../repo/errors';
import { toEpochMs } from '../../db/client';
import type { SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';

/**
 * The shop's delivery configuration — one row, `id = 'main'` (migration 0760).
 *
 * FOLLOWS `shipping-zones-repo.ts` AND `delivery-areas-repo.ts` TO THE LETTER:
 * plain `sql` templates over hand-written DDL, NEVER `db.transaction` (the Neon
 * HTTP driver throws on it unconditionally while PGlite supports it — so a
 * transaction passes every test here and 500s in production), one guarded
 * statement rather than read-compare-write, and every array bind rendered
 * explicitly because a bare array bind is a `22P02`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS ROW DECIDES, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * It decides which QUESTIONS checkout asks — whether the storefront shows the
 * district picker, whether it offers to take a location pin, and which address
 * regions the shop will accept at all.
 *
 * It does NOT decide prices. Those are `shop_shipping_zones` and
 * `shop_delivery_areas`, unchanged. `address_mode = 'simple'` prices at the
 * state's zone rate not because this row says so but because an address with no
 * district has always been priced that way — `districtRuling` has answered
 * `ZONE_RATE` for a null district since migration 0300. This row's only effect
 * on money is to stop a district that IS stored from being consulted, which is
 * the one thing needed so a cart captured before the switch flipped does not
 * price differently from the form the shopper is now looking at.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * The singleton's primary key, pinned by `shop_delivery_settings_id_ck`.
 *
 * A CHECK-CONSTRAINED CONSTANT rather than a table with one row by convention,
 * `marketing_settings`' precedent: "there is exactly one configuration" is then
 * something the database enforces, so a second row cannot appear and leave two
 * answers to "which form does checkout render" for whichever sorted first.
 */
const SETTINGS_ID = 'main';

export type AddressMode = 'district' | 'simple';

export interface DeliverySettings {
  addressMode: AddressMode;
  locationOffered: boolean;
  /** `null` = no restriction. Never an empty array — the CHECK forbids one. */
  servedRegions: string[] | null;
  /**
   * ISO-3166-1 alpha-2, uppercase. NEVER NULL AND NEVER EMPTY, and unlike
   * `servedRegions` there is no spelling of "no restriction".
   *
   * The asymmetry is deliberate and it is about money. An unrestricted REGION
   * list is harmless — every Nigerian region is inside a zone this shop has
   * priced. An unrestricted COUNTRY list is the bug migration 0900 fixed: every
   * country nobody named falls to the catch-all zone, so a London order is
   * quoted domestic delivery and Nigerian VAT. A country the shop has not
   * named is a country it will not ship to, and that must be unrepresentable
   * rather than merely discouraged.
   */
  servedCountries: string[];
  revision: number;
  updatedAt: number;
}

/**
 * The subset checkout needs, and the shape `CheckoutConfig` carries.
 *
 * SEPARATE FROM `DeliverySettings` because the money path must not depend on
 * fields that only describe a form. `locationOffered` decides whether the
 * storefront renders a button; it has no business being in scope where a total
 * is computed, and a type that excludes it cannot accidentally be read there.
 */
export interface DeliveryRules {
  addressMode: AddressMode;
  servedRegions: string[] | null;
  /**
   * `null` = NO COUNTRY RESTRICTION, and it is not a shape the column can hold.
   *
   * `served_countries` is NOT NULL with a CHECK forbidding the empty array, so
   * a configured shop ALWAYS restricts and `loadDeliveryRules` always carries a
   * list. `null` reaches here only from `DEFAULT_DELIVERY_RULES` — a caller
   * that supplied no delivery configuration at all.
   *
   * IT MUST STAY PERMISSIVE, because that is what this whole type promises: the
   * no-row fallback is "today's behaviour, exactly", and before migration 1060
   * checkout never refused on country — the gate was the storefront reading
   * `config.country.allowed`, and nothing server-side looked at it. A `['NG']`
   * here would silently start refusing every foreign address for callers that
   * never configured a shop, which is a behaviour change wearing a default's
   * clothes.
   *
   * The safety this gives up is bought back where it belongs: the COLUMN cannot
   * be empty, and `DEFAULT_DELIVERY_SETTINGS` — what the public config renders
   * from when the row is missing — still says Nigeria and nowhere else, so the
   * form a shopper actually sees stays locked.
   */
  servedCountries: string[] | null;
}

/**
 * WHAT A DEPLOYMENT WITH NO ROW GETS — today's behaviour, exactly.
 *
 * Migration 0760 seeds the row and nothing deletes it, so this is reachable
 * only by a hand-run DELETE or a database restored from before the migration.
 * It is still written down rather than thrown, because the money path reads it:
 * a checkout that 500s because a configuration row is missing is a worse answer
 * than a checkout that behaves the way it did last week.
 *
 * A MISSING TABLE IS NOT COVERED BY THIS AND MUST NOT BE. That means the code
 * was deployed ahead of its migration, which is a broken deployment, and the
 * one lesson this codebase keeps re-learning is that a fallback which hides a
 * wiring bug costs more than the outage it prevents.
 */
export const DEFAULT_DELIVERY_RULES: DeliveryRules = {
  addressMode: 'district',
  servedRegions: null,
  /* No restriction — see the field's comment. Pre-1060 checkout refused on
   * country nowhere, and this constant's job is to reproduce that exactly. */
  servedCountries: null,
};

/** Nigeria and nowhere else — the value migration 1060 seeds, and what the
 *  address form falls back to when the row is missing. */
const DEFAULT_SETTINGS_COUNTRIES = ['NG'] as const;

/**
 * The same default as a whole row, for the public config route — which has to
 * answer something renderable rather than 404 a storefront out of a checkout.
 *
 * `revision: 0` IS A SENTINEL AND CANNOT COLLIDE: the column's CHECK is
 * `revision > 0`, so a zero on the wire says "no row" and nothing else does.
 */
export const DEFAULT_DELIVERY_SETTINGS: DeliverySettings = {
  ...DEFAULT_DELIVERY_RULES,
  /* OVERRIDDEN, AND THE DISAGREEMENT WITH `DEFAULT_DELIVERY_RULES` IS THE POINT.
   *
   * That constant answers "may checkout refuse this address?" and says no,
   * reproducing pre-1060 behaviour for a caller that configured nothing. This
   * one answers "what form does the storefront render?" — and a form offering
   * countries the shop has never priced is the selector migration 1060's header
   * argues against. So the FORM stays locked to Nigeria even with no row, while
   * the money path stays as permissive as it has always been. */
  servedCountries: [...DEFAULT_SETTINGS_COUNTRIES],
  locationOffered: false,
  revision: 0,
  updatedAt: 0,
};

const COLUMNS = sql`address_mode, location_offered, served_regions, served_countries, revision, updated_at`;

function rowToSettings(row: Record<string, unknown>): DeliverySettings {
  return {
    // The CHECK constrains this to the two values; `$type<>()` would not.
    addressMode: String(row.address_mode) === 'simple' ? 'simple' : 'district',
    locationOffered: row.location_offered === true,
    // `text[]` arrives as a JS array from both drivers, and the CHECK
    // guarantees no NULL and no empty elements — so the cast is total.
    servedRegions: row.served_regions == null ? null : (row.served_regions as string[]),
    /* NOT NULL with a CHECK that forbids an empty array, so the `??` is for a
     * row read back from a database that predates migration 1060 — not for a
     * shape the column can hold. */
    servedCountries:
      (row.served_countries as string[] | null) ?? [...DEFAULT_SETTINGS_COUNTRIES],
    // `integer`, which PGlite and Neon agree about; `toEpochMs` exists for the
    // int8 divergence and `updated_at` is the only int8 here.
    revision: Number(row.revision),
    updatedAt: toEpochMs(row.updated_at),
  };
}

// ---------------------------------------------------------------------- read

/** The whole row, for the settings screen. `null` only if somebody deleted it. */
export async function getDeliverySettings(db: Db): Promise<DeliverySettings | null> {
  const res = await db.execute(sql`
    SELECT ${COLUMNS} FROM shop_delivery_settings WHERE id = ${SETTINGS_ID}`);
  return res.rows[0] ? rowToSettings(res.rows[0] as Record<string, unknown>) : null;
}

/**
 * What checkout loads on every request, beside the live shipping zones.
 *
 * ITS OWN FUNCTION RATHER THAN `getDeliverySettings()` PLUS A `??`, so the
 * fallback above lives in one place and the money path cannot forget it.
 */
export async function loadDeliveryRules(db: Db): Promise<DeliveryRules> {
  const settings = await getDeliverySettings(db);
  if (settings === null) return DEFAULT_DELIVERY_RULES;
  return {
    addressMode: settings.addressMode,
    servedRegions: settings.servedRegions,
    servedCountries: settings.servedCountries,
  };
}

// --------------------------------------------------------------- normalising

/**
 * Fold a region the way `zoneFor` folds one: case and edge whitespace out.
 *
 * DUPLICATED FROM `checkout/shipping.ts` RATHER THAN IMPORTED, and the
 * duplication is one line against a dependency that points the wrong way — this
 * module is read BY the checkout config, and `shipping.ts`'s header makes a
 * point of taking every input as an argument rather than reaching for one.
 * `settings.test.ts` asserts the two agree on the spellings that matter.
 */
export function normalizeRegion(region: string): string {
  return region.trim().toLowerCase();
}

/**
 * The served list as the column will hold it: trimmed, de-duplicated on the
 * folded form, first spelling wins.
 *
 * NORMALISED HERE RATHER THAN REFUSED, `normaliseAliases`' precedent. An owner
 * who types " Lagos " has said something correct; a validation error about
 * whitespace is pedantry. What IS refused is a list that trims away to nothing,
 * because the CHECK forbids an empty array and a raw `23514` is a 500 for input
 * a person typed.
 */
export function normalizeServedRegions(regions: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of regions) {
    const value = raw.trim();
    if (value === '') continue;
    const folded = normalizeRegion(value);
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(value);
  }
  if (out.length === 0) {
    /* Clearing the restriction is a legal, meaningful act — it is what `null`
     * means. It just is not spelled `[]`, because "serve nowhere" and "serve
     * everywhere" are one keystroke apart and only one of them shuts the shop. */
    throw new BadRequestError('servedRegions');
  }
  return out;
}

/** Does `region` fall inside the served list? `null` list serves everywhere. */
export function servesRegion(
  servedRegions: readonly string[] | null,
  region: string | null | undefined,
): boolean {
  if (servedRegions === null || servedRegions.length === 0) return true;
  // A restriction is set and the address named no region: refused. The zone
  // this would fall into is the catch-all, which is the one the restriction
  // exists to stop being handed out silently.
  if (region == null || region.trim() === '') return false;
  const folded = normalizeRegion(region);
  return servedRegions.some((served) => normalizeRegion(served) === folded);
}

/**
 * The served country list as the column will hold it: trimmed, uppercased,
 * de-duplicated, order preserved.
 *
 * NORMALISED HERE RATHER THAN REFUSED, `normalizeServedRegions`' precedent — an
 * owner who types " ng " has said something correct. What IS refused is a list
 * that empties out, because the CHECK forbids an empty array and a raw `23514`
 * is a 500 for input a person typed. The SHAPE (two letters) is refused by the
 * route's schema, where a bad value can be named to the person who typed it.
 */
export function normalizeServedCountries(countries: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of countries) {
    const value = normalizeCountry(raw);
    if (value === '') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  /* Unlike regions there is no `null` to fall back to: "we ship nowhere" is not
   * a state this shop can be in, so an empty result is the owner's mistake and
   * is named as one. */
  if (out.length === 0) throw new BadRequestError('servedCountries');
  return out;
}

/** Fold a country code the way `zoneFor` folds one: case and edge whitespace out. */
export function normalizeCountry(countryCode: string): string {
  return countryCode.trim().toUpperCase();
}

/** Does `countryCode` appear in the shop's served list? */
export function servesCountry(
  servedCountries: readonly string[] | null,
  countryCode: string | null | undefined,
): boolean {
  // `null` = nobody configured a restriction. See `DeliveryRules`.
  if (servedCountries === null || servedCountries.length === 0) return true;
  if (countryCode == null) return false;
  const folded = normalizeCountry(countryCode);
  return servedCountries.some((served) => normalizeCountry(served) === folded);
}

/**
 * Why the shop will not deliver here — `'country'`, `'region'`, or `null` for
 * "it will".
 *
 * ONE FUNCTION RATHER THAN TWO PREDICATES AT FOUR CALL SITES, because the rule
 * below is the kind that gets forgotten at the fourth one. `checkout/repo.ts`
 * consults this wherever it consults the district refusal — the address, the
 * options, the shipping choice and the freeze — since an owner can narrow
 * either list while a cart sits at the payment step, and the answer after the
 * freeze is a refund.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A REGION RESTRICTION IS A NIGERIAN TOOL AND STOPS AT THE BORDER.
 *
 * `served_regions` holds Nigerian STATES; it exists so simple mode can say "we
 * do not drive to Kano" (migration 0760). Applied to a foreign address it
 * refuses every one of them, because "England" is not in a list of Nigerian
 * states — so the first owner to open a second country would watch
 * international checkout fail for a reason named after a domestic setting, and
 * would "fix" it by clearing a restriction that was protecting something real.
 *
 * So the region list is consulted only for the DEFAULT country: the head of
 * `servedCountries`, which is also what the address form pre-selects.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * COUNTRY IS CHECKED FIRST so the message names the outer fact. "We don't ship
 * to Canada" and "we don't deliver to Kano yet" need different sentences and
 * different next steps — the same argument `outside_service_region` already
 * makes against reusing `outside_delivery_area`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS THE MANUAL SHIPPING METHOD'S RULE, AND ONLY ITS RULE.
 *
 * `served_countries` is the owner saying where the shop will send a parcel it
 * arranges ITSELF. It is not a statement about what a courier can carry.
 *
 * When the logistics providers land (Fez, Terminal — `feat/logistics-providers`,
 * not on master at the time of writing), a parcel routed through one of them is
 * serviceable exactly when THAT PROVIDER says it is: they own the country and
 * city lists, they quote the rate, and they refuse what they will not carry.
 * Consulting this list as well would refuse deliveries a courier would happily
 * make, and would do it in the owner's name for a decision the owner never took.
 *
 * So a provider-routed checkout must SKIP this function rather than be added to
 * the list, and the shape here is deliberately friendly to that: it is a pure
 * predicate over rules, called from four places in `checkout/repo.ts`, none of
 * which is inside the pricing engine.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function serviceRefusal(
  rules: DeliveryRules,
  countryCode: string | null | undefined,
  region: string | null | undefined,
): 'country' | 'region' | null {
  if (!servesCountry(rules.servedCountries, countryCode)) return 'country';

  /* WITH NO COUNTRY LIST THERE IS NO HOME COUNTRY, so the region restriction
   * applies to every address — which is exactly what it did before 1060, and
   * what the pre-existing region tests encode. The scoping below narrows the
   * rule only for a shop that has actually named its countries. */
  const homeCountry = rules.servedCountries?.[0];
  if (homeCountry !== undefined) {
    const isHome =
      countryCode != null && normalizeCountry(countryCode) === normalizeCountry(homeCountry);
    if (!isHome) return null;
  }

  return servesRegion(rules.servedRegions, region) ? null : 'region';
}

// --------------------------------------------------------------------- write

export interface DeliverySettingsPatch {
  addressMode?: AddressMode;
  locationOffered?: boolean;
  /**
   * `undefined` LEAVES IT ALONE; an explicit `null` CLEARS the restriction.
   * The two cannot be collapsed — which is why this is `| null` rather than an
   * optional array, and why the SQL below uses `CASE WHEN <provided>` rather
   * than `COALESCE`. `COALESCE` cannot tell "do not change" from "set to null",
   * and a bare NULL bind inside one needs an explicit cast anyway or Postgres
   * refuses the whole statement with `42P18`.
   */
  servedRegions?: readonly string[] | null;
  /**
   * `undefined` LEAVES IT ALONE. There is no `null` here, unlike
   * `servedRegions`: clearing the country list is not a meaningful act, it is
   * closing the shop, so the only two things an owner can say are "change it to
   * this" and "do not change it".
   */
  servedCountries?: readonly string[];
}

export interface DeliverySettingsWriteOptions {
  expectedRevision: number;
  actorId: string;
  now: number;
}

function textArray(values: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

/**
 * Write the row, compare-and-swap on `expectedRevision`.
 *
 * ONE STATEMENT, NO TRANSACTION AND NO PRIOR READ. The `WHERE … AND revision =`
 * makes read-compare-write atomic in the database, so two settings tabs cannot
 * quietly overwrite each other. Zero rows back therefore means exactly one of
 * two things, and the follow-up SELECT is only there to say which.
 */
export async function patchDeliverySettings(
  db: Db,
  patch: DeliverySettingsPatch,
  opts: DeliverySettingsWriteOptions,
): Promise<DeliverySettings> {
  const modeGiven = patch.addressMode !== undefined;
  const locationGiven = patch.locationOffered !== undefined;
  const regionsGiven = patch.servedRegions !== undefined;
  const countriesGiven = patch.servedCountries !== undefined;

  /* Normalised BEFORE the statement so a refusal is a 400 naming the field
   * rather than a CHECK violation surfacing as a 500. */
  const regions =
    patch.servedRegions == null ? null : normalizeServedRegions(patch.servedRegions);
  const countries =
    patch.servedCountries === undefined ? null : normalizeServedCountries(patch.servedCountries);

  const res = await db.execute(sql`
    UPDATE shop_delivery_settings SET
      address_mode = CASE WHEN ${modeGiven}
                          THEN ${patch.addressMode ?? null}::text
                          ELSE address_mode END,
      location_offered = CASE WHEN ${locationGiven}
                              THEN ${patch.locationOffered ?? false}
                              ELSE location_offered END,
      served_regions = CASE WHEN ${regionsGiven}
                            THEN ${regions === null ? sql`NULL::text[]` : textArray(regions)}
                            ELSE served_regions END,
      served_countries = CASE WHEN ${countriesGiven}
                              THEN ${countries === null ? sql`served_countries` : textArray(countries)}
                              ELSE served_countries END,
      revision = revision + 1,
      updated_at = ${opts.now},
      updated_by = ${opts.actorId}::uuid
    WHERE id = ${SETTINGS_ID} AND revision = ${opts.expectedRevision}
    RETURNING ${COLUMNS}`);

  const written = res.rows[0];
  if (written !== undefined) return rowToSettings(written as Record<string, unknown>);

  /* The update matched nothing. Either the row is gone — which no route can do
   * and which the settings screen must be told about plainly — or somebody else
   * saved first, which is a 409 carrying the revision to re-read. */
  const current = await db.execute(sql`
    SELECT revision FROM shop_delivery_settings WHERE id = ${SETTINGS_ID}`);
  const row = current.rows[0];
  if (row === undefined) throw new NotFoundError('delivery_settings');
  throw new StaleWriteError(opts.expectedRevision, Number(row.revision ?? 0));
}

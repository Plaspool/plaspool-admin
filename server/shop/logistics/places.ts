import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { toEpochMs } from '../../db/client';
import { BadRequestError } from '../../repo/errors';
import type { ResolvedLogisticsDeps } from './deps';
import { LogisticsError } from './port';
import type { PlaceCity, PlaceRegion, ProviderId } from './port';
import { activeCourier, getLogisticsSettings } from './repo';
import type { ProviderSetting } from './repo';

/**
 * THE COURIER'S OWN PLACE LISTS — fetched on a button, cached in
 * `shop_logistics_places` (migration 1000), and served to the storefront from
 * the cache and never from the courier.
 *
 * WHY THE CACHE EXISTS AT ALL. Terminal validates `state` AND `city` against
 * its own per-country lists and refuses anything else with a 400 that kills the
 * whole quote — measured 2026-09-07: 37 states for NG, ten place names inside
 * the FCT, 46 in Lagos, so a customer in Gwarinpa cannot be quoted at all.
 * Reading that list live would be 37 requests inside a checkout. So an admin
 * asks, the answer lands in one row, and every reader after that is one SELECT.
 *
 * TWO ENTRY POINTS, DELIBERATELY DIFFERENT SHAPES.
 *
 *   `refreshPlaces` is the admin button. It calls a courier, so it can fail,
 *   and it says how: a `LogisticsError` the routes already know how to
 *   classify, or a `places_unsupported` refusal for a courier that publishes
 *   nothing.
 *
 *   `publicPlaces` is what a storefront fetches, and IT MUST NOT FAIL. An empty
 *   cache is an empty list, a missing settings row is `manual`, and a country
 *   nobody has refreshed is an empty list too. A shop with a courier switched
 *   on and no refresh run yet still has to be able to take an order — the
 *   storefront falls back to free text, which is exactly what it does today.
 *
 * FOLLOWS `repo.ts` TO THE LETTER: plain `sql` templates over hand-written DDL,
 * NEVER `db.transaction` (the Neon HTTP driver throws on it unconditionally
 * while PGlite supports it), one guarded statement rather than
 * read-compare-write, and an explicit cast on every bind that can be NULL.
 */

/**
 * The country asked about when nobody says.
 *
 * MIRRORS `COUNTRY.default` IN `server/shop/settings/config.ts`, which is
 * `locked: true` with `allowed: ['NG']` — the address form offers no other, so
 * a refresh with no country is a refresh of the only one the shop can sell to.
 * Written down here rather than imported so this module stays a leaf of the
 * logistics subsystem; `places.test.ts` pins the two together.
 */
export const PLACES_DEFAULT_COUNTRY = 'NG';

/** ISO-3166 alpha-2, which is also `shop_logistics_places_country_ck`. */
const COUNTRY_SHAPE = /^[A-Za-z]{2}$/;

/**
 * Upper-case, or `null` for anything that is not two letters.
 *
 * NORMALISED RATHER THAN TRUSTED, in both directions: `ng` and `NG` must be one
 * cache row or a storefront's casing decides whether it gets a list, and a
 * value that would fail the column's own CHECK has to be turned away before the
 * INSERT rather than by a 500 out of Postgres.
 */
export function normaliseCountry(value: string | undefined | null): string | null {
  if (typeof value !== 'string' || !COUNTRY_SHAPE.test(value)) return null;
  return value.toUpperCase();
}

export interface CachedPlaces {
  provider: ProviderId;
  country: string;
  regions: PlaceRegion[];
  cities: Record<string, PlaceCity[]> | null;
  fetchedAt: number;
}

/** What the admin learns from pressing the button. */
export interface PlacesRefreshed {
  country: string;
  provider: ProviderId;
  /** How many regions the courier listed. */
  regions: number;
  /** Every city across every region — "how much did we just learn", not how
   *  many regions happen to have one. Zero for a courier with no city list. */
  cities: number;
  updatedAt: number;
}

/**
 * A COURIER WITHOUT THE CAPABILITY IS AN ANSWER, NOT A FAILURE — the same split
 * `service.ts` makes. The adapter is here and its credentials work; it simply
 * publishes no list, which is something the settings screen renders rather than
 * something that went wrong. `routes.ts` turns it into a 409 that names the
 * courier, never a 502 that invites a retry for a verdict that cannot change.
 */
export interface PlacesUnsupported {
  refused: 'places_unsupported';
  provider: ProviderId;
}

/**
 * jsonb arrives parsed from both drivers today. The string branch is the cheap
 * insurance a driver upgrade would otherwise turn into a run-time surprise —
 * the same defensive read `repo.ts` and frozen totals both needed.
 */
const asJson = <T>(value: unknown): T =>
  typeof value === 'string' ? (JSON.parse(value) as T) : (value as T);

// ---------------------------------------------------------------------- read

/** The cached row for one courier and country, or `null` when there is none. */
export async function readPlaces(
  db: Db,
  provider: ProviderId,
  country: string,
): Promise<CachedPlaces | null> {
  const code = normaliseCountry(country);
  if (code === null) return null;

  const res = await db.execute(sql`
    SELECT provider, country, regions, cities, fetched_at
      FROM shop_logistics_places
     WHERE provider = ${provider} AND country = ${code}`);
  const row = res.rows[0];
  if (row === undefined) return null;

  return {
    provider: String(row.provider) as ProviderId,
    country: String(row.country),
    regions: row.regions == null ? [] : asJson<PlaceRegion[]>(row.regions),
    cities: row.cities == null ? null : asJson<Record<string, PlaceCity[]>>(row.cities),
    fetchedAt: toEpochMs(row.fetched_at),
  };
}

/** Exactly what `GET /api/public/shop/delivery-places` answers. */
export interface PublicPlaces {
  country: string;
  /** The courier that is switched on. `manual` has no list, by definition. */
  provider: ProviderSetting;
  /** When the cache was last filled, or `null` when it never has been. */
  updatedAt: number | null;
  regions: PlaceRegion[];
  cities: Record<string, PlaceCity[]> | null;
}

/**
 * The place lists a storefront is served — THE READ THAT MAY NOT FAIL.
 *
 * `getLogisticsSettings` THROWS on a missing singleton, which is right for the
 * settings screen and wrong here: migration 0980 seeds that row and no route
 * deletes it, so its absence is a hand-run DELETE, and the answer to that must
 * not be a checkout nobody can finish. `manual` with an empty list is the same
 * answer a shop that has not chosen a courier gets, which is the honest one.
 *
 * The ACTIVE courier decides which row is read, so both couriers' lists can sit
 * in the cache at once and flipping the setting cannot leave a shopper picking
 * from a list the live courier has never heard of.
 */
export async function publicPlaces(db: Db, country: string): Promise<PublicPlaces> {
  const code = normaliseCountry(country) ?? PLACES_DEFAULT_COUNTRY;

  /*
   * `activeCourier` SWALLOWS ONLY `NotFoundError`, and that precision is the
   * point. The missing row is a shop with no courier configuration, which
   * `manual` describes exactly. A dropped connection or a syntax error is NOT
   * that, and catching it here would serve a confident empty list out of a
   * broken database while every monitor stayed green.
   */
  const provider = await activeCourier(db);

  const cached = provider === 'manual' ? null : await readPlaces(db, provider, code);
  return {
    country: code,
    provider,
    updatedAt: cached?.fetchedAt ?? null,
    regions: cached?.regions ?? [],
    cities: cached?.cities ?? null,
  };
}

// --------------------------------------------------------------------- write

/**
 * Ask the courier that is switched on, and write down what it said.
 *
 * THE ONE PLACE A COURIER'S PLACE LIST IS FETCHED, and it is never on a request
 * path — Terminal's list is one call plus one per region, 37 for Nigeria, so
 * this belongs behind an admin button and nowhere else (`port.ts`'s
 * `ProviderPlaces` carries the rule).
 *
 * WHAT COMES BACK, AND WHY EACH IS ITS OWN SHAPE:
 *
 *   a `PlacesRefreshed`            — the courier answered, one row is written
 *   a `PlacesUnsupported`          — the courier publishes no list at all
 *   throws `not_configured`        — the shop ships by hand, or this deployment
 *                                    has no credentials for that courier
 *   throws anything else the courier did, UNTOUCHED, so `routes.ts`'s
 *   `providerFailure` classifies a refused list exactly as it classifies a
 *   refused quote.
 *
 * NOTHING IS WRITTEN WHEN THE FETCH FAILS. A courier being briefly unreachable
 * must not blank a cache that was serving a storefront perfectly well a moment
 * ago — the write is the last thing this function does.
 */
export async function refreshPlaces(
  db: Db,
  deps: ResolvedLogisticsDeps,
  country: string,
): Promise<PlacesRefreshed | PlacesUnsupported> {
  /* The route's Zod already refuses this, so it is a precondition rather than a
     path — and a 400 naming the field is the honest answer to a caller that
     skipped it, not a 409 about a courier that has nothing to do with it. */
  const code = normaliseCountry(country);
  if (code === null) throw new BadRequestError('country');

  const settings = await getLogisticsSettings(db);
  if (settings.provider === 'manual') {
    throw new LogisticsError(
      'not_configured',
      'The shop ships by hand, so there is no courier to ask for a place list',
    );
  }

  const provider = settings.provider;
  const adapter = deps.providerFor(provider);
  if (!adapter) {
    throw new LogisticsError('not_configured', `${provider} has no credentials in this deployment`);
  }
  if (!adapter.places) return { refused: 'places_unsupported', provider };

  const list = await adapter.places.list(code);
  const now = deps.now();
  await writePlaces(db, provider, code, list.regions, list.cities, now);

  return {
    country: code,
    provider,
    regions: list.regions.length,
    cities:
      list.cities === null
        ? 0
        : Object.values(list.cities).reduce((total, entries) => total + entries.length, 0),
    updatedAt: now,
  };
}

/**
 * The upsert. ONE STATEMENT AND NO TRANSACTION, as everywhere else here.
 *
 * `ON CONFLICT … DO UPDATE` rather than DELETE-then-INSERT: a refresh must
 * REPLACE the row, and a two-statement version leaves a window in which a
 * storefront reading the cache finds nothing at all and falls back to free text
 * for no reason.
 *
 * `cities` IS CAST EXPLICITLY because it is a bind that can be NULL, which
 * Postgres otherwise refuses to type (`42P18`) — the same rule every NULL bind
 * in `repo.ts` follows.
 */
async function writePlaces(
  db: Db,
  provider: ProviderId,
  country: string,
  regions: PlaceRegion[],
  cities: Record<string, PlaceCity[]> | null,
  now: number,
): Promise<void> {
  const regionsJson = JSON.stringify(regions);
  const citiesJson = cities === null ? null : JSON.stringify(cities);

  await db.execute(sql`
    INSERT INTO shop_logistics_places (provider, country, regions, cities, fetched_at)
    VALUES (${provider}, ${country}, ${regionsJson}::jsonb, ${citiesJson}::jsonb, ${now})
    ON CONFLICT (provider, country) DO UPDATE
       SET regions = EXCLUDED.regions,
           cities = EXCLUDED.cities,
           fetched_at = EXCLUDED.fetched_at`);
}

import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { toEpochMs } from '../../db/client';
import type { ResolvedLogisticsDeps } from './deps';
import { LogisticsError } from './port';
import type { ExportDestination, ExportWeight, ProviderId } from './port';
import { getLogisticsSettings } from './repo';

/**
 * WHERE THE COURIER WILL CARRY TO OUTSIDE NIGERIA — fetched on a button, cached
 * in `shop_logistics_exports` (migration 1080), and read from the cache and
 * never from the courier.
 *
 * THE SAME SHAPE AS `places.ts` AND FOR THE SAME REASON. The country list is
 * read by `GET /api/public/shop/delivery-config`, which every storefront page
 * load hits and which is served `Cache-Control: public`. A courier call in
 * there would put a third party's uptime in front of the shop's own checkout
 * form. An admin asks; every reader after that is one SELECT.
 *
 * TWO ENTRY POINTS, DELIBERATELY DIFFERENT SHAPES — again as `places.ts`:
 *
 *   `refreshExports` is the admin button. It calls a courier, so it can fail,
 *   and it says how — a `LogisticsError` the routes already classify, or an
 *   `exports_unsupported` refusal for a courier with no international arm.
 *
 *   `exportCountries` / `readExports` are what a checkout and a storefront
 *   read, and THEY MUST NOT FAIL. An empty answer means "we know of nowhere
 *   abroad", which the caller reads as "do not offer any", and a courier
 *   having a bad afternoon must never be able to close the shop.
 */

export interface CachedExports {
  provider: ProviderId;
  destinations: ExportDestination[];
  weights: ExportWeight[];
  fetchedAt: number;
}

const asJson = <T>(value: unknown): T =>
  typeof value === 'string' ? (JSON.parse(value) as T) : (value as T);

// ---------------------------------------------------------------------- read

/** The cached catalogue for one courier, or `null` when it has never been fetched. */
export async function readExports(db: Db, provider: ProviderId): Promise<CachedExports | null> {
  const res = await db.execute(sql`
    SELECT provider, destinations, weights, fetched_at
      FROM shop_logistics_exports
     WHERE provider = ${provider}`);
  const row = res.rows[0];
  if (row === undefined) return null;
  return {
    provider: String(row.provider) as ProviderId,
    destinations: row.destinations == null ? [] : asJson<ExportDestination[]>(row.destinations),
    weights: row.weights == null ? [] : asJson<ExportWeight[]>(row.weights),
    fetchedAt: toEpochMs(row.fetched_at),
  };
}

/**
 * Every country the ACTIVE courier can carry to, as ISO codes — or `null` for
 * "no opinion", which is what every caller must read as "do not narrow anything".
 *
 * `null` AND `[]` ARE OPPOSITE ANSWERS AND THE DIFFERENCE IS THE WHOLE SHOP.
 * `null` means nobody has asked the courier yet, so the owner's own list stands
 * unchanged — which is what makes this feature additive, and what stops a
 * deployment that has never pressed refresh from silently losing every country
 * it used to sell to. `[]` means the courier was asked and carries nowhere
 * abroad, and the list narrows to Nigeria alone.
 *
 * NEVER THROWS. It is on the path of a page load.
 */
export async function exportCountries(
  db: Db,
  provider: ProviderId | 'manual',
): Promise<string[] | null> {
  /* Shipping by hand means the owner's list IS the answer; there is no courier
     whose reach could narrow it. */
  if (provider === 'manual') return null;
  try {
    const cached = await readExports(db, provider);
    if (cached === null) return null;
    return [...new Set(cached.destinations.flatMap((d) => d.countryCodes))];
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------- write

async function writeExports(
  db: Db,
  provider: ProviderId,
  destinations: ExportDestination[],
  weights: ExportWeight[],
  now: number,
): Promise<void> {
  /* ON CONFLICT rather than delete-then-insert, and never `db.transaction` —
     the Neon HTTP driver throws on it unconditionally while PGlite supports
     it, so a transaction passes every test here and 500s in production. */
  await db.execute(sql`
    INSERT INTO shop_logistics_exports (provider, destinations, weights, fetched_at)
    VALUES (${provider}, ${JSON.stringify(destinations)}::jsonb, ${JSON.stringify(weights)}::jsonb, ${now})
    ON CONFLICT (provider) DO UPDATE
       SET destinations = EXCLUDED.destinations,
           weights      = EXCLUDED.weights,
           fetched_at   = EXCLUDED.fetched_at`);
}

export interface ExportsRefreshed {
  provider: ProviderId;
  destinations: number;
  weights: number;
  /** Names the courier published that no ISO code was found for. They are
   *  cached, and offered to nobody — surfaced so an operator can report them
   *  rather than wonder why a country never appears. */
  unmapped: string[];
  /** The heaviest ceiling any bracket publishes, or `null` when none does. The
   *  single number that decides whether international is a real channel. */
  maxKg: number | null;
  updatedAt: number;
}

export interface ExportsUnsupported {
  refused: 'exports_unsupported';
  provider: ProviderId;
}

/**
 * Ask the active courier where it exports to, and cache the answer.
 *
 * NOTHING IS WRITTEN WHEN THE FETCH FAILS — the write is the last thing this
 * does. A courier briefly unreachable must not blank a cache that was serving
 * a storefront perfectly well a moment ago.
 */
export async function refreshExports(
  db: Db,
  deps: ResolvedLogisticsDeps,
): Promise<ExportsRefreshed | ExportsUnsupported> {
  const settings = await getLogisticsSettings(db);
  if (settings.provider === 'manual') {
    throw new LogisticsError(
      'not_configured',
      'The shop ships by hand, so there is no courier to ask where it exports to',
    );
  }

  const provider = settings.provider;
  const adapter = deps.providerFor(provider);
  if (!adapter) {
    throw new LogisticsError('not_configured', `${provider} has no credentials in this deployment`);
  }
  if (!adapter.exports) return { refused: 'exports_unsupported', provider };

  const cat = await adapter.exports.catalogue();
  const now = deps.now();
  await writeExports(db, provider, cat.destinations, cat.weights, now);

  return {
    provider,
    destinations: cat.destinations.length,
    weights: cat.weights.length,
    unmapped: cat.destinations.filter((d) => d.countryCodes.length === 0).map((d) => d.place),
    maxKg: cat.weights.reduce<number | null>(
      (best, w) => (w.maxKg === null ? best : best === null || w.maxKg > best ? w.maxKg : best),
      null,
    ),
    updatedAt: now,
  };
}

// ------------------------------------------------------------------ matching

export type ExportMatch =
  | { ok: true; destination: ExportDestination; weight: ExportWeight }
  /**
   * WHY IT DID NOT MATCH, because the two reasons are different sentences to a
   * shopper and only one of them is worth acting on. "We do not go there" ends
   * the conversation; "that is too heavy" tells somebody to buy three instead
   * of five, which is a sale. Collapsing both into `null` would have thrown
   * away the only refusal a customer can do anything about.
   */
  | { ok: false; reason: 'not_carried' }
  | { ok: false; reason: 'too_heavy'; maxKg: number | null };

/**
 * The cheapest row that will carry `kg` to `countryCode`, or `null` when none
 * will — which is a REFUSAL and not a fallback, because a parcel the courier
 * publishes no bracket for is a parcel it has said it will not take.
 *
 * BOTH SIDES CARRY A CEILING AND BOTH ARE HONOURED. A destination row is a
 * country AND a bracket ("Ghana(0-2kg)"), and the weight list carries its own;
 * a row whose name published no bracket is bounded by the weight list alone,
 * and a weight list that publishes no ceiling bounds nothing. Reading only one
 * of the two would quote a 9 kg parcel against a 2 kg row.
 *
 * SMALLEST FITTING BRACKET, NOT THE FIRST. A courier that sells 0-2, 2-5 and
 * 5-10 lists them in whatever order it likes, and a 1 kg parcel bought against
 * the 5-10 row is money given away on every order.
 */
export function matchExport(
  cached: CachedExports,
  countryCode: string,
  kg: number,
): ExportMatch {
  const code = countryCode.trim().toUpperCase();
  const fits = (max: number | null): boolean => max === null || kg <= max;
  const byCeiling = <T extends { maxKg: number | null }>(a: T, b: T): number =>
    (a.maxKg ?? Infinity) - (b.maxKg ?? Infinity);

  const forCountry = cached.destinations.filter((d) => d.countryCodes.includes(code));
  if (forCountry.length === 0) return { ok: false, reason: 'not_carried' };

  /* The heaviest thing the courier publishes for this country, across BOTH
     lists — what the refusal has to quote at a shopper, and the only number
     that lets them decide to buy fewer. */
  const ceiling = (rows: readonly { maxKg: number | null }[]): number | null =>
    rows.some((r) => r.maxKg === null)
      ? null
      : rows.reduce<number | null>((best, r) => (best === null || (r.maxKg as number) > best ? r.maxKg : best), null);

  const destinations = forCountry.filter((d) => fits(d.maxKg)).sort(byCeiling);
  const weights = cached.weights.filter((w) => fits(w.maxKg)).sort(byCeiling);

  if (destinations.length === 0) {
    return { ok: false, reason: 'too_heavy', maxKg: ceiling(forCountry) };
  }
  if (cached.weights.length > 0 && weights.length === 0) {
    return { ok: false, reason: 'too_heavy', maxKg: ceiling(cached.weights) };
  }

  /* A courier publishing destinations but NO weight list at all is quoted
     against the destination alone. Refusing there would turn a thin catalogue
     into a closed shop. */
  const weight = weights[0] ?? cached.weights[0];
  if (weight === undefined) return { ok: false, reason: 'not_carried' };

  /* SMALLEST FITTING BRACKET, NOT THE FIRST. A courier selling 0-2, 2-5 and
     5-10 lists them in whatever order it likes, and a 1 kg parcel bought
     against the 5-10 row is money given away on every single order. */
  return { ok: true, destination: destinations[0], weight };
}

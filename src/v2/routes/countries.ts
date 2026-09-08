/**
 * The countries the "Where we ship" picker offers.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CODES ONLY — THE NAMES COME FROM THE BROWSER.
 *
 * `Intl.DisplayNames` turns 'GH' into 'Ghana' in the reader's own language, so
 * there is no hand-typed name table here to drift, misspell, or quietly
 * disagree with the storefront's. The fallback is the code itself, which is
 * ugly but never wrong — and this list is small enough that a missing
 * `Intl.DisplayNames` (very old browsers only) is inconvenient rather than
 * unusable.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * AFRICA PLUS THE UK AND THE US — the owner's answer (2026-09-08) to "which
 * countries do you want opened". It is not every ISO country, on purpose: a
 * picker offering 249 places is a picker where the fifty that matter are hard
 * to find, and adding one later is a line in this file rather than a migration.
 *
 * OFFERING A COUNTRY HERE DOES NOT PRICE IT. Every country without a shipping
 * zone of its own falls to the catch-all, seeded at the deliberately punitive
 * international rate so a forgotten price fails safe. The card says so beside
 * the picker, because "we now ship to Kenya" and "we ship to Kenya for a
 * sensible amount of money" are different sentences.
 */

/** ISO-3166-1 alpha-2, the 54 UN member states of Africa. */
const AFRICA = [
  'DZ', 'AO', 'BJ', 'BW', 'BF', 'BI', 'CV', 'CM', 'CF', 'TD',
  'KM', 'CG', 'CD', 'DJ', 'EG', 'GQ', 'ER', 'SZ', 'ET', 'GA',
  'GM', 'GH', 'GN', 'GW', 'CI', 'KE', 'LS', 'LR', 'LY', 'MG',
  'MW', 'ML', 'MR', 'MU', 'MA', 'MZ', 'NA', 'NE', 'NG', 'RW',
  'ST', 'SN', 'SC', 'SL', 'SO', 'ZA', 'SS', 'SD', 'TZ', 'TG',
  'TN', 'UG', 'ZM', 'ZW',
] as const;

/** Named separately because they are the two the owner asked for by name. */
const ELSEWHERE = ['GB', 'US'] as const;

export const SHIPPABLE_COUNTRIES: readonly string[] = [...AFRICA, ...ELSEWHERE];

/** The shop's home country. Sorted to the top of the picker, never removable. */
export const HOME_COUNTRY = 'NG';

let display: Intl.DisplayNames | null | undefined;

/**
 * 'GH' → 'Ghana'. The code itself when the browser cannot say.
 *
 * The lookup is built once and cached — `Intl.DisplayNames` is not free, and
 * this is called for every row of a fifty-six item list on every render.
 */
export function countryName(code: string): string {
  if (display === undefined) {
    try {
      display = new Intl.DisplayNames(undefined, { type: 'region' });
    } catch {
      display = null;
    }
  }
  try {
    return display?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** The picker's order: by name, in the reader's language, not by code. */
export function byName(a: string, b: string): number {
  return countryName(a).localeCompare(countryName(b));
}

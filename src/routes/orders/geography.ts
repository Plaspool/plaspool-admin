import type { OrderStatus, ShopOrderRow, ShopShippingZone } from '../../data/api-shop';

/**
 * WHERE THE PARCELS ARE GOING — the arithmetic behind the orders console's
 * destination panel, with no React, no fetch and no clock in it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BUG THIS MODULE EXISTS TO PREVENT, IN THE LIVE DATA TODAY.
 *
 * `__fixtures__/orders-live.json` is a verbatim capture of production. Five
 * orders, every one of them bound for the same city, and the `region` field
 * says two different things:
 *
 *     "region": "Abuja"                        × 4
 *     "region": "Federal Capital Territory"    × 1
 *
 * A `groupBy(order.shippingAddress.region)` renders that as TWO destinations.
 * The operator reads two rows, infers two delivery costs, and plans two runs —
 * for one place. The shop's own zone table already treats those two strings as
 * the same zone (migration 0240 seeds `regions = {Abuja, FCT, Federal Capital
 * Territory}` on `zone_abuja`), so the screen would be contradicting the price
 * the customer was actually charged.
 *
 * So: collapse them. But collapsing is a REWRITE OF THE OPERATOR'S DATA, and a
 * panel that rewrites silently is worse than one that shows both — it destroys
 * the evidence that the checkout form is letting two spellings through in the
 * first place. Every collapse here is therefore reported alongside its result
 * (`BreakdownGroup.collapsed`, `GeographyBreakdown.collapses`), and every guess
 * is labelled as a guess (`NormalisedRegion.confident`, `matchedOn`).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️  THIS NORMALISATION IS FOR DISPLAY AND GROUPING. IT IS NOT PRICING.
 *
 * The server does not consult this file and must not be made to. Pricing goes
 * through `zoneFor` (`server/shop/cart/checkout/shipping.ts`), which compares
 * the customer's RAW region string, case- and whitespace-insensitively and
 * NOTHING MORE, against each zone's `regions` array. Three strings reach the
 * Abuja zone: `abuja`, `fct`, `federal capital territory`. `F.C.T.` does not.
 * `Abuja FCT` does not. `Ikeja` does not reach the Lagos zone.
 *
 * This module deliberately recognises MORE than that — punctuation, ordering,
 * a `city` that names a state when the `region` box holds junk — because the
 * question a panel answers ("how many parcels go to Abuja") is a different
 * question from the one a checkout answers ("what do we charge this address").
 * Being cleverer than the server about DISPLAY is right. Being cleverer than
 * the server about MONEY would be a lie: the panel would show ₦3,000 next to
 * an order the customer was charged ₦10,000 for.
 *
 * The divergence is therefore not hidden, it is REPORTED. `deliveryZoneOf`
 * returns both readings — `zone` (this module's, for the destination column)
 * and `serverZone` (what `zoneFor` would actually have quoted from the raw
 * string) — plus `agrees`. `GeographyBreakdown.delivery.disagreements` counts
 * the orders where they differ, which is the number that says "the zone table's
 * alias list needs another entry", and is actionable in the admin's own
 * shipping-zones screen without a deploy.
 *
 * ⚠️  AND EVERY ONE OF THOSE SENTENCES IS TRUE ONLY OF A TABLE THIS MODULE WAS
 *     HANDED. It used to default to a compile-time transcription of migration
 *     0240's seed, which is the shape of the bug it claims to prevent: the
 *     operator adds a Port Harcourt zone at ₦5,000 for `Rivers`, the server
 *     charges ₦5,000, and the panel prints ₦10,000 next to that order and
 *     reports `agrees: true`. There is now no default. Without a table
 *     (`BreakdownOptions.zones`, built with `deliveryZoneTableFrom`), the
 *     output carries `delivery: { known: false }` and says nothing about rates,
 *     server zones or agreement at all — while normalisation, the collapse,
 *     the counts and the frozen money keep working, because those are facts
 *     about the rows rather than readings of a price list.
 *
 * And the money already charged is never inferred at all: `CurrencyTotal.
 * shippingTotal` is the sum of each order's own FROZEN `shippingTotal`, copied
 * and never recomputed (CLAUDE.md §6 — "Frozen totals are copied, never
 * recomputed"). The zone rate sitting beside it is a statement about the table
 * as it stands today, not about what anyone paid.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PURE AND TOTAL. Nothing here reads a clock (`now` is an argument, as
 * `server/shop/admin/stats.ts` takes it), nothing fetches, and nothing throws:
 * `shippingAddress` is typed `Record<string, unknown>` in `src/data/api-shop.ts`
 * because it is UNVALIDATED JSON a customer typed into a checkout form, and a
 * destination panel that takes the whole orders route to its error boundary
 * because somebody's `region` came back as a number is a worse outcome than a
 * row that reads "region not recognised". Every field is read through a
 * coercion that has a defined answer for `undefined`, `null`, the wrong type,
 * an empty string and a hostile key such as `__proto__`.
 */

// ───────────────────────────────────────────────────────────── hostile input

/**
 * A plain object, or `null`. Arrays are refused deliberately: `["Lagos"]` in a
 * `region` slot is malformed input, and treating index `0` as a field would be
 * this module inventing a shape the checkout form never sends.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * One own property, by name.
 *
 * `Object.prototype.hasOwnProperty.call` rather than `key in obj` or a bare
 * read, because a JSON payload may legally contain `"__proto__"` and
 * `"constructor"`, and a bare `addr.constructor` answers with a function on
 * every object in the language. Reading a *function* where a region string was
 * expected is not a crash, but it is a row that silently claims a destination
 * nobody typed.
 */
function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/** A trimmed non-empty string, or `null`. Anything not a `string` is `null`. */
function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** One money field, read, plus whether the read had to refuse it. */
interface MoneyRead {
  /** Minor units to add. `0` for anything this refused. */
  value: number;
  /**
   * The field held something that is not a count of minor units. Counted into
   * `GeographyBreakdown.unusableMoneyFields` so the zero is never silent.
   */
  unusable: boolean;
}

/**
 * A count of minor units, or `0` — AND WHETHER THE `0` WAS A REFUSAL.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `Number.isSafeInteger`, NOT `Number.isFinite` PLUS `Math.trunc`, AND THAT IS
 * THE WHOLE POINT OF THIS FUNCTION CHANGING SHAPE.
 *
 * Money on this surface is minor units and always an integer, so a fractional
 * total is corrupt rather than merely surprising — which is exactly what the
 * comment here has always said. The code did not agree with it: `Math.trunc`
 * turned `2.7` into `2` and reported nothing, so a corrupt value became a
 * plausible one and the evidence that it was ever wrong was gone. Truncation
 * is a REWRITE OF THE OPERATOR'S MONEY, and this module's founding rule (see
 * the header) is that a rewrite is reported alongside its result or it is not
 * performed. `Number.isSafeInteger` also catches the other end — `2 ** 53 + 1`
 * is finite, is an "integer", and does not survive addition — where
 * `Number.isFinite` waves it through.
 *
 * REFUSAL IS `0` AND THE ROW STAYS COUNTED. Dropping the row would make the
 * panel's order count disagree with the list the operator is looking at, which
 * is a worse lie than a total that is short by one corrupt order and says so.
 *
 * AN ABSENT FIELD IS NOT A CORRUPT ONE. `undefined` and `null` read as `0`
 * with `unusable: false`: a row that never carried a `refundedTotal` is a row
 * with no refunds, not a row with a broken one, and counting it as corruption
 * would bury the real thing under the ordinary shape of the data.
 * ═══════════════════════════════════════════════════════════════════════════
 */
function minor(value: unknown): MoneyRead {
  if (value === undefined || value === null) return { value: 0, unusable: false };
  if (typeof value === 'number' && Number.isSafeInteger(value)) return { value, unusable: false };
  return { value: 0, unusable: true };
}

/** A finite epoch-ms number, or `null`. */
function epoch(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ────────────────────────────────────────────────────────── text normalising

/**
 * U+0300–U+036F, the Unicode combining diacritical marks block.
 *
 * BUILT WITH `String.fromCharCode` RATHER THAN WRITTEN AS A REGEX LITERAL, and
 * that is not decoration. A literal here has to be either raw combining
 * characters — which are invisible in every editor, attach themselves to the
 * bracket in front of them, and do not survive a tool that rewrites this file
 * in the wrong encoding — or `\u` escapes, which survive but read as noise.
 * Two numbers and a name say what the range IS, and neither can be corrupted
 * by anything that touches the bytes of this file.
 */
const COMBINING_MARKS = new RegExp(
  `[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`,
  'g',
);

/**
 * The comparison key for one piece of address text.
 *
 * `zoneFor`'s own rule is `trim().toLowerCase()` and that is the FLOOR this
 * must clear, never contradict: anything the server considers equal, this must
 * also consider equal. It goes further in exactly three ways, each of which is
 * a spelling of the SAME name rather than a different name:
 *
 *   - diacritics are folded (`Ọ̀yọ́` → `oyo`), via NFKD plus a combining-mark
 *     strip, because the address form accepts them and the zone table does not
 *     carry them;
 *   - full stops and apostrophes are DELETED rather than spaced, so `F.C.T.`
 *     becomes `fct` and not `f c t`;
 *   - every other non-alphanumeric run becomes a single space, so `Cross-River`,
 *     `Cross  River` and `Cross,River` all become `cross river`.
 *
 * Note what is NOT done: no stemming, no edit distance, no "did you mean".
 * Fuzzy matching on a field that decides where a parcel goes turns a typo into
 * a confident wrong answer, and there is no evidence on the screen afterwards
 * to say which rows were guessed. Unrecognised is a first-class result here.
 */
function fold(text: string): string {
  return text
    .normalize('NFKD')
    // Deletes the combining marks NFKD has just separated out, so a
    // diacritic-bearing spelling folds to one word: the `[^a-z0-9]+` pass below
    // would turn each mark into a SPACE, splitting the name in two.
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    // Both curly quotes are in the class alongside the straight one because a
    // phone keyboard produces U+2019 by default, so `N'Djamena` and `N’Djamena`
    // are the same word to everybody except a byte comparison.
    .replace(/['‘’`.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * `fold`, plus the one suffix Nigerian address forms add for free.
 *
 * "Lagos State", "Rivers State" and "Ogun state" are how a great many people
 * write the state's name; no Nigerian subdivision is actually *called*
 * "… State", so the word carries no information and dropping it cannot merge
 * two real places. Guarded so a region field containing literally "State"
 * folds to nothing rather than to the empty string masquerading as a match.
 */
function lookupKey(text: string): string {
  const folded = fold(text);
  const stripped = folded.replace(/\s+state$/, '');
  return stripped === '' ? folded : stripped;
}

// ────────────────────────────────────────────────────── the canonical table

/**
 * ISO 3166-2:NG subdivision codes — 36 states plus the Federal Capital
 * Territory. Used as the grouping key rather than a display string, so that
 * renaming a label on screen cannot silently re-partition the panel.
 */
export type NgRegionCode =
  | 'NG-AB' | 'NG-AD' | 'NG-AK' | 'NG-AN' | 'NG-BA' | 'NG-BY' | 'NG-BE'
  | 'NG-BO' | 'NG-CR' | 'NG-DE' | 'NG-EB' | 'NG-ED' | 'NG-EK' | 'NG-EN'
  | 'NG-FC' | 'NG-GO' | 'NG-IM' | 'NG-JI' | 'NG-KD' | 'NG-KN' | 'NG-KT'
  | 'NG-KE' | 'NG-KO' | 'NG-KW' | 'NG-LA' | 'NG-NA' | 'NG-NI' | 'NG-OG'
  | 'NG-ON' | 'NG-OS' | 'NG-OY' | 'NG-PL' | 'NG-RI' | 'NG-SO' | 'NG-TA'
  | 'NG-YO' | 'NG-ZA';

export interface NgRegion {
  code: NgRegionCode;
  /** The name this module prints. */
  name: string;
  /**
   * Other spellings of the SAME NAME. A match here is `confident` — the
   * customer named the state, they just punctuated it their own way.
   */
  aliases: readonly string[];
  /**
   * Cities, LGAs and districts that sit inside this state and that people
   * routinely type into a state box. A match here is a GUESS — the customer
   * named a place, not the state — so it never sets `confident`.
   */
  cities: readonly string[];
}

/**
 * THE CANONICAL LIST, WHERE IT CAME FROM, AND WHAT IT DOES NOT KNOW.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PROVENANCE.
 *
 *  - The 37 rows and their codes are ISO 3166-2:NG — Nigeria's 36 states plus
 *    the FCT. That standard is the reason `code` and not `name` is the
 *    grouping key: it is stable, externally defined, and nobody on this team
 *    gets to invent an entry.
 *  - `aliases` and `cities` are HAND-WRITTEN and are not from any standard.
 *    They cover the spellings this shop's own data and the shop's own zone
 *    table already contain (`Abuja` / `FCT` / `Federal Capital Territory` are
 *    lifted straight from migration 0240's seed), plus the everyday short
 *    forms — `Cross-River`, `AkwaIbom`, `Nassarawa`, `Port Harcourt`, `Ikeja`.
 *
 * WHAT IT DOES NOT KNOW, STATED SO NOBODY HAS TO DISCOVER IT.
 *
 *  - It is NOT an exhaustive gazetteer. Nigeria has 774 LGAs and thousands of
 *    named towns; `cities` holds roughly one to four per state, chosen for
 *    being unambiguous within this list and commonly mistyped into a state
 *    box. A town that is not here is `region-unknown`, which is the correct
 *    answer — a panel that says "not recognised" is repairable, one that
 *    guesses is not.
 *  - Ambiguous names are DELIBERATELY ABSENT. `Benin` (Edo's capital, and also
 *    a neighbouring country) appears only as `benin city`. `Niger` is a state
 *    here *and* a country; it is matched, and that is a known gap — see
 *    `normaliseRegion`'s country guard, which is what keeps it from firing on
 *    an address that says `countryCode: "NE"`. `Karu` and `Dutse` name places
 *    in two different states each and are in neither list.
 *  - THERE IS NO POSTCODE LOGIC AND THERE MUST NOT BE. Nigerian postcodes are
 *    not reliably captured: in the live fixture four of five addresses carry
 *    `"postalCode": null`, and the fifth carries `"90010"`. A rule built on a
 *    field that is absent 80% of the time is a rule that fires on 20% of rows
 *    and looks authoritative doing it.
 *  - It has no opinion about anywhere outside Nigeria. See `normaliseRegion`.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const NG_REGIONS: readonly NgRegion[] = [
  { code: 'NG-AB', name: 'Abia', aliases: [], cities: ['aba', 'umuahia'] },
  { code: 'NG-AD', name: 'Adamawa', aliases: [], cities: ['yola'] },
  { code: 'NG-AK', name: 'Akwa Ibom', aliases: ['akwaibom'], cities: ['uyo'] },
  { code: 'NG-AN', name: 'Anambra', aliases: [], cities: ['awka', 'onitsha', 'nnewi'] },
  { code: 'NG-BA', name: 'Bauchi', aliases: [], cities: [] },
  { code: 'NG-BY', name: 'Bayelsa', aliases: [], cities: ['yenagoa'] },
  { code: 'NG-BE', name: 'Benue', aliases: [], cities: ['makurdi'] },
  { code: 'NG-BO', name: 'Borno', aliases: ['bornu'], cities: ['maiduguri'] },
  { code: 'NG-CR', name: 'Cross River', aliases: ['crossriver'], cities: ['calabar'] },
  { code: 'NG-DE', name: 'Delta', aliases: [], cities: ['asaba', 'warri'] },
  { code: 'NG-EB', name: 'Ebonyi', aliases: [], cities: ['abakaliki'] },
  { code: 'NG-ED', name: 'Edo', aliases: [], cities: ['benin city'] },
  { code: 'NG-EK', name: 'Ekiti', aliases: [], cities: ['ado ekiti'] },
  { code: 'NG-EN', name: 'Enugu', aliases: [], cities: ['nsukka'] },
  {
    code: 'NG-FC',
    name: 'Federal Capital Territory',
    /*
     * `abuja`, `fct` and `federal capital territory` are not this module's
     * invention — they are the three strings migration 0240 seeds into
     * `zone_abuja.regions`, so all three are exactly what the server already
     * prices as Abuja. The rest (`f.c.t.` → `fct` by folding, `Abuja FCT`,
     * `FCT Abuja`) are spellings the seeded table does NOT know and this
     * module does: recognised for the panel, and counted in
     * `delivery.disagreements` — against the LIVE table, so adding the missing
     * spelling in the shipping-zones screen actually makes the number fall.
     */
    aliases: [
      'fct',
      'abuja',
      'abuja fct',
      'fct abuja',
      'abuja federal capital territory',
      'federal capital territory abuja',
      'federal capital teritory',
    ],
    cities: [
      'gwagwalada', 'kuje', 'bwari', 'kwali', 'abaji', 'garki', 'wuse',
      'maitama', 'asokoro', 'gwarinpa', 'kubwa', 'lugbe', 'jabi', 'utako',
    ],
  },
  { code: 'NG-GO', name: 'Gombe', aliases: [], cities: [] },
  { code: 'NG-IM', name: 'Imo', aliases: [], cities: ['owerri'] },
  { code: 'NG-JI', name: 'Jigawa', aliases: [], cities: [] },
  { code: 'NG-KD', name: 'Kaduna', aliases: [], cities: ['zaria', 'kafanchan'] },
  { code: 'NG-KN', name: 'Kano', aliases: [], cities: [] },
  { code: 'NG-KT', name: 'Katsina', aliases: [], cities: [] },
  { code: 'NG-KE', name: 'Kebbi', aliases: [], cities: ['birnin kebbi'] },
  { code: 'NG-KO', name: 'Kogi', aliases: [], cities: ['lokoja'] },
  { code: 'NG-KW', name: 'Kwara', aliases: [], cities: ['ilorin'] },
  {
    code: 'NG-LA',
    name: 'Lagos',
    aliases: [],
    cities: [
      'ikeja', 'lekki', 'victoria island', 'ikoyi', 'yaba', 'surulere',
      'ikorodu', 'badagry', 'epe', 'ajah', 'apapa', 'oshodi', 'agege', 'festac',
    ],
  },
  { code: 'NG-NA', name: 'Nasarawa', aliases: ['nassarawa'], cities: ['lafia', 'keffi'] },
  { code: 'NG-NI', name: 'Niger', aliases: [], cities: ['minna', 'suleja'] },
  { code: 'NG-OG', name: 'Ogun', aliases: [], cities: ['abeokuta', 'sagamu', 'ijebu ode'] },
  { code: 'NG-ON', name: 'Ondo', aliases: [], cities: ['akure', 'ondo city'] },
  { code: 'NG-OS', name: 'Osun', aliases: ['oshun'], cities: ['osogbo', 'oshogbo', 'ile ife', 'ilesa'] },
  { code: 'NG-OY', name: 'Oyo', aliases: [], cities: ['ibadan', 'ogbomoso'] },
  { code: 'NG-PL', name: 'Plateau', aliases: [], cities: ['jos'] },
  {
    code: 'NG-RI',
    name: 'Rivers',
    aliases: [],
    cities: ['port harcourt', 'portharcourt', 'obio akpor'],
  },
  { code: 'NG-SO', name: 'Sokoto', aliases: [], cities: [] },
  { code: 'NG-TA', name: 'Taraba', aliases: [], cities: ['jalingo'] },
  { code: 'NG-YO', name: 'Yobe', aliases: [], cities: ['damaturu'] },
  { code: 'NG-ZA', name: 'Zamfara', aliases: [], cities: ['gusau'] },
];

/**
 * Two alias entries claiming the same key would mean one state silently
 * shadowing another depending on table order — the exact class of bug a
 * hand-written list invites.
 *
 * Rather than trust review, the index records every collision it finds and
 * exports it, so `geography.test.ts` can assert the list is empty. A future
 * entry that collides fails a test instead of quietly re-routing parcels.
 */
export interface AliasCollision {
  key: string;
  kept: NgRegionCode;
  dropped: NgRegionCode;
  kind: 'name' | 'city';
}

const NAME_INDEX = new Map<string, NgRegionCode>();
const CITY_INDEX = new Map<string, NgRegionCode>();
const collisions: AliasCollision[] = [];

for (const region of NG_REGIONS) {
  for (const spelling of [region.name, ...region.aliases]) {
    const key = lookupKey(spelling);
    const existing = NAME_INDEX.get(key);
    if (existing !== undefined && existing !== region.code) {
      collisions.push({ key, kept: existing, dropped: region.code, kind: 'name' });
      continue;
    }
    NAME_INDEX.set(key, region.code);
  }
}
for (const region of NG_REGIONS) {
  for (const city of region.cities) {
    const key = lookupKey(city);
    // A city key that is also a state name is not a collision to report, it is
    // a precedence question, and the state name wins — `Kano` the state is the
    // answer somebody typing `Kano` wants, whichever field they typed it in.
    if (NAME_INDEX.has(key)) continue;
    const existing = CITY_INDEX.get(key);
    if (existing !== undefined && existing !== region.code) {
      collisions.push({ key, kept: existing, dropped: region.code, kind: 'city' });
      continue;
    }
    CITY_INDEX.set(key, region.code);
  }
}

/** Empty on a healthy table. Asserted by the suite. */
export const ALIAS_COLLISIONS: readonly AliasCollision[] = collisions;

const REGION_BY_CODE = new Map<NgRegionCode, NgRegion>(NG_REGIONS.map((r) => [r.code, r]));

/** The canonical row for a code, or `null`. */
export function regionByCode(code: NgRegionCode | null): NgRegion | null {
  return code === null ? null : (REGION_BY_CODE.get(code) ?? null);
}

// ─────────────────────────────────────────────────────────────── normalising

/** Which field, and which kind of evidence, produced a match. */
export type RegionMatch =
  /** `region` held the canonical name or a spelling of it. Not a guess. */
  | 'region-name'
  /** `region` held a city/LGA inside exactly one state. A guess. */
  | 'region-city'
  /** `region` was unusable; `city` named a state or a town in one. A guess. */
  | 'city-field'
  /** Nothing was recognised. */
  | 'none';

/** Why a region could not be resolved. Never collapsed into one bucket. */
export type UnrecognisedReason =
  /** `shippingAddress` was absent, `null`, an array, or not an object. */
  | 'no-address'
  /** No `region` key at all, or it was `null`. */
  | 'no-region'
  /** `region` was present but not a `string`. */
  | 'region-not-a-string'
  /** `region` was a string of nothing but whitespace. */
  | 'region-blank'
  /** A real string this table does not know, and no usable `city` either. */
  | 'region-unknown'
  /** `countryCode` names somewhere that is not Nigeria. */
  | 'non-nigerian';

export interface NormalisedRegion {
  /** ISO 3166-2:NG code, or `null` when nothing was recognised. */
  code: NgRegionCode | null;
  /**
   * What to print. The canonical name when recognised; otherwise the
   * operator's own text, VERBATIM apart from trimming, because their data is
   * the only honest thing left to show. `NO_REGION_LABEL` when there is none.
   */
  label: string;
  /** Exactly what `region` held, trimmed. `null` when absent/blank/wrong type. */
  raw: string | null;
  /** Exactly what `city` held, trimmed. Carried as evidence, matched or not. */
  rawCity: string | null;
  /** `countryCode`, uppercased and trimmed. `null` when absent or unusable. */
  countryCode: string | null;
  /**
   * The address NAMED this region, rather than this module inferring it.
   * `false` for every city-derived match — the customer told us a town, and
   * the state is our inference about it, which the panel must be able to say.
   */
  confident: boolean;
  matchedOn: RegionMatch;
  /** `null` exactly when `code` is non-null. */
  reason: UnrecognisedReason | null;
}

/** Printed where a group has no region text of its own to show. */
export const NO_REGION_LABEL = 'No region given';

/**
 * The one country this module has a table for.
 *
 * A `countryCode` that is present and is not this is a hard stop: the address
 * is not forced into a Nigerian state, however Nigerian its region text looks.
 * `"region": "Delta"` under `"countryCode": "US"` is a Delta somewhere else,
 * and `"region": "Niger"` under `"countryCode": "NE"` is the Republic of Niger
 * — an FCT row on the panel for either of those is worse than an honest
 * "not recognised", because it puts a parcel on the wrong continent's list.
 *
 * An ABSENT country is treated as Nigeria, and that is a different decision
 * with a different justification: this shop's catalogue, currency and every
 * zone in its table are Nigerian, so "unstated" is far likelier to be a form
 * that did not send the field than a silent international order. The
 * assumption is recorded — `countryCode` comes back `null` — so a panel can
 * show it, and it never upgrades confidence on its own.
 */
export const HOME_COUNTRY = 'NG';

/**
 * A raw `shippingAddress` in, a canonical region plus its evidence out.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FOUR PASSES, IN THIS ORDER, AND THE ORDER IS THE WHOLE POLICY.
 *
 *   0. Country guard. Not Nigeria → stop. See `HOME_COUNTRY`.
 *   1. `region` against state names and their spellings. Match ⇒ confident.
 *   2. `region` against the city list — the "somebody typed Port Harcourt in
 *      the state box" case. Match ⇒ NOT confident.
 *   3. `city` against state names first, then the city list, but ONLY when
 *      `region` produced nothing. Match ⇒ NOT confident.
 *
 * Pass 3 is last and conditional for a reason: `region` is the field the shop
 * prices on, so a `region` that resolves must never be overridden by a `city`
 * that disagrees. `{ region: "Ogun", city: "Ikeja" }` is Ogun here, not Lagos,
 * and that is also what the customer was charged.
 *
 * `region` AND NOTHING ELSE IS READ AS THE REGION. Not `state`, not
 * `province`, not `administrativeArea`. The checkout form sends `region`
 * (`__fixtures__/orders-live.json`), and a reader that quietly accepts three
 * other spellings of the key would make the day the form starts sending
 * `state` invisible — the panel would keep working and nothing else would.
 * An unknown key surfaces here as `no-region`, which is a question somebody
 * asks, and CLAUDE.md §2's whole lesson is that silence is how this codebase
 * ships bugs.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function normaliseRegion(address: unknown): NormalisedRegion {
  const addr = asRecord(address);
  if (addr === null) {
    return {
      code: null,
      label: NO_REGION_LABEL,
      raw: null,
      rawCity: null,
      countryCode: null,
      confident: false,
      matchedOn: 'none',
      reason: 'no-address',
    };
  }

  const rawRegionValue = own(addr, 'region');
  const raw = str(rawRegionValue);
  const rawCity = str(own(addr, 'city'));
  const countryRaw = str(own(addr, 'countryCode'));
  const countryCode = countryRaw === null ? null : countryRaw.toUpperCase();

  const missReason: UnrecognisedReason =
    rawRegionValue === undefined || rawRegionValue === null
      ? 'no-region'
      : typeof rawRegionValue !== 'string'
        ? 'region-not-a-string'
        : raw === null
          ? 'region-blank'
          : 'region-unknown';

  const base = { raw, rawCity, countryCode };
  const unresolved = (reason: UnrecognisedReason): NormalisedRegion => ({
    ...base,
    code: null,
    label: raw ?? NO_REGION_LABEL,
    confident: false,
    matchedOn: 'none',
    reason,
  });

  // 0. Not Nigeria: refuse to map, and say which of the two refusals this is.
  if (countryCode !== null && countryCode !== HOME_COUNTRY) return unresolved('non-nigerian');

  const resolved = (code: NgRegionCode, matchedOn: RegionMatch): NormalisedRegion => ({
    ...base,
    code,
    label: REGION_BY_CODE.get(code)?.name ?? code,
    confident: matchedOn === 'region-name',
    matchedOn,
    reason: null,
  });

  if (raw !== null) {
    const key = lookupKey(raw);
    // 1. The region box names the state.
    const byName = NAME_INDEX.get(key);
    if (byName !== undefined) return resolved(byName, 'region-name');
    // 2. The region box names a town inside exactly one state.
    const byCity = CITY_INDEX.get(key);
    if (byCity !== undefined) return resolved(byCity, 'region-city');
  }

  // 3. The region box is unusable; the city box may still name somewhere.
  if (rawCity !== null) {
    const key = lookupKey(rawCity);
    const fromCity = NAME_INDEX.get(key) ?? CITY_INDEX.get(key);
    if (fromCity !== undefined) return resolved(fromCity, 'city-field');
  }

  return unresolved(missReason);
}

// ──────────────────────────────────────────────────────────── delivery zones

/**
 * A zone's primary key, exactly as `shop_shipping_zones.id` holds it.
 *
 * ⚠️  A BARE `string`, AND THAT IS A CORRECTION RATHER THAN LAZINESS.
 *
 * This was a closed union — `'abuja' | 'lagos' | 'rest-of-nigeria'` — copied
 * from `DEFAULT_SHIPPING_ZONES`, which is the server's EMPTY-DATABASE fallback
 * and not the table any deployment actually runs on. The rows a real admin API
 * returns are `zone_abuja`, `zone_lagos`, `zone_rest_of_nigeria` (migration
 * 0240's seed), and a zone the operator creates gets
 * `zone_<base36><random>` from `newZoneId()`
 * (`server/shop/cart/checkout/shipping-zones-repo.ts`). Not one of those is a
 * member of that union.
 *
 * The consequence was not a cosmetic type complaint. This module DOCUMENTED
 * passing the live rows as the way to stop quoting a stale rate, and that
 * documented call could not compile — `error TS2322: Type 'string' is not
 * assignable to type 'DeliveryZoneId'` — so every caller stayed on the
 * compile-time copy of the seed, and the panel printed a rate against orders
 * the customer was charged something else for.
 *
 * The alias is kept rather than inlined so that a field holding a zone id says
 * so, and so a later move to a branded id has exactly one place to happen.
 */
export type DeliveryZoneId = string;

/**
 * ⚠️  THESE THREE NUMBERS ARE THE SEED. THEY ARE NOT THE SHOP'S RATES.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Abuja ₦3,000, Lagos ₦10,000, everywhere else ₦10,000, in minor units at
 * 100 per naira (₦3,000 = `300000` — confirmed against a live variant priced
 * `2300000` for a ~₦23,000 spool, not assumed). They are the values migration
 * 0240 INSERTs on a fresh database, and CLAUDE.md records the owner's own
 * description of them as "more like logging" while dispatch is arranged
 * separately.
 *
 * They live in `shop_shipping_options.amount_minor`, and an operator changes
 * them in `ShopShippingZones.tsx` WITHOUT A DEPLOY. So this constant is a
 * record of what the table STARTED as, and the moment anybody edits a rate it
 * is a historical footnote. Nothing in this module defaults to it any more:
 * `deliveryZoneOf` and `breakdown` both REQUIRE a table, and report nothing
 * about delivery when they are not given one. See `ZoneReading`.
 *
 * Whatever the table says, IT IS NOT WHAT ANY EXISTING ORDER WAS CHARGED.
 * That number is frozen on the order itself and reaches the panel as
 * `CurrencyTotal.shippingTotal`.
 *
 * ONE CONSTANT, DELIBERATELY. Sprinkling `300_000` through the file is how the
 * Abuja rate gets corrected in two places out of three.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const PROVISIONAL_DELIVERY_RATES_MINOR = {
  zone_abuja: 300_000,
  zone_lagos: 1_000_000,
  zone_rest_of_nigeria: 1_000_000,
} as const satisfies Record<DeliveryZoneId, number>;

/**
 * The currency those rates are denominated in — `SHOP_CURRENCY`
 * (`server/shop/currency.ts`), not `DEFAULT_STORE_CURRENCY`, which is the
 * cart subsystem's unrelated `'GBP'` scaffolding default.
 */
export const DELIVERY_RATE_CURRENCY = 'NGN';

/** One row of `shop_shipping_options`, as this module needs it. */
export interface DeliveryZoneOption {
  id: string;
  label: string;
  /** Minor units, in `DELIVERY_RATE_CURRENCY`. A safe integer, always. */
  amountMinor: number;
}

export interface DeliveryZone {
  id: DeliveryZoneId;
  label: string;
  /** ISO-3166-1 alpha-2. Empty on the fallback zone, exactly as the seed has it. */
  countries: readonly string[];
  /**
   * The zone's region list VERBATIM — not trimmed, not folded, in the exact
   * spellings the database holds. This is what `zoneFor` compares against, and
   * `serverZoneFor` can only reproduce its answer if the bytes are the same:
   * a zone whose stored region is `" Lagos "` does NOT match `"Lagos"` on the
   * server, so tidying it here would invent an agreement that does not exist.
   */
  regions: readonly string[];
  /** Every rate the zone quotes, in the order the table returned them. */
  options: readonly DeliveryZoneOption[];
  /**
   * THE zone's rate, or `null` when it does not have exactly one.
   *
   * `null` means the zone quotes nothing, quotes two prices the customer picks
   * between, or carries an option whose amount is not a usable count of minor
   * units. In all three cases there is no single number that can be printed
   * beside a destination without inventing one, and `options` is there for a
   * panel that wants to show the spread instead.
   */
  amountMinor: number | null;
  /**
   * Which canonical regions this zone's own `regions` list names, as this
   * module reads them. DERIVED, never hand-written — see `zoneRegionCodes`.
   */
  codes: readonly NgRegionCode[];
  fallback: boolean;
}

export type DeliveryZoneTable = readonly DeliveryZone[];

/**
 * The canonical regions a zone claims, read off its own `regions` strings.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DERIVED, BECAUSE THE LIVE ROW HAS NO SUCH COLUMN AND NEVER WILL.
 *
 * `DeliveryZone.codes` used to be hand-written next to each seeded zone. That
 * made the seed the only table this module could ever consume: a row out of
 * `shopApi.listShippingZones()` has `regions: string[]` and nothing else, so
 * there was no way to produce a `DeliveryZone` from one, and the documented
 * "pass the live rows" instruction was unimplementable. Deriving the codes
 * from the strings the operator actually typed is what makes an
 * operator-created zone — Port Harcourt at ₦5,000 for `Rivers` — a first-class
 * member of the table rather than something this module cannot see.
 *
 * BOTH INDEXES ARE CONSULTED, NAME FIRST. A zone listing `Rivers` claims
 * `NG-RI`; so does a zone listing `Port Harcourt`, because that is the string
 * the operator chose to price on and the panel's job is to describe their
 * table, not to grade it. An unrecognised string claims nothing and is simply
 * absent from `codes` — the zone still prices it on the server, and
 * `serverZoneFor` still reports that, which is exactly the disagreement this
 * module exists to surface.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function zoneRegionCodes(regions: readonly string[]): NgRegionCode[] {
  const out: NgRegionCode[] = [];
  for (const region of regions) {
    const text = str(region);
    if (text === null) continue;
    const key = lookupKey(text);
    const code = NAME_INDEX.get(key) ?? CITY_INDEX.get(key);
    if (code !== undefined && !out.includes(code)) out.push(code);
  }
  return out;
}

/** Every element that is a `string`, VERBATIM — see `DeliveryZone.regions`. */
function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/** One option row, or `null` for anything that is not one. */
function zoneOption(value: unknown): DeliveryZoneOption | null {
  const row = asRecord(value);
  if (row === null) return null;
  const amount = own(row, 'amountMinor');
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount)) return null;
  return {
    id: str(own(row, 'id')) ?? '',
    label: str(own(row, 'label')) ?? '',
    amountMinor: amount,
  };
}

/**
 * ONE LIVE ZONE ROW → the shape this module reads. THE ESCAPE HATCH, MADE REAL.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * This is the function whose absence was the bug. The module told callers to
 * "pass the rows from `shopApi.listShippingZones()` mapped into this shape",
 * named no mapper, and typed the id so that writing one could not compile. So
 * nobody did, everybody took the default, and the default was a transcription
 * of a seed the operator is expected to edit.
 *
 * `ShopShippingZone` (`src/data/api-shop.ts`) IS THE PARAMETER TYPE ON PURPOSE.
 * A `DeliveryZone`-shaped `unknown` would typecheck against anything and prove
 * nothing; naming the client's own row type means the compiler fails the day
 * that row changes shape, which is the only day this mapper can go wrong.
 *
 * TOTAL, LIKE EVERYTHING ELSE HERE. The parameter is typed, but the value came
 * off the network as unvalidated JSON, so every field goes through the same
 * `own`/`str`/`asRecord` coercions the address reader uses. A malformed row
 * produces a zone that claims nothing and quotes nothing; it never throws, and
 * it never takes the orders route to its error boundary.
 *
 * AN EMPTY LIST IS NOT THE SAME AS NO LIST, and the caller must decide which
 * it has. `listShippingZones()` returning `[]` means the TABLE is empty, and
 * `resolveShopCartDeps` answers that by falling back to
 * `DEFAULT_SHIPPING_ZONES` — so a caller mirroring the checkout should pass
 * `SEEDED_DELIVERY_ZONES` when the live list comes back empty, and pass
 * `null` only when the request has not finished or has failed.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function deliveryZoneFrom(zone: ShopShippingZone): DeliveryZone {
  const row = asRecord(zone);
  const at = (key: string): unknown => (row === null ? undefined : own(row, key));

  const id = str(at('id')) ?? '';
  const regions = textList(at('regions'));
  const rawOptions = at('options');
  const read = (Array.isArray(rawOptions) ? (rawOptions as unknown[]) : []).map(zoneOption);
  const options = read.filter((option): option is DeliveryZoneOption => option !== null);
  const amounts = new Set(options.map((option) => option.amountMinor));

  return {
    id,
    label: str(at('label')) ?? id,
    countries: textList(at('countries')),
    regions,
    options,
    // A row this refused to read is a row whose price is unknown, not a row
    // that costs nothing — so the zone quotes no single rate at all.
    amountMinor: read.length === options.length && amounts.size === 1 ? [...amounts][0] : null,
    codes: zoneRegionCodes(regions),
    fallback: at('isFallback') === true,
  };
}

/** `deliveryZoneFrom` over a whole `shopApi.listShippingZones()` response. */
export function deliveryZoneTableFrom(zones: readonly ShopShippingZone[]): DeliveryZoneTable {
  return Array.isArray(zones) ? zones.map(deliveryZoneFrom) : [];
}

/**
 * The shop's three zones as migration 0240 SEEDS them — the empty-database
 * fallback, and nothing else.
 *
 * ⚠️  THIS IS NOT THE LIVE TABLE AND MUST NOT BE PASSED AS IF IT WERE. Its one
 *     legitimate use is a deployment whose `shop_shipping_zones` has zero rows,
 *     because that is the case where the checkout itself falls back to
 *     `DEFAULT_SHIPPING_ZONES` and this really is what a customer is quoted.
 *     Passing it because the live rows have not loaded yet reproduces exactly
 *     the bug this module was rewritten to remove: a panel printing ₦10,000
 *     beside an order billed ₦5,000, and asserting the server agrees.
 *
 * Written as `ShopShippingZone` rows and mapped through `deliveryZoneFrom`
 * rather than as `DeliveryZone` literals, so the seed and the live rows travel
 * the same code path — a mapper that only ever ran on live data would be
 * exercised by no test that matters.
 *
 * `regions` is copied character-for-character from the seed rather than
 * regenerated from `NG_REGIONS`, because its entire job is to let
 * `serverZoneFor` reproduce `zoneFor`'s answer exactly — including the
 * spellings the server does NOT know. Generating it from this module's alias
 * table would make the two agree by construction and destroy the comparison.
 */
export const SEEDED_DELIVERY_ZONES: DeliveryZoneTable = deliveryZoneTableFrom([
  {
    id: 'zone_abuja',
    label: 'Abuja',
    countries: ['NG'],
    regions: ['Abuja', 'FCT', 'Federal Capital Territory'],
    taxRateBps: 0,
    taxLabel: 'No tax charged',
    shippingTaxable: false,
    isFallback: false,
    position: 0,
    options: [
      {
        id: 'ship_abuja_standard',
        zoneId: 'zone_abuja',
        label: 'Standard delivery',
        amountMinor: PROVISIONAL_DELIVERY_RATES_MINOR.zone_abuja,
        estimate: '',
        position: 0,
      },
    ],
  },
  {
    id: 'zone_lagos',
    label: 'Lagos',
    countries: ['NG'],
    regions: ['Lagos'],
    taxRateBps: 0,
    taxLabel: 'No tax charged',
    shippingTaxable: false,
    isFallback: false,
    position: 1,
    options: [
      {
        id: 'ship_lagos_standard',
        zoneId: 'zone_lagos',
        label: 'Standard delivery',
        amountMinor: PROVISIONAL_DELIVERY_RATES_MINOR.zone_lagos,
        estimate: '',
        position: 0,
      },
    ],
  },
  {
    id: 'zone_rest_of_nigeria',
    label: 'Rest of Nigeria',
    // Both empty, and deliberately: this is the FALLBACK, which `zoneFor` hands
    // every country and region no other zone claims.
    countries: [],
    regions: [],
    taxRateBps: 0,
    taxLabel: 'No tax charged',
    shippingTaxable: false,
    isFallback: true,
    position: 2,
    options: [
      {
        id: 'ship_rest_of_nigeria_standard',
        zoneId: 'zone_rest_of_nigeria',
        label: 'Standard delivery',
        amountMinor: PROVISIONAL_DELIVERY_RATES_MINOR.zone_rest_of_nigeria,
        estimate: '',
        position: 0,
      },
    ],
  },
]);

/**
 * NO TABLE WAS SUPPLIED, SO THERE IS NOTHING TO REPORT — and that is a VALUE,
 * not a missing field.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Every other inference in this file carries an in-band flag: `confident`,
 * `matchedOn`, `inferred`, `viaFallback`, `collapsed`. The one money-adjacent
 * guess — "the rate is ₦10,000 and the server agrees" — used to carry its
 * disclosure only in a source comment, where no panel could render it and no
 * test could catch it drifting. It defaulted to a compile-time copy of the
 * seed, so a shop that had edited a rate got a confident wrong number and
 * `agrees: true` beside it.
 *
 * `known: false` is the fix. It is a discriminant, so a UI cannot reach `.zone`
 * without first deciding what to render when there is no zone information, and
 * TypeScript enforces that rather than the reader noticing. "Zones have not
 * loaded" and "zones say Rest of Nigeria" stop being the same `null`.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export interface ZoneUnknown {
  known: false;
}

export interface ZoneKnown {
  known: true;
  /**
   * This module's answer, for the destination column. `null` means it will not
   * say — an unrecognised region outside Nigeria has no zone here, whatever
   * the price table would do with it.
   */
  zone: DeliveryZone | null;
  /**
   * `zone` is the table's FALLBACK ZONE, reached because no zone claims this
   * region — not a statement that the region was unrecognised.
   *
   * ⚠️  READ THAT AGAIN BEFORE RENDERING IT AS A "GUESS" BADGE. With the seeded
   *     table this is `true` for 35 of Nigeria's 37 regions, every one of them
   *     confidently recognised: `Oyo` is `confident: true`,
   *     `matchedOn: 'region-name'`, and `viaFallback: true`, because "Rest of
   *     Nigeria" is genuinely the zone Oyo is in and genuinely what the
   *     customer paid. The flag says which zone caught the address, and
   *     nothing about how well the address was read — `NormalisedRegion.
   *     confident` and `matchedOn` are the flags for that, and
   *     `BreakdownGroup.inferred` is the count.
   */
  viaFallback: boolean;
  /**
   * What `zoneFor` (`server/shop/cart/checkout/shipping.ts`) would ACTUALLY
   * quote, given this address's raw region string and country. The price side
   * of the truth, computed from the raw text and never from `code`.
   */
  serverZone: DeliveryZone | null;
  /**
   * The two readings name the same zone. `false` whenever `zone` is `null`,
   * because "no opinion" is not agreement.
   */
  agrees: boolean;
}

export type ZoneReading = ZoneUnknown | ZoneKnown;

/** The one `ZoneUnknown`. Frozen: it is shared by every group in a breakdown. */
export const ZONE_TABLE_ABSENT: ZoneUnknown = Object.freeze({ known: false });

/**
 * `zoneFor`, reimplemented over the same data, on the raw string.
 *
 * ⚠️  THIS IS A SECOND COPY OF A RULE THAT LIVES ON THE SERVER, which this
 *     repository has been bitten by before (two copies of a sort key that
 *     disagreed became a page boundary that skipped rows). It is here anyway,
 *     because the whole point is to detect the day the two DISAGREE, and a
 *     BROWSER BUNDLE cannot import `server/`. What keeps it honest is that it
 *     is a transcription of eight lines, that it is never used to price
 *     anything — only to compare — and, above all, that the SUITE can do what
 *     the bundle cannot: `geography.test.ts` imports the real
 *     `DEFAULT_SHIPPING_ZONES` and `zoneFor` (its Vitest project runs under
 *     node) and drives both over a generated cross-product of every spelling
 *     in `NG_REGIONS` × every country shape, asserting zero divergences —
 *     plus a foil proving that case set can still tell a right transcription
 *     from a plausible wrong one. The seeded rates below are asserted against
 *     the server's own constant rather than against literals retyped in the
 *     test, which is the CLAUDE.md §2 failure this file must not repeat.
 *
 * `zones` HAS NO DEFAULT, deliberately: see `deliveryZoneOf`.
 *
 * The rule, verbatim from that file: candidates are zones whose `countries`
 * include the code; a zone NAMING the region wins over one with no region
 * restriction (so a catch-all cannot shadow a specific zone by list order);
 * otherwise the fallback. Region comparison is `trim().toLowerCase()` and
 * nothing else — `F.C.T.` reaches the fallback, not Abuja.
 *
 * Where the server THROWS on a table with no fallback, this returns `null`:
 * a panel must not take a route down because the zone list is misconfigured,
 * and `null` renders as "—" while the checkout is the surface that has to
 * refuse the sale.
 */
export function serverZoneFor(
  countryCode: string | null,
  rawRegion: string | null,
  zones: DeliveryZoneTable,
): DeliveryZone | null {
  const code = (countryCode ?? HOME_COUNTRY).trim().toUpperCase();
  const region = rawRegion === null ? null : rawRegion.trim().toLowerCase();
  const candidates = zones.filter((zone) => zone.countries.includes(code));

  if (region !== null) {
    const named = candidates.find((zone) =>
      zone.regions.some((r) => r.trim().toLowerCase() === region),
    );
    if (named) return named;
  }
  const unrestricted = candidates.find((zone) => zone.regions.length === 0);
  if (unrestricted) return unrestricted;

  return zones.find((zone) => zone.fallback) ?? null;
}

/**
 * The zone a normalised region falls in, at the rates the supplied table
 * currently holds — with the server's own reading of the same address beside
 * it, so a caller can never mistake one for the other.
 *
 * WHY THIS TAKES THE WHOLE `NormalisedRegion` AND NOT JUST A CODE. Because
 * half the answer is about the RAW text: `serverZone` is computed from the
 * string the customer typed, since that is the only thing `zoneFor` ever sees.
 * A signature taking a code could not produce it, and a panel with only the
 * canonical half of the answer is precisely the panel that shows ₦3,000 beside
 * an order billed ₦10,000.
 *
 * ⚠️  `zones` IS REQUIRED AND HAS NO DEFAULT, WHICH IS THE FIX. It defaulted to
 *     a compile-time copy of migration 0240's seed, so the commonest call —
 *     the one with no table, made from a panel whose zone request had not
 *     landed — reported a rate, a `serverZone` and `agrees: true` from a
 *     three-row constant that any operator can invalidate in the admin without
 *     a deploy. `null` now means what it says: no table, no rate, no verdict.
 *     Nothing else in the breakdown depends on it — normalisation, grouping,
 *     counts and the frozen money a customer actually paid all still work.
 */
export function deliveryZoneOf(
  region: NormalisedRegion,
  zones: DeliveryZoneTable | null | undefined,
): ZoneReading {
  if (zones === null || zones === undefined) return ZONE_TABLE_ABSENT;

  const serverZone = serverZoneFor(region.countryCode, region.raw, zones);
  const fallback = zones.find((zone) => zone.fallback) ?? null;

  const code = region.code;
  let zone: DeliveryZone | null;
  let viaFallback: boolean;
  if (code !== null) {
    const claimed = zones.find((z) => z.codes.includes(code));
    zone = claimed ?? fallback;
    viaFallback = claimed === undefined && fallback !== null;
  } else if (region.reason === 'non-nigerian') {
    /*
     * NO OPINION, ON PURPOSE — and the gap this exposes is real. The seeded
     * fallback zone has `countries: []`, so `zoneFor` hands a London address
     * "Rest of Nigeria" at ₦10,000 rather than refusing the destination. That
     * is `serverZone`'s answer and it is reported as such; what this module
     * will not do is repeat it in the destination column, where "Rest of
     * Nigeria" next to a GB address reads as a fact about the parcel.
     */
    zone = null;
    viaFallback = false;
  } else {
    // Inside Nigeria (or country unstated) but unrecognised: the fallback is
    // genuinely what this shop charges for an address it cannot place, so the
    // number is right — it is just not evidence about where the parcel goes.
    zone = fallback;
    viaFallback = fallback !== null;
  }

  return {
    known: true,
    zone,
    viaFallback,
    serverZone,
    agrees: zone !== null && serverZone !== null && zone.id === serverZone.id,
  };
}

// ──────────────────────────────────────────────────────────────── the panel

/**
 * Money, per currency, and NEVER across currencies.
 *
 * `server/shop/admin/stats.ts` groups by `(status, currency)` and refuses to
 * add two codes for the reason repeated here: money is an integer count of
 * minor units plus an ISO-4217 code, and summing NGN into GBP produces a
 * number that looks like a total and reconciles against nothing. Contract §13
 * gives this shop one currency, so in practice this array has one element —
 * the grouping is what makes the day that stops being true VISIBLE rather than
 * silently wrong.
 */
export interface CurrencyTotal {
  /** Uppercased. `UNKNOWN_CURRENCY` when the order did not carry a usable one. */
  currency: string;
  orders: number;
  /** All minor units, all FROZEN at checkout — copied, never recomputed. */
  grandTotal: number;
  refundedTotal: number;
  /** `grandTotal - refundedTotal`. A fully refunded order nets to zero. */
  netTotal: number;
  /** What the customer was ACTUALLY charged for delivery. Not a zone rate. */
  shippingTotal: number;
  /**
   * This row's `grandTotal` as a percentage of every order's `grandTotal` IN
   * THE SAME CURRENCY, rounded here. See `SHARE_DECIMALS`.
   *
   * `null` when the arithmetic has no honest answer — see `valueSharePct`.
   */
  sharePct: number | null;
}

/**
 * The bucket for an order whose `currency` is absent, blank or not a string.
 *
 * Deliberately a visible non-code rather than a guess at `'NGN'`. `stats.ts`
 * makes the same call about an absent row — "inventing `'GBP'` there would be
 * this file asserting a fact it does not have" — and a `???` row on screen is
 * a bug report, where a silently-NGN row is a number nobody questions.
 */
export const UNKNOWN_CURRENCY = '???';

/**
 * One distinct spelling that landed in a group, and how many orders it was.
 *
 * Distinct means EXACTLY distinct, trimming aside: `Abuja` and `abuja` are two
 * entries even though they are one row. The row is the answer; this is the
 * evidence for it, and evidence that has been folded is not evidence.
 */
export interface RawVariant {
  /** `null` when those orders carried no region text at all. */
  raw: string | null;
  orders: number;
}

/**
 * A whole group's delivery reading, or the fact that there is not one.
 *
 * `known: false` is the SAME value every group carries when `breakdown` was
 * given no zone table — see `ZONE_TABLE_ABSENT`. A UI narrows on it once and
 * knows there is nothing to render in the rate column; there is no
 * `zone === null` that might mean "not loaded" and might mean "no zone claims
 * this address", because those are now different shapes.
 */
export interface GroupZoneKnown {
  known: true;
  /** This module's zone for these addresses. `null` when it will not say. */
  zone: DeliveryZone | null;
  /** `zone` is the table's fallback. NOT a claim about recognition — see `ZoneKnown`. */
  viaFallback: boolean;
  /**
   * What `zoneFor` would quote for these addresses. `null` when the group's
   * spellings are priced DIFFERENTLY from each other — the live `Abuja` vs
   * `F.C.T.` shape, one reaching Abuja and one the fallback — in which case
   * `serverZoneMixed` is `true` and there is no single honest answer.
   */
  serverZone: DeliveryZone | null;
  /** `serverZone` is `null` because the group disagrees with itself. */
  serverZoneMixed: boolean;
  /** Orders here whose raw text this module and `zoneFor` price differently. */
  disagreements: number;
}

export type GroupZoneReading = ZoneUnknown | GroupZoneKnown;

export interface BreakdownGroup {
  /**
   * The grouping key. `null` for a group nothing was recognised in — those are
   * keyed by their own folded text and country instead, so `"Ontario"` under
   * `CA` and `"Ontario"` under `NG` stay apart while `"ontario"` and
   * `"Ontario"` merge.
   */
  code: NgRegionCode | null;
  /** Canonical name, the operator's own text, or `NO_REGION_LABEL`. */
  label: string;
  /** `true` when `code !== null`. Read it rather than testing `code`. */
  recognised: boolean;
  /**
   * `'NG'`, another country, or `null` — for EITHER "the address did not say"
   * OR "the orders here did not agree". `countryCodeMixed` separates the two.
   *
   * This used to be whatever the FIRST row in the group happened to carry, so
   * three Lagos orders reported `null` or `'NG'` purely by page order and a
   * re-sort of the list could change it. `serverZone` already took the
   * mixed-value problem seriously; this field now does too. An address that
   * stated no country and one that stated `NG` count as DIFFERENT evidence and
   * mix, even though `normaliseRegion` treats both as home — the assumption
   * that unstated means Nigeria is this module's, and quietly promoting it to
   * a stated fact here is how an assumption stops being visible.
   */
  countryCode: string | null;
  /** Two orders here named different countries, so `countryCode` is `null`. */
  countryCodeMixed: boolean;
  orders: number;
  /** Orders here still waiting on the operator. See `AWAITING_ACTION_STATUSES`. */
  awaitingAction: number;
  /** Orders placed here whose region was INFERRED (a city, not a stated state). */
  inferred: number;
  value: CurrencyTotal[];
  /** Every distinct raw `region` string that landed here. The collapse, shown. */
  collapsed: RawVariant[];
  /** The zone table's reading of these addresses, or that there is no table. */
  delivery: GroupZoneReading;
  /** Share of ALL orders in the breakdown, as a percentage. See `SHARE_DECIMALS`. */
  sharePct: number;
  /** `placedAt` of the oldest order here still awaiting action, or `null`. */
  oldestAwaitingPlacedAt: number | null;
  /** `opts.now - oldestAwaitingPlacedAt`, clamped at zero. `null` when none. */
  oldestAwaitingAgeMs: number | null;
}

/** A group in which more than one spelling was folded into one destination. */
export interface Collapse {
  code: NgRegionCode | null;
  label: string;
  variants: RawVariant[];
}

/**
 * Everything the breakdown can say about delivery zones, or that it cannot.
 *
 * The counts live INSIDE the `known: true` arm on purpose. A
 * `serverDisagreements: 0` sitting at the top level of a breakdown taken with
 * no zone table is not a measurement, it is a positive assertion that the
 * panel and the checkout agree — which is precisely the sentence this module
 * was printing next to orders it had no rate for.
 */
export interface BreakdownZoneKnown {
  known: true;
  /** The rate table these readings were taken against. Echoed, not remembered. */
  zones: DeliveryZoneTable;
  /**
   * Orders where this module's zone and `zoneFor`'s zone differ — the panel
   * and the checkout reading the same address two ways. There are exactly two
   * causes and they want different fixes:
   *
   *  - a spelling this table knows and the zone table does not (`F.C.T.`,
   *    `Ikeja`). Closable by adding it to that zone's `regions` in
   *    `ShopShippingZones.tsx`, with no deploy — and because the count is
   *    computed from the table that was HANDED IN, adding the alias makes the
   *    number fall, where a reading off a compile-time constant would have
   *    reported the same disagreement for ever.
   *  - a non-Nigerian address, where this module refuses to name a zone and
   *    the server quotes "Rest of Nigeria" because the fallback zone has
   *    `countries: []`. That one is a shipping-policy question, not a typo.
   */
  disagreements: number;
}

export type BreakdownZoneReading = ZoneUnknown | BreakdownZoneKnown;

export interface GeographyBreakdown {
  /**
   * The instant this was taken. `opts.now`, echoed — never read from a clock.
   *
   * `null` WHEN `opts.now` IS NOT A FINITE NUMBER, and that is a guard against
   * one specific crash rather than tidiness. This field used to pass `opts.now`
   * through untouched while the ages beside it were sanitised, so
   * `breakdown(rows, { now: NaN }).generatedAt` was `NaN` — and
   * `Intl.DateTimeFormat().format(NaN)` throws `RangeError: Invalid time
   * value`, which is the exact failure that put this route in its error
   * boundary and the exact reason this module is documented as total.
   *
   * `null` rather than `0`, because `0` is a real instant that renders as
   * 1 January 1970 and reads as a fact. `null` is not assignable to
   * `Intl.DateTimeFormat.format`, so the compiler makes the caller decide.
   */
  generatedAt: number | null;
  totalOrders: number;
  /** Destinations first, data-quality buckets last. See `compareGroups`. */
  groups: BreakdownGroup[];
  /** Every group where two or more spellings became one row. Possibly empty. */
  collapses: Collapse[];
  /** Orders with no recognised region, and why — never one silent bucket. */
  unrecognised: {
    orders: number;
    reasons: { reason: UnrecognisedReason; orders: number }[];
  };
  /** Orders whose region was inferred from a city rather than stated. */
  inferredOrders: number;
  /** Orders whose `countryCode` says somewhere other than Nigeria. */
  nonNigerianOrders: number;
  /**
   * Money fields that were not a usable count of minor units and were read as
   * `0` — see `minor`. Non-zero means at least one total on this screen is
   * short, and by how much is unknowable, which is a bug report rather than a
   * rounding note.
   */
  unusableMoneyFields: number;
  /**
   * Every currency's whole-breakdown totals. `sharePct` is `100` on each,
   * except a currency whose orders total zero minor units, where it is `0` —
   * a share of nothing is nothing, not everything — and a currency whose rows
   * cancel to a non-positive total, where it is `null`. See `valueSharePct`.
   */
  totals: CurrencyTotal[];
  /** The zone table's readings, or the fact that no table was supplied. */
  delivery: BreakdownZoneReading;
}

/**
 * WHAT "AWAITING ACTION" MEANS HERE, AND WHOSE ACTION IT IS.
 *
 * These are the statuses where the shop has the customer's money and has not
 * finished handing over the goods. `pending` is deliberately NOT one: an
 * unpaid order is waiting on the CUSTOMER, and putting it in the same number
 * as a paid parcel sitting unshipped would make the operator's queue look
 * longer than their work. `fulfilled`, `cancelled` and `refunded` are closed.
 * `partially_refunded` still owes something, so it stays in.
 *
 * A status alone is not enough — `fulfilledAt` must also still be `null`, so
 * an order that has shipped drops out of the queue the instant it does.
 *
 * Overridable through `BreakdownOptions.awaitingStatuses` because "what counts
 * as my queue" is an operator's question, not this module's.
 */
export const AWAITING_ACTION_STATUSES: readonly OrderStatus[] = ['paid', 'partially_refunded'];

export interface BreakdownOptions {
  /**
   * The instant the panel is being drawn at, in epoch ms.
   *
   * PASSED IN, NEVER READ FROM A CLOCK — the same rule `StatsQuery.now`
   * follows, and for the same reason: a function that calls `Date.now()`
   * cannot be tested for the boundary it exists to compute.
   */
  now: number;
  /** Defaults to `AWAITING_ACTION_STATUSES`. */
  awaitingStatuses?: readonly OrderStatus[];
  /**
   * The live rate table, and THERE IS NO DEFAULT.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * Omit it, or pass `null`, and the breakdown reports NOTHING about delivery:
   * `delivery` is `{ known: false }` on the whole breakdown and on every group,
   * so there is no rate, no `serverZone` and no agreement verdict anywhere in
   * the output. Everything else — normalisation, the collapse, the counts, the
   * queue ages, and the frozen money the customer actually paid — is a fact
   * about the rows and still works, so a panel whose zone request has not
   * landed (or failed) renders in full with one column showing "—".
   *
   * To get a rate:
   *
   *     const rows = await shopApi.listShippingZones();
   *     breakdown(orders, { now, zones: deliveryZoneTableFrom(rows) });
   *
   * `deliveryZoneTableFrom` is exported from this module and typed against
   * `ShopShippingZone`, so that call compiles. Its predecessor — "pass the rows
   * mapped into this shape" with no mapper and a closed id union — did not,
   * which is how every caller ended up on a constant.
   * ═══════════════════════════════════════════════════════════════════════
   */
  zones?: DeliveryZoneTable | null;
}

/**
 * How many decimal places a share carries.
 *
 * ONE, AND THE ROUNDING IS DECIDED HERE RATHER THAN IN THE COMPONENT, because
 * two components rounding the same number two ways is how a dashboard ends up
 * disagreeing with itself. `Math.round` is half-up, and both operands are
 * non-negative, so there is no negative-zero case to reason about.
 *
 * ⚠️  THE COLUMN IS NOT GUARANTEED TO SUM TO 100, AND MUST NOT BE FORCED TO.
 *     Each row is rounded independently, so three equal thirds render as
 *     33.3 + 33.3 + 33.3 = 99.9 and the panel is allowed to show that. The
 *     alternative — largest-remainder, which adds the lost tenth to whichever
 *     row rounded down hardest — makes the COLUMN total 100 by printing at
 *     least one row a number that is not that row's share. An operator who
 *     checks one row against the order count would find the screen wrong.
 *     Per-row truth beats column tidiness; a UI that needs a clean 100 should
 *     say "of N orders" instead of implying the percentages are exhaustive.
 */
export const SHARE_DECIMALS = 1;

function round(value: number): number {
  const scale = 10 ** SHARE_DECIMALS;
  return Math.round(value * 100 * scale) / scale;
}

/**
 * A share of a COUNT. Both operands are non-negative integers by construction —
 * a group's orders, over the orders in the breakdown — and no group can hold
 * more orders than the breakdown does, so the result is always `0 … 100`.
 * `whole <= 0` is unreachable (a group exists only because a row created it)
 * and answers `0` rather than dividing.
 */
function countSharePct(part: number, whole: number): number {
  return whole <= 0 ? 0 : round(part / whole);
}

/**
 * A share of MONEY, or `null` when there is no honest one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `whole <= 0` WAS THE ONLY GUARD, AND IT IS THE WRONG HALF OF THE PROBLEM.
 *
 * `shop_orders.grand_total` carries no `>= 0` CHECK, so a currency's rows can
 * cancel: totals of −500, +500 and +3 give a denominator of 3 and shares of
 * −16,667%, +16,667% and 100%. Every one of those passed the old guard and
 * rendered as a percentage, on a screen whose whole purpose is that an
 * operator can trust the numbers on it.
 *
 * CLAMPING WAS REJECTED. Pinning −16,667% to 0% and +16,667% to 100% produces
 * a column that looks ordinary and is a fabrication — the reader has no way to
 * tell a genuine 100% row from a clamped one. A refusal is legible: a UI
 * renders `null` as "—" and the operator asks why, which is the correct
 * outcome for a page of orders that add up to a negative number.
 *
 * `0 / 0` IS STILL `0`, DELIBERATELY. A currency whose orders total nothing has
 * a share of nothing, which is `0` and not `null` and certainly not `100` —
 * that case is ordinary (a free order, a fully discounted one) rather than
 * corrupt, and has a defined answer.
 * ═══════════════════════════════════════════════════════════════════════════
 */
function valueSharePct(part: number, whole: number): number | null {
  if (whole === 0) return part === 0 ? 0 : null;
  if (whole < 0 || part < 0 || part > whole) return null;
  return round(part / whole);
}

interface Accumulator {
  code: NgRegionCode | null;
  label: string;
  countryCode: string | null;
  /** Two orders in one group named different countries. Then: no answer. */
  countryCodeMixed: boolean;
  orders: number;
  awaitingAction: number;
  inferred: number;
  disagreements: number;
  byCurrency: Map<string, CurrencyTotal>;
  /** Keyed on the raw string itself, `null` included — see the write site. */
  variants: Map<string | null, RawVariant>;
  zone: DeliveryZone | null;
  viaFallback: boolean;
  serverZone: DeliveryZone | null;
  /** Two orders in one group disagreed about the server zone. Then: no answer. */
  serverZoneMixed: boolean;
  oldestAwaitingPlacedAt: number | null;
}

function currencyOf(value: unknown): string {
  const raw = str(value);
  return raw === null ? UNKNOWN_CURRENCY : raw.toUpperCase();
}

/**
 * Locale-independent, on purpose. `localeCompare` sorts differently under
 * different ICU data, which would make the panel's row order depend on the
 * machine rendering it and a snapshot test depend on the machine running it.
 */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * THE SORT, AND WHY IT IS THIS ONE.
 *
 *  1. Recognised destinations before unrecognised buckets, REGARDLESS OF SIZE.
 *     "Region not recognised" is not a place; a big one sitting at the top of
 *     a destinations list reads as the biggest destination. It is still in the
 *     list, still counted, and also surfaced separately as
 *     `unrecognised.orders`, so nothing is hidden by moving it down.
 *  2. Order count, descending. Count is the ONLY quantity comparable across
 *     every row: value cannot be, because two currencies do not add (see
 *     `CurrencyTotal`), so a value-ordered list would be undefined the moment
 *     a second currency appears. Count is also the panel's actual question —
 *     how many parcels go there.
 *  3. Label ascending, as a tiebreak, so the order is stable and reproducible
 *     rather than dependent on input order.
 */
function compareGroups(a: BreakdownGroup, b: BreakdownGroup): number {
  if (a.recognised !== b.recognised) return a.recognised ? -1 : 1;
  if (a.orders !== b.orders) return b.orders - a.orders;
  return compareText(a.label, b.label);
}

/**
 * The destination panel's whole dataset, from the rows the orders list already
 * has in hand.
 *
 * NO SECOND REQUEST, AND NO SECOND SOURCE OF TRUTH. `GET /shop/admin/orders`
 * already returns `{ order, lines }` per row and the addresses are on it, so
 * this is a fold over the page the operator is looking at — which also means
 * the panel and the list can never disagree about how many orders there are.
 * The cost is that it describes THAT PAGE and not the whole shop; a caller
 * paginating must accumulate rows itself before calling, and a caller that
 * does not should label the panel accordingly.
 *
 * TOTAL BY CONSTRUCTION. Every field is read through a coercion with a defined
 * answer for garbage, so there is no row shape that throws — a row with no
 * `order` at all becomes one order, no currency, `no-address`, and is counted.
 * The panel's job when the data is broken is to say so, not to disappear.
 */
export function breakdown(
  rows: readonly ShopOrderRow[],
  opts: BreakdownOptions,
): GeographyBreakdown {
  const zones = opts.zones ?? null;
  const awaiting = new Set<string>(opts.awaitingStatuses ?? AWAITING_ACTION_STATUSES);
  /*
   * ONE SANITISED `now`, USED FOR EVERY TIME-DERIVED FIELD INCLUDING
   * `generatedAt`. The ages were guarded here and `generatedAt` was not, so a
   * non-finite `now` produced an output whose ages were `0` and whose stamp was
   * `NaN` — internally inconsistent, and a `RangeError` in the first formatter
   * that touched it.
   */
  const usableNow = Number.isFinite(opts.now);
  const now = usableNow ? opts.now : 0;

  const groups = new Map<string, Accumulator>();
  const reasons = new Map<UnrecognisedReason, number>();
  const totalsByCurrency = new Map<string, CurrencyTotal>();
  let totalOrders = 0;
  let inferredOrders = 0;
  let nonNigerianOrders = 0;
  let unusableMoneyFields = 0;
  let disagreements = 0;

  for (const row of rows) {
    totalOrders += 1;

    /*
     * `own`, NOT A BARE `.order`. This was the file's one bare property read,
     * in a module that says twice that every field goes through `own()`, and it
     * was reachable: `Object.create({ order: { shippingAddress: { region:
     * 'Lagos' } } })` fabricated a Lagos destination out of a prototype. Not
     * reachable from `JSON.parse`, so it was never going to fire on a real
     * response — but a stated invariant with one hole in it is worse than no
     * invariant, because the next reader trusts it.
     */
    const rowRecord = asRecord(row);
    const order = asRecord(rowRecord === null ? null : own(rowRecord, 'order'));
    const region = normaliseRegion(order === null ? null : own(order, 'shippingAddress'));
    const reading = deliveryZoneOf(region, zones);

    /*
     * THE GROUPING KEY. Recognised rows key on the ISO code alone, which is
     * what makes "Abuja" and "Federal Capital Territory" one row. Unrecognised
     * rows key on country plus folded text, so unknown places stay apart from
     * each other instead of piling into one anonymous heap — the operator can
     * then read the actual strings back off `collapsed` and fix the form or
     * add the alias.
     */
    const key =
      region.code !== null
        ? region.code
        : `?|${region.countryCode ?? ''}|${region.raw === null ? '' : fold(region.raw)}`;

    let group = groups.get(key);
    if (group === undefined) {
      group = {
        code: region.code,
        label: region.code !== null ? region.label : (region.raw ?? NO_REGION_LABEL),
        countryCode: region.countryCode,
        countryCodeMixed: false,
        orders: 0,
        awaitingAction: 0,
        inferred: 0,
        disagreements: 0,
        byCurrency: new Map(),
        variants: new Map(),
        zone: reading.known ? reading.zone : null,
        viaFallback: reading.known && reading.viaFallback,
        serverZone: reading.known ? reading.serverZone : null,
        serverZoneMixed: false,
        oldestAwaitingPlacedAt: null,
      };
      groups.set(key, group);
    } else {
      if (reading.known && group.serverZone?.id !== reading.serverZone?.id) {
        /*
         * Two spellings in one group that the SERVER prices differently — which
         * is exactly the live "Abuja" vs "F.C.T." shape, one reaching the Abuja
         * zone and one reaching the fallback. There is no single honest answer
         * for the group, so it reports none and leans on `disagreements` to say
         * the row is not uniform.
         */
        group.serverZoneMixed = true;
      }
      if (group.countryCode !== region.countryCode) {
        /*
         * THE SAME CARE, FOR THE SAME REASON. `countryCode` was whatever the
         * first row in the group happened to say, so three Lagos orders
         * reported `null` or `'NG'` by page order alone — a field whose value
         * depended on the sort of the list above it. One disagreement and the
         * group has no country, exactly as it has no server zone.
         */
        group.countryCodeMixed = true;
        group.countryCode = null;
      }
    }

    group.orders += 1;
    if (region.matchedOn === 'region-city' || region.matchedOn === 'city-field') {
      group.inferred += 1;
      inferredOrders += 1;
    }
    if (region.reason === 'non-nigerian') nonNigerianOrders += 1;
    // No table, no verdict: an order cannot disagree with a zone list this
    // module was never given, and counting it as agreement is the lie.
    if (reading.known && !reading.agrees) {
      group.disagreements += 1;
      disagreements += 1;
    }
    if (region.reason !== null) {
      reasons.set(region.reason, (reasons.get(region.reason) ?? 0) + 1);
    }

    /*
     * VARIANTS ARE KEYED ON THE EXACT TRIMMED STRING, NOT ON THE FOLDED ONE.
     *
     * The row an operator reads is keyed on the fold — that is the collapse.
     * This list is the EVIDENCE for it, and folding the evidence too would
     * hide precisely the differences worth seeing: `Abuja` and `abuja` become
     * one row on the panel, and they should, but a form emitting both is a
     * fact about the checkout that the panel is the only place to notice.
     */
    const variant = group.variants.get(region.raw);
    if (variant === undefined) {
      group.variants.set(region.raw, { raw: region.raw, orders: 1 });
    } else {
      variant.orders += 1;
    }

    const currency = currencyOf(order === null ? null : own(order, 'currency'));
    const read = {
      grandTotal: minor(order === null ? null : own(order, 'grandTotal')),
      refundedTotal: minor(order === null ? null : own(order, 'refundedTotal')),
      shippingTotal: minor(order === null ? null : own(order, 'shippingTotal')),
    };
    for (const field of [read.grandTotal, read.refundedTotal, read.shippingTotal]) {
      if (field.unusable) unusableMoneyFields += 1;
    }
    const grandTotal = read.grandTotal.value;
    const refundedTotal = read.refundedTotal.value;
    const shippingTotal = read.shippingTotal.value;
    for (const bucket of [group.byCurrency, totalsByCurrency]) {
      const total = bucket.get(currency);
      if (total === undefined) {
        bucket.set(currency, {
          currency,
          orders: 1,
          grandTotal,
          refundedTotal,
          netTotal: grandTotal - refundedTotal,
          shippingTotal,
          sharePct: 0,
        });
      } else {
        total.orders += 1;
        total.grandTotal += grandTotal;
        total.refundedTotal += refundedTotal;
        total.netTotal += grandTotal - refundedTotal;
        total.shippingTotal += shippingTotal;
      }
    }

    const status = order === null ? null : str(own(order, 'status'));
    const fulfilledAt = order === null ? null : epoch(own(order, 'fulfilledAt'));
    if (status !== null && awaiting.has(status) && fulfilledAt === null) {
      group.awaitingAction += 1;
      const placedAt = order === null ? null : epoch(own(order, 'placedAt'));
      if (
        placedAt !== null &&
        (group.oldestAwaitingPlacedAt === null || placedAt < group.oldestAwaitingPlacedAt)
      ) {
        group.oldestAwaitingPlacedAt = placedAt;
      }
    }
  }

  for (const total of totalsByCurrency.values()) {
    total.sharePct = valueSharePct(total.grandTotal, total.grandTotal);
  }

  const out: BreakdownGroup[] = [];
  for (const group of groups.values()) {
    const value = [...group.byCurrency.values()]
      .map((total) => ({
        ...total,
        sharePct: valueSharePct(
          total.grandTotal,
          totalsByCurrency.get(total.currency)?.grandTotal ?? 0,
        ),
      }))
      .sort((a, b) => compareText(a.currency, b.currency));

    const variants = [...group.variants.values()].sort(
      (a, b) => b.orders - a.orders || compareText(a.raw ?? '', b.raw ?? ''),
    );

    out.push({
      code: group.code,
      label: group.label,
      recognised: group.code !== null,
      countryCode: group.countryCode,
      countryCodeMixed: group.countryCodeMixed,
      orders: group.orders,
      awaitingAction: group.awaitingAction,
      inferred: group.inferred,
      value,
      collapsed: variants,
      delivery:
        zones === null
          ? ZONE_TABLE_ABSENT
          : {
              known: true,
              zone: group.zone,
              viaFallback: group.viaFallback,
              serverZone: group.serverZoneMixed ? null : group.serverZone,
              serverZoneMixed: group.serverZoneMixed,
              disagreements: group.disagreements,
            },
      sharePct: countSharePct(group.orders, totalOrders),
      oldestAwaitingPlacedAt: group.oldestAwaitingPlacedAt,
      // Clamped at zero: a browser clock behind the server's `placedAt` must
      // render "just now", not "-3 minutes old".
      oldestAwaitingAgeMs:
        group.oldestAwaitingPlacedAt === null
          ? null
          : Math.max(0, now - group.oldestAwaitingPlacedAt),
    });
  }
  out.sort(compareGroups);

  return {
    generatedAt: usableNow ? opts.now : null,
    totalOrders,
    groups: out,
    collapses: out
      .filter((group) => group.collapsed.length > 1)
      .map((group) => ({ code: group.code, label: group.label, variants: group.collapsed })),
    unrecognised: {
      orders: out.reduce((n, group) => (group.recognised ? n : n + group.orders), 0),
      reasons: [...reasons.entries()]
        .map(([reason, orders]) => ({ reason, orders }))
        .sort((a, b) => b.orders - a.orders || compareText(a.reason, b.reason)),
    },
    inferredOrders,
    nonNigerianOrders,
    unusableMoneyFields,
    totals: [...totalsByCurrency.values()].sort((a, b) => compareText(a.currency, b.currency)),
    delivery: zones === null ? ZONE_TABLE_ABSENT : { known: true, zones, disagreements },
  };
}

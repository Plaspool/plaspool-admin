import { fezStateName } from '../address';
import { LogisticsError, type ExportCatalogue, type ExportDestination, type ExportWeight, type ProviderExports } from '../port';
import type { FezClient } from './client';

/**
 * FEZ'S INTERNATIONAL ARM, which is a different API and not a flag on the
 * domestic one.
 *
 * `/order/cost` takes a NIGERIAN STATE NAME. Hand it "Greater Accra" and Fez
 * answers `The selected state is invalid` — measured on production 2026-09-09,
 * which is what a shopper in Accra was silently getting before this existed.
 * Exports use `/orders/export-locations` and `/orders/export-price`, address a
 * destination by an integer id of Fez's own, and buy a WEIGHT BRACKET rather
 * than naming kilograms.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A DESTINATION ROW IS A COUNTRY *AND* A BRACKET. Fez publishes names like
 * "Ghana(0-2kg)", so a heavier parcel to the same country is a DIFFERENT ROW
 * WITH A DIFFERENT ID rather than the same row at another weight. The bracket
 * is therefore parsed off the name and kept on the destination, and choosing
 * where to send something and how heavy it may be is one decision.
 *
 * The published sample lists one weight (`0 - 2`) while Fez's own example
 * request posts `weightId: 5`, which cannot exist in it. So the sample is a
 * bare account rather than the shape of the world, and NOTHING HERE ASSUMES A
 * CEILING: whatever the account answers is the list, and a basket that fits no
 * bracket is refused rather than squeezed into the biggest one.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * `"Ghana(0-2kg)"` → place, floor, ceiling. A name with no bracket — Fez
 * publishes several — parses to the whole name and two nulls, which reads as
 * "no published limit" and not as "zero".
 */
export function parseDestinationName(name: string): { place: string; minKg: number | null; maxKg: number | null } {
  const m = /^\s*(.+?)\s*\(\s*([\d.]+)\s*-\s*([\d.]+)\s*kg\s*\)\s*$/i.exec(name);
  if (!m) return { place: name.trim(), minKg: null, maxKg: null };
  const min = Number(m[2]);
  const max = Number(m[3]);
  return {
    place: m[1].trim(),
    minKg: Number.isFinite(min) ? min : null,
    maxKg: Number.isFinite(max) ? max : null,
  };
}

/**
 * A BRACKET'S NAME IS ITS CEILING IN KILOGRAMS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * MEASURED AGAINST THE LIVE ACCOUNT 2026-09-09, AND IT IS NOT WHAT THE
 * DOCUMENTATION SHOWS. The published sample names one bracket `"0 - 2"`; the
 * real account publishes FORTY-FOUR, named as bare numbers — "0.5", "2",
 * "3.5", "70". So `"2"` means "up to 2 kg".
 *
 * THIS PARSER READING A BARE NUMBER AS `null` WAS A MONEY BUG, and worth
 * spelling out because it is the shape of bug that does not look like one: a
 * null ceiling means "no published limit", every bracket then fits every
 * parcel, and `matchExport` hands a 70 kg basket the 0.5 kg bracket's price.
 * Nothing errors. The shop simply undercharges for heavy parcels abroad, one
 * order at a time.
 *
 * The range form is still accepted, because the documented sample is what a
 * thinner account may really answer and both readings mean the same thing.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function parseWeightName(name: string): { minKg: number | null; maxKg: number | null } {
  const range = /^\s*([\d.]+)\s*-\s*([\d.]+)\s*$/.exec(name);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    return { minKg: Number.isFinite(min) ? min : null, maxKg: Number.isFinite(max) ? max : null };
  }
  const bare = /^\s*([\d.]+)\s*(?:kg)?\s*$/i.exec(name);
  if (bare) {
    const max = Number(bare[1]);
    return { minKg: null, maxKg: Number.isFinite(max) ? max : null };
  }
  return { minKg: null, maxKg: null };
}

/**
 * THE COUNTRY BEHIND A COURIER'S PLACE NAME.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * BUILT FROM `Intl.DisplayNames`, NOT HAND-WRITTEN, because the live account
 * publishes 233 destinations — very nearly every country there is. A hand
 * table of that length is a hand table that goes stale, and the first symptom
 * is a country quietly never appearing at a checkout, which nobody reports.
 *
 * The runtime already knows every ISO 3166-1 alpha-2 code's English name, so
 * the map is INVERTED from that: name -> code, generated once. What is left by
 * hand is only what a machine cannot know — the courier's own spellings,
 * including its typos ("Boliva"), its lower case ("cyprus"), its long forms
 * ("Republic of Benin") and its regions ("Europe", which is not a country and
 * so resolves to a list).
 *
 * AN UNRECOGNISED NAME STILL MAPS TO NOTHING AND IS OFFERED TO NOBODY. Every
 * refresh reports how many were skipped, so a gap is something an operator is
 * told about rather than something a shopper discovers.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Every ISO 3166-1 alpha-2 code, so the runtime can name them all.
 *
 *  THE PARENTHESES ARE LOAD-BEARING: `.split()` binds to the last literal
 *  alone, so without them this is a STRING and `for...of` walks it one
 *  character at a time. TypeScript cannot see it — a string is iterable and
 *  the loop variable is a string either way — and the only symptom is an
 *  empty country map. */
const ISO_CODES = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO ' +
  'FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE ' +
  'JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO ' +
  'MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW ' +
  'PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM ' +
  'TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ');

/** Lower case, punctuation and filler words dropped, so "Cote D'Ivoire",
 *  "cote divoire" and "Côte d’Ivoire" all land on the same key. */
function fold(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    /* NO FILLER-WORD STRIPPING. Dropping "states" and "kingdom" folded BOTH
       "United States" and "United Kingdom" onto "united" - worse than a miss,
       because it is a WRONG country and silent. The courier's long forms are
       named in ALIASES instead, where each one is visible and reviewable. */
    .replace(/\s+/g, ' ')
    .trim();
}

const EUROPE = [
  'AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR',
  'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO',
  'SE', 'SI', 'SK',
];

/**
 * WHAT THE RUNTIME CANNOT KNOW: the courier's own spellings. Every entry here
 * is a real string the live account published (2026-09-09) that `Intl` does
 * not answer to, including its misspellings, which are its data and not ours
 * to correct upstream.
 */
const ALIASES: Record<string, string[]> = {
  /* Every string below is one the LIVE account published on 2026-09-09 that
     the runtime's own country names do not answer to - long forms, colonial
     forms, abbreviations and outright misspellings ("Isreal"). They are the
     courier's data, not ours to correct upstream, so they are matched rather
     than fixed. */
  /* The runtime says "Türkiye" now; the courier still says Turkey. */
  'turkey': ['TR'],
  'turks and caicos': ['TC'],
  'virgin islands british': ['VG'],
  'virgin islands us': ['VI'],
  'bonaire': ['BQ'],
  'st eustatius': ['BQ'],
  'congo': ['CG'],
  'democratic republic of congo': ['CD'],
  'czech republic': ['CZ'],
  'falkland island': ['FK'],
  'faroe island': ['FO'],
  'french guyana': ['GF'],
  'guinea equatorial': ['GQ'],
  'guyana british': ['GY'],
  'hong kong': ['HK'],
  'isreal': ['IL'],
  'kosovo': ['XK'],
  'macau sar china': ['MO'],
  'mariana island': ['MP'],
  'island of reunion': ['RE'],
  'myanmar': ['MM'],
  'nevis': ['KN'],
  'st kitts': ['KN'],
  'rep of montenegro': ['ME'],
  /* Somaliland is not an ISO country. Fez carries there and the parcel goes to
     the code the world files it under, which is Somalia's. */
  'rep of somaliland': ['SO'],
  'rep of moldova': ['MD'],
  'rep of nauru': ['NR'],
  'rep of serbia': ['RS'],
  'rep of yemen': ['YE'],
  'russian federation': ['RU'],
  'saint helena': ['SH'],
  'st maarten': ['SX'],
  'st vincent': ['VC'],
  'tahiti': ['PF'],
  'the netherlands': ['NL'],
  'the philippines': ['PH'],
  'united states of america': ['US'],
  'republic of benin': ['BJ'],
  'usa': ['US'],
  'us a': ['US'],
  'america': ['US'],
  'uk': ['GB'],
  'great britain': ['GB'],
  'britain': ['GB'],
  'uae': ['AE'],
  'emirates': ['AE'],
  'ivory coast': ['CI'],
  'boliva': ['BO'],
  'antigua': ['AG'],
  'canary island': ['ES'],
  'bosnia and herzegovina': ['BA'],
  'holland': ['NL'],
  'burma': ['MM'],
  'swaziland': ['SZ'],
  'macedonia': ['MK'],
  'czech': ['CZ'],
  'south korea': ['KR'],
  'north korea': ['KP'],
  'vatican': ['VA'],
  'russia': ['RU'],
  'syria': ['SY'],
  'iran': ['IR'],
  'laos': ['LA'],
  'moldova': ['MD'],
  'tanzania': ['TZ'],
  'venezuela': ['VE'],
  'brunei': ['BN'],
  'cape verde': ['CV'],
  'east timor': ['TL'],
  'europe': EUROPE,
};

/** name -> codes, generated once from the runtime's own country names and then
 *  overlaid with the aliases above. */
const BY_NAME: Map<string, string[]> = (() => {
  const map = new Map<string, string[]>();
  let display: Intl.DisplayNames | null = null;
  try {
    display = new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    /* A runtime without the region data still gets the aliases below, so an
       export catalogue degrades to a short list rather than to nothing. */
    display = null;
  }
  if (display) {
    for (const code of ISO_CODES) {
      let name: string | undefined;
      try {
        name = display.of(code);
      } catch {
        name = undefined;
      }
      /* `of()` echoes the code back when it has no name for it, which is not a
         name and must not become a key. */
      if (!name || name === code) continue;
      const key = fold(name);
      if (key !== '' && !map.has(key)) map.set(key, [code]);
    }
  }
  for (const [name, codes] of Object.entries(ALIASES)) map.set(fold(name), codes);
  return map;
})();

/** ISO codes a published place name stands for. Empty when we do not know it —
 *  which keeps an unrecognised destination out of every shopper's country list
 *  instead of into the wrong one. */
export function countryCodesFor(place: string): string[] {
  return BY_NAME.get(fold(place)) ?? [];
}

function readRows(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

function readId(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isInteger(n) ? n : null;
}

export function createFezExports(
  client: FezClient,
  toMinor: (v: unknown) => number | null,
): ProviderExports {
  return {
    async catalogue(): Promise<ExportCatalogue> {
      const res = await client.call('GET', '/orders/export-locations');
      const data = (res.data ?? {}) as Record<string, unknown>;

      const destinations: ExportDestination[] = readRows(data.exportLocations).flatMap((row) => {
        const id = readId(row.id);
        const name = typeof row.name === 'string' ? row.name : '';
        /* Both or neither: a row with no id cannot be quoted and a row with no
           name cannot be matched to a country, so neither is worth carrying. */
        if (id === null || name === '') return [];
        const parsed = parseDestinationName(name);
        return [{ id, name, place: parsed.place, countryCodes: countryCodesFor(parsed.place), minKg: parsed.minKg, maxKg: parsed.maxKg }];
      });

      const weights: ExportWeight[] = readRows(data.exportWeights).flatMap((row) => {
        const id = readId(row.id);
        const name = typeof row.name === 'string' ? row.name : '';
        if (id === null || name === '') return [];
        const parsed = parseWeightName(name);
        return [{ id, name, minKg: parsed.minKg, maxKg: parsed.maxKg }];
      });

      if (destinations.length === 0) {
        throw new LogisticsError('bad_response', 'Fez Delivery published no export destinations');
      }
      return { destinations, weights };
    },

    async quote(a) {
      /*
       * POST, THOUGH THE DOCUMENTATION'S HEADING SAYS GET. Fez's own runnable
       * sample for this endpoint sets `CURLOPT_CUSTOMREQUEST => 'POST'` and
       * sends a JSON body, and a GET with a body is not a thing the fetch
       * standard will send. The sample is the half that was executed.
       */
      const res = await client.call('POST', '/orders/export-price', {
        exportLocationId: a.destinationId,
        weightId: a.weightId,
        /* NORMALISED THE SAME WAY THE DOMESTIC CALL NORMALISES IT — Fez wants
           its own state spelling ("FCT", not "Federal Capital Territory"), and
           an export quote that skipped that would refuse on exactly the
           addresses the domestic one accepts. */
        ...(a.pickUpState ? { pickUpState: fezStateName(a.pickUpState) } : {}),
      });
      const data = (res.data ?? {}) as Record<string, unknown>;
      /* The discounted rate is what is actually charged when Fez is running one,
         and equals `price` when it is not. Reading `price` first would quietly
         overcharge the shopper for our own discount. */
      const amountMinor = toMinor(data.discountedRate) ?? toMinor(data.price);
      if (amountMinor === null) {
        throw new LogisticsError('bad_response', 'Fez Delivery returned no export price');
      }
      return { amountMinor };
    },
  };
}

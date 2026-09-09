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

/** `"0 - 2"` is a RANGE: 2 kg is the bracket's CEILING, not a floor. */
export function parseWeightName(name: string): { minKg: number | null; maxKg: number | null } {
  const m = /^\s*([\d.]+)\s*-\s*([\d.]+)\s*$/.exec(name);
  if (!m) return { minKg: null, maxKg: null };
  const min = Number(m[1]);
  const max = Number(m[2]);
  return { minKg: Number.isFinite(min) ? min : null, maxKg: Number.isFinite(max) ? max : null };
}

/**
 * The countries behind Fez's place names.
 *
 * FEZ PUBLISHES NAMES AND WE MATCH ON COUNTRY CODES, so something has to join
 * them, and a hand-written table is the honest version: an unmapped name maps
 * to NOTHING and is offered to nobody, rather than being guessed at and sold.
 *
 * "EUROPE" IS NOT A COUNTRY, and that is why the values are lists. Fez sells
 * one row covering the continent, so every code below resolves to it — the
 * United Kingdom and Ireland excepted, which Fez lists separately and which
 * therefore must not be swallowed by the regional row.
 *
 * Codes beyond what Fez publishes today are deliberately present: the table is
 * keyed by what a courier might name, so a destination Fez adds next month
 * resolves without a deploy.
 */
const EUROPE = [
  'AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR',
  'HU', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE',
  'SI', 'SK',
];

const COUNTRY_CODES: Record<string, string[]> = {
  'canada': ['CA'],
  'united kingdom': ['GB'],
  'uk': ['GB'],
  'great britain': ['GB'],
  'united states': ['US'],
  'usa': ['US'],
  'europe': EUROPE,
  'ghana': ['GH'],
  'united arab emirates': ['AE'],
  'uae': ['AE'],
  "cote d'ivoire": ['CI'],
  'côte d’ivoire': ['CI'],
  'ivory coast': ['CI'],
  'ireland': ['IE'],
  'australia': ['AU'],
  'china': ['CN'],
  'gabon': ['GA'],
  'gambia': ['GM'],
  'guinea': ['GN'],
  'niger': ['NE'],
  'liberia': ['LR'],
  'lebanon': ['LB'],
  'india': ['IN'],
  /* Not on Fez's published list today, and here so that the day one appears it
     is already understood. An absent name costs a deploy; a spare one costs
     nothing. */
  'benin': ['BJ'],
  'cameroon': ['CM'],
  'egypt': ['EG'],
  'kenya': ['KE'],
  'morocco': ['MA'],
  'rwanda': ['RW'],
  'senegal': ['SN'],
  'sierra leone': ['SL'],
  'south africa': ['ZA'],
  'tanzania': ['TZ'],
  'togo': ['TG'],
  'uganda': ['UG'],
  'saudi arabia': ['SA'],
  'qatar': ['QA'],
  'turkey': ['TR'],
  'japan': ['JP'],
  'malaysia': ['MY'],
  'singapore': ['SG'],
  'new zealand': ['NZ'],
};

/** ISO codes a published place name stands for. Empty when we do not know it —
 *  which keeps an unrecognised destination out of every shopper's country list
 *  instead of into the wrong one. */
export function countryCodesFor(place: string): string[] {
  return COUNTRY_CODES[place.trim().toLowerCase()] ?? [];
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

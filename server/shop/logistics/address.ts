import { LogisticsError } from './port';
import type { ShipFrom } from './port';

/**
 * The fields a courier cannot collect without. `email` and `line2` are not on
 * it: both providers treat them as optional and refusing over a missing second
 * address line would be pedantry with a shop's dispatch behind it.
 *
 * HERE RATHER THAN IN `routes.ts`, where it began, because two callers now ask
 * the same question — the settings patch and `diagnostics.ts` — and this is a
 * fact about a `ShipFrom`, not about HTTP.
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

export interface RecipientAddress {
  name: string; phone: string | null; email: string | null; line1: string; line2: string | null;
  city: string; region: string; postalCode: string | null; countryCode: string;
}

const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** Narrow the opaque shipping_address jsonb (shared/commerce/events.ts AddressSnapshot). */
export function readShippingAddress(raw: Record<string, unknown>): RecipientAddress {
  const name = s(raw.name), line1 = s(raw.line1), city = s(raw.city);
  const countryCode = s(raw.countryCode) ?? s(raw.country) ?? 'NG';
  const missing = [!name && 'name', !line1 && 'line1', !city && 'city'].filter(Boolean) as string[];
  if (missing.length > 0) {
    throw new LogisticsError('address_incomplete', `This order's delivery address has no ${missing.join(', ')}`, { detail: missing });
  }
  return {
    name: name!, line1: line1!, city: city!, countryCode: countryCode.toUpperCase(),
    line2: s(raw.line2), region: s(raw.region) ?? '', postalCode: s(raw.postalCode) ?? s(raw.postal_code),
    phone: s(raw.phone), email: s(raw.email),
  };
}

export function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '-', lastName: '-' };
  if (parts.length === 1) return { firstName: parts[0]!, lastName: parts[0]! };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(' ') };
}

/** Nigerian numbers to E.164; anything else only if it already carries a country code. */
export function toE164(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits.length >= 8 ? digits : null;
  if (/^0\d{10}$/.test(digits)) return `+234${digits.slice(1)}`;
  if (/^234\d{10}$/.test(digits)) return `+${digits}`;
  return null;
}

const FCT = /^(abuja|fct|federal capital territory|abuja fct|fct abuja|abuja \(fct\))$/i;
/**
 * Fez wants exactly one of its 37 state names; Abuja is FCT there.
 *
 * Title-casing every word is all the normalisation this needs: "akwa ibom"
 * becomes "Akwa Ibom" from the word-boundary pass alone, and every other state
 * name Fez accepts is title case too. (There WAS a trailing
 * `.replace(/\bIbom\b/i, 'Ibom')` here, which could only ever run after the
 * title-casing had already produced "Ibom" — a no-op that read like a rule.)
 */
export function fezStateName(region: string): string {
  const t = region.trim();
  if (FCT.test(t)) return 'FCT';
  return t.replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * The 37 names Terminal accepts for Nigeria, read from its own
 * `GET /states?country_code=NG` on 2026-09-07 against the sandbox.
 *
 * ═══ TERMINAL CALLS THE CAPITAL TERRITORY "Abuja". FEZ CALLS IT "FCT". ═══
 * The two couriers disagree about the one region whose name is genuinely
 * contested, and in opposite directions, so neither mapping can be shared.
 * Sending `FCT` here is not a near miss: Terminal answers
 * `400 Delivery Address - Invalid state, please select a state from the list
 * of states` and the whole quote fails, which is how this was found.
 *
 * Every other one of the 37 is the ordinary spelling that title-casing already
 * produces (Akwa Ibom, Cross River, Nasarawa...), so the capital territory is
 * the only name this has to translate. An unrecognised region is passed
 * through in title case rather than guessed at, so Terminal's own refusal —
 * which lists every name it accepts — reaches the operator instead of a
 * silent substitution.
 */
export function terminalStateName(region: string): string {
  const t = region.trim().replace(/\s+/g, ' ');
  if (FCT.test(t)) return 'Abuja';
  return t.replace(/\b\w/g, (c) => c.toUpperCase());
}

const CAPITAL_ZIP: Record<string, string> = {
  fct: '900001', abuja: '900001', lagos: '100001', rivers: '500001', kano: '700001', oyo: '200001', kaduna: '800001',
  enugu: '400001', delta: '320001', 'akwa ibom': '520001', anambra: '420001', edo: '300001', ogun: '110001', plateau: '930001',
  imo: '460001', abia: '440001', 'cross river': '540001', kwara: '240001', ondo: '340001', osun: '230001', ekiti: '360001',
  benue: '970001', niger: '920001', kogi: '260001', bauchi: '740001', borno: '600001', sokoto: '840001', katsina: '820001',
  jigawa: '720001', kebbi: '860001', zamfara: '880001', yobe: '620001', gombe: '760001', adamawa: '640001', taraba: '660001',
  nasarawa: '960001', ebonyi: '480001', bayelsa: '560001',
};
/** Terminal requires a postal code; Nigerian orders often have none. */
export function zipFor(postalCode: string | null, region: string): string {
  if (postalCode && postalCode.trim() !== '') return postalCode.trim();
  return CAPITAL_ZIP[region.trim().toLowerCase()] ?? '100001';
}

export function oneLine(a: { line1: string; line2: string | null; city: string }): string {
  return [a.line1, a.line2, a.city].filter((p) => p && p.trim() !== '').join(', ');
}

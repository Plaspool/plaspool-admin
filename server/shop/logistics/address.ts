import { LogisticsError } from './port';

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
/** Fez wants exactly one of its 37 state names; Abuja is FCT there. */
export function fezStateName(region: string): string {
  const t = region.trim();
  if (FCT.test(t)) return 'FCT';
  return t.replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bIbom\b/i, 'Ibom');
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

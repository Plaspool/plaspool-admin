import type { ParcelLine } from './port';

export function totalGrams(lines: readonly ParcelLine[]): number {
  return lines.reduce((sum, l) => sum + (l.weightGrams == null ? 0 : l.weightGrams * l.qty), 0);
}
export function missingWeights(lines: readonly ParcelLine[]): ParcelLine[] {
  const seen = new Set<string>();
  return lines.filter((l) => l.weightGrams == null && !seen.has(l.variantId) && seen.add(l.variantId));
}
/** Fez takes whole kilograms and prices 0–5 kg as one band; never send 0. */
export function fezKg(grams: number): number { return Math.max(1, Math.ceil(grams / 1000)); }
/** Terminal takes kilograms per item; three decimals, floored at 10 g. */
export function terminalItemKg(grams: number): number { return Math.max(0.01, Math.round(grams) / 1000); }
export function declaredValueMinor(lines: readonly ParcelLine[]): number {
  return lines.reduce((sum, l) => sum + l.unitMinor * l.qty, 0);
}

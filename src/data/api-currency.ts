/**
 * The admin's half of the published multipliers (migration 1140) —
 * `server/shop/currency/routes.ts`.
 *
 * NAIRA IS THE ONLY REAL PRICE. Every other currency is a MULTIPLIER — units
 * of that currency per one naira — which the storefront applies for display;
 * a non-naira amount only becomes real money when the payment link is made.
 *
 * A MULTIPLIER IS A STRING ON THE WIRE, BOTH WAYS. `"0.008496176720"` is
 * `multiplier_e12` printed verbatim, and a JSON number would let a parser
 * round it. So every write below sends the text the owner typed, trimmed,
 * and never `Number(...)` of it — the server parses it with the same
 * `parseMultiplier` this screen validates with.
 *
 * A SEPARATE MODULE, not a block in `api-shop.ts`, for the reason that file
 * gives about `api.ts`: a file several sessions append to loses blocks.
 */
import { apiFetch } from './api';

export type CurrencySource = 'feed' | 'manual';

/** Why a currency is not offered to shoppers — `null` when it is. */
export type NotOfferedReason = 'disabled' | 'no_rate' | 'stale' | 'no_gateway' | 'unknown_currency';

export interface CurrencyRow {
  code: string;
  exponent: number | null;
  /** The shop's own currency (naira): always on, multiplier exactly 1. */
  store: boolean;
  enabled: boolean;
  /** Twelve fractional digits, verbatim. `null` = no rate yet. */
  multiplier: string | null;
  source: CurrencySource | null;
  updatedAt: number | null;
  ageHours: number | null;
  /** Some payment gateway can charge it. */
  gateway: boolean;
  offered: boolean;
  reason: NotOfferedReason | null;
}

/** `GET` / `PATCH /shop/admin/payments/currency` and both multiplier writes answer this. */
export interface CurrencySettings {
  storeCurrency: string;
  revision: number;
  stalenessHours: number;
  fallbackCurrency: string;
  countries: Record<string, string>;
  known: string[];
  offered: string[];
  currencies: CurrencyRow[];
}

export interface VariantMultiplier {
  currency: string;
  multiplier: string;
  updatedAt: number;
}

const BASE = '/shop/admin';
const seg = (value: string): string => encodeURIComponent(value);

export const currencyApi = {
  async getSettings(signal?: AbortSignal): Promise<CurrencySettings> {
    return apiFetch<CurrencySettings>(`${BASE}/payments/currency`, {
      subject: 'Currency settings',
      signal,
    });
  },

  /** CAS on `revision`: a lost race is a 409 `StaleWriteError`. The store currency is always kept on server-side. */
  async setEnabled(enabled: string[], revision: number): Promise<CurrencySettings> {
    return apiFetch<CurrencySettings>(`${BASE}/payments/currency`, {
      method: 'PATCH',
      body: { enabled, revision },
      subject: 'Currency settings',
    });
  },

  /** The owner's own rate. Never goes stale; the daily rate never replaces it. */
  async setMultiplier(code: string, multiplier: string): Promise<CurrencySettings> {
    return apiFetch<CurrencySettings>(`${BASE}/payments/currency/${seg(code)}/multiplier`, {
      method: 'PUT',
      body: { multiplier },
      id: code,
      subject: 'Currency',
    });
  },

  /** Forget the rate; the next daily run fills it in again. */
  async clearMultiplier(code: string): Promise<CurrencySettings> {
    return apiFetch<CurrencySettings>(`${BASE}/payments/currency/${seg(code)}/multiplier`, {
      method: 'DELETE',
      id: code,
      subject: 'Currency',
    });
  },

  async getVariantMultipliers(variantId: string, signal?: AbortSignal): Promise<VariantMultiplier[]> {
    const res = await apiFetch<{ items: VariantMultiplier[] }>(
      `${BASE}/variants/${seg(variantId)}/multipliers`,
      { id: variantId, subject: 'Variant', signal },
    );
    return res.items;
  },

  async setVariantMultiplier(
    variantId: string,
    code: string,
    multiplier: string,
  ): Promise<VariantMultiplier[]> {
    const res = await apiFetch<{ items: VariantMultiplier[] }>(
      `${BASE}/variants/${seg(variantId)}/multipliers/${seg(code)}`,
      { method: 'PUT', body: { multiplier }, id: variantId, subject: 'Variant' },
    );
    return res.items;
  },

  async clearVariantMultiplier(variantId: string, code: string): Promise<VariantMultiplier[]> {
    const res = await apiFetch<{ items: VariantMultiplier[] }>(
      `${BASE}/variants/${seg(variantId)}/multipliers/${seg(code)}`,
      { method: 'DELETE', id: variantId, subject: 'Variant' },
    );
    return res.items;
  },
};

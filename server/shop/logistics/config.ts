import { z } from 'zod';

/**
 * Logistics' own environment, read lazily and validated here rather than in
 * server/env.ts, for the reason payments/config.ts gives: getEnv() throws when
 * anything declared is missing and runs on the boot path of the whole app. A
 * deployment with no courier must still serve everything else — it simply
 * reports both couriers as "not configured".
 *
 * Base URLs DEFAULT TO THE SANDBOXES. A forgotten variable can never book a
 * real courier or spend real money.
 */
export const FEZ_SANDBOX_URL = 'https://apisandbox.fezdelivery.co/v1';
export const FEZ_LIVE_URL = 'https://api.fezdelivery.co/v1';
export const TERMINAL_SANDBOX_URL = 'https://sandbox.terminal.africa/v1';
export const TERMINAL_LIVE_URL = 'https://api.terminal.africa/v1';

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const opt = () => z.preprocess(blankToUndefined, z.string().min(1).optional());

const Schema = z.object({
  FEZ_USER_ID: opt(),
  FEZ_PASSWORD: opt(),
  FEZ_SECRET_KEY: opt(),
  FEZ_BASE_URL: opt(),
  TERMINAL_SECRET_KEY: opt(),
  TERMINAL_BASE_URL: opt(),
});

export interface FezEnv { userId: string; password: string; secretKey: string | null; baseUrl: string }
export interface TerminalEnv { secretKey: string; baseUrl: string }
export interface LogisticsEnv { fez: FezEnv | null; terminal: TerminalEnv | null }

let cached: LogisticsEnv | null = null;

const trimSlash = (u: string) => u.replace(/\/+$/, '');

export function logisticsEnv(): LogisticsEnv {
  if (cached) return cached;
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    /* NAMES ONLY — never the value. */
    throw new Error(`Invalid logistics environment: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }
  const e = parsed.data;
  cached = {
    fez: e.FEZ_USER_ID && e.FEZ_PASSWORD
      ? { userId: e.FEZ_USER_ID, password: e.FEZ_PASSWORD, secretKey: e.FEZ_SECRET_KEY ?? null, baseUrl: trimSlash(e.FEZ_BASE_URL ?? FEZ_SANDBOX_URL) }
      : null,
    terminal: e.TERMINAL_SECRET_KEY
      ? { secretKey: e.TERMINAL_SECRET_KEY, baseUrl: trimSlash(e.TERMINAL_BASE_URL ?? TERMINAL_SANDBOX_URL) }
      : null,
  };
  return cached;
}

/** Test-only: drop the memoised environment between cases. */
export function resetLogisticsEnv(): void { cached = null; }

export function environmentOf(baseUrl: string, liveUrl: string): 'sandbox' | 'live' {
  return trimSlash(baseUrl) === trimSlash(liveUrl) ? 'live' : 'sandbox';
}

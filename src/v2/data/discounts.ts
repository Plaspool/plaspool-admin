import { apiFetch } from '../../data/api';
import { marketingApi, type Discount } from '../../data/api-marketing';

/**
 * The write half of the discounts client.
 *
 * `marketingApi` already carries `listDiscounts` — written when the model
 * shipped ahead of its screen — but no create and no patch, because until now
 * nothing could make one. The two writes live here rather than being appended
 * to `src/data/api-marketing.ts` so that reverting to v1 is still a one-line
 * change to `index.html` and not a diff to walk back through the data layer.
 *
 * ── WHAT THE SERVER WILL AND WILL NOT ACCEPT ───────────────────────────────
 *
 * CREATE IS A DISCRIMINATED UNION, not a wide object. The `percent` branch
 * carries `percentBps` and MUST NOT carry `amountMinor` or `currency`; the
 * `fixed_amount` branch is the mirror and its `currency` is required beside the
 * amount. The route's schema is `.strict()`, so sending a key from the wrong
 * branch is a 400 rather than a field quietly ignored — which is why the two
 * drafts below are separate types and never merged for convenience.
 *
 * PATCH CANNOT CHANGE WHAT A CODE IS WORTH. There is no `code`, `kind`,
 * `percentBps`, `amountMinor` or `currency` in the patch body, and the server
 * refuses any of them by name. A code is printed on a flyer and read out on a
 * podcast; every copy of it is a promise already made. To change the value you
 * disable one code and create another, and the two rows record what each was
 * worth. The UI must not offer an edit affordance it cannot honour.
 */

const BASE = '/marketing';

/** Minor units, always — 500 kobo and never ₦5. `shared/commerce/money.ts` is
 *  the whole application's convention and the column enforces it. */
export interface PercentDraft {
  kind: 'percent';
  code: string;
  /** 1–10000. 10000 is 100%. */
  percentBps: number;
  startsAt?: number | null;
  endsAt?: number | null;
  maxRedemptions?: number | null;
  note?: string | null;
}

export interface FixedDraft {
  kind: 'fixed_amount';
  code: string;
  amountMinor: number;
  /** Uppercase ISO-4217. Lower case is a measured 500 on the shop side, so the
   *  form uppercases before it gets here. */
  currency: string;
  startsAt?: number | null;
  endsAt?: number | null;
  maxRedemptions?: number | null;
  note?: string | null;
}

export type DiscountDraft = PercentDraft | FixedDraft;

export const discountsApi = {
  list: (signal?: AbortSignal) => marketingApi.listDiscounts(signal),

  async create(draft: DiscountDraft): Promise<Discount> {
    const res = await apiFetch<{ discount: Discount }>(`${BASE}/discounts`, {
      method: 'POST',
      body: draft,
      subject: 'Discount',
    });
    return res.discount;
  },

  /**
   * CAS, and `expectedRevision` is REQUIRED rather than optional: every screen
   * that changes a code has read one first, and without the token a second tab
   * silently overwrites the first.
   */
  async setStatus(
    id: string,
    expectedRevision: number,
    status: 'active' | 'disabled',
  ): Promise<Discount> {
    const res = await apiFetch<{ discount: Discount }>(`${BASE}/discounts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { expectedRevision, status },
      id,
      subject: 'Discount',
    });
    return res.discount;
  },
};

/* ─────────────────────────────────────────────────────────── form helpers ── */

/** The code the server will accept: 3–32 chars, starting alphanumeric, then
 *  alphanumerics, hyphens and underscores. Mirrored from the route so the form
 *  can refuse locally instead of round-tripping to a 400. */
export const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

export function normaliseCode(input: string): string {
  return input.trim().toUpperCase();
}

/** A–Z and 2–9 only: no O/0 and no I/1, because these get read down a phone
 *  line and written on a flyer. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomCode(length = 12): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** `"20"` → 2000 bps. Refuses anything outside 1–100 and anything that is not a
 *  number, so the caller never has to guess whether NaN reached the wire. */
export function parsePercentToBps(input: string): number | null {
  const n = Number(input.trim());
  if (!Number.isFinite(n)) return null;
  const bps = Math.round(n * 100);
  if (bps < 1 || bps > 10_000) return null;
  return bps;
}

/** A local `datetime-local` value → epoch ms, or null for an empty field. An
 *  empty start means "as soon as it is active" and an empty end means "until
 *  somebody turns it off"; both are legal and both are null on the wire. */
export function parseWhen(input: string): number | null {
  if (!input) return null;
  const ms = new Date(input).getTime();
  return Number.isFinite(ms) ? ms : null;
}

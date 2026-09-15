/**
 * The mystery box's page (migration 1260; owner's decisions 2026-09-15): the
 * words the owner writes for "How it works", and the cues that tell a shopper
 * to buy while the box is still here: "Only 22 left", "Just dropped 2 hours
 * ago", "5 bought in the last 24 hours", "Sold out".
 *
 * BROWSER-SAFE. Imports nothing. The server resolves the cues for the storefront
 * with `resolveBoxCues`, and the admin runs the same function for its live
 * preview, so what the owner previews is what the shop shows.
 *
 * THE STOREFRONT OWNS NO RULES. It renders the `BoxCue[]` it is given, in order.
 * Thresholds, time windows and wording all live here and in Settings, the same
 * way a product's overview is resolved before it reaches the wire.
 */

export interface BoxHowItWorks {
  /** The heading, e.g. "How it works". */
  title: string;
  /** One sentence each, in order. Empty hides the block on the shop. */
  steps: string[];
}

export interface BoxCueSettings {
  /** "Only {count} left" once this many boxes or fewer can still be bought. */
  lowStock: { enabled: boolean; threshold: number; text: string };
  /** "Just dropped {time}" for this many hours after the box goes on sale. */
  justDropped: { enabled: boolean; hours: number; text: string };
  /** "{count} bought in the last 24 hours" once at least this many have sold. */
  sellingFast: { enabled: boolean; minimum: number; text: string };
  /** Shown instead of the others when no more boxes can be bought. */
  soldOut: { enabled: boolean; text: string };
}

export interface BoxPage {
  howItWorks: BoxHowItWorks;
  cues: BoxCueSettings;
}

export type BoxCueKind = 'just_dropped' | 'sold_out' | 'low_stock' | 'selling_fast';

/** One ready-to-show line. `kind` is for styling only; `text` is final. */
export interface BoxCue {
  kind: BoxCueKind;
  text: string;
}

export const BOX_PAGE_DEFAULTS: BoxPage = {
  howItWorks: {
    title: 'How it works',
    steps: [
      'Every box is made up of items we have in stock.',
      'You won’t know what’s inside until it arrives.',
      'Once it’s delivered, your order page lists everything that was in the box.',
    ],
  },
  cues: {
    lowStock: { enabled: true, threshold: 25, text: 'Only {count} left' },
    justDropped: { enabled: true, hours: 48, text: 'Just dropped {time}' },
    sellingFast: { enabled: true, minimum: 3, text: '{count} bought in the last 24 hours' },
    soldOut: { enabled: true, text: 'Sold out. New boxes are on the way.' },
  },
};

export const BOX_PAGE_LIMITS = {
  title: 80,
  steps: 8,
  step: 300,
  cueText: 120,
  threshold: 100_000,
  hours: 24 * 30,
  minimum: 100_000,
} as const;

const str = (v: unknown, fallback: string, max: number): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : fallback;
const on = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const whole = (v: unknown, fallback: number, max: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 ? Math.min(v, max) : fallback;
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * The stored jsonb, made whole. A missing or malformed key reads as its default
 * rather than throwing: `{}` (the column default) is "everything as shipped", and
 * a key added later reads as its default on every row written before it existed.
 */
export function readBoxPage(raw: unknown): BoxPage {
  const d = BOX_PAGE_DEFAULTS;
  const root = obj(typeof raw === 'string' ? safeJson(raw) : raw);
  const how = obj(root.howItWorks);
  const cues = obj(root.cues);
  const low = obj(cues.lowStock);
  const drop = obj(cues.justDropped);
  const fast = obj(cues.sellingFast);
  const out = obj(cues.soldOut);
  return {
    howItWorks: {
      title: str(how.title, d.howItWorks.title, BOX_PAGE_LIMITS.title) || d.howItWorks.title,
      steps: Array.isArray(how.steps)
        ? how.steps
            .filter((s): s is string => typeof s === 'string')
            .map((s) => s.trim().slice(0, BOX_PAGE_LIMITS.step))
            .filter(Boolean)
            .slice(0, BOX_PAGE_LIMITS.steps)
        : [...d.howItWorks.steps],
    },
    cues: {
      lowStock: {
        enabled: on(low.enabled, d.cues.lowStock.enabled),
        threshold: whole(low.threshold, d.cues.lowStock.threshold, BOX_PAGE_LIMITS.threshold),
        text: str(low.text, d.cues.lowStock.text, BOX_PAGE_LIMITS.cueText),
      },
      justDropped: {
        enabled: on(drop.enabled, d.cues.justDropped.enabled),
        hours: whole(drop.hours, d.cues.justDropped.hours, BOX_PAGE_LIMITS.hours),
        text: str(drop.text, d.cues.justDropped.text, BOX_PAGE_LIMITS.cueText),
      },
      sellingFast: {
        enabled: on(fast.enabled, d.cues.sellingFast.enabled),
        minimum: whole(fast.minimum, d.cues.sellingFast.minimum, BOX_PAGE_LIMITS.minimum),
        text: str(fast.text, d.cues.sellingFast.text, BOX_PAGE_LIMITS.cueText),
      },
      soldOut: {
        enabled: on(out.enabled, d.cues.soldOut.enabled),
        text: str(out.text, d.cues.soldOut.text, BOX_PAGE_LIMITS.cueText),
      },
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const HOUR = 60 * 60 * 1000;

/** "moments ago", "12 minutes ago", "an hour ago", "5 hours ago", "yesterday", "3 days ago". */
export function relativeTime(elapsedMs: number): string {
  const minutes = Math.floor(Math.max(0, elapsedMs) / 60_000);
  if (minutes < 2) return 'moments ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 2) return 'an hour ago';
  if (hours < 24) return `${hours} hours ago`;
  if (hours < 48) return 'yesterday';
  return `${Math.floor(hours / 24)} days ago`;
}

const count = (n: number): string => new Intl.NumberFormat('en').format(n);

const fill = (text: string, vars: Record<string, string>): string =>
  text.replace(/\{(count|time)\}/g, (all, key: string) => vars[key] ?? all).trim();

/**
 * Which cues show right now, in the order the shop should show them.
 *
 * `available` is how many more boxes can be bought (null: not known, which shows
 * neither "left" nor "sold out"). A cue whose wording is blank never shows.
 */
export function resolveBoxCues(
  page: BoxPage,
  facts: { available: number | null; soldLast24Hours: number; onSaleSince: number | null; now: number },
): BoxCue[] {
  const { cues } = page;
  const out: BoxCue[] = [];
  const push = (kind: BoxCueKind, text: string) => {
    if (text) out.push({ kind, text });
  };
  const { available, soldLast24Hours, onSaleSince, now } = facts;

  if (
    cues.justDropped.enabled &&
    onSaleSince !== null &&
    now >= onSaleSince &&
    now - onSaleSince < cues.justDropped.hours * HOUR
  ) {
    push('just_dropped', fill(cues.justDropped.text, { time: relativeTime(now - onSaleSince) }));
  }
  if (available === 0) {
    if (cues.soldOut.enabled) push('sold_out', fill(cues.soldOut.text, {}));
    return out;
  }
  if (cues.lowStock.enabled && available !== null && available > 0 && available <= cues.lowStock.threshold) {
    push('low_stock', fill(cues.lowStock.text, { count: count(available) }));
  }
  if (cues.sellingFast.enabled && soldLast24Hours >= cues.sellingFast.minimum) {
    push('selling_fast', fill(cues.sellingFast.text, { count: count(soldLast24Hours) }));
  }
  return out;
}

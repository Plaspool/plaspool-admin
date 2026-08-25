import { safeFormatMinor } from '../../data/api-shop';
import type { OrderStatus, ProductStatus } from '../../data/api-shop';
import type { BadgeTone } from '../ui/primitives';

/**
 * Presentation helpers. Money formatting comes from the data layer rather than
 * being reimplemented here — `safeFormatMinor` already knows that this app
 * counts in minor units at 100 per naira, and a second implementation is how a
 * screen ends up printing ₦300,000 for a ₦3,000 delivery fee.
 */

export const money = safeFormatMinor;

/** Absolute and short: "21 Aug", or "21 Aug 2025" once the year is not this
 *  one. A relative "3 days ago" is friendlier and useless in a column you are
 *  scanning to find the order somebody phoned about. */
export function shortDate(epochMs: number | null | undefined): string {
  if (!epochMs) return '—';
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return '—';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function dateTime(epochMs: number | null | undefined): string {
  if (!epochMs) return '—';
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Sentence case from a snake_case enum value, for a label nobody wrote by
 *  hand. `awaiting_payment` → `Awaiting payment`. */
export function humanise(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * ORDER STATUS → BADGE TONE.
 *
 * The mapping is opinionated and it is the reason the status column is worth
 * scanning: `ok` is reserved for a terminal good state, `warn` means somebody
 * has to do something, `critical` means money moved the wrong way, and neutral
 * means nothing is owed. An enum rendered in one colour is a column of words.
 */
export function orderTone(status: OrderStatus): BadgeTone {
  switch (status) {
    case 'fulfilled':
      return 'ok';
    case 'paid':
      return 'info';
    /* PENDING IS A WARNING AND NOT A NEUTRAL. It means the shopper reached
       checkout and the money has not landed — the one row on this screen that
       is still costing somebody something. */
    case 'pending':
      return 'warn';
    case 'refunded':
    case 'partially_refunded':
      return 'critical';
    case 'cancelled':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export function productTone(status: ProductStatus): BadgeTone {
  switch (status) {
    case 'active':
      return 'ok';
    case 'draft':
      return 'warn';
    case 'archived':
    case 'trash':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/** The address line a list row can show without the detail view: city and
 *  region, which is what tells two orders from the same buyer apart. */
export function shortAddress(address: Record<string, unknown> | null | undefined): string {
  if (!address) return '—';
  const city = typeof address.city === 'string' ? address.city : '';
  const region = typeof address.region === 'string' ? address.region : '';
  const parts = [city, region].filter(Boolean);
  return parts.length ? parts.join(', ') : '—';
}

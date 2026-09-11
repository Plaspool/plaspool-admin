import type {
  ManualCustomer,
  ManualOrderRevision,
  ManualOrderSnapshot,
  ManualPaymentMethod,
  ManualSalesChannel,
} from '../../data/api-shop';
import { humanise, money } from '../lib/format';

/**
 * MANUAL ORDERS — the words, the calendar arithmetic, and the edit-history
 * diff. Kept out of the screens so the form, the detail page and the tests all
 * read the same labels, and so the diff (the one piece of real logic here) can
 * be read on its own.
 */

/** A save or a void that lost the race to someone else's save (409). */
export const STALE_ORDER =
  'Someone else changed this order while you had it open. Reload to see their changes.';

/* ═══════════════════════════════════════════════════════════════ LABELS ══ */

/** In the order the select shows them — the common ones first. */
export const PAYMENT_METHOD_LABELS: Record<ManualPaymentMethod, string> = {
  flutterwave_link: 'Flutterwave payment link',
  paystack_link: 'Paystack payment link',
  bank_transfer: 'Bank transfer',
  cash: 'Cash',
  pos: 'POS / card machine',
  other: 'Other',
};

export const SALES_CHANNEL_LABELS: Record<ManualSalesChannel, string> = {
  walk_in: 'Walk-in',
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  phone: 'Phone call',
  website: 'Website',
  other: 'Other',
};

export const PAYMENT_METHODS = Object.keys(PAYMENT_METHOD_LABELS) as ManualPaymentMethod[];
export const SALES_CHANNELS = Object.keys(SALES_CHANNEL_LABELS) as ManualSalesChannel[];

/** A label for a value off the wire, which may be one this build never heard
 *  of — that shows as itself rather than as a blank. */
export function paymentMethodLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return PAYMENT_METHOD_LABELS[value as ManualPaymentMethod] ?? value;
}

export function salesChannelLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return SALES_CHANNEL_LABELS[value as ManualSalesChannel] ?? value;
}

/** Why a line could not be taken out of stock, for the warning after a save. */
export function stockReason(code: string | null | undefined): string {
  switch (code) {
    case 'not_enough_stock':
      return 'not enough in stock';
    case 'no_stock_record':
      return 'its stock isn’t tracked';
    case 'error':
    case undefined:
    case null:
    case '':
      return 'the stock count couldn’t be changed';
    default:
      return humanise(code).toLowerCase();
  }
}

/**
 * The status badge's words. A manual order is recorded already sent out, and
 * "cancelled" is what the server calls a voided one — so those two read in
 * the owner's words. Every online order keeps exactly the label it had.
 */
export function orderStatusLabel(order: { status: string; source?: string }): string {
  if (order.source === 'manual') {
    if (order.status === 'fulfilled') return 'Sent out';
    if (order.status === 'cancelled') return 'Voided';
  }
  return humanise(order.status);
}

/* ═════════════════════════════════════════════════════════════ CALENDAR ══ */

/**
 * THE DAY A SALE HAPPENED IS A LAGOS DAY.
 *
 * The form sends a bare `YYYY-MM-DD` and the server stores an instant. Read
 * back in the browser's own zone, an instant at midnight could land on the day
 * before for anyone west of it — so every conversion between the two runs in
 * the shop's zone. Midnight UTC and midnight Lagos are the same Lagos date,
 * which is what makes this safe whichever the server chose.
 */
const SHOP_TZ = 'Africa/Lagos';

const isoParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHOP_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Epoch ms → `YYYY-MM-DD`, in the shop's zone. */
export function isoDay(epochMs: number): string {
  const parts = isoParts.formatToParts(new Date(epochMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Today, as the date box wants it. Reads `Date.now()` so a test can pin it. */
export function todayIso(): string {
  return isoDay(Date.now());
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "9 Sep", or "9 Sep 2025" once the year is not this one. Spelled from the
 * Lagos calendar date by hand rather than by `Intl`'s `en-GB` short month,
 * which newer ICU data renders "Sept" — the same page would read differently
 * on two machines.
 */
export function dayLabel(epochMs: number | null | undefined): string {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return '—';
  const [year, month, day] = isoDay(epochMs).split('-');
  const label = `${Number(day)} ${MONTHS[Number(month) - 1] ?? month}`;
  return year === todayIso().slice(0, 4) ? label : `${label} ${year}`;
}

/* ═════════════════════════════════════════════════════════════════ DIFF ══ */

type SnapshotLine = NonNullable<ManualOrderSnapshot['lines']>[number];

/** "PLA Basic — Black", or just the title when the product has no options. */
export function lineLabel(line: {
  title?: string;
  sku?: string;
  optionValues?: Record<string, string>;
}): string {
  const options = Object.values(line.optionValues ?? {})
    .filter(Boolean)
    .join(' / ');
  const title = line.title || line.sku || 'Item';
  return options ? `${title} — ${options}` : title;
}

const text = (value: unknown): string =>
  typeof value === 'string' && value.trim() ? value.trim() : '—';

const clip = (value: string, max = 60): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

function addressText(addr: Record<string, unknown> | null | undefined): string {
  if (!addr) return '—';
  const pick = (k: string) => (typeof addr[k] === 'string' && addr[k] ? String(addr[k]) : null);
  const parts = [
    pick('line1'),
    pick('city'),
    pick('region'),
    pick('countryCode') ?? pick('country'),
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : '—';
}

/**
 * What changed between two saved states of a manual order, in plain words:
 * "Quantity of PLA Basic — Black: 2 → 3", "Paid by: Cash → Bank transfer".
 *
 * LINES ARE PAIRED BY VARIANT, AND BY OCCURRENCE WITHIN A VARIANT. The same
 * product may legitimately sit on two lines (two prices, say), so the second
 * Black spool in the old state is compared with the second one in the new
 * state rather than both with the first.
 *
 * Every read is defensive — see `ManualOrderSnapshot`.
 */
export function diffSnapshots(
  before: ManualOrderSnapshot,
  after: ManualOrderSnapshot,
  currency: string,
): string[] {
  const out: string[] = [];
  const cash = (minor: unknown) => (typeof minor === 'number' ? money(minor, currency) : '—');

  if (before.soldAt !== after.soldAt) {
    out.push(`Date sold: ${dayLabel(before.soldAt)} → ${dayLabel(after.soldAt)}`);
  }

  /* ── the lines ─────────────────────────────────────────────────────── */
  const group = (lines: SnapshotLine[] | undefined) => {
    const map = new Map<string, SnapshotLine[]>();
    for (const line of lines ?? []) {
      const list = map.get(line.variantId) ?? [];
      list.push(line);
      map.set(line.variantId, list);
    }
    return map;
  };
  const was = group(before.lines);
  const now = group(after.lines);
  const variants = [...new Set([...was.keys(), ...now.keys()])];
  for (const variantId of variants) {
    const a = was.get(variantId) ?? [];
    const b = now.get(variantId) ?? [];
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const old = a[i];
      const neu = b[i];
      if (old && !neu) {
        out.push(`Removed ${lineLabel(old)} (${old.qty} × ${cash(old.unitAmount)})`);
      } else if (!old && neu) {
        out.push(`Added ${lineLabel(neu)} (${neu.qty} × ${cash(neu.unitAmount)})`);
      } else if (old && neu) {
        const label = lineLabel(neu);
        if (old.qty !== neu.qty) out.push(`Quantity of ${label}: ${old.qty} → ${neu.qty}`);
        if (old.unitAmount !== neu.unitAmount) {
          out.push(`Price of ${label}: ${cash(old.unitAmount)} → ${cash(neu.unitAmount)}`);
        }
      }
    }
  }

  /* ── how it was paid ───────────────────────────────────────────────── */
  if ((before.paymentMethod ?? null) !== (after.paymentMethod ?? null)) {
    out.push(`Paid by: ${paymentMethodLabel(before.paymentMethod)} → ${paymentMethodLabel(after.paymentMethod)}`);
  }
  if (text(before.paymentReference) !== text(after.paymentReference)) {
    out.push(`Reference: ${text(before.paymentReference)} → ${text(after.paymentReference)}`);
  }
  if ((before.salesChannel ?? null) !== (after.salesChannel ?? null)) {
    out.push(
      `Came from: ${salesChannelLabel(before.salesChannel)} → ${salesChannelLabel(after.salesChannel)}`,
    );
  }

  /* ── who bought it, and where it went ──────────────────────────────── */
  const who: [keyof ManualCustomer, string][] = [
    ['name', 'Customer name'],
    ['email', 'Customer email'],
    ['phone', 'Customer phone'],
  ];
  for (const [key, label] of who) {
    const x = text(before.customer?.[key]);
    const y = text(after.customer?.[key]);
    if (x !== y) out.push(`${label}: ${x} → ${y}`);
  }
  const addrWas = addressText(before.address);
  const addrNow = addressText(after.address);
  if (addrWas !== addrNow) out.push(`Delivery address: ${addrWas} → ${addrNow}`);

  /* ── the money around the items ────────────────────────────────────── */
  const amounts: [keyof ManualOrderSnapshot, string][] = [
    ['shippingAmount', 'Delivery fee'],
    ['discountAmount', 'Discount'],
    ['taxAmount', 'Tax'],
  ];
  for (const [key, label] of amounts) {
    const x = (before[key] as number | undefined) ?? 0;
    const y = (after[key] as number | undefined) ?? 0;
    if (x !== y) out.push(`${label}: ${cash(x)} → ${cash(y)}`);
  }
  if (
    typeof before.grandTotal === 'number' &&
    typeof after.grandTotal === 'number' &&
    before.grandTotal !== after.grandTotal
  ) {
    out.push(`Total: ${cash(before.grandTotal)} → ${cash(after.grandTotal)}`);
  }

  /* ── the rest ──────────────────────────────────────────────────────── */
  if (text(before.note) !== text(after.note)) {
    out.push(`Note: ${clip(text(before.note))} → ${clip(text(after.note))}`);
  }
  if (
    typeof before.takeFromStock === 'boolean' &&
    typeof after.takeFromStock === 'boolean' &&
    before.takeFromStock !== after.takeFromStock
  ) {
    out.push(
      after.takeFromStock ? 'Now taken out of stock' : 'No longer taken out of stock',
    );
  }
  if (before.status !== after.status && after.status === 'cancelled') {
    out.push('Voided — no longer counts as a sale');
    if (text(after.voidReason) !== '—') out.push(`Reason: ${clip(text(after.voidReason))}`);
  }

  return out;
}

/** The headline of one history entry: "Recorded by Ada", "Edited by Ada". */
export function revisionHeadline(entry: ManualOrderRevision): string {
  const verb =
    entry.kind === 'created' ? 'Recorded' : entry.kind === 'voided' ? 'Voided' : 'Edited';
  const name = entry.editedBy?.name?.trim();
  return name ? `${verb} by ${name}` : verb;
}

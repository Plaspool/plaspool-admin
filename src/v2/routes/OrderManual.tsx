import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronDown, Minus, Plus, Receipt, X } from 'lucide-react';
import {
  parseMajor,
  plainMajor,
  shopApi,
  type ManualOrderInput,
  type ManualPaymentMethod,
  type ManualSalesChannel,
  type ShopManualOrderResult,
  type ShopOrderDetail,
} from '../../data/api-shop';
import { ApiError } from '../../data/errors';
import { useAsync } from '../lib/useAsync';
import { money } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button, Loading } from '../ui/primitives';
import { Card } from '../ui/Card';
import { Defs } from '../ui/Defs';
import { AffixField, Checkbox, SelectField, TextArea, TextField } from '../ui/Field';
import { useToast } from '../ui/Toast';
import { byName, countryName, HOME_COUNTRY, SHIPPABLE_COUNTRIES } from './countries';
import {
  isoDay,
  lineLabel,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  SALES_CHANNEL_LABELS,
  SALES_CHANNELS,
  STALE_ORDER,
  todayIso,
} from './manual-order-copy';
import { VariantPicker, type PickedVariant } from './VariantPicker';

/**
 * RECORD A SALE BY HAND — `/orders/new`, and the same form prefilled at
 * `/orders/:id/edit`.
 *
 * For money that came in outside the online checkout: a Flutterwave or
 * Paystack payment link, a transfer, cash. The owner's brief was VERY SIMPLE —
 * what was sold, the day, how it was paid, and a reference if there is one.
 * Everything else sits closed under Advanced, and all of it is optional.
 *
 * WHAT THE FORM SENDS IS WHAT THE SUMMARY SAYS. The total on the right is
 * computed from the same state `buildBody` reads, so the two cannot disagree.
 * Money is typed in naira and sent in kobo through `parseMajor`, the app's one
 * crossing of that line — never `× 100` on a float.
 *
 * A BOX LEFT EMPTY IS NOT SENT. Not as `''`, not as `0`: the key is absent. On
 * an edit (a PUT, which replaces the order's details) absent means cleared,
 * which is exactly what emptying a box should do.
 */

interface LineDraft {
  key: string;
  variantId: string;
  title: string;
  sku: string;
  optionValues: Record<string, string>;
  qty: string;
  /** Naira, as typed. Empty means "the current price" — the server fills it. */
  price: string;
  /** The catalogue price when the line was picked, for the live total while
   *  the box is empty. `null` on an edit, where the saved price is prefilled. */
  currentPrice: number | null;
  available: number | null;
}

interface Draft {
  soldAt: string;
  lines: LineDraft[];
  paymentMethod: ManualPaymentMethod | '';
  reference: string;
  takeFromStock: boolean;
  name: string;
  email: string;
  phone: string;
  channel: ManualSalesChannel | '';
  shipping: string;
  discount: string;
  tax: string;
  line1: string;
  city: string;
  region: string;
  countryCode: string;
  note: string;
}

const EMPTY: Omit<Draft, 'soldAt'> = {
  lines: [],
  paymentMethod: '',
  reference: '',
  takeFromStock: true,
  name: '',
  email: '',
  phone: '',
  channel: '',
  shipping: '',
  discount: '',
  tax: '',
  line1: '',
  city: '',
  region: '',
  countryCode: HOME_COUNTRY,
  note: '',
};

/** `28000.00` → `28000`: a whole-naira price reads as one in the box. */
const nairaText = (minor: number, currency: string) => plainMajor(minor, currency).replace(/\.0+$/, '');

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The form, refilled from a saved order. */
function draftFromOrder(detail: ShopOrderDetail): Draft {
  const { order, lines, manual } = detail;
  const currency = order.currency;
  const addr = order.shippingAddress ?? {};
  /* The detail carries no discount figure of its own, so it is what the
     parts add up to beyond the total. Never negative. */
  const discount =
    order.subtotal + order.shippingTotal + order.taxTotal + (order.addOnTotal ?? 0) - order.grandTotal;
  return {
    soldAt: isoDay(order.paidAt ?? order.placedAt),
    lines: lines.map((l) => ({
      key: l.id,
      variantId: l.variantId,
      title: l.title,
      sku: l.sku,
      optionValues: l.optionValues ?? {},
      qty: String(l.qty),
      price: nairaText(l.unitAmount, currency),
      currentPrice: null,
      available: null,
    })),
    paymentMethod: manual?.paymentMethod ?? '',
    reference: manual?.paymentReference ?? '',
    takeFromStock: manual?.stockTaken ?? true,
    name: manual?.customer?.name ?? '',
    email: manual?.customer?.email ?? '',
    phone: manual?.customer?.phone ?? '',
    channel: manual?.salesChannel ?? '',
    shipping: order.shippingTotal > 0 ? nairaText(order.shippingTotal, currency) : '',
    discount: discount > 0 ? nairaText(discount, currency) : '',
    tax: order.taxTotal > 0 ? nairaText(order.taxTotal, currency) : '',
    line1: str(addr.line1),
    city: str(addr.city),
    region: str(addr.region) || str(addr.state),
    countryCode: str(addr.countryCode) || str(addr.country) || HOME_COUNTRY,
    note: manual?.note ?? '',
  };
}

/** Anything under Advanced filled in? Decides whether an edit opens it. */
function advancedFilled(d: Draft): boolean {
  return Boolean(
    d.name || d.email || d.phone || d.channel || d.shipping || d.discount || d.tax ||
      d.line1 || d.city || d.region || d.note,
  );
}

/* ═══════════════════════════════════════════════════════ SERVER ERRORS ══ */

/** A 400's `detail` is the refused field's PATH (`zodDetail`). This turns it
 *  into the key of the box to mark, so the refusal lands where it belongs. */
function fieldForPath(path: string, lines: LineDraft[]): string | null {
  const line = /^lines\.(\d+)(?:\.(\w+))?/.exec(path);
  if (line) {
    const draft = lines[Number(line[1])];
    if (!draft) return 'lines';
    if (line[2] === 'qty') return `qty:${draft.key}`;
    if (line[2] === 'unitAmount') return `price:${draft.key}`;
    return `line:${draft.key}`;
  }
  const map: Record<string, string> = {
    lines: 'lines',
    soldAt: 'soldAt',
    paymentMethod: 'paymentMethod',
    paymentReference: 'reference',
    'advanced.customer.name': 'name',
    'advanced.customer.email': 'email',
    'advanced.customer.phone': 'phone',
    'advanced.salesChannel': 'channel',
    'advanced.shippingAmount': 'shipping',
    'advanced.discountAmount': 'discount',
    'advanced.taxAmount': 'tax',
    'advanced.address.line1': 'line1',
    'advanced.address.city': 'city',
    'advanced.address.region': 'region',
    'advanced.address.countryCode': 'countryCode',
    'advanced.note': 'note',
  };
  return map[path] ?? null;
}

const SERVER_WORDS: Record<string, string> = {
  lines: 'Add at least one product.',
  soldAt: 'Pick the day it was sold — today or earlier.',
  paymentMethod: 'Choose how it was paid.',
  reference: 'Keep the reference to 200 characters or fewer.',
  email: 'That email address doesn’t look right.',
  note: 'Keep the note to 2,000 characters or fewer.',
  countryCode: 'Pick a country.',
};

function serverWords(field: string): string {
  if (field.startsWith('qty:')) return 'Enter a whole number, 1 or more.';
  if (field.startsWith('price:')) return 'Check this price.';
  if (field.startsWith('line:')) return 'This product can’t be sold right now. Remove it and pick again.';
  return SERVER_WORDS[field] ?? 'This wasn’t accepted. Check it and try again.';
}

const ADVANCED_FIELDS = new Set([
  'name', 'email', 'phone', 'channel', 'shipping', 'discount', 'tax',
  'line1', 'city', 'region', 'countryCode', 'note',
]);

/* ═══════════════════════════════════════════════════════════ THE ROUTE ══ */

export default function OrderManual() {
  const { id } = useParams<{ id: string }>();
  return id ? <EditManualOrder id={id} /> : <ManualOrderForm />;
}

function EditManualOrder({ id }: { id: string }) {
  const { data, error, loading, reload } = useAsync((signal) => shopApi.getOrder(id, signal), [id]);
  const header = (
    <PageHeader icon={<Receipt />} title="Edit order" backTo={`/orders/${id}`} backLabel="Order" />
  );

  if (error) {
    return (
      <div className="page">
        {header}
        <Banner tone="critical" title="Couldn’t load this order" action={<Button onClick={reload}>Retry</Button>}>
          {error}
        </Banner>
      </div>
    );
  }
  if (loading || !data) {
    return (
      <div className="page">
        {header}
        <Loading what="the order" />
      </div>
    );
  }
  if (data.order.source !== 'manual' || data.order.status === 'cancelled') {
    return (
      <div className="page">
        {header}
        <Banner tone="warn" title="This order can’t be edited here">
          Only orders recorded by hand can be edited, and not once they have been voided.
        </Banner>
      </div>
    );
  }
  /* Keyed by revision: a reload after a conflict that brings back a newer
     order starts the form again from it, rather than keeping stale boxes. */
  return <ManualOrderForm key={data.order.revision} existing={data} onReload={reload} />;
}

/* ═══════════════════════════════════════════════════════════ THE FORM ═══ */

function ManualOrderForm({
  existing,
  onReload,
}: {
  existing?: ShopOrderDetail;
  onReload?: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const currency = existing?.order.currency ?? 'NGN';
  const today = todayIso();

  const [draft, setDraft] = useState<Draft>(() =>
    existing ? draftFromOrder(existing) : { soldAt: today, ...EMPTY },
  );
  const [advanced, setAdvanced] = useState(() => (existing ? advancedFilled(draftFromOrder(existing)) : false));
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const serial = useRef(0);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setServerErrors((e) => {
      if (!(key in e)) return e;
      const rest = { ...e };
      delete rest[key as string];
      return rest;
    });
  };

  const setLine = (key: string, patch: Partial<LineDraft>) => {
    setDraft((d) => ({ ...d, lines: d.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
    setServerErrors((e) => {
      const rest = { ...e };
      delete rest[`qty:${key}`];
      delete rest[`price:${key}`];
      delete rest[`line:${key}`];
      delete rest.lines;
      return rest;
    });
  };

  function addLine(v: PickedVariant) {
    serial.current += 1;
    setDraft((d) => ({
      ...d,
      lines: [
        ...d.lines,
        {
          key: `new-${serial.current}`,
          variantId: v.variantId,
          title: v.productTitle,
          sku: v.sku,
          optionValues: v.optionValues,
          qty: '1',
          price: v.price ? nairaText(v.price.amount, v.price.currency) : '',
          currentPrice: v.price?.amount ?? null,
          available: v.available,
        },
      ],
    }));
    setServerErrors((e) => {
      const rest = { ...e };
      delete rest.lines;
      return rest;
    });
  }

  /* ── validation, and the numbers the summary and the body share ─────── */

  const money$ = (text: string) => (text.trim() ? parseMajor(text, currency) : null);

  const checked = useMemo(() => {
    const errors: Record<string, string> = {};
    let subtotal = 0;
    const lines: ManualOrderInput['lines'] = [];

    if (draft.lines.length === 0) errors.lines = 'Add at least one product.';
    for (const line of draft.lines) {
      const qty = Number(line.qty);
      const qtyOk = /^\d+$/.test(line.qty.trim()) && Number.isSafeInteger(qty) && qty >= 1;
      if (!qtyOk) errors[`qty:${line.key}`] = 'Enter a whole number, 1 or more.';
      const price = money$(line.price);
      if (price && !price.ok) errors[`price:${line.key}`] = 'Enter a price in naira, like 28000.';
      const unit = price && price.ok ? price.minor : line.currentPrice;
      if (qtyOk && unit !== null) subtotal += unit * qty;
      lines.push({
        variantId: line.variantId,
        qty: qtyOk ? qty : 0,
        ...(price && price.ok ? { unitAmount: price.minor } : {}),
      });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.soldAt)) errors.soldAt = 'Pick the day it was sold.';
    else if (draft.soldAt > today) errors.soldAt = 'The date sold can’t be in the future.';
    if (!draft.paymentMethod) errors.paymentMethod = 'Choose how it was paid.';
    if (draft.reference.trim().length > 200) errors.reference = SERVER_WORDS.reference!;
    if (draft.note.trim().length > 2000) errors.note = SERVER_WORDS.note!;
    /* The server's own rule (`ManualOrderBody`), no stricter: a local check
       that refuses what the server would take is a form that cannot be saved. */
    if (draft.email.trim() && !/^[^\s@]+@[^\s@]+$/.test(draft.email.trim())) {
      errors.email = SERVER_WORDS.email!;
    }

    const amount = (field: 'shipping' | 'discount' | 'tax'): number | undefined => {
      const parsed = money$(draft[field]);
      if (!parsed) return undefined;
      if (!parsed.ok) {
        errors[field] = 'Enter an amount in naira, like 2500.';
        return undefined;
      }
      return parsed.minor;
    };
    const shipping = amount('shipping');
    const discount = amount('discount');
    const tax = amount('tax');
    const total = subtotal + (shipping ?? 0) + (tax ?? 0) - (discount ?? 0);
    if (total < 0) errors.discount = 'The discount can’t be more than the order.';

    return { errors, lines, subtotal, shipping, discount, tax, total };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- money$ reads currency only
  }, [draft, today, currency]);

  function buildBody(): ManualOrderInput {
    const t = (value: string) => value.trim() || undefined;
    const customer = { name: t(draft.name), email: t(draft.email), phone: t(draft.phone) };
    const hasCustomer = Object.values(customer).some(Boolean);
    const address = { line1: t(draft.line1), city: t(draft.city), region: t(draft.region) };
    /* The country box always has a value (it defaults to Nigeria), so on its
       own it is not an address — it rides along only with a real one. */
    const hasAddress = Object.values(address).some(Boolean);
    const adv: NonNullable<ManualOrderInput['advanced']> = {
      ...(hasCustomer ? { customer } : {}),
      ...(draft.channel ? { salesChannel: draft.channel } : {}),
      ...(hasAddress ? { address: { ...address, countryCode: draft.countryCode || HOME_COUNTRY } } : {}),
      ...(checked.shipping !== undefined ? { shippingAmount: checked.shipping } : {}),
      ...(checked.discount !== undefined ? { discountAmount: checked.discount } : {}),
      ...(checked.tax !== undefined ? { taxAmount: checked.tax } : {}),
      ...(t(draft.note) ? { note: t(draft.note) } : {}),
    };
    return {
      soldAt: draft.soldAt,
      lines: checked.lines,
      paymentMethod: draft.paymentMethod as ManualPaymentMethod,
      ...(t(draft.reference) ? { paymentReference: t(draft.reference) } : {}),
      takeFromStock: draft.takeFromStock,
      ...(Object.keys(adv).length > 0 ? { advanced: adv } : {}),
    };
  }

  async function save() {
    setSubmitted(true);
    setFailure(null);
    if (Object.keys(checked.errors).length > 0) {
      if (Object.keys(checked.errors).some((k) => ADVANCED_FIELDS.has(k))) setAdvanced(true);
      return;
    }
    setSaving(true);
    try {
      const body = buildBody();
      const result: ShopManualOrderResult = existing
        ? await shopApi.updateManualOrder(existing.order.id, { ...body, baseRevision: existing.order.revision })
        : await shopApi.createManualOrder(body);
      toast.show(existing ? 'Order saved' : `${result.order.orderNumber} recorded`);
      navigate(`/orders/${result.order.id}`, {
        state: { stockFailed: result.stock?.failed ?? [] },
      });
    } catch (cause) {
      setSaving(false);
      if (cause instanceof ApiError && cause.status === 409) {
        setStale(true);
        return;
      }
      if (cause instanceof ApiError && cause.status === 400 && cause.detail) {
        const field = fieldForPath(cause.detail, draft.lines);
        if (field) {
          setServerErrors({ [field]: serverWords(field) });
          if (ADVANCED_FIELDS.has(field)) setAdvanced(true);
          return;
        }
      }
      setFailure(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
    }
  }

  /** A box's error: the server's refusal always, the local one once Save has
   *  been pressed — a form that opens red is telling somebody off for not
   *  having typed yet. */
  const err = (key: string): string | null =>
    serverErrors[key] ?? (submitted ? (checked.errors[key] ?? null) : null);

  const countries = useMemo(() => {
    const list = [...SHIPPABLE_COUNTRIES];
    if (draft.countryCode && !list.includes(draft.countryCode)) list.push(draft.countryCode);
    return list.sort(byName);
  }, [draft.countryCode]);

  const backTo = existing ? `/orders/${existing.order.id}` : '/orders';

  return (
    <div className="page">
      <PageHeader
        icon={<Receipt />}
        title={existing ? `Edit ${existing.order.orderNumber}` : 'Record a sale'}
        subtitle={
          existing
            ? 'Saving keeps the old version in the order’s edit history.'
            : 'For a sale made outside the online checkout — a payment link, a transfer, cash.'
        }
        backTo={backTo}
        backLabel={existing ? 'Order' : 'Orders'}
        actions={
          <>
            <Button size="lg" onClick={() => navigate(backTo)}>
              Discard
            </Button>
            <Button tone="primary" size="lg" busy={saving} onClick={() => void save()}>
              Save
            </Button>
          </>
        }
      />

      {stale ? (
        <Banner
          tone="critical"
          title="This order has changed"
          action={onReload ? <Button onClick={onReload}>Reload</Button> : undefined}
        >
          {STALE_ORDER}
        </Banner>
      ) : null}
      {failure ? (
        <Banner tone="critical" title="Couldn’t save this order">
          {failure}
        </Banner>
      ) : null}

      <div className="form2">
        <div className="form2__main">
          {/* ── what was sold ─────────────────────────────────────────── */}
          <Card title="What was sold">
            <VariantPicker onPick={addLine} error={err('lines')} />
            {draft.lines.length > 0 ? (
              <ul className="mo__lines">
                {draft.lines.map((line) => (
                  <LineRow
                    key={line.key}
                    line={line}
                    currency={currency}
                    qtyError={err(`qty:${line.key}`)}
                    priceError={err(`price:${line.key}`) ?? err(`line:${line.key}`)}
                    onQty={(qty) => setLine(line.key, { qty })}
                    onPrice={(price) => setLine(line.key, { price })}
                    onRemove={() =>
                      setDraft((d) => ({ ...d, lines: d.lines.filter((l) => l.key !== line.key) }))
                    }
                  />
                ))}
              </ul>
            ) : (
              <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
                Search for a product above to add it. Add as many as were sold.
              </p>
            )}
          </Card>

          {/* ── when, and how it was paid ─────────────────────────────── */}
          <Card title="Payment">
            <div className="mo__pair">
              <TextField
                label="Date sold"
                type="date"
                max={today}
                value={draft.soldAt}
                error={err('soldAt')}
                onChange={(e) => set('soldAt', e.target.value)}
              />
              <SelectField
                label="How was it paid?"
                value={draft.paymentMethod}
                error={err('paymentMethod')}
                onChange={(e) => set('paymentMethod', e.target.value as ManualPaymentMethod | '')}
              >
                <option value="" disabled>
                  Choose one
                </option>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHOD_LABELS[m]}
                  </option>
                ))}
              </SelectField>
            </div>
            <TextField
              label="Reference (optional)"
              value={draft.reference}
              maxLength={200}
              error={err('reference')}
              hint="Transaction ID, transfer reference or receipt number — if you have it."
              onChange={(e) => set('reference', e.target.value)}
            />
            <Checkbox
              label="Take these items out of stock"
              hint="Turn this off if your stock count already reflects the sale."
              checked={draft.takeFromStock}
              onChange={(next) => set('takeFromStock', next)}
            />
          </Card>

          {/* ── advanced, closed by default ───────────────────────────── */}
          <section className="card">
            <button
              type="button"
              className="mo__disclosure"
              aria-expanded={advanced}
              aria-controls="mo-advanced"
              onClick={() => setAdvanced((v) => !v)}
            >
              <span>
                <span className="card__title">Advanced</span>
                <span className="mo__disclosure-sub">
                  Customer, where the sale came from, delivery, discount, tax and a note. All optional.
                </span>
              </span>
              <ChevronDown aria-hidden="true" className={advanced ? 'mo__chev is-open' : 'mo__chev'} />
            </button>
            {advanced ? (
              <div id="mo-advanced" className="card__body stack">
                <div className="mo__trio">
                  <TextField
                    label="Customer name"
                    value={draft.name}
                    autoComplete="off"
                    error={err('name')}
                    onChange={(e) => set('name', e.target.value)}
                  />
                  <TextField
                    label="Email"
                    type="email"
                    value={draft.email}
                    autoComplete="off"
                    error={err('email')}
                    onChange={(e) => set('email', e.target.value)}
                  />
                  <TextField
                    label="Phone"
                    type="tel"
                    value={draft.phone}
                    autoComplete="off"
                    error={err('phone')}
                    onChange={(e) => set('phone', e.target.value)}
                  />
                </div>

                <SelectField
                  label="Where did the sale come from?"
                  value={draft.channel}
                  error={err('channel')}
                  onChange={(e) => set('channel', e.target.value as ManualSalesChannel | '')}
                >
                  <option value="">Not recorded</option>
                  {SALES_CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {SALES_CHANNEL_LABELS[c]}
                    </option>
                  ))}
                </SelectField>

                <div className="mo__trio">
                  <AffixField
                    label="Delivery fee"
                    prefix="₦"
                    inputMode="decimal"
                    placeholder="0"
                    value={draft.shipping}
                    error={err('shipping')}
                    onChange={(e) => set('shipping', e.target.value)}
                  />
                  <AffixField
                    label="Discount"
                    prefix="₦"
                    inputMode="decimal"
                    placeholder="0"
                    value={draft.discount}
                    error={err('discount')}
                    onChange={(e) => set('discount', e.target.value)}
                  />
                  <AffixField
                    label="Tax"
                    prefix="₦"
                    inputMode="decimal"
                    placeholder="0"
                    value={draft.tax}
                    error={err('tax')}
                    onChange={(e) => set('tax', e.target.value)}
                  />
                </div>

                <fieldset className="mo__fieldset">
                  <legend className="field__label">Delivery address</legend>
                  <TextField
                    label="Address"
                    value={draft.line1}
                    error={err('line1')}
                    onChange={(e) => set('line1', e.target.value)}
                  />
                  <div className="mo__trio">
                    <TextField
                      label="City"
                      value={draft.city}
                      error={err('city')}
                      onChange={(e) => set('city', e.target.value)}
                    />
                    <TextField
                      label="State"
                      value={draft.region}
                      error={err('region')}
                      onChange={(e) => set('region', e.target.value)}
                    />
                    <SelectField
                      label="Country"
                      value={draft.countryCode}
                      error={err('countryCode')}
                      onChange={(e) => set('countryCode', e.target.value)}
                    >
                      {countries.map((code) => (
                        <option key={code} value={code}>
                          {countryName(code)}
                        </option>
                      ))}
                    </SelectField>
                  </div>
                </fieldset>

                <TextArea
                  label="Note"
                  rows={3}
                  value={draft.note}
                  error={err('note')}
                  hint="Only your team sees this."
                  onChange={(e) => set('note', (e.target as HTMLTextAreaElement).value)}
                />
              </div>
            ) : null}
          </section>
        </div>

        {/* ── the total, live ───────────────────────────────────────────── */}
        <aside className="form2__side">
          <Card title="Total">
            <Defs
              rows={[
                {
                  label: `Items · ${draft.lines.reduce((n, l) => n + (Number(l.qty) || 0), 0)}`,
                  value: <span className="num">{money(checked.subtotal, currency)}</span>,
                },
                ...(checked.shipping
                  ? [{ label: 'Delivery', value: <span className="num">{money(checked.shipping, currency)}</span> }]
                  : []),
                ...(checked.tax
                  ? [{ label: 'Tax', value: <span className="num">{money(checked.tax, currency)}</span> }]
                  : []),
                ...(checked.discount
                  ? [
                      {
                        label: 'Discount',
                        value: <span className="num">−{money(checked.discount, currency)}</span>,
                      },
                    ]
                  : []),
                {
                  label: 'Total',
                  value: <span className="num">{money(checked.total, currency)}</span>,
                  total: true,
                },
              ]}
            />
            <span className="field__hint">
              Saved as sent out and paid on the date sold. It counts in your sales figures.
            </span>
          </Card>
        </aside>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════ ONE LINE ═══ */

function LineRow({
  line,
  currency,
  qtyError,
  priceError,
  onQty,
  onPrice,
  onRemove,
}: {
  line: LineDraft;
  currency: string;
  qtyError: string | null;
  priceError: string | null;
  onQty: (qty: string) => void;
  onPrice: (price: string) => void;
  onRemove: () => void;
}) {
  const label = lineLabel(line);
  const qty = Number(line.qty);
  const step = (by: number) => {
    const base = Number.isSafeInteger(qty) && qty >= 1 ? qty : 1;
    onQty(String(Math.max(1, base + by)));
  };
  const parsed = line.price.trim() ? parseMajor(line.price, currency) : null;
  const unit = parsed && parsed.ok ? parsed.minor : line.currentPrice;
  const lineTotal = unit !== null && Number.isSafeInteger(qty) && qty >= 1 ? unit * qty : null;
  const short = line.available !== null && Number.isSafeInteger(qty) && qty > line.available;

  return (
    <li className="mo__line">
      <div className="mo__line-name">
        <strong>{label}</strong>
        <span className="muted">
          <span className="mono">{line.sku}</span>
          {line.available !== null ? ` · ${line.available} in stock` : ''}
          {short ? (
            <>
              {' '}
              <Badge tone="warn">More than in stock</Badge>
            </>
          ) : null}
        </span>
      </div>
      <div className="mo__line-controls">
        <div className="field">
          <span className="field__label" aria-hidden="true">
            Quantity
          </span>
          <div className="mo__stepper">
            <Button iconOnly tone="plain" aria-label={`One fewer ${label}`} onClick={() => step(-1)}>
              <Minus aria-hidden="true" />
            </Button>
            <input
              className={qtyError ? 'input input--invalid input--tiny' : 'input input--tiny'}
              inputMode="numeric"
              aria-label={`Quantity of ${label}`}
              aria-invalid={qtyError ? true : undefined}
              value={line.qty}
              onChange={(e) => onQty(e.target.value)}
            />
            <Button iconOnly tone="plain" aria-label={`One more ${label}`} onClick={() => step(1)}>
              <Plus aria-hidden="true" />
            </Button>
          </div>
          {qtyError ? <span className="field__error">{qtyError}</span> : null}
        </div>
        <div className="mo__price">
          <AffixField
            label="Price"
            aria-label={`Price of ${label}`}
            prefix="₦"
            inputMode="decimal"
            placeholder={line.currentPrice === null ? 'Current price' : undefined}
            value={line.price}
            error={priceError}
            onChange={(e) => onPrice(e.target.value)}
          />
        </div>
        <div className="mo__line-total num">{lineTotal === null ? '—' : money(lineTotal, currency)}</div>
        <Button iconOnly tone="plain" aria-label={`Remove ${label}`} onClick={onRemove}>
          <X aria-hidden="true" />
        </Button>
      </div>
    </li>
  );
}

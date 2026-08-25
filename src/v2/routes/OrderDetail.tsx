import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Ban, CreditCard, PackageCheck, Receipt, Truck, Undo2 } from 'lucide-react';
import {
  moneyRefusalMessage,
  parseRefund,
  shopApi,
  type CancelRefundChoice,
  type ShopEmailIntent,
  type ShopFulfillment,
  type ShopOrderDetail,
  type ShopOrderLine,
  type ShopTimelineEntry,
} from '../../data/api-shop';
import { getSession } from '../../data/session';
import { useAsync } from '../lib/useAsync';
import { dateTime, humanise, money, orderTone } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button } from '../ui/primitives';
import { Card } from '../ui/Card';
import { Defs, type DefRow } from '../ui/Defs';
import { AffixField, Radio, TextField } from '../ui/Field';
import { MenuItem, MenuSeparator } from '../ui/Menu';
import { Modal } from '../ui/Modal';
import { Timeline, type TimelineEvent } from '../ui/Timeline';
import { useToast } from '../ui/Toast';

/**
 * ORDER DETAIL — `/orders/:id`.
 *
 * THE MONEY ON THIS SCREEN IS THE ORDER'S FROZEN RECORD. Subtotal, shipping,
 * tax and the grand total were copied at checkout and are NEVER recomputed
 * here — re-deriving them from today's prices would reintroduce exactly the
 * drift freezing exists to prevent (CLAUDE.md §6). Every figure renders
 * through `money()` from the order's own minor units.
 *
 * The lines are THE page's one table. Fulfilments, the timeline and the
 * queued emails are cards, and the rail carries the customer and the payment.
 */

/*
 * TODO(tests): none exist for this screen — skipped by this session's no-test
 * rule, recorded in CLAUDE.md. Most-deserving paths: the refund idempotency
 * key staying STABLE across a retried click, the cancel modal refusing a paid
 * cancel without a refund choice, and the three-state `order` result of
 * setFulfillmentStatus (absent / null / order).
 */

function optionLabel(values: Record<string, string>): string | null {
  const parts = Object.values(values).filter(Boolean);
  return parts.length ? parts.join(' / ') : null;
}

/** The address is a loose record server-side; render the keys people expect,
 *  in the order a label would print them, and nothing invented. */
function addressLines(addr: Record<string, unknown> | null | undefined): string[] {
  if (!addr) return [];
  const pick = (k: string) => (typeof addr[k] === 'string' && addr[k] ? String(addr[k]) : null);
  const lines = [
    pick('name') ?? pick('fullName'),
    pick('phone'),
    pick('line1') ?? pick('address1') ?? pick('street'),
    pick('line2') ?? pick('address2'),
    [pick('district'), pick('city')].filter(Boolean).join(', ') || null,
    [pick('region') ?? pick('state'), pick('postalCode') ?? pick('postcode')]
      .filter(Boolean)
      .join(' ') || null,
    pick('country'),
  ];
  return lines.filter((l): l is string => Boolean(l));
}

function timelineEvent(entry: ShopTimelineEntry): TimelineEvent {
  const t = entry.type.toLowerCase();
  const tone: TimelineEvent['tone'] = /cancel|refund|fail/.test(t)
    ? 'critical'
    : /paid|captur|fulfil|deliver|ship/.test(t)
      ? 'ok'
      : /placed|created/.test(t)
        ? 'info'
        : 'neutral';
  return {
    id: entry.id,
    tone,
    message: entry.message,
    meta: `${dateTime(entry.occurredAt)}${entry.actorId ? ` · ${entry.actorId}` : ''}`,
  };
}

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(
    (signal) => shopApi.getOrder(id!, signal),
    [id],
  );

  const [modal, setModal] = useState<'none' | 'fulfil' | 'cancel' | 'refund'>('none');

  if (error) {
    return (
      <div className="page">
        <PageHeader icon={<Receipt />} title="Order" backTo="/orders" backLabel="Orders" />
        <Banner tone="critical" title="Couldn’t load this order" action={<Button onClick={reload}>Retry</Button>}>
          {error}
        </Banner>
      </div>
    );
  }

  if (loading || !data) return <OrderSkeleton />;

  const { order, lines, fulfillments, timeline, emails, payment } = data;
  const currency = order.currency;
  const itemCount = lines.reduce((n, l) => n + l.qty, 0);
  const unfulfilled = lines.some((l) => l.fulfilledQty < l.qty);

  /* Cancel and refund are OWNER-ONLY at the server; a writer gets no dead
     menu items to click into a 403. */
  const session = getSession();
  const isOwner = 'user' in session && session.user?.role === 'owner';

  const canFulfil =
    (order.status === 'paid' || order.status === 'partially_refunded') && unfulfilled;
  const canCancel = isOwner && (order.status === 'pending' || order.status === 'paid');
  const intentId = payment?.intentId ?? order.paymentIntentId;
  const refundable = order.grandTotal - order.refundedTotal;
  const canRefund =
    isOwner &&
    Boolean(intentId) &&
    refundable > 0 &&
    (order.status === 'paid' ||
      order.status === 'fulfilled' ||
      order.status === 'partially_refunded');

  const done = () => {
    setModal('none');
    reload();
  };

  return (
    <div className="page">
      <PageHeader
        icon={<Receipt />}
        title={order.orderNumber}
        titleBadge={<Badge tone={orderTone(order.status)}>{humanise(order.status)}</Badge>}
        subtitle={`Placed ${dateTime(order.placedAt)} · ${order.email}`}
        backTo="/orders"
        backLabel="Orders"
        actions={
          canFulfil ? (
            <Button tone="primary" size="lg" onClick={() => setModal('fulfil')}>
              <PackageCheck aria-hidden="true" />
              Fulfil items
            </Button>
          ) : undefined
        }
        menu={(close) => (
          <>
            {canRefund ? (
              <MenuItem
                icon={<Undo2 aria-hidden="true" />}
                onSelect={() => {
                  close();
                  setModal('refund');
                }}
              >
                Refund payment…
              </MenuItem>
            ) : null}
            {canRefund && canCancel ? <MenuSeparator /> : null}
            {canCancel ? (
              <MenuItem
                critical
                icon={<Ban aria-hidden="true" />}
                onSelect={() => {
                  close();
                  setModal('cancel');
                }}
              >
                Cancel order…
              </MenuItem>
            ) : null}
            {!canRefund && !canCancel ? (
              <MenuItem onSelect={close}>Nothing to do — this order is settled</MenuItem>
            ) : null}
          </>
        )}
      />

      {order.status === 'pending' ? (
        <Banner tone="warn" title="Awaiting payment">
          The shopper reached checkout and the money has not landed. It confirms itself when
          Paystack settles — nothing to do here yet.
        </Banner>
      ) : null}

      <div className="form2">
        <div className="form2__main">
          {/* ── the lines — THE table ─────────────────────────────────── */}
          <section className="card">
            <div className="card__head">
              <h2 className="card__title">
                Items <span className="muted">· {itemCount}</span>
              </h2>
              {canFulfil ? (
                <Button onClick={() => setModal('fulfil')}>
                  <PackageCheck aria-hidden="true" />
                  Fulfil items
                </Button>
              ) : null}
            </div>
            <div className="tscroll">
              <table className="table">
                <caption className="sr">Order lines</caption>
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col" className="th--num">Qty</th>
                    <th scope="col">Fulfilled</th>
                    <th scope="col" className="th--num">Unit</th>
                    <th scope="col" className="th--num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.id}>
                      <td className="cell--primary">
                        <span className="idcell">
                          <span className="idcell__text">
                            <span className="idcell__title">{line.title}</span>
                            <span className="idcell__meta">
                              {optionLabel(line.optionValues) ? `${optionLabel(line.optionValues)} · ` : ''}
                              <span className="mono">{line.sku}</span>
                            </span>
                          </span>
                        </span>
                      </td>
                      <td className="cell--num">{line.qty}</td>
                      <td>
                        <Badge
                          tone={
                            line.fulfilledQty >= line.qty
                              ? 'ok'
                              : line.fulfilledQty > 0
                                ? 'warn'
                                : 'neutral'
                          }
                        >
                          {line.fulfilledQty} of {line.qty}
                        </Badge>
                      </td>
                      <td className="cell--num">{money(line.unitAmount, currency)}</td>
                      <td className="cell--num">
                        <strong className="num">{money(line.lineTotal, currency)}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── fulfilments ───────────────────────────────────────────── */}
          <Card title="Fulfilments">
            {fulfillments.length === 0 ? (
              <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
                Nothing packed yet.{' '}
                {canFulfil ? 'Fulfil items to start a parcel.' : ''}
              </p>
            ) : (
              <div className="stack">
                {fulfillments.map((f, i) => (
                  <FulfilmentRow
                    key={f.id}
                    index={i + 1}
                    fulfillment={f}
                    lines={lines}
                    onChanged={(settled) => {
                      if (settled) toast.show('Every parcel delivered — order fulfilled');
                      reload();
                    }}
                  />
                ))}
              </div>
            )}
          </Card>

          {/* ── emails ────────────────────────────────────────────────── */}
          <Card title="Emails">
            {emails.length === 0 ? (
              <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
                No emails queued against this order.
              </p>
            ) : (
              <div className="stack stack--tight">
                {emails.map((mail) => (
                  <EmailRow key={mail.id} mail={mail} />
                ))}
              </div>
            )}
          </Card>

          {/* ── timeline ──────────────────────────────────────────────── */}
          <Card title="Timeline">
            {timeline.length === 0 ? (
              <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
                Nothing recorded yet.
              </p>
            ) : (
              <Timeline events={timeline.map(timelineEvent)} />
            )}
          </Card>
        </div>

        <aside className="form2__side">
          <Card title="Customer">
            <Defs
              rows={[
                { label: 'Email', value: order.email },
                {
                  label: 'Account',
                  value: order.customerId ? <span className="mono">{order.customerId.slice(0, 8)}…</span> : 'Guest checkout',
                },
              ]}
            />
            <AddressBlock label="Delivery address" addr={order.shippingAddress} />
            {JSON.stringify(order.billingAddress) !== JSON.stringify(order.shippingAddress) ? (
              <AddressBlock label="Billing address" addr={order.billingAddress} />
            ) : null}
          </Card>

          <Card title="Payment">
            <Defs
              rows={[
                {
                  label: `Subtotal · ${itemCount} ${itemCount === 1 ? 'item' : 'items'}`,
                  value: <span className="num">{money(order.subtotal, currency)}</span>,
                },
                { label: 'Delivery', value: <span className="num">{money(order.shippingTotal, currency)}</span> },
                { label: 'Tax', value: <span className="num">{money(order.taxTotal, currency)}</span> },
                {
                  label: 'Total',
                  value: <span className="num">{money(order.grandTotal, currency)}</span>,
                  total: true,
                },
                ...(order.refundedTotal > 0
                  ? [
                      {
                        label: 'Refunded',
                        value: (
                          <span className="num" style={{ color: 'var(--critical)' }}>
                            −{money(order.refundedTotal, currency)}
                          </span>
                        ),
                      } satisfies DefRow,
                    ]
                  : []),
              ]}
            />
            <span className="field__hint">
              Frozen at checkout — these figures are the order’s record, never recomputed.
            </span>
            {payment ? (
              <div className="row" style={{ gap: 'var(--s2)', flexWrap: 'wrap' }}>
                <CreditCard aria-hidden="true" style={{ width: 15, height: 15, color: 'var(--ink-sub)' }} />
                <Badge tone={payment.status === 'captured' ? 'ok' : payment.status === 'failed' ? 'critical' : 'info'}>
                  {humanise(payment.status)}
                </Badge>
                <span className="mono muted" style={{ fontSize: 'var(--t-sm)' }} title={payment.intentId}>
                  {payment.intentId.slice(0, 18)}…
                </span>
              </div>
            ) : intentId ? (
              <span className="field__hint">
                Intent <span className="mono">{intentId.slice(0, 18)}…</span>
              </span>
            ) : null}
          </Card>

          <Card title="Details">
            <Defs
              rows={(
                [
                  ['Placed', order.placedAt],
                  ['Paid', order.paidAt],
                  ['Fulfilled', order.fulfilledAt],
                  ['Delivered', order.deliveredAt],
                  ['Cancelled', order.cancelledAt],
                ] as const
              )
                .filter(([, at]) => at !== null)
                .map(([label, at]) => ({ label, value: dateTime(at) }))}
            />
          </Card>
        </aside>
      </div>

      {modal === 'fulfil' ? (
        <FulfilModal orderId={order.id} lines={lines} onClose={() => setModal('none')} onDone={done} />
      ) : null}
      {modal === 'cancel' ? (
        <CancelModal order={data} onClose={() => setModal('none')} onDone={done} />
      ) : null}
      {modal === 'refund' && intentId ? (
        <RefundModal
          intentId={intentId}
          currency={currency}
          maxMinor={refundable}
          onClose={() => setModal('none')}
          onDone={done}
        />
      ) : null}
    </div>
  );
}

function AddressBlock({ label, addr }: { label: string; addr: Record<string, unknown> }) {
  const lines = addressLines(addr);
  return (
    <div className="stack stack--tight">
      <span className="field__label">{label}</span>
      {lines.length === 0 ? (
        <span className="muted" style={{ fontSize: 'var(--t-md)' }}>—</span>
      ) : (
        <div style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
          {lines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════ FULFILMENTS ════ */

function FulfilmentRow({
  index,
  fulfillment,
  lines,
  onChanged,
}: {
  index: number;
  fulfillment: ShopFulfillment;
  lines: ShopOrderLine[];
  onChanged: (orderSettled: boolean) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const tone =
    fulfillment.status === 'delivered'
      ? 'ok'
      : fulfillment.status === 'shipped'
        ? 'info'
        : fulfillment.status === 'cancelled'
          ? 'neutral'
          : 'warn';

  const contents = fulfillment.lines
    .map((fl) => {
      const line = lines.find((l) => l.id === fl.orderLineId);
      return `${fl.qty}× ${line?.title ?? 'item'}`;
    })
    .join(', ');

  async function move(status: 'shipped' | 'delivered' | 'cancelled') {
    setBusy(status);
    try {
      const res = await shopApi.setFulfillmentStatus(fulfillment.id, status);
      toast.show(`Parcel ${index} ${humanise(res.fulfillment.status).toLowerCase()}`);
      /* Plain truthiness on purpose: absent for delivered/cancelled, null for
         "shipped but the order has parcels left" — see the client contract. */
      onChanged(Boolean(res.order));
    } catch (cause) {
      toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)', flexWrap: 'wrap' }}>
      <Truck aria-hidden="true" style={{ width: 16, height: 16, color: 'var(--ink-sub)', marginTop: 3 }} />
      <div style={{ flex: 1, minWidth: '12rem' }}>
        <div className="row" style={{ gap: 'var(--s2)' }}>
          <strong style={{ fontSize: 'var(--t-md)' }}>Parcel {index}</strong>
          <Badge tone={tone}>{humanise(fulfillment.status)}</Badge>
        </div>
        <div className="muted" style={{ fontSize: 'var(--t-sm)', marginTop: 2 }}>
          {contents}
        </div>
        <div className="muted" style={{ fontSize: 'var(--t-sm)' }}>
          {fulfillment.carrier ? `${fulfillment.carrier} · ` : ''}
          {fulfillment.trackingNumber ? (
            <span className="mono">{fulfillment.trackingNumber}</span>
          ) : (
            'No tracking'
          )}
          {' · created '}
          {dateTime(fulfillment.createdAt)}
          {fulfillment.shippedAt ? ` · shipped ${dateTime(fulfillment.shippedAt)}` : ''}
          {fulfillment.deliveredAt ? ` · delivered ${dateTime(fulfillment.deliveredAt)}` : ''}
        </div>
      </div>
      <div className="row" style={{ gap: 'var(--s2)' }}>
        {fulfillment.status === 'pending' ? (
          <>
            <Button busy={busy === 'shipped'} onClick={() => void move('shipped')}>
              Mark shipped
            </Button>
            <Button tone="plain" busy={busy === 'cancelled'} onClick={() => void move('cancelled')}>
              Cancel parcel
            </Button>
          </>
        ) : fulfillment.status === 'shipped' ? (
          <Button busy={busy === 'delivered'} onClick={() => void move('delivered')}>
            Mark delivered
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function FulfilModal({
  orderId,
  lines,
  onClose,
  onDone,
}: {
  orderId: string;
  lines: ShopOrderLine[];
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const open = useMemo(() => lines.filter((l) => l.fulfilledQty < l.qty), [lines]);
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(open.map((l) => [l.id, String(l.qty - l.fulfilledQty)])),
  );
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function commit() {
    const picked: { orderLineId: string; qty: number }[] = [];
    for (const line of open) {
      const n = Number(qty[line.id] ?? '0');
      const remaining = line.qty - line.fulfilledQty;
      if (!Number.isInteger(n) || n < 0 || n > remaining) {
        setError(`${line.title}: a whole number between 0 and ${remaining}.`);
        return;
      }
      if (n > 0) picked.push({ orderLineId: line.id, qty: n });
    }
    if (picked.length === 0) {
      setError('Nothing selected — set at least one quantity.');
      return;
    }
    setBusy(true);
    try {
      await shopApi.createFulfillment(orderId, {
        lines: picked,
        carrier: carrier.trim() || null,
        trackingNumber: tracking.trim() || null,
      });
      toast.show('Parcel created');
      onDone();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Fulfil items"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} onClick={() => void commit()}>
            <PackageCheck aria-hidden="true" />
            Create parcel
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.5 }}>
          A partial parcel is normal — what is left stays open for the next one.
        </p>
        {open.map((line) => (
          <div key={line.id} className="row" style={{ gap: 'var(--s3)', alignItems: 'center' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 'var(--t-md)', fontWeight: 'var(--w-medium)' }}>{line.title}</div>
              <div className="muted" style={{ fontSize: 'var(--t-sm)' }}>
                {line.qty - line.fulfilledQty} of {line.qty} remaining
              </div>
            </div>
            <input
              className="input"
              style={{ width: '5rem', textAlign: 'right' }}
              type="number"
              min={0}
              max={line.qty - line.fulfilledQty}
              step={1}
              aria-label={`Quantity of ${line.title}`}
              value={qty[line.id] ?? '0'}
              onChange={(e) => {
                setQty((q) => ({ ...q, [line.id]: e.target.value }));
                setError(null);
              }}
            />
          </div>
        ))}
        <div className="row" style={{ gap: 'var(--s3)', alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <TextField label="Carrier" value={carrier} placeholder="Optional" onChange={(e) => setCarrier(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <TextField
              label="Tracking number"
              value={tracking}
              placeholder="Optional"
              className="input mono"
              onChange={(e) => setTracking(e.target.value)}
            />
          </div>
        </div>
        {error ? (
          <span className="field__error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </Modal>
  );
}

/* ══════════════════════════════════════════════════ CANCEL AND REFUND ════ */

function CancelModal({
  order: detail,
  onClose,
  onDone,
}: {
  order: ShopOrderDetail;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const { order } = detail;
  const paid = order.status !== 'pending';
  const currency = order.currency;
  const max = order.grandTotal - order.refundedTotal;

  const [choice, setChoice] = useState<'full' | 'threequarters' | 'custom' | 'none'>('full');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function commit() {
    let refund: CancelRefundChoice | undefined;
    if (paid) {
      if (choice === 'full') refund = { kind: 'percent', percent: 100 };
      else if (choice === 'threequarters') refund = { kind: 'percent', percent: 75 };
      else if (choice === 'none') refund = { kind: 'none' };
      else {
        const parsed = parseRefund(amount, currency, max);
        if (!parsed.ok) {
          setError(moneyRefusalMessage(parsed.reason, currency));
          return;
        }
        refund = { kind: 'amount', amount: parsed.minor };
      }
    }
    setBusy(true);
    try {
      await shopApi.cancelOrder(order.id, refund);
      toast.show(`${order.orderNumber} cancelled`);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Cancel ${order.orderNumber}?`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Keep the order</Button>
          <Button tone="critical" busy={busy} onClick={() => void commit()}>
            Cancel order
          </Button>
        </>
      }
    >
      <div className="stack">
        <p style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
          Cancelling releases the reserved stock and stops this order ever shipping.
          {paid ? ' The customer has paid, so decide what happens to the money now:' : ''}
        </p>
        {paid ? (
          <div className="stack stack--tight">
            <Radio
              name="cancel-refund"
              label={`Refund in full — ${money(max, currency)}`}
              checked={choice === 'full'}
              onChange={() => setChoice('full')}
            />
            <Radio
              name="cancel-refund"
              label={`Refund 75% — ${money(Math.round(max * 0.75), currency)}`}
              hint="Keeps a handling share."
              checked={choice === 'threequarters'}
              onChange={() => setChoice('threequarters')}
            />
            <Radio
              name="cancel-refund"
              label="Refund a custom amount"
              checked={choice === 'custom'}
              onChange={() => setChoice('custom')}
            />
            {choice === 'custom' ? (
              <AffixField
                label="Amount"
                prefix={currency}
                inputMode="decimal"
                value={amount}
                error={error}
                hint={`Up to ${money(max, currency)}.`}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setError(null);
                }}
              />
            ) : null}
            <Radio
              name="cancel-refund"
              label="Cancel without refunding"
              hint="A deliberate choice, recorded as one — not a default."
              checked={choice === 'none'}
              onChange={() => setChoice('none')}
            />
          </div>
        ) : null}
        {error && choice !== 'custom' ? (
          <span className="field__error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </Modal>
  );
}

function RefundModal({
  intentId,
  currency,
  maxMinor,
  onClose,
  onDone,
}: {
  intentId: string;
  currency: string;
  maxMinor: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /* ONE key per refund attempt, STABLE across retries — it is what stops a
     refund the network swallowed from being paid twice when the operator
     clicks again (the client contract's own words). Minted when the modal
     opens, kept for its lifetime. */
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  async function commit() {
    const parsed = parseRefund(amount, currency, maxMinor);
    if (!parsed.ok) {
      setError(moneyRefusalMessage(parsed.reason, currency));
      return;
    }
    setBusy(true);
    try {
      const refund = await shopApi.refundPayment(intentId, {
        amount: parsed.minor,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        idempotencyKey,
      });
      toast.show(`Refunded ${money(refund.amount, refund.currency)}`);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Refund payment"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="critical" busy={busy} onClick={() => void commit()}>
            <Undo2 aria-hidden="true" />
            Refund
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.5 }}>
          Money moves back through Paystack. The order stays as it is — refunding does not cancel
          it.
        </p>
        <AffixField
          label="Amount"
          prefix={currency}
          inputMode="decimal"
          value={amount}
          error={error}
          autoFocus
          hint={`Up to ${money(maxMinor, currency)} is still refundable.`}
          onChange={(e) => {
            setAmount(e.target.value);
            setError(null);
          }}
        />
        <TextField
          label="Reason"
          value={reason}
          placeholder="Optional — the customer sees nothing of this"
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
    </Modal>
  );
}

/* ═════════════════════════════════════════════════════════ EMAIL ROW ════ */

function EmailRow({ mail }: { mail: ShopEmailIntent }) {
  const stuck = mail.sentAt === null && mail.lastError !== null && mail.attempts > 0;
  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--t-md)', fontWeight: 'var(--w-medium)' }} className="truncate">
          {mail.subject}
        </div>
        <div className="muted" style={{ fontSize: 'var(--t-sm)' }}>
          {humanise(mail.kind)} · to {mail.to} · {dateTime(mail.createdAt)}
          {mail.attempts > 0 ? ` · ${mail.attempts} ${mail.attempts === 1 ? 'attempt' : 'attempts'}` : ''}
        </div>
        {stuck && mail.lastError ? (
          <div style={{ fontSize: 'var(--t-sm)', color: 'var(--critical)' }} className="truncate" title={mail.lastError}>
            {mail.lastError}
          </div>
        ) : null}
      </div>
      <Badge tone={mail.sentAt ? 'ok' : stuck ? 'critical' : 'neutral'}>
        {mail.sentAt ? 'Handed to mailer' : stuck ? 'Stuck' : 'Queued'}
      </Badge>
    </div>
  );
}

function OrderSkeleton() {
  return (
    <div className="page" aria-busy="true">
      <div>
        <span className="skel" style={{ width: '4rem' }} />
        <div className="page__head" style={{ marginTop: 'var(--s2)' }}>
          <span className="skel" style={{ width: '13rem', height: '1rem' }} />
        </div>
      </div>
      <div className="form2">
        <div className="form2__main">
          <div className="card" style={{ padding: 'var(--s4)' }}>
            <div className="stack stack--tight">
              {[0, 1, 2].map((i) => (
                <div key={i} className="row" style={{ gap: 'var(--s3)' }}>
                  <span className="skel" style={{ width: '14rem' }} />
                  <span className="spacer" />
                  <span className="skel" style={{ width: '4rem' }} />
                </div>
              ))}
            </div>
          </div>
          <div className="card" style={{ padding: 'var(--s4)' }}>
            <span className="skel" style={{ width: '10rem' }} />
          </div>
        </div>
        <aside className="form2__side">
          <div className="card" style={{ padding: 'var(--s4)' }}>
            <div className="stack stack--tight">
              <span className="skel" style={{ width: '8rem' }} />
              <span className="skel" style={{ width: '11rem', opacity: 0.7 }} />
              <span className="skel" style={{ width: '9rem', opacity: 0.5 }} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

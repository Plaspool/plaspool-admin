import { Fragment, useEffect, useMemo, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { Ban, Check, CreditCard, PackageCheck, Pencil, Receipt, Truck, Undo2 } from 'lucide-react';
import {
  moneyRefusalMessage,
  parseRefund,
  shopApi,
  type CancelRefundChoice,
  type ManualOrderRevision,
  type ManualOrderStock,
  type ShopCourierProvider,
  type ShopEmailIntent,
  type ShopBoxFill,
  type ShopBoxLine,
  type ShopFulfillment,
  type ShopOrderDetail,
  type ShopOrderLine,
  type ShopRestockChoice,
  type ShopTimelineEntry,
} from '../../data/api-shop';
import { ApiError } from '../../data/errors';
import { getSession } from '../../data/session';
import { useAsync } from '../lib/useAsync';
import { dateTime, humanise, money, orderTone } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button, ButtonLink } from '../ui/primitives';
import { Card } from '../ui/Card';
import { Defs, type DefRow } from '../ui/Defs';
import { Checkbox, MoneyField, Radio, TextField } from '../ui/Field';
import { BoxFillModal } from './BoxFillModal';
import { MenuItem, MenuSeparator } from '../ui/Menu';
import { Modal } from '../ui/Modal';
import { Timeline, type TimelineEvent } from '../ui/Timeline';
import { useToast } from '../ui/Toast';
import { CourierDialog, describeCourierError } from './CourierDialog';
import { COURIER_COPY, canBook, courierStateBadge } from './courier-copy';
import {
  dayLabel,
  diffSnapshots,
  orderStatusLabel,
  paymentMethodLabel,
  revisionHeadline,
  salesChannelLabel,
  STALE_ORDER,
  stockReason,
} from './manual-order-copy';
import { countryName } from './countries';
import { describeRefundError, gatewayName } from './payment-copy';
import { isAdminRole } from '../../../shared/roles';

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

function optionLabel(values: Record<string, string>): string | null {
  const parts = Object.values(values).filter(Boolean);
  return parts.length ? parts.join(' / ') : null;
}

/** The address is a loose record server-side; render the keys people expect,
 *  in the order a label would print them, and nothing invented. */
function addressLines(addr: Record<string, unknown> | null | undefined): string[] {
  if (!addr) return [];
  const pick = (k: string) => (typeof addr[k] === 'string' && addr[k] ? String(addr[k]) : null);
  /*
   * WHAT THE COURIER WAS TOLD, WHEN IT IS NOT WHAT THE CUSTOMER TYPED.
   *
   * The shopper picks a routing city off the courier's own list because
   * Terminal refuses a city that is not on it. Staff chasing a parcel need to
   * see the zone it actually went out under — otherwise a waybill saying
   * Maitama for an order that says Gwarinpa is a mystery this screen cannot
   * resolve.
   *
   * ONLY WHEN IT DIFFERS, and quietly. On most orders the two are the same
   * string or there is no zone at all (every order placed before migration
   * 1020), and a line repeating the city back would be noise on every one of
   * them. The customer's own city keeps its usual place above.
   */
  const routing = pick('routingCity');
  const lines = [
    pick('name') ?? pick('fullName'),
    pick('phone'),
    pick('line1') ?? pick('address1') ?? pick('street'),
    pick('line2') ?? pick('address2'),
    [pick('district'), pick('city')].filter(Boolean).join(', ') || null,
    routing && routing !== pick('city') ? `${routing} · courier zone` : null,
    [pick('region') ?? pick('state'), pick('postalCode') ?? pick('postcode')]
      .filter(Boolean)
      .join(' ') || null,
    pick('country'),
  ];
  return lines.filter((l): l is string => Boolean(l));
}

/* ═══════════════════════════════════════════════════════════ NEXT STEP ════ */

/**
 * The one lifecycle move this order is waiting on, derived from the loaded
 * order + parcels — so the More actions menu can always NAME it and run it.
 *
 * The derivation mirrors the server's own ordering: money first (nothing to do
 * until it lands), then unpacked quantity, then parcels in flight. A settled
 * order — everything delivered, or cancelled/refunded — has no step, and says
 * so rather than hiding the item.
 */
type NextStep =
  | { kind: 'awaiting' }
  | { kind: 'settled' }
  | { kind: 'fulfil' }
  | { kind: 'ship'; parcel: ShopFulfillment; index: number }
  | { kind: 'deliver'; parcel: ShopFulfillment; index: number };

/** The first parcel in `status`, with its 1-based position — the SAME number
 *  the FulfilmentRow list paints, because the menu names "Parcel N" and the
 *  two must agree. */
function firstParcel(
  fulfillments: ShopFulfillment[],
  status: 'pending' | 'shipped',
): { parcel: ShopFulfillment; index: number } | null {
  for (let i = 0; i < fulfillments.length; i += 1) {
    const parcel = fulfillments[i];
    if (parcel && parcel.status === status) return { parcel, index: i + 1 };
  }
  return null;
}

/**
 * MYSTERY BOXES (migration 1220). Whether a filled box is still free to go in a
 * parcel: in none yet, or only in one that was cancelled. The server's parcel
 * guard uses the same rule; this copy only shapes the screen.
 */
function boxIsFree(fill: ShopBoxFill, fulfillments: ShopFulfillment[]): boolean {
  if (fill.fulfillmentId === null) return true;
  return fulfillments.find((f) => f.id === fill.fulfillmentId)?.status === 'cancelled';
}

/**
 * How many units of a line can go in a parcel NOW. An ordinary line: whatever
 * has not been sent. A box line: only its filled boxes not already in a live
 * parcel, because an empty box cannot be sent.
 */
function sendableUnits(
  line: ShopOrderLine,
  fulfillments: ShopFulfillment[],
  boxLines: ShopBoxLine[],
  boxFills: ShopBoxFill[],
): number {
  const remaining = line.qty - line.fulfilledQty;
  if (!boxLines.some((b) => b.orderLineId === line.id)) return remaining;
  const free = boxFills.filter((f) => f.orderLineId === line.id && boxIsFree(f, fulfillments)).length;
  return Math.max(0, Math.min(remaining, free));
}

function deriveNextStep(
  order: ShopOrderDetail['order'],
  lines: ShopOrderLine[],
  fulfillments: ShopFulfillment[],
  boxLines: ShopBoxLine[] = [],
  boxFills: ShopBoxFill[] = [],
): NextStep {
  if (order.status === 'pending') return { kind: 'awaiting' };
  if (order.status === 'cancelled' || order.status === 'refunded') return { kind: 'settled' };

  const remainder = lines.reduce((n, l) => n + sendableUnits(l, fulfillments, boxLines, boxFills), 0);
  if ((order.status === 'paid' || order.status === 'partially_refunded') && remainder > 0) {
    return { kind: 'fulfil' };
  }

  const pending = firstParcel(fulfillments, 'pending');
  if (pending) return { kind: 'ship', ...pending };
  const shipped = firstParcel(fulfillments, 'shipped');
  if (shipped) return { kind: 'deliver', ...shipped };
  return { kind: 'settled' };
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
    meta: `${dateTime(entry.occurredAt)}${entry.actorName || entry.actorId ? ` · ${entry.actorName || entry.actorId}` : ''}`,
  };
}

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(
    (signal) => shopApi.getOrder(id!, signal),
    [id],
  );

  /* WHICH COURIER IS SWITCHED ON — a SEPARATE, failure-tolerant read. This
     screen is worked by roles that do not hold the settings domain, and the
     order must never fail to load because the courier question could not be
     answered: anything but a clean answer reads as By hand, which is the
     screen exactly as it was before couriers existed. */
  const [courier, setCourier] = useState<ShopCourierProvider>({ provider: 'manual', label: 'By hand' });
  useEffect(() => {
    const controller = new AbortController();
    shopApi
      .getCourierProvider(controller.signal)
      .then((c) => setCourier(c))
      .catch(() => setCourier({ provider: 'manual', label: 'By hand' }));
    return () => controller.abort();
  }, [id]);

  /* A MANUAL ORDER'S EDIT HISTORY — read only for a manual order, and again
     after every save or void (the revision moves). Failure-tolerant like the
     courier read: the order itself must load whatever this says. */
  const manualRevision =
    data?.order.source === 'manual' ? data.order.revision : null;
  const [revisions, setRevisions] = useState<ManualOrderRevision[] | null>(null);
  const [revisionsError, setRevisionsError] = useState(false);
  useEffect(() => {
    if (manualRevision === null || !id) return;
    const controller = new AbortController();
    setRevisionsError(false);
    shopApi
      .listOrderRevisions(id, controller.signal)
      .then((items) => setRevisions(items))
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setRevisionsError(true);
      });
    return () => controller.abort();
  }, [id, manualRevision]);

  /* Lines a save could not take out of stock, handed over by the form. The
     order was saved; this is the one moment to say what still needs doing. */
  const location = useLocation();
  const stockFailed =
    (location.state as { stockFailed?: ManualOrderStock['failed'] } | null)?.stockFailed ?? [];

  const [modal, setModal] = useState<'none' | 'fulfil' | 'cancel' | 'refund' | 'void'>('none');
  /* Migration 1220. The mystery box being filled, if any. */
  const [filling, setFilling] = useState<{ lineId: string; boxNo: number } | null>(null);
  /** Booking a courier for ONE parcel, so it carries which parcel — the same
   *  shape and the same reason as the ship dialog below. */
  const [courierDialog, setCourierDialog] = useState<{
    parcel: ShopFulfillment;
    index: number;
  } | null>(null);
  /** The ship dialog carries a payload — WHICH parcel, and whether the confirm
   *  transitions it or only saves details — so it is state of its own rather
   *  than a fifth arm of `modal`. */
  const [shipDialog, setShipDialog] = useState<{
    parcel: ShopFulfillment;
    index: number;
    mode: 'ship' | 'details';
  } | null>(null);

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
  /* Migration 1220. Which lines are mystery boxes, and what is in the filled ones.
     Both absent on a response from before boxes existed. */
  const boxLines = data.boxLines ?? [];
  const boxFills = data.boxFills ?? [];
  const boxPaid = order.status === 'paid' || order.status === 'partially_refunded';
  const emptyBoxes = boxPaid
    ? boxLines.flatMap((b) => {
        const line = lines.find((l) => l.id === b.orderLineId);
        if (!line) return [];
        return Array.from({ length: line.qty }, (_, i) => i + 1)
          .filter((n) => !boxFills.some((f) => f.orderLineId === line.id && f.boxNo === n))
          .map((boxNo) => ({ line, boxNo }));
      })
    : [];
  const onlyOneBoxLine = boxLines.length === 1;
  const unfulfilled = lines.some((l) => l.fulfilledQty < l.qty);

  /* A SALE RECORDED BY HAND. It arrives already sent out and paid, has no
     checkout, no parcels and no payment intent — so the parcel, send-out,
     refund and cancel controls have nothing to act on, and it gets Edit and
     Void instead. Every branch below is keyed on this, and an online order
     (including one from before `source` existed) renders exactly as it did. */
  const isManual = order.source === 'manual';
  const voided = isManual && order.status === 'cancelled';
  const manual = isManual ? (data.manual ?? null) : null;

  /* Cancel and refund are OWNER-ONLY at the server; a writer gets no dead
     menu items to click into a 403. */
  const session = getSession();
  /* Owner-grade means owner OR developer since migration 0680 — the
     server's requireAdmin() tier, mirrored (shared/roles.ts). */
  const isOwner = 'user' in session && session.user != null && isAdminRole(session.user.role);

  const canFulfil =
    !isManual && (order.status === 'paid' || order.status === 'partially_refunded') && unfulfilled;
  const canCancel =
    !isManual && isOwner && (order.status === 'pending' || order.status === 'paid');
  const intentId = payment?.intentId ?? order.paymentIntentId;
  /* The gateway THIS payment went through — a refund goes back the same way. */
  const gateway = gatewayName(payment?.provider);
  const refundable = order.grandTotal - order.refundedTotal;
  const canRefund =
    !isManual &&
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

  /** What every parcel change funnels through — the FulfilmentRow buttons, the
   *  ship dialog, and the next-step deliver all report here, so the settled
   *  toast has exactly one wording and one trigger. */
  const parcelChanged = (settled: boolean) => {
    if (settled) toast.show('Every parcel is on its way — order complete');
    reload();
  };

  /** The next-step deliver: the EXISTING direct flow, with the existing
   *  toasts — no dialog, because delivery has nothing to confirm. */
  async function deliverParcel(parcel: ShopFulfillment, index: number) {
    try {
      const res = await shopApi.setFulfillmentStatus(parcel.id, 'delivered');
      toast.show(`Parcel ${index} ${humanise(res.fulfillment.status).toLowerCase()}`);
      parcelChanged(Boolean(res.order));
    } catch (cause) {
      toast.show(
        cause instanceof Error && cause.message ? cause.message : 'Something went wrong.',
        'critical',
      );
    }
  }

  const nextStep = deriveNextStep(order, lines, fulfillments, boxLines, boxFills);

  /** The FIRST item of More actions, always present: it names the next
   *  lifecycle move and runs it — or says honestly that there is none. */
  function nextStepItem(close: () => void) {
    switch (nextStep.kind) {
      case 'awaiting':
        return <MenuItem onSelect={close}>Waiting for payment — nothing to do yet</MenuItem>;
      case 'settled':
        return <MenuItem onSelect={close}>Nothing to do — this order is settled</MenuItem>;
      case 'fulfil':
        return (
          <MenuItem
            icon={<PackageCheck aria-hidden="true" />}
            onSelect={() => {
              close();
              setModal('fulfil');
            }}
          >
            Next step: Send out items…
          </MenuItem>
        );
      case 'ship':
        return (
          <MenuItem
            icon={<Truck aria-hidden="true" />}
            onSelect={() => {
              close();
              setShipDialog({ parcel: nextStep.parcel, index: nextStep.index, mode: 'ship' });
            }}
          >
            Next step: Mark Parcel {nextStep.index} shipped…
          </MenuItem>
        );
      case 'deliver':
        return (
          <MenuItem
            icon={<Check aria-hidden="true" />}
            onSelect={() => {
              close();
              void deliverParcel(nextStep.parcel, nextStep.index);
            }}
          >
            Next step: Mark Parcel {nextStep.index} delivered
          </MenuItem>
        );
    }
  }

  /** A manual order's header: Edit on the row, Void behind More actions —
   *  and nothing at all once it is void, because nothing is left to do. */
  const manualHeader = isManual
    ? {
        titleBadge: (
          <>
            <Badge tone={orderTone(order.status)}>{orderStatusLabel(order)}</Badge>
            <Badge dot={false}>Manual</Badge>
          </>
        ),
        subtitle: [`Sold ${dayLabel(order.paidAt ?? order.placedAt)}`, manual?.customer?.name, order.email]
          .filter(Boolean)
          .join(' · '),
        actions: voided ? undefined : (
          <ButtonLink to={`/orders/${order.id}/edit`} size="lg">
            <Pencil aria-hidden="true" />
            Edit
          </ButtonLink>
        ),
        /* Void is owner-grade at the server (`requireAdmin`), like cancel —
           a writer gets no menu item to click into a 403. */
        menu: voided || !isOwner
          ? undefined
          : (close: () => void) => (
              <MenuItem
                critical
                icon={<Ban aria-hidden="true" />}
                onSelect={() => {
                  close();
                  setModal('void');
                }}
              >
                Void order…
              </MenuItem>
            ),
      }
    : null;

  return (
    <div className="page">
      {manualHeader ? (
        <PageHeader
          icon={<Receipt />}
          title={order.orderNumber}
          titleBadge={manualHeader.titleBadge}
          subtitle={manualHeader.subtitle}
          backTo="/orders"
          backLabel="Orders"
          actions={manualHeader.actions}
          menu={manualHeader.menu}
        />
      ) : (
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
              Send out items
            </Button>
          ) : undefined
        }
        menu={(close) => (
          <>
            {nextStepItem(close)}
            {canRefund || canCancel ? <MenuSeparator /> : null}
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
          </>
        )}
      />
      )}

      {voided ? (
        <Banner tone="warn" title="This order was voided">
          It no longer counts as a sale.
          {manual?.stockTaken ? ' The items it took out of stock were put back.' : ''}
        </Banner>
      ) : null}

      {stockFailed.length > 0 ? (
        <Banner tone="warn" title="Some items weren’t taken out of stock">
          The order is saved, but the stock count didn’t change for{' '}
          {stockFailed.map((f) => `${f.sku} (${stockReason(f.reason)})`).join(', ')}
          . Check {stockFailed.length === 1 ? 'it' : 'them'} in Inventory.
        </Banner>
      ) : null}

      {order.status === 'pending' ? (
        <Banner tone="warn" title="Waiting for payment">
          The customer reached checkout but the money hasn’t arrived yet. This updates on its own once{' '}
          {gateway ? `${gateway} confirms` : 'the payment is confirmed'}. Nothing to do here yet.
        </Banner>
      ) : null}

      {boxPaid && data.boxShortAt && emptyBoxes.length > 0 ? (
        <Banner tone="critical" title="The shop couldn’t fill this mystery box by itself">
          {`There wasn’t enough on the mystery box list on ${dateTime(data.boxShortAt)}. Fill it by hand below, or cancel and refund the order.`}
        </Banner>
      ) : null}

      {emptyBoxes.length > 0 ? (
        <Banner
          tone="warn"
          title={
            onlyOneBoxLine
              ? `Box ${emptyBoxes[0].boxNo} needs filling before it can go in a parcel`
              : `${emptyBoxes[0].line.title}, box ${emptyBoxes[0].boxNo}, needs filling before it can go in a parcel`
          }
          action={
            <Button
              tone="primary"
              onClick={() => setFilling({ lineId: emptyBoxes[0].line.id, boxNo: emptyBoxes[0].boxNo })}
            >
              {`Fill box ${emptyBoxes[0].boxNo}`}
            </Button>
          }
        >
          {emptyBoxes.length === 1
            ? 'Everything else on this order can be sent out now. The box’s items leave stock when you save its contents.'
            : `${emptyBoxes.length} boxes are empty. Everything else on this order can be sent out now.`}
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
                  Send out items
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
                    {isManual ? null : <th scope="col">Fulfilled</th>}
                    <th scope="col" className="th--num">Unit</th>
                    <th scope="col" className="th--num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <Fragment key={line.id}>
                    <tr>
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
                      {isManual ? null : (
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
                      )}
                      <td className="cell--num">{money(line.unitAmount, currency)}</td>
                      <td className="cell--num">
                        <strong className="num">{money(line.lineTotal, currency)}</strong>
                      </td>
                    </tr>
                    {boxLines.some((b) => b.orderLineId === line.id)
                      ? Array.from({ length: line.qty }, (_, i) => i + 1).map((boxNo) => {
                          const fill = boxFills.find((f) => f.orderLineId === line.id && f.boxNo === boxNo);
                          const label = onlyOneBoxLine ? `box ${boxNo}` : `box ${boxNo} of ${line.title}`;
                          return (
                            <tr key={`${line.id}-box-${boxNo}`} className="tr--box">
                              <td colSpan={isManual ? 3 : 4}>
                                <span className="idcell">
                                  <span className="idcell__text">
                                    <span className="idcell__title">Box {boxNo}</span>
                                    <span className="idcell__meta">
                                      {fill
                                        ? fill.items.map((it) => it.title).join(', ')
                                        : 'Not filled yet'}
                                    </span>
                                  </span>
                                </span>
                              </td>
                              <td className="cell--num">
                                {!boxPaid ? null : !fill ? (
                                  <Button aria-label={`Fill ${label}`} onClick={() => setFilling({ lineId: line.id, boxNo })}>
                                    Fill box
                                  </Button>
                                ) : boxIsFree(fill, fulfillments) ? (
                                  <Button tone="plain" aria-label={`Change ${label}`} onClick={() => setFilling({ lineId: line.id, boxNo })}>
                                    Change
                                  </Button>
                                ) : (
                                  <Badge tone="ok">In a parcel</Badge>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── add-ons ───────────────────────────────────────────────── */}
          {(data.addOns ?? []).length > 0 ? (
            <Card title="Add-ons">
              <ul style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s2)' }}>
                {(data.addOns ?? []).map((a) => (
                  <li
                    key={a.id}
                    style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s3)' }}
                  >
                    <span>
                      {a.title}
                      {/* A packer has to know a box was taken OUT, and how many.
                          The money alone does not say it — a minus is easy to
                          read past, and ₦0 beside “Included” says nothing about
                          how many went in. */}
                      {a.mode === 'removed' ? <span className="muted"> · taken out</span> : null}
                      {a.units > 1 ? <span className="muted"> · {a.units} × {money(Math.abs(a.unitAmount), a.currency)}</span> : null}
                    </span>
                    <span className="num">
                      {a.mode !== 'removed' && a.amount === 0 ? 'Included' : money(a.amount, a.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {/* ── a manual order's edit history ─────────────────────────── */}
          {isManual ? (
            <EditHistory revisions={revisions} failed={revisionsError} currency={currency} />
          ) : null}

          {/* ── fulfilments ───────────────────────────────────────────── */}
          {/* A manual order is recorded already sent out and never gets a
              parcel, so the card would only ever say "Nothing packed yet". */}
          {isManual && fulfillments.length === 0 ? null : (
          <Card title="Parcels">
            {fulfillments.length === 0 ? (
              <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
                Nothing packed yet.{' '}
                {canFulfil ? 'Send out some items to start a parcel.' : ''}
              </p>
            ) : (
              <div className="stack">
                {fulfillments.map((f, i) => (
                  <FulfilmentRow
                    key={f.id}
                    index={i + 1}
                    fulfillment={f}
                    lines={lines}
                    courier={courier}
                    onBook={() => setCourierDialog({ parcel: f, index: i + 1 })}
                    onShip={() => setShipDialog({ parcel: f, index: i + 1, mode: 'ship' })}
                    onEditTracking={() =>
                      setShipDialog({ parcel: f, index: i + 1, mode: 'details' })
                    }
                    onChanged={parcelChanged}
                  />
                ))}
              </div>
            )}
          </Card>
          )}

          {/* ── emails ────────────────────────────────────────────────── */}
          {isManual && emails.length === 0 ? null : (
          <Card title="Emails">
            {emails.length === 0 ? (
              <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
                No emails sent for this order yet.
              </p>
            ) : (
              <div className="stack stack--tight">
                {emails.map((mail) => (
                  <EmailRow key={mail.id} mail={mail} />
                ))}
              </div>
            )}
          </Card>
          )}

          {/* ── timeline ──────────────────────────────────────────────── */}
          <Card title="History">
            {timeline.length === 0 ? (
              <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
                Nothing recorded yet.
              </p>
            ) : (
              <Timeline events={timeline.map(timelineEvent)} />
            )}
          </Card>
        </div>

        {isManual ? (
          <ManualRail detail={data} itemCount={itemCount} />
        ) : (
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
                ...((order.addOnTotal ?? 0) > 0
                  ? [{ label: 'Add-ons', value: <span className="num">{money(order.addOnTotal, currency)}</span> } satisfies DefRow]
                  : []),
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
              Saved at checkout. These are the amounts the customer agreed to, and they never change.
            </span>
            {payment ? (
              <div className="row" style={{ gap: 'var(--s2)', flexWrap: 'wrap' }}>
                <CreditCard aria-hidden="true" style={{ width: 15, height: 15, color: 'var(--ink-sub)' }} />
                {gateway ? <span style={{ fontWeight: 'var(--w-medium)' }}>{gateway}</span> : null}
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
                  ['Sent out', order.fulfilledAt],
                  ['Delivered', order.deliveredAt],
                  ['Cancelled', order.cancelledAt],
                ] as const
              )
                .filter(([, at]) => at !== null)
                .map(([label, at]) => ({ label, value: dateTime(at) }))}
            />
          </Card>
        </aside>
        )}
      </div>

      {modal === 'void' ? (
        <VoidModal order={data} onClose={() => setModal('none')} onDone={done} />
      ) : null}
      {modal === 'fulfil' ? (
        <FulfilModal
          orderId={order.id}
          lines={lines}
          courier={courier}
          sendable={(l) => sendableUnits(l, fulfillments, boxLines, boxFills)}
          onClose={() => setModal('none')}
          onDone={done}
        />
      ) : null}
      {modal === 'cancel' ? (
        <CancelModal order={data} onClose={() => setModal('none')} onDone={done} />
      ) : null}
      {filling
        ? (() => {
            const line = lines.find((l) => l.id === filling.lineId);
            const spec = boxLines.find((b) => b.orderLineId === filling.lineId);
            if (!line || !spec) return null;
            return (
              <BoxFillModal
                target={{
                  kind: 'order',
                  orderId: order.id,
                  line,
                  boxNo: filling.boxNo,
                  existing:
                    boxFills.find((f) => f.orderLineId === filling.lineId && f.boxNo === filling.boxNo) ?? null,
                }}
                itemCount={spec.itemCount ?? 1}
                onClose={() => setFilling(null)}
                onDone={() => {
                  setFilling(null);
                  reload();
                }}
              />
            );
          })()
        : null}
      {modal === 'refund' && intentId ? (
        <RefundModal
          intentId={intentId}
          gateway={gateway}
          currency={currency}
          maxMinor={refundable}
          onClose={() => setModal('none')}
          onDone={done}
        />
      ) : null}
      {courierDialog ? (
        <CourierDialog
          parcel={courierDialog.parcel}
          index={courierDialog.index}
          order={order}
          providerLabel={courier.label}
          onClose={() => setCourierDialog(null)}
          onBooked={() => {
            setCourierDialog(null);
            reload();
          }}
        />
      ) : null}
      {shipDialog ? (
        <ShipDialog
          parcel={shipDialog.parcel}
          index={shipDialog.index}
          mode={shipDialog.mode}
          onClose={() => setShipDialog(null)}
          onDone={(settled) => {
            setShipDialog(null);
            parcelChanged(settled);
          }}
        />
      ) : null}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════ MANUAL ORDERS ═══ */

/**
 * The rail of a sale recorded by hand. Its own component rather than a branch
 * per row of the online rail: almost every fact differs (no account, no
 * checkout, no intent; a payment METHOD instead), and an online order must
 * render exactly as it did before manual orders existed.
 */
function ManualRail({ detail, itemCount }: { detail: ShopOrderDetail; itemCount: number }) {
  const { order } = detail;
  const manual = detail.manual ?? null;
  const currency = order.currency;
  const customer = manual?.customer ?? null;
  /* No discount figure rides the detail; it is what the parts add up to
     beyond the total. Never shown when it is nothing. */
  const discount =
    order.subtotal + order.shippingTotal + order.taxTotal + (order.addOnTotal ?? 0) - order.grandTotal;
  /* The stored address carries the buyer's name and phone too (the same keys
     an online order's does); both already sit in the rows above, so the
     address block shows only the place. */
  const addr: Record<string, unknown> = { ...(order.shippingAddress ?? {}) };
  delete addr.name;
  delete addr.phone;
  const countryCode = typeof addr.countryCode === 'string' ? addr.countryCode : null;
  const shownAddress =
    countryCode && !addr.country ? { ...addr, country: countryName(countryCode) } : addr;
  const hasAddress = addressLines(shownAddress).length > 0;
  const who: DefRow[] = [
    ...(customer?.name ? [{ label: 'Name', value: customer.name }] : []),
    ...(customer?.email ? [{ label: 'Email', value: customer.email }] : []),
    ...(customer?.phone ? [{ label: 'Phone', value: customer.phone }] : []),
  ];
  const num = (minor: number) => <span className="num">{money(minor, currency)}</span>;

  return (
    <aside className="form2__side">
      <Card title="How it was paid">
        <Defs
          rows={[
            { label: 'Paid by', value: paymentMethodLabel(manual?.paymentMethod) },
            {
              label: 'Reference',
              value: manual?.paymentReference ? (
                <span className="mono">{manual.paymentReference}</span>
              ) : (
                '—'
              ),
            },
            { label: 'Came from', value: salesChannelLabel(manual?.salesChannel) },
            {
              label: 'Stock',
              value: manual?.stockTaken ? 'Taken out of stock' : 'Not taken out of stock',
            },
          ]}
        />
        {manual?.note ? (
          <div className="stack stack--tight">
            <span className="field__label">Note</span>
            <p style={{ fontSize: 'var(--t-md)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
              {manual.note}
            </p>
          </div>
        ) : null}
      </Card>

      <Card title="Customer">
        {who.length > 0 ? (
          <Defs rows={who} />
        ) : (
          <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
            No customer details recorded.
          </p>
        )}
        {hasAddress ? <AddressBlock label="Delivery address" addr={shownAddress} /> : null}
      </Card>

      <Card title="Payment">
        <Defs
          rows={[
            {
              label: `Subtotal · ${itemCount} ${itemCount === 1 ? 'item' : 'items'}`,
              value: num(order.subtotal),
            },
            ...(order.shippingTotal > 0 ? [{ label: 'Delivery', value: num(order.shippingTotal) }] : []),
            ...(order.taxTotal > 0 ? [{ label: 'Tax', value: num(order.taxTotal) }] : []),
            ...(discount > 0
              ? [{ label: 'Discount', value: <span className="num">−{money(discount, currency)}</span> }]
              : []),
            { label: 'Total', value: num(order.grandTotal), total: true },
          ]}
        />
        <span className="field__hint">Entered by hand when the sale was recorded.</span>
      </Card>

      <Card title="Details">
        <Defs
          rows={[
            { label: 'Sold', value: dayLabel(order.paidAt ?? order.placedAt) },
            { label: 'Recorded', value: dateTime(order.placedAt) },
            ...(order.cancelledAt !== null ? [{ label: 'Voided', value: dateTime(order.cancelledAt) }] : []),
          ]}
        />
      </Card>
    </aside>
  );
}

/**
 * Every saved state of a manual order, newest first, each with what changed
 * against the one before it. The oldest entry is the order being recorded, and
 * has nothing before it to compare with.
 */
function EditHistory({
  revisions,
  failed,
  currency,
}: {
  revisions: ManualOrderRevision[] | null;
  failed: boolean;
  currency: string;
}) {
  const quiet = { fontSize: 'var(--t-md)' };
  return (
    <Card title="Edit history">
      {failed ? (
        <p className="muted" style={quiet}>
          Couldn’t load the edit history.
        </p>
      ) : revisions === null ? (
        <p className="muted" style={quiet}>
          Loading the edit history…
        </p>
      ) : revisions.length === 0 ? (
        <p className="muted" style={quiet}>
          Nothing recorded yet.
        </p>
      ) : (
        <ol className="mo__history">
          {revisions.map((entry, i) => {
            const older = revisions[i + 1];
            const compare = entry.kind !== 'created' && older !== undefined;
            const changes = compare
              ? diffSnapshots(older.snapshot ?? {}, entry.snapshot ?? {}, currency)
              : [];
            return (
              <li key={entry.revision}>
                <div className="mo__history-head">
                  <strong>{revisionHeadline(entry)}</strong>
                  <span className="mo__history-when">{dateTime(entry.editedAt)}</span>
                </div>
                {compare ? (
                  changes.length > 0 ? (
                    <ul className="summary">
                      {changes.map((change) => (
                        <li key={change}>{change}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted" style={{ fontSize: 'var(--t-sm)' }}>
                      Saved with no changes.
                    </p>
                  )
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

/** Void a manual order — the one way to take a recorded sale back out of the
 *  figures. Confirmed, because it cannot be edited afterwards. */
function VoidModal({
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
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      await shopApi.voidOrder(order.id, order.revision, reason.trim() || undefined);
      toast.show(`${order.orderNumber} voided`);
      onDone();
    } catch (cause) {
      setBusy(false);
      if (cause instanceof ApiError && cause.status === 409) {
        setError(STALE_ORDER);
        return;
      }
      setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
    }
  }

  return (
    <Modal
      title="Void this order?"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Keep the order</Button>
          <Button tone="critical" busy={busy} onClick={() => void commit()}>
            Void order
          </Button>
        </>
      }
    >
      <div className="stack">
        <p style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
          It will no longer count as a sale.
          {detail.manual?.stockTaken ? ' The items it took out of stock go back in.' : ''} A voided
          order can’t be edited.
        </p>
        <TextField
          label="Reason (optional)"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
        {error ? (
          <span className="field__error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </Modal>
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
  courier,
  onBook,
  onShip,
  onEditTracking,
  onChanged,
}: {
  index: number;
  fulfillment: ShopFulfillment;
  lines: ShopOrderLine[];
  /** Which courier the shop has switched on. `manual` — including every way
   *  the question could not be answered — leaves this row exactly as it was. */
  courier: ShopCourierProvider;
  /** Open the booking dialog for this parcel. */
  onBook: () => void;
  /** Open the ship dialog for this parcel — the transition itself, and its
   *  busy state, live there now (the email renders what the dialog confirms). */
  onShip: () => void;
  /** The same dialog in details-only mode: no transition, pending parcels only. */
  onEditTracking: () => void;
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

  /* ── the courier, if one is switched on ─────────────────────────────── */
  const state = fulfillment.courierState ?? null;
  const badge = courierStateBadge(state);
  const courierOn = courier.provider !== 'manual';
  const bookable = courierOn && fulfillment.status === 'pending' && canBook(state);
  const P = COURIER_COPY.parcel;

  /** Ask the courier where the parcel is, or call the booking off. Both
   *  answer with the parcel, and both re-read the order rather than patching
   *  the row from here: a refresh can also SHIP or DELIVER it server-side.
   *
   *  THE FAILURE IS A SENTENCE, NOT A CODE. These two buttons hit the same
   *  routes the booking dialog does and get the same refusals back —
   *  `already_shipped`, `provider_rejected`, `provider_error` — and
   *  `ApiError.message` is the bare code (`src/data/api.ts` passes no
   *  message), so this toast used to read `provider_rejected` at an operator
   *  holding a parcel. `describeCourierError` is the dialog's own switch,
   *  shared rather than copied. */
  async function courierAction(kind: 'refresh' | 'cancel') {
    setBusy(kind);
    try {
      if (kind === 'refresh') {
        const res = await shopApi.refreshCourier(fulfillment.id);
        /* Nothing moved: say so, rather than repeating "status refreshed" over
           a row that looks exactly like it did before the press. */
        toast.show(
          !res.changed && res.transitioned === null ? P.refreshedNoChange : P.refreshed(index),
        );
      } else {
        await shopApi.cancelCourier(fulfillment.id);
        toast.show(P.courierCancelled(index));
      }
      onChanged(false);
    } catch (cause) {
      toast.show(describeCourierError(cause, courier.label), 'critical');
    } finally {
      setBusy(null);
    }
  }

  /* Shipping is no longer fired from here — the ship dialog owns it, so the
     carrier/tracking the email renders are confirmed rather than assumed. */
  async function move(status: 'delivered' | 'cancelled') {
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
            /* A courier that gave us somewhere to look makes the number the
               link; typed-in tracking stays plain text, because a link to
               nowhere is worse than no link. */
            fulfillment.trackingUrl ? (
              <a className="mono" href={fulfillment.trackingUrl} target="_blank" rel="noreferrer">
                {fulfillment.trackingNumber}
              </a>
            ) : (
              <span className="mono">{fulfillment.trackingNumber}</span>
            )
          ) : (
            'No tracking'
          )}
          {fulfillment.labelUrl ? (
            <>
              {' · '}
              <a href={fulfillment.labelUrl} target="_blank" rel="noreferrer">
                {P.waybill}
              </a>
            </>
          ) : null}
          {' · created '}
          {dateTime(fulfillment.createdAt)}
          {fulfillment.shippedAt ? ` · shipped ${dateTime(fulfillment.shippedAt)}` : ''}
          {fulfillment.deliveredAt ? ` · delivered ${dateTime(fulfillment.deliveredAt)}` : ''}
        </div>
        {/* The courier's own line, and only for a parcel that HAS one — every
            field here is absent on a parcel from before couriers shipped. */}
        {fulfillment.provider ? (
          <div className="row" style={{ gap: 'var(--s2)', marginTop: 4, flexWrap: 'wrap' }}>
            {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
            {fulfillment.providerStatus && badge && fulfillment.providerStatus !== badge.label ? (
              <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>
                {fulfillment.providerStatus}
              </span>
            ) : null}
            {fulfillment.providerCostMinor != null ? (
              <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>
                {P.cost(money(fulfillment.providerCostMinor, 'NGN'))}
              </span>
            ) : null}
            {fulfillment.providerLastError ? (
              <span className="field__error">{P.lastError(fulfillment.providerLastError)}</span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="row" style={{ gap: 'var(--s2)' }}>
        {fulfillment.status === 'pending' ? (
          <>
            {bookable ? (
              <Button tone="primary" onClick={onBook}>
                {state === 'cancelled' || state === 'failed' || state === 'returned'
                  ? P.bookAgain
                  : P.book(courier.label)}
              </Button>
            ) : null}
            {courierOn && !bookable && state === 'booked' ? (
              <>
                <Button busy={busy === 'refresh'} onClick={() => void courierAction('refresh')}>
                  {P.refresh}
                </Button>
                <Button tone="plain" busy={busy === 'cancel'} onClick={() => void courierAction('cancel')}>
                  {P.cancelCourier}
                </Button>
              </>
            ) : null}
            {/* Picked up, on its way, delivered by the courier while the parcel
                row still says pending: nothing to cancel, everything to re-ask. */}
            {courierOn && !bookable && state !== null && state !== 'booked' && state !== 'draft' ? (
              <Button busy={busy === 'refresh'} onClick={() => void courierAction('refresh')}>
                {P.refresh}
              </Button>
            ) : null}
            {/* Still reachable with a courier on: a pickup nobody webhooked, a
                parcel somebody carried themselves. */}
            <Button tone={courierOn ? 'plain' : 'default'} onClick={onShip}>
              {courierOn ? P.shipByHand : 'Mark shipped'}
            </Button>
            <Button tone="plain" onClick={onEditTracking}>
              Edit tracking
            </Button>
            <Button tone="plain" busy={busy === 'cancelled'} onClick={() => void move('cancelled')}>
              Cancel parcel
            </Button>
          </>
        ) : fulfillment.status === 'shipped' ? (
          <>
            {fulfillment.provider ? (
              <Button tone="plain" busy={busy === 'refresh'} onClick={() => void courierAction('refresh')}>
                {P.refresh}
              </Button>
            ) : null}
            <Button busy={busy === 'delivered'} onClick={() => void move('delivered')}>
              Mark delivered
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * THE SHIP DIALOG — the moment the shipping email's contents are decided.
 *
 * "Mark shipped" used to fire immediately, which meant the email rendered
 * whatever carrier/tracking happened to be on the row from parcel creation —
 * usually nothing. The dialog puts the two fields in front of the operator AT
 * SHIP TIME, prefilled from the row, and the server writes them in the same
 * statement as the transition, so what is on screen at confirm is exactly what
 * the customer is told.
 *
 * `details` MODE IS THE SAME DIALOG WITHOUT THE TRANSITION: it saves
 * carrier/tracking on a still-pending parcel (the server 409s once it has
 * shipped — the email is already out, the record is frozen).
 *
 * Empty fields submit as `null` — a cleared box is "no tracking", and the
 * email omits the panel rather than printing blanks.
 */
function ShipDialog({
  parcel,
  index,
  mode,
  onClose,
  onDone,
}: {
  parcel: ShopFulfillment;
  index: number;
  mode: 'ship' | 'details';
  onClose: () => void;
  onDone: (orderSettled: boolean) => void;
}) {
  const toast = useToast();
  const [carrier, setCarrier] = useState(parcel.carrier ?? '');
  const [tracking, setTracking] = useState(parcel.trackingNumber ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function commit() {
    setBusy(true);
    try {
      const res = await shopApi.setFulfillmentStatus(parcel.id, {
        ...(mode === 'ship' ? { status: 'shipped' as const } : {}),
        carrier: carrier.trim() || null,
        trackingNumber: tracking.trim() || null,
      });
      toast.show(
        mode === 'ship'
          ? `Parcel ${index} ${humanise(res.fulfillment.status).toLowerCase()}`
          : `Parcel ${index} tracking saved`,
      );
      /* Same three-state contract as every parcel change: only a real order in
         the response may claim the shipment settled it. Details-only never
         carries one. */
      onDone(mode === 'ship' && Boolean(res.order));
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={mode === 'ship' ? `Mark Parcel ${index} shipped` : `Parcel ${index} tracking`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} onClick={() => void commit()}>
            {mode === 'ship' ? (
              <>
                <Truck aria-hidden="true" />
                Mark shipped
              </>
            ) : (
              'Save tracking'
            )}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="row" style={{ gap: 'var(--s3)', alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <TextField
              label="Carrier"
              value={carrier}
              placeholder="Optional"
              autoFocus
              onChange={(e) => {
                setCarrier(e.target.value);
                setError(null);
              }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <TextField
              label="Tracking number"
              value={tracking}
              placeholder="Optional"
              className="input mono"
              onChange={(e) => {
                setTracking(e.target.value);
                setError(null);
              }}
            />
          </div>
        </div>
        <p className="muted" style={{ fontSize: 'var(--t-sm)', lineHeight: 1.5, margin: 0 }}>
          {mode === 'ship'
            ? 'This goes into the shipping email the customer gets as soon as you confirm.'
            : 'Saved to the parcel now. The shipping email will use whatever is here when it ships.'}
        </p>
        {error ? (
          <span className="field__error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SEND OUT ITEMS — STEP ONE OF TWO WHEN A COURIER IS SWITCHED ON.
 *
 * This modal makes the PARCEL. `Book with <courier>` lives on the parcel's own
 * row and cannot exist until it does — so an operator with a courier on met
 * this screen first, saw it asking for a free-text *Carrier* and *Tracking
 * number*, and reasonably asked whether the booking had gone wrong.
 *
 * With a courier on, those two fields are not rendered AT ALL and `null` is
 * sent for both. Not merely hidden and not defaulted: the courier fills both
 * columns in itself the moment the parcel is booked, and a value typed here
 * would be a second, human opinion about which carrier a parcel went with —
 * on the same row, arriving first, and wrong whenever they disagree.
 *
 * By hand keeps the fields exactly as they were: there, they are the only way
 * those columns ever get filled in.
 * ═══════════════════════════════════════════════════════════════════════════
 */
function FulfilModal({
  orderId,
  lines,
  courier,
  sendable,
  onClose,
  onDone,
}: {
  orderId: string;
  lines: ShopOrderLine[];
  /** Which courier the shop has switched on — `manual` is the screen as it was. */
  courier: ShopCourierProvider;
  /** Units of a line that can go in a parcel now. An empty mystery box cannot (migration 1220). */
  sendable: (line: ShopOrderLine) => number;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const courierOn = courier.provider !== 'manual';
  const open = useMemo(() => lines.filter((l) => sendable(l) > 0), [lines, sendable]);
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(open.map((l) => [l.id, String(sendable(l))])),
  );
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function commit() {
    const picked: { orderLineId: string; qty: number }[] = [];
    for (const line of open) {
      const n = Number(qty[line.id] ?? '0');
      const remaining = sendable(line);
      if (!Number.isInteger(n) || n < 0 || n > remaining) {
        setError(`${line.title}: a whole number between 0 and ${remaining}.`);
        return;
      }
      if (n > 0) picked.push({ orderLineId: line.id, qty: n });
    }
    if (picked.length === 0) {
      setError('Nothing selected. Enter at least one quantity.');
      return;
    }
    setBusy(true);
    try {
      await shopApi.createFulfillment(orderId, {
        lines: picked,
        /* Explicitly null with a courier on, rather than relying on two boxes
           nobody could have typed into: the booking owns these columns. */
        carrier: courierOn ? null : carrier.trim() || null,
        trackingNumber: courierOn ? null : tracking.trim() || null,
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
      title="Send out items"
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
          {courierOn
            ? COURIER_COPY.parcel.packFirst(courier.label)
            : 'Sending part of an order is normal. Whatever is left stays open for the next parcel.'}
        </p>
        {open.map((line) => (
          <div key={line.id} className="row" style={{ gap: 'var(--s3)', alignItems: 'center' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 'var(--t-md)', fontWeight: 'var(--w-medium)' }}>{line.title}</div>
              <div className="muted" style={{ fontSize: 'var(--t-sm)' }}>
                {sendable(line)} of {line.qty} remaining
              </div>
            </div>
            <input
              className="input"
              style={{ width: '5rem', textAlign: 'right' }}
              type="number"
              min={0}
              max={sendable(line)}
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
        {courierOn ? null : (
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
        )}
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

/**
 * How many units of each line could still go back on the shelf: the line's
 * quantity minus what is in a parcel that has SHIPPED or been DELIVERED. A parcel
 * that was packed but not shipped is still in the building, so it counts.
 *
 * The same rule the server's restock statement guards on (migration 1200). This
 * copy only shapes the dialog; the server's is the one that decides.
 */
function returnableUnits(
  line: ShopOrderLine,
  fulfillments: ShopFulfillment[],
): { max: number; sent: number } {
  const sent = fulfillments
    .filter((f) => f.status === 'shipped' || f.status === 'delivered')
    .flatMap((f) => f.lines)
    .filter((fl) => fl.orderLineId === line.id)
    .reduce((n, fl) => n + fl.qty, 0);
  return { max: Math.max(0, line.qty - sent), sent };
}

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

  /*
   * WHAT GOES BACK IN STOCK (migration 1200; owner's decision 2026-09-15). A
   * number per line rather than a tick, because a line of three can have one
   * damaged spool. Starts at everything that can go back: most cancelled goods
   * were never opened, and lowering a number is the deliberate act.
   */
  const stockLines = useMemo(
    () =>
      paid
        ? detail.lines.map((line) => ({ line, ...returnableUnits(line, detail.fulfillments) }))
        : [],
    [paid, detail.lines, detail.fulfillments],
  );
  const [putBack, setPutBack] = useState<Record<string, string>>(() =>
    Object.fromEntries(stockLines.map((s) => [s.line.id, String(s.max)])),
  );
  const [keptOut, setKeptOut] = useState('');
  const [stockError, setStockError] = useState<string | null>(null);

  /*
   * MIGRATION 1220: WHAT WAS PACKED INSIDE A FILLED MYSTERY BOX. Only items not
   * already returned whose box has not shipped. Every one starts ticked, because
   * most cancelled boxes were never opened.
   */
  const returnableBoxItems = useMemo(
    () =>
      paid
        ? (detail.boxFills ?? [])
            .filter((f) => boxIsFree(f, detail.fulfillments) ||
              detail.fulfillments.find((p) => p.id === f.fulfillmentId)?.status === 'pending')
            .flatMap((f) =>
              f.items.filter((it) => it.returnedToStockAt === null).map((it) => ({ fill: f, item: it })),
            )
        : [],
    [paid, detail.boxFills, detail.fulfillments],
  );
  const [boxTicked, setBoxTicked] = useState<Set<string>>(
    () => new Set(returnableBoxItems.map((r) => r.item.id)),
  );
  const lowered = stockLines.some((s) => putBack[s.line.id] !== String(s.max));

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

    let restock: ShopRestockChoice | undefined;
    if (paid) {
      const lines: ShopRestockChoice['lines'] = [];
      for (const s of stockLines) {
        const raw = (putBack[s.line.id] ?? '').trim();
        const n = Number(raw);
        if (raw === '' || !Number.isInteger(n) || n < 0 || n > s.max) {
          setStockError(`${s.line.title}: a whole number from 0 to ${s.max}.`);
          return;
        }
        lines.push({ orderLineId: s.line.id, qty: n });
      }
      const boxKeptOut = boxTicked.size < returnableBoxItems.length;
      restock = {
        lines,
        keptOutReason: lowered || boxKeptOut ? keptOut.trim() || null : null,
        ...(returnableBoxItems.length > 0 ? { boxItemIds: [...boxTicked] } : {}),
      };
    }

    setBusy(true);
    try {
      const res = await shopApi.cancelAndRestock(order.id, refund, restock);
      const result = res.restock;
      if (result && 'failed' in result) {
        toast.show(
          `${order.orderNumber} cancelled, but the stock wasn’t put back. Adjust the stock count by hand.`,
        );
      } else if (result && result.refused.length > 0) {
        toast.show(
          `${order.orderNumber} cancelled. Some items had already been sent out and weren’t put back.`,
        );
      } else {
        toast.show(`${order.orderNumber} cancelled`);
      }
      onDone();
    } catch (cause) {
      setError(describeRefundError(cause));
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
          {paid
            ? 'Cancelling stops this order ever shipping. The customer has paid, so choose what goes back in stock and what happens to the money.'
            : 'Cancelling stops this order ever shipping. Items set aside for it go back in stock within about 30 minutes.'}
        </p>
        {stockLines.length > 0 ? (
          <fieldset className="stack stack--tight" style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="field__label" style={{ marginBottom: 'var(--s2)' }}>
              Put back in stock
            </legend>
            {stockLines.map((s) => (
              <div key={s.line.id} className="row" style={{ gap: 'var(--s3)', alignItems: 'center' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--t-md)', fontWeight: 'var(--w-medium)' }}>
                    {s.line.title}
                  </div>
                  <div className="muted" style={{ fontSize: 'var(--t-sm)' }}>
                    {s.sent > 0 ? `${s.sent} already sent out` : `${s.line.qty} ordered`}
                  </div>
                </div>
                <input
                  className="input"
                  style={{ width: '4.5rem', textAlign: 'right' }}
                  type="number"
                  min={0}
                  max={s.max}
                  step={1}
                  aria-label={`Put back how many of ${s.line.title}`}
                  value={putBack[s.line.id] ?? ''}
                  disabled={s.max === 0}
                  onChange={(e) => {
                    setPutBack((p) => ({ ...p, [s.line.id]: e.target.value }));
                    setStockError(null);
                  }}
                />
                <span className="muted" style={{ fontSize: 'var(--t-sm)', minWidth: '2.5rem' }}>
                  of {s.max}
                </span>
              </div>
            ))}
            {returnableBoxItems.length > 0 ? (
              <div className="stack stack--tight">
                <span className="field__label">What was packed in the boxes</span>
                {returnableBoxItems.map(({ fill, item }) => (
                  <Checkbox
                    key={item.id}
                    label={`${item.title} · Box ${fill.boxNo}`}
                    checked={boxTicked.has(item.id)}
                    onChange={(on) =>
                      setBoxTicked((t) => {
                        const next = new Set(t);
                        if (on) next.add(item.id);
                        else next.delete(item.id);
                        return next;
                      })
                    }
                  />
                ))}
              </div>
            ) : null}
            {stockError ? (
              <span className="field__error" role="alert">
                {stockError}
              </span>
            ) : null}
            {lowered || boxTicked.size < returnableBoxItems.length ? (
              <TextField
                label="Why the rest stays out (optional)"
                placeholder="For example: seal broken in transit"
                value={keptOut}
                onChange={(e) => setKeptOut(e.target.value)}
              />
            ) : null}
          </fieldset>
        ) : null}
        {paid ? (
          <div className="stack stack--tight">
            <span className="field__label">Refund</span>
            <Radio
              name="cancel-refund"
              label={`Refund in full — ${money(max, currency)}`}
              checked={choice === 'full'}
              onChange={() => setChoice('full')}
            />
            <Radio
              name="cancel-refund"
              label={`Refund 75% — ${money(Math.round(max * 0.75), currency)}`}
              hint="Keeps part of the money as a handling fee."
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
              <MoneyField
                label="Amount"
                currency={currency}
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
              hint="Only pick this on purpose. It is recorded as your decision."
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
  gateway,
  currency,
  maxMinor,
  onClose,
  onDone,
}: {
  intentId: string;
  /** The gateway that took the payment, or `null` when the page does not know. */
  gateway: string | null;
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
      setError(describeRefundError(cause));
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
          {gateway ? `The money goes back through ${gateway}.` : 'The money goes back the way the customer paid.'}{' '}
          The order itself stays as it is — a refund does not cancel it.
        </p>
        <MoneyField
          label="Amount"
          currency={currency}
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
          placeholder="Optional — the customer never sees this"
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
    </Modal>
  );
}

/* ═════════════════════════════════════════════════════════ EMAIL ROW ════ */

function EmailRow({ mail }: { mail: ShopEmailIntent }) {
  /* A dismissed intent is one the operator RESOLVED on the outbox screen —
   * badging it critical here would keep alarming about a decision already
   * made, and the wording matches the outbox's bucket names. */
  const dismissed = mail.sentAt === null && mail.dismissedAt != null;
  const stuck =
    mail.sentAt === null && !dismissed && mail.lastError !== null && mail.attempts > 0;
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
        {mail.sentAt ? 'Sent' : dismissed ? 'Dismissed' : stuck ? 'Won’t send' : 'Waiting to send'}
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

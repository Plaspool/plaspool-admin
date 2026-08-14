import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Receipt, Search, X } from 'lucide-react';
import {
  shopApi,
  formatMinor,
  moneyRefusalMessage,
  parseRefund,
  type OrderStatus,
  type ShopFulfillment,
  type ShopOrder,
  type ShopOrderDetail,
  type ShopOrderLine,
} from '../data/api-shop';
import { ApiError, NotFoundError, OfflineError } from '../data/errors';
import { useSession } from '../components/RequireAuth';
import { useToast } from '../components/Toast';
import { ConfirmDialog } from '../components/Dialog';
import { Skeleton } from '../components/ui/Feedback';
import { Select } from '../components/ui/Select';
import { useDelayed } from '../components/ui/useDelayed';
import './shop.css';

/**
 * Orders, and one order in detail.
 *
 * TWO SCREENS IN ONE FILE AND ONE URL, because `?id=` is the only difference
 * between them: `/shop/orders?status=paid&q=…` is the list a person filtered,
 * and `/shop/orders?status=paid&q=…&id=o_7` is that same list with one order
 * open on top of it. Keeping the filters in the URL while the detail is open is
 * what makes "back to the list" return to the list they had rather than to an
 * unfiltered one — the same defect HANDOFF §1.7 records on the blog dashboard,
 * avoided here by not building it.
 *
 * WHAT THIS SCREEN MUST NOT PRETEND. `registerOrdersDeps` has no production
 * caller (§1.9), so on the live deployment the payment panel is `null` for every
 * order and the order mailer is `LoggingMailer` — an intent marked "sent" was
 * handed to something that writes a log line. Both are said in the markup rather
 * than left for an operator to infer from an empty box.
 */

const STATUS_TABS: { key: OrderStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Awaiting payment' },
  { key: 'paid', label: 'Paid' },
  { key: 'fulfilled', label: 'Fulfilled' },
  { key: 'partially_refunded', label: 'Partly refunded' },
  { key: 'refunded', label: 'Refunded' },
  { key: 'cancelled', label: 'Cancelled' },
];

const STATUS_LABEL: Record<string, string> = Object.fromEntries(
  STATUS_TABS.filter((t) => t.key !== 'all').map((t) => [t.key, t.label]),
);

const FULFILLMENT_LABEL: Record<string, string> = {
  pending: 'Ready to ship',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

const PAYMENT_LABEL: Record<string, string> = {
  requires_payment: 'Awaiting payment',
  authorized: 'Authorised',
  captured: 'Captured',
  failed: 'Failed',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
  partially_refunded: 'Partly refunded',
};

const PAGE_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 250;

const WHEN = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** `?status=fulfille` is somebody's typo, not an error screen. */
function readStatus(params: URLSearchParams): OrderStatus | 'all' {
  const raw = params.get('status');
  return STATUS_TABS.some((t) => t.key === raw) ? (raw as OrderStatus | 'all') : 'all';
}

/** The same params with the defaults dropped rather than written. */
function withParams(
  base: URLSearchParams,
  patch: Record<string, string | null>,
): URLSearchParams {
  const next = new URLSearchParams(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '' || (key === 'status' && value === 'all')) {
      next.delete(key);
    } else next.set(key, value);
  }
  return next;
}

const asSearch = (params: URLSearchParams): string => {
  const qs = params.toString();
  return qs === '' ? '' : `?${qs}`;
};

export default function ShopOrders() {
  const [params] = useSearchParams();
  const openId = params.get('id');

  return (
    <div className="shopscr">
      {/*
        Both the section title and the section nav are hidden on an order's own
        page — see `ShopProducts.tsx` for the reasoning. One order is a support
        conversation, not a stop on a tour of the shop.
      */}
      {!openId && (
        <>
          <header className="shopscr__head">
            <div className="shopscr__headrow">
              <div>
                <h1 className="shopscr__title">Orders</h1>
                <p className="shopscr__lede">
                  What was bought, what has shipped, and what the store has tried to
                  email about it. Cancelling and refunding are owner-only, and both ask
                  before they act.
                </p>
              </div>
            </div>
          </header>
        </>
      )}

      <div className="shopscr__body">
        {openId ? <OrderDetail id={openId} /> : <OrderList />}
      </div>
    </div>
  );
}

// ============================================================================
// LIST
// ============================================================================

function OrderList() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const status = readStatus(params);
  const search = params.get('q') ?? '';
  const cursor = params.get('cursor') ?? '';

  const [page, setPage] = useState<{ items: ShopOrder[]; nextCursor: string | null } | null>(
    null,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const showSkeletons = useDelayed(loading);

  /**
   * The box types into local state; a timer copies it into `?q=`.
   *
   * Same 250 ms and the same two halves as the dashboard's search: writing the
   * param on every keystroke would refetch the list five times for the word
   * "hello", and holding the query only in state is the bug URL-driven state
   * exists to undo. `pushed` is how the adopting effect tells "the URL moved
   * under us — Back, or a hand-edited address" from "our own timer just fired".
   */
  const [draft, setDraft] = useState(search);
  const pushed = useRef(search);

  useEffect(() => {
    if (search === pushed.current) return;
    pushed.current = search;
    setDraft(search);
  }, [search]);

  useEffect(() => {
    if (draft === pushed.current) return;
    const timer = window.setTimeout(() => {
      pushed.current = draft;
      // `cursor: null` WITH EVERY FILTER CHANGE. A keyset cursor is a position
      // in one particular ordering of one particular filter; carrying it across
      // a new search means page two of the old list, which looks like a search
      // that found nothing.
      setParams((prev) => withParams(prev, { q: draft, cursor: null }), { replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, setParams]);

  const load = useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      setProblem(null);
      return shopApi
        .listOrders(
          {
            status: status === 'all' ? undefined : status,
            search: search.trim() || undefined,
            cursor: cursor || undefined,
            limit: PAGE_LIMIT,
          },
          signal,
        )
        .then((next) => {
          if (signal?.aborted) return;
          setPage(next);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (signal?.aborted) return;
          setProblem(explain(err, 'order list'));
          setLoading(false);
        });
    },
    [status, search, cursor],
  );

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const items = page?.items ?? [];

  return (
    <>
      <div className="shopfilters">
        {/*
          A SELECT RATHER THAN A TAB STRIP, and the deciding number is seven.
          Tabs are for a handful of destinations you want to compare at a glance;
          an order has seven states, most of which are empty most of the time, so
          the strip spent a full row telling you six things you were not looking
          for and wrapped on a narrow screen. It also read as navigation while
          behaving like a filter — which is what it is, and it now sits with the
          search box that filters the same list.

          It stays URL-driven and still PUSHES, so Back walks Paid → Fulfilled
          and a filtered list is still a link somebody can send.
        */}
        <Select
          label="Status"
          value={status}
          onChange={(v) =>
            navigate({
              pathname: '/shop/orders',
              search: asSearch(withParams(params, { status: v, id: null, cursor: null })),
            })
          }
          options={STATUS_TABS.map((t) => ({ value: t.key, label: t.label }))}
        />
        <div className="searchbox">
          <Search className="ui-ic" aria-hidden="true" />
          <input
            className="searchbox__input"
            type="search"
            value={draft}
            /*
             * "exactly" is not hedging. `GET /shop/admin/orders?search=` matches
             * an order number (check-character validated first) or a lowercased
             * email, both exactly — there is no prefix or substring arm, and a
             * box that implied one would look broken to anyone who typed half a
             * name into it.
             */
            placeholder="Order number or email, exactly…"
            aria-label="Search orders"
            onChange={(e) => setDraft(e.target.value)}
          />
          {draft && (
            <button
              className="searchbox__clear"
              aria-label="Clear search"
              onClick={() => {
                pushed.current = '';
                setDraft('');
                setParams((prev) => withParams(prev, { q: '', cursor: null }), {
                  replace: true,
                });
              }}
            >
              <X className="ui-ic" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {problem && (
        <div className="notice notice--danger" role="alert">
          <div>
            <strong>The orders didn&rsquo;t load.</strong> {problem}
          </div>
          <div className="notice__actions">
            <button className="btn btn--outline btn--sm" onClick={() => void load()}>
              Try again
            </button>
          </div>
        </div>
      )}

      {loading && !page ? (
        showSkeletons ? (
          <div className="panel" style={{ marginTop: 'var(--s5)' }} aria-hidden="true">
            <div className="panel__body">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} height={18} width={`${92 - i * 7}%`} />
              ))}
            </div>
          </div>
        ) : null
      ) : items.length === 0 && !problem ? (
        <div className="empty">
          <div className="empty__mark" aria-hidden="true">
            <Receipt />
          </div>
          <h2 className="empty__title">
            {search ? 'Nothing matches' : 'No orders here'}
          </h2>
          <p className="empty__body">
            {search
              ? 'Order search matches a whole order number or a whole email address. A part of either finds nothing.'
              : status === 'all'
                ? 'Nobody has completed a checkout yet.'
                : 'No order is in this state right now.'}
          </p>
          {(search || status !== 'all') && (
            <Link className="btn btn--outline" to="/shop/orders">
              Clear filters
            </Link>
          )}
        </div>
      ) : (
        <section className="panel" style={{ marginTop: 'var(--s5)' }}>
          <div className="panel__body panel__body--flush">
            <div className="dtable__scroll">
              <table className="dtable">
                <thead>
                  <tr>
                    <th scope="col">Order</th>
                    <th scope="col">Placed</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="dtable__num">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((order) => (
                    <tr key={order.id}>
                      <td>
                        <Link
                          className="dtable__link"
                          to={{
                            pathname: '/shop/orders',
                            search: asSearch(withParams(params, { id: order.id })),
                          }}
                        >
                          {order.orderNumber}
                        </Link>
                        <span className="dtable__sub">{order.email}</span>
                      </td>
                      <td className="num" data-label="Placed">
                        {WHEN.format(new Date(order.placedAt))}
                      </td>
                      <td data-label="Status">
                        <span className={`chip chip--${order.status}`}>
                          {STATUS_LABEL[order.status] ?? order.status}
                        </span>
                      </td>
                      <td className="dtable__num" data-label="Total">
                        {formatMinor(order.grandTotal, order.currency)}
                        {order.refundedTotal > 0 && (
                          <span className="dtable__sub">
                            {formatMinor(order.refundedTotal, order.currency)} refunded
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {(cursor || page?.nextCursor) && (
        <div className="pager">
          {/*
            PAGING PUSHES, unlike every filter above it. A page is a place —
            Back should return to the previous page of orders rather than leave
            the section — and because `?cursor=` is the whole of the page's
            state, the browser's own Back button IS the previous-page control.
            A keyset cursor has no inverse, so a stack of seen cursors held in a
            ref would be the only alternative, and it would not survive a reload.
          */}
          <button
            className="btn btn--ghost btn--sm"
            disabled={!cursor}
            onClick={() => navigate(-1)}
          >
            Back a page
          </button>
          <span className="pager__note">{items.length} on this page</span>
          <button
            className="btn btn--outline btn--sm"
            disabled={!page?.nextCursor}
            onClick={() => setParams(withParams(params, { cursor: page!.nextCursor! }))}
          >
            Next page
          </button>
        </div>
      )}
    </>
  );
}

// ============================================================================
// DETAIL
// ============================================================================

function OrderDetail({ id }: { id: string }) {
  const [params] = useSearchParams();
  const { notify } = useToast();
  const session = useSession();
  const isOwner =
    session.status !== 'unknown' && session.user?.role === 'owner';

  const [detail, setDetail] = useState<ShopOrderDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const showSkeletons = useDelayed(loading);
  const [confirm, setConfirm] = useState<'cancel' | 'refund' | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      setProblem(null);
      return shopApi
        .getOrder(id, signal)
        .then((next) => {
          if (signal?.aborted) return;
          setDetail(next);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (signal?.aborted) return;
          setProblem(explain(err, 'order'));
          setLoading(false);
        });
    },
    [id],
  );

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  /** Back to the list the operator had, filters and all. */
  const backTo = {
    pathname: '/shop/orders',
    search: asSearch(withParams(params, { id: null })),
  };

  // ---------------------------------------------------------------- refund
  /**
   * WHAT IS LEFT TO REFUND, IN MINOR UNITS, FROM THE PAYMENT AND NOT THE ORDER.
   *
   * `order.refundedTotal` is Orders' copy, updated when it consumes a
   * `payment.refunded` event; `payment.refundedTotal` is Payments' own sum and
   * is the number the refund route will check against. Bounding the input by
   * the order's copy would let an operator type an amount the server then
   * refuses, in the window between a refund and the event being drained.
   */
  const payment = detail?.payment ?? null;
  const refundable = payment ? Math.max(0, payment.amount - payment.refundedTotal) : 0;
  const [refundDraft, setRefundDraft] = useState('');
  const [refundReason, setRefundReason] = useState('');
  /**
   * MINTED ONCE PER TYPED AMOUNT, NOT PER CLICK. `idempotencyKey` is what stops
   * a refund the network swallowed from being paid twice when the operator
   * clicks again, and a key generated inside the click handler would be a new
   * key on the retry — which is the mechanism switched off while looking like it
   * is on. It is reset only when the amount changes, i.e. when this is a
   * genuinely different refund.
   */
  const refundKey = useMemo(
    () => `refund-${id}-${refundDraft}-${idSeed()}`,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, refundDraft],
  );

  const refundParse = payment
    ? parseRefund(refundDraft, payment.currency, refundable)
    : null;
  const refundError =
    refundDraft.trim() === '' || !refundParse || refundParse.ok
      ? null
      : moneyRefusalMessage(refundParse.reason, payment!.currency, refundable);

  if (loading && !detail) {
    return showSkeletons ? (
      <div className="panel" aria-hidden="true">
        <div className="panel__body">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} height={18} width={`${94 - i * 6}%`} />
          ))}
        </div>
      </div>
    ) : null;
  }

  if (!detail) {
    return (
      <div className="empty">
        <div className="empty__mark" aria-hidden="true">
          <Receipt />
        </div>
        <h2 className="empty__title">That order isn&rsquo;t here</h2>
        <p className="empty__body">{problem ?? 'It may have been opened from a stale link.'}</p>
        <Link className="btn btn--outline" to={backTo}>
          Back to orders
        </Link>
      </div>
    );
  }

  const { order, lines, fulfillments, timeline, emails } = detail;
  const currency = order.currency;
  const closed = order.status === 'cancelled' || order.status === 'refunded';

  return (
    <>
      <div className="shopfilters" style={{ marginTop: 0 }}>
        <Link className="btn btn--ghost btn--sm" to={backTo}>
          <ArrowLeft className="ui-ic" aria-hidden="true" />
          All orders
        </Link>
        <span className={`chip chip--${order.status}`}>
          {STATUS_LABEL[order.status] ?? order.status}
        </span>
        <span className="pager__note">
          {order.orderNumber} · {WHEN.format(new Date(order.placedAt))} · {order.email}
        </span>
      </div>

      {problem && (
        <div className="notice notice--danger" role="alert">
          <div>{problem}</div>
        </div>
      )}

      <div className="shopgrid" style={{ marginTop: 'var(--s5)' }}>
        <div className="shopgrid__col">
          <section className="panel">
            <div className="panel__head">
              <h2 className="panel__title">What was bought</h2>
            </div>
            <div className="panel__body panel__body--flush">
              <div className="dtable__scroll">
                <table className="dtable">
                  <thead>
                    <tr>
                      <th scope="col">Item</th>
                      <th scope="col" className="dtable__num">
                        Qty
                      </th>
                      <th scope="col" className="dtable__num">
                        Each
                      </th>
                      <th scope="col" className="dtable__num">
                        Line
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => (
                      <tr key={line.id}>
                        <td>
                          <span className="dtable__strong">{line.title}</span>
                          <span className="dtable__sub">
                            {line.sku}
                            {optionText(line) && ` · ${optionText(line)}`}
                          </span>
                        </td>
                        <td className="dtable__num" data-label="Qty">
                          {line.qty}
                          {line.fulfilledQty > 0 && line.fulfilledQty < line.qty && (
                            <span className="dtable__sub">{line.fulfilledQty} sent</span>
                          )}
                        </td>
                        <td className="dtable__num" data-label="Each">
                          {formatMinor(line.unitAmount, currency)}
                        </td>
                        <td className="dtable__num" data-label="Line">
                          {formatMinor(line.lineTotal, currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="panel__body">
              <div className="kv">
                <span className="kv__k">Subtotal</span>
                <span className="kv__v">{formatMinor(order.subtotal, currency)}</span>
                <span className="kv__k">Shipping</span>
                <span className="kv__v">{formatMinor(order.shippingTotal, currency)}</span>
                <span className="kv__k">Tax</span>
                <span className="kv__v">{formatMinor(order.taxTotal, currency)}</span>
                <span className="kv__rule" />
                <span className="kv__k">Total</span>
                <span className="kv__v kv__v--total">
                  {formatMinor(order.grandTotal, currency)}
                </span>
                {order.refundedTotal > 0 && (
                  <>
                    <span className="kv__k">Refunded</span>
                    <span className="kv__v">
                      −{formatMinor(order.refundedTotal, currency)}
                    </span>
                  </>
                )}
              </div>
              {/* The four totals are copied from `checkout.completed` and never
                  recomputed, which is why they are shown rather than derived
                  here: a client that re-added the lines could disagree with the
                  amount the customer was actually charged. */}
              <p className="shopform__hint" style={{ marginTop: 'var(--s3)' }}>
                Frozen at checkout. These are the figures the customer agreed to.
              </p>
            </div>
          </section>

          <Fulfilments
            orderId={order.id}
            lines={lines}
            fulfillments={fulfillments}
            disabled={closed}
            onChanged={() => void load()}
          />

          <section className="panel">
            <div className="panel__head">
              <h2 className="panel__title">History</h2>
            </div>
            <div className="panel__body">
              {timeline.length === 0 ? (
                <p className="panel__note">Nothing has happened to this order yet.</p>
              ) : (
                <div className="timeline">
                  {[...timeline].reverse().map((entry) => (
                    <div className="timeline__item" key={entry.id}>
                      <span>{entry.message}</span>
                      <span className="timeline__when">
                        {WHEN.format(new Date(entry.occurredAt))}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>

        <div className="shopgrid__col">
          <section className="panel">
            <div className="panel__head">
              <h2 className="panel__title">Delivery</h2>
            </div>
            <div className="panel__body">
              <address className="addr">{addressLines(order.shippingAddress)}</address>
            </div>
          </section>

          <section className="panel">
            <div className="panel__head">
              <h2 className="panel__title">Payment</h2>
            </div>
            <div className="panel__body">
              {payment ? (
                <div className="kv">
                  <span className="kv__k">State</span>
                  <span className="kv__v">
                    <span className={`chip chip--${payment.status}`}>
                      {PAYMENT_LABEL[payment.status] ?? payment.status}
                    </span>
                  </span>
                  <span className="kv__k">Charged</span>
                  <span className="kv__v">
                    {formatMinor(payment.amount, payment.currency)}
                  </span>
                  <span className="kv__k">Refunded</span>
                  <span className="kv__v">
                    {formatMinor(payment.refundedTotal, payment.currency)}
                  </span>
                  <span className="kv__k">Left</span>
                  <span className="kv__v kv__v--total">
                    {formatMinor(refundable, payment.currency)}
                  </span>
                </div>
              ) : (
                /*
                 * NOT AN ERROR AND NOT AN EMPTY BOX. `GET /shop/admin/orders/:id`
                 * returns `payment: null` whenever Orders was constructed without
                 * a `PaymentPort` — which, until `registerOrdersDeps` gets a
                 * production caller, is every request on the live deployment.
                 * An operator staring at a blank panel would reasonably conclude
                 * the customer had not paid.
                 */
                <p className="panel__note">
                  This deployment doesn&rsquo;t hand the order screen a payments
                  connection, so nothing can be shown here — including for orders
                  that were paid. It is not a statement about this order.
                </p>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel__head">
              <h2 className="panel__title">Email</h2>
            </div>
            <div className="panel__body">
              {emails.length === 0 ? (
                <p className="panel__note">No email has been queued for this order.</p>
              ) : (
                emails.map((mail) => (
                  <div className="mailrow" key={mail.id}>
                    <span className="dtable__strong">{mail.subject}</span>
                    <span className="mailrow__meta">
                      {mail.to} ·{' '}
                      {mail.sentAt
                        ? `handed to the mailer ${WHEN.format(new Date(mail.sentAt))}`
                        : mail.attempts > 0
                          ? `${mail.attempts} failed ${mail.attempts === 1 ? 'attempt' : 'attempts'}`
                          : 'waiting for a sweep'}
                    </span>
                    {mail.lastError && <span className="mailrow__err">{mail.lastError}</span>}
                  </div>
                ))
              )}
              {/* "sent" means "handed to the mailer", and the default mailer
                  records the message and sends nothing (HANDOFF §1.11). An
                  operator answering "did they get their receipt?" must not read
                  this panel as proof of delivery. */}
              <p className="shopform__hint" style={{ marginTop: 'var(--s3)' }}>
                &ldquo;Handed to the mailer&rdquo; is not the same as delivered.
              </p>
            </div>
          </section>

          {isOwner && (
            <section className="panel">
              <div className="panel__head">
                <h2 className="panel__title">Owner actions</h2>
              </div>
              <div className="panel__body shopform">
                <div className="shopform__field">
                  <span className="label">Refund</span>
                  {payment ? (
                    refundable === 0 ? (
                      <p className="panel__note">Nothing left to refund on this payment.</p>
                    ) : (
                      <>
                        <div className="shopform__row">
                          <input
                            className="input"
                            style={{ maxWidth: '10rem' }}
                            inputMode="decimal"
                            value={refundDraft}
                            aria-label={`Refund amount in ${payment.currency}`}
                            placeholder={majorPlaceholder(refundable, payment.currency)}
                            onChange={(e) => setRefundDraft(e.target.value)}
                          />
                          <button
                            className="btn btn--danger btn--sm"
                            disabled={!refundParse?.ok}
                            onClick={() => setConfirm('refund')}
                          >
                            Refund
                          </button>
                        </div>
                        <input
                          className="input"
                          value={refundReason}
                          maxLength={500}
                          aria-label="Refund reason"
                          placeholder="Why (optional, kept with the refund)"
                          onChange={(e) => setRefundReason(e.target.value)}
                        />
                        {refundError ? (
                          <p className="shopform__error">{refundError}</p>
                        ) : (
                          <p className="shopform__hint">
                            In {payment.currency}, as you would write it —{' '}
                            {formatMinor(refundable, payment.currency)} is what is left.
                          </p>
                        )}
                      </>
                    )
                  ) : (
                    <p className="panel__note">
                      Refunding needs the payments connection this deployment does
                      not wire up.
                    </p>
                  )}
                </div>

                <div className="shopform__field">
                  <span className="label">Cancel</span>
                  <button
                    className="btn btn--danger btn--sm"
                    disabled={closed || order.status === 'fulfilled'}
                    onClick={() => setConfirm('cancel')}
                  >
                    Cancel this order
                  </button>
                  <p className="shopform__hint">
                    {closed
                      ? 'This order is already closed.'
                      : order.status === 'fulfilled'
                        ? 'It has already shipped, so cancelling would not stop anything.'
                        : 'Releases the reserved stock and stops the order ever shipping.'}
                  </p>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirm === 'cancel'}
        onClose={() => setConfirm(null)}
        title="Cancel this order?"
        description={
          <>
            {order.orderNumber} for {formatMinor(order.grandTotal, currency)} will be
            cancelled, the reserved stock released, and the customer emailed. This does
            not refund anything — do that separately.
          </>
        }
        confirmLabel="Cancel the order"
        danger
        onConfirm={async () => {
          try {
            await shopApi.cancelOrder(order.id);
            notify('Order cancelled', { tone: 'danger' });
            await load();
          } catch (err) {
            notify(explain(err, 'cancellation'), { tone: 'danger' });
          }
        }}
      />

      <ConfirmDialog
        open={confirm === 'refund'}
        onClose={() => setConfirm(null)}
        title="Refund this payment?"
        description={
          refundParse?.ok && payment ? (
            <>
              {formatMinor(refundParse.minor, payment.currency)} goes back to the
              customer&rsquo;s card. Refunds cannot be taken back from this screen.
            </>
          ) : null
        }
        confirmLabel="Send the refund"
        danger
        onConfirm={async () => {
          if (!payment || !refundParse?.ok) return;
          try {
            await shopApi.refundPayment(payment.intentId, {
              amount: refundParse.minor,
              reason: refundReason.trim() || undefined,
              idempotencyKey: refundKey,
            });
            notify(`Refunded ${formatMinor(refundParse.minor, payment.currency)}`);
            setRefundDraft('');
            setRefundReason('');
            await load();
          } catch (err) {
            notify(explain(err, 'refund'), { tone: 'danger' });
          }
        }}
      />
    </>
  );
}

// ============================================================================
// FULFILMENT
// ============================================================================

/**
 * Create a shipment from the lines that have not shipped, then advance it.
 *
 * PARTIAL SHIPMENT IS THE ORDINARY CASE, not an edge one — three items, two in
 * stock — so the form starts with everything outstanding filled in and lets the
 * operator reduce it, rather than starting empty and making the common case the
 * one that needs typing.
 */
function Fulfilments({
  orderId,
  lines,
  fulfillments,
  disabled,
  onChanged,
}: {
  orderId: string;
  lines: ShopOrderLine[];
  fulfillments: ShopFulfillment[];
  disabled: boolean;
  onChanged: () => void;
}) {
  const { notify } = useToast();
  const outstanding = useMemo(
    () => lines.filter((l) => l.qty - l.fulfilledQty > 0),
    [lines],
  );

  const [qty, setQty] = useState<Record<string, string>>({});
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [busy, setBusy] = useState(false);

  // Re-seeded whenever the outstanding set changes — after a shipment lands,
  // the boxes must show what is left rather than what was there before it.
  useEffect(() => {
    setQty(Object.fromEntries(outstanding.map((l) => [l.id, String(l.qty - l.fulfilledQty)])));
  }, [outstanding]);

  const picked = outstanding
    .map((line) => ({ line, n: Number(qty[line.id] ?? '0') }))
    .filter((p) => Number.isInteger(p.n) && p.n > 0 && p.n <= p.line.qty - p.line.fulfilledQty);

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">Shipments</h2>
      </div>

      <div className="panel__body">
        {fulfillments.length === 0 ? (
          <p className="panel__note">Nothing has been shipped yet.</p>
        ) : (
          fulfillments.map((f) => (
            <div className="mailrow" key={f.id}>
              <span className="dtable__strong">
                <span className={`chip chip--${f.status}`}>
                  {FULFILLMENT_LABEL[f.status] ?? f.status}
                </span>{' '}
                {f.lines.reduce((n, l) => n + l.qty, 0)} item
                {f.lines.reduce((n, l) => n + l.qty, 0) === 1 ? '' : 's'}
              </span>
              <span className="mailrow__meta">
                {f.carrier ? `${f.carrier} · ` : ''}
                {f.trackingNumber ? `${f.trackingNumber} · ` : ''}
                created {WHEN.format(new Date(f.createdAt))}
              </span>
              {f.status !== 'cancelled' && f.status !== 'delivered' && (
                <div className="shopform__row" style={{ marginTop: 'var(--s2)' }}>
                  {f.status === 'pending' && (
                    <button
                      className="btn btn--outline btn--sm"
                      onClick={() => void advance(f.id, 'shipped')}
                    >
                      Mark shipped
                    </button>
                  )}
                  {f.status === 'shipped' && (
                    <button
                      className="btn btn--outline btn--sm"
                      onClick={() => void advance(f.id, 'delivered')}
                    >
                      Mark delivered
                    </button>
                  )}
                  <button
                    className="btn btn--danger btn--sm"
                    onClick={() => void advance(f.id, 'cancelled')}
                  >
                    Cancel shipment
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {!disabled && outstanding.length > 0 && (
        <div className="panel__body shopform" style={{ borderTop: '1px solid var(--rule)' }}>
          <div className="shopform__field">
            <span className="label">Ship what is left</span>
            <div className="dtable__scroll">
              <table className="dtable">
                <tbody>
                  {outstanding.map((line) => (
                    <tr key={line.id}>
                      <td>
                        <span className="dtable__strong">{line.title}</span>
                        <span className="dtable__sub">
                          {line.sku} · {line.qty - line.fulfilledQty} outstanding
                        </span>
                      </td>
                      {/* This table has no header row to borrow from, so the
                          phone label is the one place the column is named at
                          all — the input's `aria-label` says it for a screen
                          reader and said it to nobody else. */}
                      {/* `.dtable__fit` rather than an inline width, so the
                          phone stack can hand the cell its full width back —
                          an inline style is unbeatable from a media query
                          without `!important`. */}
                      <td className="dtable__num dtable__fit" data-label="Ship">
                        <input
                          className="input"
                          inputMode="numeric"
                          value={qty[line.id] ?? ''}
                          aria-label={`Quantity to ship of ${line.title}`}
                          onChange={(e) =>
                            setQty((prev) => ({ ...prev, [line.id]: e.target.value }))
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="shopform__split">
            <div className="shopform__field">
              <label className="label" htmlFor="ff-carrier">
                Carrier
              </label>
              <input
                id="ff-carrier"
                className="input"
                value={carrier}
                maxLength={300}
                placeholder="Royal Mail"
                onChange={(e) => setCarrier(e.target.value)}
              />
            </div>
            <div className="shopform__field">
              <label className="label" htmlFor="ff-tracking">
                Tracking number
              </label>
              <input
                id="ff-tracking"
                className="input"
                value={tracking}
                maxLength={300}
                placeholder="Optional"
                onChange={(e) => setTracking(e.target.value)}
              />
            </div>
          </div>

          <div className="shopform__actions">
            <button
              className="btn btn--primary btn--sm"
              disabled={busy || picked.length === 0}
              onClick={async () => {
                setBusy(true);
                try {
                  await shopApi.createFulfillment(orderId, {
                    lines: picked.map((p) => ({ orderLineId: p.line.id, qty: p.n })),
                    carrier: carrier.trim() || null,
                    trackingNumber: tracking.trim() || null,
                  });
                  notify('Shipment created');
                  setCarrier('');
                  setTracking('');
                  onChanged();
                } catch (err) {
                  notify(explain(err, 'shipment'), { tone: 'danger' });
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create shipment
            </button>
            <span className="shopform__hint">
              {picked.length === 0
                ? 'Enter at least one quantity to ship.'
                : `${picked.reduce((n, p) => n + p.n, 0)} item${
                    picked.reduce((n, p) => n + p.n, 0) === 1 ? '' : 's'
                  } across ${picked.length} line${picked.length === 1 ? '' : 's'}.`}
            </span>
          </div>
        </div>
      )}
    </section>
  );

  async function advance(id: string, status: 'shipped' | 'delivered' | 'cancelled') {
    try {
      await shopApi.setFulfillmentStatus(id, status);
      notify(
        status === 'shipped'
          ? 'Marked shipped — the customer gets a tracking email'
          : status === 'delivered'
            ? 'Marked delivered'
            : 'Shipment cancelled',
        status === 'cancelled' ? { tone: 'danger' } : undefined,
      );
      onChanged();
    } catch (err) {
      notify(explain(err, 'shipment'), { tone: 'danger' });
    }
  }
}

// ============================================================================
// SMALL THINGS
// ============================================================================

/** `{ Size: 'M', Colour: 'Blue' }` → `Size M · Colour Blue`. */
function optionText(line: ShopOrderLine): string {
  return Object.entries(line.optionValues ?? {})
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');
}

/**
 * The address, from a JSON blob whose shape is Cart's rather than this
 * screen's.
 *
 * `shippingAddress` is `Record<string, unknown>` all the way from the column, so
 * the fields are read defensively and anything unrecognised is simply not shown.
 * Rendering `[object Object]` into a delivery address would be worse than
 * rendering less of it.
 */
function addressLines(address: Record<string, unknown>): string {
  const pick = (key: string): string => {
    const value = address?.[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
  };
  const parts = [
    [pick('name'), pick('company')].filter(Boolean).join(', '),
    pick('line1'),
    pick('line2'),
    [pick('city'), pick('region')].filter(Boolean).join(', '),
    [pick('postalCode'), pick('country')].filter(Boolean).join(' '),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : 'No delivery address on this order.';
}

/** `2500, 'GBP'` → `25.00`, so the box hints in the shape it wants back. */
function majorPlaceholder(minor: number, currency: string): string {
  // Digits only: the placeholder is an example of what to type, and a currency
  // symbol in it would look like the box wants one typed too.
  return formatMinor(minor, currency).replace(/[^\d.,]/g, '');
}

/** A per-mount seed, so two tabs refunding the same order do not share a key. */
function idSeed(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // jsdom before 22 and any environment without webcrypto. Uniqueness here is
  // only ever within one operator's session, so time plus a counter is enough.
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** This is the shop, so nothing here blames the blog — see `ShopProducts.tsx`. */
function explain(err: unknown, what: string): string {
  if (err instanceof OfflineError) return 'The request didn’t reach the server.';
  if (err instanceof NotFoundError) {
    return `This deployment has no ${what} route yet.`;
  }
  if (err instanceof ApiError) {
    if (err.status === 403) return `Your account isn’t allowed to do that.`;
    if (err.status === 409) return 'Something else changed this order first. Reload and look again.';
    if (err.status === 429) return 'Too many changes too quickly — wait a moment and retry.';
    if (err.status === 400 && err.detail) return `The ${err.detail} wasn’t accepted.`;
  }
  return `The ${what} didn’t go through.`;
}

/** See `Shop.tsx` for why this row is copied into each screen. */

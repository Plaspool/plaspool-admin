import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Receipt, Search, X } from 'lucide-react';
import {
  shopApi,
  formatMinor,
  safeFormatMinor,
  moneyRefusalMessage,
  parseRefund,
  type OrderStatus,
  type ShopFulfillment,
  type ShopOrderDetail,
  type ShopOrderLine,
  type ShopOrderRow,
} from '../data/api-shop';
import { ageLabel, safeFormat } from '../data/when';
import { ApiError, NotFoundError, OfflineError } from '../data/errors';
import { useSession } from '../components/RequireAuth';
import { useToast } from '../components/Toast';
import { ConfirmDialog } from '../components/Dialog';
import { Skeleton } from '../components/ui/Feedback';
import { Select } from '../components/ui/Select';
import { useDelayed } from '../components/ui/useDelayed';
import { Board, awaitingPayment } from './orders/Board';
import { GeographyPanel } from './orders/GeographyPanel';
import { deliveryZoneTableFrom, type DeliveryZoneTable } from './orders/geography';
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
 * THE LIST ITSELF HAS TWO SHAPES, AND `?view=` IS THE WHOLE OF THE DIFFERENCE.
 * The board (`orders/Board.tsx`) is for working the queue; the table is for
 * scanning and finding. The board is the default because triage is the job this
 * screen exists for, and `withParams` therefore DROPS `view=board` rather than
 * writing it — `/shop/orders` is the board, `/shop/orders?view=table` is the
 * table, and both are links somebody can send. The switch is two `<Link>`s and
 * not a pair of buttons over local state, for the same reason every filter here
 * is a param: a view held in `useState` looks identical until anyone reloads,
 * shares the address, or presses Back.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE STATUS FILTER IS NOT APPLIED TO THE BOARD, AND THAT IS THE ONE DECISION
 * ON THIS SCREEN MOST WORTH ARGUING.
 *
 * The board's lanes ARE the statuses — `columnOf` reads `paid`, `fulfilled`,
 * `refunded`, `cancelled` and turns them into six lanes. Sending `?status=paid`
 * to the server as well would draw a six-lane board with one lane occupied and
 * five structurally empty, and an empty lane on a kanban means exactly one thing
 * to the person reading it: nothing is waiting there. "No orders in this lane"
 * and "you filtered them out" would look identical, which is the failure this
 * screen cannot ship. `?status=pending` is the sharpest case of all: `pending`
 * has no lane at all (`Board.tsx` argues why), so applying it would fetch a page
 * of orders and draw a board with nothing on it whatsoever.
 *
 * The three ways out were: apply it and explain the empty lanes; drop it from
 * the URL when the board opens; or keep it in the URL, leave it unapplied on
 * the board, and say so. The first still hands the operator six lanes they must
 * read a paragraph to discount. The second destroys a filter with a click on a
 * view switch, and a filter that a toggle can silently delete is worse than one
 * that is visibly parked.
 *
 * SO IT IS PARKED, and the precedent is three paragraphs up: `?id=` already
 * carries the list's filters unapplied so that closing the detail returns the
 * list somebody had. `?view=board&status=paid` is the same trade — the filter
 * is kept, is not in force, and the board says so above the lanes with the way
 * back to the surface that does apply it. The status control is not rendered on
 * the board at all: a dropdown reading "Paid" over a board showing every status
 * is a lie told by a control, and no caption underneath rescues it.
 *
 * WHAT THE BOARD STILL FILTERS BY IS `?q=`, because a search has no
 * relationship to a lane and the box the operator typed into is on screen — but
 * an empty lane under a search is still ambiguous, so the scope note says that
 * too whenever `q` is set.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS SCREEN MUST NOT PRETEND. `registerOrdersDeps` has no production
 * caller (§1.9), so on the live deployment the payment panel is `null` for every
 * order and the order mailer is `LoggingMailer` — an intent marked "sent" was
 * handed to something that writes a log line. Both are said in the markup rather
 * than left for an operator to infer from an empty box.
 *
 * TWO MONEY FORMATTERS APPEAR BELOW AND THE CHOICE IS NEVER ARBITRARY.
 * `safeFormatMinor` renders an amount the SERVER sent — every total, line and
 * payment figure on the screen — and downgrades one it cannot read to a
 * placeholder, so a single bad column costs the operator that cell and not the
 * whole surface (`when.ts` argues the case; `/shop/orders` is the screen it was
 * argued about). Bare `formatMinor` survives only where the number came from
 * `parseRefund` and is on its way BACK to the server — the refund confirmation,
 * its toast, and the box's own placeholder. There a throw is the correct
 * outcome: a refund dialog that renders "––" and still submits is the one
 * failure on this screen that reaches somebody's card.
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

type View = 'board' | 'table';

/** `?view=bord` is the same typo as `?status=fulfille`, and gets the default. */
function readView(params: URLSearchParams): View {
  return params.get('view') === 'table' ? 'table' : 'board';
}

/**
 * The value each param means when it is ABSENT, so it can be dropped rather
 * than written. `?status=all&view=board` and `/shop/orders` are the same screen,
 * and only one of them is a link worth sending.
 */
const PARAM_DEFAULT: Record<string, string> = { status: 'all', view: 'board' };

/** The same params with the defaults dropped rather than written. */
function withParams(
  base: URLSearchParams,
  patch: Record<string, string | null>,
): URLSearchParams {
  const next = new URLSearchParams(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '' || PARAM_DEFAULT[key] === value) {
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
  const view = readView(params);
  const search = params.get('q') ?? '';
  const cursor = params.get('cursor') ?? '';

  /**
   * The status the SERVER is asked for, which is not always the one in the URL.
   * The board parks it (see the file header); the table applies it. Everything
   * downstream — the request, the effect that fires it, the cursor's meaning —
   * reads this rather than `status`, so the rule is stated once.
   */
  const appliedStatus = view === 'board' ? 'all' : status;

  const [page, setPage] = useState<{ items: ShopOrderRow[]; nextCursor: string | null } | null>(
    null,
  );
  /**
   * WHEN THIS PAGE WAS READ, and it is what the board and the geography panel
   * are given as `now`.
   *
   * Both refuse to read a clock themselves — `summarise`, `ageBand` and
   * `breakdown` all take the instant as an argument so the boundary between
   * "waiting" and "overdue" is testable — and this is the honest instant to
   * hand them: an age on this board is an age against the data it is drawn
   * from. The cost is stated rather than hidden: the ages do not creep while
   * the tab sits open, they move when the page is re-read, which is also the
   * only moment anything else on the board can move.
   */
  const [readAt, setReadAt] = useState(() => Date.now());
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

  /**
   * `quiet` is the difference between "the operator asked for this list" and
   * "something changed under it": a quiet read leaves the skeletons, the empty
   * state and whatever is on screen exactly where they are and swaps the rows
   * underneath. See the move handler below for why that mode exists.
   */
  const load = useCallback(
    (signal?: AbortSignal, quiet = false) => {
      if (!quiet) setLoading(true);
      setProblem(null);
      return shopApi
        .listOrders(
          {
            status: appliedStatus === 'all' ? undefined : appliedStatus,
            search: search.trim() || undefined,
            cursor: cursor || undefined,
            limit: PAGE_LIMIT,
          },
          signal,
        )
        .then((next) => {
          if (signal?.aborted) return;
          setPage(next);
          setReadAt(Date.now());
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (signal?.aborted) return;
          setProblem(explain(err, 'order list'));
          setLoading(false);
        });
    },
    [appliedStatus, search, cursor],
  );

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  /**
   * THE LIVE DELIVERY RATES, FETCHED ONCE, AND ALLOWED TO FAIL ON THEIR OWN.
   *
   * `GeographyPanel` has no default for `zones` on purpose: without a table it
   * refuses to print a rate rather than quoting the seeded migration values as
   * if they were the shop's tariff, which they are not — they are owner-editable
   * without a deploy. So the table is worth a request, and `null` is a
   * legitimate answer rather than an error.
   *
   * WHICH IS WHY THE FAILURE IS SWALLOWED HERE AND NOWHERE ELSE. This request
   * has its own state and never touches `problem`: a shipping-zones route that
   * 404s on a deployment, or a request that simply loses, must cost the
   * operator one column of one panel — not the order list, which is the screen
   * they cannot get past. An abort deliberately does NOT record the attempt, so
   * switching away from the board mid-flight and back asks again; a real
   * failure does, so it is asked once per mount and not once per toggle.
   */
  const [zones, setZones] = useState<DeliveryZoneTable | null>(null);
  const zonesAsked = useRef(false);

  useEffect(() => {
    if (view !== 'board' || zonesAsked.current) return;
    const ac = new AbortController();
    void shopApi
      .listShippingZones(ac.signal)
      .then((rows) => {
        if (ac.signal.aborted) return;
        zonesAsked.current = true;
        setZones(deliveryZoneTableFrom(rows));
      })
      .catch(() => {
        if (ac.signal.aborted) return;
        zonesAsked.current = true;
      });
    return () => ac.abort();
  }, [view]);

  const items = page?.items ?? [];

  /**
   * THE ORDERS THE BOARD DOES NOT DRAW, AND WHICH OF THEM MEAN SOMETHING.
   *
   * `Board.tsx` dropped `awaiting_payment` from the lanes because nothing an
   * operator does moves an unpaid order, and it owes this screen an accounting
   * in return: every row it leaves out is counted in the scope note and named in
   * `StalledPayments` below. Computed here rather than inside the board because
   * both of those are ABOUT the page — its count, its address, its link back to
   * the table — and the board is deliberately router-free.
   *
   * Read on every render and used only on the board. On the table the status
   * filter is in force, so this would be "the pending orders in a page already
   * filtered to something else" — a true statement about the wrong question.
   */
  const awaiting = awaitingPayment(items, readAt);

  /** Those same orders on the surface that can show them: the table applies the
   *  status filter, and `?view=table&status=pending` is an ordinary address on
   *  this screen. `q` rides along because it is what `awaiting` was counted
   *  under; the cursor does not, for the reason the search box gives above. */
  const pendingTo = {
    pathname: '/shop/orders',
    search: asSearch(withParams(params, { view: 'table', status: 'pending', cursor: null })),
  };

  /**
   * WHERE A VIEW SWITCH LEAVES THE PAGE CURSOR, and it is not always the same
   * place. A keyset cursor is a position in one ordering of one filter, and the
   * two views do not always send the same filter — so the cursor survives the
   * switch exactly when it still means something, which is when there is no
   * status to apply. Otherwise it goes, for the reason the search box gives
   * above: page two of a list nobody is looking at reads as a screen that found
   * nothing.
   */
  const viewLink = (next: View) => ({
    pathname: '/shop/orders',
    search: asSearch(
      withParams(params, status === 'all' ? { view: next } : { view: next, cursor: null }),
    ),
  });

  return (
    <>
      <div className="shopfilters">
        {/*
          TWO LINKS, NOT TWO BUTTONS, and `aria-current` rather than
          `aria-pressed`.

          They are links because the view IS the address: `?view=table` is a
          different URL for the same list, so the browser's own Back button is
          the undo, a middle-click opens the other view in a tab, and the whole
          thing keeps working with JavaScript's own history rather than beside
          it. A pair of `aria-pressed` toggles would claim two independent
          switches where there is one choice of two, and a `<div onClick>` would
          claim neither and reach no keyboard at all.
        */}
        <div className="oview" role="group" aria-label="How the orders are shown">
          <Link
            className="oview__opt"
            to={viewLink('board')}
            aria-current={view === 'board' ? 'true' : undefined}
          >
            Board
          </Link>
          <Link
            className="oview__opt"
            to={viewLink('table')}
            aria-current={view === 'table' ? 'true' : undefined}
          >
            Table
          </Link>
        </div>

        {/*
          THE STATUS CONTROL IS NOT RENDERED ON THE BOARD. It is not disabled
          and it is not left showing a filter that is not in force — a dropdown
          reading "Paid" above a board holding every status is a control telling
          a lie, and the scope note below is where the parked filter is
          explained instead. The file header argues the whole decision.

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
        {view === 'table' && (
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
        )}
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
          {/*
            TWO HEADINGS, ONE NOTICE, because a failed read means two different
            things depending on whether anything is already on screen. With no
            page, nothing loaded and the notice is the screen. With a page — a
            re-read after a move that did not come back — the orders below are
            real, they are merely older than the shop, and telling the operator
            they "didn't load" while they are sitting there reads as a bug in
            the notice rather than a warning about the rows.
          */}
          <div>
            <strong>
              {page === null
                ? 'The orders didn’t load.'
                : 'This page may be older than the shop.'}
            </strong>{' '}
            {problem}
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
          {/*
            `appliedStatus`, NOT `status`. On the board the status in the URL is
            parked, so "no order is in this state right now" would name a state
            nothing was filtered by — an explanation for an empty screen that is
            not the reason the screen is empty.
          */}
          <p className="empty__body">
            {search
              ? 'Order search matches a whole order number or a whole email address. A part of either finds nothing.'
              : appliedStatus === 'all'
                ? 'Nobody has completed a checkout yet.'
                : 'No order is in this state right now.'}
          </p>
          {(search || status !== 'all') && (
            /* Clearing the filters keeps the VIEW. It is not one of them: an
               operator who clears a search on the board expects the board back,
               and `to="/shop/orders"` would have quietly returned the default. */
            <Link
              className="btn btn--outline"
              to={{
                pathname: '/shop/orders',
                search: asSearch(withParams(params, { q: null, status: null, cursor: null })),
              }}
            >
              Clear filters
            </Link>
          )}
        </div>
      ) : view === 'board' ? (
        <>
          <BoardScope
            drawn={items.length - awaiting.all.length}
            awaiting={awaiting.all.length}
            search={search}
            status={status}
            hasMore={page?.nextCursor != null}
            tableTo={viewLink('table')}
            pendingTo={pendingTo}
          />

          <StalledPayments
            count={awaiting.stale.length}
            oldestSince={awaiting.oldestSince}
            now={readAt}
            to={pendingTo}
          />

          {/*
            `onMoved` REFETCHES THE PAGE RATHER THAN PATCHING THE ROW, and the
            board has already made the cheaper option look attractive: `Board`
            re-reads the order it moved (`settle` → `getOrder`) and holds the
            server's answer beside these rows, so the CARD is already right by
            the time this fires. Nothing here is about the card.

            It is about everything else drawn from the same array. The geography
            panel is counting the pre-move page, the pager is counting rows that
            may no longer be in this filter, and the table view — one click away,
            over the same `page` — would show the operator the state they just
            changed. Patching one row from here would mean either projecting
            what the server does to an order on a move (a second copy of rules
            `pipeline.ts` owns, which is the drift its header refuses) or a THIRD
            read of an order the board has already re-read — and it would still
            leave the panel and the pager counting the old page.

            So: one list read, and QUIETLY. `quiet` keeps the rows and the scroll
            position on screen while it happens — no skeleton, no empty state,
            the URL untouched, so the operator's filters and their place in the
            lane survive — and a refresh that fails leaves the page that is
            already there alone under a notice that says it may be stale rather
            than blanking the queue.

            THE COST, SAID OUT LOUD: a move settling while another is still in
            flight hands `Board` a new array, which is how it throws its
            optimistic patch away — so the second card drops back to its old lane
            until its own move settles. Patching shares that exactly (any new
            array does it), and the only cure is a callback that says a move has
            STARTED, which `BoardProps` does not have.
          */}
          <Board
            rows={items}
            now={readAt}
            onMoved={() => void load(undefined, true)}
            onReload={() => void load()}
          />

          {/*
            The same rows, no second request — the panel's own contract. `zones`
            is `null` until the rate table lands and stays `null` if it never
            does, which is a mode the panel is built for rather than a failure
            it has to survive.
          */}
          <GeographyPanel rows={items} now={readAt} zones={zones} />
        </>
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
                  {items.map(({ order }) => (
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
                        {safeFormat(WHEN, order.placedAt)}
                      </td>
                      <td data-label="Status">
                        <span className={`chip chip--${order.status}`}>
                          {STATUS_LABEL[order.status] ?? order.status}
                        </span>
                      </td>
                      <td className="dtable__num" data-label="Total">
                        {safeFormatMinor(order.grandTotal, order.currency)}
                        {order.refundedTotal > 0 && (
                          <span className="dtable__sub">
                            {safeFormatMinor(order.refundedTotal, order.currency)} refunded
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

/**
 * WHAT IS ON THE BOARD, SAID BEFORE ANYBODY READS AN EMPTY LANE AS GOOD NEWS.
 *
 * A kanban is a picture of a queue, and a picture of a queue is read as the
 * WHOLE queue. This one is a page — fifty rows at most, keyset-ordered — with a
 * search sometimes applied, a status filter deliberately not, and one column of
 * the model that has no lane at all. Each of those is a way a lane can be empty
 * for a reason that has nothing to do with the work, and an empty lane says
 * "nothing is waiting here" whichever reason it is. So each one is named, above
 * the lanes, in as few words as the fact takes.
 *
 * THE ORDERS WITH NO LANE ARE ACCOUNTED FOR HERE WHETHER OR NOT ANYTHING IS
 * WRONG WITH THEM, which is the division of labour with `StalledPayments`
 * below. A checkout completed thirty seconds ago is entirely ordinary and is
 * still one row of this page that is not one card on this board; that is a fact
 * about the picture and belongs in the terms it is drawn under. Only the ones
 * old enough to mean a payment event went missing get a notice.
 *
 * IT IS NOT A `notice`. Nothing here is wrong or needs an action — these are
 * the terms the board is drawn under, and dressing them as a warning would
 * train the operator to dismiss the line that matters on the day the queue runs
 * past one page.
 */
function BoardScope({
  drawn,
  awaiting,
  search,
  status,
  hasMore,
  tableTo,
  pendingTo,
}: {
  /** Cards actually on the canvas — the page MINUS the orders with no lane. */
  drawn: number;
  /** How many of the page have no lane, i.e. are awaiting payment. */
  awaiting: number;
  search: string;
  status: OrderStatus | 'all';
  hasMore: boolean;
  tableTo: { pathname: string; search: string };
  pendingTo: { pathname: string; search: string };
}) {
  return (
    <div className="oscope">
      {/*
        THE COUNT IS OF CARDS DRAWN, NOT OF ROWS FETCHED, and that is a change
        the dropped lane forced. "50 orders on the board" over 49 cards is the
        one number on this screen an operator would count by hand to check, and
        the line under it names the difference in the same breath — a board that
        is short by one with no explanation is exactly the card somebody goes
        looking for.
      */}
      <p className="oscope__line">
        <strong>
          {drawn} order{drawn === 1 ? '' : 's'} on the board
        </strong>{' '}
        — one page, of at most {PAGE_LIMIT}. Every status that can be worked is
        here, so a lane is empty because nothing is waiting in it.
      </p>

      {awaiting > 0 && (
        <p className="oscope__line">
          <strong>{awaiting}</strong> more {awaiting === 1 ? 'is' : 'are'} awaiting
          payment and {awaiting === 1 ? 'has' : 'have'} no lane: only a payment
          event turns an order paid, and there is nothing an operator can do to
          hurry one.{' '}
          <Link to={pendingTo}>The table lists {awaiting === 1 ? 'it' : 'them'}</Link>.
        </p>
      )}

      {hasMore && (
        <p className="oscope__line">
          There is at least one more page after this one and the board cannot see
          past it, so this is not the whole queue. Page on below.
        </p>
      )}

      {search !== '' && (
        /* `<bdi>` for the same reason every piece of customer text on a card
           has one: the operator may have pasted an address, and an unpaired
           U+202E in it reverses the sentence it lands in. */
        <p className="oscope__line">
          Only orders matching <bdi>“{search}”</bdi> are on it — so a lane can
          also be empty because the search did not match anything in it.
        </p>
      )}

      {status !== 'all' && (
        <p className="oscope__line">
          The <strong>{STATUS_LABEL[status] ?? status}</strong> filter is still in
          the address and is not applied here: the lanes are the statuses, so
          filtering to one would empty the rest and the board would read as a
          shop with nothing to do.{' '}
          <Link to={tableTo}>The table applies it</Link>.
        </p>
      )}
    </div>
  );
}

/**
 * THE PAYMENT EVENT THAT NEVER ARRIVED — the signal the dropped lane was in the
 * way of.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS WORTH A BAND AND THE LANE WAS NOT.
 *
 * An order is INSERTed `pending` on `checkout.completed` and moved by an event:
 * `payment.captured` makes it `paid`, `payment.failed` CANCELS it and releases
 * the points. NOTHING EXPIRES A PENDING ORDER — the sweep drains the
 * commerce-event and email outboxes and does not touch order status — so a
 * `pending` row that is still `pending` an hour later is not a slow customer.
 * It is an order that will sit there until somebody looks: a checkout the
 * customer completed, quite possibly a card that was charged, and no event
 * coming to say so.
 *
 * A lane could not say that, and this is the whole argument for the trade. A
 * column shows a card; a card is a card whether it is thirty seconds old or
 * three days old, and the capture in `__fixtures__/orders-live.json` says the
 * thirty-second one is completely ordinary — capture to payment there is 191 ms,
 * 22 s, 63 s. The distinction that matters is a CLOCK, and only something
 * allowed to read one can draw it. `awaitingPayment` in `Board.tsx` draws it and
 * defends the boundary; this renders the half of it worth interrupting for.
 *
 * IT IS HERE AND NOT IN THE BOARD for the same reason `BoardScope` is: it is
 * about the page rather than about the lanes. It counts rows the route fetched,
 * it links to another view of the same list through `withParams`, and both of
 * those are this file's vocabulary — the board takes `rows`, `now` and two
 * callbacks, and giving it a router to build one link would be the larger change
 * by far.
 *
 * WHAT IT DOES NOT DO. It does not offer a cancel. The move is owner-only, it
 * releases stock and points, and it is the wrong answer in the case this notice
 * is usually about — a payment that was taken. So the action is a link to the
 * orders and the sentence is what to check; cancelling stays where it already
 * lives, on the order's own page and in the table view.
 *
 * SILENCE IS THE NORMAL STATE. `null` on most days, on most shops, forever.
 * ═══════════════════════════════════════════════════════════════════════════
 */
function StalledPayments({
  count,
  oldestSince,
  now,
  to,
}: {
  count: number;
  /** When the oldest of them was placed. Non-null exactly when `count > 0` — a
   *  row is only counted stale if its `placedAt` could be read — and gating on
   *  it is what hands `ageLabel` a number rather than a maybe. */
  oldestSince: number | null;
  now: number;
  to: { pathname: string; search: string };
}) {
  if (count === 0 || oldestSince === null) return null;

  return (
    /*
     * `notice--warn` AND NO `role="alert"`. The danger tone and the live region
     * are for something that just happened to the operator's own action — a
     * failed save, a stale page — and this is a standing fact about the shop
     * that was equally true before the page loaded. Interrupting a screen reader
     * mid-sentence with it would be the alarm this must not be.
     */
    <div className="notice notice--warn">
      <div>
        <strong>
          {count === 1
            ? `One order has been awaiting payment for ${ageLabel(oldestSince, now)}`
            : `${count} orders are awaiting payment, the oldest for ${ageLabel(oldestSince, now)}`}
          .
        </strong>{' '}
        Nothing in the shop will move {count === 1 ? 'it' : 'them'} from here: a
        payment that fails cancels the order outright, and one that never lands
        leaves it exactly like this indefinitely. Check the payment provider — if
        the money arrived, the shop was never told. Cancelling, which releases
        the reserved stock, is on an order&rsquo;s own page.
      </div>
      <div className="notice__actions">
        <Link className="btn btn--outline btn--sm" to={to}>
          Show {count === 1 ? 'the order' : 'them'}
        </Link>
      </div>
    </div>
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
          {order.orderNumber} · {safeFormat(WHEN, order.placedAt)} · {order.email}
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
                          {safeFormatMinor(line.unitAmount, currency)}
                        </td>
                        <td className="dtable__num" data-label="Line">
                          {safeFormatMinor(line.lineTotal, currency)}
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
                <span className="kv__v">{safeFormatMinor(order.subtotal, currency)}</span>
                <span className="kv__k">Shipping</span>
                <span className="kv__v">{safeFormatMinor(order.shippingTotal, currency)}</span>
                <span className="kv__k">Tax</span>
                <span className="kv__v">{safeFormatMinor(order.taxTotal, currency)}</span>
                <span className="kv__rule" />
                <span className="kv__k">Total</span>
                <span className="kv__v kv__v--total">
                  {safeFormatMinor(order.grandTotal, currency)}
                </span>
                {order.refundedTotal > 0 && (
                  <>
                    <span className="kv__k">Refunded</span>
                    <span className="kv__v">
                      −{safeFormatMinor(order.refundedTotal, currency)}
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
                        {safeFormat(WHEN, entry.occurredAt)}
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
                    {safeFormatMinor(payment.amount, payment.currency)}
                  </span>
                  <span className="kv__k">Refunded</span>
                  <span className="kv__v">
                    {safeFormatMinor(payment.refundedTotal, payment.currency)}
                  </span>
                  <span className="kv__k">Left</span>
                  <span className="kv__v kv__v--total">
                    {safeFormatMinor(refundable, payment.currency)}
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
                        ? `handed to the mailer ${safeFormat(WHEN, mail.sentAt)}`
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
                            {safeFormatMinor(refundable, payment.currency)} is what is left.
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
            {order.orderNumber} for {safeFormatMinor(order.grandTotal, currency)} will be
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
                created {safeFormat(WHEN, f.createdAt)}
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

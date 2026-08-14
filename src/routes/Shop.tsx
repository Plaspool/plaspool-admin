import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShoppingBag } from 'lucide-react';
import { shopApi, formatMinor, type ShopStats } from '../data/api-shop';
import { ApiError, NotFoundError, OfflineError } from '../data/errors';
import { Skeleton } from '../components/ui/Feedback';
import { useDelayed } from '../components/ui/useDelayed';
import './shop.css';

/**
 * The shop's overview.
 *
 * ONE REQUEST, AND THAT IS THE DESIGN (HANDOFF §2 A4): `GET /shop/admin/stats`
 * answers orders by status, revenue over three windows, low stock, unsent order
 * email and the latest five orders in a single JSON, computed from a handful of
 * indexed aggregates. Six requests would give six instants — a revenue figure
 * from before a sale next to an order count from after it — and this screen's
 * whole job is to be internally consistent at a glance.
 *
 * NO CHART LIBRARY (§3 B3). Every figure here is a number a person reads
 * exactly: "£4,182.50 in the last 7 days" is the fact, and a sparkline over it
 * would be decoration that has to be maintained, sized for two themes, and made
 * legible to someone who cannot see colour. `tabular-nums` and the `Feedback`
 * skeleton vocabulary are the whole visual budget for v1.
 */

const WHEN = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** The status labels, in the order an order actually moves through them. */
const ORDER_STATUS_LABEL: Record<string, string> = {
  pending: 'Awaiting payment',
  paid: 'Paid',
  fulfilled: 'Fulfilled',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
  partially_refunded: 'Partly refunded',
};

export default function Shop() {
  const [stats, setStats] = useState<ShopStats | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Held back 250ms: a warm route answers faster than a person can perceive,
  // and a skeleton that flashes reads as a fault rather than as loading.
  const showSkeletons = useDelayed(loading);

  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    setProblem(null);
    return shopApi
      .stats({}, signal)
      .then((next) => {
        if (signal?.aborted) return;
        setStats(next);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (signal?.aborted) return;
        setProblem(explain(err));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  return (
    <div className="shopscr">
      <header className="shopscr__head">
        <div className="shopscr__headrow">
          <div>
            <h1 className="shopscr__title">Shop</h1>
            <p className="shopscr__lede">
              Products, orders and the people who bought them. Everything here is
              priced in whole minor units — the store never rounds a customer&rsquo;s
              money through a float.
            </p>
          </div>
        </div>
      </header>


      <div className="shopscr__body">
        {problem && (
          <div className="notice notice--danger" role="alert">
            <div>
              <strong>The figures didn&rsquo;t load.</strong> {problem}
            </div>
            <div className="notice__actions">
              <button className="btn btn--outline btn--sm" onClick={() => void load()}>
                Try again
              </button>
            </div>
          </div>
        )}

        {loading && !stats ? (
          showSkeletons ? (
            <div className="stattiles" aria-hidden="true">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="stat">
                  <Skeleton height={11} width="55%" />
                  <Skeleton height={28} width="70%" />
                  <Skeleton height={13} width="85%" />
                </div>
              ))}
            </div>
          ) : null
        ) : stats ? (
          <Figures stats={stats} />
        ) : (
          !problem && (
            <div className="empty">
              <div className="empty__mark" aria-hidden="true">
                <ShoppingBag />
              </div>
              <h2 className="empty__title">No figures yet</h2>
              <p className="empty__body">
                Nothing has been sold, so there is nothing to total. The catalogue
                and order screens work on their own.
              </p>
              <Link className="btn btn--outline" to="/shop/products">
                Go to the catalogue
              </Link>
            </div>
          )
        )}
      </div>
    </div>
  );
}

function Figures({ stats }: { stats: ShopStats }) {
  const lowStock = stats.lowStock ?? [];
  const byStatus = stats.ordersByStatus ?? [];
  const orders = stats.latestOrders ?? [];
  const revenue = stats.revenue ?? [];
  const unsent = stats.emails.pending + stats.emails.stuck;

  return (
    <>
      <div className="stattiles">
        {/*
          ONE TILE PER CURRENCY, because the route groups by currency and two
          ISO-4217 codes cannot be added. v1 sells in one, so this is one tile;
          the map is what keeps the screen honest on the day it is not, instead
          of printing a sum that reconciles against nothing.
        */}
        {revenue.length === 0 ? (
          <div className="stat">
            <span className="stat__label">Revenue</span>
            <span className="stat__value">—</span>
            <span className="stat__note">Nothing has been paid for yet.</span>
          </div>
        ) : (
          revenue.map((window) => (
            <div className="stat" key={window.currency}>
              <span className="stat__label">
                Revenue, 24 hours
                {revenue.length > 1 ? ` · ${window.currency}` : ''}
              </span>
              {/* "24 hours" and not "today": the window is measured back from
                  `generatedAt`, so at 9 a.m. it includes most of yesterday. */}
              <span className="stat__value">
                {formatMinor(window.last24h, window.currency)}
              </span>
              <span className="stat__note">
                {formatMinor(window.last7d, window.currency)} over 7 days ·{' '}
                {formatMinor(window.last30d, window.currency)} over 30. Net of refunds.
              </span>
            </div>
          ))
        )}

        <div className="stat">
          <span className="stat__label">Orders</span>
          <span className="stat__value">
            {byStatus.reduce((n, row) => n + row.count, 0).toLocaleString()}
          </span>
          <span className="stat__note">
            {/* Awaiting payment is the count that costs somebody something if
                it is ignored, so it is the one repeated out here. */}
            {byStatus
              .filter((r) => r.status === 'pending')
              .reduce((n, r) => n + r.count, 0)}{' '}
            awaiting payment
          </span>
        </div>

        <div className={`stat${lowStock.length > 0 ? ' stat--alert' : ''}`}>
          <span className="stat__label">Low stock</span>
          <span className="stat__value">
            {lowStock.length.toLocaleString()}
            {stats.lowStockMore ? '+' : ''}
          </span>
          <span className="stat__note">
            {lowStock.length === 0
              ? `Nothing at or below ${stats.lowStockThreshold}.`
              : `${lowStock.length === 1 ? 'One variant is' : 'Variants'} at or below ${stats.lowStockThreshold} available.${
                  stats.lowStockMore ? ' There are more than these.' : ''
                }`}
          </span>
        </div>

        <div className={`stat${unsent > 0 ? ' stat--alert' : ''}`}>
          <span className="stat__label">Unsent order email</span>
          <span className="stat__value">{unsent.toLocaleString()}</span>
          {/*
            THIS SENTENCE IS THE POINT OF THE TILE. The order outbox is complete
            — four kinds, dedupe keys, eight-attempt retry — and it is drained
            only by an owner calling `POST /shop/admin/sweep`, which nothing
            schedules (HANDOFF §1.11). A number here that looked like a queue
            being worked through would be the screen implying a mechanism that
            is not running — and `stuck` is worse than waiting: those are out of
            attempts, so nothing will ever retry them without a person.
          */}
          <span className="stat__note">
            {stats.emails.stuck > 0
              ? `${stats.emails.stuck} ran out of attempts — nothing will retry those.`
              : unsent === 0
                ? 'Nothing waiting in the order outbox.'
                : 'Waiting for a sweep. Nothing schedules one yet, so these go out when someone asks.'}
          </span>
        </div>
      </div>

      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Orders by status</h2>
        </div>
        <div className="panel__body panel__body--flush">
          <div className="dtable__scroll">
            <table className="dtable">
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col" className="dtable__num">
                    Orders
                  </th>
                  <th scope="col" className="dtable__num">
                    Value, gross
                  </th>
                </tr>
              </thead>
              <tbody>
                {byStatus.length === 0 ? (
                  <tr>
                    <td className="dtable__empty" colSpan={3}>
                      No orders have been placed.
                    </td>
                  </tr>
                ) : (
                  byStatus.map((row) => (
                    // Keyed on both, because the rows are grouped by
                    // (status, currency) and a single-currency shop is a
                    // coincidence rather than a guarantee.
                    <tr key={`${row.status}:${row.currency}`}>
                      <td>
                        <span className={`chip chip--${row.status}`}>
                          {ORDER_STATUS_LABEL[row.status] ?? row.status}
                        </span>
                      </td>
                      <td className="dtable__num" data-label="Orders">
                        {row.count.toLocaleString()}
                      </td>
                      {/* Gross, and the header says so — `revenue` above is the
                          figure that is net of refunds. The stacked phone row
                          has no header to say it, so `data-label` carries the
                          word rather than repeating the bare number. */}
                      <td className="dtable__num" data-label="Value, gross">
                        {formatMinor(row.total, row.currency)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {lowStock.length > 0 && (
        <section className="panel">
          <div className="panel__head">
            {/*
              "Running out" was a mood, not a fact: it named no threshold, no
              unit and no action, so the number beside each row — Available 3 —
              had nothing to be low AGAINST. The threshold is the whole content
              of this panel, and it is a setting, so it has to be on screen
              rather than in the reader's head. "Low stock" is also what the
              rest of the shop calls this: `stats.lowStockThreshold`, the tile
              above, the products screen's own filter.
            */}
            <div className="panel__heading">
              <h2 className="panel__title">Low stock</h2>
              {/*
                NOT THE TILE'S SENTENCE AGAIN. The tile says "at or below 5
                available" and this said it a second time nine pixels lower —
                a duplicate the test above caught before a reader had to. This
                line has a different job: it explains the AVAILABLE COLUMN,
                which is the one number in the list with no meaning until you
                know what it is being measured against.
              */}
              <p className="panel__sub">
                {lowStock.length === 1 ? 'One variant has' : `${lowStock.length} variants have`}{' '}
                {stats.lowStockThreshold} or fewer available
                {stats.lowStockMore ? ', and there are more than these' : ''}.
              </p>
            </div>
            <Link className="btn btn--ghost btn--sm" to="/shop/products">
              Open the catalogue
            </Link>
          </div>
          <div className="panel__body panel__body--flush">
            <div className="dtable__scroll">
              <table className="dtable">
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col">SKU</th>
                    <th scope="col" className="dtable__num">
                      Available
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {lowStock.map((row) => (
                    <tr key={row.variantId}>
                      <td>
                        <Link
                          className="dtable__link"
                          to={`/shop/products?id=${encodeURIComponent(row.productId)}`}
                        >
                          {row.productTitle || 'Untitled product'}
                        </Link>
                      </td>
                      <td className="num" data-label="SKU">
                        {row.sku}
                      </td>
                      <td className="dtable__num" data-label="Available">
                        {row.available.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Latest orders</h2>
          <Link className="btn btn--ghost btn--sm" to="/shop/orders">
            All orders
          </Link>
        </div>
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
                {orders.length === 0 ? (
                  <tr>
                    <td className="dtable__empty" colSpan={4}>
                      No orders yet.
                    </td>
                  </tr>
                ) : (
                  orders.map((order) => (
                    <tr key={order.id}>
                      <td>
                        <Link
                          className="dtable__link"
                          to={`/shop/orders?id=${encodeURIComponent(order.id)}`}
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
                          {ORDER_STATUS_LABEL[order.status] ?? order.status}
                        </span>
                      </td>
                      {/*
                        The ORDER's own currency, which is why the row carries
                        one. There is no store-wide currency in this response to
                        borrow instead — the route groups every total by code
                        precisely so nothing downstream assumes there is one.
                      */}
                      <td className="dtable__num" data-label="Total">
                        {formatMinor(order.grandTotal, order.currency)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}

/**
 * The failure, in a sentence an operator can act on.
 *
 * The 404 arm is not defensive padding: this screen is being written while
 * `GET /shop/admin/stats` is being written, and "the route is not on this
 * deployment" is a completely different problem from "the shop is broken".
 */
function explain(err: unknown): string {
  if (err instanceof OfflineError) return 'The request didn’t reach the blog.';
  if (err instanceof NotFoundError) {
    return 'This deployment has no shop statistics route yet.';
  }
  if (err instanceof ApiError && err.status === 403) {
    return 'Your account isn’t allowed to read the shop’s figures.';
  }
  return 'The blog answered with an error.';
}

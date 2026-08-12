import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Users } from 'lucide-react';
import { shopApi, formatMinor, type ShopBuyer } from '../data/api-shop';
import { ApiError, NotFoundError, OfflineError } from '../data/errors';
import { Skeleton } from '../components/ui/Feedback';
import { useDelayed } from '../components/ui/useDelayed';
import './shop.css';

/**
 * Buyers, which is not the same list as accounts.
 *
 * Guest checkout exists, so `shop_customers` holds only the people who made an
 * account; the set that actually matters commercially is
 * `DISTINCT email FROM shop_orders` (HANDOFF §1.9, §2 A4). The route builds it
 * from orders and joins accounts onto them, and this screen is honest about the
 * difference — a row with no account says so, because "customer" and "person who
 * has paid us" are two different lists and support needs to know which one it is
 * looking at.
 *
 * PAGINATION LIVES IN THE URL AND PUSHES (HANDOFF §3 B3). `?cursor=` is the
 * whole of this screen's state, so browser Back walks back through the pages
 * for free — which is why there is no "previous" button and no stack of seen
 * cursors held in a ref. A keyset cursor has no inverse; the history stack is
 * the only honest "previous" available, and it is the one the buttons on the
 * browser already offer.
 */

const PAGE_LIMIT = 50;

const WHEN = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export default function ShopCustomers() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const cursor = params.get('cursor') ?? '';

  const [page, setPage] = useState<{ items: ShopBuyer[]; nextCursor: string | null } | null>(
    null,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const showSkeletons = useDelayed(loading);

  const load = useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      setProblem(null);
      return shopApi
        .listCustomers({ cursor: cursor || undefined, limit: PAGE_LIMIT }, signal)
        .then((next) => {
          if (signal?.aborted) return;
          setPage(next);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (signal?.aborted) return;
          setProblem(explain(err));
          setLoading(false);
        });
    },
    [cursor],
  );

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const items = page?.items ?? [];

  return (
    <div className="shopscr">
      <header className="shopscr__head">
        <div className="shopscr__headrow">
          <div>
            <h1 className="shopscr__title">Customers</h1>
            <p className="shopscr__lede">
              Everyone who has bought something, whether or not they made an
              account, with what they have spent and when they last ordered.
            </p>
          </div>
        </div>
      </header>

      <ShopNav />

      <div className="shopscr__body">
        {problem && (
          <div className="notice notice--danger" role="alert">
            <div>
              <strong>The buyer list didn&rsquo;t load.</strong> {problem}
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
            <div className="panel" aria-hidden="true">
              <div className="panel__body">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} height={18} width={`${90 - i * 6}%`} />
                ))}
              </div>
            </div>
          ) : null
        ) : items.length === 0 && !problem ? (
          <div className="empty">
            <div className="empty__mark" aria-hidden="true">
              <Users />
            </div>
            <h2 className="empty__title">
              {cursor ? 'Nothing further' : 'No buyers yet'}
            </h2>
            <p className="empty__body">
              {cursor
                ? 'This page is past the end of the list.'
                : 'Nobody has completed a checkout. A buyer appears here on their first order, account or not.'}
            </p>
            {cursor && (
              <Link className="btn btn--outline" to="/shop/customers">
                Back to the first page
              </Link>
            )}
          </div>
        ) : (
          <section className="panel">
            <div className="panel__head">
              <h2 className="panel__title">Buyers</h2>
              <span className="pager__note">
                {items.length} on this page
                {page?.nextCursor ? ', more after it' : ''}
              </span>
            </div>
            <div className="panel__body panel__body--flush">
              <div className="dtable__scroll">
                <table className="dtable">
                  <thead>
                    <tr>
                      <th scope="col">Buyer</th>
                      <th scope="col" className="dtable__num">
                        Orders
                      </th>
                      <th scope="col" className="dtable__num">
                        Kept
                      </th>
                      <th scope="col">Last order</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((buyer) => (
                      <tr key={buyer.email}>
                        <td>
                          <span className="dtable__strong">
                            {buyer.displayName || buyer.email}
                          </span>
                          <span className="dtable__sub">
                            {/* The account/guest distinction, said on every row.
                                An operator reading this list is usually deciding
                                whether the person can sign in to find their own
                                order, and that answer is exactly this field. */}
                            {buyer.displayName ? `${buyer.email} · ` : ''}
                            {buyer.customerId ? 'has an account' : 'guest checkout'}
                          </span>
                        </td>
                        <td className="dtable__num">
                          {buyer.orderCount.toLocaleString()}
                          {buyer.paidCount !== buyer.orderCount && (
                            // Orders placed and orders PAID FOR are different
                            // numbers, and the money column counts only the
                            // second. Showing one without the other invites the
                            // arithmetic "four orders, £0 spent — bug?".
                            <span className="dtable__sub">{buyer.paidCount} paid</span>
                          )}
                        </td>
                        <td className="dtable__num">
                          {formatMinor(buyer.totalSpent, buyer.currency)}
                          <span className="dtable__sub">after refunds</span>
                        </td>
                        <td>
                          {/* Straight to the order, not to a search for it: the
                              row carries the id as well as the number, and a
                              search would be a second lookup for something this
                              response already resolved. */}
                          <Link
                            className="dtable__link"
                            to={`/shop/orders?id=${encodeURIComponent(buyer.lastOrderId)}`}
                          >
                            {buyer.lastOrderNumber}
                          </Link>
                          <span className="dtable__sub">
                            {WHEN.format(new Date(buyer.lastOrderAt))} ·{' '}
                            {buyer.lastOrderStatus.replace('_', ' ')}
                          </span>
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
            <button
              className="btn btn--ghost btn--sm"
              disabled={!cursor}
              onClick={() => navigate(-1)}
            >
              Back a page
            </button>
            <button
              className="btn btn--outline btn--sm"
              disabled={!page?.nextCursor}
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set('cursor', page!.nextCursor!);
                /*
                 * PUSHES, unlike every filter on this surface. A page is a
                 * place — Back should return to the previous page of buyers,
                 * not leave the section — and it is the only control here for
                 * which that is true.
                 */
                setParams(next);
              }}
            >
              Next page
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function explain(err: unknown): string {
  if (err instanceof OfflineError) return 'The request didn’t reach the blog.';
  if (err instanceof NotFoundError) return 'This deployment has no buyer list route yet.';
  if (err instanceof ApiError && err.status === 403) {
    return 'Your account isn’t allowed to read the buyer list.';
  }
  return 'The blog answered with an error.';
}

/** See `Shop.tsx` for why this row is copied into each screen. */
function ShopNav() {
  return (
    <nav className="shopscr__nav" aria-label="Shop sections">
      <Link className="shopscr__tab" to="/shop">
        Overview
      </Link>
      <Link className="shopscr__tab" to="/shop/products">
        Products
      </Link>
      <Link className="shopscr__tab" to="/shop/orders">
        Orders
      </Link>
      <Link className="shopscr__tab" to="/shop/customers" aria-current="page">
        Customers
      </Link>
    </nav>
  );
}

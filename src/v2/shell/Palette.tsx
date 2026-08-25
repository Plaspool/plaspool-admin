import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CornerDownRight,
  FileText,
  Package,
  Receipt,
  Search,
  TicketPercent,
  UserRound,
} from 'lucide-react';
import type { ListPost } from '../../../shared/types';
import { api } from '../../data/api';
import { shopApi, type ShopOrderRow, type ShopProduct } from '../../data/api-shop';
import { discountsApi } from '../data/discounts';
import { marketingApi, type CustomerRow, type Discount } from '../../data/api-marketing';
import { humanise, money } from '../lib/format';
import { NAV, NAV_FOOT } from './nav';

/**
 * Ctrl+K — the application search.
 *
 * WHAT IT SEARCHES, HONESTLY: pages (the nav), the FIRST PAGE of products,
 * orders, discounts and posts filtered client-side — plus CUSTOMERS through
 * a real server search (`marketingApi.listCustomers` matches an email or id
 * prefix over everyone who has ever paid or held points). `listProducts`
 * still has no search parameter (the route's schema is `.strict()` and
 * would 400 one), so the footer names the scope rather than implying a
 * store-wide search that does not exist.
 *
 * TODO(v2): true store-wide product search needs a server-side endpoint
 * (title prefix at least) — still queued as backend work.
 */
type Scope = 'all' | 'pages' | 'products' | 'orders' | 'discounts' | 'posts' | 'customers';

interface Hit {
  key: string;
  group: 'Pages' | 'Products' | 'Orders' | 'Discounts' | 'Posts' | 'Customers';
  icon: ReactNode;
  title: ReactNode;
  /** Plain text for filtering. */
  text: string;
  meta?: string;
  to: string;
}

const SCOPES: { value: Scope; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'pages', label: 'Pages' },
  { value: 'products', label: 'Products' },
  { value: 'orders', label: 'Orders' },
  { value: 'discounts', label: 'Discounts' },
  { value: 'posts', label: 'Posts' },
  { value: 'customers', label: 'Customers' },
];

const STALE_MS = 60_000;

interface Pool {
  products: ShopProduct[];
  orders: ShopOrderRow[];
  discounts: Discount[];
  posts: ListPost[];
}

function pageHits(): Hit[] {
  const hits: Hit[] = [];
  for (const entry of [...NAV, ...NAV_FOOT]) {
    hits.push({
      key: `page:${entry.to}`,
      group: 'Pages',
      icon: entry.icon,
      title: entry.label,
      text: entry.label,
      to: entry.to,
    });
    for (const child of entry.children ?? []) {
      hits.push({
        key: `page:${child.to}`,
        group: 'Pages',
        icon: <CornerDownRight aria-hidden="true" />,
        title: child.label,
        text: `${entry.label} ${child.label}`,
        meta: entry.label,
        to: child.to,
      });
    }
  }
  return hits;
}

export function Palette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [hot, setHot] = useState(0);
  const [pool, setPool] = useState<Pool | null>(null);
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const fetchedAt = useRef(0);

  /* Open: reset the query, lock the page scroll, refresh the pool if stale. */
  useEffect(() => {
    if (!open) return;
    setQ('');
    setScope('all');
    setHot(0);

    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const controller = new AbortController();
    if (Date.now() - fetchedAt.current > STALE_MS) {
      setLoading(true);
      void Promise.all([
        shopApi.listProducts({ limit: 50 }, controller.signal),
        shopApi.listOrders({ limit: 25 }, controller.signal),
        discountsApi.list(controller.signal),
        api.listPosts({ limit: 50 }).catch(() => ({ items: [] as ListPost[], nextCursor: null })),
      ])
        .then(([products, orders, discounts, posts]) => {
          fetchedAt.current = Date.now();
          setPool({ products: products.items, orders: orders.items, discounts, posts: posts.items });
          setLoading(false);
        })
        .catch((cause: unknown) => {
          if (cause instanceof DOMException && cause.name === 'AbortError') return;
          /* The pages group still works with no pool — say nothing loud. */
          setLoading(false);
        });
    }

    return () => {
      controller.abort();
      document.body.style.overflow = previous;
    };
  }, [open]);

  /* Customers are the one LIVE search — the marketing route matches an email
     or customer-id prefix server-side, so it types along with the query,
     debounced a beat. */
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  useEffect(() => {
    if (!open || !q.trim() || (scope !== 'all' && scope !== 'customers')) {
      setCustomers([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      marketingApi
        .listCustomers({ query: q.trim(), limit: 8 }, controller.signal)
        .then((page) => setCustomers(page.items))
        .catch(() => setCustomers([]));
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, q, scope]);

  const groups = useMemo(() => {
    const query = q.trim().toLowerCase();
    const has = (text: string) => !query || text.toLowerCase().includes(query);
    const cap = scope === 'all' ? 5 : 30;

    const result: { label: Hit['group']; hits: Hit[] }[] = [];

    if (scope === 'all' || scope === 'pages') {
      const hits = pageHits().filter((h) => has(h.text));
      if (hits.length) result.push({ label: 'Pages', hits: hits.slice(0, query ? cap : 30) });
    }

    if ((scope === 'all' || scope === 'products') && pool) {
      const hits = pool.products
        .filter((p) => has(`${p.title} ${p.slug ?? ''} ${p.category}`))
        .slice(0, cap)
        .map<Hit>((p) => ({
          key: `product:${p.id}`,
          group: 'Products',
          icon: <Package aria-hidden="true" />,
          title: p.title || 'Untitled product',
          text: p.title,
          meta: humanise(p.status),
          to: `/products/${p.id}`,
        }));
      if (hits.length) result.push({ label: 'Products', hits });
    }

    if ((scope === 'all' || scope === 'orders') && pool) {
      const hits = pool.orders
        .filter(({ order }) => has(`${order.orderNumber} ${order.email}`))
        .slice(0, cap)
        .map<Hit>(({ order }) => ({
          key: `order:${order.id}`,
          group: 'Orders',
          icon: <Receipt aria-hidden="true" />,
          title: <span className="mono">{order.orderNumber}</span>,
          text: order.orderNumber,
          meta: `${order.email} · ${money(order.grandTotal, order.currency)}`,
          to: `/orders/${order.id}`,
        }));
      if (hits.length) result.push({ label: 'Orders', hits });
    }

    if ((scope === 'all' || scope === 'discounts') && pool) {
      const hits = pool.discounts
        .filter((d) => has(`${d.code} ${d.note ?? ''}`))
        .slice(0, cap)
        .map<Hit>((d) => ({
          key: `discount:${d.id}`,
          group: 'Discounts',
          icon: <TicketPercent aria-hidden="true" />,
          title: <span className="mono">{d.code}</span>,
          text: d.code,
          meta:
            d.kind === 'percent'
              ? `${((d.percentBps ?? 0) / 100).toFixed((d.percentBps ?? 0) % 100 === 0 ? 0 : 2)}% off`
              : money(d.amountMinor ?? 0, d.currency ?? 'NGN'),
          to: '/discounts',
        }));
      if (hits.length) result.push({ label: 'Discounts', hits });
    }

    if ((scope === 'all' || scope === 'posts') && pool) {
      const hits = pool.posts
        .filter((p) => has(`${p.title} ${p.category}`))
        .slice(0, cap)
        .map<Hit>((p) => ({
          key: `post:${p.id}`,
          group: 'Posts',
          icon: <FileText aria-hidden="true" />,
          title: p.title || 'Untitled post',
          text: p.title,
          meta: humanise(p.status),
          to: `/content/posts/${p.id}`,
        }));
      if (hits.length) result.push({ label: 'Posts', hits });
    }

    if ((scope === 'all' || scope === 'customers') && customers.length > 0) {
      const hits = customers.slice(0, cap).map<Hit>((c) => ({
        key: `customer:${c.email}`,
        group: 'Customers',
        icon: <UserRound aria-hidden="true" />,
        title: c.displayName || c.email,
        text: `${c.displayName ?? ''} ${c.email}`,
        meta: `${c.balance} pts${c.guest ? ' · guest' : ''}`,
        to: '/customers',
      }));
      result.push({ label: 'Customers', hits });
    }

    return result;
  }, [q, scope, pool, customers]);

  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups]);

  useEffect(() => {
    setHot(0);
  }, [q, scope]);

  /* Keep the highlighted row in view while arrowing through a long list. */
  useEffect(() => {
    const el = listRef.current?.querySelector('.palette__row.is-hot');
    el?.scrollIntoView({ block: 'nearest' });
  }, [hot]);

  if (!open) return null;

  function go(hit: Hit) {
    onClose();
    navigate(hit.to);
  }

  return (
    <div
      className="palette__scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search">
        <div className="palette__head">
          <Search aria-hidden="true" />
          <input
            className="palette__input"
            placeholder="Search PlaSpool Admin"
            aria-label="Search"
            value={q}
            autoFocus
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHot((h) => Math.min(h + 1, Math.max(flat.length - 1, 0)));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHot((h) => Math.max(h - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const hit = flat[hot];
                if (hit) go(hit);
              }
            }}
          />
          <span className="palette__esc" aria-hidden="true">
            esc
          </span>
        </div>

        <div className="palette__chips" role="group" aria-label="Search scope">
          {SCOPES.map((s) => (
            <button
              key={s.value}
              type="button"
              className="palette__chip"
              aria-pressed={scope === s.value}
              onClick={() => setScope(s.value)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="palette__body" ref={listRef}>
          {flat.length === 0 ? (
            <div className="palette__empty">
              <span className="palette__glass" aria-hidden="true">
                <Search />
              </span>
              <span className="palette__hint">
                {loading ? 'Loading the store…' : q ? 'Nothing matches that' : 'Find anything in PlaSpool Admin'}
              </span>
              {!loading && q ? (
                <span className="alerts__body">
                  The palette covers pages, the latest products, orders, discounts and posts, and
                  a live customer search.
                </span>
              ) : null}
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.label}>
                <div className="palette__label">{group.label}</div>
                {group.hits.map((hit) => {
                  const index = flat.indexOf(hit);
                  return (
                    <button
                      key={hit.key}
                      type="button"
                      className={index === hot ? 'palette__row is-hot' : 'palette__row'}
                      onMouseEnter={() => setHot(index)}
                      onClick={() => go(hit)}
                    >
                      {hit.icon}
                      <span className="palette__rowtitle">{hit.title}</span>
                      {hit.meta ? <span className="palette__rowmeta">{hit.meta}</span> : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="palette__foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
          <span className="spacer" />
          <span>Pages, latest records &amp; live customer search</span>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { CornerDownRight, Package, Receipt, Search, TicketPercent } from 'lucide-react';
import { shopApi, type ShopOrderRow, type ShopProduct } from '../../data/api-shop';
import { discountsApi } from '../data/discounts';
import type { Discount } from '../../data/api-marketing';
import { humanise, money } from '../lib/format';
import { NAV, NAV_FOOT } from './nav';

/**
 * Ctrl+K — the application search.
 *
 * WHAT IT SEARCHES, HONESTLY: pages (the nav), and the FIRST PAGE of
 * products, orders and discounts, filtered client-side. `listProducts` has no
 * search parameter at all (the route's schema is `.strict()` and would 400
 * one), and `listOrders`' search is an exact-match lookup — so a palette that
 * claimed to search the whole store would be lying about both. The footer
 * names the scope. A store at PlaSpool's size fits in these pages for a long
 * time.
 *
 * TODO(v2): customers and blog posts are not in the palette yet, and true
 * store-wide search needs server-side search endpoints (products by title
 * prefix at least) — queued as backend work, per the session brief.
 */
type Scope = 'all' | 'pages' | 'products' | 'orders' | 'discounts';

interface Hit {
  key: string;
  group: 'Pages' | 'Products' | 'Orders' | 'Discounts';
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
];

const STALE_MS = 60_000;

interface Pool {
  products: ShopProduct[];
  orders: ShopOrderRow[];
  discounts: Discount[];
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
      ])
        .then(([products, orders, discounts]) => {
          fetchedAt.current = Date.now();
          setPool({ products: products.items, orders: orders.items, discounts });
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

    return result;
  }, [q, scope, pool]);

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
                  The palette covers pages plus the latest products, orders and discounts.
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
          <span>Pages, latest products, orders &amp; discounts</span>
        </div>
      </div>
    </div>
  );
}

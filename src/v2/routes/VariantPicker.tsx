import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { shopApi, type ShopProduct, type ShopProductDetail, type ShopVariant } from '../../data/api-shop';
import { money } from '../lib/format';
import { Float } from '../ui/Float';
import { lineLabel } from './manual-order-copy';

/**
 * PICK A PRODUCT — search-as-you-type over the catalogue, one row per variant:
 * "PLA Basic — Black · ₦28,000.00 · 12 in stock".
 *
 * THE SEARCH IS CLIENT-SIDE, BECAUSE THE ROUTE HAS NONE. `GET /admin/products`
 * is `.strict()` and takes no `search` (see `listProducts`), and the list rows
 * carry no variants or prices. So the picker reads the selling catalogue once
 * — the active products, then each one's variants — the first time the box is
 * focused, and filters that in memory as you type. The shop sells a handful of
 * products; if that ever grows past one page (100), this is the place to ask
 * the server for a search instead.
 *
 * The same variant may be picked twice on purpose — two lines of one colour
 * at two prices is a real sale.
 */

export interface PickedVariant {
  variantId: string;
  productTitle: string;
  sku: string;
  optionValues: Record<string, string>;
  /** The current price, or `null` for a variant that was never priced. */
  price: { amount: number; currency: string } | null;
  available: number | null;
}

interface Row extends PickedVariant {
  label: string;
  haystack: string;
}

/** At most this many rows in the panel — past it, keep typing. */
const SHOWN = 30;
/** Variant reads in flight at once, so a big catalogue does not stampede. */
const PARALLEL = 4;

function stockText(available: number | null): string {
  if (available === null) return 'Stock not tracked';
  return `${available} in stock`;
}

export function VariantPicker({
  onPick,
  error,
}: {
  onPick: (variant: PickedVariant) => void;
  error?: string | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [hot, setHot] = useState(0);
  const [products, setProducts] = useState<ShopProduct[] | null>(null);
  const [details, setDetails] = useState<Record<string, ShopProductDetail>>({});
  const [pending, setPending] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const started = useRef(false);
  const quiet = useRef(false);

  /* The catalogue, read once, on the first focus — not on mount, so a form
     that is opened to change a date never pays for it. */
  function start() {
    if (started.current) return;
    started.current = true;
    shopApi
      .listProducts({ status: 'active', limit: 100 })
      .then(async (page) => {
        setProducts(page.items);
        const queue = [...page.items];
        setPending(queue.length);
        const worker = async () => {
          for (let next = queue.shift(); next; next = queue.shift()) {
            try {
              const product = await shopApi.getProduct(next.id);
              setDetails((d) => ({ ...d, [product.id]: product }));
            } catch {
              /* One product that will not load is one product missing from
                 the list, not a picker that says nothing at all. */
            } finally {
              setPending((n) => n - 1);
            }
          }
        };
        await Promise.all(Array.from({ length: PARALLEL }, worker));
      })
      .catch((cause: unknown) => {
        started.current = false;
        setLoadError(
          cause instanceof Error && cause.message ? cause.message : 'Couldn’t load the products.',
        );
      });
  }

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const product of products ?? []) {
      const detail = details[product.id];
      if (!detail) continue;
      for (const v of detail.variants as ShopVariant[]) {
        if (v.status !== 'active') continue;
        const label = lineLabel({ title: detail.title, optionValues: v.optionValues });
        out.push({
          variantId: v.id,
          productTitle: detail.title,
          sku: v.sku,
          optionValues: v.optionValues,
          price: v.price,
          available: v.available,
          label,
          haystack: `${label} ${v.sku}`.toLowerCase(),
        });
      }
    }
    return out;
  }, [products, details]);

  const matches = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hit = tokens.length ? rows.filter((r) => tokens.every((t) => r.haystack.includes(t))) : rows;
    return hit.slice(0, SHOWN);
  }, [rows, query]);

  useEffect(() => setHot(0), [query]);

  function pick(row: Row) {
    onPick({
      variantId: row.variantId,
      productTitle: row.productTitle,
      sku: row.sku,
      optionValues: row.optionValues,
      price: row.price,
      available: row.available,
    });
    setQuery('');
    setOpen(false);
    /* Focus goes back to the box, ready for the next product — without the
       focus reopening the panel the pick just closed. */
    quiet.current = true;
    input.current?.focus();
    quiet.current = false;
  }

  const loading = products === null || pending > 0;

  return (
    <div className="field">
      <label className="sr" htmlFor="vpick-input">
        Search products
      </label>
      <div
        ref={box}
        className="tagin__box vpick__box"
        style={error ? { borderColor: 'var(--critical)' } : undefined}
        onClick={() => {
          input.current?.focus();
          start();
          setOpen(true);
        }}
      >
        <Search aria-hidden="true" className="vpick__icon" />
        <input
          ref={input}
          id="vpick-input"
          className="tagin__input"
          role="combobox"
          aria-expanded={open}
          aria-controls="vpick-list"
          aria-autocomplete="list"
          autoComplete="off"
          placeholder="Search products to add"
          value={query}
          onFocus={() => {
            start();
            if (!quiet.current) setOpen(true);
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setHot((h) => Math.min(h + 1, Math.max(matches.length - 1, 0)));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHot((h) => Math.max(h - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const row = matches[hot];
              if (open && row) pick(row);
            }
          }}
        />
      </div>
      {error ? <span className="field__error">{error}</span> : null}
      <Float
        open={open}
        anchor={box}
        align="left"
        className="tagin__pop vpick__pop"
        onClose={() => setOpen(false)}
      >
        <div id="vpick-list" role="listbox" aria-label="Products">
          {loadError ? (
            <div className="sselect__empty">{loadError}</div>
          ) : matches.length === 0 ? (
            <div className="sselect__empty">
              {loading ? 'Loading products…' : query ? 'No product matches that.' : 'No products for sale yet.'}
            </div>
          ) : (
            matches.map((row, i) => (
              <button
                key={row.variantId}
                type="button"
                role="option"
                aria-selected={i === hot}
                className={i === hot ? 'tagin__opt is-hot' : 'tagin__opt'}
                onMouseEnter={() => setHot(i)}
                onClick={() => pick(row)}
              >
                <span className="vpick__name">{row.label}</span>
                <span className="vpick__meta">
                  {row.sku ? `${row.sku} · ` : ''}
                  {row.price ? money(row.price.amount, row.price.currency) : 'No price'} ·{' '}
                  {stockText(row.available)}
                </span>
              </button>
            ))
          )}
          {!loadError && loading && matches.length > 0 ? (
            <div className="vpick__more">Loading more products…</div>
          ) : null}
        </div>
      </Float>
    </div>
  );
}

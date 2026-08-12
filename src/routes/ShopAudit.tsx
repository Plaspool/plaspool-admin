import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, History, Tag } from 'lucide-react';
import {
  shopApi,
  formatMinor,
  type AuditEntry,
  type AuditKind,
} from '../data/api-shop';
import { ApiError, NotFoundError, OfflineError } from '../data/errors';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Feedback';
import { useDelayed } from '../components/ui/useDelayed';
import './shop.css';

/**
 * Everything that has changed in the catalogue, newest first.
 *
 * THE QUESTION IT ANSWERS is "why is this number what it is" — asked in front
 * of a stock count that looks wrong, or a price a customer is querying. So the
 * row leads with the DIFFERENCE rather than the value: `18,500 → 22,000` and
 * `+12 → 47`, because the current figure is already on the product page and the
 * thing that is nowhere else is what it was before.
 *
 * NOTHING HERE IS EDITABLE, and there is no control that looks like it might
 * be. An audit trail with a Save button beside it is a record somebody can
 * quietly rewrite.
 */

const WHEN = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
});

const DAY = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const KINDS: { value: AuditKind | 'all'; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'stock', label: 'Stock only' },
  { value: 'price', label: 'Prices only' },
];

function readKind(params: URLSearchParams): AuditKind | 'all' {
  const raw = params.get('kind');
  return KINDS.some((k) => k.value === raw) ? (raw as AuditKind | 'all') : 'all';
}

/** Midnight-to-midnight, so entries group under the day they happened. */
const dayKey = (ms: number): string => new Date(ms).toDateString();

function explain(err: unknown): string {
  if (err instanceof OfflineError) return 'The request didn’t reach the server.';
  if (err instanceof NotFoundError) return 'This deployment has no history route yet.';
  if (err instanceof ApiError && err.status === 403) {
    return 'Your account isn’t allowed to read this.';
  }
  return 'The history didn’t load.';
}

export default function ShopAudit() {
  const [params, setParams] = useSearchParams();
  const kind = readKind(params);
  const variantId = params.get('variant') ?? '';
  const productId = params.get('product') ?? '';

  const [items, setItems] = useState<AuditEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const showSkeletons = useDelayed(loading);

  const load = useCallback(
    async (signal?: AbortSignal, after?: string) => {
      setLoading(true);
      setProblem(null);
      try {
        const page = await shopApi.listAudit(
          {
            ...(kind === 'all' ? {} : { kind }),
            ...(variantId ? { variantId } : {}),
            ...(productId ? { productId } : {}),
            ...(after ? { cursor: after } : {}),
            limit: 50,
          },
          signal,
        );
        if (signal?.aborted) return;
        // Appending rather than replacing: "Show more" is reading further back
        // through one list, not turning to a page that replaces what you were
        // half-way through reading.
        setItems((prev) => (after ? [...(prev ?? []), ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch (err) {
        if (signal?.aborted) return;
        setProblem(explain(err));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [kind, variantId, productId],
  );

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const scoped = variantId || productId;

  return (
    <div className="shopscr">
      <header className="shopscr__head">
        <div className="shopscr__headrow">
          <div>
            <h1 className="shopscr__title">History</h1>
            <p className="shopscr__lede">
              Every stock and price change, newest first, with who made it and
              why. Nothing here can be edited — a record with a Save button
              beside it is a record somebody can quietly rewrite.
            </p>
          </div>
        </div>
      </header>

      <div className="shopscr__body">
        <div className="shopfilters">
          <Select
            label="What to show"
            value={kind}
            onChange={(v) =>
              setParams((prev) => {
                const next = new URLSearchParams(prev);
                if (v === 'all') next.delete('kind');
                else next.set('kind', v);
                return next;
              })
            }
            options={KINDS.map((k) => ({ value: k.value, label: k.label }))}
          />
          {scoped && (
            <button
              className="btn btn--ghost btn--sm"
              onClick={() =>
                setParams((prev) => {
                  const next = new URLSearchParams(prev);
                  next.delete('variant');
                  next.delete('product');
                  return next;
                })
              }
            >
              Showing one {variantId ? 'variant' : 'product'} — show the whole shop
            </button>
          )}
        </div>

        {problem && (
          <div className="notice notice--danger" role="alert">
            <div>
              <strong>Nothing to show.</strong> {problem}
            </div>
            <div className="notice__actions">
              <button className="btn btn--outline btn--sm" onClick={() => void load()}>
                Try again
              </button>
            </div>
          </div>
        )}

        {items === null && showSkeletons && (
          <div className="auditlist">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} />
            ))}
          </div>
        )}

        {items !== null && items.length === 0 && !problem && (
          <div className="empty">
            <History className="empty__icon" aria-hidden="true" />
            <h2 className="empty__title">Nothing has changed yet</h2>
            <p className="empty__note">
              Stock adjustments and price changes appear here as soon as they
              happen, each with the reason given at the time.
            </p>
          </div>
        )}

        {items !== null && items.length > 0 && (
          <>
            <ol className="auditlist">
              {items.map((entry, i) => (
                <AuditRow
                  key={entry.id}
                  entry={entry}
                  // The day heading is drawn by the FIRST entry of each day, so
                  // the list stays one flat <ol> — grouping into nested lists
                  // would break the reading order a screen reader announces.
                  startsDay={i === 0 || dayKey(items[i - 1].occurredAt) !== dayKey(entry.occurredAt)}
                />
              ))}
            </ol>

            {cursor && (
              <div className="pager">
                <button
                  className="btn btn--outline btn--sm"
                  disabled={loading}
                  onClick={() => void load(undefined, cursor)}
                >
                  {loading ? 'Loading…' : 'Show earlier changes'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AuditRow({ entry, startsDay }: { entry: AuditEntry; startsDay: boolean }) {
  const options = Object.entries(entry.optionValues ?? {})
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');

  return (
    <>
      {startsDay && (
        <li className="auditday" aria-hidden="true">
          {DAY.format(new Date(entry.occurredAt))}
        </li>
      )}
      <li className={`auditrow auditrow--${entry.kind}`}>
        <span className="auditrow__icon" aria-hidden="true">
          {entry.kind === 'price' ? (
            <Tag className="ui-ic" />
          ) : (entry.delta ?? 0) >= 0 ? (
            <ArrowUp className="ui-ic" />
          ) : (
            <ArrowDown className="ui-ic" />
          )}
        </span>

        <span className="auditrow__body">
          <span className="auditrow__what">
            {entry.kind === 'price' ? (
              <PriceChange entry={entry} />
            ) : (
              <StockChange entry={entry} />
            )}
          </span>

          <span className="auditrow__where">
            {entry.productTitle ?? 'A deleted product'}
            {options && <> · {options}</>}
            {entry.sku && <span className="auditrow__sku"> {entry.sku}</span>}
          </span>

          <span className="auditrow__why">
            {/*
              "No reason recorded" is TRUE and an empty space is not. Every
              price written before migration 0009 has none, and a price change
              may still decline to say — so the absence is stated rather than
              rendered as a gap that reads like a loading bug.
            */}
            {entry.reason ?? <em>No reason recorded</em>}
            {entry.actor && <> — {entry.actor}</>}
          </span>
        </span>

        <time className="auditrow__when" dateTime={new Date(entry.occurredAt).toISOString()}>
          {WHEN.format(new Date(entry.occurredAt))}
        </time>
      </li>
    </>
  );
}

function PriceChange({ entry }: { entry: AuditEntry }) {
  const currency = entry.currency ?? 'NGN';
  const now = entry.amount == null ? '—' : formatMinor(entry.amount, currency);
  if (entry.previousAmount == null) {
    return (
      <>
        Priced at <strong>{now}</strong> <span className="auditrow__note">first price</span>
      </>
    );
  }
  const was = formatMinor(entry.previousAmount, currency);
  const up = (entry.amount ?? 0) > entry.previousAmount;
  return (
    <>
      Price <span className="auditrow__was">{was}</span>
      <span className="auditrow__arrow" aria-label="changed to">
        →
      </span>
      <strong>{now}</strong>{' '}
      <span className={`auditrow__note auditrow__note--${up ? 'up' : 'down'}`}>
        {up ? 'increase' : 'decrease'}
      </span>
    </>
  );
}

function StockChange({ entry }: { entry: AuditEntry }) {
  const delta = entry.delta ?? 0;
  return (
    <>
      Stock{' '}
      <strong className={delta >= 0 ? 'auditrow__up' : 'auditrow__down'}>
        {delta > 0 ? `+${delta}` : delta}
      </strong>
      {entry.onHand != null && (
        <>
          <span className="auditrow__arrow" aria-label="leaving">
            →
          </span>
          <strong>{entry.onHand}</strong> <span className="auditrow__note">on hand</span>
        </>
      )}
    </>
  );
}

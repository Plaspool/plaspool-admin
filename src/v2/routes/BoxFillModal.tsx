import { useEffect, useMemo, useRef, useState } from 'react';
import {
  shopApi,
  type ShopBoxFill,
  type ShopBoxRefusal,
  type ShopOrderLine,
  type ShopPoolItem,
} from '../../data/api-shop';
import { ApiError } from '../../data/errors';
import { Modal } from '../ui/Modal';
import { Badge, Button } from '../ui/primitives';
import { BoxSlots } from '../ui/BoxSlots';
import { useToast } from '../ui/Toast';
import { VariantPicker } from './VariantPicker';

interface Picked {
  variantId: string;
  title: string;
  colorHex: string | null;
}

/**
 * Fill one mystery box, or change what is in it (migration 1220).
 *
 * The pool comes first, because that is what the box promises. Anything else
 * in stock can still be picked below it: someone at the bench with no PETG left
 * must be able to substitute. Saving takes the items out of stock in one step,
 * or saves nothing at all if one of them has just run out.
 */
export function BoxFillModal({
  orderId,
  line,
  boxNo,
  poolTag,
  itemCount,
  existing,
  onClose,
  onDone,
}: {
  orderId: string;
  line: ShopOrderLine;
  boxNo: number;
  poolTag: string | null;
  itemCount: number;
  existing: ShopBoxFill | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [pool, setPool] = useState<ShopPoolItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked[]>(
    () => existing?.items.map((i) => ({ variantId: i.variantId, title: i.title, colorHex: null })) ?? [],
  );
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!poolTag) {
      setPool([]);
      return;
    }
    const controller = new AbortController();
    shopApi.boxPool(poolTag, controller.signal).then(
      (p) => setPool(p.items),
      (cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setLoadError('Couldn’t load the pool. Close this and try again.');
      },
    );
    return () => controller.abort();
  }, [poolTag]);

  const full = picked.length >= itemCount;
  /* What is left of an item once this box's own picks are counted. When
     CHANGING a box, its current items are still out of stock, so they count
     back in. */
  const left = (item: ShopPoolItem) =>
    item.available +
    (existing?.items.filter((i) => i.variantId === item.variantId).length ?? 0) -
    picked.filter((p) => p.variantId === item.variantId).length;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (pool ?? []).filter((i) => !q || i.productTitle.toLowerCase().includes(q));
  }, [pool, query]);

  function add(next: Picked) {
    if (full) return;
    const all = [...picked, next];
    setPicked(all);
    setError(null);
    /* Keep focus where the hand is: the same row, or Save once the box is full. */
    requestAnimationFrame(() => {
      const target =
        all.length >= itemCount
          ? document.querySelector<HTMLButtonElement>('[data-box-save]')
          : listRef.current?.querySelector<HTMLButtonElement>(`[data-variant="${next.variantId}"]`);
      target?.focus();
    });
  }

  async function save() {
    if (!full || busy) return;
    setBusy(true);
    try {
      await shopApi.saveBoxFill(orderId, line.id, boxNo, {
        variantIds: picked.map((p) => p.variantId),
        expectedFilledAt: existing?.filledAt ?? null,
      });
      toast.show(existing ? `Box ${boxNo} changed` : `Box ${boxNo} filled`);
      onDone();
    } catch (cause) {
      const body = cause instanceof ApiError ? (cause.body as Partial<ShopBoxRefusal> | undefined) : undefined;
      if (body?.error === 'box_refused' && body.reason === 'box_short') {
        const names = body.short?.length ? body.short.join(', ') : 'An item';
        setError(`${names} just ran out. Nothing was saved; pick something else.`);
      } else if (body?.error === 'box_refused' && body.reason === 'box_changed') {
        setError('Someone else changed this box. Close this to see what is in it now.');
      } else if (body?.error === 'box_refused' && body.reason === 'box_in_parcel') {
        setError('This box is already in a parcel, so it can’t be changed.');
      } else {
        setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      }
      setBusy(false);
    }
  }

  const repeat = new Set(picked.map((p) => p.variantId)).size < picked.length;
  const option = Object.values(line.optionValues).join(' · ');

  return (
    <Modal
      title={`${existing ? 'Change' : 'Fill'} box ${boxNo} of ${line.qty}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            tone="primary"
            busy={busy}
            disabled={!full}
            data-box-save=""
            onClick={() => void save()}
          >
            Save contents
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="row" style={{ justifyContent: 'space-between', gap: 'var(--s3)' }}>
          <span className="muted" style={{ fontSize: 'var(--t-md)' }}>
            {line.title}
            {option ? ` · ${option}` : ''}
            {poolTag ? (
              <>
                , from the <span className="tag">{poolTag}</span> pool
              </>
            ) : null}
          </span>
          <Badge tone={full ? 'ok' : 'neutral'}>
            <span aria-live="polite">
              {picked.length} of {itemCount}
            </span>
          </Badge>
        </div>

        <BoxSlots
          count={itemCount}
          label="Box contents"
          items={picked.map((p) => ({ key: p.variantId, title: p.title, colorHex: p.colorHex }))}
          onRemove={(i) => {
            setPicked(picked.filter((_, n) => n !== i));
            search.current?.focus();
          }}
        />

        <label className="field">
          <span className="field__label">Add from the pool</span>
          <input
            ref={search}
            className="input"
            value={query}
            placeholder="Search the pool"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>

        {loadError ? (
          <span className="field__error" role="alert">
            {loadError}
          </span>
        ) : pool === null ? (
          <p className="muted">Loading the pool…</p>
        ) : shown.length === 0 ? (
          <p className="muted">
            {poolTag
              ? `Nothing tagged ${poolTag} is in stock. Pick something below instead.`
              : 'This box has no pool. Pick something below.'}
          </p>
        ) : (
          <ul ref={listRef} className="pool-list" aria-label="Pool items">
            {shown.map((item) => {
              const n = left(item);
              return (
                <li key={item.variantId}>
                  <button
                    type="button"
                    data-variant={item.variantId}
                    aria-disabled={full || n <= 0}
                    onClick={() => {
                      if (full || n <= 0) return;
                      add({ variantId: item.variantId, title: item.productTitle, colorHex: item.colorHex });
                    }}
                  >
                    <span
                      className="slot__swatch"
                      style={{ background: item.colorHex ?? 'var(--surface-sunken)' }}
                      aria-hidden="true"
                    />
                    <span>
                      {item.productTitle}
                      {Object.keys(item.optionValues).length ? (
                        <span className="muted"> · {Object.values(item.optionValues).join(' · ')}</span>
                      ) : null}
                    </span>
                    <Badge tone={n === 1 ? 'warn' : 'neutral'}>{n <= 0 ? 'None left' : `${n} in stock`}</Badge>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <details>
          <summary className="muted" style={{ cursor: 'pointer', fontSize: 'var(--t-md)' }}>
            Pick something outside the pool
          </summary>
          <div style={{ marginTop: 'var(--s2)' }}>
            <VariantPicker
              onPick={(v) =>
                add({
                  variantId: v.variantId,
                  title: [v.productTitle, ...Object.values(v.optionValues)].join(' · '),
                  colorHex: null,
                })
              }
            />
          </div>
        </details>

        <p className="field__hint" aria-live="polite">
          {full
            ? repeat
              ? 'Full. This box has the same item twice, which is allowed.'
              : 'Full. Saving takes these out of stock.'
            : `${itemCount - picked.length} more to add.`}
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

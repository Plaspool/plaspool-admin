import { useEffect, useMemo, useRef, useState } from 'react';
import {
  shopApi,
  type ShopBoxFill,
  type ShopBoxRefusal,
  type ShopMysteryBoxItem,
  type ShopOrderLine,
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

/** Filling a box on an order, or building one ahead of any sale (migration 1240). */
export type BoxFillTarget =
  | { kind: 'order'; orderId: string; line: ShopOrderLine; boxNo: number; existing: ShopBoxFill | null }
  | { kind: 'build'; sizeVariantId: string; sizeLabel: string };

/**
 * Pack a mystery box: on a paid order, or on the shelf ahead of a sale.
 *
 * The Settings tick list comes first (and the backup list after it), because
 * that is what the box promises. Anything else in stock can still be picked
 * below: someone at the bench with nothing left on the list must be able to
 * substitute. Saving takes the items out of stock in one step, or saves nothing
 * at all if one of them has just run out.
 */
export function BoxFillModal({
  target,
  itemCount,
  onClose,
  onDone,
}: {
  target: BoxFillTarget;
  itemCount: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const existing = target.kind === 'order' ? target.existing : null;
  const [pool, setPool] = useState<ShopMysteryBoxItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked[]>(
    () => existing?.items.map((i) => ({ variantId: i.variantId, title: i.title, colorHex: null })) ?? [],
  );
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    shopApi.getMysteryBox(controller.signal).then(
      (box) => setPool(box.items.filter((i) => i.usable)),
      (cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setLoadError('Couldn’t load the mystery box list. Close this and try again.');
      },
    );
    return () => controller.abort();
  }, []);

  const full = picked.length >= itemCount;
  /* What is left of an item once this box's own picks are counted. When
     CHANGING a box, its current items are still out of stock, so they count
     back in. */
  const left = (item: ShopMysteryBoxItem) =>
    item.available +
    (existing?.items.filter((i) => i.variantId === item.variantId).length ?? 0) -
    picked.filter((p) => p.variantId === item.variantId).length;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (i: ShopMysteryBoxItem) =>
      !q || `${i.productTitle} ${Object.values(i.optionValues).join(' ')}`.toLowerCase().includes(q);
    return {
      main: (pool ?? []).filter((i) => i.list === 'main' && match(i)),
      backup: (pool ?? []).filter((i) => i.list === 'backup' && match(i)),
    };
  }, [pool, query]);

  const label = (i: { productTitle: string; optionValues: Record<string, string> }) =>
    [i.productTitle, ...Object.values(i.optionValues)].join(' · ');

  function add(next: Picked) {
    if (full) return;
    const all = [...picked, next];
    setPicked(all);
    setError(null);
    /* Keep focus where the hand is: the same row, or Save once the box is full. */
    requestAnimationFrame(() => {
      const el =
        all.length >= itemCount
          ? document.querySelector<HTMLButtonElement>('[data-box-save]')
          : listRef.current?.querySelector<HTMLButtonElement>(`[data-variant="${next.variantId}"]`);
      el?.focus();
    });
  }

  async function save() {
    if (!full || busy) return;
    setBusy(true);
    try {
      if (target.kind === 'order') {
        await shopApi.saveBoxFill(target.orderId, target.line.id, target.boxNo, {
          variantIds: picked.map((p) => p.variantId),
          expectedFilledAt: existing?.filledAt ?? null,
        });
        toast.show(existing ? `Box ${target.boxNo} changed` : `Box ${target.boxNo} filled`);
      } else {
        await shopApi.buildMysteryBox(target.sizeVariantId, picked.map((p) => p.variantId));
        toast.show(`${target.sizeLabel} box built`);
      }
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
  const title =
    target.kind === 'order'
      ? `${existing ? 'Change' : 'Fill'} box ${target.boxNo} of ${target.line.qty}`
      : `Build a box: ${target.sizeLabel}`;

  const renderList = (items: ShopMysteryBoxItem[], name: string) => (
    <ul className="pool-list" aria-label={name}>
      {items.map((item) => {
        const n = left(item);
        return (
          <li key={`${item.list}-${item.variantId}`}>
            <button
              type="button"
              data-variant={item.variantId}
              aria-disabled={full || n <= 0}
              onClick={() => {
                if (full || n <= 0) return;
                add({ variantId: item.variantId, title: label(item), colorHex: item.colorHex });
              }}
            >
              <span
                className="slot__swatch"
                style={{ background: item.colorHex ?? 'var(--surface-sunken)' }}
                aria-hidden="true"
              />
              <span>{label(item)}</span>
              <Badge tone={n === 1 ? 'warn' : 'neutral'}>{n <= 0 ? 'None left' : `${n} in stock`}</Badge>
            </button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} disabled={!full} data-box-save="" onClick={() => void save()}>
            Save contents
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="row" style={{ justifyContent: 'space-between', gap: 'var(--s3)' }}>
          <span className="muted" style={{ fontSize: 'var(--t-md)' }}>
            {target.kind === 'order'
              ? [target.line.title, ...Object.values(target.line.optionValues)].join(' · ')
              : 'Packed now and kept on the shelf until one sells.'}
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
          <span className="field__label">Add from the mystery box list</span>
          <input
            ref={search}
            className="input"
            value={query}
            placeholder="Search the list"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>

        <div ref={listRef} className="stack stack--tight">
          {loadError ? (
            <span className="field__error" role="alert">
              {loadError}
            </span>
          ) : pool === null ? (
            <p className="muted">Loading the list…</p>
          ) : shown.main.length === 0 && shown.backup.length === 0 ? (
            <p className="muted">
              Nothing on the mystery box list is in stock. Pick something below, or add items in
              Settings → Mystery box.
            </p>
          ) : (
            <>
              {shown.main.length > 0 ? renderList(shown.main, 'Mystery box list') : null}
              {shown.backup.length > 0 ? (
                <>
                  <span className="field__label">Backup items</span>
                  {renderList(shown.backup, 'Backup items')}
                </>
              ) : null}
            </>
          )}
        </div>

        <details>
          <summary className="muted" style={{ cursor: 'pointer', fontSize: 'var(--t-md)' }}>
            Pick something not on the list
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

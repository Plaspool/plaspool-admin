import { useState } from 'react';
import { shopApi } from '../../data/api-shop';
import { TextField } from '../ui/Field';
import { Stepper } from '../ui/Stepper';
import { PopEdit, PopEditFoot } from '../ui/PopEdit';
import { Button } from '../ui/primitives';
import { useToast } from '../ui/Toast';

/**
 * THE STOCK ADJUSTER — a variant's Available figure as an editable cell, whose
 * panel moves the count. The Stock screen (`Inventory.tsx`) and the product
 * page's variant table (`ProductDetail.tsx`) both render THIS.
 *
 * ONE COMPONENT BECAUSE TWO COPIES DRIFTED. Each screen used to carry its own
 * near-identical panel. When the owner made every reason optional (2026-09-03,
 * PR #103) only the Stock screen's copy changed, and the product page's kept
 * refusing a blank reason until the owner met it on 2026-09-15 (PR #158). A
 * change to how stock is adjusted belongs here, and both screens get it.
 *
 * YOU SET THE COUNT, YOU DO NOT TYPE A DELTA (the owner's ask, 2026-09-19).
 * The panel used to take "+5 or -2" in a box, which made the operator do the
 * arithmetic: to make a shelf of 8 read 12 you had to work out 4. Now the
 * number shown IS the Available figure, the buttons either side move it, and
 * the delta is worked out here on the way to the wire.
 *
 * THE WIRE DID NOT MOVE. `adjustInventory` still takes a DELTA, and the stock
 * ledger still records one — which is right: "+4, delivery arrived" is the fact
 * worth keeping, and an absolute target would lose it.
 *
 * WHAT THIS COSTS, ACCEPTED BY THE OWNER ON THE SAME DAY. A delta is immune to
 * staleness — "+4" is +4 whenever it lands. A target is not: the server moves
 * `on_hand` while the cell shows `available` (`available = on_hand - reserved`),
 * so a checkout that freezes a cart between this panel opening and Adjust being
 * pressed moves `reserved`, and the count settles a unit or two off what was
 * typed. The window is seconds on a single-operator admin, and the toast
 * reports the SERVER'S resulting figure rather than a locally computed one, so
 * a surprise is visible immediately rather than believed.
 *
 * PLAIN FIELDS, NOT A ROW TYPE. The Stock screen holds an `InventoryRow` and the
 * product page a `ShopVariant`; they name the id differently and disagree on
 * whether `available` can be missing, so each caller spells out the five facts.
 *
 * Top-level, never nested in a screen — a component defined inside another gets
 * a fresh identity per parent render.
 */
export function StockCell({
  variantId,
  sku,
  available,
  backorderable,
  onWrite,
}: {
  variantId: string;
  sku: string;
  /** `null` when the variant has no stock row yet. The product page can show
   *  such a variant; the Stock screen lists stock rows, so it never passes one. */
  available: number | null;
  backorderable: boolean;
  /** After a successful adjustment, so the screen re-reads what the server holds. */
  onWrite: () => void;
}) {
  return (
    <PopEdit
      ariaLabel={`Adjust stock of ${sku}`}
      value={
        available === null ? (
          <span className="muted">No stock row</span>
        ) : (
          <span className="num" style={available < 0 ? { color: 'var(--critical)' } : undefined}>
            {available}
          </span>
        )
      }
    >
      {(close) => (
        <StockPanel
          variantId={variantId}
          sku={sku}
          available={available}
          backorderable={backorderable}
          close={close}
          onWrite={onWrite}
        />
      )}
    </PopEdit>
  );
}

/**
 * The panel's body, a component of its own SO THAT THE DRAFT IS SEEDED FROM THE
 * LIVE COUNT EVERY TIME IT OPENS. `Float` returns null while closed, so this
 * mounts fresh on each open and `useState` runs again — which a draft held up
 * in `StockCell` could not do, and which matters far more now the box starts at
 * a real figure than it did when it started empty: a stale 12 left over from a
 * cancelled edit is indistinguishable from the count itself.
 */
function StockPanel({
  variantId,
  sku,
  available,
  backorderable,
  close,
  onWrite,
}: {
  variantId: string;
  sku: string;
  available: number | null;
  backorderable: boolean;
  close: () => void;
  onWrite: () => void;
}) {
  const toast = useToast();
  const base = available ?? 0;
  const [target, setTarget] = useState(String(base));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parsed = Number(target);
  const targetOk = target.trim() !== '' && Number.isInteger(parsed);
  const delta = targetOk ? parsed - base : 0;

  async function commit() {
    if (!targetOk) {
      setError('Enter a whole number.');
      return;
    }
    if (delta === 0) {
      setError(`Already ${base}. Change the number to adjust it.`);
      return;
    }
    setBusy(true);
    try {
      /* NO REASON GUARD. It is optional since 2026-09-03 (owner's instruction);
       * the placeholder still asks, and `adjustInventory` omits the key rather
       * than sending an empty string, which the route refuses. */
      const res = await shopApi.adjustInventory(variantId, delta, reason.trim());
      toast.show(`${sku} — ${res.available} available`);
      close();
      onWrite();
    } catch (cause) {
      /* The plain message both copies showed. The product page's helper added
       * only a 422 about descriptions, which this route never sends — it
       * answers 400 (including a write-off larger than the stock on hand),
       * 401, 403 or 404. */
      setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Stepper
        label="Set available to"
        inputLabel={`Available for ${sku}`}
        decrementLabel={`One fewer ${sku}`}
        incrementLabel={`One more ${sku}`}
        value={target}
        /* The floor is the Available column's ordinary domain. A variant that
         * can be back-ordered is allowed below it — and one already oversold
         * keeps whatever figure it has, because the clamp only applies to a
         * step and never rewrites what the box was seeded with. */
        min={backorderable ? undefined : 0}
        fallback={base}
        autoFocus
        hint={
          available === null
            ? 'This variant has no stock row yet.'
            : delta !== 0
              ? /* The arithmetic, not the word for it (CLAUDE.md §7). */
                `Was ${base} · ${delta > 0 ? `adding ${delta}` : `removing ${-delta}`}`
              : backorderable
                ? 'Can be back-ordered, so stock is allowed to go below zero.'
                : undefined
        }
        onChange={(next) => {
          setTarget(next);
          setError(null);
        }}
      />
      <TextField
        label="Reason (optional)"
        value={reason}
        placeholder="Stock count, damage, correction…"
        hint="Kept on record. Worth a few words if you have them."
        error={error}
        onChange={(e) => {
          setReason(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit();
        }}
      />
      <PopEditFoot>
        <Button tone="plain" onClick={close}>
          Cancel
        </Button>
        <Button tone="primary" busy={busy} onClick={() => void commit()}>
          Adjust
        </Button>
      </PopEditFoot>
    </>
  );
}

import { useState } from 'react';
import { shopApi } from '../../data/api-shop';
import { TextField } from '../ui/Field';
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
 * PLAIN FIELDS, NOT A ROW TYPE. The Stock screen holds an `InventoryRow` and the
 * product page a `ShopVariant`; they name the id differently and disagree on
 * whether `available` can be missing, so each caller spells out the five facts.
 *
 * Top-level, never nested in a screen — a component defined inside another gets
 * a fresh identity per parent render, and this one holds an open panel's draft.
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
  const toast = useToast();
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parsed = Number(delta);
  const deltaOk = delta.trim() !== '' && Number.isInteger(parsed) && parsed !== 0;

  async function commit(close: () => void) {
    if (!deltaOk) {
      setError('Enter a whole number, above or below zero — but not zero.');
      return;
    }
    setBusy(true);
    try {
      /* NO REASON GUARD. It is optional since 2026-09-03 (owner's instruction);
       * the placeholder still asks, and `adjustInventory` omits the key rather
       * than sending an empty string, which the route refuses. */
      const res = await shopApi.adjustInventory(variantId, parsed, reason.trim());
      toast.show(`${sku} — ${res.available} available`);
      close();
      /* The draft is cleared HERE, not left to the parent. The Stock screen's
       * table happens to remount its rows while it reloads, and the product page
       * keys this cell by the live figure, but neither is this cell's contract. */
      setDelta('');
      setReason('');
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
        <>
          <TextField
            label="Adjust by"
            type="number"
            step={1}
            placeholder="+5 or -2"
            value={delta}
            autoFocus
            hint={
              available !== null && deltaOk
                ? `Available ${available} → ${available + parsed}`
                : backorderable
                  ? 'Can be back-ordered, so stock is allowed to go below zero.'
                  : undefined
            }
            onChange={(e) => {
              setDelta(e.target.value);
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
              if (e.key === 'Enter') void commit(close);
            }}
          />
          <PopEditFoot>
            <Button tone="plain" onClick={close}>
              Cancel
            </Button>
            <Button tone="primary" busy={busy} onClick={() => void commit(close)}>
              Adjust
            </Button>
          </PopEditFoot>
        </>
      )}
    </PopEdit>
  );
}

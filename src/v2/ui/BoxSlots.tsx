import { X } from 'lucide-react';

export interface BoxSlotItem {
  key: string;
  title: string;
  colorHex?: string | null;
}

/**
 * The box on the bench (mystery boxes, migration 1220). "2 of 3" is a number;
 * three wells with two spools in them is where the gap is.
 *
 * Each slot is a labelled group, so a screen reader hears "Slot 2: PLA Basic
 * Red 1kg" or "Slot 3: empty". The remove button is 24px drawn with a 44px hit
 * area from `.slot__x::after`. Where focus goes after a removal is the CALLER's
 * decision, because it knows where the pool search is.
 */
export function BoxSlots({
  count,
  items,
  onRemove,
  label,
}: {
  count: number;
  items: BoxSlotItem[];
  onRemove: (index: number) => void;
  label: string;
}) {
  return (
    <div
      className="slots"
      role="group"
      aria-label={label}
      style={{ ['--slots' as string]: String(Math.min(Math.max(count, 1), 3)) }}
    >
      {Array.from({ length: count }, (_, i) => {
        const item = items[i];
        return item ? (
          <div key={`${item.key}-${i}`} className="slot slot--full" role="group" aria-label={`Slot ${i + 1}: ${item.title}`}>
            {item.colorHex ? (
              <span className="slot__swatch" style={{ background: item.colorHex }} aria-hidden="true" />
            ) : null}
            <span className="slot__title">{item.title}</span>
            <button
              type="button"
              className="slot__x"
              aria-label={`Remove ${item.title} from slot ${i + 1}`}
              onClick={() => onRemove(i)}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        ) : (
          <div key={`empty-${i}`} className="slot" role="group" aria-label={`Slot ${i + 1}: empty`}>
            Empty
          </div>
        );
      })}
    </div>
  );
}

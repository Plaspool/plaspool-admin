import { useRef, useState, type ReactNode } from 'react';
import { Float } from './Float';

/**
 * The inline cell editor. The value in the table renders as a quiet button —
 * a dashed underline is its whole affordance — and clicking it opens an
 * anchored panel carrying the real form.
 *
 * A panel rather than an in-place input, deliberately: the two writes this
 * exists for are money and stock, and both carry a REASON field (`shop_prices`
 * records why a price moved; `adjustInventory` refuses a change without one).
 * An inline input has nowhere to put the reason, which is how "quick edit"
 * designs end up padding `reason: 'edit'` into an audit trail.
 *
 * The panel rides `Float`: it lives in table cells and in the phone's
 * details sheet, which are exactly the two clipping ancestors (`.tscroll`,
 * `.modal__body`) the shared mechanism exists to escape. Float also stops
 * clicks reaching the clickable row behind it, and its capture-phase Escape
 * closes the editor without taking a surrounding modal down with it.
 */
export function PopEdit({
  value,
  ariaLabel,
  align = 'right',
  disabled = false,
  children,
}: {
  /** What the cell shows at rest. */
  value: ReactNode;
  ariaLabel: string;
  align?: 'left' | 'right';
  disabled?: boolean;
  /** The panel's content. Call `close` after a successful save. */
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  if (disabled) return <>{value}</>;

  return (
    /* The trigger's own click must never reach a clickable table row —
       stopping propagation here is what lets the editor live in a row that
       navigates. (Float does the same for the panel.) */
    <span className="popedit" onClick={(e) => e.stopPropagation()}>
      <button
        ref={trigger}
        type="button"
        className={open ? 'cellbtn is-open' : 'cellbtn'}
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {value}
      </button>
      <Float
        open={open}
        anchor={trigger}
        align={align}
        className="popedit__panel"
        role="dialog"
        ariaLabel={ariaLabel}
        onClose={(opts) => {
          setOpen(false);
          if (opts?.refocus) trigger.current?.focus();
        }}
      >
        {children(() => setOpen(false))}
      </Float>
    </span>
  );
}

/** The Cancel / confirm row at the foot of a PopEdit panel. */
export function PopEditFoot({ children }: { children: ReactNode }) {
  return <div className="popedit__foot">{children}</div>;
}

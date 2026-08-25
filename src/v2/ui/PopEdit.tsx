import { useEffect, useRef, useState, type ReactNode } from 'react';

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
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(event: PointerEvent) {
      if (root.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (disabled) return <>{value}</>;

  return (
    /* Clicks inside must never reach a clickable table row behind this —
       stopping propagation here is what lets the editor live in a row that
       navigates. */
    <span className="popedit" ref={root} onClick={(e) => e.stopPropagation()}>
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
      {open ? (
        <div
          className={align === 'left' ? 'popedit__panel popedit__panel--left' : 'popedit__panel'}
          role="dialog"
          aria-label={ariaLabel}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </span>
  );
}

/** The Cancel / confirm row at the foot of a PopEdit panel. */
export function PopEditFoot({ children }: { children: ReactNode }) {
  return <div className="popedit__foot">{children}</div>;
}

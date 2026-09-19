import { type InputHTMLAttributes, type ReactNode } from 'react';
import { Minus, Plus } from 'lucide-react';
import { useFieldIds } from './Field';
import { Button } from './primitives';

/**
 * A NUMBER WITH A BUTTON EITHER SIDE — the shape three screens had each
 * hand-rolled before this file existed: manual orders' line quantity, mystery
 * box's items-per-box, and the stock panel's Available figure.
 *
 * ONE COMPONENT BECAUSE TWO COPIES ALREADY DRIFTED ONCE. `StockCell.tsx` says
 * the same thing about the stock panel, and for the same reason: manual orders
 * clamped silently at its floor while mystery box disabled the button there, so
 * the same gesture did two different things on two screens. The floor behaviour
 * here is mystery box's — a button you cannot press tells you where the bottom
 * is, and a button that quietly does nothing does not.
 *
 * STILL A REAL INPUT, NEVER A READOUT. Stock arrives forty at a time. A control
 * that only steps by one would have the owner clicking forty times, so the
 * number in the middle stays typeable and the buttons carry on from whatever
 * was typed.
 *
 * `value` IS A STRING, in and out. All three screens hold their drafts as text
 * so that a half-typed "1" on the way to "12" survives a render; taking a
 * number here would round-trip every such keystroke through NaN.
 */
export function Stepper({
  label,
  labelHidden = false,
  inputLabel,
  decrementLabel,
  incrementLabel,
  value,
  onChange,
  min,
  max,
  fallback,
  disabled = false,
  hint,
  error,
  tiny = false,
  ...rest
}: {
  /** The short word above the number. The input's own name is `inputLabel`,
   *  which carries the row it belongs to as well. */
  label?: ReactNode;
  /**
   * Hides the visible label from the accessibility tree, for a screen where
   * the input's own name already repeats it and the duplication is noise.
   *
   * OPT-IN, because the default is the safe one: a label may hold an `InfoTip`,
   * and a focusable button inside an `aria-hidden` subtree is reachable by Tab
   * while being unreadable to the screen reader that lands on it.
   */
  labelHidden?: boolean;
  /** The input's accessible name — "Items per box in Small", not "Quantity".
   *  Required, because the visible label is hidden from the accessibility tree
   *  and a field with neither would have no name at all. */
  inputLabel: string;
  decrementLabel: string;
  incrementLabel: string;
  value: string;
  onChange: (next: string) => void;
  min?: number;
  max?: number;
  /**
   * Where a step lands when the box has been cleared. THE CALLER'S FACT, not a
   * constant: mystery box sizes start at 1, and the stock panel starts at
   * whatever the variant already has. Defaults to `min`, then to zero.
   */
  fallback?: number;
  disabled?: boolean;
  hint?: ReactNode;
  error?: string | null;
  /** The narrow column manual orders' line rows need. */
  tiny?: boolean;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'value' | 'onChange' | 'min' | 'max'>) {
  const { id, hintId, errorId, describedBy } = useFieldIds(hint, error);

  /* An empty box is not a zero and a lone "-" is not a number. `Number('')` is
   * 0 and `Number('-')` is NaN, so both are caught here rather than reaching
   * the arithmetic — a stepper that read a cleared box as 0 would jump the
   * owner's 40 down to 1 on the next press. */
  const parsed = Number(value);
  const ok = value.trim() !== '' && Number.isInteger(parsed);
  const base = ok ? parsed : (fallback ?? min ?? 0);

  const step = (by: number) => {
    const next = base + by;
    onChange(String(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next))));
  };

  return (
    <div className="field stepper-field">
      {label === undefined ? null : (
        <span className="field__label" aria-hidden={labelHidden || undefined}>
          {label}
        </span>
      )}
      <div className={tiny ? 'stepper stepper--tiny' : 'stepper'}>
        <Button
          iconOnly
          aria-label={decrementLabel}
          disabled={disabled || (ok && min !== undefined && parsed <= min)}
          onClick={() => step(-1)}
        >
          <Minus aria-hidden="true" />
        </Button>
        <input
          id={id}
          className={error ? 'input input--invalid' : 'input'}
          inputMode="numeric"
          aria-label={inputLabel}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          {...rest}
        />
        <Button
          iconOnly
          aria-label={incrementLabel}
          disabled={disabled || (ok && max !== undefined && parsed >= max)}
          onClick={() => step(1)}
        >
          <Plus aria-hidden="true" />
        </Button>
      </div>
      {hint ? (
        <span className="field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="field__error" id={errorId}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

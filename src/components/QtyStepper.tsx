import { useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import '../routes/marketing.css';

/**
 * A quantity, with its two directions on either side of it.
 *
 * WHY NOT A BARE TEXT BOX. Every number this control edits is counted off a
 * pallet one unit at a time, usually by somebody holding something else: a
 * return of six, one of them cracked, five accepted. Buttons make one more a
 * single tap and keep the arithmetic on this side of the form; the field stays
 * typable for the rare jump from 4 to 40.
 *
 * `type="text"` with `inputMode`, not `type="number"` — the argument
 * `ShopVariants` records: a number input silently discards what it cannot
 * parse mid-typing, and its spinners cannot be styled to the design system on
 * every browser. Only digits survive the change handler here, so a quantity
 * cannot be negative or fractional however hard somebody leans on the keyboard.
 *
 * MIN AND MAX ARE NOT SYMMETRICAL, and this is the decision in the file:
 *
 * - `max` is a real ceiling — you cannot accept more units than you received —
 *   so it is enforced on typing as well as on the buttons.
 * - `min` is a RULE THE FORM STATES, not one the box may tell a lie about. The
 *   buttons stop at it and `[−]` disables there, but a typed 3 against a
 *   minimum of 5 stays 3: the operator typed what the customer sent, and the
 *   answer to it is the error the intake route already returns (`below_minimum`
 *   carries the minimum so the message can name it), not a number that quietly
 *   became a different number while they were looking at it.
 *
 * The accessible name comes from `label`, so callers render their visible text
 * as `<span className="label">` — the idiom `ShopOrders` uses for the same
 * shape — rather than a `<label htmlFor>` this component would then have to
 * out-shout with an `aria-label` of its own.
 */
export function QtyStepper({
  value,
  min = 0,
  max,
  onChange,
  label,
}: {
  value: number;
  /** The floor the buttons respect. Typing below it is the form's problem. */
  min?: number;
  /** A ceiling nothing may exceed, typing included. Omit when there isn't one. */
  max?: number;
  onChange: (next: number) => void;
  /** Names the field and both buttons — "Quantity", "Accepted". */
  label: string;
}) {
  /**
   * What the box SHOWS, which is not always what the form holds. An empty box
   * is a half-typed number rather than a zero, and it has to survive being
   * empty for as long as it takes to type the next digit.
   */
  const [draft, setDraft] = useState(() => String(value));
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    // The prop moved under us — a form reset, a clamp, another control. React's
    // adjust-state-during-render path rather than an effect: the box never
    // paints the stale number first.
    setSeen(value);
    setDraft(String(value));
  }

  const ceiling = (n: number): number => (max === undefined ? n : Math.min(n, max));

  /** Show it, remember it, and tell the form — in that order, once. */
  function settle(next: number): void {
    setDraft(String(next));
    setSeen(next);
    if (next !== value) onChange(next);
  }

  function typeInto(raw: string): void {
    const digits = raw.replace(/[^0-9]/g, '');
    if (digits === '') {
      // Nothing is emitted: the form keeps the last real number, so a cleared
      // box mid-edit cannot submit as zero.
      setDraft('');
      return;
    }
    settle(ceiling(Number(digits)));
  }

  function step(by: 1 | -1): void {
    const next = Math.max(min, ceiling(value + by));
    if (next !== value) settle(next);
  }

  return (
    <div className="qtystep">
      <button
        type="button"
        className="qtystep__btn"
        aria-label={`Decrease ${label}`}
        disabled={value <= min}
        onClick={() => step(-1)}
      >
        <Minus className="ui-ic" aria-hidden="true" />
      </button>
      <input
        className="input qtystep__field"
        inputMode="numeric"
        aria-label={label}
        value={draft}
        onChange={(e) => typeInto(e.target.value)}
        // Leaving an empty box puts back what the form still holds, because
        // that is what leaving it means. Nothing else is normalised on the way
        // out: see the min/max note above.
        onBlur={() => {
          if (draft === '') setDraft(String(value));
        }}
      />
      <button
        type="button"
        className="qtystep__btn"
        aria-label={`Increase ${label}`}
        disabled={max !== undefined && value >= max}
        onClick={() => step(1)}
      >
        <Plus className="ui-ic" aria-hidden="true" />
      </button>
    </div>
  );
}

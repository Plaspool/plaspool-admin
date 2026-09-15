import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentProps,
  type FocusEvent,
  type ReactNode,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
} from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { currencyDigits } from '../../data/api-shop';
import { Float } from './Float';

/**
 * Form controls, wired so the label, the hint and the error are all associated
 * with the input rather than merely sitting near it.
 *
 * `aria-describedby` carries BOTH the hint and the error when both exist, which
 * is the case the obvious implementation gets wrong: overwriting the hint's id
 * with the error's means a screen-reader user who trips the validation loses
 * the sentence explaining the format they got wrong.
 */

interface Common {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  /** Renders the label for sighted users but keeps it out of the visual flow —
   *  for a field whose purpose is obvious from position (a search box). */
  hiddenLabel?: boolean;
}

function useIds(hint: unknown, error: unknown) {
  const base = useId();
  const hintId = hint ? `${base}-hint` : undefined;
  const errorId = error ? `${base}-err` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return { id: base, hintId, errorId, describedBy };
}

export function TextField({
  label,
  hint,
  error,
  hiddenLabel,
  ...rest
}: Common & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>) {
  const { id, hintId, errorId, describedBy } = useIds(hint, error);
  return (
    <div className="field">
      <label className={hiddenLabel ? 'sr' : 'field__label'} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={error ? 'input input--invalid' : 'input'}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
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

/** A text field with a fixed affix — `₦` before a money amount, `%` after a
 *  rate. The affix is decorative and `aria-hidden`: the unit belongs in the
 *  label or the hint, where a screen reader will actually reach it. */
export function AffixField({
  label,
  hint,
  error,
  prefix,
  suffix,
  suggestion,
  onSuggest,
  ...rest
}: Common & {
  prefix?: string;
  suffix?: string;
  /**
   * A greyed quick-fill (the owner's ask, 2026-08-25): rendered as the
   * placeholder while the field is EMPTY, with a Tab keycap at its end.
   * Pressing Tab in the empty field — or tapping the keycap, which is the
   * touch path — types the digits out, focus kept, ready to edit. It is a
   * SUGGESTION and never a value: a form submitted untouched still submits
   * empty, because nothing enters state until it has been typed out.
   */
  suggestion?: string;
  onSuggest?: (value: string) => void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>) {
  const { id, hintId, errorId, describedBy } = useIds(hint, error);
  const inputRef = useRef<HTMLInputElement>(null);
  const empty = rest.value == null || rest.value === '';
  const offer = suggestion !== undefined && onSuggest !== undefined && empty;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <div className="affix" style={error ? { borderColor: 'var(--critical)' } : undefined}>
        {prefix ? (
          <span className="affix__tag" aria-hidden="true">
            {prefix}
          </span>
        ) : null}
        <input
          id={id}
          ref={inputRef}
          className="input"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...rest}
          placeholder={offer ? suggestion : rest.placeholder}
          onKeyDown={(e) => {
            // Tab ACCEPTS rather than leaves only while the field is empty and
            // an offer stands; Shift+Tab still walks backwards untouched.
            if (offer && e.key === 'Tab' && !e.shiftKey) {
              e.preventDefault();
              onSuggest(suggestion);
              return;
            }
            rest.onKeyDown?.(e);
          }}
        />
        {offer ? (
          <button
            type="button"
            className="affix__fill"
            tabIndex={-1}
            aria-label={`Fill in ${suggestion}`}
            onClick={() => {
              onSuggest(suggestion);
              inputRef.current?.focus();
            }}
          >
            Tab
          </button>
        ) : null}
        {suffix ? (
          <span className="affix__tag affix__tag--end" aria-hidden="true">
            {suffix}
          </span>
        ) : null}
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

/**
 * MONEY THE WAY PEOPLE READ IT, WHILE THEY ARE TYPING IT (the owner's ask,
 * 2026-09-15): a price box showed `200000.00`, and a run of zeros is a number
 * nobody reads at a glance — one short is ₦20,000 and looks almost the same.
 *
 * THE GROUPING IS LIVE, not applied on blur, because the moment somebody
 * miscounts a run of zeros is while they are typing it. Every key lands, the
 * commas move, and the caret stays after the same digit it was after.
 *
 * TEXT THAT IS NOT AN AMOUNT IS LEFT EXACTLY AS TYPED. `abc`, `-5` and `1.999`
 * pass through untouched, so the field's own validation can still say what is
 * wrong with them — a box that quietly rewrote `-5` into `5` would be deciding
 * a price on the operator's behalf.
 *
 * THE COMMAS NEVER REACH THE WIRE. Callers keep the box's text in state and
 * keep reading it with `parseMajor`, which already strips grouping separators
 * (a figure pasted from a spreadsheet carries them too). This is display, and
 * no amount is ever worked out on a float.
 */
const AMOUNT_SHAPE = /^(\d*)(?:\.(\d*))?$/;

/** `1234567` → `1,234,567`. Digits only; the caller has already checked. */
const groupWhole = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * What a money box shows while it is being typed in: `200000.5` → `200,000.5`,
 * `.5` → `.5`. Text that is not an amount comes back unchanged. Grouping text
 * that is already grouped changes nothing, so it is safe on every keystroke
 * and every render. No leading zero is stripped and no decimal is cut — both
 * are the validation's business, not the display's.
 */
export function groupMajorInput(text: string): string {
  const bare = text.replace(/,/g, '');
  const match = AMOUNT_SHAPE.exec(bare);
  if (!match) return text;
  return match[2] === undefined ? groupWhole(match[1]!) : `${groupWhole(match[1]!)}.${match[2]}`;
}

/**
 * What a money box shows once it is left: `200000` → `200,000.00`, `5.5` →
 * `5.50`, `.5` → `0.50`. Only an amount the currency can actually hold is
 * tidied; empty, invalid and too-many-decimals text comes back unchanged, for
 * the reason above — padding `1.999` would hide the mistake being refused.
 */
export function tidyMajorInput(text: string, digits: number): string {
  const match = AMOUNT_SHAPE.exec(text.trim().replace(/,/g, ''));
  if (!match) return text;
  const whole = match[1]!;
  const fraction = match[2] ?? '';
  if (whole === '' && fraction === '') return text;
  if (fraction.length > digits) return text;
  const kept = groupWhole(whole.replace(/^0+(?=\d)/, '') || '0');
  return digits === 0 ? kept : `${kept}.${fraction.padEnd(digits, '0')}`;
}

const SIGN_BY_CURRENCY = new Map<string, string>();

/**
 * `NGN` → `₦`, `USD` → `$`: the sign `formatMinor` prints, for the front of a
 * money box. English CLDR's plain `symbol` for the naira IS the letters `NGN`,
 * so only `narrowSymbol` reaches the sign. An engine too old for that option,
 * or a code `Intl` refuses, gets the code back — it still names the money.
 */
export function currencySign(code: string): string {
  const upper = code.toUpperCase();
  const cached = SIGN_BY_CURRENCY.get(upper);
  if (cached !== undefined) return cached;
  let sign = upper;
  try {
    const part = new Intl.NumberFormat('en', {
      style: 'currency',
      currency: upper,
      currencyDisplay: 'narrowSymbol',
    })
      .formatToParts(0)
      .find((p) => p.type === 'currency');
    if (part?.value) sign = part.value;
  } catch {
    // Kept as the code; see above.
  }
  SIGN_BY_CURRENCY.set(upper, sign);
  return sign;
}

/** Characters before `end` that are not grouping commas. */
const keptBefore = (text: string, end: number): number => text.slice(0, end).replace(/,/g, '').length;

/** The offset just past the `kept`-th character of `text` that is not a comma. */
function offsetAfterKept(text: string, kept: number): number {
  if (kept <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== ',') seen += 1;
    if (seen === kept) return i + 1;
  }
  return text.length;
}

/** What each money box showed after its last edit, for `commaNeighbourDeleted`. */
const lastShown = new WeakMap<HTMLInputElement, string>();

/**
 * BACKSPACE OR DELETE ON A GROUPING COMMA TAKES THE DIGIT BESIDE IT. Without
 * this, Backspace at `1,|500` removes the comma, the grouping puts it straight
 * back, and the key seems to do nothing at all.
 *
 * Returns the text with that neighbouring digit gone too, and the caret where
 * the digit was — or `null` when the keystroke was not one comma the grouping
 * would rebuild (in text that is not an amount, a deleted comma stays deleted).
 * "What the box showed" is read from two places because each is only
 * sometimes fresh: React writes a controlled value back into `defaultValue` on
 * every commit, and an uncontrolled box has only what this module last wrote.
 * A stale copy can only miss: no grouped amount with a digit deleted regroups
 * into another grouped amount with a comma deleted, so a Backspace on a digit
 * is never mistaken for one on a comma.
 */
function commaNeighbourDeleted(
  input: HTMLInputElement,
  inputType: string | undefined,
): { text: string; caret: number } | null {
  const back = inputType === 'deleteContentBackward';
  if (!back && inputType !== 'deleteContentForward') return null;
  const typed = input.value;
  const caret = input.selectionStart;
  if (caret === null) return null;
  const regrouped = groupMajorInput(typed);
  const commaWent = [lastShown.get(input), input.defaultValue].some(
    (shown) =>
      shown === regrouped && shown[caret] === ',' && shown.slice(0, caret) + shown.slice(caret + 1) === typed,
  );
  const at = back ? caret - 1 : caret;
  if (!commaWent || at < 0 || at >= typed.length) return null;
  return { text: typed.slice(0, at) + typed.slice(at + 1), caret: at };
}

type MoneyInputHandlers = {
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onBlur: (e: FocusEvent<HTMLInputElement>) => void;
};

/**
 * The grouping and the tidy-up as a plain `onChange`/`onBlur` pair, for a money
 * box that is a bare `<input>` rather than a `MoneyField` (the add-on rules'
 * pill-sized boxes). Spread both onto the input; give an uncontrolled one a
 * `defaultValue` already passed through `groupMajorInput`.
 *
 * The grouped text is written into the input BEFORE the caller's `onChange`
 * runs, so `e.target.value` is already what the screen shows and a controlled
 * field's state and its DOM never disagree. On blur the tidied text goes
 * through the same `onChange`, so state follows it there too.
 */
export function moneyInputHandlers(
  currency: string,
  { onChange, onBlur }: Partial<MoneyInputHandlers> = {},
): MoneyInputHandlers {
  return {
    onChange: (e) => {
      const input = e.currentTarget;
      const fixed = commaNeighbourDeleted(input, (e.nativeEvent as Partial<InputEvent>).inputType);
      const typed = fixed ? fixed.text : input.value;
      const caret = fixed ? fixed.caret : input.selectionStart;
      const grouped = groupMajorInput(typed);
      if (grouped !== input.value) {
        // Assigning `value` throws the caret to the end, so it is put back
        // after the same digit — and only in a box the person is typing in.
        input.value = grouped;
        if (caret !== null && input.ownerDocument.activeElement === input) {
          const at = offsetAfterKept(grouped, keptBefore(typed, caret));
          input.setSelectionRange(at, at);
        }
      }
      lastShown.set(input, input.value);
      onChange?.(e);
    },
    onBlur: (e) => {
      const input = e.currentTarget;
      const tidy = tidyMajorInput(input.value, currencyDigits(currency));
      if (tidy !== input.value) {
        input.value = tidy;
        onChange?.(e as unknown as ChangeEvent<HTMLInputElement>);
      }
      lastShown.set(input, input.value);
      onBlur?.(e);
    },
  };
}

/**
 * `AffixField` for an amount of money: the currency's sign inside the border
 * (`₦`, never `NGN`), a decimal keypad on a phone, the thousands grouped as
 * they are typed, and the decimals filled in when the box is left.
 *
 * Nothing about how an amount is stored or sent moves: the caller still keeps
 * `e.target.value` and still parses it with `parseMajor`. A value seeded with
 * `plainMajor` shows grouped without the caller doing anything, and so does a
 * `suggestion` — which is also what `onSuggest` is handed back.
 */
export function MoneyField({
  currency,
  value,
  defaultValue,
  suggestion,
  onChange,
  onBlur,
  ...rest
}: Omit<ComponentProps<typeof AffixField>, 'prefix' | 'type'> & { currency: string }) {
  const handlers = moneyInputHandlers(currency, { onChange, onBlur });
  return (
    <AffixField
      inputMode="decimal"
      autoComplete="off"
      {...rest}
      prefix={currencySign(currency)}
      value={typeof value === 'string' ? groupMajorInput(value) : value}
      defaultValue={typeof defaultValue === 'string' ? groupMajorInput(defaultValue) : defaultValue}
      suggestion={suggestion === undefined ? undefined : groupMajorInput(suggestion)}
      onChange={handlers.onChange}
      onBlur={handlers.onBlur}
    />
  );
}

export function SelectField({
  label,
  hint,
  error,
  hiddenLabel,
  children,
  ...rest
}: Common & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'>) {
  const { id, hintId, errorId, describedBy } = useIds(hint, error);
  return (
    <div className="field">
      <label className={hiddenLabel ? 'sr' : 'field__label'} htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className={error ? 'select select--invalid' : 'select'}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      >
        {children}
      </select>
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

export function TextArea({
  label,
  hint,
  error,
  rows = 3,
  ...rest
}: Common & { rows?: number } & Omit<
    InputHTMLAttributes<HTMLTextAreaElement>,
    'id' | 'rows' | 'type'
  >) {
  const { id, hintId, errorId, describedBy } = useIds(hint, error);
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        rows={rows}
        className="textarea"
        aria-describedby={describedBy}
        {...(rest as Record<string, unknown>)}
      />
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

/**
 * Below this, a segmented control is a wrapped mess rather than a row.
 *
 * 34rem is the phone breakpoint `page.css` already uses. Four range options
 * (30d / 90d / 1y / All time) wrapped onto two lines at 375px, which is what
 * the owner photographed.
 */
const COLLAPSE = '(max-width: 34rem)';

/**
 * Is the viewport narrow enough to collapse a segmented control?
 *
 * The `Sidebar` idiom, and for its reasons: the FIRST render has to commit a
 * shape before any effect runs, so the initial value is read straight off
 * `innerWidth`, and `matchMedia` only keeps it correct as the window is
 * dragged. The guard is not optional — this repo's jsdom has no `matchMedia`,
 * and an unguarded call inside a passive effect takes the whole route to the
 * router's error page. `innerWidth` is already a correct answer without it,
 * and in jsdom it reads 1024, so the suites see the button row they assert on.
 */
function useCollapsed(enabled: boolean): boolean {
  const [narrow, setNarrow] = useState(
    () => enabled && typeof window !== 'undefined' && window.innerWidth <= 544,
  );
  useEffect(() => {
    if (!enabled) return;
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(COLLAPSE);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [enabled]);
  return enabled && narrow;
}

/** The two-option switch used for Discount code / Automatic discount. A pair of
 *  buttons rather than a `<select>`: both options are worth showing at once,
 *  and there are exactly two of them.
 *
 *  `collapse` opts a LONGER control into becoming a dropdown on a phone — the
 *  range pickers over the analytics screens, where four options never fit a
 *  375px row. It is opt-in rather than automatic because the two-option switch
 *  above is the case the component was built for, and it still fits. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  collapse = false,
}: {
  label: string;
  value: T;
  /** A `disabled` option is SHOWN rather than omitted. The reference admin
   *  offers both methods, and hiding the one this backend cannot do yet makes
   *  the control look finished while quietly narrowing what the product does.
   *  Disabled-with-a-title says which it is. */
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
  onChange: (next: T) => void;
  hint?: ReactNode;
  /** Render as a dropdown below 34rem instead of a row of buttons. */
  collapse?: boolean;
}) {
  const collapsed = useCollapsed(collapse);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);

  if (collapsed) {
    return (
      <div className="field field--block">
        <span className="field__label">{label}</span>
        <div className="sselect">
          <button
            ref={trigger}
            type="button"
            className="statuspick__trigger"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label={label}
            onClick={() => setOpen((v) => !v)}
          >
            {current?.label ?? value}
            <ChevronsUpDown aria-hidden="true" />
          </button>
          <Float
            open={open}
            anchor={trigger}
            align="right"
            className="sselect__panel"
            onClose={(opts) => {
              setOpen(false);
              if (opts?.refocus) trigger.current?.focus();
            }}
          >
            <div className="sselect__list" role="listbox" aria-label={label}>
              {options.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={opt.value === value}
                  className="sselect__opt"
                  disabled={opt.disabled}
                  title={opt.title}
                  onClick={() => {
                    if (opt.disabled) return;
                    onChange(opt.value);
                    setOpen(false);
                  }}
                >
                  <span className="sselect__check" aria-hidden="true">
                    {opt.value === value ? <Check /> : null}
                  </span>
                  <span className="sselect__label">{opt.label}</span>
                </button>
              ))}
            </div>
          </Float>
        </div>
        {hint ? <span className="field__hint">{hint}</span> : null}
      </div>
    );
  }

  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <div className="segmented" role="group" aria-label={label}>
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className="segmented__opt"
            aria-pressed={value === opt.value}
            disabled={opt.disabled}
            title={opt.title}
            style={opt.disabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
            onClick={() => !opt.disabled && onChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {hint ? <span className="field__hint">{hint}</span> : null}
    </div>
  );
}

export function Checkbox({
  label,
  hint,
  checked,
  onChange,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span>{label}</span>
        {hint ? <span className="field__hint" style={{ display: 'block' }}>{hint}</span> : null}
      </span>
    </label>
  );
}


/**
 * A radio option with a hint line — the reference's export-modal pattern.
 * The visual (dot-in-circle) comes from `.check input[type='radio']` in
 * ui.css; a DISABLED option stays visible and greyed, because hiding the
 * choice this context cannot offer makes the product look smaller than it is.
 */
export function Radio({
  name,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  name: string;
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <label className="check" style={disabled ? { cursor: 'not-allowed', opacity: 0.55 } : undefined}>
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onChange} />
      <span>
        <span>{label}</span>
        {hint ? (
          <span className="field__hint" style={{ display: 'block' }}>
            {hint}
          </span>
        ) : null}
      </span>
    </label>
  );
}

/** The reference's toggle switch, labelled. The label is the click target. */
export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="tsel__show">
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

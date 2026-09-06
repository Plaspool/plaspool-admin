import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
} from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
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

import { useId, useRef, type ReactNode, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react';

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

/** The two-option switch used for Discount code / Automatic discount. A pair of
 *  buttons rather than a `<select>`: both options are worth showing at once,
 *  and there are exactly two of them. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
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
}) {
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

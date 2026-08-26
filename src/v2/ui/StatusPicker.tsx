import { useRef, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Float } from './Float';

export interface StatusOption<T extends string> {
  value: T;
  label: string;
  /** One sentence on what the state means for the storefront. */
  description: string;
  disabled?: boolean;
  /** Why it is disabled, shown as the pointer title. */
  title?: string;
}

/**
 * The Active / Draft control: a select-shaped trigger whose panel explains
 * each state in a sentence, with the check on the current one. Chosen over a
 * bare <select> because "Draft" without "not visible on the storefront" is a
 * word doing a sentence's job — the reference admin spends the space, and it
 * is the one control where the explanation earns its pixels.
 */
export function StatusPicker<T extends string>({
  value,
  options,
  onChange,
  label,
  busy = false,
}: {
  value: T;
  options: StatusOption<T>[];
  onChange: (next: T) => void;
  /** Accessible name for the trigger. */
  label: string;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  const current = options.find((o) => o.value === value);

  return (
    <div className="statuspick">
      <button
        ref={trigger}
        type="button"
        className="statuspick__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
      >
        {busy ? <span className="spinner" aria-hidden="true" /> : null}
        {current?.label ?? value}
        <ChevronsUpDown aria-hidden="true" />
      </button>
      {/* Floated (portaled, viewport-fixed): this control sits on detail
          pages AND inside modal bodies, and a modal body scrolls — the exact
          clip the shared mechanism exists to escape. The panel matches the
          trigger's width through `--float-anchor-w` rather than `left/right:
          0`, which a fixed element would resolve against the viewport. */}
      <Float
        open={open}
        anchor={trigger}
        align="left"
        className="statuspick__panel"
        role="listbox"
        ariaLabel={label}
        onClose={(opts) => {
          setOpen(false);
          if (opts?.refocus) trigger.current?.focus();
        }}
      >
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              className="statuspick__opt"
              disabled={opt.disabled}
              title={opt.title}
              onClick={() => {
                setOpen(false);
                if (opt.value !== value) onChange(opt.value);
              }}
            >
              <span className="statuspick__check" aria-hidden="true">
                {opt.value === value ? <Check /> : null}
              </span>
              <span className="statuspick__title">{opt.label}</span>
              <span className="statuspick__desc" style={{ gridColumn: 2 }}>
                {opt.description}
              </span>
            </button>
          ))}
      </Float>
    </div>
  );
}

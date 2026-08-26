import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { Float } from './Float';

export interface SearchSelectOption<T extends string> {
  value: T;
  label: string;
  /** Right-aligned figure on the row — "4 of 21". Often WHY you are looking. */
  meta?: ReactNode;
}

/**
 * A select with a search box in its panel, for a list too long to scan —
 * thirty-seven states do not fit in a tab strip. v1 solved this with its
 * Picker; this is the same method restated in v2's language: click, type to
 * narrow, arrow to the row, Enter to pick.
 */
export function SearchSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  placeholder = 'Search…',
  emptyText = 'Nothing matches that.',
  align = 'left',
  triggerPrefix,
}: {
  /** Accessible name for the control. */
  label: string;
  value: T;
  options: SearchSelectOption<T>[];
  onChange: (next: T) => void;
  placeholder?: string;
  emptyText?: string;
  align?: 'left' | 'right';
  /** A small icon inside the trigger, before the current label. */
  triggerPrefix?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hot, setHot] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    /* Open on the CURRENT row, not the top — you usually open this to move a
       step away from where you are, not to start over. (Dismissal lives in
       Float; this effect is only the open-time snapshot.) */
    setHot(Math.max(0, options.findIndex((o) => o.value === value)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open-time snapshot
  }, [open]);

  useEffect(() => {
    setHot(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector('.sselect__opt.is-hot')?.scrollIntoView({ block: 'nearest' });
  }, [hot]);

  function pick(next: T) {
    setOpen(false);
    trigger.current?.focus();
    if (next !== value) onChange(next);
  }

  const current = options.find((o) => o.value === value);

  return (
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
        {triggerPrefix}
        {current?.label ?? value}
        <ChevronsUpDown aria-hidden="true" />
      </button>
      {/* Floated: these pickers sit inside cards and modal bodies, both of
          which clip. The panel keeps at least the trigger's width through
          `--float-anchor-w` (the old `min-width: 100%` would resolve against
          the viewport once fixed). */}
      <Float
        open={open}
        anchor={trigger}
        align={align === 'right' ? 'right' : 'left'}
        className="sselect__panel"
        onClose={(opts) => {
          setOpen(false);
          if (opts?.refocus) trigger.current?.focus();
        }}
      >
          <div className="sselect__search">
            <Search aria-hidden="true" />
            <input
              autoFocus
              value={query}
              placeholder={placeholder}
              aria-label={placeholder}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setHot((h) => Math.min(h + 1, Math.max(matches.length - 1, 0)));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setHot((h) => Math.max(h - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  const hit = matches[hot];
                  if (hit) pick(hit.value);
                }
              }}
            />
          </div>
          <div className="sselect__list" role="listbox" aria-label={label} ref={listRef}>
            {matches.length === 0 ? (
              <div className="sselect__empty">{emptyText}</div>
            ) : (
              matches.map((opt, i) => (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={opt.value === value}
                  className={i === hot ? 'sselect__opt is-hot' : 'sselect__opt'}
                  onMouseEnter={() => setHot(i)}
                  onClick={() => pick(opt.value)}
                >
                  <span className="sselect__check" aria-hidden="true">
                    {opt.value === value ? <Check /> : null}
                  </span>
                  <span className="sselect__label">{opt.label}</span>
                  {opt.meta !== undefined ? <span className="sselect__meta">{opt.meta}</span> : null}
                </button>
              ))
            )}
          </div>
      </Float>
    </div>
  );
}

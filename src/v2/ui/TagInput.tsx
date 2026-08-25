import { useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';

/**
 * The tag field: chips in the box, the caret after the last chip, and the
 * store's own vocabulary offered underneath while you type — so a spelling is
 * REUSED rather than re-invented. A typed name that case-matches an existing
 * tag adopts the stored spelling, the same fold rule the server applies,
 * stated here so the person sees the canonical form before the round trip.
 */
export function TagInput({
  label,
  value,
  onChange,
  suggestions = [],
  hint,
  placeholder = 'Add a tag',
}: {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  /** The vocabulary — `listTags`'s canonical spellings with usage counts. */
  suggestions?: { name: string; count: number }[];
  hint?: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const [hot, setHot] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const chosen = useMemo(() => new Set(value.map((t) => t.toLowerCase())), [value]);

  const matches = useMemo(() => {
    const q = draft.trim().toLowerCase();
    return suggestions
      .filter((s) => !chosen.has(s.name.toLowerCase()))
      .filter((s) => !q || s.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [suggestions, chosen, draft]);

  /** Adds under the fold rule: an existing spelling wins over the typed one. */
  function add(raw: string) {
    const trimmed = raw.trim().replace(/,+$/, '').trim();
    if (!trimmed) return;
    if (chosen.has(trimmed.toLowerCase())) {
      setDraft('');
      return;
    }
    const canonical =
      suggestions.find((s) => s.name.toLowerCase() === trimmed.toLowerCase())?.name ?? trimmed;
    onChange([...value, canonical]);
    setDraft('');
    setHot(0);
  }

  function remove(tag: string) {
    onChange(value.filter((t) => t !== tag));
  }

  const showPop = focused && (matches.length > 0 || draft.trim().length > 0);

  return (
    <div className="field">
      <span className="field__label" id={undefined}>
        {label}
      </span>
      <div className="tagin">
        <div
          className="tagin__box"
          onMouseDown={(e) => {
            /* The whole box focuses the input — but not when the press was on
               a chip's remove button, whose own click must win. */
            if ((e.target as HTMLElement).closest('button')) return;
            e.preventDefault();
            input.current?.focus();
          }}
        >
          {value.map((tag) => (
            <span key={tag} className="tagin__chip">
              {tag}
              <button
                type="button"
                className="tagin__x"
                aria-label={`Remove tag ${tag}`}
                onClick={() => remove(tag)}
              >
                <X aria-hidden="true" />
              </button>
            </span>
          ))}
          <input
            ref={input}
            className="tagin__input"
            value={draft}
            placeholder={value.length === 0 ? placeholder : ''}
            aria-label={label}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              /* Blur commits what was typed — leaving the field with half a
                 tag in it and losing it is the surprise, not the commit. */
              setFocused(false);
              if (draft.trim()) add(draft);
            }}
            onChange={(e) => {
              const next = e.target.value;
              if (next.endsWith(',')) add(next);
              else {
                setDraft(next);
                setHot(0);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (showPop && matches[hot] && draft.trim() === '') add(matches[hot].name);
                else if (showPop && matches[hot] && hot > 0) add(matches[hot].name);
                else add(draft);
              } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
                remove(value[value.length - 1]!);
              } else if (e.key === 'ArrowDown' && showPop) {
                e.preventDefault();
                setHot((h) => Math.min(h + 1, matches.length - 1));
              } else if (e.key === 'ArrowUp' && showPop) {
                e.preventDefault();
                setHot((h) => Math.max(h - 1, 0));
              } else if (e.key === 'Escape') {
                setDraft('');
              }
            }}
          />
        </div>
        {showPop ? (
          <div className="tagin__pop" role="listbox" aria-label="Existing tags">
            {matches.map((s, i) => (
              <button
                key={s.name}
                type="button"
                role="option"
                aria-selected={i === hot}
                className={i === hot ? 'tagin__opt is-hot' : 'tagin__opt'}
                /* mousedown, because blur fires before click and would close
                   the list under the pointer. */
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(s.name);
                }}
                onMouseEnter={() => setHot(i)}
              >
                {s.name}
                <span className="tagin__count">
                  {s.count} {s.count === 1 ? 'product' : 'products'}
                </span>
              </button>
            ))}
            {draft.trim() &&
            !matches.some((m) => m.name.toLowerCase() === draft.trim().toLowerCase()) ? (
              <button
                type="button"
                className="tagin__opt"
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(draft);
                }}
              >
                Add “{draft.trim()}”
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {hint ? <span className="field__hint">{hint}</span> : null}
    </div>
  );
}

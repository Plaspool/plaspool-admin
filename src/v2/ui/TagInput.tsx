import { useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Float } from './Float';

/**
 * Comma, newline, carriage return and tab.
 *
 * Comma because that is how a person writes a list; the other three because
 * that is what a spreadsheet column and a table cell put on the clipboard, and
 * a list of Nigerian states is far likelier to be copied than typed.
 */
const SEPARATOR = /[,\n\r\t]/;
const SEPARATOR_RUN = /[,\n\r\t]+/;

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
  const box = useRef<HTMLDivElement>(null);

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

  /**
   * Commit a whole list at once — a pasted "Abuja, Lagos, Kano", or a column
   * of states copied out of a spreadsheet.
   *
   * NOT `add()` IN A LOOP, and that is the whole reason this exists: `add`
   * closes over `value` and appends ONE tag to it, so a second call in the
   * same render would start from the same stale array and every name but the
   * last would be silently dropped. One `onChange` carries the whole batch.
   *
   * Duplicates fold away twice over: against what is already chosen, and
   * against earlier names in the same paste.
   */
  function addMany(raw: string) {
    const parts = raw
      .split(SEPARATOR_RUN)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0) {
      setDraft('');
      return;
    }
    const seen = new Set(chosen);
    const added: string[] = [];
    for (const part of parts) {
      const folded = part.toLowerCase();
      if (seen.has(folded)) continue;
      seen.add(folded);
      added.push(suggestions.find((s) => s.name.toLowerCase() === folded)?.name ?? part);
    }
    setDraft('');
    setHot(0);
    if (added.length > 0) onChange([...value, ...added]);
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
          ref={box}
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
            onPaste={(e) => {
              /* A pasted list becomes chips. Handled here rather than in
                 `onChange` because a paste is the one case where the LAST
                 segment is finished too: mid-typing, "Abuja, La" must leave
                 "La" behind the caret, and a paste must not. */
              const text = e.clipboardData.getData('text');
              if (!SEPARATOR.test(text)) return;
              e.preventDefault();
              addMany(draft + text);
            }}
            onChange={(e) => {
              const next = e.target.value;
              /* A separator is an Enter: it commits everything BEFORE it and
                 keeps whatever follows as the draft.

                 `endsWith(',')` was true exactly once — when the comma was
                 the last character typed — so anything that arrived with
                 text after it became one tag with commas inside, which then
                 had to match a delivery address exactly. */
              let cut = -1;
              for (let i = next.length - 1; i >= 0; i -= 1) {
                if (SEPARATOR.test(next[i]!)) {
                  cut = i;
                  break;
                }
              }
              if (cut === -1) {
                setDraft(next);
                setHot(0);
                return;
              }
              addMany(next.slice(0, cut + 1));
              const rest = next.slice(cut + 1);
              if (rest.trim()) setDraft(rest);
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
        {/* Floated (portal, viewport-fixed): the field lives in cards and
            modal bodies, both of which clip an absolute pop. The pop keeps
            the BOX's width via --float-anchor-w. Escape stays the input's
            own (clear the draft), so the float's Escape is opted out; every
            other dismissal maps to blurring the input, which is this
            field's native close — and blur commits the draft, its stated
            leaving rule. */}
        <Float
          /* A new chip can wrap the box taller; remounting per chip-count
             remeasures the anchor so the pop never overlaps a grown box. */
          key={value.length}
          open={showPop}
          anchor={box}
          align="left"
          className="tagin__pop"
          role="listbox"
          ariaLabel="Existing tags"
          dismissOnEscape={false}
          onClose={() => input.current?.blur()}
        >
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
        </Float>
      </div>
      {hint ? <span className="field__hint">{hint}</span> : null}
    </div>
  );
}

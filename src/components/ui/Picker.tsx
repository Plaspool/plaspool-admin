import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import './ui.css';

/**
 * A dropdown for a list too long to look through.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SEARCH FIELD IS THE POINT, NOT A GARNISH.
 *
 * `Select` (Radix) covers a handful of fixed choices — a sort order, a status.
 * This covers the other kind: 774 local government areas, 37 states, every
 * district a van might reach. At that length a menu is a filing cabinet with no
 * index — you scroll, you squint, you scroll back. Typing three letters is the
 * only interaction that scales, so the field is focused the moment the menu
 * opens and every keystroke narrows the list underneath it.
 *
 * IT IS NOT A `Select` WITH AN INPUT BOLTED ON. Radix Select owns its own
 * typeahead, focus and keyboard model, all of which fight a text field inside
 * the popup — the field would swallow the arrow keys the listbox needs and the
 * typeahead would steal the letters the field needs. So the popup is written
 * out here: the input keeps focus for the whole interaction and drives the list
 * through `aria-activedescendant`, which is the pattern this actually is.
 *
 * MATCHING IS ACCENT- AND CASE-BLIND AND ANCHORED NOWHERE. "ngwa" finds "Isiala
 * Ngwa North"; "abia" finds every area filed under Abia. A prefix-only match
 * would be faster to write and would fail the first time somebody types the
 * distinctive half of a two-word name, which is what people actually do.
 *
 * WHAT IT IS NOT: a combobox that accepts free text. There is no value here
 * except one of the rows — the field filters, it never becomes the answer.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface PickerItem<T extends string> {
  value: T;
  label: string;
  /** A heading this row files under. Rows with no group sort above the rest. */
  group?: string;
  /** A number pinned to the right — a queue depth, a count of anything. */
  badge?: number;
  /** Quiet words on the right, for a row that has nothing to count. */
  note?: string;
  /** Extra words matched by the search box but never drawn. */
  keywords?: string;
}

/** Case- and accent-blind, matched anywhere in the string. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    /* The combining marks NFD just split off, named rather than spelled as a
       codepoint range — a class of literal combining characters is invisible in
       an editor and does not survive the first tool that rewrites this file in
       the wrong encoding. */
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

export function filterItems<T extends string>(
  items: readonly PickerItem<T>[],
  query: string,
): PickerItem<T>[] {
  const needle = fold(query.trim());
  if (needle === '') return [...items];
  return items.filter((item) =>
    fold(`${item.label} ${item.group ?? ''} ${item.keywords ?? ''}`).includes(needle),
  );
}

/** The rows in display order, with their headings — groups keep first-seen order. */
export function groupItems<T extends string>(
  items: readonly PickerItem<T>[],
): { group: string | null; items: PickerItem<T>[] }[] {
  const names = [...new Set(items.map((item) => item.group ?? null))];
  return names.map((group) => ({
    group,
    items: items.filter((item) => (item.group ?? null) === group),
  }));
}

export function Picker<T extends string>({
  value,
  items,
  onChange,
  label,
  triggerLabel,
  icon,
  badge,
  searchPlaceholder = 'Type to filter…',
  emptyText = 'Nothing matches that.',
  footer,
  align = 'start',
  width,
}: {
  value: T | null;
  items: readonly PickerItem<T>[];
  onChange: (value: T) => void;
  /** The control's accessible name — what it chooses, not what is chosen. */
  label: string;
  /** What the closed trigger reads. Defaults to the chosen row's label. */
  triggerLabel?: string;
  icon?: ReactNode;
  /** A count beside the trigger's own label. */
  badge?: number;
  searchPlaceholder?: string;
  emptyText?: string;
  /**
   * Pinned under the list, inside the popup — a row that is not one of these.
   *
   * Handed a `close` rather than a node, because whatever the caller puts here
   * is still a way out of the menu and has to be able to shut it.
   */
  footer?: (close: () => void) => ReactNode;
  align?: 'start' | 'end';
  /** Popup width. Defaults to the trigger's, floored at 16rem. */
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  const shown = useMemo(() => filterItems(items, query), [items, query]);
  const groups = useMemo(() => groupItems(shown), [shown]);
  const current = items.find((item) => item.value === value) ?? null;

  /*
   * CLOSED BY A CLICK ANYWHERE ELSE AND BY ESCAPE — the two behaviours a person
   * expects from a popup, written out because this repository has no popover
   * primitive to inherit them from.
   */
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Opening starts from a clean field and puts the caret in it. A menu that
  // reopens still filtered by what you typed last time is a menu that appears
  // to have lost half its rows.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    field.current?.focus();
  }, [open]);

  // Typing moves the highlight back to the top: the first row is what Enter
  // takes, and leaving it deep in a list that just changed underneath is how
  // you choose the wrong thing without seeing it.
  useEffect(() => setActive(0), [query]);

  /*
   * Keep the highlighted row in view when the arrows walk past the fold.
   *
   * Found by `data-at` rather than by the row's own id: `useId` produces `:r7:`,
   * which is not a valid CSS identifier, so an id selector would need
   * `CSS.escape` — and `CSS` is one of the globals jsdom does not define, so
   * that spelling throws inside an effect in every test that opens this menu.
   */
  useEffect(() => {
    if (!open) return;
    const row = list.current?.querySelector(`[data-at="${active}"]`);
    /* Feature-detected, because jsdom does not implement it: this is a comfort
       for a list that scrolls, and a comfort must never be the reason a screen
       throws where it is missing. */
    if (row instanceof HTMLElement && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [active, open]);

  const choose = (next: T) => {
    setOpen(false);
    onChange(next);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, shown.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActive(shown.length - 1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const picked = shown[active];
      if (picked !== undefined) choose(picked.value);
    }
  };

  // One running index across the groups, because the arrow keys walk the rows
  // and not the headings between them.
  let index = -1;

  return (
    <div className="ui-picker" ref={box}>
      <button
        type="button"
        className="ui-picker__trigger"
        aria-expanded={open}
        aria-haspopup="listbox"
        /*
          THE PURPOSE AND THE CURRENT VALUE, in that order — "Switch board:
          Maitama District". `aria-label` REPLACES the element's content rather
          than adding to it, so labelling this with the purpose alone would take
          the one word the trigger exists to show away from the only people who
          cannot see it, and labelling it with the value alone leaves a button
          called "Maitama District" that gives no hint it opens anything.
        */
        aria-label={`${label}: ${triggerLabel ?? current?.label ?? 'nothing chosen'}`}
        onClick={() => setOpen((was) => !was)}
      >
        {icon}
        <span className="ui-picker__value">
          {triggerLabel ?? current?.label ?? 'Choose…'}
        </span>
        {badge !== undefined && badge > 0 && <span className="ui-picker__badge">{badge}</span>}
        <ChevronDown className="ui-ic ui-picker__chev" aria-hidden="true" />
      </button>

      {open && (
        <div
          className={`ui-picker__menu ui-picker__menu--${align}`}
          style={width === undefined ? undefined : { width }}
        >
          <div className="ui-picker__search">
            <Search className="ui-ic ui-picker__searchic" aria-hidden="true" />
            <input
              ref={field}
              className="ui-picker__input"
              type="text"
              value={query}
              placeholder={searchPlaceholder}
              aria-label={`Filter ${label.toLowerCase()}`}
              aria-controls={`${id}-list`}
              aria-activedescendant={shown.length > 0 ? `${id}-opt-${active}` : undefined}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
            />
          </div>

          <div className="ui-picker__list" role="listbox" aria-label={label} id={`${id}-list`} ref={list}>
            {shown.length === 0 ? (
              <p className="ui-picker__empty">{emptyText}</p>
            ) : (
              groups.map((group) => (
                <div className="ui-picker__group" key={group.group ?? '—'}>
                  {group.group !== null && <p className="ui-picker__heading">{group.group}</p>}
                  {group.items.map((item) => {
                    index += 1;
                    const at = index;
                    const chosen = item.value === value;
                    return (
                      <button
                        type="button"
                        key={item.value}
                        id={`${id}-opt-${at}`}
                        data-at={at}
                        role="option"
                        aria-selected={chosen}
                        className={`ui-picker__row${at === active ? ' is-active' : ''}${chosen ? ' is-chosen' : ''}`}
                        /* `onMouseDown` would fire before the input's blur and
                           is not needed: the field never loses focus, because
                           nothing inside the popup takes it. */
                        onMouseMove={() => setActive(at)}
                        onClick={() => choose(item.value)}
                      >
                        <Check className="ui-ic ui-picker__check" aria-hidden="true" />
                        <span className="ui-picker__label">{item.label}</span>
                        {item.badge !== undefined && item.badge > 0 && (
                          <span className="ui-picker__badge">{item.badge}</span>
                        )}
                        {item.note !== undefined && (
                          <span className="ui-picker__note">{item.note}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          {footer !== undefined && (
            <div className="ui-picker__foot">{footer(() => setOpen(false))}</div>
          )}
        </div>
      )}
    </div>
  );
}

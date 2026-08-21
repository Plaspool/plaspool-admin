import { useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { Link, type To } from 'react-router-dom';
import './ui.css';

/**
 * The segmented control — one choice out of a few, drawn as one object.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FLUSH, WITH ONE RULE BETWEEN THE OPTIONS, BECAUSE THE PAIR IS ONE CHOICE.
 *
 * This is the Board/Table control from the orders screen, lifted out of
 * `shop.css` so every screen that offers a small closed set of views gets the
 * same object rather than its own near-miss. A gap between the options would
 * read as two buttons that happen to sit together; the single border and the
 * shared background say "these are faces of one switch", which is what a
 * segmented control is for.
 *
 * IT IS NOT A TAB STRIP AND CARRIES NO `role="tab"`. `tab` promises a
 * `tabpanel` and an arrow-key model tied to it, and none of the screens using
 * this render one — they re-list the same region under a different filter.
 * Claiming `tab` without a panel is the kind of ARIA that reads worse than no
 * ARIA at all, so the two honest models below are what it offers instead.
 *
 * NOT FOR MANY OPTIONS. Seven statuses in a flush strip is a row that wraps on
 * a phone and spends a line telling you six things you were not looking for —
 * `Select` or `Picker` is the control for that. The ceiling is about four.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface TabItem<T extends string> {
  value: T;
  label: string;
  /** Hover text — why you would pick this one. */
  hint?: string;
  /** A count pinned after the label. Omit rather than pass a `0` you invented. */
  badge?: number;
  /** Present but not yet reachable — drawn greyed, never hidden. */
  disabled?: boolean;
}

interface Common<T extends string> {
  items: readonly TabItem<T>[];
  value: T;
  /** The control's accessible name — the question it answers, not the answer. */
  label: string;
  /** `lg` matches `Select`'s taller default; `md` matches `--ctl-h`. */
  size?: 'md' | 'lg';
  className?: string;
}

interface LinkMode<T extends string> {
  /**
   * Where each option goes. PASSING THIS MAKES THE OPTIONS LINKS, which is the
   * right shape whenever the choice is already in the URL: the browser's own
   * Back button becomes the undo, middle-click opens the other view in a tab,
   * and the address stays something a person can send to a colleague.
   */
  to: (value: T) => To;
  /** History semantics, forwarded to `Link`. Match whatever the screen's other
   *  filters already do — a strip that pushes beside filters that replace makes
   *  Back walk a history only half the screen wrote. */
  replace?: boolean;
  onChange?: never;
}

interface ButtonMode<T extends string> {
  /** For a choice that is genuinely local state and belongs in no URL. */
  onChange: (value: T) => void;
  to?: never;
  replace?: never;
}

export function Tabs<T extends string>(props: Common<T> & (LinkMode<T> | ButtonMode<T>)) {
  const { items, value, label, size = 'md', className } = props;
  const box = useRef<HTMLDivElement>(null);
  const cls = `ui-tabs ui-tabs--${size}${className === undefined ? '' : ` ${className}`}`;

  const body = (item: TabItem<T>): ReactNode => (
    <>
      <span className="ui-tabs__label">{item.label}</span>
      {item.badge !== undefined && item.badge > 0 && (
        <span className="ui-tabs__badge">{item.badge}</span>
      )}
    </>
  );

  /*
   * LINKS: `aria-current` rather than `aria-pressed`. There is one choice of
   * N here, not N independent toggles, and `aria-current` is the only one of
   * the two that says so. Links need no arrow-key handling — Tab reaches them
   * because they are links, which is the whole reason to use one.
   */
  if (props.to !== undefined) {
    const { to, replace } = props;
    return (
      <div className={cls} role="group" aria-label={label}>
        {items.map((item) =>
          item.disabled === true ? (
            <span key={item.value} className="ui-tabs__opt is-disabled" aria-disabled="true">
              {body(item)}
            </span>
          ) : (
            <Link
              key={item.value}
              className="ui-tabs__opt"
              to={to(item.value)}
              replace={replace}
              title={item.hint}
              aria-current={item.value === value ? 'true' : undefined}
            >
              {body(item)}
            </Link>
          ),
        )}
      </div>
    );
  }

  /*
   * BUTTONS: a radio group, with the roving tabindex that comes with it.
   *
   * `aria-pressed` on each option would be the easier spelling and would claim
   * N switches that can each be on — which is the one thing this control makes
   * impossible. A radio group says "exactly one of these", and having said it,
   * owes the keyboard the model that goes with it: ONE tab stop for the whole
   * group, and the arrows move the choice inside it.
   */
  const { onChange } = props;
  const reachable = items.filter((item) => item.disabled !== true);

  const step = (delta: number) => {
    const at = reachable.findIndex((item) => item.value === value);
    /* Wraps, because a radio group's arrows wrap. `+ length` keeps the modulo
       positive when stepping left off the first option. */
    const to = (at + delta + reachable.length) % reachable.length;
    const next = reachable[to];
    if (next === undefined) return;
    onChange(next.value);
    /*
     * The choice moved, so the tab stop moved with it — put focus where the
     * person is looking, or the next Tab leaves from the option they left.
     *
     * FOUND BY POSITION, NOT BY VALUE. A value is caller data and may hold any
     * character, so a `[data-value="…"]` selector would need `CSS.escape` —
     * and `CSS` is one of the globals jsdom does not define, which makes that
     * spelling throw in every test that arrows across this control. The index
     * is ours and is always a digit. (`Picker` avoids the same trap the same
     * way, for the same reason.)
     */
    box.current?.querySelector<HTMLButtonElement>(`[data-at="${to}"]`)?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    const delta = moves[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    step(delta);
  };

  return (
    <div className={cls} role="radiogroup" aria-label={label} ref={box} onKeyDown={onKeyDown}>
      {items.map((item) => {
        const chosen = item.value === value;
        /* -1 for a disabled option, which the arrows skip and never land on. */
        const at = reachable.indexOf(item);
        return (
          <button
            key={item.value}
            type="button"
            role="radio"
            data-at={at}
            className="ui-tabs__opt"
            aria-checked={chosen}
            /* The chosen option is the group's single tab stop. */
            tabIndex={chosen ? 0 : -1}
            disabled={item.disabled}
            title={item.hint}
            onClick={() => onChange(item.value)}
          >
            {body(item)}
          </button>
        );
      })}
    </div>
  );
}

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * The dropdown behind every "More actions" control.
 *
 * Hand-rolled rather than Radix, and that is a v2-isolation decision rather
 * than a taste one: v1 restyles `@radix-ui/react-dropdown-menu` through its own
 * token sheet, so mounting Radix here would either inherit v1 chrome or force a
 * second override sheet fighting the first. This is forty lines and owes
 * nothing to v1.
 *
 * WHAT IT STILL HAS TO GET RIGHT:
 *  · Escape closes and returns focus to the trigger, or a keyboard user is
 *    stranded inside a panel they cannot leave.
 *  · A pointerdown ANYWHERE outside closes it — `click` is too late, because a
 *    click on a second trigger would open that one and then this handler would
 *    close it again in the same tick.
 *  · Choosing an item closes the menu. `onSelect` wraps the caller's handler
 *    rather than trusting each call site to remember.
 */
export function Menu({
  label,
  children,
  align = 'right',
  tone = 'default',
  chrome = 'button',
  buttonLabel,
}: {
  label: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  tone?: 'default' | 'plain';
  /** `button` renders the standard bevelled trigger with a chevron. `bare`
   *  renders the label alone — for triggers that ARE their own affordance,
   *  like the topbar avatar disc, where a chevroned button around a face
   *  would be chrome around chrome. */
  chrome?: 'button' | 'bare';
  /** Accessible name for a `bare` trigger whose visible label is not text. */
  buttonLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  /*
   * ═══ THE PANEL IS FIXED, NOT ABSOLUTE (owner's third round) ═══
   * An absolute panel is clipped by any overflowing ancestor, and menus live
   * inside two of them: `.tscroll` (a per-row ⋯ in a wide table — the
   * Marketing screenshot, where the open menu forced the table to scroll and
   * cut itself off) and the mobile card (the variants ⋯, cut at the card
   * edge). Fixed positioning measures the trigger on open and renders at the
   * viewport level, above every overflow. The cost is that a fixed panel does
   * not ride along when something scrolls — so ANY scroll closes it, which is
   * also what a menu should do: the thing it was anchored to just moved.
   */
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  function openAtTrigger() {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    setPos(
      align === 'left'
        ? { top: rect.bottom + 8, left: Math.max(8, rect.left) }
        : { top: rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right) },
    );
    setOpen(true);
  }

  /* If the panel would run off the bottom, sit it above the trigger instead —
     measured after mount, because the panel's height is its content's. */
  useEffect(() => {
    if (!open || !panel.current || !trigger.current || pos === null) return;
    const panelRect = panel.current.getBoundingClientRect();
    const triggerRect = trigger.current.getBoundingClientRect();
    if (panelRect.bottom > window.innerHeight - 8) {
      const above = triggerRect.top - 8 - panelRect.height;
      setPos((was) => (was ? { ...was, top: Math.max(8, above) } : was));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- position once per open
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(event: PointerEvent) {
      if (root.current?.contains(event.target as Node)) return;
      if (panel.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    }
    function onScroll() {
      setOpen(false);
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    /* Capture phase, because the scrolling element is `.main` or `.tscroll`,
       not the window — bubbling scroll events never reach the document. */
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  return (
    <div className="menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={
          (chrome === 'bare' ? 'menu__bare' : `btn btn--${tone} btn--lg`) + (open ? ' is-open' : '')
        }
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={buttonLabel}
        onClick={() => (open ? setOpen(false) : openAtTrigger())}
      >
        {label}
        {chrome === 'bare' ? null : <ChevronDown aria-hidden="true" />}
      </button>
      {open && pos ? (
        <div
          ref={panel}
          className="menu__panel menu__panel--fixed"
          style={{ top: pos.top, left: pos.left, right: pos.right }}
          role="menu"
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({
  icon,
  onSelect,
  critical = false,
  children,
}: {
  icon?: ReactNode;
  onSelect: () => void;
  critical?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={critical ? 'menu__item menu__item--critical' : 'menu__item'}
      onClick={onSelect}
    >
      {icon}
      {children}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="menu__sep" role="separator" />;
}

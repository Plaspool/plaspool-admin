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

  useEffect(() => {
    if (!open) return;
    function onDown(event: PointerEvent) {
      if (root.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
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
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        {chrome === 'bare' ? null : <ChevronDown aria-hidden="true" />}
      </button>
      {open ? (
        <div className={align === 'left' ? 'menu__panel menu__panel--left' : 'menu__panel'} role="menu">
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

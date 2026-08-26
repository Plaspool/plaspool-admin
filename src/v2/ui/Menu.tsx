import { useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Float } from './Float';

/**
 * The dropdown behind every "More actions" control.
 *
 * Hand-rolled rather than Radix, and that is a v2-isolation decision rather
 * than a taste one: v1 restyles `@radix-ui/react-dropdown-menu` through its own
 * token sheet, so mounting Radix here would either inherit v1 chrome or force a
 * second override sheet fighting the first. This is forty lines and owes
 * nothing to v1.
 *
 * The positioning, portaling and dismissal all live in `Float` — the shared
 * mechanism every popover here rides, after a row's menu was photographed
 * painted OVER by its own pinned column (a sticky cell is a stacking
 * context; a panel left inside one loses to every later row). What this file
 * keeps is only what makes a menu a menu:
 *
 *  · Escape returns focus to the trigger, or a keyboard user is stranded.
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
  const trigger = useRef<HTMLButtonElement>(null);

  return (
    <div className="menu">
      <button
        ref={trigger}
        type="button"
        className={
          (chrome === 'bare' ? 'menu__bare' : `btn btn--${tone} btn--lg`) + (open ? ' is-open' : '')
        }
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={buttonLabel}
        onClick={() => setOpen((was) => !was)}
      >
        {label}
        {chrome === 'bare' ? null : <ChevronDown aria-hidden="true" />}
      </button>
      <Float
        open={open}
        anchor={trigger}
        align={align}
        className="menu__panel"
        role="menu"
        onClose={(opts) => {
          setOpen(false);
          if (opts?.refocus) trigger.current?.focus();
        }}
      >
        {children(() => setOpen(false))}
      </Float>
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

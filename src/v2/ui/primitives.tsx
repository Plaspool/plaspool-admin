import type { ReactNode, ButtonHTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import { CircleAlert, Info } from 'lucide-react';

/**
 * v2 primitives — button, badge, spinner, empty state, banner.
 *
 * These are components rather than raw class names because the class names are
 * the part that drifts. `.btn--primary` typed by hand in fourteen screens is
 * fourteen chances to write `.btn-primary`; a `tone` prop is one.
 */

/* ═══════════════════════════════════════════════════════════════ BUTTON ══ */

export type ButtonTone = 'default' | 'primary' | 'plain' | 'critical';

interface ButtonBase {
  tone?: ButtonTone;
  size?: 'md' | 'lg';
  /** Renders as a square control with no label. `aria-label` becomes required
   *  in practice — an icon-only button with no accessible name is a button a
   *  screen reader announces as "button". */
  iconOnly?: boolean;
  /** Shows a spinner and blocks the click WITHOUT changing the label. Swapping
   *  the text for "Saving…" resizes the button under the cursor mid-press. */
  busy?: boolean;
  children?: ReactNode;
}

export interface ButtonProps
  extends ButtonBase,
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {}

function classes(tone: ButtonTone, size: 'md' | 'lg', iconOnly: boolean, busy: boolean): string {
  return [
    'btn',
    `btn--${tone}`,
    size === 'lg' ? 'btn--lg' : '',
    iconOnly ? 'btn--icon' : '',
    busy ? 'btn--busy' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function Button({
  tone = 'default',
  size = 'md',
  iconOnly = false,
  busy = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      className={[classes(tone, size, iconOnly, busy), className].filter(Boolean).join(' ')}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

/** The same surface as a `Button`, but it navigates. A `Button` with an
 *  `onClick` that calls `navigate()` loses middle-click, open-in-new-tab and
 *  the status bar preview — every affordance a link has and a button does not. */
export function ButtonLink({
  to,
  tone = 'default',
  size = 'md',
  iconOnly = false,
  children,
  ...rest
}: ButtonBase & { to: string; 'aria-label'?: string; title?: string }) {
  return (
    <Link to={to} className={classes(tone, size, iconOnly, false)} {...rest}>
      {children}
    </Link>
  );
}

/* ══════════════════════════════════════════════════════════════ SPINNER ══ */

export function Spinner({ large = false }: { large?: boolean }) {
  return <span className={large ? 'spinner spinner--lg' : 'spinner'} aria-hidden="true" />;
}

/** The whole-panel loading state. It says what it is waiting for, because
 *  "Loading…" on four screens is indistinguishable from a stuck one. */
export function Loading({ what }: { what: string }) {
  return (
    <div className="loading" role="status">
      <Spinner />
      <span>Loading {what}…</span>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════ BADGE ══ */

export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'critical' | 'info';

export function Badge({
  tone = 'neutral',
  dot = true,
  children,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={tone === 'neutral' ? 'badge' : `badge badge--${tone}`}>
      {dot ? <span className="badge__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/* ══════════════════════════════════════════════════════════ EMPTY STATE ══ */

export function EmptyState({
  icon,
  art,
  title,
  body,
  actions,
}: {
  /** The plain icon ring — the right grade for a filter that matched nothing. */
  icon?: ReactNode;
  /** A drawn illustration from `ui/illustrations.tsx` — the right grade for a
   *  screen's true first-run state, and only that. When both are passed the
   *  art wins. */
  art?: ReactNode;
  title: string;
  body?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="empty">
      {art ? (
        <div className="empty__art" aria-hidden="true">
          {art}
        </div>
      ) : icon ? (
        <div className="empty__mark" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <h2 className="empty__title">{title}</h2>
      {body ? <p className="empty__body">{body}</p> : null}
      {actions ? <div className="empty__actions">{actions}</div> : null}
    </div>
  );
}

/**
 * The reference's product-style first-run state: copy and actions on the
 * left, a 2×2 shelf of product pictures on the right. Reserved for the one
 * or two screens whose first run is a real onboarding moment — everything
 * else uses `EmptyState`.
 */
export function SplitEmpty({
  title,
  body,
  actions,
  shelf,
}: {
  title: string;
  body: ReactNode;
  actions: ReactNode;
  /** The picture grid — e.g. `<SpoolTiles />`. */
  shelf: ReactNode;
}) {
  return (
    <div className="splitempty">
      <div>
        <h2 className="splitempty__title">{title}</h2>
        <p className="splitempty__body">{body}</p>
        <div className="splitempty__actions">{actions}</div>
      </div>
      <div className="splitempty__grid" aria-hidden="true">
        {shelf}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ BANNER ══ */

export function Banner({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: 'info' | 'warn' | 'critical';
  title?: string;
  children: ReactNode;
  /** A button or link that takes the reader TO the thing being warned about.
   *  A banner that names a problem and offers no way to go look at it is a
   *  to-do the reader has to carry in their head. */
  action?: ReactNode;
}) {
  const Icon = tone === 'info' ? Info : CircleAlert;
  return (
    <div className={tone === 'info' ? 'banner' : `banner banner--${tone}`} role="status">
      <span className="banner__icon" aria-hidden="true">
        <Icon />
      </span>
      <div className="banner__content">
        {title ? <div className="banner__title">{title}</div> : null}
        <div className="banner__body">{children}</div>
      </div>
      {action ? <div className="banner__action">{action}</div> : null}
    </div>
  );
}

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Calendar, ChevronRight, Eye, EyeOff } from 'lucide-react';
import { Menu, MenuItem } from './Menu';
import { useToast } from './Toast';

/**
 * The page frame, and the two rules of the v2 information architecture.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * RULE 1 — ANALYTICS ARE HIDDEN UNTIL SOMEBODY ASKS FOR THEM.
 *
 * A summary strip pinned above every table is five numbers an operator did not
 * come for, sitting between them and the rows they did. So the bar starts
 * closed, and the control that opens it lives in More actions rather than on
 * the page — a visible "Show analytics" button is most of the cost of the bar
 * itself.
 *
 * The choice IS remembered, per screen, for the rest of the browser session:
 * an owner who wants the numbers on Orders should not re-open them every time
 * they come back from an order. `sessionStorage` rather than `localStorage`, so
 * "hidden by default" stays true of a fresh visit rather than being true once.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * RULE 2 — ONE TABLE PER PAGE.
 *
 * Not enforced by a runtime check, but by there being nowhere to put a second
 * one: `PageHeader` takes a single title and the screens compose one `DataTable`
 * under it. Anything that wants to be a second table is a card, a definition
 * list, or its own route.
 */

const STORE_PREFIX = 'plaspool.v2.analytics.';

/**
 * A panel that starts HIDDEN and is revealed from More actions — the
 * analytics bar was the first (Rule 1 above); Marketing's activity feed is
 * the second. Same contract for every one: off on a fresh visit, remembered
 * per screen for the browser session, announced by a toast that names the
 * panel rather than a generic "shown".
 */
export function useRevealPanel(screen: string, noun: string): [boolean, () => void] {
  const toast = useToast();
  const key = STORE_PREFIX + screen;

  const [shown, setShown] = useState<boolean>(() => {
    /* Wrapped, because Safari in private mode throws on `sessionStorage` access
       rather than returning null — an unguarded read here would blank the whole
       screen behind an error boundary. */
    try {
      return window.sessionStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });

  const toggle = useCallback(() => {
    setShown((was) => {
      const next = !was;
      try {
        window.sessionStorage.setItem(key, next ? '1' : '0');
      } catch {
        /* Not remembering the choice is survivable; failing to make it is not. */
      }
      toast.show(next ? `${noun} shown` : `${noun} hidden`);
      return next;
    });
  }, [key, noun, toast]);

  return [shown, toggle];
}

export function useAnalyticsBar(screen: string): [boolean, () => void] {
  return useRevealPanel(screen, 'Analytics bar');
}

/* ══════════════════════════════════════════════════════════ PAGE HEADER ══ */

export function PageHeader({
  icon,
  title,
  titleBadge,
  subtitle,
  backTo,
  backLabel,
  actions,
  menu,
}: {
  icon?: ReactNode;
  title: string;
  /** A status badge beside the title — the detail pages' "Active" chip. */
  titleBadge?: ReactNode;
  subtitle?: ReactNode;
  /** Turns the header into a BREADCRUMB, the reference's own anatomy: the
   *  section is an icon chip you can click, a chevron, then this page's
   *  title. No "← Back" line — the parent page IS the icon. */
  backTo?: string;
  /** Accessible name for the crumb chip — the parent page's name. */
  backLabel?: string;
  /** Buttons shown on the header row, primary last — the reference admin puts
   *  the primary action at the far right, where the eye lands after the title. */
  actions?: ReactNode;
  /** The More actions dropdown's contents. Rendered BEFORE `actions`, because
   *  a menu of secondary things belongs left of the primary button. */
  menu?: (close: () => void) => ReactNode;
}) {
  /* ═══ THE TWO-TAP CRUMB (touch only) ═══ On a pointer the chip has a hover
     title, so an icon-only crumb is legible before it is pressed. Touch has
     no hover, and an unlabelled icon that navigates on first contact is a
     mystery button — so on touch the FIRST tap peeks the destination's name
     in a small bubble under the chip (the reference admin's own move,
     photographed by the owner), and the second tap — on the chip or on the
     bubble, which is a real link — actually goes. The peek dismisses itself
     after a beat, on an outside tap, and on Escape. */
  const [peek, setPeek] = useState(false);
  const crumbRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!peek) return;
    const timer = window.setTimeout(() => setPeek(false), 2600);
    function onDown(event: PointerEvent) {
      if (crumbRef.current?.contains(event.target as Node)) return;
      setPeek(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setPeek(false);
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [peek]);

  return (
    /* Classed so the phone layout can dissolve it (display: contents): a
       sticky title can only travel inside its parent's box, and every wrapper
       between the h1 and the tall `.page` column is exactly title-height —
       zero travel. Dissolving the chain makes `.page` the containing block. */
    <div className="page__headwrap">
      <div className="page__head">
        <div className="page__titles">
          <h1 className="page__title">
            {backTo ? (
              <>
                <span className="page__crumbwrap" ref={crumbRef}>
                  <Link
                    className="page__crumb"
                    to={backTo}
                    title={backLabel}
                    aria-label={backLabel ?? 'Back'}
                    onClick={(event) => {
                      if (peek) return;
                      if (window.matchMedia('(hover: none)').matches) {
                        event.preventDefault();
                        setPeek(true);
                      }
                    }}
                  >
                    {icon}
                  </Link>
                  {peek ? (
                    <Link className="page__peek" to={backTo}>
                      {backLabel ?? 'Back'}
                    </Link>
                  ) : null}
                </span>
                <ChevronRight className="page__crumbsep" aria-hidden="true" />
              </>
            ) : (
              icon
            )}
            {/* Its own span so a phone can clamp a long title to two lines —
                a bare text node cannot be line-clamped. */}
            <span className="page__titletext">{title}</span>
            {titleBadge}
          </h1>
          {subtitle ? <p className="page__sub">{subtitle}</p> : null}
        </div>
        <div className="page__actions">
          {menu ? <Menu label="More actions">{menu}</Menu> : null}
          {actions}
        </div>
      </div>
    </div>
  );
}

/** The More actions entry a revealable panel gets — the label always matches
 *  the state it describes: "Show" when hidden, "Hide" when shown. */
export function RevealMenuItem({
  shown,
  onToggle,
  close,
  noun,
}: {
  shown: boolean;
  onToggle: () => void;
  close: () => void;
  /** Lowercase, as it reads mid-sentence: "Show latest activity". */
  noun: string;
}) {
  return (
    <MenuItem
      icon={shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      onSelect={() => {
        onToggle();
        close();
      }}
    >
      {shown ? `Hide ${noun}` : `Show ${noun}`}
    </MenuItem>
  );
}

/** The one every list screen shares. */
export function AnalyticsMenuItem(props: {
  shown: boolean;
  onToggle: () => void;
  close: () => void;
}) {
  return <RevealMenuItem {...props} noun="analytics bar" />;
}

/* ═════════════════════════════════════════════════════════ ANALYTICS BAR ══ */

export interface Metric {
  label: string;
  value: string;
  /** The change against the previous window, already formatted. Omitted rather
   *  than rendered as "—" when there is nothing to compare against. */
  delta?: string;
  /** Points for the sparkline, oldest first. An ABSENT series draws a flat rule
   *  and not a curve: inventing a shape under a real number is the one thing a
   *  summary bar must never do. */
  series?: number[];
}

function Sparkline({ points }: { points: number[] }) {
  const gradId = useId();
  if (points.length < 2) return <span className="abar__flat" aria-hidden="true" />;

  const H = 18;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const step = 100 / (points.length - 1);
  const xy = points.map((p, i) => [i * step, H - 2 - ((p - min) / span) * (H - 5)] as const);

  /* A SMOOTH line, drawn through midpoints: each segment is a quadratic curve
     whose control point is the data point itself, joined at the midpoints
     between samples. The first pass drew straight polylines, and three samples
     joined by two hard angles read as a glitch rather than a trend. Midpoint
     smoothing never overshoots the data the way a fitted spline can — the
     curve stays inside the range the numbers actually cover. */
  const pt = (i: number) => `${xy[i]![0].toFixed(2)},${xy[i]![1].toFixed(2)}`;
  let line = `M${pt(0)}`;
  for (let i = 1; i < xy.length - 1; i++) {
    const [cx, cy] = xy[i]!;
    const [nx, ny] = xy[i + 1]!;
    line += ` Q${cx.toFixed(2)},${cy.toFixed(2)} ${((cx + nx) / 2).toFixed(2)},${((cy + ny) / 2).toFixed(2)}`;
  }
  /* The tail lands ON the final sample. The control collapses onto it, which
     degrades to a straight run into the endpoint — exact where it matters. */
  line += ` Q${pt(xy.length - 1)} ${pt(xy.length - 1)}`;

  const area = `${line} L100,${H} L0,${H} Z`;

  return (
    <span className="abar__spark" aria-hidden="true">
      <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" focusable="false">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.16" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gradId})`} stroke="none" />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
    </span>
  );
}

export function AnalyticsBar({
  range = 'Today',
  metrics,
}: {
  range?: string;
  metrics: Metric[];
}) {
  return (
    <section className="abar" aria-label={`${range} summary`}>
      <div className="abar__range">
        <Calendar aria-hidden="true" />
        {range}
      </div>
      <div className="abar__cells">
        {metrics.map((m) => (
          <div className="abar__cell" key={m.label}>
            <span className="abar__label" title={m.label}>
              {m.label}
            </span>
            <span className="abar__value">
              {m.value}
              {m.delta ? <span className="abar__delta">{m.delta}</span> : null}
            </span>
            {m.series ? <Sparkline points={m.series} /> : <span className="abar__flat" aria-hidden="true" />}
          </div>
        ))}
      </div>
      {/* No stepper. There is exactly one window the server answers for, and a
          permanently disabled arrow pair is dead chrome spending a cell's
          width — it returns the day a second window exists. */}
    </section>
  );
}

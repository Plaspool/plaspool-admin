import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  ChevronLeft,
  Mail,
  Newspaper,
  PanelLeft,
  PanelLeftClose,
  Settings as SettingsIcon,
  ShoppingBag,
  X,
} from 'lucide-react';
import { Tooltip } from './ui/Switch';
import { useSettings } from '../data/settings';
import type { AuthUser } from '../data/types';
import './sidebar.css';

/**
 * The shell's navigation, and the two shapes it takes.
 *
 * **Collapsed is the resting state**, on every screen size. This app's whole
 * argument is that the words are the interface, so the chrome is 56px of icons
 * until someone asks for more — by putting a pointer on it, by tabbing into it,
 * or by pinning it open for good.
 *
 * The two shapes are not a responsive nicety, they are different mechanisms:
 *
 * - **Rail** (>=720px). Fixed to the left edge, and the route column is inset
 *   by its width. Peeking OVERLAYS rather than pushes, so moving the mouse
 *   across the screen cannot reflow a grid of post cards under the cursor.
 *   Only pinning moves the column, and only when a human asks.
 *
 *   **Peeking is CSS and not state**, which is not a micro-optimisation. The
 *   tooltips a collapsed rail needs are conditional on the rail being
 *   collapsed, so a React `hovered` flag would swap `<Tooltip><Link/></Tooltip>`
 *   for `<Link/>` the instant the pointer crossed the panel edge — React
 *   replaces the element when the type at a position changes, which unmounts
 *   the very link the pointer is travelling towards, on every entry, along
 *   with any focus and any transition mid-flight. `:hover` and `:focus-within`
 *   do the same job and touch nothing. The price is that a tooltip can still
 *   open while the rail is peeked, showing a word that is now also visible
 *   eight pixels to its left; this app's `Tooltip` wrapper exposes no way to
 *   suppress that, and a duplicated word is a far smaller defect than a
 *   navigation that rebuilds itself under the cursor.
 * - **Drawer** (<720px). There is no room to inset 56px out of 375, so the
 *   rail leaves entirely and the whole panel slides over the content with a
 *   scrim. Escape closes it, the scrim closes it, and following a link closes
 *   it — a nav that stays open over the thing you just navigated to is a nav
 *   you have to dismiss twice.
 */

type SectionId = 'posts' | 'shop' | 'emails' | 'settings';

interface Section {
  id: SectionId;
  label: string;
  /** Where the rail sends you. Emails has no index screen of its own. */
  to: string;
  icon: typeof Newspaper;
}

const SECTIONS: Section[] = [
  { id: 'posts', label: 'Posts', to: '/', icon: Newspaper },
  { id: 'shop', label: 'Shop', to: '/shop', icon: ShoppingBag },
  /*
   * Straight to the templates screen. `/emails` exists and redirects here, but
   * sending the rail through a redirect would put a dead entry in the history
   * stack — Back from the templates screen would land on `/emails` and bounce
   * forward again, which reads as Back being broken.
   */
  { id: 'emails', label: 'Emails', to: '/emails/templates', icon: Mail },
];

const SETTINGS_SECTION: Section = {
  id: 'settings',
  label: 'Settings',
  to: '/settings',
  icon: SettingsIcon,
};

/**
 * THE PAGES INSIDE A SECTION, which used to be a tab row on every screen.
 *
 * Three separate strips did this job — `ShopNav` copied into four shop files,
 * `MailNav` into three email ones, and the dashboard's status tabs — and each
 * cost a full row above content that had a heading of its own directly beneath
 * it. Moving them here makes one navigation instead of two: the rail says where
 * you are and where you can go, and the page under it is only the page.
 *
 * `key` is what a screen publishes a count against (see `useSidebarCounts`),
 * and what decides which item is lit. `search` is how the Posts filters live in
 * the URL — they are the dashboard's `?status=`, not separate routes, so they
 * are matched on the query rather than on the path.
 */
interface SectionPage {
  key: string;
  label: string;
  to: string;
  /** The `?status=` this item owns. `''` is the unfiltered default. */
  status?: string;
}

const SECTION_PAGES: Partial<Record<SectionId, SectionPage[]>> = {
  posts: [
    { key: 'all', label: 'All', to: '/', status: '' },
    { key: 'published', label: 'Published', to: '/?status=published', status: 'published' },
    { key: 'draft', label: 'Drafts', to: '/?status=draft', status: 'draft' },
    { key: 'archived', label: 'Archived', to: '/?status=archived', status: 'archived' },
    { key: 'trash', label: 'Trash', to: '/?status=trash', status: 'trash' },
  ],
  shop: [
    { key: 'overview', label: 'Overview', to: '/shop' },
    { key: 'products', label: 'Products', to: '/shop/products' },
    { key: 'orders', label: 'Orders', to: '/shop/orders' },
    { key: 'customers', label: 'Customers', to: '/shop/customers' },
  ],
  emails: [
    { key: 'templates', label: 'Templates', to: '/emails/templates' },
    { key: 'broadcasts', label: 'Broadcasts', to: '/emails/broadcasts' },
    { key: 'subscribers', label: 'Subscribers', to: '/emails/subscribers' },
  ],
};

/**
 * Counts beside the section's pages, published by whichever screen knows them.
 *
 * ONLY THE DASHBOARD HAS THEM, and only it can: the tab counts are derived from
 * the Dexie cache of every post, which the sidebar has no business reading and
 * no way to read cheaply. Moving the tabs into the rail without this would have
 * quietly dropped "Drafts 8" — a regression disguised as a layout change.
 *
 * A context rather than a store: the value is per-render and per-screen, and it
 * must be cleared when the screen unmounts, which a module-scope store would
 * make somebody remember to do.
 */
type Counts = Record<string, number>;
const CountsContext = createContext<{
  counts: Counts;
  publish: (c: Counts | null) => void;
}>({ counts: {}, publish: () => {} });

export function SidebarCounts({ children }: { children: ReactNode }) {
  const [counts, setCounts] = useState<Counts>({});
  const publish = useCallback((c: Counts | null) => setCounts(c ?? {}), []);
  const value = useMemo(() => ({ counts, publish }), [counts, publish]);
  return <CountsContext.Provider value={value}>{children}</CountsContext.Provider>;
}

/**
 * Publish this screen's counts to the rail, and take them down on unmount.
 *
 * The cleanup is the load-bearing half: without it, navigating from the
 * dashboard to the shop would leave "Drafts 8" hanging beside Orders.
 */
export function useSidebarCounts(counts: Counts | null): void {
  const { publish } = useContext(CountsContext);
  // Serialised, so a caller may pass an object literal without re-publishing on
  // every render — the shape is a handful of small integers.
  const encoded = counts === null ? null : JSON.stringify(counts);
  useEffect(() => {
    publish(encoded === null ? null : (JSON.parse(encoded) as Counts));
    return () => publish(null);
  }, [encoded, publish]);
}

/**
 * Which item is lit, derived from the URL and nothing else.
 *
 * `/recover` and `/migrate` fall through to Posts on purpose, and so does the
 * catch-all `*` route — all three render library screens, and a navigation bar
 * with nothing lit reads as broken rather than as neutral. The three prefixes
 * are matched with a boundary so a future `/shopping-list` cannot light Shop.
 */
export function sectionOf(pathname: string): SectionId {
  if (/^\/shop(\/|$)/.test(pathname)) return 'shop';
  if (/^\/emails(\/|$)/.test(pathname)) return 'emails';
  if (/^\/settings(\/|$)/.test(pathname)) return 'settings';
  return 'posts';
}

/** The breakpoint the drawer takes over at — the same one `BlockMenu` uses. */
const NARROW = '(max-width: 719px)';

export function Sidebar({
  user,
  signOut,
}: {
  /** The signed-in identity, for the footer. */
  user: AuthUser | null;
  /**
   * The sign-out control, handed in rather than imported.
   *
   * `RequireAuth.tsx` renders this component, so reaching back into it for
   * `SignOutButton` would close a module cycle around the one file every
   * authenticated render passes through. It has to be THAT button and not a
   * local reimplementation: it owns the unsent-work confirmation, and a second
   * copy of that question is a second chance to destroy a paragraph that
   * exists nowhere else.
   */
  signOut: ReactNode;
}) {
  const { pathname, search } = useLocation();
  const [settings, update] = useSettings();
  const pinned = settings.sidebarPinned;
  const { counts } = useContext(CountsContext);

  /**
   * DRILLED UP — the one piece of state the rail keeps about itself.
   *
   * Entering a section shows that section's pages, because that is what you are
   * about to navigate among. Back does NOT navigate: you are still on the shop
   * page you were reading, and a Back that also threw away the screen would be
   * a second, worse meaning for the same arrow. It only lifts the rail one level
   * so Posts and Emails are reachable again.
   *
   * Cleared on any path change, which is what makes the next click re-enter:
   * lift to the top list, choose Emails, and the rail is showing Emails' pages
   * by the time that screen paints. Only an explicit Back can set it.
   */
  const [drilledUp, setDrilledUp] = useState(false);

  /*
   * Initial value from `innerWidth` and every value after it from
   * `matchMedia`, exactly as `BlockMenu` does. The first render has to commit
   * a shape before any effect runs, and getting it wrong means the rail paints
   * and then vanishes on a phone.
   */
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 720,
  );
  useEffect(() => {
    /*
     * GUARDED, unlike the identical block in `BlockMenu`, and the difference
     * is blast radius rather than taste. That one runs inside an editor that
     * has already booted, and losing it costs one affordance. This one runs in
     * the first authenticated paint of every route, so a `window.matchMedia`
     * that is not a function — measured: this repo's jsdom has none, which is
     * why `Dashboard.test.tsx` carries a stub — throws inside a passive effect
     * and takes the whole app to the router's error page. The `innerWidth`
     * reading above is already a correct answer; the listener only keeps it
     * correct as the window is dragged.
     */
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(NARROW);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const [drawerOpen, setDrawerOpen] = useState(false);

  const panelRef = useRef<HTMLElement>(null);
  const pullRef = useRef<HTMLButtonElement>(null);

  /**
   * HELD open, which is not the same question as "is wide right now" — the
   * peek is a `:hover`/`:focus-within` rule in `sidebar.css` and React never
   * hears about it. This value decides the two things CSS cannot: how far the
   * route column is inset, and whether the icons still need tooltips to say
   * what they are.
   */
  const expanded = narrow ? drawerOpen : pinned;

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    // Focus goes back where it came from. Leaving it on a panel that just slid
    // off screen strands a keyboard user at the top of the document.
    pullRef.current?.focus();
  }, []);

  // Following a link closes the drawer. Deliberately keyed on the path rather
  // than wired into every link's onClick, so a redirect or a programmatic
  // navigate closes it too.
  useEffect(() => setDrawerOpen(false), [pathname]);

  // ...and re-enters the section. See `drilledUp`.
  useEffect(() => setDrilledUp(false), [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') closeDrawer();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen, closeDrawer]);

  // Opening moves focus into the panel, so the next Tab lands on Posts rather
  // than on whatever was behind the scrim.
  useEffect(() => {
    if (drawerOpen) panelRef.current?.focus();
  }, [drawerOpen]);

  /**
   * Tab wraps inside the open drawer.
   *
   * Not a full focus trap and not `role="dialog"`: this is the app's
   * navigation landmark, and announcing it as a modal would cost a screen
   * reader user the ability to jump to it the ordinary way. Wrapping Tab is
   * the part that actually matters for a sighted keyboard user, who otherwise
   * tabs straight through the scrim into content they cannot see.
   */
  const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Tab' || !narrow || !drawerOpen) return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled])');
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    const on = document.activeElement;
    if (e.shiftKey && (on === first || on === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && on === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const active = sectionOf(pathname);
  const pages = SECTION_PAGES[active];

  return (
    <>
      {/*
        THE DRAWER'S HANDLE, AND WHY IT IS ON THE EDGE RATHER THAN IN A CORNER.
        Every fixed thing already on screen is anchored top or bottom: the
        dashboard masthead, the sticky `.settings__bar`, the reader's bar, and
        the toast stack at `bottom: var(--s5)` spanning nearly the full width
        at 375px. A hamburger in either corner lands on top of one of them, and
        none of those files are this component's to move. The left edge at
        mid-height is the one region nothing else claims, and a tab pulling out
        of the edge is what a drawer looks like anyway.
      */}
      {narrow && (
        <button
          ref={pullRef}
          className="shell__pull"
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <PanelLeft className="ui-ic" aria-hidden="true" />
        </button>
      )}

      {narrow && drawerOpen && (
        <div className="shell__scrim" onClick={closeDrawer} aria-hidden="true" />
      )}

      <aside
        ref={panelRef}
        className="sidebar"
        aria-label="Sections"
        data-mode={narrow ? 'drawer' : 'rail'}
        data-expanded={expanded}
        data-pinned={pinned}
        data-open={drawerOpen}
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
      >
        <div className="sidebar__head">
          {narrow ? (
            <button className="sidebar__toggle" onClick={closeDrawer}>
              <X className="ui-ic" aria-hidden="true" />
              <span className="sidebar__label">Close</span>
            </button>
          ) : (
            <RailToggle
              pinned={pinned}
              expanded={expanded}
              onToggle={() => update({ sidebarPinned: !pinned })}
            />
          )}
        </div>

        <nav className="sidebar__nav">
          {pages && !drilledUp ? (
            <>
              {/*
                THE WAY BACK UP, and it is a button rather than a link because
                it navigates nowhere — see `drilledUp`. It carries the section's
                own name so the rail always says which set of pages is below it;
                a bare arrow in a 56px rail is an arrow to nothing in particular.
              */}
              <button
                className="sidebar__back"
                onClick={() => setDrilledUp(true)}
                aria-label={`Leave ${sectionLabel(active)} — show all sections`}
              >
                <ChevronLeft className="ui-ic sidebar__icon" aria-hidden="true" />
                <span className="sidebar__label">{sectionLabel(active)}</span>
              </button>

              <ul className="sidebar__list">
                {pages.map((p) => (
                  <li key={p.key}>
                    <PageLink
                      page={p}
                      href={pageHref(p, search)}
                      active={isPageActive(p, pathname, search)}
                      expanded={expanded}
                      count={counts[p.key]}
                    />
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <ul className="sidebar__list">
              {SECTIONS.map((s) => (
                <li key={s.id}>
                  <SectionLink section={s} active={active === s.id} expanded={expanded} />
                </li>
              ))}
            </ul>
          )}

          {/* Settings sits at the bottom with the identity it configures,
              rather than in the list of places you go to do work. */}
          <ul className="sidebar__list sidebar__list--foot">
            <li>
              <SectionLink
                section={SETTINGS_SECTION}
                active={active === 'settings'}
                expanded={expanded}
              />
            </li>
          </ul>
        </nav>

        <div className="sidebar__foot">
          {/* `user` is null only in states `RequireAuth` never renders children
              for, so this is a type guard rather than a screen anyone sees. */}
          {user && <Identity user={user} expanded={expanded} />}
          {signOut}
        </div>
      </aside>
    </>
  );
}

/** Pin or unpin. `aria-pressed` because it is a toggle, not a navigation. */
function RailToggle({
  pinned,
  expanded,
  onToggle,
}: {
  pinned: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const label = pinned ? 'Unpin sidebar' : 'Pin sidebar';
  const button = (
    <button className="sidebar__toggle" aria-pressed={pinned} onClick={onToggle}>
      {pinned ? (
        <PanelLeftClose className="ui-ic" aria-hidden="true" />
      ) : (
        <PanelLeft className="ui-ic" aria-hidden="true" />
      )}
      <span className="sidebar__label">{label}</span>
    </button>
  );
  return expanded ? button : <Tooltip label={label} side="right">{button}</Tooltip>;
}

const sectionLabel = (id: SectionId): string =>
  id === 'settings'
    ? SETTINGS_SECTION.label
    : (SECTIONS.find((s) => s.id === id)?.label ?? 'Sections');

/**
 * Which page inside the section is lit.
 *
 * TWO RULES, because the Posts pages are not routes. Shop and Emails have a
 * path each, so an exact path match is the answer. The dashboard's five are one
 * route with a `?status=`, so they compare on that param — and the empty status
 * is "All", which is why the default is `''` rather than absent.
 */
function isPageActive(page: SectionPage, pathname: string, search: string): boolean {
  if (page.status !== undefined) {
    if (pathname !== '/') return false;
    return (new URLSearchParams(search).get('status') ?? '') === page.status;
  }
  return pathname === page.to;
}

/**
 * Where a page item actually points.
 *
 * THE POSTS FILTERS CARRY THE REST OF THE QUERY, which the tab row they replace
 * did through `writeFilters`. Switching from Drafts to Published with "neon" in
 * the search box and a category chosen has to keep both, or the rail becomes a
 * way to silently clear filters somebody set two clicks ago. `status=all` is
 * dropped rather than written, so `/` stays clean — the same rule the dashboard
 * applies to every default.
 *
 * Shop and Emails pages are plain routes and carry nothing: their filters are
 * per-screen and a cursor from the orders list means nothing on customers.
 */
function pageHref(page: SectionPage, search: string): string {
  if (page.status === undefined) return page.to;
  const next = new URLSearchParams(search);
  if (page.status === '') next.delete('status');
  else next.set('status', page.status);
  // A cursor is a position in one ordering of one filter; carrying it into a
  // different tab is page two of a list nobody asked for.
  next.delete('cursor');
  const qs = next.toString();
  return qs === '' ? '/' : `/?${qs}`;
}

function PageLink({
  page,
  href,
  active,
  expanded,
  count,
}: {
  page: SectionPage;
  href: string;
  active: boolean;
  expanded: boolean;
  count?: number;
}) {
  const link = (
    <Link
      className={`sidebar__item sidebar__item--page${active ? ' is-active' : ''}`}
      to={href}
      aria-current={active ? 'page' : undefined}
    >
      {/* A dot where the section icons are, so the two levels line up on the
          same 56px grid and the collapsed rail still shows SOMETHING per item
          rather than a column of clipped words. */}
      <span className="sidebar__dot ui-ic" aria-hidden="true" />
      <span className="sidebar__label">{page.label}</span>
      {count !== undefined && (
        <span className="sidebar__count sidebar__label">{count}</span>
      )}
    </Link>
  );
  const tip = count === undefined ? page.label : `${page.label} · ${count}`;
  return expanded ? link : <Tooltip label={tip} side="right">{link}</Tooltip>;
}

function SectionLink({
  section,
  active,
  expanded,
}: {
  section: Section;
  active: boolean;
  expanded: boolean;
}) {
  const Icon = section.icon;
  const link = (
    <Link
      className={`sidebar__item${active ? ' is-active' : ''}`}
      to={section.to}
      aria-current={active ? 'page' : undefined}
    >
      <Icon className="ui-ic sidebar__icon" aria-hidden="true" />
      {/* The label is never removed from the DOM, only clipped — `display:
          none` would take it out of the accessibility tree and leave every
          item in the collapsed rail with no name at all. */}
      <span className="sidebar__label">{section.label}</span>
    </Link>
  );
  // A tooltip is the collapsed rail's only way to say what an icon means. Once
  // the word is on screen next to it, repeating it is noise a mouse user has
  // to sit through.
  return expanded ? link : <Tooltip label={section.label} side="right">{link}</Tooltip>;
}

function Identity({ user, expanded }: { user: AuthUser; expanded: boolean }) {
  const name = user.displayName || user.email;
  const block = (
    <div className="sidebar__id">
      <span className="sidebar__avatar" aria-hidden="true">
        {initials(name)}
      </span>
      {/* `sidebar__label` too, so the two lines fade with every other word in
          the rail instead of leaking a sliver of an email address past the
          56px edge. */}
      <span className="sidebar__idtext sidebar__label">
        <span className="sidebar__name">{name}</span>
        <span className="sidebar__email">{user.email}</span>
      </span>
    </div>
  );
  return expanded ? (
    block
  ) : (
    <Tooltip label={`${name} · ${user.email}`} side="right">
      {block}
    </Tooltip>
  );
}

/**
 * Up to two initials from a display name, falling back to the first letter of
 * whatever we were given. Deliberately not a generated avatar image: the rail
 * has to render offline from cache, and a remote gravatar would be a hole in
 * the one screen that must always paint.
 */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]![0]!;
  const last = parts.length > 1 ? parts[parts.length - 1]![0]! : '';
  return (first + last).toUpperCase();
}

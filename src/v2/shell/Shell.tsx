import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { CircleAlert, CornerDownRight, LogOut, Menu as MenuIcon, Search } from 'lucide-react';
import { NAV, NAV_FOOT, type NavEntry } from './nav';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu';
import { logout } from '../../data/session';
import { brand } from '../../brand';
import { AlertsBell } from './Alerts';
import { Palette } from './Palette';

/**
 * The application frame: dark topbar over a light rail and the working area.
 *
 * TOPBAR LAYOUT, second pass: wordmark left, search centre, bell and the
 * person right — and nothing else. The first pass put a store-switcher chip on
 * the right because the reference admin has one; the reference admin manages
 * many stores and this one manages exactly one, so the chip was chrome
 * borrowed without its reason. The wordmark is the store.
 *
 * The wordmark is `brand.assets.logoDark` — the artwork drawn FOR dark
 * surfaces — because this bar is the one dark surface in the system. v1 lets
 * CSS pick between the two variants per theme; v2 is light-only with a dark
 * bar, so the choice is static and made here.
 */

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (parts.length === 0) return 'PS';
  return parts.map((p) => p[0]!.toUpperCase()).join('');
}

/** A section is current when the URL is it OR sits under it. Compared on a
 *  segment boundary, so `/products` does not light up for `/products-archive`
 *  — the bug a bare `startsWith` always eventually produces. */
function isSectionActive(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}

function NavItem({ entry, pathname }: { entry: NavEntry; pathname: string }) {
  const active = isSectionActive(pathname, entry.to);
  /* ONE PILL, EVER. When a CHILD route is current, the child alone carries the
     white pill and the parent drops to plain dark text — the reference's rule,
     which the last pass got wrong by lighting both. The parent keeps its pill
     for its own screen AND its detail pages (an order, a product), which
     belong to no child. */
  const childActive = Boolean(entry.children?.some((c) => isSectionActive(pathname, c.to)));
  const cls = !active ? 'side__link' : childActive ? 'side__link is-section' : 'side__link is-active';
  return (
    <div>
      <NavLink
        to={entry.to}
        className={cls}
        title={entry.soon ? `${entry.label} — not redesigned yet` : undefined}
      >
        {entry.icon}
        <span className="side__label">{entry.label}</span>
        {entry.soon ? (
          <>
            <span className="side__soon" aria-hidden="true" />
            <span className="sr">(not redesigned yet)</span>
          </>
        ) : null}
      </NavLink>
      {active && entry.children ? (
        <div className="side__sub">
          {entry.children.map((child) => (
            <NavLink
              key={child.to}
              to={child.to}
              className={({ isActive }) => (isActive ? 'side__sublink is-active' : 'side__sublink')}
              title={child.soon ? `${child.label} — not redesigned yet` : undefined}
            >
              {/* The ↳. Rendered for every child and revealed by state — full
                  on the current one, faint on hover — so the row you are on
                  reads as "inside this section" the way the reference draws
                  it, without a tree control. */}
              <CornerDownRight className="side__arrow" aria-hidden="true" />
              <span className="side__label">{child.label}</span>
              {child.soon ? (
                <>
                  <span className="side__soon" aria-hidden="true" />
                  <span className="sr">(not redesigned yet)</span>
                </>
              ) : null}
            </NavLink>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Shell({ storeName, userName }: { storeName: string; userName: string }) {
  const { pathname } = useLocation();
  const [railOpen, setRailOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  /* Ctrl+K / ⌘K from anywhere in the app. The palette's own Escape handling
     lives with the palette; this only opens. */
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  /* ═══ THE DRAWER CLOSES ITSELF ═══ On a phone the rail is an overlay, and an
     overlay that outlives the tap that used it is the bug the owner named:
     pick "Orders", arrive on Orders, and the menu is still covering it. The
     pathname IS the signal a navigation happened — including a tap on the row
     for the screen you are already on, which `NavLink` does not re-path, so
     that case closes via the nav's own click handler below instead. */
  useEffect(() => {
    setRailOpen(false);
  }, [pathname]);

  /* A new screen starts at its top. The scroll container is `.main`, not the
     window, so the browser's own restoration never sees it — without this a
     phone user who taps through from the bottom of a long form lands mid-way
     down the next list and reads it as missing rows. (Caught by the mobile
     pass: Orders opened at its skeleton's waist.) */
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    mainRef.current?.scrollTo(0, 0);
  }, [pathname]);

  /* Escape closes the drawer, from anywhere — same contract as every panel. */
  useEffect(() => {
    if (!railOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setRailOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [railOpen]);

  /* The page behind an open drawer must not scroll under it. Only the mobile
     layout ever sets `railOpen` (the burger does not exist on desktop), so
     locking on the flag alone cannot bite a desktop session. */
  useEffect(() => {
    if (!railOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [railOpen]);

  return (
    <div className="shell">
      <header className="top">
        <div className="row">
          <button
            type="button"
            className="top__icon top__burger"
            aria-label="Toggle navigation"
            aria-expanded={railOpen}
            onClick={() => setRailOpen((v) => !v)}
          >
            <MenuIcon aria-hidden="true" />
          </button>
          <Link to="/home" className="top__brand">
            {brand.assets.logoDark ? (
              <img src={brand.assets.logoDark} alt={brand.name} />
            ) : (
              <span style={{ color: 'var(--topbar-ink-strong)', fontWeight: 'var(--w-bold)' }}>
                {brand.name}
              </span>
            )}
          </Link>
        </div>

        {/* The search HANDLE — a button drawn as the field it opens. The real
            input lives in the palette, so focus goes straight there. */}
        <div className="top__search">
          <button
            type="button"
            className="top__searchbtn"
            aria-label="Search (Ctrl+K)"
            aria-haspopup="dialog"
            onClick={() => setSearchOpen(true)}
          >
            <Search aria-hidden="true" />
            <span className="top__ghost">Search</span>
            <span aria-hidden="true" style={{ display: 'flex', gap: 2 }}>
              <kbd>Ctrl</kbd>
              <kbd>K</kbd>
            </span>
          </button>
        </div>

        <div className="top__end">
          <AlertsBell />
          <Menu
            tone="plain"
            chrome="bare"
            label={
              <span className="top__user" aria-hidden="true">
                {initials(userName || storeName)}
              </span>
            }
            buttonLabel="Account"
          >
            {(close) => (
              <>
                <div style={{ padding: 'var(--s2)', fontSize: 'var(--t-sm)', color: 'var(--ink-sub)' }}>
                  Signed in as{' '}
                  <strong style={{ color: 'var(--ink)', fontWeight: 'var(--w-semi)' }}>{userName}</strong>
                </div>
                <MenuSeparator />
                <MenuItem
                  icon={<LogOut aria-hidden="true" />}
                  onSelect={() => {
                    close();
                    void logout({ confirmed: true });
                  }}
                >
                  Sign out
                </MenuItem>
              </>
            )}
          </Menu>
        </div>
      </header>

      <div className="shell__body">
        {/* The scrim: mobile-only (display gated in CSS), tap-to-close, and a
            real button so it is reachable and labelled rather than a div with
            a click handler. */}
        {railOpen ? (
          <button
            type="button"
            className="shell__scrim"
            aria-label="Close navigation"
            onClick={() => setRailOpen(false)}
          />
        ) : null}
        <nav
          className={railOpen ? 'side is-open' : 'side'}
          aria-label="Sections"
          onClick={(event) => {
            /* A tap on any nav LINK closes the drawer — including the link for
               the page already on screen, where the pathname effect above never
               fires because nothing navigated. */
            if ((event.target as HTMLElement).closest('a')) setRailOpen(false);
          }}
        >
          {NAV.map((entry) => (
            <NavItem key={entry.to} entry={entry} pathname={pathname} />
          ))}
          <div className="side__foot">
            {NAV_FOOT.map((entry) => (
              <NavItem key={entry.to} entry={entry} pathname={pathname} />
            ))}
            {/* The one place the version is stated — the anchor for "which one
                am I looking at" while both UIs exist. */}
            <div
              className="row"
              style={{
                marginTop: 'var(--s3)',
                padding: '0 var(--s2)',
                fontSize: 'var(--t-sm)',
                color: 'var(--ink-muted)',
                gap: 'var(--s1)',
              }}
            >
              <CircleAlert size={13} aria-hidden="true" />
              Admin UI v2
            </div>
          </div>
        </nav>

        <main className="main" ref={mainRef}>
          <Outlet />
        </main>
      </div>

      <Palette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

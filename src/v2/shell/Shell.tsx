import { useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Bell, CircleAlert, CornerDownRight, LogOut, Menu as MenuIcon, Search } from 'lucide-react';
import { NAV, NAV_FOOT, type NavEntry } from './nav';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu';
import { logout } from '../../data/session';
import { brand } from '../../brand';

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

        {/* Presentational for now, and it says so: the control is disabled
            rather than accepting text it cannot search. */}
        <div className="top__search">
          <Search aria-hidden="true" />
          <input
            type="search"
            placeholder="Search"
            aria-label="Search (not wired yet)"
            disabled
            title="Search is not wired up in v2 yet"
          />
          <span className="top__kbd" aria-hidden="true">
            <kbd>Ctrl</kbd>
            <kbd>K</kbd>
          </span>
        </div>

        <div className="top__end">
          <button type="button" className="top__icon" aria-label="Notifications" disabled title="Not wired yet">
            <Bell aria-hidden="true" />
          </button>
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
        <nav className={railOpen ? 'side is-open' : 'side'} aria-label="Sections">
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

        <main className="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

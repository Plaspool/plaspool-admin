import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';

/**
 * The shell's navigation, asserted on the four things that can quietly go
 * wrong and would not be caught by looking at it once:
 *
 * - it opens by itself (a rail that starts expanded is a rail nobody asked
 *   for, and the pin exists precisely so that is a choice);
 * - it appears over the editor (the writing surface is chromeless on purpose,
 *   and `.editor__page` does its own width arithmetic that a 56px inset would
 *   fight);
 * - the drawer cannot be dismissed (Escape is the only exit a keyboard user
 *   has from a panel covering the whole screen);
 * - `aria-current` drifts from the URL, which is invisible to everyone except
 *   the people who most need it.
 */

const fixture = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const box = { session: { status: 'unknown' } as Record<string, unknown> };
  return {
    box,
    listeners,
    set(next: Record<string, unknown>) {
      box.session = next;
      for (const l of listeners) l();
    },
  };
});

vi.mock('../data/session', () => ({
  getSession: () => fixture.box.session,
  subscribe: (l: () => void) => {
    fixture.listeners.add(l);
    return () => fixture.listeners.delete(l);
  },
  initSession: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('../data/sync', () => ({ revalidate: vi.fn() }));

vi.mock('../data/api', () => ({
  AUTH_EXPIRED_EVENT: 'auth-expired',
  api: { login: vi.fn() },
}));

import { readSettings } from '../data/settings';
import { TooltipProvider } from './ui/Switch';
import { AppShell } from './RequireAuth';
import { Sidebar } from './Sidebar';

const WRITER = {
  id: 'u_writer',
  email: 'writer@test.local',
  displayName: 'A Writer',
  role: 'writer' as const,
};

/**
 * The viewport, controlled.
 *
 * jsdom ships a `matchMedia` that answers `false` to everything and an
 * `innerWidth` of 1024, so without this the drawer arm is unreachable — the
 * component would report a desktop rail no matter what the test asked for.
 * Both are set because `Sidebar` reads `innerWidth` for its first render and
 * `matchMedia` for every render after, exactly as `BlockMenu` does.
 */
function setViewport(width: number): void {
  window.innerWidth = width;
  window.matchMedia = ((query: string) => {
    const listeners = new Set<() => void>();
    return {
      get matches() {
        const max = /max-width:\s*(\d+)px/.exec(query);
        return max ? width <= Number(max[1]) : false;
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    };
  }) as unknown as typeof window.matchMedia;
}

/** The sidebar on its own, which is how it is written: props in, markup out. */
function mount(initial = '/dashboard') {
  render(
    <TooltipProvider>
      <MemoryRouter initialEntries={[initial]}>
        <Sidebar user={WRITER} signOut={<button>Sign out</button>} />
      </MemoryRouter>
    </TooltipProvider>,
  );
  return screen.getByRole('complementary', { name: 'Sections' });
}

/** The whole shell, which is the only place the route decision is made. */
function mountShell(initial: string) {
  const router = createMemoryRouter(
    [
      {
        element: <AppShell />,
        children: [
          { path: '/dashboard', element: <p>THE DASHBOARD</p> },
          { path: '/edit/:id', element: <p>THE EDITOR</p> },
          { path: '/read/:id', element: <p>THE READER</p> },
          { path: '/settings', element: <p>THE SETTINGS</p> },
        ],
      },
    ],
    { initialEntries: [initial] },
  );
  render(
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  cleanup();
  fixture.listeners.clear();
  fixture.box.session = { status: 'authed', user: WRITER };
  localStorage.clear();
  setViewport(1280);
});

describe('the resting state', () => {
  it('is collapsed, on a fresh browser with nothing stored', () => {
    const rail = mount();

    expect(rail.getAttribute('data-expanded')).toBe('false');
    expect(rail.getAttribute('data-pinned')).toBe('false');
  });

  it('still names every item while collapsed', async () => {
    mount();

    /*
     * The point of the assertion is the accessibility tree, not the pixels.
     * `display: none` on the labels would collapse the rail just as neatly and
     * leave every link called nothing — the failure the tooltips paper over
     * for sighted users and for nobody else.
     *
     * The rail opens INSIDE a section now, so at `/` these are the Posts pages.
     * The three section links are one Back away, and are asserted there.
     */
    expect(screen.getByRole('link', { name: /^All/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /^Drafts/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /show all sections/i }));

    expect(screen.getByRole('link', { name: 'Posts' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Shop' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Emails' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeTruthy();
  });

  it('shows the pages of the section you are in, not the sections', () => {
    mount('/shop/orders');

    // The rail IS the shop's navigation now; the tab strip these replace is
    // gone from all four shop screens.
    expect(screen.getByRole('link', { name: 'Overview' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Products' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Orders' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Customers' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Emails' })).toBeNull();
  });

  it('names the section on the way back up, and does not navigate', async () => {
    mount('/shop/orders');

    const back = screen.getByRole('button', { name: /show all sections/i });
    // It says which set of pages it is closing. A bare arrow in a 56px rail is
    // an arrow to nothing in particular.
    expect(back.textContent).toContain('Shop');

    await userEvent.click(back);

    // The three sections are reachable again...
    expect(screen.getByRole('link', { name: 'Posts' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Emails' })).toBeTruthy();
    // ...and Shop is still lit, because Back lifts the rail without moving you
    // off the page you were reading.
    expect(screen.getByRole('link', { name: 'Shop' }).getAttribute('aria-current')).toBe('page');
  });

  it('goes back into the section you are standing in, and keeps the filter', async () => {
    mount('/dashboard?status=draft');
    await userEvent.click(screen.getByRole('button', { name: /show all sections/i }));

    await userEvent.click(screen.getByRole('button', { name: 'Show Posts pages' }));

    expect(screen.getByRole('link', { name: /^Published/ })).toBeTruthy();
    // Still on Drafts. The chevron only lifts the rail back down a level — the
    // Posts LINK beside it would have navigated to the unfiltered dashboard,
    // which is why re-entering is not that link's job.
    expect(screen.getByRole('link', { name: /^Drafts/ }).getAttribute('aria-current')).toBe('page');
  });

  it('re-enters on the section link too, which navigates nowhere new', async () => {
    mount('/dashboard');
    await userEvent.click(screen.getByRole('button', { name: /show all sections/i }));

    // Posts from `/dashboard` changes neither the path nor the query, so the
    // effect that normally drops the rail back into a section never runs. Left
    // to it, the five filters were unreachable until the page was reloaded —
    // the section you are standing in was the one section you could not open.
    await userEvent.click(screen.getByRole('link', { name: 'Posts' }));

    expect(screen.getByRole('link', { name: /^Drafts/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /^Published/ })).toBeTruthy();
  });

  it('carries the rest of the query across a Posts filter', () => {
    // The tab row it replaces did this through `writeFilters`. Switching from
    // Drafts to Published with a search and a category set has to keep both, or
    // the rail becomes a way to silently clear filters set two clicks ago.
    mount('/dashboard?status=draft&q=neon&category=Tech');

    const href = screen.getByRole('link', { name: /^Published/ }).getAttribute('href') || '';
    expect(href).toContain('status=published');
    expect(href).toContain('q=neon');
    expect(href).toContain('category=Tech');

    // `all` drops the param rather than writing `status=all`.
    expect(
      screen.getByRole('link', { name: /^All/ }).getAttribute('href'),
    ).not.toContain('status=');
  });

  it('carries the signed-in identity and the sign-out it was given', () => {
    mount();

    expect(screen.getByText(WRITER.email)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });
});

describe('pinning', () => {
  it('expands the rail and says so on the toggle', async () => {
    const rail = mount();

    await userEvent.click(screen.getByRole('button', { name: 'Pin sidebar' }));

    expect(rail.getAttribute('data-expanded')).toBe('true');
    expect(rail.getAttribute('data-pinned')).toBe('true');
    const toggle = screen.getByRole('button', { name: 'Unpin sidebar' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  it('writes through to the settings object the rest of the app reads', async () => {
    mount();

    await userEvent.click(screen.getByRole('button', { name: 'Pin sidebar' }));

    // The existing per-device preference document, not a key of its own: the
    // rail's width decides how much room the route gets, so it has to be
    // readable in the same synchronous read as the theme.
    expect(readSettings().sidebarPinned).toBe(true);
  });

  it('starts expanded when the stored settings say it was pinned', () => {
    localStorage.setItem(
      'blog-admin:settings',
      JSON.stringify({ ...readSettings(), sidebarPinned: true }),
    );

    expect(mount().getAttribute('data-expanded')).toBe('true');
  });

  it('unpins back to the rail', async () => {
    const rail = mount();
    await userEvent.click(screen.getByRole('button', { name: 'Pin sidebar' }));

    await userEvent.click(screen.getByRole('button', { name: 'Unpin sidebar' }));

    expect(rail.getAttribute('data-expanded')).toBe('false');
    expect(readSettings().sidebarPinned).toBe(false);
  });
});

describe('which routes get chrome', () => {
  it('shows the sidebar on the dashboard', async () => {
    mountShell('/dashboard');

    expect(await screen.findByText('THE DASHBOARD')).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Sections' })).toBeTruthy();
  });

  it('hides it on the editor, leaving the writing surface alone', async () => {
    mountShell('/edit/p_1');

    /*
     * Both halves matter. The editor being on screen proves the route
     * rendered rather than the shell having swallowed it, and the missing
     * complementary landmark proves nothing is insetting `.editor__page`,
     * whose width arithmetic is its own and is not this component's to fight.
     */
    expect(await screen.findByText('THE EDITOR')).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: 'Sections' })).toBeNull();
  });

  it('hides it on the reader too', async () => {
    mountShell('/read/p_1');

    expect(await screen.findByText('THE READER')).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: 'Sections' })).toBeNull();
  });

  it('shows it again on settings', async () => {
    mountShell('/settings');

    expect(await screen.findByText('THE SETTINGS')).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Sections' })).toBeTruthy();
  });
});

describe('the drawer, under 720px', () => {
  beforeEach(() => setViewport(375));

  it('starts closed, with a handle to open it', () => {
    const rail = mount();

    expect(rail.getAttribute('data-mode')).toBe('drawer');
    expect(rail.getAttribute('data-open')).toBe('false');
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeTruthy();
  });

  it('opens onto a scrim', async () => {
    const rail = mount();

    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));

    expect(rail.getAttribute('data-open')).toBe('true');
    expect(rail.getAttribute('data-expanded')).toBe('true');
  });

  it('closes on Escape', async () => {
    const rail = mount();
    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));

    await userEvent.keyboard('{Escape}');

    // A panel covering a 375px screen with no keyboard exit is a trap, and it
    // is a trap that only shows up for the people who cannot click the scrim.
    expect(rail.getAttribute('data-open')).toBe('false');
  });

  it('closes on the close button, and puts focus back on the handle', async () => {
    const rail = mount();
    const handle = screen.getByRole('button', { name: 'Open navigation' });
    await userEvent.click(handle);

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(rail.getAttribute('data-open')).toBe('false');
    // Focus left on a panel that just slid off screen strands a keyboard user
    // at the top of the document with no idea where they are.
    expect(document.activeElement).toBe(handle);
  });

  it('closes on a Posts filter, which changes only the query', async () => {
    const rail = mount('/dashboard');
    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));

    await userEvent.click(screen.getByRole('link', { name: /^Drafts/ }));

    // The five Posts filters are one route with a `?status=`, so a close keyed
    // on the path alone left the drawer sitting over the list it had just
    // filtered — on the section the rail is used most for, and only on a phone.
    expect(rail.getAttribute('data-open')).toBe('false');
  });

  it('offers no handle once the window is wide again', () => {
    setViewport(1280);
    const rail = mount();

    expect(rail.getAttribute('data-mode')).toBe('rail');
    expect(screen.queryByRole('button', { name: 'Open navigation' })).toBeNull();
  });
});

describe('aria-current follows the route', () => {
  /** The sections are one Back away now — see `drilledUp` in `Sidebar.tsx`. */
  const drillUp = async () =>
    userEvent.click(screen.getByRole('button', { name: /show all sections/i }));

  it('marks Posts at the root', async () => {
    mount('/dashboard');
    await drillUp();

    expect(screen.getByRole('link', { name: 'Posts' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Shop' }).getAttribute('aria-current')).toBeNull();
  });

  it('marks the page you are on inside the section', () => {
    mount('/shop/orders');

    expect(screen.getByRole('link', { name: 'Orders' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Products' }).getAttribute('aria-current')).toBeNull();
  });

  it('marks the Posts filter the URL is showing', () => {
    mount('/dashboard?status=draft');

    expect(screen.getByRole('link', { name: /^Drafts/ }).getAttribute('aria-current')).toBe('page');
    // `All` is the empty status, so it must not also light up.
    expect(screen.getByRole('link', { name: /^All/ }).getAttribute('aria-current')).toBeNull();
  });

  it('marks Shop on a shop child route, not only on its index', async () => {
    mount('/shop/orders');
    await drillUp();

    expect(screen.getByRole('link', { name: 'Shop' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Posts' }).getAttribute('aria-current')).toBeNull();
  });

  it('marks Emails on a broadcast route, though the link points at templates', async () => {
    mount('/emails/broadcasts');
    await drillUp();

    const emails = screen.getByRole('link', { name: 'Emails' });
    expect(emails.getAttribute('aria-current')).toBe('page');
    expect(emails.getAttribute('href')).toContain('/emails/templates');
  });

  it('marks Settings on the settings route', () => {
    mount('/settings');

    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('falls back to Posts on the library-adjacent routes', async () => {
    // `/recover` and `/migrate` are reached from the library and render
    // library screens, and so does the catch-all. Lighting nothing on them
    // would read as the navigation being broken rather than as neutrality.
    mount('/recover');
    await drillUp();

    expect(screen.getByRole('link', { name: 'Posts' }).getAttribute('aria-current')).toBe('page');
  });
});

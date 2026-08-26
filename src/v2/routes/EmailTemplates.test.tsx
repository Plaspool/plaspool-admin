import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

/**
 * The templates screen, pinned on the one rule that decides whether mass mail
 * may leave at all: `missingUnsubscribe`.
 *
 * The client's copy of the rule (`src/data/api-email.ts`) exists so the refusal
 * is visible WHILE the template is written rather than at the moment somebody
 * reaches for Send — which means the thing to test is that the copy actually
 * matches the server's rule (`server/routes/email.ts` `assertSendable`) instead
 * of a plausible approximation of it. The fixture set is built to defeat each
 * approximation separately:
 *
 *  - **"Either body is enough."** `htmlOnly` carries the link in its HTML part
 *    and not its text part. The server requires BOTH — a reader whose client
 *    shows the text part has no unsubscribe link that lives only in the HTML —
 *    so the row must flag.
 *  - **"System templates flag like everything else."** `confirmation` is
 *    `order.confirmation` with no link anywhere. Transactional mail is exempt —
 *    flagging all the defaults would put a permanent warning on screen that an
 *    operator learns to ignore — so the row must read Ready.
 *  - **"ALL system templates are exempt."** `welcome` is `account.welcome`
 *    with no link, and it must STILL flag: it is the one system template that
 *    genuinely subscribes, and an owner who edits the link out has to see so.
 *
 * `fetch` IS STUBBED, NOT `../../data/api-email`, per the section's canonical
 * harness (`src/routes/MarketingRewards.test.tsx`): the path, the method and
 * the body are the things most likely to be silently wrong, and a mocked
 * module asserts none of them.
 */

vi.setConfig({ testTimeout: 20_000 });

const fixture = vi.hoisted(() => ({
  session: {
    status: 'authed',
    user: {
      id: 'u_owner',
      email: 'o@test.local',
      displayName: 'An Owner',
      role: 'owner' as 'owner' | 'writer',
    },
  },
}));

vi.mock('../../data/session', () => ({
  getSession: () => fixture.session,
  subscribe: () => () => {},
  initSession: vi.fn(),
  logout: vi.fn(),
}));

import { ToastHost } from '../ui/Toast';
import type { EmailTemplate } from '../../data/api-email';
import EmailTemplates from './EmailTemplates';

/**
 * What jsdom does not implement and the v2 chrome touches — `ResizeObserver`
 * is the one `TableScroll` actually constructs; the rest are the harness's
 * standard three blocks, kept identical across the section's suites.
 */
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
const dialogProto = Object.getPrototypeOf(document.createElement('dialog'));
dialogProto.showModal = function (this: HTMLDialogElement) {
  this.open = true;
};
dialogProto.close = function (this: HTMLDialogElement) {
  this.open = false;
};

// --------------------------------------------------------------- the server

type Responder = (url: URL, init: RequestInit) => { status?: number; body: unknown };

const handlers = new Map<string, Responder>();
let calls: { path: string; init: RequestInit }[] = [];

/** Register a route. Anything unregistered answers 404 `gone`, like the app. */
function when(pathname: string, respond: Responder): void;
function when(pathname: string, body: unknown, status?: number): void;
function when(pathname: string, body: unknown, status = 200): void {
  handlers.set(
    pathname,
    typeof body === 'function' ? (body as Responder) : () => ({ status, body }),
  );
}

/** GETs of exactly this path. */
const reads = (pathname: string): number =>
  calls.filter((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === 'GET')
    .length;

/** Every request that was not a read — the live check must produce none. */
const writes = (): { path: string; init: RequestInit }[] =>
  calls.filter((c) => (c.init.method ?? 'GET') !== 'GET');

beforeEach(() => {
  handlers.clear();
  calls = [];
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init: RequestInit = {}) => {
      const url = new URL(String(input), 'https://studio.test');
      calls.push({ path: url.pathname + url.search, init });
      const handler = handlers.get(url.pathname);
      const answer = handler
        ? handler(url, init)
        : { status: 404, body: { error: 'gone', requestId: 'req_test' } };
      return new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  fixture.session.user.role = 'owner';
});

// -------------------------------------------------------------- the fixtures

const NOW = Date.UTC(2026, 7, 26, 12, 0, 0);

/** The variable, spelled once — the same literal the client rule scans for. */
const UNSUB = '{{unsubscribe_url}}';

const tpl = (
  over: Partial<EmailTemplate> & Pick<EmailTemplate, 'id' | 'name'>,
): EmailTemplate => ({
  subject: `${over.name} subject`,
  html: '<p>hello {{name}}</p>',
  text: 'hello {{name}}',
  updatedAt: NOW - 86_400_000,
  updatedBy: 'o@test.local',
  systemKey: null,
  ...over,
});

/** The link in BOTH bodies — the only state a broadcast may leave from. */
const ready = tpl({
  id: 'tpl_ready',
  name: 'August Restock News',
  subject: 'Fresh drums are back',
  html: `<p>Hello {{name}}</p><p><a href="${UNSUB}">Unsubscribe</a></p>`,
  text: `Hello {{name}}\n\nUnsubscribe: ${UNSUB}`,
});

/** The trap the both-bodies rule exists for: the link in the HTML part ONLY. */
const htmlOnly = tpl({
  id: 'tpl_htmlonly',
  name: 'Harmattan Promo',
  subject: 'Cold-season prices',
  html: `<p>Deals.</p><a href="${UNSUB}">out</a>`,
  text: 'Deals. No way out written down here.',
});

/** A transactional default with no link anywhere — exempt, deliberately. */
const confirmation = tpl({
  id: 'tpl_confirm',
  name: 'Order confirmation',
  subject: 'Your order is confirmed',
  html: '<p>Order confirmed, {{name}}.</p>',
  text: 'Order confirmed.',
  systemKey: 'order.confirmation',
});

/** `account.welcome` with no link — the one system template that must flag. */
const welcome = tpl({
  id: 'tpl_welcome',
  name: 'Welcome',
  subject: 'Welcome to the list',
  html: '<p>Welcome, {{name}}!</p>',
  text: 'Welcome aboard!',
  systemKey: 'account.welcome',
});

const templates = [ready, htmlOnly, confirmation, welcome];

const TEMPLATES = '/api/admin/email/templates';

function withTemplates(rows: EmailTemplate[] = templates): void {
  when(TEMPLATES, { items: rows });
}

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/emails/templates']}>
        <EmailTemplates />
      </MemoryRouter>
    </ToastHost>,
  );
}

/** A template's list row, found through its name cell. */
const rowOf = (t: EmailTemplate): HTMLElement => {
  const found = screen.getByText(t.name).closest('tr');
  if (found === null) throw new Error(`no row for ${t.name}`);
  return found as HTMLElement;
};

// ============================================================================

describe('the email templates screen', () => {
  it('flags exactly the templates the server would refuse to broadcast from', async () => {
    withTemplates();
    mount();
    await screen.findByText('August Restock News');

    /*
     * TWO FLAGS, and they sit on `htmlOnly` and `welcome` — not on the row
     * that merely lacks the link (`confirmation` lacks it too and is exempt),
     * and not sparing the row whose systemKey looks exempt-ish (`welcome`).
     * An implementation that checked one body, skipped the exemption, or
     * exempted every systemKey draws a different set of badges here.
     */
    expect(screen.getAllByText('No unsubscribe link')).toHaveLength(2);
    expect(within(rowOf(htmlOnly)).getByText('No unsubscribe link')).toBeTruthy();
    expect(within(rowOf(welcome)).getByText('No unsubscribe link')).toBeTruthy();

    expect(within(rowOf(ready)).getByText('Ready')).toBeTruthy();
    expect(within(rowOf(confirmation)).getByText('Ready')).toBeTruthy();
  });

  it('warns live in the editor when one body loses the link, and clears when it returns — with nothing saved', async () => {
    const user = userEvent.setup();
    withTemplates();
    mount();

    await user.click(await screen.findByText('August Restock News'));
    await screen.findByRole('dialog');

    // Both bodies carry the link, so the editor opens quiet.
    expect(screen.queryByText('Not broadcastable yet')).toBeNull();

    /*
     * Empty the PLAIN-TEXT body while the HTML part keeps its link. One body
     * is not enough — both parts are delivered — so the warning must appear,
     * and it must appear from the boxes' own state: nothing has been saved and
     * nothing may be fetched to decide it.
     */
    const text = screen.getByLabelText('Plain-text body');
    await user.clear(text);
    expect(await screen.findByText('Not broadcastable yet')).toBeTruthy();

    await user.click(text);
    await user.paste(`Hello again.\nUnsubscribe: ${UNSUB}`);
    await waitFor(() => expect(screen.queryByText('Not broadcastable yet')).toBeNull());

    // The whole exchange was client-side: one list read, zero writes.
    expect(writes()).toHaveLength(0);
    expect(reads(TEMPLATES)).toBe(1);
  });

  it('keeps the editor quiet for a transactional default and loud for account.welcome', async () => {
    const user = userEvent.setup();
    withTemplates();
    mount();

    /*
     * `order.confirmation` has no link in EITHER body and the editor says
     * nothing: an order confirmation is not marketing, and a warning here
     * would be one the operator can never clear.
     */
    await user.click(await screen.findByText('Order confirmation'));
    const sysDialog = await screen.findByRole('dialog');
    expect(within(sysDialog).getByText('Step 2 — payment confirmed')).toBeTruthy();
    expect(screen.queryByText('Not broadcastable yet')).toBeNull();
    await user.click(within(sysDialog).getByRole('button', { name: 'Cancel' }));

    /*
     * `account.welcome` without the link flags the moment it opens — the one
     * system template that genuinely subscribes is NOT exempt, which is the
     * clause a "systemKey means exempt" implementation drops.
     */
    await user.click(screen.getByText('Welcome'));
    await screen.findByRole('dialog');
    expect(await screen.findByText('Not broadcastable yet')).toBeTruthy();
  });
});

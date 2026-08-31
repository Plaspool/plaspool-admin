import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

/**
 * The broadcasts screen, asserted on its two ways of being quietly dangerous.
 *
 *  - **A composer that offers what the server will refuse.** The send route
 *    rejects any snapshot missing `{{unsubscribe_url}}` from either body, so a
 *    template without it must be a dead control in the picker — visibly dead,
 *    named for why — and `account.welcome` without the link is just as dead,
 *    because the welcome template is NOT exempt from the rule.
 *  - **A confirmation that names the wrong number.** The dialog in front of
 *    the irreversible send must state the broadcast row's own
 *    `recipientCount`. Every other number on this screen is wrong for the
 *    job — the loaded page's length, the audience aggregate, another row's
 *    counters — so the fixtures make every one of them DIFFERENT from the
 *    count, and the dialog is read for the one that survives.
 *
 * `fetch` IS STUBBED, NOT `../../data/api-email`, per the section's canonical
 * harness (`src/routes/MarketingRewards.test.tsx`): the path, the method and
 * the body are what a backend integration gets silently wrong, and a mocked
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
import type { EmailBroadcast, EmailTemplate } from '../../data/api-email';
import EmailBroadcasts from './EmailBroadcasts';

/** The harness's standard jsdom shims — `ResizeObserver` is the one the v2
 *  table chrome actually constructs. */
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

/** The body of the last request to a path with this method. */
function sent(pathname: string, method: string): Record<string, unknown> {
  const call = [...calls]
    .reverse()
    .find((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === method);
  if (call === undefined) throw new Error(`no ${method} to ${pathname}`);
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

/** No write has gone to this path yet — the question has not been answered. */
function sentNothing(pathname: string): boolean {
  return !calls.some(
    (c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') !== 'GET',
  );
}

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

const ready = tpl({
  id: 'tpl_ready',
  name: 'August Restock News',
  subject: 'Fresh drums are back',
  html: `<p>Hello {{name}}</p><p><a href="${UNSUB}">Unsubscribe</a></p>`,
  text: `Hello {{name}}\n\nUnsubscribe: ${UNSUB}`,
});

/** Link in the HTML body only — the server's both-parts rule refuses it. */
const htmlOnly = tpl({
  id: 'tpl_htmlonly',
  name: 'Harmattan Promo',
  subject: 'Cold-season prices',
  html: `<p>Deals.</p><a href="${UNSUB}">out</a>`,
  text: 'Deals. No way out written down here.',
});

/** `account.welcome` with no link — NOT exempt, so just as unpickable. */
const welcome = tpl({
  id: 'tpl_welcome',
  name: 'Welcome',
  subject: 'Welcome to the list',
  html: '<p>Welcome, {{name}}!</p>',
  text: 'Welcome aboard!',
  systemKey: 'account.welcome',
});

const broadcast = (
  over: Partial<EmailBroadcast> & Pick<EmailBroadcast, 'id' | 'subject' | 'status'>,
): EmailBroadcast => ({
  templateId: 'tpl_ready',
  html: `<p>Hi {{name}}</p><a href="${UNSUB}">out</a>`,
  text: `Hi {{name}}\n${UNSUB}`,
  createdBy: 'o@test.local',
  createdAt: NOW - 7_200_000,
  scheduledAt: null,
  startedAt: null,
  finishedAt: null,
  sentCount: 0,
  failedCount: 0,
  recipientCount: 0,
  ...over,
});

/**
 * THE COUNT THE CONFIRMATION MUST NAME — 4183, chosen to collide with nothing:
 * the list below holds THREE rows, the audience says 5000, and every other
 * row's counters are 912 and 40-of-260. Any implementation that reaches for a
 * page length or an aggregate produces a number this suite can see is wrong.
 */
const draft = broadcast({
  id: 'br_draft',
  subject: 'Fresh drums are back',
  status: 'draft',
  recipientCount: 4183,
});

const doneRow = broadcast({
  id: 'br_done',
  subject: 'July clearance',
  status: 'sent',
  startedAt: NOW - 40 * 86_400_000,
  finishedAt: NOW - 40 * 86_400_000 + 3_600_000,
  sentCount: 912,
  recipientCount: 912,
});

const sendingRow = broadcast({
  id: 'br_mid',
  subject: 'Mid-month nudge',
  status: 'sending',
  startedAt: NOW - 3_600_000,
  sentCount: 40,
  recipientCount: 260,
});

const BROADCASTS = '/api/admin/email/broadcasts';
const TEMPLATES = '/api/admin/email/templates';
const AUDIENCE = '/api/admin/email/audience';

/** The list route, and the POST that shares its path. */
function withBroadcasts(rows: EmailBroadcast[], write?: Responder): void {
  when(BROADCASTS, (url, init) =>
    (init.method ?? 'GET') === 'GET'
      ? { body: { items: rows } }
      : (write ?? (() => ({ status: 201, body: { broadcast: draft } })))(url, init),
  );
}

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/emails/broadcasts']}>
        <EmailBroadcasts />
      </MemoryRouter>
    </ToastHost>,
  );
}

// ============================================================================

describe('the broadcasts screen', () => {
  it('offers only templates carrying the unsubscribe link, and snapshots the picked one', async () => {
    const user = userEvent.setup();
    withBroadcasts([]);
    when(AUDIENCE, { subscribed: 5000, suppressed: 77 });
    when(TEMPLATES, { items: [ready, htmlOnly, welcome] });
    mount();

    await user.click(await screen.findByRole('button', { name: 'New newsletter' }));
    await screen.findByText('August Restock News');

    /*
     * The two without the link in both bodies are DEAD controls — disabled,
     * badged, and titled with why — not hidden, and not pickable. `welcome`
     * matters here for the same reason it matters on the templates screen:
     * `account.welcome` is not exempt from the rule.
     */
    const blocked = screen.getByText('Harmattan Promo').closest('button');
    if (blocked === null) throw new Error('no pick control for Harmattan Promo');
    expect(blocked).toHaveProperty('disabled', true);
    expect(within(blocked).getByText('No unsubscribe link')).toBeTruthy();
    expect(blocked.getAttribute('title')).toBe(
      'Both versions need an unsubscribe link before this can be sent',
    );

    const blockedWelcome = screen.getByText('Welcome').closest('button');
    if (blockedWelcome === null) throw new Error('no pick control for Welcome');
    expect(blockedWelcome).toHaveProperty('disabled', true);
    expect(within(blockedWelcome).getByText('No unsubscribe link')).toBeTruthy();

    // A click on the dead control creates nothing.
    await user.click(blocked);
    expect(sentNothing(BROADCASTS)).toBe(true);

    const pickable = screen.getByText('August Restock News').closest('button');
    if (pickable === null) throw new Error('no pick control for August Restock News');
    await user.click(pickable);

    // The create names the template and nothing else — the server snapshots.
    await waitFor(() => expect(sent(BROADCASTS, 'POST')).toEqual({ templateId: 'tpl_ready' }));
    // ...and the draft toast already speaks in the broadcast's own count.
    expect(await screen.findByText('Draft ready — 4183 recipients when you send')).toBeTruthy();
  });

  it('confirms a send with the broadcast’s own recipientCount, never a page length', async () => {
    const user = userEvent.setup();
    withBroadcasts([doneRow, sendingRow, draft]);
    when(AUDIENCE, { subscribed: 5000, suppressed: 77 });
    when(`${BROADCASTS}/${draft.id}/send`, {
      broadcast: { ...draft, status: 'sent', startedAt: NOW, finishedAt: NOW, sentCount: 4183 },
    });
    mount();

    await screen.findByText('Fresh drums are back');

    // The row's own menu already names the count...
    await user.click(screen.getByRole('button', { name: `Actions for ${draft.subject}` }));
    await user.click(await screen.findByRole('menuitem', { name: 'Send to 4183…' }));

    /*
     * ...and the confirmation names it again: 4183 — a number derivable from
     * NOTHING else rendered. Three rows are loaded, the audience says 5000,
     * the other rows count 912 and 260. Only the draft row itself carries
     * 4183, so only an implementation reading the broadcast's own
     * `recipientCount` can produce this dialog.
     */
    const dialog = await screen.findByRole('dialog', { name: 'Send to 4183 people?' });
    expect(within(dialog).getByRole('heading', { name: 'Send to 4183 people?' })).toBeTruthy();
    expect(dialog.textContent).toContain('Fresh drums are back');
    expect(dialog.textContent).not.toContain('5000');
    expect(dialog.textContent).not.toContain('912');
    expect(dialog.textContent).not.toContain('260');

    // The irreversible thing has NOT happened while the question is open.
    expect(sentNothing(`${BROADCASTS}/${draft.id}/send`)).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: 'Send newsletter' }));

    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.path === `${BROADCASTS}/${draft.id}/send` && c.init.method === 'POST',
        ),
      ).toBe(true),
    );
    // The receipt reads the server's own arithmetic back, not the page's.
    expect(await screen.findByText('Sent to 4183')).toBeTruthy();
  });
});

describe('deleting a draft', () => {
  it('confirms, DELETEs the route, and drops the row', async () => {
    const user = userEvent.setup();
    withBroadcasts([doneRow, draft]);
    when(`${BROADCASTS}/${draft.id}`, { ok: true });
    mount();

    await screen.findByText('Fresh drums are back');
    await user.click(screen.getByRole('button', { name: `Actions for ${draft.subject}` }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete draft…' }));

    const dialog = await screen.findByRole('dialog', { name: 'Delete this draft?' });
    expect(dialog.textContent).toContain('Fresh drums are back');
    // The irreversible thing has NOT happened while the question is open.
    expect(sentNothing(`${BROADCASTS}/${draft.id}`)).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: 'Delete draft' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.path === `${BROADCASTS}/${draft.id}` && c.init.method === 'DELETE',
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.queryByText('Fresh drums are back')).toBeNull());
    expect(screen.getByText('July clearance')).toBeTruthy();
  });

  it('offers no delete on anything that has started', async () => {
    const user = userEvent.setup();
    withBroadcasts([doneRow, sendingRow]);
    mount();

    await screen.findByText('July clearance');
    await user.click(screen.getByRole('button', { name: `Actions for ${doneRow.subject}` }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: /Delete draft/ })).toBeNull();
  });
});

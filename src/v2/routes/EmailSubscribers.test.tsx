import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

/**
 * The subscribers screen's import flow, pinned on its one promise: the writer
 * SEES which rows would be refused BEFORE anything is written, and what then
 * travels is exactly the rows the preview called valid.
 *
 * The order matters because the server's rule is validate-all-then-write
 * (`/api/import`'s rule): a preview that only appeared after a request, or a
 * body that carried the refused rows anyway, would mean the preview the
 * writer approved and the list they got are different things. So each test
 * reads the wire log at the moment that could go wrong:
 *
 *  - while the preview is on screen there must be NO write of any kind — the
 *    arithmetic is client-side, or it is not a preview;
 *  - the confirmed POST must carry the valid addresses ONLY — deduped,
 *    lowercased, in first-seen order, with `consent: true` beside them and
 *    the refused strings absent from the raw body, not merely uncounted;
 *  - while nothing typed is valid the import control stays dead, which is
 *    the degenerate case of "only valid addresses travel": none do.
 *
 * `fetch` IS STUBBED, NOT `../../data/api-email`, per the section's canonical
 * harness (`src/routes/MarketingRewards.test.tsx`): the path, the method and
 * the body are what integration gets silently wrong, and a mocked module
 * asserts none of them.
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
import type { EmailSubscriber } from '../../data/api-email';
import EmailSubscribers from './EmailSubscribers';

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

/** Every request that was not a read — the preview must produce none. */
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

const subscribers: EmailSubscriber[] = [
  {
    id: 'sub_1',
    email: 'ada@example.com',
    source: 'customer',
    consentAt: NOW - 86_400_000,
    unsubscribedAt: null,
  },
  {
    id: 'sub_2',
    email: 'tunde@example.com',
    source: 'manual',
    consentAt: null,
    unsubscribedAt: null,
  },
];

/**
 * The paste, built to exercise every rule the parser owns at once:
 * mixed separators (newline, comma, semicolon), a case to fold
 * (NGOZI@Example.COM), a duplicate to collapse (bisi twice), and three
 * refusable shapes — no `@`, a dotless domain, a double `@`.
 *
 * valid, first-seen, lowercased: bisi, chidi, ngozi, zainab.
 * refused: bad-address, not@right, bogus@@double.com.
 */
const RAW = [
  'bisi@example.com',
  'bad-address',
  'chidi@example.com, not@right',
  'NGOZI@Example.COM',
  'zainab@example.com; bogus@@double.com',
  'bisi@example.com',
].join('\n');

const SUBSCRIBERS = '/api/admin/email/subscribers';
const IMPORT = '/api/admin/email/subscribers/import';
const AUDIENCE = '/api/admin/email/audience';

function withSubscribers(): void {
  when(SUBSCRIBERS, { items: subscribers, nextCursor: null });
  when(AUDIENCE, { subscribed: 40, suppressed: 2 });
}

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/emails/subscribers']}>
        <EmailSubscribers />
      </MemoryRouter>
    </ToastHost>,
  );
}

/** Open the import modal and paste the addresses into it. */
async function openImportWith(
  user: ReturnType<typeof userEvent.setup>,
  raw: string,
): Promise<HTMLElement> {
  await screen.findByText('ada@example.com');
  await user.click(screen.getByRole('button', { name: 'Import' }));
  const dialog = await screen.findByRole('dialog', { name: 'Import subscribers' });
  await user.click(within(dialog).getByLabelText('Addresses'));
  await user.paste(raw);
  return dialog;
}

// ============================================================================

describe('the subscribers import', () => {
  it('lists the refused rows before anything is written — not one request until confirm', async () => {
    const user = userEvent.setup();
    withSubscribers();
    mount();
    const dialog = await openImportWith(user, RAW);

    // The preview's arithmetic: what travels, what does not.
    expect(await within(dialog).findByText('4 importable')).toBeTruthy();
    expect(within(dialog).getByText('3 refused')).toBeTruthy();

    // The refused rows are NAMED, each one, so the writer can fix or drop
    // them — a count alone would make that a guessing game.
    const refusal = within(dialog).getByText(/Won’t be written:/);
    expect(refusal.textContent).toContain('bad-address');
    expect(refusal.textContent).toContain('not@right');
    expect(refusal.textContent).toContain('bogus@@double.com');

    // The button already speaks in the valid count, before any confirm.
    expect(within(dialog).getByRole('button', { name: 'Import 4 addresses' })).toBeTruthy();

    /*
     * AND NOTHING HAS CROSSED THE WIRE. The whole preview is client-side
     * arithmetic — if a request were needed to produce it, the "before
     * anything is written" promise would already be broken.
     */
    expect(writes()).toHaveLength(0);
  });

  it('sends only the valid addresses when confirmed — deduped, lowercased, refusals left behind', async () => {
    const user = userEvent.setup();
    withSubscribers();
    when(IMPORT, { added: 3, skipped: 1 });
    mount();
    const dialog = await openImportWith(user, RAW);

    await user.click(within(dialog).getByRole('button', { name: 'Import 4 addresses' }));

    /*
     * KEY BY KEY: the four survivors in first-seen order, folded to lower
     * case, with the consent assertion beside them — that flag is what fills
     * `consentAt` on the imported rows, so a body without it is a different
     * import than the one this screen describes.
     */
    await waitFor(() => expect(sent(IMPORT, 'POST')).toBeTruthy());
    expect(sent(IMPORT, 'POST')).toEqual({
      emails: ['bisi@example.com', 'chidi@example.com', 'ngozi@example.com', 'zainab@example.com'],
      consent: true,
    });

    // Said twice on purpose: the refused strings are absent from the RAW
    // body, not merely from the parsed count.
    const wire = calls.find((c) => c.path === IMPORT);
    if (wire === undefined) throw new Error('no request to the import route');
    const body = String(wire.init.body);
    expect(body).not.toContain('bad-address');
    expect(body).not.toContain('not@right');
    expect(body).not.toContain('bogus');

    // The receipt reads the server's arithmetic, which may differ from the
    // preview's — already-present rows are skipped, never overwritten.
    expect(await screen.findByText('3 added · 1 already on the list')).toBeTruthy();
  });

  it('keeps the import control dead while nothing typed is valid', async () => {
    const user = userEvent.setup();
    withSubscribers();
    mount();
    const dialog = await openImportWith(user, 'nonsense, still@nonsense');

    expect(await within(dialog).findByText('0 importable')).toBeTruthy();
    expect(within(dialog).getByText('2 refused')).toBeTruthy();

    const button = within(dialog).getByRole('button', { name: 'Import addresses' });
    expect(button).toHaveProperty('disabled', true);
    await user.click(button);

    // The degenerate case of "only valid addresses travel": none do.
    expect(writes()).toHaveLength(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * THE SEND COMPOSER — the one irreversible control in "Not bought yet", pinned
 * on the four things it can get wrong quietly.
 *
 *  - **A count that is decorative.** "3 will be emailed" beside a list of three
 *    where one has opted out is a lie the operator only discovers afterwards,
 *    and there is no recall. Suppression is dropped at enqueue AND again at
 *    claim time (`server/email/repo.ts` `enqueueAudience`,
 *    `server/email/send.ts`), so an unsubscribed pick is never mailed and the
 *    screen must say so before the press.
 *  - **The WRONG basket predicate.** `drainBroadcast` decides whether to
 *    resolve a basket — and therefore whom to SKIP — with `needsBasket` over
 *    the subject and both bodies. A composer warning with `usesBasket` would
 *    promise nobody is skipped for a template written `{{basket_total}}`, and
 *    then skip people.
 *  - **A missing unsubscribe link met after committing.** The server 412s it;
 *    the button has to be unreachable first.
 *  - **The audience posted wrong.** It is the field with no visible
 *    consequence until real mail lands in the wrong inboxes, so the body is
 *    asserted key by key.
 *
 * `fetch` IS STUBBED, NOT the api modules, per the section's canonical harness
 * (`src/routes/MarketingRewards.test.tsx`).
 */

vi.setConfig({ testTimeout: 20_000 });

vi.mock('../../../data/session', () => ({
  getSession: () => ({ status: 'authed', user: { id: 'u_owner', role: 'owner' } }),
  subscribe: () => () => {},
  initSession: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('../../../data/images', () => ({
  acquireImageURL: vi.fn(async () => 'blob:test'),
  releaseImageURL: vi.fn(),
  storeImageFile: vi.fn(),
  ImageError: class ImageError extends Error {},
}));

import { ToastHost } from '../../ui/Toast';
import type { ShopProspect } from '../../../data/api-shop';
import { SendModal } from './SendModal';

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
let calls: { path: string; method: string; body: string | null }[] = [];

function when(pathname: string, body: unknown, status = 200): void {
  handlers.set(
    pathname,
    typeof body === 'function' ? (body as Responder) : () => ({ status, body }),
  );
}

/** The one call to a path with a method, or undefined. */
const callTo = (method: string, path: string) =>
  calls.find((c) => c.method === method && c.path.split('?')[0] === path);

const TEMPLATES = '/api/admin/email/templates';
const BROADCASTS = '/api/admin/email/broadcasts';

const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);

/** Template fixtures. `plain` needs no basket; `withBasket` carries only the
 *  SCALAR, which is exactly the case `usesBasket` would miss. */
const plain = {
  id: 'tpl_1',
  name: 'A plain nudge',
  subject: 'Still thinking it over?',
  html: 'Hello {{name}} — {{unsubscribe_url}}',
  text: 'Hello {{name}} — {{unsubscribe_url}}',
  updatedAt: NOW,
  updatedBy: 'o@test.local',
  systemKey: null,
};

const withBasket = {
  ...plain,
  id: 'tpl_2',
  name: 'Your basket',
  subject: 'Your basket is worth {{basket_total}}',
  html: 'Hello {{name}} — {{unsubscribe_url}}',
  text: 'Hello {{name}} — {{unsubscribe_url}}',
};

const noExit = {
  ...plain,
  id: 'tpl_3',
  name: 'No way out',
  subject: 'Hello',
  html: 'Hello {{name}}',
  text: 'Hello {{name}}',
};

const person = (over: Partial<ShopProspect> & { email: string }): ShopProspect => ({
  displayName: null,
  hasBasket: true,
  hasAccount: false,
  isSubscriber: false,
  subscribeState: 'never_asked',
  basketItems: 2,
  basketMinor: 280_000,
  currency: 'NGN',
  lastSeenAt: NOW,
  lastNudgeAt: null,
  ...over,
});

const subscribed = person({ email: 'a@x.test', subscribeState: 'subscribed' });
const neverAsked = person({ email: 'b@x.test', subscribeState: 'never_asked' });
const unsubscribed = person({ email: 'c@x.test', subscribeState: 'unsubscribed' });
/** Mailable, and nothing in the basket — the person a basket template skips. */
const empty = person({ email: 'd@x.test', hasBasket: false, basketItems: 0, basketMinor: 0 });

beforeEach(() => {
  handlers.clear();
  calls = [];
  when(TEMPLATES, { items: [plain, withBasket, noExit] });
  when('/api/shop/admin/customers/prospects/a%40x.test', { basket: null, sends: [] });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init: RequestInit = {}) => {
      const url = new URL(String(input), 'https://studio.test');
      calls.push({
        path: url.pathname + url.search,
        method: String(init.method ?? 'GET').toUpperCase(),
        body: typeof init.body === 'string' ? init.body : null,
      });
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
});

function mount(picked: ShopProspect[], onSent = vi.fn()) {
  render(
    <>
      <SendModal picked={picked} onClose={() => {}} onSent={onSent} />
      <ToastHost />
    </>,
  );
  return onSent;
}

/** Choose a template by its visible name, once the picker has loaded. */
async function choose(name: string) {
  const select = await screen.findByLabelText(/message/i);
  await userEvent.selectOptions(select, screen.getByRole('option', { name }));
}

describe('SendModal', () => {
  it('counts who will actually be mailed', async () => {
    mount([subscribed, neverAsked, unsubscribed]);
    expect(await screen.findByText(/2 will be emailed/)).toBeTruthy();
    expect(screen.getByText(/1 unsubscribed and will be left out/)).toBeTruthy();
  });

  it('warns about people with no basket ONLY when the template needs one', async () => {
    mount([subscribed, empty]);
    await choose('A plain nudge');
    expect(screen.queryByText(/no basket/i)).toBeNull();

    /* The BASKET template carries `{{basket_total}}` in its SUBJECT and nothing
       else — the exact template `usesBasket` reads as needing no basket and
       `drainBroadcast` skips people for. */
    await choose('Your basket');
    expect(await screen.findByText(/1 has no basket and will be skipped/)).toBeTruthy();
  });

  it('refuses to send a template with no unsubscribe link', async () => {
    mount([subscribed]);
    await choose('No way out');
    expect(await screen.findByText(/no unsubscribe link/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: /send/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('posts the picked addresses, then sends', async () => {
    when(BROADCASTS, { broadcast: { id: 'bc_1', recipientCount: 2, status: 'draft' } }, 201);
    when(`${BROADCASTS}/bc_1/send`, {
      broadcast: { id: 'bc_1', status: 'sent', sentCount: 2, recipientCount: 2 },
    });
    const onSent = mount([subscribed, neverAsked, unsubscribed]);
    await choose('A plain nudge');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(callTo('POST', `${BROADCASTS}/bc_1/send`)).toBeTruthy());
    const create = callTo('POST', BROADCASTS);
    expect(create).toBeTruthy();
    /* KEY BY KEY. `emails` carries the mailable picks only — an unsubscribed
       address on the wire would be dropped by the server anyway, but naming it
       makes the screen's own count and its request disagree. */
    expect(JSON.parse(create?.body ?? 'null')).toEqual({
      templateId: 'tpl_1',
      audience: { kind: 'picked', emails: ['a@x.test', 'b@x.test'] },
    });
    await waitFor(() => expect(onSent).toHaveBeenCalled());
  });

  it('does not send when nobody picked is mailable', async () => {
    mount([unsubscribed]);
    await choose('A plain nudge');
    expect(await screen.findByText(/nobody left to email/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: /send/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The outbox screen, pinned on the three behaviours the Home banner depends on:
 *
 *  - **The dead bucket is the landing tab**, each row carrying the provider's
 *    refusal and the order number — the operator arrives from an alert about a
 *    specific failure, not from curiosity.
 *  - **Retry now POSTs to the retry route and reports what the sweep did** —
 *    "Sent" when the message left, the critical shape when it failed again.
 *  - **Dismiss POSTs to the dismiss route** — the verb that clears the banner
 *    without sending anything.
 *
 * `fetch` IS STUBBED, NOT `../../data/api-shop`, for the reason the rewards
 * suite gives: the path, the method and the body are the three things most
 * likely to be silently wrong against a backend written in another session,
 * and a mocked module asserts none of them.
 */

import { ToastHost } from '../ui/Toast';
import type { ShopOutboxItem } from '../../data/api-shop';
import EmailOutbox from './EmailOutbox';

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

function when(pathname: string, respond: Responder): void;
function when(pathname: string, body: unknown, status?: number): void;
function when(pathname: string, body: unknown, status = 200): void {
  handlers.set(
    pathname,
    typeof body === 'function' ? (body as Responder) : () => ({ status, body }),
  );
}

const asked = (fragment: string): number =>
  calls.filter((c) => c.path.includes(fragment)).length;

beforeEach(() => {
  handlers.clear();
  calls = [];
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
});

// -------------------------------------------------------------- the harness

const OUTBOX = '/api/shop/admin/emails';

const dead: ShopOutboxItem = {
  id: 'em_dead',
  orderId: 'ord_1',
  orderNumber: '2026-000009-D',
  kind: 'confirmation',
  to: 'buyer@example.test',
  subject: 'Order 2026-000009-D is confirmed',
  body: 'Thanks for your order.',
  html: null,
  createdAt: Date.now() - 60_000,
  sentAt: null,
  attempts: 8,
  lastError: 'to address is invalid',
  dismissedAt: null,
};

const delivered: ShopOutboxItem = {
  ...dead,
  id: 'em_sent',
  subject: 'Order 2026-000009-D has shipped',
  kind: 'shipment',
  attempts: 1,
  lastError: null,
  sentAt: Date.now() - 30_000,
};

/** Serve buckets the way the route does: the bucket is a query parameter. */
function withOutbox(rows: { attention?: ShopOutboxItem[]; sent?: ShopOutboxItem[] }): void {
  when(OUTBOX, (url) => {
    const bucket = url.searchParams.get('bucket') ?? 'attention';
    const items =
      bucket === 'attention' ? (rows.attention ?? []) : bucket === 'sent' ? (rows.sent ?? []) : [];
    return {
      body: {
        items,
        counts: {
          attention: rows.attention?.length ?? 0,
          queued: 0,
          sent: rows.sent?.length ?? 0,
          dismissed: 0,
        },
      },
    };
  });
}

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/emails/outbox']}>
        <EmailOutbox />
      </MemoryRouter>
    </ToastHost>,
  );
}

// ------------------------------------------------------------------- tests

describe('the dead-letter bucket', () => {
  it('lands on Needs attention with the refusal and the order number on the row', async () => {
    withOutbox({ attention: [dead], sent: [delivered] });
    mount();

    expect(await screen.findByText('Order 2026-000009-D is confirmed')).toBeTruthy();
    expect(screen.getByText('Won’t send')).toBeTruthy();
    expect(screen.getByText('to address is invalid')).toBeTruthy();
    const orderLink = screen.getByRole('link', { name: '2026-000009-D' });
    expect(orderLink.getAttribute('href')).toContain('/orders/ord_1');
    /* The tab label carries the count — the alert said "1 email", the tab must
     * agree with it. */
    expect(screen.getByRole('tab', { name: /Needs attention · 1/ })).toBeTruthy();
    expect(asked('bucket=attention')).toBe(1);
  });

  it('switching to Sent asks the server for that bucket', async () => {
    withOutbox({ attention: [dead], sent: [delivered] });
    mount();
    await screen.findByText('Order 2026-000009-D is confirmed');

    await userEvent.click(screen.getByRole('tab', { name: /Sent/ }));
    expect(await screen.findByText('Order 2026-000009-D has shipped')).toBeTruthy();
    expect(asked('bucket=sent')).toBe(1);
  });
});

describe('the two verbs', () => {
  it('Retry now POSTs to the retry route and reports the delivery', async () => {
    withOutbox({ attention: [dead] });
    when(`${OUTBOX}/em_dead/retry`, {
      ok: true,
      emails: { sent: 1, failed: 0, skipped: 0 },
    });
    mount();
    await screen.findByText('Order 2026-000009-D is confirmed');

    await userEvent.click(screen.getByRole('button', { name: /Actions for Order/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Retry now' }));

    await waitFor(() => expect(asked('/em_dead/retry')).toBe(1));
    /* Scoped to the toaster: the Sent TAB also matches the bare text. */
    const toaster = document.querySelector('.toaster') as HTMLElement;
    await waitFor(() => expect(within(toaster).getByText('Sent')).toBeTruthy());
    /* The list is re-asked so the row moves buckets rather than lying in place. */
    await waitFor(() => expect(asked('bucket=attention')).toBeGreaterThan(1));
  });

  it('a retry that fails again reports the critical shape, not success', async () => {
    withOutbox({ attention: [dead] });
    when(`${OUTBOX}/em_dead/retry`, {
      ok: true,
      emails: { sent: 0, failed: 1, skipped: 0 },
    });
    mount();
    await screen.findByText('Order 2026-000009-D is confirmed');

    await userEvent.click(screen.getByRole('button', { name: /Actions for Order/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Retry now' }));

    expect(await screen.findByText(/failed again/)).toBeTruthy();
  });

  it('Dismiss POSTs to the dismiss route', async () => {
    withOutbox({ attention: [dead] });
    when(`${OUTBOX}/em_dead/dismiss`, { ok: true });
    mount();
    await screen.findByText('Order 2026-000009-D is confirmed');

    await userEvent.click(screen.getByRole('button', { name: /Actions for Order/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Dismiss' }));

    await waitFor(() => expect(asked('/em_dead/dismiss')).toBe(1));
    const post = calls.find((c) => c.path.includes('/em_dead/dismiss'));
    expect(post?.init.method).toBe('POST');
  });

  it('a SENT row offers View only — no retry, no dismiss', async () => {
    withOutbox({ attention: [], sent: [delivered] });
    mount();
    await userEvent.click(await screen.findByRole('tab', { name: /Sent/ }));
    await screen.findByText('Order 2026-000009-D has shipped');

    await userEvent.click(screen.getByRole('button', { name: /Actions for Order/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'View email…' })).toBeTruthy();
    expect(within(menu).queryByRole('menuitem', { name: 'Retry now' })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: 'Dismiss' })).toBeNull();
  });
});

describe('the detail view', () => {
  it('shows the message text and the provider’s refusal', async () => {
    withOutbox({ attention: [dead] });
    mount();
    await screen.findByText('Order 2026-000009-D is confirmed');

    await userEvent.click(screen.getByRole('button', { name: /Actions for Order/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'View email…' }));

    const modal = await screen.findByRole('dialog');
    expect(within(modal).getByText('Thanks for your order.')).toBeTruthy();
    expect(within(modal).getByText('to address is invalid')).toBeTruthy();
    expect(within(modal).getByText('buyer@example.test')).toBeTruthy();
  });
});

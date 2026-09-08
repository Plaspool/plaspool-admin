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

describe('Send queued now', () => {
  /**
   * THE BUTTON EXISTS FOR THE PREVIEW HOST, where nothing else drains the
   * outbox: Vercel fires cron entries for the production deployment only, and
   * the external cron service authenticates with production's CRON_SECRET.
   * Measured 2026-09-08 — three intents sat at `attempts = 0` on dev while the
   * order they belonged to was plainly `paid`, because the storefront's
   * checkout-complete page settles the capture without any sweep.
   */
  const SWEEP = '/api/shop/admin/sweep';

  /** `runSweep`'s real answer, field for field — payments answers `count`, and
   *  the event drain answers applied/ignored/parked. Both were guessed wrong
   *  once; a fixture that agrees with the client's own invented shape would
   *  prove nothing. */
  const sweepRun = (sent: number, failed = 0) => ({
    payments: { count: 0 },
    events: { applied: 0, ignored: 0, parked: 0, passes: 1 },
    emails: { sent, failed, skipped: 0 },
    seeded: 0,
    passes: 1,
  });

  it('POSTs the sweep and says how many left', async () => {
    withOutbox({ attention: [dead] });
    when(SWEEP, sweepRun(3));
    mount();
    await screen.findByText('Order 2026-000009-D is confirmed');

    await userEvent.click(screen.getByRole('button', { name: 'Send queued now' }));

    // The PATH and the METHOD, which a mocked api module would assert neither of.
    await waitFor(() => {
      const call = calls.find((c) => c.path === SWEEP);
      expect(call).toBeTruthy();
      expect(call!.init.method).toBe('POST');
    });
    await screen.findByText('3 emails sent');
  });

  it('says nothing was waiting rather than claiming a send', async () => {
    withOutbox({ attention: [] });
    when(SWEEP, sweepRun(0));
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Send queued now' }));

    await screen.findByText('Nothing was waiting to send');
  });

  it('reports a partial failure instead of only the good half', async () => {
    withOutbox({ attention: [dead] });
    when(SWEEP, sweepRun(2, 1));
    mount();
    await screen.findByText('Order 2026-000009-D is confirmed');

    await userEvent.click(screen.getByRole('button', { name: 'Send queued now' }));

    await screen.findByText('2 sent, 1 failed — the reasons are on the rows.');
  });

  it('re-reads the table afterwards, so a row that left stops showing as owed', async () => {
    withOutbox({ attention: [dead] });
    when(SWEEP, sweepRun(1));
    mount();
    await screen.findByText('Order 2026-000009-D is confirmed');
    const before = asked('/emails?');

    await userEvent.click(screen.getByRole('button', { name: 'Send queued now' }));

    await waitFor(() => expect(asked('/emails?')).toBeGreaterThan(before));
  });

  it('surfaces a refusal rather than reporting a send that did not happen', async () => {
    withOutbox({ attention: [dead] });
    // A writer pressing it: the route is requireAdmin(), so the server says no.
    when(SWEEP, { error: 'forbidden', requestId: 'req_test' }, 403);
    mount();
    await screen.findByText('Order 2026-000009-D is confirmed');

    await userEvent.click(screen.getByRole('button', { name: 'Send queued now' }));

    /* `querySelector` rather than a text matcher: the toast wraps its message
       beside a close button, so no single node's text is the whole message. */
    await waitFor(() => expect(document.querySelector('.toast')).toBeTruthy());
    expect(document.querySelector('.toast--critical')).toBeTruthy();
    expect(screen.queryByText(/emails sent/)).toBeNull();
    expect(screen.queryByText('Nothing was waiting to send')).toBeNull();
  });
});

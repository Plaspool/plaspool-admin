import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastHost } from '../ui/Toast';
import { ReviewLinkCard } from './ReviewLinkCard';

vi.setConfig({ testTimeout: 20_000 });

/**
 * "Ask for a review" on an order (migration 1280). `fetch` is stubbed, not the
 * API module, so the path and method are what is asserted.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReviewLinkCard', () => {
  it('makes a link for a paid order, copies it and shows it', async () => {
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET' });
        return new Response(
          JSON.stringify({
            url: 'https://plaspool.com/review?token=abc.def',
            expiresAt: Date.now() + 1000,
            productCount: 2,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(
      <ToastHost>
        <ReviewLinkCard orderId="ord_1" status="fulfilled" />
      </ToastHost>,
    );
    await userEvent.click(screen.getByRole('button', { name: /copy review link/i }));

    await waitFor(() =>
      expect(screen.getByLabelText('Review link')).toHaveProperty(
        'value',
        'https://plaspool.com/review?token=abc.def',
      ),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/api/shop/admin/orders/ord_1/review-link');
    expect(calls[0]!.method).toBe('POST');
    expect(writeText).toHaveBeenCalledWith('https://plaspool.com/review?token=abc.def');
  });

  it('is not offered for an order that was never paid', () => {
    render(
      <ToastHost>
        <ReviewLinkCard orderId="ord_2" status="pending" />
      </ToastHost>,
    );
    expect(screen.queryByText('Ask for a review')).toBeNull();
  });
});

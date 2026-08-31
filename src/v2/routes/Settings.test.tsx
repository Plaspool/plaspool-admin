import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The settings INDEX — `/settings` is doors now, not a working screen (the
 * zones surface moved whole to `/settings/shipping`; its suite moved with it
 * to `SettingsShipping.test.tsx`). What this page owes is exactly its links:
 * each door is a REAL `<a>` (middle-click, open-in-new-tab) pointing at the
 * route the nav also names, including the fourth door — Delivery areas —
 * which deliberately points INTO the Orders section rather than at a
 * duplicate settings route.
 */

import Settings from './Settings';

afterEach(() => {
  cleanup();
});

function mount() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <Settings />
    </MemoryRouter>,
  );
}

// ============================================================================

describe('the settings index', () => {
  it('links each door to its route, delivery areas included', async () => {
    mount();

    const hrefOf = (name: RegExp) =>
      (screen.getByRole('link', { name }) as HTMLAnchorElement).getAttribute('href');

    expect(hrefOf(/Shipping/)).toBe('/settings/shipping');
    expect(hrefOf(/Team/)).toBe('/settings/team');
    expect(hrefOf(/Writing/)).toBe('/settings/writing');
    // The fourth door opens the EXISTING screen under Orders — one room, two doors.
    expect(hrefOf(/Delivery areas/)).toBe('/orders/delivery');

    // Each door says what is behind it, not just its name.
    expect(
      screen.getByText('What each part of the country pays for delivery, and how much tax is added.'),
    ).toBeTruthy();
    expect(screen.getByText('Who can sign in, and what each of them is allowed to do.')).toBeTruthy();
  });
});

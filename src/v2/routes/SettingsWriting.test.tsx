import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The writing page — `/settings/writing`, the device preference on its own
 * small route. One behaviour is worth pinning: THE TOGGLE IS THE WHOLE
 * TRANSACTION. No save button, no server round trip — one flip writes the
 * localStorage preference `editorPref.ts` reads at every editor open, and the
 * toast is the receipt. A regression here is silent (nothing errors; posts
 * just open in the wrong editor), which is exactly the kind that needs a pin.
 */

import { ToastHost } from '../ui/Toast';
import { advancedByDefault } from '../lib/editorPref';
import SettingsWriting from './SettingsWriting';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/settings/writing']}>
        <SettingsWriting />
      </MemoryRouter>
    </ToastHost>,
  );
}

// ============================================================================

describe('the writing page', () => {
  it('flips the device preference on the spot and says so', async () => {
    const user = userEvent.setup();
    mount();

    const toggle = screen.getByRole('switch', {
      name: 'Open posts in the advanced editor',
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(advancedByDefault()).toBe(false);

    // On: the preference is WRITTEN by the flip itself — no save step exists.
    await user.click(toggle);
    expect(advancedByDefault()).toBe(true);
    expect(
      await screen.findByText('Posts open in the advanced editor on this device'),
    ).toBeTruthy();

    // And straight back off — the receipt names the state it left behind.
    await user.click(toggle);
    expect(advancedByDefault()).toBe(false);
    expect(
      await screen.findByText('Posts open in the quick editor on this device'),
    ).toBeTruthy();
  });
});

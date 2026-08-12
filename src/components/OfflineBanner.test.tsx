import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { OfflineBanner, useOnline } from './OfflineBanner';

/**
 * The banner, and what it is allowed to claim.
 *
 * The interesting assertions here are negative. A writer who reads "you are
 * offline, changes are not being saved" stops typing, and on this app that
 * sentence would be false: every failed save lands in a `pending` row and an
 * overlay. So the tests below check that the banner appears and disappears on
 * the real window events, and that it names the two things that genuinely do
 * not work rather than the many that do.
 */

/**
 * jsdom's `navigator.onLine` is a getter on the prototype and always `true`.
 * Redefining it on the instance is the only way to drive the component, and it
 * has to be undone or every later file in this project's `ui` project inherits
 * a permanently offline browser.
 */
function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    value,
    configurable: true,
  });
}

function goOffline(): void {
  setOnline(false);
  act(() => {
    window.dispatchEvent(new Event('offline'));
  });
}

function goOnline(): void {
  setOnline(true);
  act(() => {
    window.dispatchEvent(new Event('online'));
  });
}

afterEach(() => {
  cleanup();
  setOnline(true);
});

describe('OfflineBanner', () => {
  it('says nothing at all while the connection is up', () => {
    render(<OfflineBanner />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('appears on the offline event and names the two things that stop working', () => {
    render(<OfflineBanner />);
    goOffline();

    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('offline');
    expect(banner.textContent).toContain('starting a new post');
    expect(banner.textContent).toContain('adding a picture');
  });

  it('does not tell the writer their changes are being lost', () => {
    render(<OfflineBanner />);
    goOffline();

    const text = screen.getByRole('status').textContent ?? '';
    // The claim the app can actually make: the words are on this device and go
    // out later. `savePost`'s failure path writes the pending row and the
    // overlay before it rethrows, so this is a property of the code and not a
    // reassurance.
    expect(text).toContain('kept on this device');
    expect(text).not.toMatch(/not\s+(being\s+)?saved/i);
    expect(text).not.toMatch(/lost/i);
  });

  it('goes away again when the connection comes back', () => {
    render(<OfflineBanner />);
    goOffline();
    expect(screen.getByRole('status')).toBeTruthy();

    goOnline();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('useOnline', () => {
  function Probe() {
    return <span data-testid="probe">{useOnline() ? 'up' : 'down'}</span>;
  }

  it('tracks both events for every consumer, not just the banner', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('up');

    goOffline();
    expect(screen.getByTestId('probe').textContent).toBe('down');

    goOnline();
    expect(screen.getByTestId('probe').textContent).toBe('up');
  });
});

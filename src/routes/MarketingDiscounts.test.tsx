import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';

import MarketingDiscounts from './MarketingDiscounts';

/**
 * The placeholder, asserted on the four ways a placeholder goes wrong.
 *
 *  - **It starts asking.** The endpoints for discount codes exist (#24-26), so
 *    the tempting next edit is a list — and the moment this screen has a request
 *    it has a spinner, a failure and a retry, which turn "not built yet" into
 *    "broken". The `fetch` stub here exists to be NEVER CALLED.
 *  - **It grows a button.** A disabled "New code" is an invitation with nothing
 *    behind it and is the first thing an owner presses. There is one control on
 *    this screen and it navigates somewhere real.
 *  - **It names the currency.** Every other screen renders the points word from
 *    settings or from the row's own program. This one cannot — it fetches
 *    nothing — so a hardcoded "points" here would survive a rename that the
 *    whole section is built to make safe, on the one screen with no data to
 *    catch it.
 *  - **It names the preset.** Same trap, one level down, and the section's grep
 *    guard walks this file too.
 */

/**
 * The seeded preset's noun, assembled from halves rather than typed: this file
 * is one of the sources the section's naming guard reads as text, so spelling
 * the word out to assert its absence would fail the very guard it asserts.
 * (The guard's own file name carries the word, which is why it is not cited
 * here by name either.)
 */
const PRESET_NOUN = 'sp' + 'ool';

let calls: string[] = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      calls.push(String(input));
      /* Answering at all would be a kindness that hides the bug. A screen that
         is supposed to be static and isn't should fail loudly here rather than
         render whatever an empty 200 happens to produce. */
      throw new Error(`the discounts placeholder asked the server for ${String(input)}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Shows the router's current URL, so a test can assert where a link went. */
function Address() {
  const location = useLocation();
  return <output data-testid="address">{location.pathname + location.search}</output>;
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/marketing/discounts']}>
      <MarketingDiscounts />
      <Address />
    </MemoryRouter>,
  );
}

const address = (): string => screen.getByTestId('address').textContent ?? '';

/**
 * Every word the screen puts in front of somebody — including the ones only a
 * screen reader hears.
 *
 * `textContent` alone would miss them, and the miss is not hypothetical: an
 * `aria-label` is a whole sentence and this file already carries one. The
 * section's file-level grep covers the PRESET'S noun in an attribute; nothing
 * covers the generic currency word, because "points" is far too ordinary a
 * string to grep a source tree for. This screen is the only place it can be
 * pinned at all, so it is pinned over the whole surface rather than half of it.
 */
const COPY_ATTRS = ['aria-label', 'title', 'alt', 'placeholder'];

function everyWord(container: HTMLElement): string {
  const spoken = [...container.querySelectorAll('*')].flatMap((el) =>
    COPY_ATTRS.map((name) => el.getAttribute(name) ?? ''),
  );
  return [container.textContent ?? '', ...spoken].join(' ');
}

// ============================================================================

describe('the discounts placeholder', () => {
  it('says what is missing, and asks the server nothing to say it', () => {
    mount();

    expect(screen.getByRole('heading', { name: 'Discount codes aren’t built yet' })).toBeTruthy();
    // Not "coming soon" with nothing under it: the two sentences say what the
    // thing will be, which is what makes the absence a decision instead of a gap.
    expect(screen.getByText(/percentage or a flat amount/)).toBeTruthy();
    expect(screen.getByText('Planned')).toBeTruthy();

    /* Three lines that are deliberately undecided, marked up as a list so a
       screen reader announces them as three of something rather than as one
       long sentence about stacking. */
    const later = screen.getByRole('list', { name: 'Left for later' });
    expect(later.querySelectorAll('li')).toHaveLength(3);

    expect(calls).toEqual([]);
  });

  it('offers one control, and it opens a screen that exists', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole('link', { name: 'Open Rewards' }));

    expect(address()).toBe('/marketing/rewards');
    expect(calls).toEqual([]);
  });

  it('has nothing on it that leads nowhere', () => {
    mount();

    // No button at all — every control that could exist here is a promise this
    // screen cannot keep, and a disabled one is the same promise with a shrug.
    expect(screen.queryAllByRole('button')).toHaveLength(0);

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('/marketing/rewards');
  });

  it('names neither the preset’s noun nor a currency it cannot look one up for', () => {
    const { container } = mount();
    const words = everyWord(container);

    expect(words).not.toMatch(new RegExp(PRESET_NOUN, 'i'));
    /*
     * THE WORD THE GREP GUARD CANNOT CATCH (spec D11 names it a review
     * responsibility; on this screen it is testable). "Points" is the DEFAULT
     * label, not the word — the seeded preset ships with it and the owner is
     * expected to change it on day one. Every other surface interpolates
     * whatever it was changed to; this one has no way to, so it must not say it.
     */
    expect(words).not.toMatch(/\bpoints?\b/i);
  });
});

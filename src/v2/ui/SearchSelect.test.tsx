import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The search-select, pinned on the two ways its two kinds of row-state can be
 * confused (the debt ledger's pair):
 *
 *  - **Filtering never loses the checked row's identity.** The check belongs
 *    to `value`; the highlight belongs to the keyboard. A filter that excludes
 *    the checked row must not hand its check to whatever is left (row #0, the
 *    hot row), and clearing the filter must find the original row still
 *    checked — with `onChange` never having fired.
 *  - **Enter picks the HIGHLIGHTED match** — not the first match, and not the
 *    checked row. The fixture is arranged so all three are different rows, so
 *    an implementation that picked either wrong one fails by value.
 *
 * No fetch stub: the component owns no requests. It IS given the harness's
 * jsdom shims — the hot-row effect calls `scrollIntoView`, which jsdom lacks.
 */

import { SearchSelect } from './SearchSelect';

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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * Four areas, arranged so one filter ('b') matches three rows but not the
 * checked one, and another ('u') matches exactly two of which neither is
 * first-in-list nor the current value.
 */
const AREAS: { value: string; label: string }[] = [
  { value: 'abia', label: 'Abia' },
  { value: 'bauchi', label: 'Bauchi' },
  { value: 'benue', label: 'Benue' },
  { value: 'cross_river', label: 'Cross River' },
];

// ============================================================================

describe('the search select', () => {
  it('keeps the check on the value while a filter excludes the checked row', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SearchSelect
        label="Service area"
        value="cross_river"
        options={AREAS}
        onChange={onChange}
        placeholder="Type an area"
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Service area' });
    expect(trigger.textContent).toContain('Cross River');
    await user.click(trigger);

    // 'b' matches Abia, Bauchi and Benue — and NOT the checked Cross River.
    await user.type(screen.getByLabelText('Type an area'), 'b');

    const rows = screen.getAllByRole('option');
    expect(rows.map((r) => r.textContent)).toEqual(['Abia', 'Bauchi', 'Benue']);
    // None of the survivors inherits the check: selection is the VALUE's, not
    // row #0's and not the highlighted row's.
    for (const row of rows) {
      expect(row.getAttribute('aria-selected')).toBe('false');
    }
    expect(onChange).not.toHaveBeenCalled();
    // The trigger never stops naming the real selection.
    expect(trigger.textContent).toContain('Cross River');

    // Clearing the filter finds the checked row exactly where it was, still
    // the only row checked.
    await user.clear(screen.getByLabelText('Type an area'));
    const all = screen.getAllByRole('option');
    expect(all.map((r) => r.textContent)).toEqual(['Abia', 'Bauchi', 'Benue', 'Cross River']);
    expect(
      all.filter((r) => r.getAttribute('aria-selected') === 'true').map((r) => r.textContent),
    ).toEqual(['Cross River']);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('picks the highlighted match on Enter — not the first match, not the checked row', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SearchSelect
        label="Service area"
        value="abia"
        options={AREAS}
        onChange={onChange}
        placeholder="Type an area"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Service area' }));
    // 'u' narrows to Bauchi and Benue; the checked Abia is gone entirely, so
    // whatever Enter picks cannot be blamed on the value.
    await user.type(screen.getByLabelText('Type an area'), 'u');
    expect(screen.getAllByRole('option').map((r) => r.textContent)).toEqual(['Bauchi', 'Benue']);

    // The arrow moves the highlight off the first match…
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: 'Benue' }).className).toContain('is-hot');

    // …and Enter picks THAT row.
    await user.keyboard('{Enter}');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('benue');
    // The panel closes and focus returns to the trigger, ready to reopen.
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Service area' }));
  });
});

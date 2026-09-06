import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The range picker, pinned on the shape it takes at each width.
 *
 * Four options (30d / 90d / 1y / All time) is a comfortable row on a laptop
 * and a wrapped mess at 375px — the owner photographed "All time" alone on a
 * second line. Below 34rem the control becomes a dropdown instead.
 *
 * `collapse` is OPT-IN, and the last test is why: the discount editor's
 * two-option switch is the case this component was built for, both of its
 * options are worth showing at once, and it still fits on a phone. A
 * component that collapsed automatically would take that away.
 *
 * jsdom has no `matchMedia`, so the hook's guard returns early and the width
 * comes from `innerWidth` — which is what these tests set.
 */

import { Segmented } from './Field';

const RANGES = [
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
  { value: '365', label: '1y' },
  { value: 'all', label: 'All time' },
];

function Host({ collapse = false }) {
  const [value, setValue] = useState('90');
  return (
    <>
      <Segmented label="Range" value={value} options={RANGES} onChange={setValue} collapse={collapse} />
      <output data-testid="out">{value}</output>
    </>
  );
}

function widthIs(px: number) {
  (window as unknown as { innerWidth: number }).innerWidth = px;
}

afterEach(() => {
  cleanup();
  widthIs(1024);
});

describe('Segmented at phone width', () => {
  it('is a row of buttons on a laptop', () => {
    widthIs(1024);
    render(<Host collapse />);
    expect(screen.getByRole('group', { name: 'Range' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All time' })).toBeTruthy();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('collapses to a dropdown on a phone, showing the current range', () => {
    widthIs(375);
    render(<Host collapse />);

    expect(screen.queryByRole('group', { name: 'Range' })).toBeNull();
    const trigger = screen.getByRole('button', { name: 'Range' });
    /* The trigger has to SAY which range is on — a bare "Range" would hide
       the one fact the control exists to report. */
    expect(trigger.textContent).toContain('90d');
  });

  it('picks a range from the dropdown and closes', async () => {
    widthIs(375);
    const user = userEvent.setup();
    render(<Host collapse />);

    await user.click(screen.getByRole('button', { name: 'Range' }));
    await user.click(screen.getByRole('option', { name: 'All time' }));

    expect(screen.getByTestId('out').textContent).toBe('all');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Range' }).textContent).toContain('All time');
  });

  it('marks the current option selected for a screen reader', async () => {
    widthIs(375);
    const user = userEvent.setup();
    render(<Host collapse />);

    await user.click(screen.getByRole('button', { name: 'Range' }));

    expect(screen.getByRole('option', { name: '90d' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('option', { name: '30d' }).getAttribute('aria-selected')).toBe('false');
  });

  it('leaves a control that did NOT opt in as buttons, even on a phone', () => {
    widthIs(375);
    render(<Host />);
    expect(screen.getByRole('group', { name: 'Range' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All time' })).toBeTruthy();
  });
});

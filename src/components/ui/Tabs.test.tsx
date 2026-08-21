import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Tabs, type TabItem } from './Tabs';

/**
 * The segmented control, and the two different promises its two modes make.
 *
 * What is worth asserting here is the ARIA and the keyboard, because those are
 * the parts a screenshot cannot check and the parts a careless edit silently
 * drops. A strip whose selected option is drawn dark but says nothing to a
 * screen reader looks finished and is not.
 */

afterEach(cleanup);

const VIEWS: readonly TabItem<'board' | 'table'>[] = [
  { value: 'board', label: 'Board' },
  { value: 'table', label: 'Table' },
];

const STATUSES: readonly TabItem<'pending' | 'approved' | 'flagged'>[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'flagged', label: 'Flagged' },
];

describe('Tabs — link mode', () => {
  it('renders links, and marks the current one with aria-current', () => {
    render(
      <MemoryRouter initialEntries={['/shop/orders']}>
        <Tabs label="How the orders are shown" value="table" items={VIEWS} to={(v) => `?view=${v}`} />
      </MemoryRouter>,
    );

    const board = screen.getByRole('link', { name: 'Board' });
    const table = screen.getByRole('link', { name: 'Table' });
    expect(board.getAttribute('aria-current')).toBeNull();
    expect(table.getAttribute('aria-current')).toBe('true');
    // The address is the whole reason these are links rather than buttons.
    expect(table.getAttribute('href')).toBe('/shop/orders?view=table');
  });

  /* `role="tab"` promises a `tabpanel` that no caller renders, and a strip of
     links is not a button either — a test that pins the negative is what stops
     the next person "fixing" it back. */
  it('claims neither tab nor button', () => {
    render(
      <MemoryRouter>
        <Tabs label="Review status" value="pending" items={STATUSES} to={(v) => `?status=${v}`} />
      </MemoryRouter>,
    );
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByRole('group', { name: 'Review status' })).toBeTruthy();
  });

  it('draws a disabled option as present but unreachable', () => {
    render(
      <MemoryRouter>
        <Tabs
          label="Product sections"
          value="details"
          items={[
            { value: 'details', label: 'Details' },
            { value: 'variants', label: 'Variants', disabled: true },
          ]}
          to={(v) => `?tab=${v}`}
        />
      </MemoryRouter>,
    );
    // Listed, so the section is discoverable — but not a link to anywhere.
    expect(screen.queryByRole('link', { name: 'Variants' })).toBeNull();
    expect(screen.getByText('Variants')).toBeTruthy();
  });
});

describe('Tabs — button mode', () => {
  function Choosing() {
    const [value, setValue] = useState<'pending' | 'approved' | 'flagged'>('pending');
    return <Tabs label="Review status" value={value} items={STATUSES} onChange={setValue} />;
  }

  it('is a radio group with exactly one chosen', async () => {
    const user = userEvent.setup();
    render(<Choosing />);

    expect(screen.getByRole('radiogroup', { name: 'Review status' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Pending' }).getAttribute('aria-checked')).toBe('true');

    await user.click(screen.getByRole('radio', { name: 'Approved' }));

    expect(screen.getByRole('radio', { name: 'Approved' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Pending' }).getAttribute('aria-checked')).toBe('false');
  });

  /* ONE TAB STOP for the group, which is the half of a radio group that is
     easy to forget and impossible to notice with a mouse. */
  it('gives the group a single tab stop, on the chosen option', () => {
    render(<Choosing />);
    expect(screen.getByRole('radio', { name: 'Pending' }).getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('radio', { name: 'Approved' }).getAttribute('tabindex')).toBe('-1');
  });

  it('moves the choice with the arrows, and wraps', async () => {
    const user = userEvent.setup();
    render(<Choosing />);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Pending' }));

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Approved' }).getAttribute('aria-checked')).toBe('true');
    // Focus follows the choice, or the next Tab leaves from an option nobody is on.
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Approved' }));

    // Off the left edge of the first option and round to the last.
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('radio', { name: 'Flagged' }).getAttribute('aria-checked')).toBe('true');
  });

  it('never lands the arrows on a disabled option', async () => {
    const user = userEvent.setup();
    function WithDisabled() {
      const [value, setValue] = useState<'a' | 'b' | 'c'>('a');
      return (
        <Tabs
          label="Pick"
          value={value}
          items={[
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B', disabled: true },
            { value: 'c', label: 'C' },
          ]}
          onChange={setValue}
        />
      );
    }
    render(<WithDisabled />);

    await user.tab();
    await user.keyboard('{ArrowRight}');

    expect(screen.getByRole('radio', { name: 'C' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'B' }).getAttribute('aria-checked')).toBe('false');
  });
});

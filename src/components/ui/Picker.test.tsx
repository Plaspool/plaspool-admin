import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Picker, type PickerItem } from './Picker';

/**
 * The dropdown, and specifically the mode with no search field.
 *
 * The searchable mode is the one this component was written for and the returns
 * desk drives it daily. What is new — and therefore what is worth pinning — is
 * that turning the field OFF does not take the keyboard with it: with nothing
 * else inside the popup to hold focus, the list has to take it, or the whole
 * control becomes mouse-only the moment a caller passes `searchable={false}`.
 */

afterEach(cleanup);

const SENTIMENTS: readonly PickerItem<'any' | 'positive' | 'negative'>[] = [
  { value: 'any', label: 'Any sentiment' },
  { value: 'positive', label: 'Positive' },
  { value: 'negative', label: 'Negative' },
];

function Choosing({ searchable }: { searchable?: boolean }) {
  const [value, setValue] = useState<'any' | 'positive' | 'negative'>('any');
  return (
    <Picker
      label="Sentiment"
      value={value}
      items={SENTIMENTS}
      onChange={setValue}
      searchable={searchable}
    />
  );
}

describe('Picker without a search field', () => {
  it('opens with no text field over three rows', async () => {
    const user = userEvent.setup();
    render(<Choosing searchable={false} />);

    await user.click(screen.getByRole('button', { name: /Sentiment/ }));

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  /* The whole point of the mode: no field to hold the keys means the list
     must, and `aria-activedescendant` has to move with it. */
  it('hands the list the focus and the keys', async () => {
    const user = userEvent.setup();
    render(<Choosing searchable={false} />);
    await user.click(screen.getByRole('button', { name: /Sentiment/ }));

    const list = screen.getByRole('listbox', { name: 'Sentiment' });
    expect(document.activeElement).toBe(list);

    await user.keyboard('{ArrowDown}');
    const positive = screen.getByRole('option', { name: 'Positive' });
    expect(list.getAttribute('aria-activedescendant')).toBe(positive.id);

    await user.keyboard('{Enter}');
    // Chosen, and the popup is gone with it.
    expect(screen.getByRole('button', { name: /Sentiment: Positive/ })).toBeTruthy();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('still closes on Escape', async () => {
    const user = userEvent.setup();
    render(<Choosing searchable={false} />);
    await user.click(screen.getByRole('button', { name: /Sentiment/ }));

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).toBeNull();
    // Escape backs out; it never chooses on the way.
    expect(screen.getByRole('button', { name: /Sentiment: Any sentiment/ })).toBeTruthy();
  });

  it('leaves the searchable default alone', async () => {
    const user = userEvent.setup();
    render(<Choosing />);
    await user.click(screen.getByRole('button', { name: /Sentiment/ }));

    const field = screen.getByRole('textbox');
    expect(document.activeElement).toBe(field);

    await user.type(field, 'neg');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: 'Negative' })).toBeTruthy();
  });
});

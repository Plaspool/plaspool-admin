import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The tag field, pinned on the two ways a LIST reaches it.
 *
 * The zone editor's Regions field is this component, and its whole job is a
 * list of state names. The old rule committed only on `endsWith(',')`, which is
 * true exactly once — when the comma is the last character typed. Paste
 * "Abuja, Lagos, Kano" and the whole string became ONE tag, spelled with
 * commas in it, which then had to match a delivery address exactly. Nobody
 * types thirty-seven states one Enter at a time, so paste is the real path.
 *
 * Newline and tab count as separators for the same reason: a column copied out
 * of a spreadsheet arrives that way, and that is where a list of Nigerian
 * states actually lives.
 */

import { TagInput } from './TagInput';

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

function Host({ initial = [] as string[] }) {
  const [value, setValue] = useState<string[]>(initial);
  return (
    <>
      <TagInput label="Regions" value={value} onChange={setValue} placeholder="Abuja, Lagos…" />
      <output data-testid="out">{value.join('|')}</output>
    </>
  );
}

const out = () => screen.getByTestId('out').textContent;

afterEach(cleanup);

describe('TagInput lists', () => {
  it('turns a pasted comma list into one chip per name', async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.click(screen.getByLabelText('Regions'));
    await user.paste('Abuja, Lagos, Kano');

    expect(out()).toBe('Abuja|Lagos|Kano');
    /* The draft is spent — nothing left half-committed behind the caret. */
    expect((screen.getByLabelText('Regions') as HTMLInputElement).value).toBe('');
  });

  it('accepts a spreadsheet column, newlines and all', async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.click(screen.getByLabelText('Regions'));
    await user.paste('Abuja\nLagos\r\nKano\tRivers');

    expect(out()).toBe('Abuja|Lagos|Kano|Rivers');
  });

  it('drops duplicates — against what is chosen and within the paste', async () => {
    const user = userEvent.setup();
    render(<Host initial={['Abuja']} />);
    await user.click(screen.getByLabelText('Regions'));
    await user.paste('abuja, Lagos, LAGOS, Kano');

    expect(out()).toBe('Abuja|Lagos|Kano');
  });

  it('commits on a typed comma and keeps what follows as the draft', async () => {
    const user = userEvent.setup();
    render(<Host />);
    const field = screen.getByLabelText('Regions');
    await user.click(field);
    await user.type(field, 'Abuja,');

    expect(out()).toBe('Abuja');

    await user.type(field, 'Lag');
    /* Mid-word: still the draft, not a tag. */
    expect(out()).toBe('Abuja');
    expect((field as HTMLInputElement).value).toBe('Lag');
  });

  it('keeps the remainder when a comma arrives with text after it', async () => {
    const user = userEvent.setup();
    render(<Host />);
    const field = screen.getByLabelText('Regions');
    await user.click(field);
    /* `endsWith(',')` was blind to this shape and made one tag of the lot. */
    await user.paste('Abuja, Lagos');
    await user.type(field, 'x');

    expect(out()).toBe('Abuja|Lagos');
    expect((field as HTMLInputElement).value).toBe('x');
  });

  it('still adds a single typed name on Enter', async () => {
    const user = userEvent.setup();
    render(<Host />);
    const field = screen.getByLabelText('Regions');
    await user.click(field);
    await user.type(field, 'Ogun{Enter}');

    expect(out()).toBe('Ogun');
  });
});

import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QtyStepper } from './QtyStepper';

/**
 * The counting control, and the two rules it does NOT apply symmetrically.
 *
 * Most of what is worth asserting here is what the box refuses to do to a
 * number somebody typed. A stepper that silently rounds a 3 up to the
 * program's minimum of 5 turns "the customer sent three" into a false claim
 * nobody made, and it does it while the operator is looking at the field — so
 * the minimum stops the BUTTONS and leaves typing alone, while a real ceiling
 * (you cannot accept more than you received) is enforced everywhere.
 */

afterEach(cleanup);

/**
 * A form that actually holds the number. The component is controlled and keeps
 * nothing of its own, so rendering it with a frozen prop would be testing a
 * parent that refuses every edit — which is its own test, further down.
 */
function Counting({
  initial,
  min,
  max,
  onChange,
}: {
  initial: number;
  min?: number;
  max?: number;
  onChange?: (n: number) => void;
}) {
  const [n, setN] = useState(initial);
  return (
    <QtyStepper
      value={n}
      min={min}
      max={max}
      label="Quantity"
      onChange={(next) => {
        onChange?.(next);
        setN(next);
      }}
    />
  );
}

const field = (): HTMLInputElement => screen.getByLabelText('Quantity') as HTMLInputElement;
/**
 * Typed as buttons because the disabled assertions read `.disabled` rather than
 * `toBeDisabled()`: this repo has no `@testing-library/jest-dom`, and the
 * matcher would be a silent `Invalid Chai property` rather than an assertion.
 */
const less = (): HTMLButtonElement =>
  screen.getByRole('button', { name: 'Decrease Quantity' }) as HTMLButtonElement;
const more = (): HTMLButtonElement =>
  screen.getByRole('button', { name: 'Increase Quantity' }) as HTMLButtonElement;

describe('QtyStepper', () => {
  it('names the field and both buttons after the one label it is given', () => {
    render(<Counting initial={6} />);

    expect(field().value).toBe('6');
    // The buttons are icons. Without these names a screen reader announces two
    // unlabelled buttons either side of a number.
    expect(less()).toBeTruthy();
    expect(more()).toBeTruthy();
  });

  it('counts one unit at a time in both directions', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(<Counting initial={6} onChange={changed} />);

    await user.click(more());
    expect(field().value).toBe('7');

    await user.click(less());
    await user.click(less());
    expect(field().value).toBe('5');
    expect(changed.mock.calls.map(([n]) => n)).toEqual([7, 6, 5]);
  });

  it('stops at the floor, and disables the button rather than ignoring it', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(<Counting initial={4} min={4} onChange={changed} />);

    expect(less().disabled).toBe(true);
    await user.click(less());
    expect(field().value).toBe('4');
    expect(changed).not.toHaveBeenCalled();
  });

  it('stops at a ceiling the same way', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(<Counting initial={6} max={6} onChange={changed} />);

    expect(more().disabled).toBe(true);
    await user.click(more());
    expect(field().value).toBe('6');
    expect(changed).not.toHaveBeenCalled();
  });

  it('STILL COUNTS BY ONE FROM BELOW THE MINIMUM — the floor is not a magnet', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    // 3 against a minimum of 5 is a state the typing rule above deliberately
    // allows, so it is a state the buttons have to behave in.
    render(<Counting initial={3} min={5} onChange={changed} />);

    await user.click(more());

    // 5 would be a single tap moving the number by two, and would leave 4
    // unreachable from the buttons entirely.
    expect(field().value).toBe('4');
    expect(changed).toHaveBeenLastCalledWith(4);
  });

  it('steps DOWN into a ceiling that dropped under the value it was holding', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    // Accepted holds 6 and Received has just been corrected to 4: the value is
    // above a limit it never crossed, and `[+]` is already refusing.
    render(<Counting initial={6} max={4} onChange={changed} />);
    expect(more().disabled).toBe(true);

    await user.click(less());

    // 5 would still be more units than were received.
    expect(field().value).toBe('4');
    expect(changed).toHaveBeenLastCalledWith(4);
  });

  it('does not tell the form a number it is already holding', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(<Counting initial={6} onChange={changed} />);

    await user.clear(field());
    await user.type(field(), '6');

    // Retyping the same number is not an edit. Every screen in this section
    // recomputes the live award sentence on this callback, and B4 re-runs a
    // 409 auto-heal from it, so a keystroke that changed nothing must not
    // announce itself as a change.
    expect(field().value).toBe('6');
    expect(changed).not.toHaveBeenCalled();
  });

  it('takes a typed number, for the jump the buttons would take forty taps to reach', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(<Counting initial={4} onChange={changed} />);

    await user.clear(field());
    await user.type(field(), '40');

    expect(field().value).toBe('40');
    expect(changed).toHaveBeenLastCalledWith(40);
  });

  it('CAPS A TYPED NUMBER AT THE CEILING — you cannot accept more than you received', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(<Counting initial={1} max={6} onChange={changed} />);

    await user.clear(field());
    await user.type(field(), '99');

    expect(field().value).toBe('6');
    // Not one keystroke of it reached the form above the ceiling, so a live
    // award line computed from this number can never quote an impossible one.
    expect(changed.mock.calls.every(([n]) => n <= 6)).toBe(true);
    expect(changed).toHaveBeenLastCalledWith(6);
  });

  it('LEAVES A NUMBER BELOW THE MINIMUM ALONE — the minimum is a rule the form states', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(<Counting initial={5} min={5} onChange={changed} />);

    await user.clear(field());
    await user.type(field(), '3');

    // Rewriting this to 5 would put a number in front of the operator that
    // nobody typed and that no customer sent. The route answers `below_minimum`
    // with the minimum in the payload; that is where the correction belongs.
    expect(field().value).toBe('3');
    expect(changed).toHaveBeenLastCalledWith(3);
  });

  it('keeps signs, dots and letters out of the form entirely', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(<Counting initial={1} onChange={changed} />);

    await user.clear(field());
    await user.type(field(), '-1.5x');

    // A quantity is a non-negative whole number of physical objects, and the
    // digits are all that survived: no NaN, no fraction, no minus sign.
    expect(field().value).toBe('15');
    expect(changed.mock.calls.every(([n]) => Number.isInteger(n) && n >= 0)).toBe(true);
  });

  it('treats an emptied box as a half-typed number, never as a zero', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(<Counting initial={6} onChange={changed} />);

    await user.clear(field());

    // The box is empty on screen so the next digit can be typed into it, and
    // the form still holds 6 — a cleared field mid-edit must not submit as 0.
    expect(field().value).toBe('');
    expect(changed).not.toHaveBeenCalled();

    await user.tab();
    expect(field().value).toBe('6');
  });

  it('gives the box back to the form when the form refuses the change', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    // No state behind it: whatever is typed, the value prop stays 6.
    render(<QtyStepper value={6} label="Quantity" onChange={changed} />);

    await user.clear(field());
    await user.type(field(), '9');

    expect(changed).toHaveBeenCalledWith(9);
    // The number on screen is the form's, not the keyboard's. Anything else and
    // a rejected edit would leave the operator reading a quantity that is not
    // the one about to be submitted.
    expect(field().value).toBe('6');
  });

  it('follows the value when something else moves it', () => {
    const { rerender } = render(<QtyStepper value={4} label="Quantity" onChange={vi.fn()} />);
    expect(field().value).toBe('4');

    // A form reset, a server clamp, the Received box driving Accepted down.
    rerender(<QtyStepper value={9} label="Quantity" onChange={vi.fn()} />);
    expect(field().value).toBe('9');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.setConfig({ testTimeout: 20_000 });

/**
 * THE STEPPER, pinned on the behaviours its three call sites each relied on
 * before they shared one component.
 *
 * It is a NUMBER YOU CAN STILL TYPE, not a pair of buttons around a readout.
 * Stock arrives forty at a time; a control that only steps by one would have
 * the owner clicking forty times, so every test that drives a button here has
 * a sibling that drives the keyboard.
 *
 * `value` is a STRING and `onChange` hands back a string, deliberately: all
 * three screens hold their drafts as text so a half-typed "1" on the way to
 * "12" survives, and a numeric prop would round-trip that through NaN.
 */

import { Stepper } from './Stepper';

function Host({
  initial = '3',
  min,
  max,
  fallback,
  disabled,
  error,
}: {
  initial?: string;
  min?: number;
  max?: number;
  fallback?: number;
  disabled?: boolean;
  error?: string | null;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <Stepper
        label="Items per box"
        inputLabel="Items per box in Small"
        decrementLabel="One fewer item in Small"
        incrementLabel="One more item in Small"
        value={value}
        min={min}
        max={max}
        fallback={fallback}
        disabled={disabled}
        error={error}
        onChange={setValue}
      />
      <output data-testid="out">{value}</output>
    </>
  );
}

const out = () => screen.getByTestId('out').textContent;
const plus = () => screen.getByRole('button', { name: 'One more item in Small' });
const minus = () => screen.getByRole('button', { name: 'One fewer item in Small' });
const box = () => screen.getByLabelText('Items per box in Small');

afterEach(cleanup);

describe('the stepper', () => {
  it('steps up and down by one, handing back a string', async () => {
    const user = userEvent.setup();
    render(<Host initial="3" />);

    await user.click(plus());
    expect(out()).toBe('4');

    await user.click(minus());
    await user.click(minus());
    expect(out()).toBe('2');
  });

  /* The whole point of keeping a real input: forty boxes arrive at once and
   * nobody clicks forty times. */
  it('still takes a typed number', async () => {
    const user = userEvent.setup();
    render(<Host initial="3" />);

    await user.clear(box());
    await user.type(box(), '40');
    expect(out()).toBe('40');

    // And the buttons carry on from what was typed, not from where they were.
    await user.click(plus());
    expect(out()).toBe('41');
  });

  it('will not step below min, and says so by disabling the button', async () => {
    const user = userEvent.setup();
    render(<Host initial="2" min={1} />);

    await user.click(minus());
    expect(out()).toBe('1');
    expect(minus()).toHaveProperty('disabled', true);
  });

  it('will not step above max', async () => {
    const user = userEvent.setup();
    render(<Host initial="4" max={5} />);

    await user.click(plus());
    expect(out()).toBe('5');
    expect(plus()).toHaveProperty('disabled', true);
  });

  /*
   * A CLEARED BOX IS NOT A ZERO. Mystery box sizes started at 1 and the stock
   * panel starts at whatever the variant already has, so where a step lands
   * from an empty box is the CALLER's fact, not a constant this component
   * gets to pick.
   */
  it('steps from the caller’s fallback when the box has been cleared', async () => {
    const user = userEvent.setup();
    render(<Host initial="7" fallback={7} min={0} />);

    await user.clear(box());
    expect(out()).toBe('');

    await user.click(plus());
    expect(out()).toBe('8');
  });

  it('treats a half-typed minus sign as empty rather than as a number', async () => {
    const user = userEvent.setup();
    render(<Host initial="5" fallback={5} />);

    await user.clear(box());
    await user.type(box(), '-');
    expect(out()).toBe('-');

    // Not NaN, and not 0 — back to the fallback and up one.
    await user.click(plus());
    expect(out()).toBe('6');
  });

  it('disables all three controls together', () => {
    render(<Host disabled />);

    expect(box()).toHaveProperty('disabled', true);
    expect(plus()).toHaveProperty('disabled', true);
    expect(minus()).toHaveProperty('disabled', true);
  });

  it('marks the input invalid and shows the message', () => {
    render(<Host error="Enter a whole number." />);

    expect(box().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Enter a whole number.')).toBeTruthy();
    // The error is reachable from the input, not merely sitting near it.
    expect(box().getAttribute('aria-describedby')).toBeTruthy();
  });

  /* The visible label names the field; the input carries the row it belongs
   * to. Both matter — a screen reader on a table of sizes hears "Items per box
   * in Small", while the eye reads one short word above the number. */
  it('keeps the visible label and the input’s own name both', () => {
    render(<Host />);

    expect(screen.getByText('Items per box')).toBeTruthy();
    expect(box().getAttribute('aria-label')).toBe('Items per box in Small');
  });
});

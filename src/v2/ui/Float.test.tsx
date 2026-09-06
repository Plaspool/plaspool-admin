import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { act } from 'react';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The float, pinned on the dismissal that made it unusable on a phone.
 *
 * AN ON-SCREEN KEYBOARD IS A RESIZE. Tapping the search box inside a
 * SearchSelect focuses an input; Android/Chrome shrinks the layout viewport to
 * make room for the keyboard; `window.resize` fires. The float used to close on
 * any resize, so the panel dismissed the very input the tap had just focused —
 * reported from a real phone as "it opens and closes immediately, my keyboard
 * opens", and invisible to every previous test because jsdom has no keyboard.
 *
 * The discriminator is the WIDTH: a rotation or a window drag moves it, a
 * keyboard never does. So the two cases below are the whole rule, and they
 * differ only in whether `innerWidth` changes.
 */

import { Float } from './Float';

function Host({ align = 'left' as const }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button ref={anchor} type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Float
        open={open}
        anchor={anchor}
        onClose={() => setOpen(false)}
        align={align}
        className="probe__panel"
        role="dialog"
        ariaLabel="Probe"
      >
        <input aria-label="Search inside" />
      </Float>
    </div>
  );
}

/** Resize the viewport the way a browser does: set the property, then fire. */
function resizeTo(width: number, height: number) {
  act(() => {
    (window as unknown as { innerWidth: number }).innerWidth = width;
    (window as unknown as { innerHeight: number }).innerHeight = height;
    window.dispatchEvent(new Event('resize'));
  });
}

afterEach(() => {
  cleanup();
  (window as unknown as { innerWidth: number }).innerWidth = 1024;
  (window as unknown as { innerHeight: number }).innerHeight = 768;
});

describe('Float dismissal on resize', () => {
  it('STAYS OPEN when only the height changes — that is the keyboard', async () => {
    resizeTo(375, 812);
    render(<Host />);
    act(() => screen.getByRole('button', { name: 'Open' }).click());
    expect(screen.getByRole('dialog', { name: 'Probe' })).toBeTruthy();

    /* The keyboard takes roughly half the screen and no width at all. */
    resizeTo(375, 400);

    expect(screen.queryByRole('dialog', { name: 'Probe' })).not.toBeNull();
    expect(screen.getByLabelText('Search inside')).toBeTruthy();
  });

  it('CLOSES when the width changes — a rotation or a window drag', async () => {
    resizeTo(375, 812);
    render(<Host />);
    act(() => screen.getByRole('button', { name: 'Open' }).click());
    expect(screen.getByRole('dialog', { name: 'Probe' })).toBeTruthy();

    resizeTo(812, 375);

    expect(screen.queryByRole('dialog', { name: 'Probe' })).toBeNull();
  });

  it('survives a keyboard opening AND closing, the way a typed search does', async () => {
    resizeTo(375, 812);
    render(<Host />);
    act(() => screen.getByRole('button', { name: 'Open' }).click());

    resizeTo(375, 400); // keyboard up
    resizeTo(375, 812); // keyboard down

    expect(screen.queryByRole('dialog', { name: 'Probe' })).not.toBeNull();
  });
});

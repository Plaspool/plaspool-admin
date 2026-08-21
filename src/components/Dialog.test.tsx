import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog, Dialog } from './Dialog';

/**
 * THE TWO PROMISES `Dialog` MAKES TO EVERY SCREEN IN THE APP, GUARDED WHERE IT
 * MAKES THEM RATHER THAN INSIDE WHICHEVER CONSUMER NOTICED THEM BREAKING.
 *
 * There is one dialog in this codebase. The shop's confirmations, the editor's
 * cover picker and alt-text box, the revision panel, the shortcuts sheet, the
 * broadcast composer and the orders board are all this file's single element
 * wearing different children — which is why both defects below were not "a bug
 * on the board" but the same bug on every surface at once: dismissing a dialog
 * dropped focus on `<body>` (SC 2.4.3), and no dialog anywhere carried an
 * accessible name (SC 4.1.2).
 *
 * A consumer's suite CAN cover this and `Board.test.tsx` does, from the board.
 * That is worth having and is not this: coverage that lives in one caller
 * leaves with that caller, and the guarantee it was standing in for is shared.
 * Everything here drives the component through the two mounting shapes its
 * callers actually use, so the next consumer inherits the assertions instead of
 * having to remember to rewrite them.
 */

afterEach(cleanup);

/*
 * jsdom DOES NOT IMPLEMENT `<dialog>` — measured in this environment rather
 * than assumed. Its `HTMLDialogElement` impl class is empty and the generated
 * interface exposes only the `open` attribute's reflection: `showModal` and
 * `close` are both `undefined`. `Dialog` calls `showModal()` from an effect, so
 * with no shim at all every case in this file dies during commit for a reason
 * that has nothing to do with the component.
 *
 * SO THE SHIM MODELS THE THREE UA BEHAVIOURS THE ASSERTIONS ARE ABOUT, and
 * modelling them is the point rather than a convenience. Per HTML,
 * `showModal()` (a) remembers whatever was focused at the instant it ran and
 * (b) moves focus into the dialog; `close()` (c) hands focus back to what (a)
 * remembered. Tearing a still-open modal out of the document does none of the
 * three.
 *
 * (b) IS THE HALF A LAZIER SHIM WOULD SKIP AND THE HALF THAT MAKES THIS FILE
 * MEAN ANYTHING. Flip `open` and nothing else, and focus stays parked on the
 * trigger for the whole test — exactly where the assertion wants to find it —
 * so the case passes against the component that never closed the dialog just as
 * happily as against the one that does. With focus genuinely moved inside, a
 * `Dialog` that unmounts while open loses it to `<body>` here for the same
 * reason it did in Chrome, and the assertion has something to catch. Verified
 * by reverting the fix: without the unmount-time `close()`, every focus case
 * below fails.
 *
 * WHAT IT STILL CANNOT PROVE, said plainly rather than papered over. There is
 * no top layer, no `:modal`, no focus TRAP — tabbing out of a dialog is not
 * stopped here — and no hit testing, so "the backdrop" below is a click whose
 * target is the `<dialog>` element, which is what a real browser reports for a
 * backdrop click and what the component keys on, but is not the same act as
 * clicking at those coordinates. Likewise Escape: jsdom has no modal dialogs to
 * press Escape on, so the case dispatches the `cancel` event the UA would have
 * fired. Those three are the browser run's to settle. This file settles that
 * the component's own contract holds and cannot regress unnoticed.
 */
type Shimmed = HTMLDialogElement & { __restoreTo?: Element | null };
const dialogProto = Object.getPrototypeOf(document.createElement('dialog'));

/**
 * The UA's "dialog focusing steps", cut down to what jsdom can honour: the
 * autofocus candidate if the dialog has one, else the first focusable
 * descendant. The real algorithm falls back to focusing the dialog element
 * itself, which jsdom will not do for an element with no `tabindex` — a gap
 * that costs nothing here, because every dialog in this repo contains at least
 * one button.
 */
function focusInto(el: HTMLDialogElement): void {
  const target =
    el.querySelector<HTMLElement>('[autofocus]') ??
    el.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
  target?.focus();
}

dialogProto.showModal = function (this: Shimmed) {
  this.open = true;
  // Captured BEFORE focus moves, which is the order the spec gives and the
  // order the whole restore depends on.
  this.__restoreTo = document.activeElement;
  focusInto(this);
};
dialogProto.close = function (this: Shimmed) {
  this.open = false;
  const back = this.__restoreTo ?? null;
  this.__restoreTo = null;
  if (back instanceof HTMLElement && back.isConnected) back.focus();
};

// ────────────────────────────────────────────────────────── the two shapes

/**
 * THE SHAPE THE FOCUS BUG LIVED IN, and the one most of this repo uses:
 * `{pending !== null && <Dialog open …/>}`. The dialog does not exist until
 * there is something to ask, and every way out of it does the same single thing
 * — stop rendering it — so React unmounts a still-open modal and the UA's
 * restore step never runs. The orders board, `ShopProducts`, `Settings`,
 * `MarketingBanners` and the returns queue all mount theirs like this.
 *
 * It carries TWO ways out on purpose. The footer's "Close" belongs to `Dialog`;
 * the "Cancel" in the body belongs to the CALLER and never touches the dialog
 * element at all — it is a form's own button, the way `ShipmentForm` and
 * `LogReturn` supply theirs. A fix that only handled the component's own button
 * would pass one of those and fail the other.
 */
function Conditional({
  title = 'A question worth asking',
  footer,
}: {
  title?: string;
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open it</button>
      {/* A second control, so "focus came back" cannot be satisfied by the
          trigger simply being the only button left standing. */}
      <button>Somewhere else entirely</button>
      {open && (
        <Dialog open onClose={() => setOpen(false)} title={title} footer={footer}>
          <p>Body copy.</p>
          <button onClick={() => setOpen(false)}>Cancel</button>
        </Dialog>
      )}
    </>
  );
}

/**
 * THE OTHER SHAPE: mounted once and toggled, which is what `ShortcutsDialog`
 * does above the router. This one never unmounts, so it takes the ANIMATED exit
 * — a different branch of the component, where the `close()` that restores
 * focus happens 200ms later, after the panel has finished leaving. Worth its
 * own case because the two branches restore focus by different means and only
 * one of them is the thing that was broken.
 */
function Toggled() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open it</button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Still mounted when shut" />
    </>
  );
}

/** The `<dialog>` currently open, whichever consumer put it there. */
function openDialog(): HTMLDialogElement {
  const el = [...document.querySelectorAll('dialog')].find((d) => d.open);
  if (el === undefined) throw new Error('no dialog is open');
  return el;
}

// ─────────────────────────────────────────────────── where focus goes (2.4.3)

/**
 * The four ways out, which are four spellings of ONE act — flipping the
 * caller's state back — and therefore four chances for a fix that only
 * understood one of them.
 */
const ROUTES: Record<string, (dialog: HTMLDialogElement) => void> = {
  escape: (dialog) => {
    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }));
  },
  backdrop: (dialog) => {
    fireEvent.click(dialog);
  },
  'the footer Close': (dialog) => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  },
  'the form own Cancel': (dialog) => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  },
};

describe('a dismissed dialog hands focus back', () => {
  it.each(Object.keys(ROUTES))(
    'to the control that opened it, dismissed by %s',
    async (route) => {
      const user = userEvent.setup();
      render(<Conditional />);
      const trigger = screen.getByRole('button', { name: 'Open it' });
      await user.click(trigger);

      const dialog = openDialog();
      /*
       * The premise, asserted rather than assumed: focus really did leave the
       * trigger. Skip this and a case could "pass" by never having moved, which
       * is the failure mode the shim's focusing step exists to rule out.
       */
      expect(dialog.contains(document.activeElement)).toBe(true);

      ROUTES[route](dialog);
      await waitFor(() => expect(document.querySelector('dialog')).toBeNull());

      // Not `<body>`, and not merely "somewhere on the page" — the exact button.
      expect(document.activeElement, `after ${route}`).toBe(trigger);
    },
  );

  /**
   * THE SECOND CONSUMER, and a real one rather than another local harness.
   * `ConfirmDialog` is what `RequireAuth`, the dashboard, the editor, the shop
   * and the board reach for, and it differs in the way that matters here: its
   * confirm button carries `autoFocus`, so React moves focus during commit —
   * BEFORE the effect that opens the dialog runs — and the anchor the UA
   * records can end up pointing at a node that is about to leave with the
   * dialog. The component remembers the opener itself for exactly this.
   */
  it('from a ConfirmDialog abandoned by its own dismiss button', async () => {
    const user = userEvent.setup();

    function Asking() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Trash it</button>
          {open && (
            <ConfirmDialog
              open
              onClose={() => setOpen(false)}
              onConfirm={() => {}}
              title="Move to trash?"
              confirmLabel="Move to trash"
              dismissLabel="Keep it"
            />
          )}
        </>
      );
    }

    render(<Asking />);
    const trigger = screen.getByRole('button', { name: 'Trash it' });
    await user.click(trigger);

    const dialog = openDialog();
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(document.querySelector('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  /**
   * THE BELT, TESTED SEPARATELY FROM THE BRACES.
   *
   * Everything above passes on the UA's own restore. This case takes that away:
   * the shim is rewritten to anchor on whatever is focused AFTER the dialog has
   * pulled focus in — i.e. on a node inside the dialog, which is precisely what
   * a stray `autoFocus` landing before `showModal()` produces. `close()` then
   * dutifully restores focus to something that is one tick from being removed,
   * and only the opener the component captured during render can save it.
   *
   * Without this, that branch of `Dialog` is unreachable from any test here and
   * could be deleted without a single case going red.
   */
  it('even when the UA anchored on a node inside the dialog', async () => {
    const real = dialogProto.showModal;
    dialogProto.showModal = function (this: Shimmed) {
      this.open = true;
      focusInto(this);
      this.__restoreTo = document.activeElement;
    };

    try {
      const user = userEvent.setup();
      render(<Conditional />);
      const trigger = screen.getByRole('button', { name: 'Open it' });
      await user.click(trigger);

      const dialog = openDialog();
      expect(dialog.contains(document.activeElement)).toBe(true);
      // The anchor is genuinely wrong, or this case is testing the happy path.
      expect(dialog.contains((dialog as Shimmed).__restoreTo ?? null)).toBe(true);

      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(document.querySelector('dialog')).toBeNull());
      expect(document.activeElement).toBe(trigger);
    } finally {
      dialogProto.showModal = real;
    }
  });

  /**
   * The mounted-and-toggled branch, where the dialog survives its own dismissal
   * and closes on the far side of the exit animation. Nothing here was broken —
   * this path always reached `close()` — and that is the reason to pin it: the
   * unmount fix must not have quietly moved the restore off the path that
   * already worked.
   */
  it('from a dialog that stays mounted and plays its exit first', async () => {
    const user = userEvent.setup();
    render(<Toggled />);
    const trigger = screen.getByRole('button', { name: 'Open it' });
    await user.click(trigger);

    const dialog = openDialog();
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    // The 200ms is the animation's, not this test's: waited out rather than
    // faked, because a fake clock here would be asserting that the timer was
    // scheduled instead of that focus came home.
    await waitFor(() => expect(dialog.open).toBe(false), { timeout: 2000 });
    expect(document.activeElement).toBe(trigger);
  });
});

// ───────────────────────────────────────── what it is called (SC 4.1.2)

/**
 * A labelling attribute must resolve or not exist. `aria-labelledby` aimed at a
 * missing id computes to `""`, and an empty name is NOT the same as an absent
 * one: the browser will not fall back from it, so the dialog ends up announced
 * as less than it would have been with no attribute at all. Asserted as an
 * invariant rather than case by case so it holds for the titled and untitled
 * dialogs alike.
 */
function expectNoDanglingLabel(dialog: HTMLElement): void {
  const by = dialog.getAttribute('aria-labelledby');
  if (by === null) return;
  for (const id of by.split(/\s+/).filter(Boolean)) {
    const target = document.getElementById(id);
    expect(target, `aria-labelledby points at #${id}, which is not in the document`).not.toBeNull();
    expect((target?.textContent ?? '').trim()).not.toBe('');
  }
}

describe('a dialog says what it is', () => {
  it('taking its accessible name from the heading a sighted operator reads', async () => {
    const user = userEvent.setup();
    render(<Conditional title="Pack order 2026-000123-A" />);
    await user.click(screen.getByRole('button', { name: 'Open it' }));

    // The COMPUTED name, not merely the presence of the attribute — which is
    // the entire claim, since a reference to nothing computes to nothing.
    expect(screen.getByRole('dialog', { name: 'Pack order 2026-000123-A' })).toBeTruthy();

    const dialog = openDialog();
    expectNoDanglingLabel(dialog);
    // ...and it is the visible heading being pointed at, not a duplicate string
    // kept in an attribute where the two can drift apart.
    const by = dialog.getAttribute('aria-labelledby');
    expect(by).toBeTruthy();
    expect(document.getElementById(by as string)).toBe(dialog.querySelector('.dialog__title'));
  });

  /**
   * The guard, which is the half that is easy to get wrong in the direction
   * that looks fixed. `title` is a required prop and every call site in this
   * repo passes a real one; this is the day one of them passes a value that is
   * empty at runtime — a category name that has not loaded, an order number
   * that came back null.
   */
  it('and leaves no reference dangling when there is no title to point at', async () => {
    const user = userEvent.setup();
    render(<Conditional title="" />);
    await user.click(screen.getByRole('button', { name: 'Open it' }));

    const dialog = openDialog();
    expect(dialog.hasAttribute('aria-labelledby')).toBe(false);
    expect(dialog.hasAttribute('aria-label')).toBe(false);
    // No empty heading left behind for it to have pointed at either.
    expect(dialog.querySelector('.dialog__title')).toBeNull();
    expectNoDanglingLabel(dialog);
  });

  /**
   * Two on screen at once, because the ids are generated and generated ids are
   * where a shared component gets to be wrong in a way one dialog never
   * reveals. `useId` is per-instance; a module-level counter or a constant
   * would have both panels answering to the same heading.
   */
  it('and names two dialogs at once without either borrowing the other id', () => {
    render(
      <>
        <Dialog open onClose={() => {}} title="The first question" />
        <Dialog open onClose={() => {}} title="The second question" />
      </>,
    );

    const dialogs = [...document.querySelectorAll('dialog')];
    expect(dialogs).toHaveLength(2);

    const ids = dialogs.map((d) => d.getAttribute('aria-labelledby'));
    expect(ids[0]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);

    for (const dialog of dialogs) expectNoDanglingLabel(dialog);
    expect(screen.getByRole('dialog', { name: 'The first question' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'The second question' })).toBeTruthy();
  });
});

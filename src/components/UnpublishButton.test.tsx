import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { UnpublishButton } from './UnpublishButton';

/**
 * Unpublishing, and the one case where it is not a single click.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS ADMIN-UI ITEM 4 OF THE STOREFRONT'S CONTRACT, and the reason it gets
 * a component of its own rather than three more `useState`s in a 780-line
 * editor: the behaviour is a consequence on a DIFFERENT PAGE than the one being
 * edited. Unpublishing clears `featured` and `featured_rank` in the same
 * statement as the status change (invariant 3), so the post leaves the blog's
 * front as well as its published list. Told afterwards, that is an undo the
 * writer has to know to want.
 *
 * The button must stay one click for the ordinary case. A confirmation on every
 * unpublish would be a dialog people learn to dismiss without reading, which is
 * how the one that matters gets dismissed too.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const dialogProto = Object.getPrototypeOf(document.createElement('dialog'));
dialogProto.showModal = function (this: HTMLDialogElement) {
  this.open = true;
};
dialogProto.close = function (this: HTMLDialogElement) {
  this.open = false;
};

/**
 * `ConfirmDialog` keeps its `<dialog>` MOUNTED and toggles `open`, so the
 * warning's text is in the document whether or not it has been shown. A real
 * browser hides a closed `<dialog>` with `display: none` from the UA
 * stylesheet; jsdom applies no such sheet, so `queryByText` finds it either way
 * and an assertion written against the text would pass for a dialog that never
 * opened. `open` is the only thing that distinguishes "asked" from "did not
 * ask" — the same reason `RequireAuth.test.tsx` asserts on `showModal`.
 */
const asked = (): boolean =>
  document.querySelector('dialog')?.hasAttribute('open') ?? false;

afterEach(cleanup);

describe('a post that is not featured', () => {
  it('unpublishes on the first click, with nothing in the way', async () => {
    const run = vi.fn();
    render(<UnpublishButton featured={false} onUnpublish={run} />);

    await userEvent.click(screen.getByRole('button', { name: 'Unpublish' }));

    expect(run).toHaveBeenCalledTimes(1);
    expect(asked()).toBe(false);
  });
});

describe('a post that is featured', () => {
  it('warns that it will leave the rail, and does not act yet', async () => {
    const run = vi.fn();
    render(<UnpublishButton featured onUnpublish={run} />);

    await userEvent.click(screen.getByRole('button', { name: 'Unpublish' }));

    expect(await screen.findByText(/This post is featured/i)).toBeTruthy();
    // The warning names the consequence AND the fact that it is not undone by
    // re-publishing — curation is deliberate and is not restored automatically.
    expect(screen.getByText(/will not put it back/i)).toBeTruthy();
    expect(asked()).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it('unpublishes once the warning is accepted', async () => {
    const run = vi.fn();
    render(<UnpublishButton featured onUnpublish={run} />);

    await userEvent.click(screen.getByRole('button', { name: 'Unpublish' }));
    await userEvent.click(await screen.findByRole('button', { name: /Unpublish anyway/i }));

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });

  it('leaves the post published when the warning is dismissed', async () => {
    const run = vi.fn();
    render(<UnpublishButton featured onUnpublish={run} />);

    await userEvent.click(screen.getByRole('button', { name: 'Unpublish' }));
    await userEvent.click(await screen.findByRole('button', { name: /cancel/i }));

    // The whole point of asking: "no" has to mean nothing happened.
    expect(run).not.toHaveBeenCalled();
  });
});

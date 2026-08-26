import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.setConfig({ testTimeout: 20_000 });

/**
 * v2's description editor, pinned on the ways it can lose or leak data
 * quietly — the debt ledger's RichText items:
 *
 *  - A stored doc carrying a node this schema cannot hold must LOCK the
 *    editor (the content-check path), never hydrate as a stripped copy —
 *    a save after a silent strip overwrites the stored description and a
 *    customer-facing block is gone with no error anywhere.
 *  - Hydration happens ONCE and OUTSIDE the undo history: `setContent` is an
 *    ordinary undoable step, so hydrating as an edit puts "empty → whole
 *    description" on the stack and one Ctrl+Z blanks the field; and a parent
 *    re-render with a fresh `value` must not clobber what has been typed.
 *  - The image node view pairs every acquire with a release, INCLUDING the
 *    acquire that resolves after the node view is already destroyed — the
 *    unpaired acquire is a leaked refcount on an object URL.
 *  - The insert-image button exists only where the orphan collector walks
 *    (blog posts). A product description's embedded image is outside the
 *    collector's reference walk (v1's §1.10 rule) and would be deleted from
 *    under the page, so the default is NO button and product screens never
 *    opt in.
 *
 * `../../data/images` IS MOCKED, an exception to the route suites'
 * stub-fetch-not-modules rule: that module is the refcounted object-URL
 * registry (and drags Dexie in with it), and the contract under test here is
 * exactly the acquire/release pairing at its seam — timing included, which
 * only a promise the test controls can produce. Everything else (TipTap, the
 * schema, the node view, the toolbar) is real.
 */

vi.mock('../../data/images', () => ({
  acquireImageURL: vi.fn(),
  releaseImageURL: vi.fn(),
  storeImageFile: vi.fn(),
  ImageError: class ImageError extends Error {},
}));

import { acquireImageURL, releaseImageURL } from '../../data/images';
import { RichText } from './RichText';

// -------------------------------------------------------------- doc builders

const doc = (...content: unknown[]): unknown => ({ type: 'doc', content });
const para = (text: string): unknown => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

/**
 * `@tiptap/react` destroys the editor on a `setTimeout(…, 1)` scheduled
 * during unmount (`EditorInstanceManager.scheduleDestroy`), so the node views
 * outlive `unmount()` by a tick. A timer queued AFTER that one necessarily
 * fires after it — awaiting this guarantees the destroy has run, without
 * guessing at machine speed.
 */
const editorReallyDestroyed = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(acquireImageURL).mockResolvedValue('blob:mock-url');
});

afterEach(cleanup);

// ============================================================================

describe('the v2 description editor', () => {
  it('locks editing over a node outside the schema instead of letting a save strip it', async () => {
    /*
     * A node type neither v1 nor v2 defines. With `enableContentCheck` the
     * hydrate throws and the component locks; WITHOUT it TipTap would warn,
     * hydrate the stripped remainder, and the next save would overwrite the
     * stored description with the stripped copy — which is exactly the bug
     * the lock exists to prevent, so the strip must be observable as absent.
     */
    const onChange = vi.fn();
    render(
      <RichText
        value={doc({ type: 'videoEmbed', attrs: { src: 'https://example.com' } }, para('Kept'))}
        onChange={onChange}
      />,
    );

    // The honest sentence, in a status region.
    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain('editing is locked');

    // The surface itself is read-only…
    await waitFor(() =>
      expect(screen.getByLabelText('Description').getAttribute('contenteditable')).toBe('false'),
    );
    // …every tool is off…
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Link' })).toHaveProperty('disabled', true);
    // …and the parent's draft never received a stripped copy to save.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('hydrates once, outside the undo history', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<RichText value={doc(para('First words'))} onChange={onChange} />);

    await screen.findByText('First words');
    // The counterpart of the lock test: a doc the schema holds does NOT lock.
    expect(screen.queryByRole('status')).toBeNull();

    /*
     * OUTSIDE THE HISTORY: if hydration were an ordinary step, "empty → whole
     * description" would sit on the undo stack and the Undo tool would light
     * up — one press would blank the field. `addToHistory: false` is what
     * keeps it off, and the disabled button is that rule made visible.
     */
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Undo' })).toHaveProperty('disabled', true),
    );
    // And outside the update event: hydration is not an edit, so the parent's
    // dirty-tracking must not fire for it (`emitUpdate: false`).
    expect(onChange).not.toHaveBeenCalled();

    /*
     * ONCE: a later render with a different `value` — a background refetch,
     * a parent state echo — must not re-hydrate over live typing. The
     * documented reset path is a remount via `key`, never the prop.
     */
    rerender(<RichText value={doc(para('Second thoughts'))} onChange={onChange} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText('Second thoughts')).toBeNull();
    expect(screen.getByText('First words')).toBeTruthy();
  });

  it('releases the image node view’s acquire even when it resolves after destroy', async () => {
    /*
     * The race the refcount contract has to survive: the node view is
     * destroyed (screen navigated away) while `acquireImageURL` is still in
     * flight. Destroy alone must release NOTHING — nothing was acquired yet,
     * and an early release would decrement a count some other holder owns.
     * The late resolve is what must pay the release, exactly once.
     */
    let resolveAcquire!: (url: string | null) => void;
    vi.mocked(acquireImageURL).mockReturnValue(
      new Promise((r) => {
        resolveAcquire = r;
      }),
    );

    const { unmount } = render(
      <RichText
        value={doc({ type: 'image', attrs: { src: 'idb:img_late', alt: '' } }, para('Below'))}
        onChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(acquireImageURL).toHaveBeenCalledWith('img_late'));

    unmount();
    await editorReallyDestroyed();
    expect(releaseImageURL).not.toHaveBeenCalled();

    resolveAcquire('blob:landed-too-late');
    await waitFor(() => expect(releaseImageURL).toHaveBeenCalledWith('img_late'));
    // Paired, not showered: one acquire, one release, the same id.
    expect(vi.mocked(releaseImageURL).mock.calls).toEqual([['img_late']]);
  });

  it('offers no insert-image button unless images are allowed — the product default', async () => {
    /*
     * The orphan collector's reference walk covers a product's cover and
     * gallery ids and NOT images embedded in its description, so an embedded
     * one would be swept from under the live page (§1.10). ProductDetail
     * renders `<RichText>` bare; the OFF default is what protects it. The
     * positive half is the control — proof the query would find the button
     * where posts legitimately get it.
     */
    render(<RichText value={doc(para('A product'))} onChange={vi.fn()} />);
    await screen.findByText('A product');
    expect(screen.queryByRole('button', { name: 'Insert image' })).toBeNull();
    cleanup();

    render(<RichText value={doc(para('A post'))} onChange={vi.fn()} allowImages />);
    await screen.findByText('A post');
    expect(screen.getByRole('button', { name: 'Insert image' })).toBeTruthy();
  });
});

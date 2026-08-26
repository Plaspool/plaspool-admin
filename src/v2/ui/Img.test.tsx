import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

vi.setConfig({ testTimeout: 20_000 });

/**
 * `StoredImg`, pinned on the one thing it can get wrong invisibly (the debt
 * ledger's Img item): `acquireImageURL` refcounts object URLs, so EVERY
 * acquire must be paired with a release — including the acquire that resolves
 * only after the component is already gone. Miss that pairing and the count
 * never reaches zero, the object URL is never revoked, and the blob it pins
 * leaks for the life of the tab; release too early instead and the decrement
 * lands on a count some other mounted holder owns.
 *
 * `../../data/images` IS MOCKED — an exception to the route suites'
 * stub-fetch-not-modules rule — because the refcount registry itself is the
 * seam under test and the race only exists when the test controls exactly
 * when the acquire resolves. The component is real.
 */

vi.mock('../../data/images', () => ({
  acquireImageURL: vi.fn(),
  releaseImageURL: vi.fn(),
  storeImageFile: vi.fn(),
  ImageError: class ImageError extends Error {},
}));

import { acquireImageURL, releaseImageURL } from '../../data/images';
import { StoredImg } from './Img';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

// ============================================================================

describe('StoredImg', () => {
  it('releases the acquired URL when the acquire resolves after unmount', async () => {
    let resolveAcquire!: (url: string | null) => void;
    vi.mocked(acquireImageURL).mockReturnValue(
      new Promise((r) => {
        resolveAcquire = r;
      }),
    );

    const { unmount } = render(<StoredImg id="img_late" alt="A cover" />);
    await waitFor(() => expect(acquireImageURL).toHaveBeenCalledWith('img_late'));

    unmount();
    /*
     * The effect cleanup ran with nothing acquired yet. Releasing HERE would
     * be the opposite bug: a decrement against a refcount this component
     * never held, revoking a URL out from under whoever does hold it.
     */
    expect(releaseImageURL).not.toHaveBeenCalled();

    resolveAcquire('blob:landed-too-late');
    await waitFor(() => expect(releaseImageURL).toHaveBeenCalledWith('img_late'));
    // Exactly the pairing: one acquire, one release, the same id.
    expect(vi.mocked(releaseImageURL).mock.calls).toEqual([['img_late']]);
  });
});

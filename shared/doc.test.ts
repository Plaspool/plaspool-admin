/**
 * The first test under `shared/`.
 *
 * Until this file existed, the `shared` vitest project collected **zero** files
 * and reported success — deleting the `asset:` branch of `imageIdFromSrc`
 * outright left the whole suite green. `shared/` is the module both `src/` and
 * `server/` import, so a silent hole there is the worst-placed hole in the
 * repo.
 *
 * `imageIdFromSrc` is the scheme seam of spec §7: `DocRenderer` routes every
 * stored image through it, so a bug here renders "Image unavailable" for every
 * image in every post rather than throwing anywhere visible.
 */
import { describe, expect, it } from 'vitest';
import { ASSET_SCHEME, IDB_SCHEME, imageIdFromSrc } from './doc';

describe('imageIdFromSrc', () => {
  it('reads the id out of an asset: src — the canonical scheme after cutover', () => {
    expect(imageIdFromSrc('asset:img_abc123')).toBe('img_abc123');
    expect(ASSET_SCHEME).toBe('asset:');
  });

  it('still reads idb:, which is what every pre-migration document uses', () => {
    // Rejecting `idb:` would make migration impossible: it is the scheme every
    // locally authored document already carries.
    expect(imageIdFromSrc('idb:img_local9')).toBe('img_local9');
    expect(IDB_SCHEME).toBe('idb:');
  });

  it('returns null for a scheme it does not own', () => {
    // https: is a legitimate image src, but it is not an id — the caller must
    // fall through to using it as a URL rather than looking it up.
    expect(imageIdFromSrc('https://example.com/cat.png')).toBeNull();
    expect(imageIdFromSrc('data:image/png;base64,iVBOR')).toBeNull();
    expect(imageIdFromSrc('javascript:alert(1)')).toBeNull();
    expect(imageIdFromSrc('img_abc123')).toBeNull();
    expect(imageIdFromSrc('')).toBeNull();
    // Scheme matching is prefix-anchored, not a substring search.
    expect(imageIdFromSrc('https://example.com/x?u=asset:img_1')).toBeNull();
  });

  it('returns null for anything that is not a string', () => {
    // `node.attrs?.src` is `unknown` at the call site, so this is reached by
    // ordinary documents, not just hostile ones.
    expect(imageIdFromSrc(undefined)).toBeNull();
    expect(imageIdFromSrc(null)).toBeNull();
    expect(imageIdFromSrc(42)).toBeNull();
    expect(imageIdFromSrc({ src: 'asset:img_1' })).toBeNull();
    expect(imageIdFromSrc(['asset:img_1'])).toBeNull();
  });

  it('returns null for a scheme with no id rather than an empty id', () => {
    // The edge that decides between "no image" and a lookup for `''`, which
    // would miss and be reported as a missing image anyway — but only after a
    // pointless round trip, and with `''` as a cache key.
    expect(imageIdFromSrc('asset:')).toBeNull();
    expect(imageIdFromSrc('idb:')).toBeNull();
  });
});

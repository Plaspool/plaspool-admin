import { useEffect, useState } from 'react';
import { acquireImageURL, releaseImageURL } from '../data/images';

/**
 * Renders an image by its BARE id, from whichever side of the cutover holds it.
 *
 * `acquireImageURL` decides: a local blob becomes a refcounted object URL,
 * cleaned up on unmount exactly as before; anything else becomes
 * `/api/images/<id>`, which the browser follows to a signed URL. Both arrive
 * here as a string and nothing below has to know which it got — the release in
 * the cleanup is a no-op for the server case, because `releaseImageURL` only
 * knows ids it minted an object URL for.
 *
 * The prop is still named `blobId` because `CoverImage.blobId` is, and that
 * field is read by the server's own SQL as `cover_image->>'blobId'` — renaming
 * it here would be renaming a column's contract for cosmetics.
 *
 * A missing, unreadable or 404ing image degrades to a styled placeholder
 * instead of a broken-image icon — and never takes the surrounding post down
 * with it. That matters more after the cutover than before it: an image can now
 * fail because the network did.
 */
export function StoredImg({
  blobId,
  alt,
  focalPoint = '50% 50%',
  className,
  eager = false,
}: {
  blobId: string;
  alt: string;
  focalPoint?: string;
  className?: string;
  eager?: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    // Exactly one release per successful acquire. Cleanup releases only if
    // the acquire actually landed; otherwise the late resolver does it.
    // Releasing in both paths revoked URLs other components were still using.
    let acquired = false;
    setFailed(false);
    setUrl(null);

    acquireImageURL(blobId)
      .then((u) => {
        if (u) acquired = true;
        if (!alive) {
          if (u) {
            releaseImageURL(blobId);
            acquired = false;
          }
          return;
        }
        if (u) setUrl(u);
        else setFailed(true);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });

    return () => {
      alive = false;
      if (acquired) releaseImageURL(blobId);
    };
  }, [blobId]);

  if (failed) {
    return (
      <div className={`img-missing ${className ?? ''}`} role="img" aria-label={alt}>
        <span>Image unavailable</span>
      </div>
    );
  }
  if (!url) return <div className={`skeleton ${className ?? ''}`} aria-hidden="true" />;

  return (
    <img
      src={url}
      alt={alt}
      className={className}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      style={{ objectPosition: focalPoint }}
      onError={() => setFailed(true)}
    />
  );
}

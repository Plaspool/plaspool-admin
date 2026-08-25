import { useState } from 'react';
import { ConfirmDialog } from './Dialog';

/**
 * Unpublish, and the one case where it is not a single click.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A FEATURED POST IS ASKED ABOUT AND NOTHING ELSE IS.
 *
 * Unpublishing clears `featured` and `featured_rank` in the SAME statement as
 * the status change (`server/repo/posts.ts`, invariant 3 of the storefront's
 * contract), so the post leaves the blog's FRONT PAGE as well as its published
 * list. That is a consequence on a page the writer is not looking at, and the
 * alternative the invariant exists to prevent — a rail that silently shrinks to
 * three with nothing anywhere to say why — is exactly what an unwarned
 * unpublish produces.
 *
 * THE ORDINARY CASE STAYS ONE CLICK. A confirmation on every unpublish is a
 * dialog people learn to dismiss without reading, which is how the one that
 * matters gets dismissed too.
 *
 * NOT `danger`. Unpublishing is reversible and re-publishing is one click; only
 * the curation has to be redone, which is what the second sentence says. Red
 * chrome here would borrow urgency from the trash button beside it.
 *
 * ═══ A COMPONENT RATHER THAN THREE MORE `useState`s IN THE EDITOR ═══
 * `Editor.tsx` is 780 lines and owns the document, the autosave and the
 * lifecycle. This is the one piece of it whose behaviour depends on a fact
 * about a different page, and pulling it out is what makes that behaviour
 * testable without mounting TipTap, Dexie and the autosave loop.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function UnpublishButton({
  featured,
  onUnpublish,
}: {
  /** Is this post on the curated rail? Decides whether to ask first. */
  featured: boolean;
  onUnpublish: () => void | Promise<void>;
}) {
  const [asking, setAsking] = useState(false);

  return (
    <>
      <button
        className="btn btn--outline btn--sm"
        onClick={() => {
          if (featured) {
            setAsking(true);
            return;
          }
          void onUnpublish();
        }}
      >
        Unpublish
      </button>

      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        title="This post is featured"
        description="Unpublishing it will also take it off the blog’s featured posts. Publishing it again will not put it back — you would need to feature it again."
        confirmLabel="Unpublish anyway"
        onConfirm={() => {
          setAsking(false);
          void onUnpublish();
        }}
      />
    </>
  );
}

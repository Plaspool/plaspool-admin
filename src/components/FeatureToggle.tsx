import { useCallback, useState } from 'react';
import { Switch, Tooltip } from './ui/Switch';
import { Dialog } from './Dialog';
import { useToast } from './Toast';
import { FeaturedConflictError, NotFeaturableError } from '../data/errors';
import { featureOne, unfeatureOne, useFeatured } from '../data/useFeatured';
import type { AuthUser, FeaturedItem, Post } from '../data/types';
import './featured-toggle.css';

/**
 * "Feature this post", with the counter and the swap that a refusal needs.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A DISABLED CONTROL THAT SAYS WHY, NEVER ONE THAT FAILS ON CLICK.
 *
 * The server refuses a draft with a 422, so a toggle that let a writer flip it
 * and then apologised would be teaching them a rule the interface already knew.
 * The tooltip carries the reason, and it is the SAME sentence the 422 maps to
 * (`NOT_FEATURABLE_MESSAGE` in `src/data/errors.ts`) so the two cannot drift.
 *
 * ═══ THE COUNTER IS LIVE, AND IT IS THE SAME LIST THE MANAGER DRAWS ═══
 * Both read `useFeatured`, which holds one rail for the whole app. A counter
 * derived separately would be the thing that says "3 of 4" beside a toggle that
 * has just been refused.
 *
 * ═══ THE FIFTH IS AN OFFER, NOT AN ERROR ═══
 * A 409 `featured_full` carries the current four. That is what the dialog below
 * lists, and picking one sends `replace` — a single statement server-side, so
 * the rail is never three posts long in between and the newcomer inherits the
 * position the operator pointed at. Falling back to "unfeature one, then try
 * again" would be two round trips and a visibly wrong rail between them.
 *
 * ═══ OWNER ONLY, BECAUSE THE SERVER SAYS SO ═══
 * `server/routes/featured.ts` guards every mutation with `requireOwner()`. The
 * control follows that rather than preceding it — a writer sees the state and
 * the reason, not a switch in front of a 403.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Why this post cannot be featured, or `null` if it can.
 *
 * Derived from the post the editor is already holding, so the switch is right
 * on first paint rather than after a round trip. It is NOT the authority — the
 * server re-decides against `PUBLIC_POST_PREDICATE` and this cannot see a
 * missing slug or a null publish date — which is why a 422 is still handled
 * below. This exists to stop the ordinary case (a draft) from needing one.
 */
export function blockedReason(post: Post | null | undefined): string | null {
  if (!post) return 'This post has not been saved yet';
  if (post.deletedAt != null) return 'Posts in the trash cannot be featured';
  if (post.status === 'archived') return 'Archived posts cannot be featured';
  if (post.status !== 'published') return 'Publish this post before featuring it';
  return null;
}

export function FeatureToggle({
  post,
  user,
}: {
  post: Post | null;
  user: AuthUser | null;
}) {
  const userId = user?.id ?? '';
  const { notify } = useToast();
  const { items, count, limit, isFeatured, unavailable } = useFeatured(userId);
  const [busy, setBusy] = useState(false);
  /** The four the server named in a 409, or `null` when nothing is being swapped. */
  const [swap, setSwap] = useState<FeaturedItem[] | null>(null);

  const owner = user?.role === 'owner';
  const featured = post ? isFeatured(post.id) : false;
  const blocked = blockedReason(post);

  const reason = !owner
    ? 'Only the blog’s owner can change what is featured'
    : unavailable
      ? 'The featured posts could not be loaded — this needs a connection'
      : // An already-featured post can always be un-featured, whatever state it
        // is in. Blocking that would strand a post on the rail.
        (!featured && blocked) || null;

  const run = useCallback(
    async (job: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await job();
        return true;
      } catch (err) {
        if (err instanceof FeaturedConflictError && err.reason === 'featured_full') {
          // The refusal names the current four. Offer the swap rather than the
          // error — this is the whole reason the server sends the list.
          setSwap(err.items);
          return false;
        }
        notify(
          err instanceof NotFeaturableError || err instanceof FeaturedConflictError
            ? err.message
            : 'That could not be saved.',
          { tone: 'danger' },
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [notify],
  );

  const toggle = useCallback(
    async (next: boolean) => {
      if (!post) return;
      const ok = await run(() =>
        next ? featureOne(userId, post.id) : unfeatureOne(userId, post.id),
      );
      if (ok) notify(next ? 'Added to the featured posts' : 'Removed from the featured posts');
    },
    [notify, post, run, userId],
  );

  const doSwap = useCallback(
    async (victim: FeaturedItem) => {
      if (!post) return;
      const ok = await run(() => featureOne(userId, post.id, victim.id));
      if (ok) {
        setSwap(null);
        notify(`Swapped in for “${victim.title || 'Untitled'}”`);
      }
    },
    [notify, post, run, userId],
  );

  const control = (
    <span className="feature-toggle__control">
      <Switch
        checked={featured}
        onChange={(next) => void toggle(next)}
        label="Feature this post"
        disabled={busy || reason !== null}
      />
      <span className="feature-toggle__label">Featured</span>
    </span>
  );

  return (
    <span className="feature-toggle">
      {reason ? <Tooltip label={reason}>{control}</Tooltip> : control}
      <span className="feature-toggle__count" aria-live="polite">
        {unavailable ? '— of ' : `${count} of `}
        {limit}
      </span>

      <Dialog
        open={swap !== null}
        onClose={() => setSwap(null)}
        title={`Only ${limit} posts can be featured`}
        description={
          <>
            Choose one to take off the rail and{' '}
            <strong>“{post?.title || 'Untitled'}”</strong> will take its place, in
            the same position.
          </>
        }
        footer={
          <button className="btn btn--ghost" onClick={() => setSwap(null)}>
            Cancel
          </button>
        }
      >
        <ul className="feature-toggle__swap">
          {(swap ?? items).map((item) => (
            <li key={item.id}>
              <button
                className="btn btn--outline feature-toggle__swap-item"
                onClick={() => void doSwap(item)}
                disabled={busy}
              >
                <span className="feature-toggle__swap-rank">{item.rank}</span>
                <span className="feature-toggle__swap-title">
                  {item.title || 'Untitled'}
                </span>
                <span className="feature-toggle__swap-action">Replace</span>
              </button>
            </li>
          ))}
        </ul>
      </Dialog>
    </span>
  );
}

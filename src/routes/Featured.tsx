import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Star } from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useSession } from '../components/RequireAuth';
import { FeaturedConflictError } from '../data/errors';
import { reorderRail, unfeatureOne, useFeatured } from '../data/useFeatured';
import { useToast } from '../components/Toast';
import { StoredImg } from '../components/StoredImg';
import { Skeleton } from '../components/ui/Feedback';
import type { FeaturedItem } from '../data/types';
import './featured.css';

/**
 * The featured rail — the posts the storefront's `/posts` page leads with.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS SCREEN IS FOR, AND WHY IT IS A SCREEN RATHER THAN A DIALOG.
 *
 * Curation is a standing decision about the front of the blog, not a property
 * of whichever post happens to be open. Behind a dialog in the editor there
 * would be no way to reach it without first opening some post — which is the
 * wrong mental model and, on a blog with four featured posts and two hundred
 * others, the wrong ergonomics.
 *
 * ═══ A DROP POSTS THE WHOLE LIST ═══
 * `reorderRail` sends every id in the new order, never one row. Invariant 4 of
 * the storefront's contract asks for exactly that, and it is not a nicety: two
 * posts exchanging ranks is the ordinary case, and any decomposition of it
 * leaves a moment where they share a rank or a moment where one has none.
 *
 * ═══ THE LIST MOVES FIRST, AND GOES BACK IF THE SERVER REFUSES ═══
 * A drag that waited for a round trip before the card moved would feel broken.
 * So the order is applied locally, posted, and REVERTED on failure — with the
 * server's own list adopted when the refusal carries one (a 409 `featured_stale`
 * does), because the truth beats whatever this screen was holding.
 *
 * ═══ THE GATE FOLLOWS THE SERVER, IT DOES NOT PRECEDE IT ═══
 * Every mutation here is owner-only on the server (`server/routes/featured.ts`),
 * so a writer gets a read-only view rather than controls in front of a 403 —
 * the failure `MarketingBanners.tsx` records. Reading is `requireAuth`, so a
 * writer still sees which posts are featured, which is what makes the disabled
 * toggle in their editor make sense.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Where a card can be dropped: onto the slot at this index. */
const SLOT = 'slot-';

function Card({
  item,
  index,
  editable,
  onRemove,
  onMove,
  total,
}: {
  item: FeaturedItem;
  index: number;
  editable: boolean;
  onRemove: (item: FeaturedItem) => void;
  onMove: (from: number, to: number) => void;
  total: number;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: item.id,
    disabled: !editable,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `${SLOT}${index}`,
    disabled: !editable,
  });

  // The raw `blobId`, exactly as `PostCard` passes it: `acquireImageURL` is what
  // knows about the `asset:`/`idb:` prefixes and about which side of the cutover
  // holds the bytes, and a second normalisation here would be a second opinion.
  const cover = item.coverImage;

  return (
    <li
      ref={setDropRef}
      className={[
        'featured__card',
        isDragging ? 'featured__card--dragging' : '',
        isOver ? 'featured__card--over' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="featured__rank" aria-hidden="true">
        {index + 1}
      </div>

      <div className="featured__thumb">
        {cover ? (
          <StoredImg
            blobId={cover.blobId}
            alt={cover.alt}
            focalPoint={cover.focalPoint}
            className="featured__img"
          />
        ) : (
          <div className="featured__thumb--empty" aria-hidden="true" />
        )}
      </div>

      <div className="featured__meta">
        <Link className="featured__title" to={`/edit/${item.id}`}>
          {item.title || 'Untitled'}
        </Link>
        <span className="featured__slug">/{item.slug}</span>
      </div>

      {editable && (
        <div className="featured__controls">
          {/*
           * THE GRIP IS THE POINTER ROUTE AND THE ARROWS ARE THE OTHER ONE.
           * dnd-kit's `KeyboardSensor` handles a focused grip, but a grip is a
           * hard target on a touchscreen and an unfamiliar one everywhere, so
           * the two buttons are the plain way to do the same thing. Neither is
           * a fallback for the other; both post the whole list.
           */}
          <button
            className="btn btn--ghost btn--sm featured__grip"
            ref={setNodeRef}
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${item.title || 'Untitled'}`}
          >
            <svg viewBox="0 0 24 24" className="ic" aria-hidden="true">
              <path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" />
            </svg>
          </button>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => onMove(index, index - 1)}
            disabled={index === 0}
            aria-label={`Move ${item.title || 'Untitled'} up`}
          >
            ↑
          </button>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => onMove(index, index + 1)}
            disabled={index === total - 1}
            aria-label={`Move ${item.title || 'Untitled'} down`}
          >
            ↓
          </button>
          <button
            className="btn btn--outline btn--sm"
            onClick={() => onRemove(item)}
            aria-label={`Remove ${item.title || 'Untitled'} from the featured rail`}
          >
            Remove
          </button>
        </div>
      )}
    </li>
  );
}

export default function Featured() {
  /*
   * `useSession`, not `getSession`. It subscribes, so this screen re-renders
   * when the session resolves — a bare read paints once with `status:
   * 'unknown'` and never asks again, which is an empty rail that never loads.
   *
   * `status === 'authed'` narrows the union honestly. `RequireAuth` is above
   * this route so nothing else can render it, but the type does not know that.
   */
  const session = useSession();
  const user = session.status === 'authed' ? session.user : null;
  const userId = user?.id ?? '';
  const editable = user?.role === 'owner';
  const { notify } = useToast();

  const { items, count, limit, loading, unavailable, reload } = useFeatured(userId);

  /**
   * The order this screen is showing, which is the store's until a drag moves
   * it. Held separately so a drop can paint immediately and be reverted whole
   * if the server refuses.
   */
  const [order, setOrder] = useState<FeaturedItem[] | null>(null);
  const shown = order ?? items;

  // The store is the authority whenever this screen is not mid-write: adopting
  // it here is what makes a 409's carried rail land on screen.
  useEffect(() => {
    setOrder(null);
  }, [items]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor),
  );

  const commit = useCallback(
    async (next: FeaturedItem[], previous: FeaturedItem[]) => {
      setOrder(next);
      try {
        await reorderRail(userId, next.map((item) => item.id));
      } catch (err) {
        if (err instanceof FeaturedConflictError) {
          // The refusal carried the truth and the store has already adopted it.
          setOrder(null);
          notify('The featured posts changed elsewhere. Showing the current order.', {
            tone: 'danger',
          });
          return;
        }
        setOrder(previous);
        notify('That order could not be saved.', { tone: 'danger' });
      }
    },
    [notify, userId],
  );

  const move = useCallback(
    (from: number, to: number) => {
      if (to < 0 || to >= shown.length || from === to) return;
      const next = [...shown];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      void commit(next, shown);
    },
    [commit, shown],
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const overId = event.over?.id;
      if (typeof overId !== 'string' || !overId.startsWith(SLOT)) return;
      const to = Number(overId.slice(SLOT.length));
      const from = shown.findIndex((item) => item.id === event.active.id);
      if (from === -1 || Number.isNaN(to)) return;
      move(from, to);
    },
    [move, shown],
  );

  const remove = useCallback(
    async (item: FeaturedItem) => {
      try {
        await unfeatureOne(userId, item.id);
        notify(`“${item.title || 'Untitled'}” is no longer featured`);
      } catch {
        notify('That post could not be removed from the rail.', { tone: 'danger' });
      }
    },
    [notify, userId],
  );

  const empties = useMemo(
    () => Array.from({ length: Math.max(0, limit - shown.length) }, (_, i) => i),
    [limit, shown.length],
  );

  return (
    <div className="featured">
      <header className="featured__head">
        <div>
          <h1 className="featured__heading">
            <Star className="ic" aria-hidden="true" /> Featured
          </h1>
          <p className="featured__lede">
            The posts the blog leads with, in the order readers see them. At most{' '}
            {limit}.
          </p>
        </div>
        <span className="featured__counter" aria-live="polite">
          {count} of {limit} featured
        </span>
      </header>

      {!editable && (
        <p className="notice">
          Only the blog’s owner can change what is featured. This is what readers
          are seeing now.
        </p>
      )}

      {unavailable && (
        <div className="notice notice--warn" role="alert">
          <div>
            {/*
             * NOT AN EMPTY RAIL. There is no way to derive which posts are
             * curated from this device's cache, so the honest answer to a failed
             * read is "we could not ask" — showing "0 of 4" would invite an
             * operator to feature a post that is already on the rail.
             */}
            <strong>The featured posts could not be loaded.</strong> This needs a
            connection — curation is decided on the server, so there is nothing
            cached to show.
          </div>
          <div className="notice__actions">
            <button className="btn btn--outline btn--sm" onClick={reload}>
              Try again
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <ul className="featured__list">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="featured__card">
              <Skeleton height="4.5rem" />
            </li>
          ))}
        </ul>
      ) : (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <ul className="featured__list">
            {shown.map((item, index) => (
              <Card
                key={item.id}
                item={item}
                index={index}
                total={shown.length}
                editable={editable}
                onRemove={remove}
                onMove={move}
              />
            ))}
            {!unavailable &&
              empties.map((i) => (
                <li key={`empty-${i}`} className="featured__card featured__card--empty">
                  <div className="featured__rank" aria-hidden="true">
                    {shown.length + i + 1}
                  </div>
                  <p className="featured__empty-note">
                    {shown.length === 0 && i === 0
                      ? 'Nothing is featured. Until something is, the blog leads with its newest posts.'
                      : 'Empty — feature a post from its editor.'}
                  </p>
                </li>
              ))}
          </ul>
        </DndContext>
      )}
    </div>
  );
}

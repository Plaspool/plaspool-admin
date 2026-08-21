import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  Copy,
  EyeOff,
  MoreHorizontal,
  Send,
  Trash2,
} from 'lucide-react';
import { StoredImg } from './StoredImg';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from './ui/Menu';
import type { ListPost } from '../data/types';
import { isoAttr } from '../data/when';

export interface CardActions {
  edit: () => void;
  read: () => void;
  duplicate: () => void;
  publish: () => void;
  unpublish: () => void;
  archive: () => void;
  unarchive: () => void;
  trash: () => void;
  restore: () => void;
  destroy: () => void;
}

/**
 * `ListPost`, NOT `Post` (F13, plan §4).
 *
 * `GET /api/posts` never returns `content` — that is the whole reason the
 * projection type exists — so the dashboard's rows come out of `db.postList`
 * with no document in them. Typing this prop `Post` would have compiled only by
 * a cast at the call site, and the cast would have hidden the real consequence
 * below.
 */
export function PostCard({
  post,
  actions,
  onTag,
  index = 0,
  canDestroy = true,
}: {
  post: ListPost;
  actions: CardActions;
  onTag: (t: string) => void;
  /** Position in the grid — drives the entrance stagger only. */
  index?: number;
  /**
   * Whether "Delete forever" may be offered at all.
   *
   * `DELETE /api/posts/:id` is owner-only (`server/authorize.ts:48`), so for a
   * writer this control is a confirmation dialog in front of a guaranteed 403 —
   * the app asking "are you sure?" about something it cannot do. Defaulted to
   * `true` so the prop is additive: only a caller that knows the role has an
   * opinion, and `Dashboard` is the only surface that renders trashed cards.
   */
  canDestroy?: boolean;
}) {
  const inTrash = post.deletedAt != null;
  /*
   * THE `deriveExcerpt(post.content, 150)` FALLBACK IS GONE, and dropping it is
   * a decision rather than a compile fix. The server derives an excerpt on
   * every write (`server/repo/mapping.ts:88`), so a list row always carries
   * one; the fallback only ever existed because the pre-cutover client derived
   * nothing on the list path. Keeping it would mean shipping every document to
   * the browser to render a card — the exact mistake ARCHITECTURE.md §6 flags.
   */
  const excerpt = post.excerpt;
  const title = post.title.trim() || 'Untitled';

  return (
    <article
      className={[
        'card',
        `card--${post.status}`,
        inTrash ? 'card--trashed' : '',
        post.coverImage ? '' : 'card--textonly',
      ]
        .filter(Boolean)
        .join(' ')}
      // Cap the stagger so a hundred posts don't take two seconds to appear.
      style={{ ['--i' as string]: Math.min(index, 12) }}
    >
      <button
        className="card__hit"
        onClick={inTrash ? actions.restore : actions.edit}
        aria-label={inTrash ? `Restore ${title}` : `Edit ${title}`}
      />

      {/*
        TEXT FIRST, PICTURE UNDER IT — the order the reference design reads in,
        and the order this list is actually scanned in. A cover on top makes the
        image the row's headline; here the words are, and the picture is what
        confirms them. It also means a post with no cover is not a card with a
        hole at the top, which is why the media well is still conditional.
      */}
      <div className="card__body">
        <div className="card__meta">
          <span className={`chip chip--${post.status}`}>{post.status}</span>
          {post.category && <span className="card__cat">{post.category}</span>}
        </div>

        <h2 className={`card__title${post.title.trim() ? '' : ' card__title--untitled'}`}>
          {title}
        </h2>
        {post.subtitle && <p className="card__subtitle">{post.subtitle}</p>}
        {excerpt && <p className="card__excerpt">{excerpt}</p>}

        {post.tags.length > 0 && (
          <div className="card__tags">
            {post.tags.slice(0, 4).map((t) => (
              <button
                key={t}
                className="card__tag"
                onClick={(e) => {
                  e.stopPropagation();
                  onTag(t);
                }}
              >
                {t}
              </button>
            ))}
            {post.tags.length > 4 && (
              <span className="card__tag card__tag--more">+{post.tags.length - 4}</span>
            )}
          </div>
        )}

        {/*
          THE BYLINE ROW, which is the one part of the reference design this app
          had nothing standing in for. `authorName` is denormalised onto every
          row precisely so a card can name its writer without a join, and on a
          shared blog "who wrote this" is the first thing you look for in a grid
          of ten drafts. The dates and the length ride with it rather than in a
          footer of their own — one line about the post's provenance instead of
          two rows of small grey text at opposite ends of the card.
        */}
        <footer className="card__by">
          <span className="card__avatar" aria-hidden="true">
            {initials(post.authorName)}
          </span>
          <span className="card__byline">
            <span className="card__author">{post.authorName || 'Unknown writer'}</span>
            <span className="card__when">
              <time dateTime={isoAttr(post.updatedAt)}>
                {inTrash
                  ? `Trashed ${relative(post.deletedAt!)}`
                  : post.status === 'published' && post.publishedAt
                    ? `Published ${relative(post.publishedAt)}`
                    : `Updated ${relative(post.updatedAt)}`}
              </time>
              {' · '}
              {post.wordCount === 0
                ? 'Empty'
                : `${post.readingTime} min read`}
            </span>
          </span>
        </footer>
      </div>

      {post.coverImage && (
        <div className="card__media">
          <StoredImg
            blobId={post.coverImage.blobId}
            alt={post.coverImage.alt}
            focalPoint={post.coverImage.focalPoint}
            className="card__img"
          />
          {/* Not a control — the whole card is the control, and a second button
              inside the first one is a click target that eats its parent's. It
              is the reference design's cue that the picture is pressable, drawn
              where that design draws it. */}
          <span className="card__more" aria-hidden="true">
            Read More
            <ArrowRight className="ui-ic" />
          </span>
        </div>
      )}

      <div className="card__actions">
        {inTrash ? (
          <>
            <button className="card__act" onClick={actions.restore}>
              Restore
            </button>
            {canDestroy && (
              <button className="card__act card__act--danger" onClick={actions.destroy}>
                Delete forever
              </button>
            )}
          </>
        ) : (
          <>
            <button className="card__act" onClick={actions.edit}>
              Edit
            </button>
            <button className="card__act" onClick={actions.read}>
              Read
            </button>
            <Overflow post={post} actions={actions} />
          </>
        )}
      </div>
    </article>
  );
}

function Overflow({ post, actions }: { post: ListPost; actions: CardActions }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          className="card__act card__act--icon"
          aria-label={`More actions for ${post.title.trim() || 'Untitled'}`}
        >
          <MoreHorizontal className="ui-ic" aria-hidden="true" />
        </button>
      </MenuTrigger>
      <MenuContent>
        {post.status === 'published' ? (
          <MenuItem icon={<EyeOff className="ui-ic" />} onSelect={actions.unpublish}>
            Unpublish
          </MenuItem>
        ) : (
          <MenuItem icon={<Send className="ui-ic" />} onSelect={actions.publish}>
            Publish
          </MenuItem>
        )}
        <MenuItem icon={<Copy className="ui-ic" />} onSelect={actions.duplicate}>
          Duplicate
        </MenuItem>
        {post.status === 'archived' ? (
          <MenuItem icon={<ArchiveRestore className="ui-ic" />} onSelect={actions.unarchive}>
            Unarchive
          </MenuItem>
        ) : (
          <MenuItem icon={<Archive className="ui-ic" />} onSelect={actions.archive}>
            Archive
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem danger icon={<Trash2 className="ui-ic" />} onSelect={actions.trash}>
          Move to trash
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/**
 * Up to two initials for the byline disc.
 *
 * The same rule the rail's identity block uses, copied rather than imported:
 * that one lives inside `Sidebar.tsx` next to the signed-in user, and a card
 * names whoever wrote the post — often not the person reading it. Importing it
 * would tie a list row to the navigation's module for four lines of string
 * handling.
 */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '·';
  const first = parts[0]![0]!;
  const last = parts.length > 1 ? parts[parts.length - 1]![0]! : '';
  return (first + last).toUpperCase();
}

export function relative(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: new Date(ts).getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
}

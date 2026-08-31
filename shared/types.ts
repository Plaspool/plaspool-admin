/**
 * THE domain model. Imported by both `src/` (frontend) and `server/`, so the
 * two sides cannot disagree about what a `Post` is. Never duplicate a type
 * across the boundary, and never import from `src/` here.
 *
 * Every field maps 1:1 onto the relational store. `coverImage.blobId` is an
 * image id — a row in the local `images` table before cutover, an object
 * storage key after.
 *
 * See ARCHITECTURE.md and docs/superpowers/specs/2026-08-11-backend-design.md.
 */

export type PostStatus = 'draft' | 'published' | 'archived';

/**
 * Reading layouts. Defined here rather than in `src/data/settings.ts` because
 * a post can now pin one, which makes it part of the domain rather than a
 * device preference — and a public renderer must be able to honour it without
 * importing anything from the admin client.
 */
export type ReadingTemplate = 'magazine' | 'minimal' | 'editorial' | 'technical';

/** TipTap/ProseMirror JSON document. Block-oriented by construction. */
export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

export interface CoverImage {
  /** Key into the local `images` table. Becomes an object-storage key later. */
  blobId: string;
  alt: string;
  /** CSS object-position, e.g. "50% 30%". Lets us reframe without re-encoding. */
  focalPoint: string;
  width: number;
  height: number;
}

export interface Post {
  /** Stable, client-generated, never reused. Survives backend migration. */
  id: string;
  title: string;
  subtitle: string;
  /**
   * NULL until the post is titled or published, at which point the server
   * assigns one. A UNIQUE column cannot hold twenty empty strings, but
   * Postgres permits many NULLs — see spec §3.4.
   */
  slug: string | null;
  excerpt: string;
  /**
   * 'derived' excerpts track the opening of the post; 'author' excerpts are
   * left exactly as written. Without this the first derivation froze forever
   * and cards advertised text the post no longer contained.
   */
  excerptSource: 'derived' | 'author';

  /** Block content. Never a plain HTML string — see ARCHITECTURE.md. */
  content: DocNode;

  coverImage: CoverImage | null;

  category: string;
  tags: string[];

  /**
   * Layout override for this one post, or NULL to follow the blog's default.
   *
   * Nullable rather than defaulted: "no opinion" and "deliberately Magazine"
   * are different states, and only the first should follow the default when it
   * changes. Additive column, no migration needed — see ARCHITECTURE.md
   * § Settings and presentation.
   */
  template: ReadingTemplate | null;

  status: PostStatus;

  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  /** Set when moved to trash. Non-null == in trash, regardless of status. */
  deletedAt: number | null;

  wordCount: number;
  readingTime: number;

  /** `users.id`. The authority for authorship and for `authorize()`. */
  authorId: string;
  /**
   * Denormalised display name, so a card renders an author without a join.
   * The server fills both; never trust this one for a permission decision.
   */
  authorName: string;

  /**
   * Monotonic per-post counter. Incremented on every successful persist.
   * This is the hook for optimistic concurrency once a backend exists:
   * a write carries the revision it was based on and the server rejects
   * a mismatch instead of clobbering. See ARCHITECTURE.md § Collaboration.
   */
  revision: number;
}

/** Immutable point-in-time snapshot. Append-only; never mutated. */
export interface Revision {
  id: string;
  postId: string;
  revision: number;
  createdAt: number;
  /**
   * `users.id` of whoever made this snapshot — `revisions.author_id`, which the
   * schema declares `not null`, so every server-written revision carries it.
   *
   * OPTIONAL IN THE DOMAIN TYPE, AND DELIBERATELY. The plan asks for
   * `authorId: string`; the spec (§3.5) is the narrower claim — `revisions`
   * "mirrors `Revision`, **plus** `author_id`" — and the spec wins. Making it
   * required would be a lie about the rows that already exist: the pre-cutover
   * IndexedDB store writes revisions from three places in `src/data/posts.ts`
   * and an import bundle carries a fourth, none of which has ever had a user
   * to name. Until Project C's cutover, "who made this" is genuinely unknown
   * for locally-written history, and a type that says otherwise just moves the
   * lie somewhere a `!` hides it.
   */
  authorId?: string;
  title: string;
  subtitle: string;
  content: DocNode;
  wordCount: number;
  /**
   * 'autosave' entries are pruned aggressively; everything else is kept.
   * 'status' entries record lifecycle changes (publish, unpublish, archive,
   * trash, restore) so history has no unexplained gaps in its numbering.
   */
  kind: 'autosave' | 'manual' | 'publish' | 'status';
  /** Human-readable summary, used by 'status' entries. */
  note?: string;
}

// ------------------------------------------------------------------ backup

/**
 * The backup bundle (spec §5.5).
 *
 * HERE RATHER THAN IN `src/data/backup.ts`, for the reason everything else in
 * this file is here: `GET /api/export` and `POST /api/import` speak this exact
 * shape, `server/` may not import from `src/`, and a second declaration on the
 * server side is the duplication the shared module exists to prevent.
 *
 * `src/data/backup.ts` still carries its own copy today — Project C's cutover
 * is what re-points it at this one. Until then the two are identical by
 * inspection and the server's is the authority for what the API accepts.
 */
export const BUNDLE_FORMAT = 'publishing-studio/v2';

/**
 * The prefix every version of the format shares. Import checks this rather
 * than the exact string, so a v1 bundle from an older export is still
 * recognisable as one of ours.
 */
export const BUNDLE_FORMAT_PREFIX = 'publishing-studio/';

export interface BundleImage {
  id: string;
  type: string;
  width: number;
  height: number;
  /** base64, no `data:` prefix. */
  data: string;
}

export interface Bundle {
  format: string;
  exportedAt: string;
  posts: Post[];
  revisions: Revision[];
  images: BundleImage[];
}

export interface StoredImage {
  id: string;
  blob: Blob;
  width: number;
  height: number;
  type: string;
  createdAt: number;
}

export const EMPTY_DOC: DocNode = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
};

/** The only user shape that crosses the client/server boundary. */
export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  /** The six-role model of `shared/roles.ts` (migration 0680). */
  role: import('./roles').Role;
}

/**
 * What `GET /api/posts` returns. Shipping every document to render a list is
 * the exact mistake ARCHITECTURE.md §6 flags — `content` comes only from
 * `GET /api/posts/:id`.
 */
export type ListPost = Omit<Post, 'content'>;

/**
 * What `GET /api/posts/:id/revisions` returns, for the same reason `ListPost`
 * exists and more sharply: history is unbounded, so a list that carried bodies
 * would grow without limit while the panel only ever renders titles, word
 * counts and kinds. Bodies come from `GET /api/revisions/:revId`.
 */
export type RevisionMeta = Omit<Revision, 'content'>;

/**
 * Fields a caller may change. Everything else is derived or system-owned.
 *
 * `slug` is deliberately absent: it is server-authoritative (spec §4.5).
 * Letting a client set one bypasses `uniqueSlug` and turns a collision into a
 * raw `unique_violation` 500.
 */
export type PostPatch = Partial<
  Pick<
    Post,
    | 'title'
    | 'subtitle'
    | 'content'
    | 'coverImage'
    | 'category'
    | 'tags'
    | 'excerpt'
    | 'template'
  >
>;

export interface SaveOptions {
  /** Snapshot kind. Autosaves are throttled + pruned; manual saves are kept. */
  kind?: Revision['kind'];
  /** When set, refuse the write if the stored post has moved on. */
  baseRevision?: number;
}

export type StatusFilter = 'all' | PostStatus | 'trash';

export type SortKey =
  | 'updated'
  | 'published'
  | 'oldest'
  | 'alphabetical'
  | 'drafts-first';

export interface Query {
  status: StatusFilter;
  search: string;
  category: string | null;
  tag: string | null;
  sort: SortKey;
}

// ----------------------------------------------------- the public read surface

/**
 * What an UNAUTHENTICATED reader may see of a post (plan D3).
 *
 * An ALLOW-LIST, assembled field by field in `server/repo/public-projection.ts`
 * — never a `Post` with keys deleted. Dropped on purpose, each closing a named
 * threat: `authorId` (T3), and `deletedAt`, `revision`, `status`,
 * `excerptSource`, `createdAt` (T4). `status` is dropped because on this surface
 * it is always `'published'`, and emitting it invites a consumer to branch on a
 * value that cannot vary.
 *
 * `author` is an object rather than a flat `authorName` so that adding a public
 * author field later is additive, and so the shape makes obvious that a byline
 * is all there is.
 */
export interface PublicPost {
  id: string;
  /** Never null on this surface — `slug IS NOT NULL` is in the predicate. */
  slug: string;
  title: string;
  subtitle: string;
  excerpt: string;
  coverImage: PublicCoverImage | null;
  category: string;
  tags: string[];
  template: ReadingTemplate | null;
  /** Never null on this surface — `published_at IS NOT NULL` is in the predicate. */
  publishedAt: number;
  updatedAt: number;
  wordCount: number;
  readingTime: number;
  /** A byline. Never an id, never an email. */
  author: { name: string };
}

export interface PublicPostDetail extends PublicPost {
  content: DocNode;
}

export interface PublicCoverImage {
  /** Resolved public URL — see `publicImageUrl`. */
  url: string;
  alt: string;
  focalPoint: string;
  width: number;
  height: number;
}

/**
 * How many posts the curated rail holds.
 *
 * HERE, WHERE BOTH SIDES CAN READ IT, because both need it and they must not
 * disagree: the server assigns ranks against it and the admin draws an
 * "n of 4" counter from it.
 *
 * THE REAL AUTHORITY IS NEITHER. `posts_featured_rank_ck` bounds the column to
 * 1..4 and `posts_featured_rank_uq` makes it unique, so "at most four" holds
 * against `psql`, an import and a backfill. Raising this number alone raises
 * nothing — changing the cap needs a migration, which is the intended friction
 * for a decision about the shape of a page.
 */
export const MAX_FEATURED = 4;

/**
 * One card on the curated rail, as the ADMIN sees it.
 *
 * Deliberately not `Post` and not `PublicPost`. It is the smallest shape that
 * draws a card in the featured manager and names a post in a 409 body — an
 * identity, a title, a cover and the position. `content` is the reason: the
 * manager renders at most four cards and a list response ships no documents
 * (ARCHITECTURE.md §6), and a 409 that carried four whole posts would be a
 * refusal heavier than the request that caused it.
 *
 * `rank` RIDES ALONG rather than being implied by array position. The two agree
 * today, and they must: a client that inferred rank from the index would
 * silently renumber a rail that legitimately has gaps in it (unfeaturing the
 * second of three leaves ranks 1 and 3), and would then post that renumbering
 * back as a reorder nobody asked for.
 */
export interface FeaturedItem {
  id: string;
  /** Never null: only a publicly visible post can be featured. */
  slug: string;
  title: string;
  coverImage: CoverImage | null;
  publishedAt: number;
  /** 1..4. Unique among featured posts; gaps are legal. */
  rank: number;
}

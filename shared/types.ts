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
  role: 'owner' | 'writer';
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

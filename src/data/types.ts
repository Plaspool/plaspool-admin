/**
 * Backend-ready domain model.
 *
 * Every field here is designed to map 1:1 onto a relational or document store
 * later. Nothing is browser-specific except `coverImage.blobId`, which points
 * at a row in the local `images` table and will become an object-storage key.
 *
 * See ARCHITECTURE.md for the future-backend + collaboration TODOs.
 */

export type PostStatus = 'draft' | 'published' | 'archived';

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
  slug: string;
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

  status: PostStatus;

  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  /** Set when moved to trash. Non-null == in trash, regardless of status. */
  deletedAt: number | null;

  wordCount: number;
  readingTime: number;

  author: string;

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

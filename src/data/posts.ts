import { db, newId } from './db';
import {
  countWords,
  deriveExcerpt,
  docToText,
  isValidDoc,
  readingTime,
  slugify,
} from './doc';
import {
  EMPTY_DOC,
  type DocNode,
  type Post,
  type PostPatch,
  type Query,
  type Revision,
  type SaveOptions,
} from './types';
import { IDB_SCHEME } from './doc';
import { isBlankDoc } from './docguards';

/**
 * The type aliases moved to `shared/types.ts` so `server/` shares them. They
 * are re-exported here so `src/data/posts.ts` keeps its exact public surface.
 */
export type { PostPatch, SaveOptions, Query, StatusFilter, SortKey } from '../../shared/types';

/**
 * Placeholder identity until Task 3's real users exist. Every locally created
 * post is authored by the single person using this browser; the server
 * overwrites both fields from the session on cutover.
 */
const LOCAL_AUTHOR_ID = 'local';
const LOCAL_AUTHOR_NAME = 'You';

/**
 * Every write goes through this shape:
 *   read current → derive next → validate → persist in one transaction
 * Nothing ever deletes-then-writes. A rejected validation leaves the last
 * known-good row untouched.
 */

export function createDraftShape(partial: Partial<Post> = {}): Post {
  const now = Date.now();
  const content = isValidDoc(partial.content) ? partial.content : EMPTY_DOC;
  const text = docToText(content);
  const words = countWords(text);
  return {
    id: partial.id ?? newId('p_'),
    title: partial.title ?? '',
    subtitle: partial.subtitle ?? '',
    slug: partial.slug ?? null,
    excerpt: partial.excerpt ?? '',
    excerptSource: partial.excerptSource ?? (partial.excerpt ? 'author' : 'derived'),
    content,
    coverImage: partial.coverImage ?? null,
    category: partial.category ?? '',
    tags: partial.tags ?? [],
    // `?? null`, not `|| null`: a post that pins a layout must keep it through
    // an export/import round trip, and `backup.ts` rebuilds every imported post
    // through this function. A field missing here is a field silently dropped.
    template: partial.template ?? null,
    status: partial.status ?? 'draft',
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
    publishedAt: partial.publishedAt ?? null,
    deletedAt: partial.deletedAt ?? null,
    wordCount: partial.wordCount ?? words,
    readingTime: partial.readingTime ?? readingTime(words),
    authorId: partial.authorId ?? LOCAL_AUTHOR_ID,
    authorName: partial.authorName ?? LOCAL_AUTHOR_NAME,
    revision: partial.revision ?? 1,
  };
}

export async function createPost(partial: Partial<Post> = {}): Promise<Post> {
  const post = createDraftShape(partial);
  await db.transaction('rw', db.posts, db.revisions, async () => {
    await db.posts.add(post);
    await appendRevision(post, 'manual');
  });
  return post;
}

export class StaleWriteError extends Error {
  expected: number;
  actual: number;
  constructor(expected: number, actual: number) {
    super(`Stale write: based on revision ${expected}, store is at ${actual}`);
    this.name = 'StaleWriteError';
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * The single mutation path for post content/metadata.
 * Returns the new persisted post, or throws without touching the store.
 */
export async function savePost(
  id: string,
  patch: PostPatch,
  opts: SaveOptions = {},
): Promise<Post> {
  return db.transaction('rw', db.posts, db.revisions, async () => {
    const current = await db.posts.get(id);
    if (!current) throw new Error(`Post ${id} not found`);

    if (opts.baseRevision != null && opts.baseRevision !== current.revision) {
      throw new StaleWriteError(opts.baseRevision, current.revision);
    }

    const content =
      patch.content !== undefined
        ? isValidDoc(patch.content)
          ? patch.content
          : current.content
        : current.content;

    const next: Post = {
      ...current,
      ...patch,
      content,
      // Never let a patch smuggle in system fields.
      id: current.id,
      createdAt: current.createdAt,
      status: current.status,
      publishedAt: current.publishedAt,
      deletedAt: current.deletedAt,
      authorId: current.authorId,
      authorName: current.authorName,
      revision: current.revision + 1,
      updatedAt: Date.now(),
    };

    const text = docToText(next.content);
    next.wordCount = countWords(text);
    next.readingTime = readingTime(next.wordCount);
    // A derived excerpt tracks the post. An author-written one is never touched.
    if (patch.excerpt !== undefined) {
      const written = patch.excerpt.trim();
      next.excerptSource = written ? 'author' : 'derived';
      next.excerpt = written || deriveExcerpt(next.content);
    } else if (current.excerptSource !== 'author') {
      next.excerpt = deriveExcerpt(next.content);
    }
    // Slugs are derived, never supplied — `PostPatch` has no `slug` key.
    if (!current.slug && next.title) {
      next.slug = await uniqueSlug(slugify(next.title), current.id);
    }

    if (!isValidDoc(next.content)) {
      throw new Error('Refusing to persist an invalid document');
    }

    await db.posts.put(next);
    await appendRevision(next, opts.kind ?? 'autosave');
    return next;
  });
}

async function uniqueSlug(base: string, selfId: string): Promise<string> {
  let candidate = base;
  let n = 2;
  // Bounded: a slug colliding 200 times means something else is wrong.
  while (n < 200) {
    const clash = await db.posts.where('slug').equals(candidate).first();
    if (!clash || clash.id === selfId) return candidate;
    candidate = `${base}-${n++}`;
  }
  return `${base}-${newId()}`;
}

async function appendRevision(post: Post, kind: Revision['kind']) {
  await db.revisions.add({
    id: newId('r_'),
    postId: post.id,
    revision: post.revision,
    createdAt: Date.now(),
    title: post.title,
    subtitle: post.subtitle,
    content: post.content,
    wordCount: post.wordCount,
    kind,
  });
  await maybePruneRevisions(post.id);
}

/**
 * Keep history bounded without losing meaningful checkpoints:
 * all manual/publish snapshots survive; autosaves keep the newest 30.
 */
const AUTOSAVE_KEEP = 30;
/**
 * Pruning walks a post's revisions, so doing it on every keystroke-driven save
 * made typing cost scale with history length. The cap is soft — checking one
 * save in ten keeps history bounded at ~AUTOSAVE_KEEP + 10 without putting an
 * O(revisions) scan in the typing path.
 */
const PRUNE_EVERY = 10;
const sinceLastPrune = new Map<string, number>();

async function maybePruneRevisions(postId: string) {
  const n = (sinceLastPrune.get(postId) ?? 0) + 1;
  if (n < PRUNE_EVERY) {
    sinceLastPrune.set(postId, n);
    return;
  }
  sinceLastPrune.set(postId, 0);
  await pruneRevisions(postId);
}

async function pruneRevisions(postId: string) {
  // Deliberately NOT `.toArray()`: that deserialised every snapshot's full
  // document on every autosave, so the cost of one keystroke grew with the
  // length of the post. We only need ids, kinds and timestamps.
  const light: { id: string; kind: Revision['kind']; createdAt: number }[] = [];
  await db.revisions
    .where('postId')
    .equals(postId)
    .each((r) => {
      if (r.kind === 'autosave') {
        light.push({ id: r.id, kind: r.kind, createdAt: r.createdAt });
      }
    });
  if (light.length <= AUTOSAVE_KEEP) return;
  light.sort((a, b) => b.createdAt - a.createdAt);
  await db.revisions.bulkDelete(light.slice(AUTOSAVE_KEEP).map((r) => r.id));
}

/**
 * Lifecycle changes bump the revision, so they must also leave a history
 * entry — otherwise the timeline shows unexplained jumps (r16 → r18) and
 * "when did I publish this?" is unanswerable.
 */
async function setStatus(
  id: string,
  changes: Partial<Post>,
  note: string,
): Promise<Post> {
  return db.transaction('rw', db.posts, db.revisions, async () => {
    const current = await db.posts.get(id);
    if (!current) throw new Error(`Post ${id} not found`);
    const next: Post = {
      ...current,
      ...changes,
      revision: current.revision + 1,
      updatedAt: Date.now(),
    };
    await db.posts.put(next);
    await db.revisions.add({
      id: newId('r_'),
      postId: next.id,
      revision: next.revision,
      createdAt: Date.now(),
      title: next.title,
      subtitle: next.subtitle,
      content: next.content,
      wordCount: next.wordCount,
      kind: 'status',
      note,
    });
    return next;
  });
}

/**
 * Publishing is one transaction: read, derive, write, snapshot. Nothing can
 * commit between the read and the write, so an autosave racing the publish
 * button can no longer be reverted by stale derived fields, and a post can
 * never end up published without its publish snapshot.
 */
export async function publishPost(id: string): Promise<Post> {
  return db.transaction('rw', db.posts, db.revisions, async () => {
    const current = await db.posts.get(id);
    if (!current) throw new Error(`Post ${id} not found`);
    const next: Post = {
      ...current,
      status: 'published',
      publishedAt: current.publishedAt ?? Date.now(),
      deletedAt: null,
      slug: current.slug || (await uniqueSlug(slugify(current.title || 'untitled'), id)),
      excerpt:
        current.excerptSource === 'author' && current.excerpt
          ? current.excerpt
          : deriveExcerpt(current.content),
      revision: current.revision + 1,
      updatedAt: Date.now(),
    };
    await db.posts.put(next);
    await db.revisions.add({
      id: newId('r_'),
      postId: next.id,
      revision: next.revision,
      createdAt: Date.now(),
      title: next.title,
      subtitle: next.subtitle,
      content: next.content,
      wordCount: next.wordCount,
      kind: 'publish',
    });
    return next;
  });
}

export const unpublishPost = (id: string) =>
  setStatus(id, { status: 'draft' }, 'Moved back to drafts');
export const archivePost = (id: string) =>
  setStatus(id, { status: 'archived' }, 'Archived');
export const unarchivePost = (id: string) =>
  setStatus(id, { status: 'draft' }, 'Restored from archive');

/** Soft delete. The row and every revision stay intact. */
export const trashPost = (id: string) =>
  setStatus(id, { deletedAt: Date.now() }, 'Moved to trash');
export const restorePost = (id: string) =>
  setStatus(id, { deletedAt: null }, 'Restored from trash');

/** The only destructive operation in the app. Guarded by explicit UI confirm. */
export async function destroyPost(id: string): Promise<void> {
  await db.transaction('rw', db.posts, db.revisions, async () => {
    await db.revisions.where('postId').equals(id).delete();
    await db.posts.delete(id);
  });
  // Collection is a separate, best-effort pass. If it fails, we have leaked
  // bytes — never a missing image, and never a half-deleted post.
  await collectOrphanImages().catch(() => {});
}

/**
 * Mark-and-sweep over the whole image store.
 *
 * Refcounting per operation was wrong: an image can be referenced as a cover
 * AND inline in any number of posts and revisions, so deleting on the basis of
 * one reference disappearing destroyed images other posts were still using.
 * Sweeping the full reference set is O(posts) and runs only after a permanent
 * delete, which is rare and already user-confirmed.
 */
export async function collectOrphanImages(): Promise<number> {
  const referenced = new Set<string>();
  const collect = (node: DocNode | undefined) => {
    if (!node) return;
    if (node.type === 'image') {
      const src = String(node.attrs?.src ?? '');
      if (src.startsWith(IDB_SCHEME)) referenced.add(src.slice(IDB_SCHEME.length));
    }
    node.content?.forEach(collect);
  };

  for (const p of await db.posts.toArray()) {
    if (p.coverImage) referenced.add(p.coverImage.blobId);
    collect(p.content);
  }
  // Revisions are restorable, so anything they reference is still live.
  for (const r of await db.revisions.toArray()) collect(r.content);

  const ids = await db.images.toCollection().primaryKeys();
  const orphans = ids.filter((id) => !referenced.has(id));
  if (orphans.length) await db.images.bulkDelete(orphans);
  return orphans.length;
}

/** A draft with no title, no words, no cover and no metadata. */
export function isBlankDraft(p: Post): boolean {
  return (
    // Scalar checks first: `sweepBlankDrafts` runs on every dashboard mount, so
    // the document walk must only happen for drafts that are blank on the cheap
    // criteria. Round 1 already caught one "cost scales with document length".
    p.status === 'draft' &&
    p.deletedAt == null &&
    p.title.trim() === '' &&
    p.subtitle.trim() === '' &&
    p.wordCount === 0 &&
    !p.coverImage &&
    p.tags.length === 0 &&
    p.category === '' &&
    // `wordCount === 0` is not emptiness. An image-only or divider-only draft
    // has no words and was being destroyed — with its image bytes — the instant
    // the writer left the editor. See isBlankDoc.
    isBlankDoc(p.content)
  );
}

/**
 * "New post" then immediately leaving used to leave a permanent Untitled row
 * in the dashboard. Discard it on the way out — there is nothing in it to lose,
 * and a list full of empty drafts is its own kind of data loss.
 */
export async function discardIfBlank(id: string): Promise<boolean> {
  const p = await db.posts.get(id);
  if (!p || !isBlankDraft(p)) return false;
  await destroyPost(id);
  return true;
}

/**
 * Sweep blank drafts left behind by any exit route the editor can't see —
 * browser Back, a closed tab, a crash. The age guard means a draft someone is
 * actively staring at in another tab is never pulled out from under them.
 */
const BLANK_DRAFT_GRACE_MS = 60_000;

export async function sweepBlankDrafts(exceptId?: string): Promise<number> {
  const now = Date.now();
  const doomed = (await db.posts.toArray()).filter(
    (p) =>
      p.id !== exceptId &&
      isBlankDraft(p) &&
      now - p.updatedAt > BLANK_DRAFT_GRACE_MS,
  );
  for (const p of doomed) await destroyPost(p.id);
  return doomed.length;
}

export async function duplicatePost(id: string): Promise<Post> {
  const src = await db.posts.get(id);
  if (!src) throw new Error(`Post ${id} not found`);
  return createPost({
    ...src,
    id: undefined,
    title: src.title ? `${src.title} (copy)` : '',
    slug: null,
    status: 'draft',
    publishedAt: null,
    deletedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 1,
  });
}

/** All-or-nothing: either every trashed post goes, or none of them do. */
export async function emptyTrash(): Promise<number> {
  const n = await db.transaction('rw', db.posts, db.revisions, async () => {
    const ids = (await db.posts.filter((p) => p.deletedAt != null).toArray()).map(
      (p) => p.id,
    );
    for (const id of ids) await db.revisions.where('postId').equals(id).delete();
    await db.posts.bulkDelete(ids);
    return ids.length;
  });
  await collectOrphanImages().catch(() => {});
  return n;
}

// ---------------------------------------------------------------- queries

export function filterAndSort(posts: Post[], q: Query): Post[] {
  const needle = q.search.trim().toLowerCase();
  const out = posts.filter((p) => {
    if (q.status === 'trash') {
      if (p.deletedAt == null) return false;
    } else {
      if (p.deletedAt != null) return false;
      if (q.status !== 'all' && p.status !== q.status) return false;
    }
    if (q.category && p.category !== q.category) return false;
    if (q.tag && !p.tags.includes(q.tag)) return false;
    if (needle) {
      const hay = [
        p.title,
        p.subtitle,
        p.excerpt,
        p.category,
        p.tags.join(' '),
        docToText(p.content).slice(0, 4000),
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  const byTitle = (a: Post, b: Post) =>
    (a.title || 'Untitled').localeCompare(b.title || 'Untitled', undefined, {
      sensitivity: 'base',
    });

  switch (q.sort) {
    case 'updated':
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    case 'published':
      return out.sort(
        (a, b) => (b.publishedAt ?? -Infinity) - (a.publishedAt ?? -Infinity),
      );
    case 'oldest':
      return out.sort((a, b) => a.createdAt - b.createdAt);
    case 'alphabetical':
      return out.sort(byTitle);
    case 'drafts-first':
      return out.sort((a, b) => {
        const rank = (p: Post) => (p.status === 'draft' ? 0 : p.status === 'published' ? 1 : 2);
        return rank(a) - rank(b) || b.updatedAt - a.updatedAt;
      });
    default:
      return out;
  }
}

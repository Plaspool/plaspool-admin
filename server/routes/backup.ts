import { Hono } from 'hono';
import { readJson } from '../middleware/errors';
import { requireAdmin, requireAuth } from '../middleware/session';
import { limit } from '../middleware/ratelimit';
import { BACKUP_LIMIT, BACKUP_WINDOW_MS } from '../repo/ratelimit';
import { exportAll, existingPostIds } from '../repo/backup';
import { createPost } from '../repo/posts';
import { InvalidDocumentError } from '../repo/errors';
import { BadRequestError } from '../repo/errors';
import { uniqueViolation } from '../db/client';
import { checkPostMeta, validateDoc } from '../../shared/validate';
/*
 * THE BODY SCHEMA IS SHARED, AND THAT IS LOAD-BEARING RATHER THAN TIDY.
 *
 * Migration (plan §6.4 step 0) has to answer "would the server take this?"
 * BEFORE it uploads, because `limit()` runs ahead of `readJson` below, so a
 * body this schema refuses still burns one of the five import slots the hour
 * allows. It can only answer that by running this exact object; a client-side
 * approximation of it produced a 400 on every batch. `shared/bundle.test.ts`
 * fails if this file goes back to declaring its own.
 */
import { ImportBody } from '../../shared/bundle';
import type { BundlePostInput } from '../../shared/bundle';
import { BUNDLE_FORMAT, BUNDLE_FORMAT_PREFIX } from '../../shared/types';
import { currentDb, currentUser } from '../app-env';
import type { AppEnv } from '../app-env';
import type { Bundle, DocNode, Post } from '../../shared/types';

/**
 * Backup and restore (spec §5.5).
 *
 * These are the two routes that carry the whole store in one request, and each
 * has a hazard the ordinary post routes do not.
 *
 * **`GET /export` is owner-only and rate-limited.** It returns every writer's
 * drafts and their full history in a single response — the cheapest possible
 * exfiltration of the entire blog, and simultaneously the most expensive query
 * the application can run.
 *
 * **`POST /import` is the one write path carrying content the requester did not
 * author**, which is exactly the case `validateDoc` exists for (spec §4.6). A
 * bundle containing an invalid document is rejected whole, 422, naming the
 * first offending path, and NOTHING is written — so every document is checked
 * before the first insert rather than as it goes.
 */
export const routes = new Hono<AppEnv>();

// ------------------------------------------------------------------ export

routes.get('/export', requireAdmin(), async (c) => {
  const db = currentDb(c);
  await limit(c, `export:${currentUser(c).id}`, BACKUP_LIMIT, BACKUP_WINDOW_MS);

  const { posts, revisions } = await exportAll(db);

  /*
   * `images: []`, and it is accurate rather than a stub: there is no server
   * image store until Project B (Tasks 15–16), so there are no bytes to carry.
   * The key is present because it is part of the `Bundle` shape every existing
   * consumer reads, and an absent key would make a v2 bundle unparseable by
   * `importBundle`.
   */
  const bundle: Bundle = {
    format: BUNDLE_FORMAT,
    exportedAt: new Date().toISOString(),
    posts,
    revisions,
    images: [],
  };
  return c.json(bundle);
});

// ------------------------------------------------------------------ import

/**
 * A bundle post, reduced to what import is allowed to honour.
 *
 * **`id` IS PRESERVED** (spec §5.5). `ARCHITECTURE.md` §3 already promises post
 * ids are stable and never reused, and adopting the incoming one is what makes
 * migration and re-import idempotent, including from two devices. Minting a new
 * id would leave the local rows pointing at posts the server has never heard
 * of, so every later save would 404 and the writer would be typing into a post
 * that can never be saved.
 *
 * **`authorId` is NOT.** The importing session is the author; a bundle naming a
 * `users.id` from another deployment would fail the foreign key, and one naming
 * a real local id would let anyone attribute writing to a colleague.
 *
 * **`revision`, `wordCount` and `readingTime` are NOT.** `createPost` writes
 * revision 1 and re-derives the counts from the document, which is the point of
 * server-owned derivation (spec §4.4).
 *
 * `slug` IS honoured, and safely: `createPost` runs a supplied slug through
 * `slugify` and then through the uniqueness walk, so a taken or hostile one
 * becomes a free, well-formed candidate rather than a raw unique violation.
 */
function toPartial(post: BundlePostInput): Partial<Post> {
  return {
    id: post.id,
    title: post.title,
    subtitle: post.subtitle,
    slug: post.slug ?? null,
    excerpt: post.excerpt,
    excerptSource: post.excerptSource,
    content: post.content as DocNode,
    coverImage: post.coverImage ?? null,
    category: post.category,
    tags: post.tags,
    template: post.template ?? null,
    status: post.status,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    publishedAt: post.publishedAt ?? null,
    deletedAt: post.deletedAt ?? null,
  };
}

routes.post('/import', requireAuth(), async (c) => {
  const db = currentDb(c);
  const user = currentUser(c);
  await limit(c, `import:${user.id}`, BACKUP_LIMIT, BACKUP_WINDOW_MS);

  const bundle = await readJson(c, ImportBody);
  if (!bundle.format.startsWith(BUNDLE_FORMAT_PREFIX)) {
    throw new BadRequestError('format');
  }

  /*
   * VALIDATE EVERYTHING BEFORE WRITING ANYTHING (spec §5.5).
   *
   * Validating as each post is inserted would leave the posts before the bad
   * one stored and the ones after it not — a partial restore the caller cannot
   * distinguish from a complete one. The path names the index as well as the
   * position inside the document, because "invalid document" over a 400-post
   * bundle is not something anyone can act on.
   */
  bundle.posts.forEach((post, i) => {
    const result = validateDoc(post.content);
    if (!result.ok) {
      throw new InvalidDocumentError({
        ...result.violation,
        path: `posts[${i}].${result.violation.path}`,
      });
    }
    const meta = checkPostMeta(post);
    if (meta) {
      throw new InvalidDocumentError({ ...meta, path: `posts[${i}].${meta.path}` });
    }
  });

  const ids = bundle.posts.map((p) => p.id);
  if (new Set(ids).size !== ids.length) throw new BadRequestError('posts.id');
  const already = await existingPostIds(db, ids);

  let imported = 0;
  let skipped = 0;
  for (const post of bundle.posts) {
    if (already.has(post.id)) {
      skipped += 1;
      continue;
    }
    try {
      await createPost(db, user, toPartial(post));
      imported += 1;
    } catch (err) {
      /*
       * The same "already imported" answer, reached the other way. `existingPostIds`
       * is a read and the insert is a write, so two devices importing the same
       * bundle at once can both find the id absent — and the primary key is the
       * authority for which one wins, not the read.
       */
      if (uniqueViolation(err) === 'posts_pkey') {
        skipped += 1;
        continue;
      }
      throw err;
    }
  }

  return c.json({
    imported,
    skipped,
    /*
     * WHAT DID NOT LAND, COUNTED.
     *
     * Revision history from a bundle is NOT restored. Spec §5.5 asks for two
     * things — preserved ids and validation — and neither the spec nor the plan
     * asks for history, while restoring it is genuinely unsafe here: an
     * imported post starts at revision 1 with a matching snapshot, so a
     * bundle's revisions 1..47 would collide with it on
     * `UNIQUE (post_id, revision)` and any renumbering would leave the post's
     * CAS pointer naming a snapshot that is not its current text. The words —
     * the thing this application exists to protect — are preserved in full, and
     * `createPost` writes a revision-1 snapshot of them.
     *
     * Image bytes are not restored either: there is no server image store
     * until Project B. Both are reported rather than dropped, so a caller can
     * tell a partial restore from a complete one.
     */
    ignored: {
      revisions: bundle.revisions?.length ?? 0,
      images: bundle.images?.length ?? 0,
    },
  });
});

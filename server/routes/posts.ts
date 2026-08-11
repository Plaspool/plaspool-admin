import { Hono } from 'hono';
import { z } from 'zod';
import { pathParam, readJson, readJsonOrEmpty, readQuery, str } from '../middleware/errors';
import { requireAuth, requireOwner } from '../middleware/session';
import { assertAuthorized } from '../authorize';
import {
  archivePost,
  createPost,
  destroyPost,
  duplicatePost,
  emptyTrash,
  getPost,
  publishPost,
  restorePost,
  savePost,
  sweepBlankDrafts,
  trashPost,
  unarchivePost,
  unpublishPost,
} from '../repo/posts';
import { pruneAutosaves } from '../repo/revisions';
import { listPosts } from '../repo/query';
import { NotFoundError } from '../repo/errors';
import { currentDb, currentUser } from '../app-env';
import type { AppEnv } from '../app-env';
import type { Db } from '../db/client';
import type { DocNode, Post, PostPatch } from '../../shared/types';

/**
 * Every post route (spec §5.2, §5.4): read and create and the 409 contract,
 * then lifecycle, destroy and the two maintenance sweeps.
 *
 * EVERY BODY IS PARSED WITH A `.strict()` SCHEMA. An unknown key is a 400, not
 * a silently ignored field, so a client cannot attempt to set a system field
 * and be told it worked. `slug` is the sharpest case: it is absent from
 * `PostPatch` on purpose (spec §4.5 — slugs are server-authoritative), so a
 * request carrying one is refused rather than accepted-and-discarded, which
 * would leave the caller believing it had set an address it had not.
 */
export const routes = new Hono<AppEnv>();

/**
 * `requireAuth()` IS ATTACHED PER ROUTE, NEVER AS `routes.use('*', ...)`.
 *
 * Measured, and it is not a style preference. `app.route('/api', posts)`
 * flattens this router into the parent, so a `use('*')` here becomes
 * `use('/api/*')` there — it applies to every path under the prefix, including
 * ones this file has never heard of. With the blanket form in place, an
 * unrouted `/api/nothing-here` answered **401 instead of 404**: the guard ran,
 * found no session, and refused a request that had no handler to reach. The
 * only reason `/api/auth/login` still worked is that its handler was registered
 * first and returned before the guard was reached — i.e. the behaviour depended
 * on mount order between two files.
 *
 * Per route it cannot leak, and forgetting one fails that route's own
 * "401 without a session" case.
 */
const auth = requireAuth();

// ------------------------------------------------------------------ schemas

const CoverImage = z
  .object({
    blobId: str().min(1).max(300),
    alt: str().max(2000),
    focalPoint: str().max(100),
    width: z.number().int().min(0).max(100_000),
    height: z.number().int().min(0).max(100_000),
  })
  .strict();

/**
 * `PostPatch`, mirrored (spec §5.2).
 *
 * `content` is `z.unknown()` rather than a recursive document schema, and that
 * is deliberate: `validateDoc` in `shared/validate.ts` is the single authority
 * on what a document may contain — allow-listed nodes and marks, href
 * protocols, depth, node count, serialised size and derived-text bytes — and it
 * reports a `path` that becomes spec §8's 422. A second, weaker Zod copy of
 * those rules would answer 400 where the contract says 422 and would drift from
 * the real one the first time a node type is added.
 *
 * NO `slug` KEY. `.strict()` therefore makes a request carrying one a 400.
 *
 * `coverImage` and `template` are `.nullable()` because null is a real value
 * for both: `savePost` distinguishes "absent, keep what is stored" from
 * "present and null, clear it".
 */
const PostPatchBody = z
  .object({
    title: str(),
    subtitle: str(),
    content: z.unknown(),
    coverImage: CoverImage.nullable(),
    category: str(),
    tags: z.array(str()).max(1000),
    excerpt: str(),
    template: z.enum(['magazine', 'minimal', 'editorial', 'technical']).nullable(),
  })
  .partial()
  .strict();

type PostPatchInput = z.infer<typeof PostPatchBody>;

/**
 * The parsed body as a `PostPatch`.
 *
 * The only cast is `content`, from `unknown` to `DocNode` — and it is honest
 * because `savePost`/`createPost` immediately run `validateDoc` on it and
 * throw `InvalidDocumentError` (422) if it is not one. The alternative, a Zod
 * schema claiming to know what a document is, would be the lie.
 */
function toPatch(body: PostPatchInput): PostPatch {
  const patch: PostPatch = { ...body, content: undefined };
  if ('content' in body) patch.content = body.content as DocNode;
  else delete patch.content;
  return patch;
}

const PatchBody = z
  .object({
    patch: PostPatchBody,
    /**
     * The CAS token (spec §4.2). Optional in the type because `savePost` treats
     * its absence as "no client base, do not refuse" — which is what the
     * lifecycle routes and `restoreRevision` rely on — but every editor save
     * sends one, and without it a second tab silently overwrites the first.
     */
    baseRevision: z.number().int().min(1).optional(),
    /**
     * Restricted to the two kinds a client may legitimately author.
     * `publish` and `status` snapshots are written by the lifecycle routes and
     * are never pruned, so letting a client name one would let it forge
     * history that survives every sweep.
     */
    kind: z.enum(['autosave', 'manual']).optional(),
  })
  .strict();

const ListQueryParams = z
  .object({
    status: z.enum(['all', 'draft', 'published', 'archived', 'trash']).default('all'),
    sort: z
      .enum(['updated', 'published', 'oldest', 'alphabetical', 'drafts-first'])
      .default('updated'),
    search: str().optional(),
    category: str().optional(),
    tag: str().optional(),
    cursor: str().optional(),
    /**
     * `pageLimit` decides the range and answers 400 by itself; this only makes
     * a non-numeric `?limit=abc` a 400 here rather than a NaN there.
     */
    limit: z.coerce.number().int().optional(),
  })
  /*
   * STRICT, LIKE THE BODIES. A mistyped filter that is silently ignored is
   * worse than a refusal: `?statuss=draft` would quietly return every post in
   * the blog, including the trash, and look like a bug in the dashboard.
   */
  .strict();

// -------------------------------------------------------------------- reads

routes.get('/posts', auth, async (c) => {
  const q = readQuery(c, ListQueryParams);
  /*
   * NO `content`. `listPosts` selects `LIST_POST_COLUMNS`, which enumerates it
   * out — shipping every document to render a list is the exact mistake spec
   * §5.2 names. `content` comes only from `GET /posts/:id`.
   */
  return c.json(await listPosts(currentDb(c), q));
});

/** The post, or a 404 — absent and destroyed are the same answer (spec §8). */
async function requirePost(db: Db, id: string): Promise<Post> {
  const post = await getPost(db, id);
  if (!post) throw new NotFoundError(id);
  return post;
}

routes.get('/posts/:id', auth, async (c) => {
  const post = await requirePost(currentDb(c), pathParam(c, 'id'));
  // Always true today. Called anyway: the day reads stop being universal, the
  // rule changes in `authorize()` and every route inherits it.
  assertAuthorized(post, currentUser(c), 'read');
  return c.json({ post });
});

// ------------------------------------------------------------------- create

routes.post('/posts', auth, async (c) => {
  const body = await readJsonOrEmpty(c, PostPatchBody);
  /*
   * `createPost` takes `Partial<Post>` because import and duplicate carry
   * system fields; this route hands it a `PostPatch` and nothing else, so a
   * caller cannot set `status`, `authorId`, `createdAt` or an id.
   */
  const post = await createPost(currentDb(c), currentUser(c), toPatch(body));
  return c.json({ post }, 201);
});

// -------------------------------------------------------------------- patch

/**
 * Autosave pruning is scheduled here, not inside `savePost`.
 *
 * `pruneAutosaves` is O(history) and the save path is the typing path, so it
 * runs on one save in ten — the same ratio the client used, but on a
 * deterministic trigger (`revision % 10`) rather than a sampled one, so what it
 * does is reproducible. `AUTOSAVE_KEEP` is 30, so history is bounded at 30 plus
 * at most nine.
 *
 * A FAILURE HERE MUST NOT FAIL THE SAVE. The write has already committed; the
 * writer's words are stored. Turning a successful save into a 500 because a
 * housekeeping DELETE lost a race is how a client concludes it must retry a
 * write that already happened.
 */
const PRUNE_EVERY = 10;

async function schedulePrune(db: Db, post: Post, kind: string): Promise<void> {
  if (kind !== 'autosave') return;
  if (post.revision % PRUNE_EVERY !== 0) return;
  await pruneAutosaves(db, post.id).catch(() => undefined);
}

routes.patch('/posts/:id', auth, async (c) => {
  const db = currentDb(c);
  const user = currentUser(c);
  const { patch, baseRevision, kind } = await readJson(c, PatchBody);

  // Read first so authorization is judged against the stored author, and so an
  // absent post is a 404 rather than a 403 that reveals nothing.
  const current = await requirePost(db, pathParam(c, 'id'));
  assertAuthorized(current, user, 'write');

  /*
   * A stale `baseRevision` throws `StaleWriteError`, which spec §4.3's 409
   * carries whole — `{ error, expected, actual, post }`, the server's current
   * post embedded — so the conflict banner's "Load theirs" renders with no
   * second request.
   */
  const post = await savePost(db, current.id, toPatch(patch), {
    actor: user,
    baseRevision,
    kind: kind ?? 'autosave',
  });

  await schedulePrune(db, post, kind ?? 'autosave');
  return c.json({ post });
});

// ---------------------------------------------------------------- lifecycle

/**
 * Publish, unpublish, archive, unarchive, trash, restore (spec §4.2, §5.2).
 *
 * NO `baseRevision` IN THE BODY, AND THAT IS THE CONTRACT, NOT AN OMISSION.
 * These are server-derived: there is no human decision to surface, so the
 * repository re-reads, re-derives and re-CASes up to three times, pinning the
 * `lifecycle_generation` it first saw. A concurrent autosave therefore does not
 * refuse a publish (the retry wins and re-derives from the newer text), and any
 * concurrent LIFECYCLE change by anyone does (the pin cannot match), which is
 * the only way a `trash` that lost to a deliberate `restore` fails instead of
 * silently re-trashing a post somebody had just rescued.
 *
 * SO A 409 FROM HERE MEANS ONE OF TWO DIFFERENT THINGS, and they are different
 * errors: `stale_write` is a lost race, `precondition_failed` is "the post is
 * already published" with no race involved at all. Collapsed into one, the
 * refusal arrives with `expected === actual` and no conflict banner can render
 * it.
 *
 * EACH RETURNS THE NEW POST so the editor can adopt the bumped revision without
 * a second request — without it the next autosave would carry a `baseRevision`
 * the server has already passed and 409 against itself.
 */
const TRANSITIONS = {
  publish: publishPost,
  unpublish: unpublishPost,
  archive: archivePost,
  unarchive: unarchivePost,
  trash: trashPost,
  restore: restorePost,
} as const;

for (const [name, run] of Object.entries(TRANSITIONS)) {
  routes.post(`/posts/:id/${name}`, auth, async (c) => {
    const db = currentDb(c);
    const user = currentUser(c);
    const current = await requirePost(db, pathParam(c, 'id'));
    assertAuthorized(current, user, 'write');
    return c.json({ post: await run(db, current.id, user) });
  });
}

/**
 * A copy, authored by whoever asked for it.
 *
 * `read` and not `write` on the SOURCE, deliberately: the source is not
 * modified, everyone authenticated already reads everything (spec §6), and a
 * duplicate is what a writer would otherwise do by selecting the text. The
 * COPY is theirs — `duplicatePost` resets the author, the slug, the status and
 * every timestamp, so this cannot be used to acquire someone else's published
 * address.
 */
routes.post('/posts/:id/duplicate', auth, async (c) => {
  const db = currentDb(c);
  const user = currentUser(c);
  const source = await requirePost(db, pathParam(c, 'id'));
  assertAuthorized(source, user, 'read');
  return c.json({ post: await duplicatePost(db, source.id, user) }, 201);
});

// ------------------------------------------------------------------ destroy

/**
 * OWNER ONLY, and this is where spec §5.2 and spec §6 disagree — see the note
 * in `server/authorize.ts`. §6 wins: `destroyPost` is the only irreversible
 * operation in the application and it CASCADEs away every revision.
 *
 * `assertAuthorized(post, user, 'destroy')` rather than `requireOwner()`, so
 * the rule lives in the one function spec §6 names and a later loosening is one
 * edit rather than a search.
 *
 * Idempotent: destroying an already-destroyed post is a 404, because the read
 * that authorizes it cannot find the row — and spec §8 answers absent and
 * destroyed identically anyway.
 */
routes.delete('/posts/:id', auth, async (c) => {
  const db = currentDb(c);
  const post = await requirePost(db, pathParam(c, 'id'));
  assertAuthorized(post, currentUser(c), 'destroy');
  await destroyPost(db, post.id);
  return c.json({ ok: true });
});

// -------------------------------------------------------------- maintenance

/**
 * The two sweeps the client can no longer compute (spec §5.4).
 *
 * List responses carry no `content` and pagination means the browser cannot see
 * every post, so "which drafts are blank" is not a question a dashboard can
 * answer any more. It moves here.
 */

const SweepBody = z
  .object({
    /** The draft the caller is currently editing — never swept out from under them. */
    exceptId: str().min(1).max(200).optional(),
  })
  .strict();

/**
 * NOT owner-only, and that matches spec §5.4's table exactly: it marks
 * `/images/collect-orphans` owner-only and leaves `/posts/sweep-blank`
 * unmarked. A writer's dashboard is where this runs, and it destroys only
 * drafts that are blank by `isBlankDoc`'s own reading — where an image-only,
 * a divider-only and an UNPARSEABLE document all count as content — and only
 * after a 60-second grace period.
 */
routes.post('/posts/sweep-blank', auth, async (c) => {
  const { exceptId } = await readJsonOrEmpty(c, SweepBody);
  /*
   * THE CALLER'S OWN DRAFTS, AND NOBODY ELSE'S.
   *
   * Not owner-only, because spec §5.4's table marks `/images/collect-orphans`
   * owner-only and leaves this one unmarked — a writer's dashboard is where it
   * runs, and an owner-only sweep would simply never run for a writer, leaving
   * their blank drafts to accumulate forever. Scoping it to `authorId` keeps
   * the route where the spec puts it while removing the only thing that made
   * it dangerous: one writer hard-deleting another writer's row.
   */
  const swept = await sweepBlankDrafts(currentDb(c), currentUser(c).id, exceptId);
  return c.json({ swept });
});

/**
 * Owner only (spec §6). It hard-deletes every trashed post and CASCADEs away
 * their revisions, so it is the one route that can destroy another writer's
 * history in bulk.
 */
routes.post('/trash/empty', requireOwner(), async (c) =>
  c.json({ emptied: await emptyTrash(currentDb(c)) }),
);

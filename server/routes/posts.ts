import { Hono } from 'hono';
import { z } from 'zod';
import { readJson, readJsonOrEmpty, readQuery } from '../middleware/errors';
import { requireAuth } from '../middleware/session';
import { assertAuthorized } from '../authorize';
import { createPost, getPost, savePost } from '../repo/posts';
import { pruneAutosaves } from '../repo/revisions';
import { listPosts } from '../repo/query';
import { NotFoundError } from '../repo/errors';
import { currentDb, currentUser } from '../app-env';
import type { AppEnv } from '../app-env';
import type { Db } from '../db/client';
import type { DocNode, Post, PostPatch } from '../../shared/types';

/**
 * Post read, create and the 409 contract (spec §5.2).
 *
 * Lifecycle, destroy and the maintenance sweeps are in `lifecycle.ts`, mounted
 * beside this one — split so a reviewer can reject one without the other.
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
    blobId: z.string().min(1).max(300),
    alt: z.string().max(2000),
    focalPoint: z.string().max(100),
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
    title: z.string(),
    subtitle: z.string(),
    content: z.unknown(),
    coverImage: CoverImage.nullable(),
    category: z.string(),
    tags: z.array(z.string()).max(1000),
    excerpt: z.string(),
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
    search: z.string().optional(),
    category: z.string().optional(),
    tag: z.string().optional(),
    cursor: z.string().optional(),
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
  const post = await requirePost(currentDb(c), c.req.param('id'));
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
  const current = await requirePost(db, c.req.param('id'));
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

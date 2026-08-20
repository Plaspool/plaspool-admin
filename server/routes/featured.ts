import { Hono } from 'hono';
import { z } from 'zod';
import { pathParam, readJson, readJsonOrEmpty, str } from '../middleware/errors';
import { requireAuth, requireOwner } from '../middleware/session';
import {
  MAX_FEATURED,
  featurePost,
  listFeatured,
  reorderFeatured,
  unfeaturePost,
} from '../repo/featured';
import { currentDb } from '../app-env';
import type { AppEnv } from '../app-env';

/**
 * The admin side of the curated rail.
 *
 * ═══ WHY CURATION IS OWNER-ONLY ═══
 *
 * `assertAuthorized(post, user, 'write')` is the rule every other post mutation
 * uses, and it is the WRONG rule here. It asks "did you write this post", and
 * curation is not a question about a post's author — it is a question about the
 * front of the blog. Under the write rule any writer could put their own post
 * at the top of the site, on an invite-only writer list whose whole point is
 * that an editor decides what leads.
 *
 * So the mutations take `requireOwner()`, which is spec §6's rule for exactly
 * this class of operation: "Destroy, empty-trash and invite management are
 * owner-only" — the site-wide ones. `GET` is `requireAuth()` instead, following
 * §6's other rule that every authenticated user reads everything: a writer has
 * to see the rail to be told why the toggle in their editor is disabled.
 *
 * ═══ EVERY MUTATION ANSWERS WITH THE WHOLE RAIL ═══
 *
 * Not with the post, and not with `{ ok: true }`. The manager renders four
 * cards and the editor shows an "n of 4" counter, and both are derived from the
 * same list — so returning it makes every mutation self-sufficient, exactly as
 * the lifecycle routes return the new post so the editor can adopt the bumped
 * revision without a second request.
 *
 * ═══ THE REFUSALS CARRY THE RAIL TOO ═══
 *
 * A 409 from here is `{ error, limit, items }`. The storefront's contract asks
 * for it by name — the fifth feature "should NAME the current four so the admin
 * UI can offer 'unfeature one of these' instead of a dead error" — and the same
 * body serves a stale reorder, where the manager re-renders from the refusal
 * rather than asking again and hoping. Built in `server/middleware/errors.ts`
 * from `FeaturedConflictError`, so this file shapes nothing.
 */
export const routes = new Hono<AppEnv>();

/**
 * Per route, never `routes.use('*', …)`.
 *
 * `app.route('/api', featured)` flattens this router into the parent, so a
 * blanket guard here would become `use('/api/*')` there and answer 401 for
 * every unrouted path under the prefix — measured, and written up at length in
 * `server/routes/posts.ts`.
 */
const auth = requireAuth();
const ownerOnly = requireOwner();

/**
 * `.strict()`, so `{ rank: 1 }` is a 400 rather than a silently ignored field.
 *
 * A caller cannot choose a rank. Position is assigned by the server — the
 * lowest free slot, or the one a `replace` vacates — because the rank column is
 * unique and bounded, and a client picking numbers into it would be racing the
 * constraint on every call.
 */
const FeatureBody = z
  .object({
    /** Take this post's slot, and its position. See `featurePost`. */
    replace: str().min(1).max(200).optional(),
  })
  .strict();

/**
 * BOUNDED AT THE RAIL'S WIDTH, at the schema.
 *
 * A longer list can only ever be refused — `posts_featured_rank_ck` bounds the
 * column to 1..4 — so refusing it here costs a caller nothing and saves
 * building a statement over however many ids they chose to send. `str()` is the
 * project's NUL-rejecting string, so an id carrying U+0000 is a 400 rather than
 * SQLSTATE 22021 arriving as a 500.
 */
const ReorderBody = z
  .object({
    ids: z.array(str().min(1).max(200)).max(MAX_FEATURED),
  })
  .strict();

routes.get('/featured', auth, async (c) =>
  c.json({ items: await listFeatured(currentDb(c)) }),
);

routes.post('/posts/:id/feature', ownerOnly, async (c) => {
  const body = await readJsonOrEmpty(c, FeatureBody);
  /*
   * `pathParam`, so a NUL byte is a 400 and not a 500 — `server/nul-bytes.test.ts`
   * walks every registered route and requires it.
   *
   * NO `requirePost` READ FIRST, unlike the lifecycle routes. Those read the
   * post to authorize it against its author; this route's permission does not
   * depend on the post at all, and the repository's single guarded statement is
   * already the authority on whether the row exists and may be featured. A read
   * here would add a round trip and a window, and would answer 404 from a
   * different place than `featurePost` does.
   */
  const items = await featurePost(currentDb(c), pathParam(c, 'id'), {
    replace: body.replace,
  });
  return c.json({ items });
});

routes.post('/posts/:id/unfeature', ownerOnly, async (c) =>
  c.json({ items: await unfeaturePost(currentDb(c), pathParam(c, 'id')) }),
);

/**
 * PUT, because it REPLACES the ordering rather than amending it.
 *
 * There is deliberately no single-row form. Two posts exchanging ranks is the
 * ordinary case, and any decomposition of it leaves a moment where they share a
 * rank or a moment where one has none — invariant 4 of the contract, and the
 * reason `posts_featured_rank_uq` is deferrable.
 */
routes.put('/featured', ownerOnly, async (c) => {
  const body = await readJson(c, ReorderBody);
  return c.json({ items: await reorderFeatured(currentDb(c), body.ids) });
});

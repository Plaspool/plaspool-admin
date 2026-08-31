import { Hono } from 'hono';
import { z } from 'zod';
import type { Context } from 'hono';
import { pathParam, readJson, readQuery, str, toResponse } from '../middleware/errors';
import { requireAdmin, requireAuth } from '../middleware/session';
import { BadRequestError } from '../repo/errors';
import {
  CategoryPreconditionFailedError,
  UNCATEGORISED,
  createCategory,
  deleteCategory,
  listCategories,
  normaliseCategoryName,
  renameCategory,
} from '../repo/categories';
import { MAX_CATEGORY_BYTES } from '../../shared/validate';
import { currentDb } from '../app-env';
import type { AppEnv } from '../app-env';

/**
 * Managed categories (HANDOFF §2 A3).
 *
 * FOUR ROUTES, THREE OF THEM `requireAuth()` AND ONE `requireOwner()`. Writers
 * create and rename because a writer inventing a category is the ordinary act
 * this feature exists to make survivable — it is how the free-text era's typo
 * categories were born, and refusing writers would simply push them back into
 * typing one into the post. Only DELETE is owner-only: it is the one operation
 * that can rewrite `posts.category` on posts the caller did not write, in bulk,
 * with no undo.
 *
 * THE RESPONSE SHAPES ARE PINNED BY `src/data/api-categories.ts`, which was
 * written before this file because three frontend surfaces are being built
 * against it in parallel. `{ categories }`, `{ category }`,
 * `{ category, movedPosts }`, `{ movedPosts }` — that module is the contract and
 * this one matches it; `categories.test.ts` asserts each shape so the two cannot
 * drift apart silently.
 */
export const routes = new Hono<AppEnv>();

/**
 * The three refusals, rendered with the category they are about.
 *
 * WHY A LOCAL HANDLER RATHER THAN AN EDIT TO `server/middleware/errors.ts`.
 * `CategoryPreconditionFailedError` extends `PreconditionFailedError`, so one
 * escaping this handler still lands on the global one and still becomes a correct
 * 409 — that fallback is the safety property, not a fork of the §8 table. What
 * could not be reused is the payload: the shared class carries a `Post`, and the
 * questions these refusals have to answer ("which row already has that name",
 * "how many posts still use this") are about a category. `server/shop/app.ts`
 * does exactly this for Catalog's two conflicts, for the same reason.
 *
 * EVERYTHING ELSE FALLS THROUGH TO `toResponse` UNTOUCHED, so 400, 401, 403, 404
 * and 500 on this surface are the same implementation the whole application
 * shares and this file cannot grow its own dialect of them.
 */
routes.onError((err, c) => {
  const requestId = c.get('requestId') ?? '';
  if (!(err instanceof CategoryPreconditionFailedError)) return toResponse(err, requestId);

  return new Response(
    JSON.stringify({
      error: 'precondition_failed',
      operation: err.operation,
      category: err.category,
      requestId,
    }),
    {
      status: 409,
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'x-request-id': requestId,
      },
    },
  );
});

// ------------------------------------------------------------------ schemas

/**
 * `{ name }`, strict, for both create and rename.
 *
 * `.max(MAX_CATEGORY_BYTES)` here is a COARSE outer bound and not the real check:
 * Zod counts UTF-16 units and the ceiling is bytes, so a 400-character name of
 * emoji is 1600 bytes and passes this. `normaliseCategoryName` does the byte
 * measurement after trimming. This still earns its place — it bounds what reaches
 * `TextEncoder` at all, and it makes `?name=<10 MB>` a refusal rather than an
 * allocation.
 */
const CategoryBody = z
  .object({ name: str().min(1).max(MAX_CATEGORY_BYTES) })
  .strict();

/**
 * STRICT, like the bodies, and the reason is the same one `ListQueryParams`
 * gives: a mistyped parameter that is silently ignored is worse than a refusal.
 * `?reassing=Design` would delete the category and leave twelve posts pointing at
 * a name nothing manages, having reported success.
 */
const DeleteQuery = z
  .object({ reassign: str().max(MAX_CATEGORY_BYTES).optional() })
  .strict();

/**
 * `-` MEANS UNCATEGORISED, and the marker is the client's (`api-categories.ts`
 * sends it). A query parameter cannot carry "the empty string" in a way every
 * layer agrees about — `url()` on the client drops an empty value entirely — so
 * "move them to no category at all" needed a spelling that survives the round
 * trip. The cost is that a category literally named `-` cannot be a reassignment
 * target, which is the cheapest thing on the table to give up.
 *
 * `undefined` (the parameter absent) is NOT the same as `''`: absent means "only
 * delete if nothing uses it", which is the refusal path.
 */
const UNCATEGORISED_MARKER = '-';

function reassignTarget(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  if (raw === UNCATEGORISED_MARKER || raw.trim() === '') return UNCATEGORISED;
  return normaliseCategoryName(raw, 'reassign');
}

/**
 * The `:id` segment, or a 400.
 *
 * BOTH CHECKS, IN THIS ORDER. `pathParam` is the NUL boundary every route in this
 * codebase reads its segments through, and `server/nul-bytes.test.ts` walks the
 * whole route table on that assumption. The UUID shape is the second half:
 * `categories.id` is a `uuid` column, so a segment that is not one reaches the
 * driver as SQLSTATE 22P02, is scrubbed to a `DbError`, answered 500, and then
 * retried five times by the client's policy for a request that can never succeed.
 *
 * The regex would refuse a NUL on its own. Calling `pathParam` anyway costs one
 * line and keeps the rule uniform — a route that opts out because its own
 * validation happens to be stricter is the route the next one gets copied from.
 */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function categoryId(c: Context<AppEnv>): string {
  const id = pathParam(c, 'id');
  if (!UUID.test(id)) throw new BadRequestError('id');
  return id;
}

// -------------------------------------------------------------------- routes

/**
 * The union of the managed list and the values in use, counts included.
 *
 * NO QUERY PARAMETERS AT ALL, including no pagination. This is an invite-only
 * blog's category vocabulary — the same reason `GET /api/users` needs none — and
 * every consumer is a picker that has to render the whole list anyway. A cursor
 * here would be a filter the dashboard's category `Select` would immediately have
 * to defeat.
 */
routes.get('/categories', requireAuth(), async (c) => {
  return c.json({ categories: await listCategories(currentDb(c)) });
});

/**
 * Create, or adopt: the name may already be in use as free text, in which case
 * the row that comes back carries the count of posts that were already carrying
 * it. 409 if a managed row already has the name in any casing.
 */
routes.post('/categories', requireAuth(), async (c) => {
  const { name } = await readJson(c, CategoryBody);
  const category = await createCategory(currentDb(c), normaliseCategoryName(name, 'name'));
  return c.json({ category }, 201);
});

/**
 * Rename, and move every post carrying the old value in the same statement.
 *
 * `movedPosts` comes back because the UI promises the number BEFORE the click
 * ("N posts will move") and has to be able to say what actually happened after
 * it — a rename that quietly moved a different number of posts than the list said
 * it would is the one outcome that makes the count untrustworthy forever.
 */
routes.patch('/categories/:id', requireAuth(), async (c) => {
  const id = categoryId(c);
  const { name } = await readJson(c, CategoryBody);
  return c.json(await renameCategory(currentDb(c), id, normaliseCategoryName(name, 'name')));
});

/**
 * Owner-only. Refused with 409 while posts still carry the name, unless
 * `?reassign=` names where they should go (`-` for uncategorised).
 */
routes.delete('/categories/:id', requireAdmin(), async (c) => {
  const id = categoryId(c);
  const { reassign } = readQuery(c, DeleteQuery);
  return c.json(await deleteCategory(currentDb(c), id, reassignTarget(reassign)));
});

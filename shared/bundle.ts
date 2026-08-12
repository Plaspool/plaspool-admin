import { z } from 'zod';

/**
 * The wire schema `POST /api/import` parses its body with — HERE rather than in
 * `server/routes/backup.ts`, so the client can run the SERVER'S OWN object
 * before it uploads a single byte.
 *
 * MEASURED, AND THE REASON THIS MODULE EXISTS. Migration (plan §6.4 step 0)
 * used to "pre-validate" with a client-side approximation of this schema. A
 * `localPosts` row is a `Post` PLUS the `migratedAt` field the v1→v2 upgrade
 * stamps on it, `BundlePost` is `.strict()`, and the approximation was not — so
 * every batch passed the local check and came back
 * `unrecognized_keys: ['migratedAt']`, i.e. a **400**. Two things made that
 * expensive rather than merely wrong: the import route's 422 arm does not
 * handle a 400, and `limit()` runs before `readJson`
 * (`server/routes/backup.ts`), so each rejected batch still burned one of the
 * five import slots the hour allows. Five retries and the budget was gone.
 *
 * An approximation cannot be made safe by being careful, because the failure is
 * silent in the direction that matters: the local copy is laxer than the real
 * one, so it says yes to bodies the server says no to. The only fix that stays
 * fixed is for both sides to run the same object, which is what this file is.
 *
 * `server/` may import from here and `src/` may import from here; neither may
 * import from the other, and nothing here may import from either.
 */

/**
 * A `text` value Postgres can actually store.
 *
 * DUPLICATED FROM `server/middleware/errors.ts`, DELIBERATELY, AND PINNED BY A
 * TEST. That module is where `str()` belongs — it sits beside `pathParam` and
 * `readJson` and it imports `hono` for `Context` — and importing it from here
 * would drag the whole server request layer into the browser bundle for one
 * regex. So the rule is copied and `shared/bundle.test.ts` asserts the two
 * accept and reject the same strings, which is the guarantee that actually
 * matters: a bundle post the client accepts and the server refuses is another
 * 400 that burns an import slot, which is the exact defect this module was
 * created to remove.
 *
 * U+0000 is the whole of it. Postgres `text` cannot hold one — the driver
 * raises SQLSTATE 22021 — and jsonb cannot either (22P05). Neither has a row in
 * spec §8's table, so untranslated both are a 500 that the client's retry
 * policy re-sends five times over ~30 seconds for input that can never be
 * accepted.
 *
 * `.regex()` and not `.refine()` DELIBERATELY: a regex is a `ZodString` check,
 * so `str().min(1).max(300)` still type-checks and still reads as a string
 * schema. A `.refine()` returns a wrapper in some Zod versions and every call
 * site below would have to be reordered around it.
 */
const NUL = String.fromCharCode(0);
const NO_NUL = new RegExp(`^[^${NUL}]*$`, 'u');

export function str(): z.ZodString {
  return z.string().regex(NO_NUL, 'nul');
}

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
 * EVERY field a bundle's `Post` carries, and `.strict()`.
 *
 * The system-owned ones are declared here and then deliberately NOT honoured by
 * the route's `toPartial` — declaring them is what lets a genuine
 * `exportBundle()` file import at all, while `.strict()` still refuses a key
 * that is not part of `Post`, so a caller cannot smuggle a column name past the
 * schema and hope.
 *
 * Nearly everything is optional because a bundle may come from an older export
 * (`template` and `excerptSource` are recent) and because `createPost` already
 * has a defined default for each.
 *
 * WHAT IS NOT HERE IS THE POINT AS MUCH AS WHAT IS. `migratedAt` is a
 * `localPosts` column, not a `Post` field, and it stays rejected — the fix for
 * plan §6.4's 400 is that the client builds each bundle post from an explicit
 * field allow-list and finds out locally, not that the schema is widened to
 * swallow client-side bookkeeping.
 */
export const BundlePost = z
  .object({
    id: str().min(1).max(300),
    title: str(),
    subtitle: str(),
    slug: str().nullable().optional(),
    excerpt: str().optional(),
    excerptSource: z.enum(['derived', 'author']).optional(),
    content: z.unknown(),
    coverImage: CoverImage.nullable().optional(),
    category: str().optional(),
    tags: z.array(str()).max(1000).optional(),
    template: z.enum(['magazine', 'minimal', 'editorial', 'technical']).nullable().optional(),
    status: z.enum(['draft', 'published', 'archived']).optional(),
    createdAt: z.number().int().optional(),
    updatedAt: z.number().int().optional(),
    publishedAt: z.number().int().nullable().optional(),
    deletedAt: z.number().int().nullable().optional(),
    // Declared, never honoured — see `toPartial` in `server/routes/backup.ts`.
    wordCount: z.number().optional(),
    readingTime: z.number().optional(),
    authorId: str().optional(),
    authorName: str().optional(),
    revision: z.number().optional(),
    author: str().optional(),
  })
  .strict();

export type BundlePostInput = z.infer<typeof BundlePost>;

export const ImportBody = z
  .object({
    format: str().min(1).max(200),
    exportedAt: str().max(100).optional(),
    posts: z.array(BundlePost).max(20_000),
    /*
     * ACCEPTED AND IGNORED, AND THE RESPONSE SAYS SO.
     *
     * A real bundle carries both keys, so refusing them would make the file
     * this application writes unimportable by the application that wrote it.
     * But neither is restored — see the note on `revisions` in
     * `server/routes/backup.ts` — and silently dropping them would be the
     * accepted-and-discarded failure every other `.strict()` schema here exists
     * to prevent. So the counts come back in the response.
     */
    revisions: z.array(z.unknown()).optional(),
    images: z.array(z.unknown()).optional(),
  })
  .strict();

export type ImportBodyInput = z.infer<typeof ImportBody>;

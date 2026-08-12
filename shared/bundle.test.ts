import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ZodError } from 'zod';
import { BundlePost, ImportBody, str } from './bundle';
import { str as serverStr, zodDetail } from '../server/middleware/errors';

/**
 * The drift guard for `shared/bundle.ts`.
 *
 * This file exists because of one measured 400 and the way it was expensive.
 * Plan §6.4 step 0 asks migration to validate locally before uploading, and the
 * first attempt did it with a client-side approximation of the import route's
 * body schema. A `localPosts` row carries `migratedAt`, `BundlePost` is
 * `.strict()`, the approximation was not — so every batch passed locally, came
 * back `unrecognized_keys: ['migratedAt']` → 400, and burned an import slot on
 * the way (`limit()` runs before `readJson`). The route's 422 arm does not
 * handle a 400 either, so five retries emptied the hour's budget of five.
 *
 * So the two things worth pinning are: the route runs THIS object rather than a
 * copy, and this object still behaves the way the measurement said it did.
 */

/** A NUL, built exactly the way `server/middleware/errors.ts` builds its own. */
const NUL = String.fromCharCode(0);

const bundlePost = () => ({
  id: 'p_1',
  title: 'A title',
  subtitle: '',
  content: { type: 'doc', content: [] },
});

/** The `ZodError` from a parse that was supposed to fail. */
function refusal(result: { success: boolean; error?: ZodError }): ZodError {
  if (result.success || !result.error) throw new Error('expected the schema to refuse this');
  return result.error;
}

const ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL('../server/routes/backup.ts', import.meta.url)),
  'utf8',
);

describe('the route parses with the shared schema, not a copy of it', () => {
  it('imports ImportBody from shared/bundle', () => {
    expect(ROUTE_SOURCE).toMatch(
      /import \{[^}]*\bImportBody\b[^}]*\} from '\.\.\/\.\.\/shared\/bundle'/,
    );
  });

  /*
   * A COPY IS THE FAILURE, NOT AN ABSENT IMPORT. Re-declaring `BundlePost` in
   * the route beside the import would leave every assertion below passing while
   * the server parsed something else entirely — which is exactly the defect
   * this module was created to remove, one layer up.
   */
  it('declares no local BundlePost, ImportBody or CoverImage', () => {
    expect(ROUTE_SOURCE).not.toMatch(/^const (BundlePost|ImportBody|CoverImage)\b/m);
  });

  /*
   * `str()` is duplicated rather than imported (see the note in
   * `shared/bundle.ts`), so it is the one part of the shared schema that CAN
   * drift from the server's. A drifted copy is another body the client accepts
   * and the server refuses, i.e. another 400 that costs an import slot.
   */
  it('applies the same string boundary the server middleware does', () => {
    const cases = ['', 'ordinary', `a${NUL}b`, NUL, ' ', 'emoji 🙂', 'tab\tnewline\n'];
    for (const value of cases) {
      expect([value, str().safeParse(value).success]).toEqual([
        value,
        serverStr().safeParse(value).success,
      ]);
    }
    // Pinned absolutely as well as relatively: two copies that agree because
    // both stopped checking would satisfy the loop above.
    expect(str().safeParse(`a${NUL}b`).success).toBe(false);
    expect(str().safeParse('ordinary').success).toBe(true);
  });
});

describe('BundlePost', () => {
  /*
   * THE MEASURED CASE. `migratedAt` is the field plan §2.1's v1→v2 upgrade
   * stamps on every `localPosts` row, so it is what a bundle post spread
   * straight out of the store carries. It stays rejected: the fix is that
   * migration builds each post from an explicit field allow-list and finds out
   * locally, not that the schema is widened to swallow client bookkeeping.
   */
  it('rejects a post carrying migratedAt with unrecognized_keys', () => {
    const error = refusal(BundlePost.safeParse({ ...bundlePost(), migratedAt: null }));
    expect(error.issues[0].code).toBe('unrecognized_keys');
    expect(error.issues[0]).toMatchObject({ keys: ['migratedAt'] });
  });

  /* The other half of the measurement: without the field, the same row parses. */
  it('accepts the same post without migratedAt', () => {
    expect(BundlePost.safeParse(bundlePost()).success).toBe(true);
  });

  /*
   * What the client sees when it asks the question locally: `zodDetail` is what
   * the route turns a failed parse into, so this is the exact `detail` the 400
   * carried — the string migration reports beside "can't be uploaded".
   */
  it('names the offending key in the detail the route would have answered with', () => {
    const error = refusal(
      ImportBody.safeParse({
        format: 'publishing-studio/v2',
        posts: [{ ...bundlePost(), migratedAt: null }],
      }),
    );
    expect(zodDetail(error)).toBe('posts.0.migratedAt');
  });

  /*
   * The system-owned fields are declared so a genuine `exportBundle()` file
   * imports at all; the route's `toPartial` is what refuses to honour them.
   * Dropping one from the schema makes every real export a 400.
   */
  it('accepts the system-owned fields a real export carries', () => {
    const parsed = BundlePost.safeParse({
      ...bundlePost(),
      wordCount: 12,
      readingTime: 1,
      authorId: 'u_1',
      authorName: 'Ada',
      revision: 7,
      author: 'Ada',
      excerptSource: 'author',
      template: 'magazine',
      status: 'published',
      publishedAt: 1,
      deletedAt: null,
      coverImage: { blobId: 'img_1', alt: '', focalPoint: '50% 50%', width: 10, height: 10 },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a NUL byte in a string field', () => {
    expect(BundlePost.safeParse({ ...bundlePost(), title: `a${NUL}b` }).success).toBe(false);
  });

  it('rejects an unknown key on coverImage', () => {
    const parsed = BundlePost.safeParse({
      ...bundlePost(),
      coverImage: { blobId: 'i', alt: '', focalPoint: '', width: 1, height: 1, srcset: 'x' },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('ImportBody', () => {
  it('requires format and accepts the accepted-and-ignored keys', () => {
    expect(ImportBody.safeParse({ posts: [] }).success).toBe(false);
    expect(
      ImportBody.safeParse({
        format: 'publishing-studio/v2',
        exportedAt: new Date().toISOString(),
        posts: [bundlePost()],
        revisions: [{ anything: true }],
        images: [{ anything: true }],
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown top-level key', () => {
    const error = refusal(
      ImportBody.safeParse({ format: 'publishing-studio/v2', posts: [], cursor: 'x' }),
    );
    expect(zodDetail(error)).toBe('cursor');
  });
});

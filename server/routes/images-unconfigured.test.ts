/**
 * The media routes on a deployment with NO R2 CONFIGURATION (spec §5.4).
 *
 * A SEPARATE FILE BECAUSE IT MOCKS NOTHING. `server/routes/images.test.ts`
 * stubs `../storage/r2` for the whole module — it has to, since every one of
 * those six operations needs a bucket — and a stub is exactly the wrong
 * instrument for this question. What is under test here is what the REAL
 * `presignPut` does when `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID` and
 * `R2_SECRET_ACCESS_KEY` are empty, which is their state in this repository's
 * test environment and the state `server/storage/r2.ts` calls supported: every
 * one is `.default('')` in `server/env.ts` precisely so an instance without
 * media boots and serves `GET /api/posts` normally.
 *
 * THE DEFECT THIS PINS lived in the interaction of four decisions that are each
 * correct alone:
 *
 * 1. the `images` row is inserted BEFORE the URL is signed, so no signature can
 *    ever authorise a write to a key no row knows about;
 * 2. an instance with no R2 configuration boots rather than failing at import;
 * 3. `presignPut` throws `R2NotConfiguredError` on such an instance;
 * 4. spec §8's client retries 5xx five times with backoff.
 *
 * Composed: each retry inserted a row and removed none. Eleven attempts filled
 * `MAX_OPEN_SLOTS`, and from the twelfth the writer was answered 400 `slots` —
 * for 24 hours, INCLUDING after ops had corrected the environment, because
 * `createSlot` counts open slots younger than `SLOT_TTL_MS`. A server
 * misconfiguration consumed the writer's own quota, and their retry policy was
 * the mechanism. Ghost 5.x with an unavailable storage adapter fails the upload
 * and succeeds on the next one after the fix; this locked the writer out for a
 * day.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { SEED_PASSWORD, freshDb, type TestCtx } from '../test/harness';
import { httpClient, json, type HttpClient } from '../test/http';
import { MAX_OPEN_SLOTS } from '../repo/images';

let ctx: TestCtx;
let owner: HttpClient;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM images`);
  await ctx.db.execute(sql`DELETE FROM auth_attempts`);
  await ctx.db.execute(sql`DELETE FROM sessions`);
  owner = httpClient(ctx.db);
  const res = await owner.post('/api/auth/login', {
    email: ctx.users.owner.email,
    password: SEED_PASSWORD,
  });
  expect(res.status).toBe(200);
});

async function count(): Promise<number> {
  const res = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM images`);
  return Number(res.rows[0].n);
}

describe('POST /api/images with no R2 configuration', () => {
  it('the critic\'s repro: twelve attempts, and the table stays empty', async () => {
    // Twelve is two more than MAX_OPEN_SLOTS plus one, i.e. past the point the
    // old code began answering `slots`. The count is the assertion, and it is
    // taken after EVERY attempt so a leak on any one of them is located.
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const res = await owner.post('/api/images', {
        contentType: 'image/png',
        byteSize: 24,
      });
      const body = await json<{ error: string; detail?: string }>(res);
      expect(body.detail, `attempt ${attempt}`).toBe('storage');
      expect(await count(), `attempt ${attempt}`).toBe(0);
    }
  });

  it('never degrades into `slots`, which would outlive the misconfiguration', async () => {
    /*
     * The specific harm: `slots` is a 400 that keeps being returned after the
     * environment is fixed, until the oldest row ages past SLOT_TTL_MS or an
     * owner runs collect-orphans. The writer cannot clear it and has no reason
     * to connect it to a configuration change made hours ago.
     */
    const details = new Set<string | undefined>();
    for (let i = 0; i < MAX_OPEN_SLOTS + 2; i += 1) {
      const res = await owner.post('/api/images', {
        contentType: 'image/png',
        byteSize: 24,
      });
      details.add((await json<{ detail?: string }>(res)).detail);
    }
    expect([...details]).toEqual(['storage']);
  });

  it('is a 400 — the client must not retry a condition that cannot change', async () => {
    /*
     * Spec §8: 5xx and network errors are retried five times over ~30 seconds;
     * permanent conditions stop. A deployment's absent R2 variables do not
     * appear inside those 30 seconds, so a 500 spends the whole budget to
     * arrive at the same answer — and, before the compensating delete existed,
     * did real damage on the way. The body names no variable: which ones are
     * missing is operational detail, and `R2NotConfiguredError` keeps it out of
     * the response deliberately.
     */
    const res = await owner.post('/api/images', {
      contentType: 'image/png',
      byteSize: 24,
    });
    expect(res.status).toBe(400);
    const body = await json<Record<string, unknown>>(res);
    expect(body).toMatchObject({ error: 'bad_request', detail: 'storage' });
    expect(JSON.stringify(body)).not.toMatch(/R2_|bucket|account/i);
  });

  it('the rest of the app is unaffected — media-less is a supported deployment', async () => {
    // The reason `presignPut` cannot simply be resolved at import time, and the
    // control for everything above: if this 500s, the fix has broken the state
    // it exists to support.
    expect((await owner.get('/api/posts')).status).toBe(200);
  });
});

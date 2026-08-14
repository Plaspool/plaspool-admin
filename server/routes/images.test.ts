/**
 * The media routes, end to end (spec §5.4).
 *
 * R2 IS STUBBED, AND ONLY R2. Every one of its six operations needs a network
 * and a bucket; the database is real (PGlite), the router, the origin guard, the
 * session middleware and the error handler are real, and the magic-byte reader
 * is real — the stub hands it genuine PNG/GIF/JPEG bytes built in-test, so what
 * is being asserted is the actual sniffing decision and not a mock of one.
 *
 * WHAT THESE TESTS ARE BUILT TO CATCH. The previous round of this project was
 * mutation-tested and every CAS precondition turned out to be satisfied by a JS
 * pre-check, so removing the SQL guard broke nothing. The cross-writer cases
 * here therefore assert on the STORED ROW and on whether R2 was asked to delete
 * anything, not merely on the status code: a stranger's commit must leave the
 * row unclaimed and the object untouched, which is a claim no status code makes
 * on its own. `server/repo/images.test.ts` holds the same predicates at the
 * statement level, where nothing else could possibly be doing the refusing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { SEED_PASSWORD, freshDb, type TestCtx } from '../test/harness';
import { httpClient, json, type HttpClient } from '../test/http';
import { QUARANTINE_MS, SLOT_TTL_MS, getImage } from '../repo/images';
import type { AuthUser, DocNode } from '../../shared/types';

/**
 * The stub's state, hoisted so `vi.mock`'s factory — which vitest lifts above
 * every import — can close over it.
 */
const r2 = vi.hoisted(() => ({
  /** What a ranged GET hands back, i.e. what the object actually is. */
  bytes: new Uint8Array() as Uint8Array,
  /** What `headObject` reports, or `null` for "the client never uploaded". */
  size: null as number | null,
  deleted: [] as string[],
  signed: [] as string[],
}));

/*
 * `importOriginal` rather than a bare factory, so `R2NotConfiguredError` is the
 * REAL class. The slot route distinguishes "this deployment has no media
 * storage" from "signing failed" with an `instanceof`, and a stubbed-out or
 * absent error class would make that test pass against a route that could not
 * tell them apart in production.
 */
vi.mock('../storage/r2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../storage/r2')>()),
  PRESIGN_TTL_SECONDS: 300,
  presignPut: vi.fn(async (key: string, contentType: string, byteSize: number) => ({
    url: `https://r2.test/${key}?put`,
    headers: { 'Content-Type': contentType, 'Content-Length': String(byteSize) },
    expiresIn: 300,
  })),
  presignGet: vi.fn(async (key: string) => {
    r2.signed.push(key);
    return `https://r2.test/${key}?get`;
  }),
  headObject: vi.fn(async () =>
    r2.size === null ? null : { contentLength: r2.size, contentType: null, etag: null },
  ),
  getRange: vi.fn(async () => r2.bytes),
  deleteObject: vi.fn(async (key: string) => {
    r2.deleted.push(key);
  }),
}));

// --------------------------------------------------------------- fixtures

/** A real PNG header: signature, then an IHDR carrying the dimensions. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

/** A real GIF87a header — used as the bytes that contradict a PNG claim. */
function gif(): Uint8Array {
  const bytes = new Uint8Array(10);
  bytes.set([...'GIF87a'].map((ch) => ch.charCodeAt(0)), 0);
  bytes.set([0x10, 0x00, 0x10, 0x00], 6);
  return bytes;
}

/**
 * A JPEG whose FIRST segment is an APP1 carrying `Exif\0\0` — i.e. one the
 * client's canvas re-encode did not strip.
 */
function jpegWithExif(): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10], 0);
  bytes.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 6); // 'Exif\0\0'
  return bytes;
}

/** The same shape without the APP1: a JPEG that passes. */
function jpegClean(): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x10], 0);
  // EOI, immediately after the DQT this declares. Required (Task 15): the Exif
  // check is tri-state, and a segment table that simply stops is `unknown`,
  // not `absent` — a JPEG whose APP1 lies beyond the fetched prefix must not
  // be admitted as clean. A fixture with no terminator is that case.
  bytes.set([0xff, 0xd9], 20);
  return bytes;
}

// ------------------------------------------------------------------ set-up

let ctx: TestCtx;
let owner: HttpClient;
let writer: HttpClient;
let anon: HttpClient;

async function login(user: AuthUser): Promise<HttpClient> {
  const c = httpClient(ctx.db);
  const res = await c.post('/api/auth/login', {
    email: user.email,
    password: SEED_PASSWORD,
  });
  expect(res.status).toBe(200);
  return c;
}

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM images`);
  await ctx.db.execute(sql`DELETE FROM posts`);
  await ctx.db.execute(sql`DELETE FROM auth_attempts`);
  await ctx.db.execute(sql`DELETE FROM sessions`);
  r2.bytes = png(640, 480);
  r2.size = 24;
  r2.deleted = [];
  r2.signed = [];
  owner = await login(ctx.users.owner);
  writer = await login(ctx.users.writer);
  anon = httpClient(ctx.db);
});

/**
 * Run `body` with `presignPut` failing, then put the stub back exactly as it
 * was.
 *
 * `mockReset()` would leave a `vi.fn()` returning `undefined` for every later
 * test in the file, which is a way to make the NEXT suite fail for a reason
 * that has nothing to do with it.
 */
async function withPresignFailure(error: Error, body: () => Promise<void>): Promise<void> {
  const { presignPut } = await import('../storage/r2');
  const original = vi.mocked(presignPut).getMockImplementation();
  vi.mocked(presignPut).mockRejectedValue(error);
  try {
    await body();
  } finally {
    if (original) vi.mocked(presignPut).mockImplementation(original);
  }
}

interface Slot {
  id: string;
  uploadUrl: string;
  headers: Record<string, string>;
}

async function slot(
  c: HttpClient,
  body: Record<string, unknown> = { contentType: 'image/png', byteSize: 24 },
): Promise<Slot> {
  const res = await c.post('/api/images', body);
  expect(res.status).toBe(201);
  return json<Slot>(res);
}

// ------------------------------------------------------------- POST /images

describe('POST /api/images', () => {
  it('401s without a session', async () => {
    const res = await anon.post('/api/images', { contentType: 'image/png', byteSize: 1 });
    expect(res.status).toBe(401);
  });

  it('returns an id, a signed PUT and the exact headers the URL binds', async () => {
    const body = await slot(owner);
    expect(body.id).toMatch(/^img_/);
    expect(body.uploadUrl).toContain(`images/${ctx.users.owner.id}/${body.id}`);
    // Returned rather than left to the client to reconstruct: these are inputs
    // to the signature, so a byte's difference is a 403 from R2.
    expect(body.headers).toEqual({ 'Content-Type': 'image/png', 'Content-Length': '24' });

    const stored = await getImage(ctx.db, body.id);
    expect(stored?.ownerId).toBe(ctx.users.owner.id);
    expect(stored?.committedAt).toBeNull();
    expect(stored?.width).toBeNull();
  });

  it('rejects a disallowed content type and an oversized byteSize before presigning', async () => {
    for (const body of [
      { contentType: 'text/html', byteSize: 10 },
      { contentType: 'image/svg+xml', byteSize: 10 },
      { contentType: 'image/png', byteSize: 12 * 1024 * 1024 + 1 },
      { contentType: 'image/png', byteSize: 0 },
    ]) {
      const res = await owner.post('/api/images', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const rows = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM images`);
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  it('refuses an unknown body key rather than ignoring it', async () => {
    const res = await owner.post('/api/images', {
      contentType: 'image/png',
      byteSize: 10,
      ownerId: ctx.users.writer.id,
    });
    expect(res.status).toBe(400);
  });

  it('caps open slots, through the statement rather than around it', async () => {
    for (let i = 0; i < 10; i += 1) await slot(owner);
    const res = await owner.post('/api/images', { contentType: 'image/png', byteSize: 24 });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'slots' });
  });

  it('leaves NO row behind when signing fails, however many times it is retried', async () => {
    /*
     * THE SEAM DEFECT, and it needed four correct-looking decisions to appear.
     * The row is inserted before the URL is signed (right); a deployment with
     * no R2 configuration boots and is supported (right); `presignPut` throws
     * there (right); a 500 is retried five times by spec §8's client (right).
     * Together: every retry inserted a row and removed none, so eleven attempts
     * filled MAX_OPEN_SLOTS and the writer was locked out with 400 `slots` for
     * a day — including after ops fixed the configuration.
     *
     * Twelve attempts is the critic's repro. The count staying at zero is the
     * assertion; a status that stops the retry is the test below.
     */
    const { R2NotConfiguredError } = await import('../storage/r2');
    await withPresignFailure(
      new R2NotConfiguredError(['R2_ACCOUNT_ID', 'R2_BUCKET']),
      async () => {
        for (let i = 0; i < 12; i += 1) {
          const res = await owner.post('/api/images', {
            contentType: 'image/png',
            byteSize: 24,
          });
          // Never 'slots': the writer's quota is not consumed by a server fault.
          expect(await json(res)).toMatchObject({ detail: 'storage' });
        }
        const rows = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM images`);
        expect(Number(rows.rows[0].n)).toBe(0);
      },
    );
  });

  it('answers a missing media configuration with a status that STOPS the retry', async () => {
    /*
     * 400 and not 500, for the reason `server/middleware/errors.ts` states at
     * the top: spec §8's client treats 5xx as transient and re-asks five times
     * over ~30 seconds, and a deployment's missing R2 variables do not appear
     * during those 30 seconds. `detail` names what failed and nothing else —
     * `R2NotConfiguredError` knows which variables are missing and that is
     * operational detail, not something to hand an authenticated writer.
     */
    const { R2NotConfiguredError } = await import('../storage/r2');
    await withPresignFailure(new R2NotConfiguredError(['R2_BUCKET']), async () => {
      const res = await owner.post('/api/images', {
        contentType: 'image/png',
        byteSize: 24,
      });
      expect(res.status).toBe(400);
      const body = await json<Record<string, unknown>>(res);
      expect(body).toMatchObject({ error: 'bad_request', detail: 'storage' });
      // And it names no variable, no bucket and no account id.
      expect(JSON.stringify(body)).not.toMatch(/R2_/);
    });
  });

  it('a transient signing failure stays a 500 — and still leaves no row', async () => {
    /*
     * The other half of the decision. An outage IS plausibly transient, so it
     * keeps the status spec §8's policy retries; what changed is that the
     * retry is now free, because the compensating delete ran either way.
     */
    await withPresignFailure(new Error('socket hang up'), async () => {
      const res = await owner.post('/api/images', {
        contentType: 'image/png',
        byteSize: 24,
      });
      expect(res.status).toBe(500);
      const rows = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM images`);
      expect(Number(rows.rows[0].n)).toBe(0);
    });
  });

  it('the compensating delete removes THAT row and no other', async () => {
    /*
     * A compensation is a DELETE on an error path — the path least likely to be
     * exercised and the easiest place to write something a little too broad.
     * "Clean up my unclaimed slots" and "delete the row this request created"
     * look the same in the only case anyone tests by hand, and differ here: a
     * writer with a healthy open slot and a second request that fails to sign
     * must not lose the first one, and a stranger's committed image must not be
     * touched at all. `deleteUnclaimedImage` carries `id AND owner_id AND
     * committed_at IS NULL`, and `server/repo/images.test.ts` pins each half of
     * that predicate at the statement level.
     */
    const mine = await slot(owner);
    const theirs = await slot(writer);
    await writer.post(`/api/images/${theirs.id}/commit`);

    const { R2NotConfiguredError } = await import('../storage/r2');
    await withPresignFailure(new R2NotConfiguredError(['R2_BUCKET']), async () => {
      const res = await owner.post('/api/images', {
        contentType: 'image/png',
        byteSize: 24,
      });
      expect(res.status).toBe(400);
    });

    expect(await getImage(ctx.db, mine.id)).not.toBeNull();
    expect((await getImage(ctx.db, theirs.id))?.committedAt).not.toBeNull();
    // Exactly the two pre-existing rows: the failed request's own row is gone.
    const rows = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM images`);
    expect(Number(rows.rows[0].n)).toBe(2);
  });

  it('is rate-limited by the Postgres limiter, not by module memory', async () => {
    /*
     * The counter is seeded directly rather than by making 120 requests: the
     * point under test is that the limit is read from `auth_attempts`, which is
     * the only bucket a second serverless instance can see. A second app object
     * over the same database is used to make exactly that visible — an
     * in-process counter would give this request a fresh allowance.
     */
    const window = 60 * 60_000;
    await ctx.db.execute(sql`
      INSERT INTO auth_attempts (key, window_start, count)
      VALUES (${`images:${ctx.users.owner.id}`},
              ${Math.floor(Date.now() / window) * window}, 120)`);

    const res = await owner.post('/api/images', { contentType: 'image/png', byteSize: 24 });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    // And nothing was written: the limiter runs before the slot is minted.
    const rows = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM images`);
    expect(Number(rows.rows[0].n)).toBe(0);
  });
});

// --------------------------------------------------------------- commit

describe('POST /api/images/:id/commit', () => {
  it('401s without a session', async () => {
    const res = await anon.post('/api/images/img_x/commit');
    expect(res.status).toBe(401);
  });

  it('commits, and writes the dimensions read from the OBJECT', async () => {
    const created = await slot(owner);
    r2.bytes = png(800, 600);
    r2.size = 4096;

    const res = await owner.post(`/api/images/${created.id}/commit`);
    expect(res.status).toBe(200);
    const stored = await getImage(ctx.db, created.id);
    expect(stored?.width).toBe(800);
    expect(stored?.height).toBe(600);
    // Corrected from headObject, not the 24 the client declared at slot time.
    expect(stored?.byteSize).toBe(4096);
    expect(stored?.committedAt).not.toBeNull();
  });

  it('rejects magic bytes contradicting the declared type, and deletes the object', async () => {
    const created = await slot(owner);
    r2.bytes = gif(); // a real GIF, declared as a PNG

    const res = await owner.post(`/api/images/${created.id}/commit`);
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ detail: 'contentType' });
    // Row and object both gone — an object nothing points at is unreachable.
    expect(await getImage(ctx.db, created.id)).toBeNull();
    expect(r2.deleted).toEqual([`images/${ctx.users.owner.id}/${created.id}`]);
  });

  it('rejects bytes that are not an image at all', async () => {
    const created = await slot(owner);
    r2.bytes = new TextEncoder().encode('<!doctype html><script>');

    expect((await owner.post(`/api/images/${created.id}/commit`)).status).toBe(400);
    expect(await getImage(ctx.db, created.id)).toBeNull();
  });

  it('rejects a JPEG still carrying an Exif marker', async () => {
    const created = await slot(owner, { contentType: 'image/jpeg', byteSize: 24 });
    r2.bytes = jpegWithExif();

    const res = await owner.post(`/api/images/${created.id}/commit`);
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ detail: 'exif' });
    expect(await getImage(ctx.db, created.id)).toBeNull();
    expect(r2.deleted).toHaveLength(1);
  });

  it('accepts the same JPEG once the marker is gone', async () => {
    // The control for the test above: without it, a broken `hasExifMarker` that
    // returned `true` for everything would look correct.
    const created = await slot(owner, { contentType: 'image/jpeg', byteSize: 24 });
    r2.bytes = jpegClean();
    expect((await owner.post(`/api/images/${created.id}/commit`)).status).toBe(200);
    // A JPEG whose SOF is past the fetched prefix: unknown, never guessed.
    expect((await getImage(ctx.db, created.id))?.width).toBeNull();
  });

  it('is idempotent for the owner', async () => {
    const created = await slot(owner);
    r2.bytes = png(100, 50);
    expect((await owner.post(`/api/images/${created.id}/commit`)).status).toBe(200);

    // The object has since vanished from R2. A second commit must still be a
    // 200: idempotency that only holds while the bucket is healthy is not
    // idempotency.
    r2.size = null;
    const again = await owner.post(`/api/images/${created.id}/commit`);
    expect(again.status).toBe(200);
    expect(await json<{ image: { width: number } }>(again)).toMatchObject({
      image: { width: 100, height: 50 },
    });
    expect(r2.deleted).toEqual([]);
  });

  it("a writer cannot commit another writer's image", async () => {
    /*
     * Ids appear in `posts.content`, which every writer can read. The 404 is
     * only half the assertion — the row must be UNCLAIMED afterwards, which is
     * what says the `owner_id` predicate refused the UPDATE rather than the
     * response being decorated after a successful one.
     */
    const created = await slot(owner);
    const res = await writer.post(`/api/images/${created.id}/commit`);
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({ error: 'gone' });
    expect((await getImage(ctx.db, created.id))?.committedAt).toBeNull();
  });

  it("a writer cannot trigger reject-and-delete on another writer's upload", async () => {
    /*
     * THE SHARPEST CASE IN THIS FILE. The rejection path deletes a row and an
     * object, and it is reachable by anyone who can name an id. With the
     * identical owner + unclaimed predicate on the DELETE, a stranger uploading
     * nothing and pointing at somebody else's slot destroys neither.
     */
    const created = await slot(owner);
    r2.bytes = gif(); // would be a rejection if the caller owned it

    const res = await writer.post(`/api/images/${created.id}/commit`);
    expect(res.status).toBe(404);
    expect(await getImage(ctx.db, created.id)).not.toBeNull();
    expect(r2.deleted).toEqual([]);
  });

  it('404s for an id that does not exist', async () => {
    expect((await owner.post('/api/images/img_nope/commit')).status).toBe(404);
  });

  it('400s when the object was never uploaded', async () => {
    const created = await slot(owner);
    r2.size = null;
    const res = await owner.post(`/api/images/${created.id}/commit`);
    expect(res.status).toBe(400);
    // The row SURVIVES: the writer can retry the PUT until the slot ages out.
    expect(await getImage(ctx.db, created.id)).not.toBeNull();
  });

  it("gives a stranger the SAME answer for a real slot as for an id that does not exist", async () => {
    /*
     * THE EXISTENCE ORACLE. `headObject` used to run before any ownership
     * predicate, so a slot whose owner had not yet PUT the bytes answered a
     * stranger 400 {detail:'object'} while an unknown id answered 404
     * {error:'gone'} — two distinguishable answers for two conditions this
     * file says must be indistinguishable. Byte-for-byte equality of the two
     * bodies is the assertion, because "both are 4xx" was already true.
     */
    const created = await slot(owner);
    r2.size = null; // the owner never PUT anything

    const probe = await writer.post(`/api/images/${created.id}/commit`);
    const unknown = await writer.post('/api/images/img_does_not_exist/commit');
    expect(probe.status).toBe(unknown.status);
    expect(probe.status).toBe(404);
    const [a, b] = [await json<Record<string, unknown>>(probe), await json<Record<string, unknown>>(unknown)];
    delete a.requestId;
    delete b.requestId;
    expect(a).toEqual(b);
  });

  it('spends no R2 operation at all on a stranger\'s id', async () => {
    /*
     * The other half of the same defect: every stranger commit cost a
     * headObject plus a 64 KiB ranged GET against somebody else's key, before
     * anything had decided the caller had any business naming it.
     */
    const { headObject, getRange } = await import('../storage/r2');
    const created = await slot(owner);
    vi.mocked(headObject).mockClear();
    vi.mocked(getRange).mockClear();

    expect((await writer.post(`/api/images/${created.id}/commit`)).status).toBe(404);
    expect(headObject).not.toHaveBeenCalled();
    expect(getRange).not.toHaveBeenCalled();
  });

  it('is rate-limited by the Postgres limiter — it is the expensive route', async () => {
    /*
     * Two R2 round trips per call and, until this limit existed, no bound on
     * how many. The counter is seeded directly and the bucket is the one in
     * `auth_attempts`, which is the only counter a second serverless instance
     * can see; a module-level map would give this request a fresh allowance.
     */
    const created = await slot(owner);
    const window = 60 * 60_000;
    await ctx.db.execute(sql`
      INSERT INTO auth_attempts (key, window_start, count)
      VALUES (${`images:commit:${ctx.users.owner.id}`},
              ${Math.floor(Date.now() / window) * window}, 240)`);

    const { headObject } = await import('../storage/r2');
    vi.mocked(headObject).mockClear();
    const res = await owner.post(`/api/images/${created.id}/commit`);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    // The limiter runs BEFORE the bucket is touched, which is its whole job.
    expect(headObject).not.toHaveBeenCalled();
    expect((await getImage(ctx.db, created.id))?.committedAt).toBeNull();
  });

  it('400s `quota` when the REAL size crosses the ceiling, and keeps the bytes', async () => {
    /*
     * The slot declared one byte and 12 MB arrived. The INSERT weighed the
     * declaration, so only the commit predicate can catch this.
     */
    await ctx.db.execute(sql`
      INSERT INTO images (id, owner_id, storage_key, content_type, width, height,
                          byte_size, checksum, created_at, committed_at,
                          unreferenced_since)
      VALUES ('img_filler', ${ctx.users.owner.id}::uuid, 'images/filler',
              'image/png', NULL, NULL, ${1024 * 1024 * 1024 - 100}, NULL,
              ${Date.now()}, ${Date.now()}, NULL)`);
    const created = await slot(owner, { contentType: 'image/png', byteSize: 1 });
    r2.size = 5000;

    const res = await owner.post(`/api/images/${created.id}/commit`);
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'quota' });
    // The row survives UNCLAIMED and the object is NOT deleted: the writer can
    // free space and commit again, and `sweepUncommitted` reclaims both after
    // 24h if they never do.
    expect((await getImage(ctx.db, created.id))?.committedAt).toBeNull();
    expect(r2.deleted).toEqual([]);
  });

  it('rejects an object larger than the ceiling, whatever the slot declared', async () => {
    const created = await slot(owner);
    r2.size = 12 * 1024 * 1024 + 1;
    expect((await owner.post(`/api/images/${created.id}/commit`)).status).toBe(400);
    expect(await getImage(ctx.db, created.id)).toBeNull();
  });
});

// ------------------------------------------------------------ GET /images/:id

describe('GET /api/images/:id', () => {
  it('401s without a session', async () => {
    expect((await anon.get('/api/images/img_x')).status).toBe(401);
  });

  it('302s to a signed URL once committed', async () => {
    const created = await slot(owner);
    await owner.post(`/api/images/${created.id}/commit`);

    const res = await owner.get(`/api/images/${created.id}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('?get');
    expect(r2.signed).toEqual([`images/${ctx.users.owner.id}/${created.id}`]);
    // A cached 302 outlives the five-minute credential inside it.
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('404s for an uncommitted image, whose bytes have never been looked at', async () => {
    const created = await slot(owner);
    const res = await owner.get(`/api/images/${created.id}`);
    expect(res.status).toBe(404);
    expect(r2.signed).toEqual([]);
  });

  it('serves another writer\'s committed image — reads are universal (spec §6)', async () => {
    const created = await slot(owner);
    await owner.post(`/api/images/${created.id}/commit`);
    expect((await writer.get(`/api/images/${created.id}`)).status).toBe(302);
  });
});

// --------------------------------------------------------------- maintenance

describe('POST /api/images/collect-orphans', () => {
  const ancient = () => Date.now() - 10 * SLOT_TTL_MS;

  async function seedImage(
    id: string,
    over: { committedAt?: number | null; createdAt?: number; unreferencedSince?: number | null } = {},
  ): Promise<void> {
    const createdAt = over.createdAt ?? ancient();
    await ctx.db.execute(sql`
      INSERT INTO images (id, owner_id, storage_key, content_type, width, height,
                          byte_size, checksum, created_at, committed_at,
                          unreferenced_since)
      VALUES (${id}, ${ctx.users.owner.id}::uuid,
              ${`images/${ctx.users.owner.id}/${id}`}, 'image/png', NULL, NULL,
              10, NULL, ${createdAt},
              ${over.committedAt === undefined ? createdAt : over.committedAt},
              ${over.unreferencedSince ?? null})`);
  }

  it('is owner only', async () => {
    expect((await writer.post('/api/images/collect-orphans')).status).toBe(403);
    expect((await anon.post('/api/images/collect-orphans')).status).toBe(401);
  });

  it('collects a quarantined orphan and asks R2 to drop its object', async () => {
    await seedImage('img_gone', { unreferencedSince: Date.now() - 2 * QUARANTINE_MS });
    const res = await owner.post('/api/images/collect-orphans');
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ collected: 1 });
    expect(await getImage(ctx.db, 'img_gone')).toBeNull();
    // AFTER the row, and best-effort (rule 6).
    expect(r2.deleted).toEqual([`images/${ctx.users.owner.id}/img_gone`]);
  });

  it('does not collect an image a live post still points at', async () => {
    await seedImage('img_used', { unreferencedSince: Date.now() - 2 * QUARANTINE_MS });
    const post = await json<{ post: { id: string } }>(
      await owner.post('/api/posts', { title: 'With an image' }),
    );
    await ctx.db.execute(sql`
      UPDATE posts SET content = ${JSON.stringify({
        type: 'doc',
        content: [{ type: 'image', attrs: { src: 'asset:img_used' } }],
      } satisfies DocNode)}::jsonb WHERE id = ${post.post.id}`);

    const res = await owner.post('/api/images/collect-orphans');
    expect(await json(res)).toMatchObject({ collected: 0 });
    expect(await getImage(ctx.db, 'img_used')).not.toBeNull();
    expect(r2.deleted).toEqual([]);
  });

  it('does not collect an image that only just went unreferenced', async () => {
    // No `unreferenced_since` yet: this run stamps one, and stamping is not
    // collecting. The single-pass implementation everyone writes first deletes
    // it here.
    await seedImage('img_new_orphan');
    const res = await owner.post('/api/images/collect-orphans');
    expect(await json(res)).toMatchObject({ collected: 0, unreferenced: 1 });
    expect(await getImage(ctx.db, 'img_new_orphan')).not.toBeNull();
  });

  it('sweeps abandoned slots in the same call, since there is no cron', async () => {
    await seedImage('img_abandoned', {
      createdAt: Date.now() - SLOT_TTL_MS - 60_000,
      committedAt: null,
    });
    await seedImage('img_open', { createdAt: Date.now(), committedAt: null });

    const res = await owner.post('/api/images/collect-orphans');
    expect(await json(res)).toMatchObject({ swept: 1 });
    expect(await getImage(ctx.db, 'img_abandoned')).toBeNull();
    expect(await getImage(ctx.db, 'img_open')).not.toBeNull();
    expect(r2.deleted).toEqual([`images/${ctx.users.owner.id}/img_abandoned`]);
  });

  it('collects nothing at all while any document is unwalkable', async () => {
    await seedImage('img_gone', { unreferencedSince: Date.now() - 2 * QUARANTINE_MS });
    const post = await json<{ post: { id: string } }>(
      await owner.post('/api/posts', { title: 'Imported' }),
    );
    // Nested, not top level: the top level is a healthy object, which is why a
    // column-level guard sees nothing wrong here.
    await ctx.db.execute(sql`
      UPDATE posts SET content = ${JSON.stringify({
        type: 'doc',
        content: [{ type: 'section', content: [{ type: 'weird', content: 'oops' }] }],
      })}::jsonb WHERE id = ${post.post.id}`);

    const res = await owner.post('/api/images/collect-orphans');
    expect(await json(res)).toMatchObject({ collected: 0 });
    expect(await getImage(ctx.db, 'img_gone')).not.toBeNull();
    expect(r2.deleted).toEqual([]);
  });

  it('SAYS it is blocked, and names the document to fix', async () => {
    /*
     * The fail-safe direction is right and stays. What was wrong is that this
     * answered `{collected: 0}` — exactly what a healthy store with nothing to
     * collect answers — so a deployment whose collection had been dead for
     * months looked identical to one with nothing to do, and the owner had no
     * way to find the row.
     */
    await seedImage('img_gone', { unreferencedSince: Date.now() - 2 * QUARANTINE_MS });
    const post = await json<{ post: { id: string } }>(
      await owner.post('/api/posts', { title: 'Imported' }),
    );
    await ctx.db.execute(sql`
      UPDATE posts SET content = ${JSON.stringify({
        type: 'doc',
        content: [{ type: 'section', content: [{ type: 'weird', content: 'oops' }] }],
      })}::jsonb WHERE id = ${post.post.id}`);

    const body = await json<{ blocked: boolean; blockedBy: unknown[] }>(
      await owner.post('/api/images/collect-orphans'),
    );
    expect(body.blocked).toBe(true);
    expect(body.blockedBy).toContainEqual({ source: 'post', id: post.post.id });
  });

  it('a single "content": null does NOT block collection', async () => {
    // `node -> 'content' IS NOT NULL` is TRUE for a JSON null, so one of these
    // anywhere in the store halted every sweep, silently and forever.
    await seedImage('img_gone', { unreferencedSince: Date.now() - 2 * QUARANTINE_MS });
    const post = await json<{ post: { id: string } }>(
      await owner.post('/api/posts', { title: 'Nulled' }),
    );
    await ctx.db.execute(sql`
      UPDATE posts SET content = ${JSON.stringify({
        type: 'doc',
        content: [{ type: 'paragraph', content: null }],
      })}::jsonb WHERE id = ${post.post.id}`);

    const body = await json<{ collected: number; blocked: boolean }>(
      await owner.post('/api/images/collect-orphans'),
    );
    expect(body.blocked).toBe(false);
    expect(body.collected).toBe(1);
  });

  it('reports blocked: false and an empty list on a healthy store', async () => {
    const body = await json(await owner.post('/api/images/collect-orphans'));
    expect(body).toMatchObject({ blocked: false, blockedBy: [] });
  });

  it('accounts for every image it destroyed, by id and by size', async () => {
    /*
     * A writer who commits an image and never places it in a document loses
     * the bytes 48 hours later. The row is gone by the time this response is
     * rendered, so this response is the only record that it ever existed.
     */
    await seedImage('img_gone', { unreferencedSince: Date.now() - 2 * QUARANTINE_MS });
    const body = await json<{ collectedImages: Record<string, unknown>[] }>(
      await owner.post('/api/images/collect-orphans'),
    );
    expect(body.collectedImages).toEqual([
      {
        id: 'img_gone',
        ownerId: ctx.users.owner.id,
        byteSize: 10,
        unreferencedSince: expect.any(Number),
      },
    ]);
  });

  it('previews without deleting anything when dryRun is asked for', async () => {
    await seedImage('img_gone', { unreferencedSince: Date.now() - 2 * QUARANTINE_MS });
    await seedImage('img_abandoned', {
      createdAt: Date.now() - SLOT_TTL_MS - 60_000,
      committedAt: null,
    });

    const body = await json<{
      dryRun: boolean;
      collected: number;
      collectedImages: { id: string }[];
      swept: number;
    }>(await owner.post('/api/images/collect-orphans?dryRun=1'));
    expect(body.dryRun).toBe(true);
    expect(body.collectedImages.map((i) => i.id)).toEqual(['img_gone']);
    expect(body.swept).toBe(1);

    // NOTHING happened: not the delete, not the object, and not the mark
    // either — a preview that stamped the quarantine clock would bring every
    // image it listed a day closer to deletion.
    expect(await getImage(ctx.db, 'img_gone')).not.toBeNull();
    expect(await getImage(ctx.db, 'img_abandoned')).not.toBeNull();
    expect(r2.deleted).toEqual([]);
    const fresh = await getImage(ctx.db, 'img_abandoned');
    expect(fresh?.unreferencedSince).toBeNull();

    // And the real run then takes exactly what the preview promised.
    const real = await json<{ collectedImages: { id: string }[] }>(
      await owner.post('/api/images/collect-orphans'),
    );
    expect(real.collectedImages.map((i) => i.id)).toEqual(['img_gone']);
  });

  it('the dry run is owner-only too', async () => {
    expect((await writer.post('/api/images/collect-orphans?dryRun=1')).status).toBe(403);
  });
});

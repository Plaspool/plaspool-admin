import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { pathParam, readJson, readQuery, str } from '../middleware/errors';
import { requireAuth, requireOwner } from '../middleware/session';
import { limit } from '../middleware/ratelimit';
import { BadRequestError, NotFoundError } from '../repo/errors';
import {
  ALLOWED_CONTENT_TYPES,
  MAX_IMAGE_BYTES,
  collectOrphans,
  commitImage,
  createSlot,
  deleteUnclaimedImage,
  findUnwalkableDocs,
  getImage,
  getOwnedImage,
  markUnreferenced,
  previewOrphans,
  sweepUncommitted,
} from '../repo/images';
import type { CollectedImage, ImageRow, SweptObject } from '../repo/images';
import {
  R2NotConfiguredError,
  deleteObject,
  getRange,
  headObject,
  presignGet,
  presignPut,
} from '../storage/r2';
import { exifMarkerState, readDimensions, sniffImageType } from '../storage/magic';
import type { ImageType } from '../storage/magic';
import { currentDb, currentUser } from '../app-env';
import type { AppEnv } from '../app-env';
import type { Db } from '../db/client';

/**
 * Media (spec §5.4).
 *
 * THE FLOW, AND THE THING IT IS BUILT AROUND: the client asks for a slot, PUTs
 * the bytes straight to R2, then commits. The bytes never pass through this
 * server, so the ONLY moment it can look at them is commit — which is why
 * commit is where the declared `Content-Type` stops being believed and
 * `sniffImageType` decides what the object actually is.
 *
 * FOUR PROPERTIES CARRY THIS FILE.
 *
 * **Commit is scoped to the owner and to the unclaimed state, in the SQL.**
 * Image ids appear in `posts.content`, which every writer can read. Nothing here
 * pre-checks ownership in TypeScript — the CAS's zero rows IS the refusal, and
 * the follow-up read only says whether zero rows meant "already yours and
 * already done" (200) or "not yours" (404).
 *
 * **The rejection path carries the identical predicate.** "These bytes are not
 * a PNG" deletes a row and an object, so reaching it with a weaker scope would
 * make it a way to destroy another writer's in-flight upload by naming an id.
 * The object is deleted only when the row delete actually removed a row.
 *
 * **Nothing here is a cron.** This deployment has none — `vercel.json` carries
 * no `crons` key — so the two sweeps spec §5.4 requires are an owner-only route,
 * called from the dashboard. A sweep that exists only as a function nobody calls
 * is a table that grows forever.
 *
 * **R2 failures on the housekeeping paths are swallowed.** A leaked object costs
 * storage; a sweep that aborts halfway through because one `DELETE` 503'd leaves
 * the database and the bucket disagreeing with nobody to reconcile them.
 */
export const routes = new Hono<AppEnv>();

const auth = requireAuth();

/**
 * `POST /api/images`, per user, per hour.
 *
 * THROUGH THE POSTGRES LIMITER (`auth_attempts`), not an in-process counter:
 * serverless instances share no memory, so a module-level map bounds one warm
 * instance and nothing that adds concurrency or survives a cold start.
 *
 * The number is a choice, not a spec value. `MAX_OPEN_SLOTS` already bounds how
 * many slots can be open at once, but nothing bounds the RATE at which a client
 * commits and re-opens them, and each slot issue is a signature operation plus
 * two statements. Generous for a writer pasting a photo essay, useless as a
 * loop.
 */
export const IMAGE_SLOT_LIMIT = 120;
export const IMAGE_SLOT_WINDOW_MS = 60 * 60_000;

/**
 * `POST /api/images/:id/commit`, per user, per hour — THE MORE EXPENSIVE OF THE
 * TWO, and for a long time the only one that was not limited.
 *
 * A slot issue costs a signature and two statements. A commit costs TWO R2 ROUND
 * TRIPS: a `headObject` and a 64 KiB ranged GET (`SNIFF_BYTES`). Measured before
 * this limit existed, 300 sequential commits against one slot id produced 600 R2
 * operations and roughly 19 MB of egress, and nothing in the app bounded the
 * next 300. Resolving ownership before touching R2 (see the handler) took the
 * stranger's version of that away; it did not bound the OWNER's, which is the
 * loop this number is for.
 *
 * Higher than the slot limit rather than lower: a commit legitimately gets
 * retried — the writer's PUT was still in flight, the network dropped the
 * response — so a limit at the slot ceiling would punish the honest retry.
 * Through the Postgres limiter for the same reason as everything else here:
 * serverless instances share no memory.
 */
export const IMAGE_COMMIT_LIMIT = 240;
export const IMAGE_COMMIT_WINDOW_MS = 60 * 60_000;

/**
 * How much of the object commit pulls back to identify it.
 *
 * 64 KiB, which is `readDimensions`' documented recommendation: it covers
 * GIF/PNG/WebP outright and the overwhelming majority of real JPEG and AVIF
 * headers. The residue surfaces as a NULL dimension, never as a wrong number,
 * and never as a rejected upload — an image whose header sits past 64 KiB is
 * still a valid image and refusing it would be a worse answer than storing
 * `width IS NULL`.
 */
export const SNIFF_BYTES = 64 * 1024;

const SlotBody = z
  .object({
    contentType: str().min(1).max(100),
    byteSize: z.number().int(),
    /**
     * SHA-256 hex, for content addressing later. Never trusted, and NOTHING
     * READS IT TODAY — not commit, not the sweeps. It is stored so the column
     * is populated when something does; it verifies nothing at present.
     */
    checksum: str().max(200).nullable().optional(),
  })
  .strict();

/**
 * What a slot looks like on the wire. `id` is what the client writes into the
 * document as `asset:<id>`; `uploadUrl` and `headers` must be used exactly as
 * given or R2 answers 403 — both values are inputs to the signature.
 */
routes.post('/images', auth, async (c) => {
  const db = currentDb(c);
  const user = currentUser(c);
  /*
   * RATE LIMIT FIRST, before the body is parsed and long before anything is
   * signed. The limiter's job is to make the expensive part unreachable, and a
   * limiter that ran after the insert would be counting requests it had already
   * granted.
   */
  await limit(c, `images:${user.id}`, IMAGE_SLOT_LIMIT, IMAGE_SLOT_WINDOW_MS);

  const body = await readJson(c, SlotBody);
  const image = await createSlot(db, user, {
    contentType: body.contentType,
    byteSize: body.byteSize,
    checksum: body.checksum ?? null,
  });

  /*
   * THE ROW EXISTS BEFORE THE URL DOES, and that ordering is deliberate.
   *
   * A signature minted before the row would authorise a write to a key nothing
   * in the database has ever heard of — an object with no owner, no size and no
   * sweep that will ever find it. This way round, a signing failure leaves an
   * uncommitted row instead.
   *
   * WHICH IS WHY IT IS COMPENSATED. "`sweepUncommitted` removes it after 24
   * hours" was the wrong answer, and the interaction that proved it: an
   * instance deployed with no R2 configuration is a SUPPORTED state
   * (`server/storage/r2.ts` says so, and every R2 var is `.default('')` so the
   * app boots without them), `presignPut` throws `R2NotConfiguredError` there,
   * and the response was a 500 — which spec §8's client retries five times.
   * Each retry inserted another row and removed none, so eleven attempts filled
   * `MAX_OPEN_SLOTS` and the writer was answered 400 `slots` for the next 24
   * HOURS, including after ops had fixed the configuration. The writer's own
   * retry policy burned their upload quota over a server misconfiguration.
   */
  const put = await presignSlot(db, user.id, image);
  return c.json(
    {
      id: image.id,
      uploadUrl: put.url,
      headers: put.headers,
      expiresIn: put.expiresIn,
    },
    201,
  );
});

/**
 * Sign the PUT, or undo the row and answer with a status that is honest about
 * whether trying again can help.
 *
 * THE COMPENSATING DELETE CARRIES THE OWNER AND UNCLAIMED PREDICATE, through
 * `deleteUnclaimedImage`, exactly like the rejection path at commit. The id was
 * minted three statements ago and nobody else can have seen it, so this looks
 * like a place where an unscoped `DELETE ... WHERE id = $1` would be
 * equivalent — it is not, and the reason is that "equivalent today" is how the
 * rejection path would have been written too. A compensating delete is a delete
 * on an error path, i.e. the path least likely to be exercised and most likely
 * to be reached later with an id that came from somewhere else. It gets the
 * same predicate as every other statement in this file.
 *
 * THE TWO FAILURES ARE NOT THE SAME FAILURE, and collapsing them into 500 is
 * what made the retry harmful:
 *
 * - `R2NotConfiguredError` is a deployment that has no media storage. Nothing
 *   about it changes within the 30 seconds of the client's five attempts, so it
 *   is a 400 with `detail: 'storage'` — the same reasoning `server/middleware/
 *   errors.ts` states at the top of the file and the same one `createSlot` uses
 *   for `slots` and `quota`: a condition that is permanent for this request must
 *   be a 4xx, because a 500 is transient by spec §8's policy and would be
 *   re-asked five times for an answer that cannot change. `detail` names the
 *   thing that failed and never why — the missing variable NAMES are
 *   operational detail an authenticated writer has no use for and an attacker
 *   would enjoy, and `R2NotConfiguredError` deliberately carries no values.
 * - Anything else — a signing library fault, an outage, a DNS failure — IS
 *   plausibly transient, so it is rethrown and becomes the ordinary 500 that
 *   spec §8's policy retries. That retry is now free: the row is already gone.
 *
 * If the compensation itself fails, the ORIGINAL error still surfaces. A
 * database that cannot delete is not going to be explained better by a second
 * error thrown on top of the first, and `sweepUncommitted` remains the backstop
 * for the row it left behind.
 */
async function presignSlot(
  db: Db,
  ownerId: string,
  image: ImageRow,
): Promise<{ url: string; headers: Record<string, string>; expiresIn: number }> {
  try {
    return await presignPut(image.storageKey, image.contentType, image.byteSize);
  } catch (err) {
    await deleteUnclaimedImage(db, ownerId, image.id).catch(() => undefined);
    if (err instanceof R2NotConfiguredError) throw new BadRequestError('storage');
    throw err;
  }
}

// ------------------------------------------------------------------ commit

/** The public shape of an image row. `storageKey` is never sent. */
function toWire(image: ImageRow): Record<string, unknown> {
  return {
    id: image.id,
    contentType: image.contentType,
    width: image.width,
    height: image.height,
    byteSize: image.byteSize,
    createdAt: image.createdAt,
    committedAt: image.committedAt,
  };
}

/**
 * Verify the bytes, or say why not.
 *
 * `null` means "these bytes are acceptable"; a string is the `detail` of the
 * 400 and the signal to reject-and-delete.
 */
function verify(bytes: Uint8Array, declared: string): { type: ImageType } | string {
  const sniffed = sniffImageType(bytes);
  if (sniffed === null) return 'contentType';
  /*
   * THE DECLARED TYPE MUST MATCH WHAT THE BYTES ARE, not merely be some allowed
   * type. The object is served back later under the STORED `Content-Type`, so a
   * GIF stored as `image/png` is a browser being handed a type its bytes
   * contradict — which is the sniffing confusion the whole check exists to
   * remove.
   */
  if (sniffed !== declared) return 'contentType';
  /*
   * Spec §5.4: the client strips EXIF by re-encoding through a canvas, and the
   * server ENFORCES that rather than trusting it — EXIF is where a phone writes
   * GPS coordinates, so a false negative publishes the writer's address.
   *
   * JPEG only, and that is a stated gap rather than a silent one: WebP (`EXIF`
   * RIFF chunk) and PNG (`eXIf`) also carry EXIF and are both in the allowed
   * list. `hasExifMarker` documents the same limit. Spec §5.4 asks for the JPEG
   * marker check and this is exactly that, no more.
   */
  /*
   * NOTE (Task 15): `hasExifMarker` became `exifMarkerState` and returns
   * `present | absent | unknown`. Only `absent` may be accepted. `unknown`
   * means the fetched prefix ended before the segment table did — a large ICC
   * profile ahead of the APP1 does it, and the uploader chooses the segment
   * order — and reading that as clean is how a photograph carrying GPS
   * coordinates gets published. Rejecting is the conservative side; a caller
   * that would rather refetch more bytes can distinguish the two states.
   */
  if (sniffed === 'image/jpeg' && exifMarkerState(bytes) !== 'absent') return 'exif';
  return { type: sniffed };
}

/**
 * Claim an upload.
 *
 * ORDER OF OPERATIONS, AND WHY IT IS THIS ONE:
 *
 * 1. Rate limit, before anything else — see `IMAGE_COMMIT_LIMIT`. This is the
 *    route with two R2 round trips in it, so the limiter's job is to make them
 *    unreachable rather than to count them after the fact.
 * 2. Read the row SCOPED TO THE CALLER, and 404 if there is none. This read is a
 *    lookup for the storage key AND the point at which a stranger stops, and the
 *    second half of that is not an optimisation.
 *
 *    IT USED TO BE UNSCOPED, and that was an existence oracle. An unknown id
 *    404s here; an id belonging to somebody else's in-flight slot reached
 *    `headObject` and came back 400 `{detail:'object'}` when the owner had not
 *    yet PUT the bytes. Two distinguishable answers for two conditions this
 *    file's own comment (below, on `idempotent`) says must be indistinguishable
 *    — so any writer could confirm the existence, and the upload state, of
 *    another writer's slot by naming an id read out of a document. It also made
 *    every stranger's request spend two R2 operations on somebody else's object.
 *
 *    THIS DOES NOT MOVE THE PERMISSION DECISION INTO TYPESCRIPT. The CAS and the
 *    reject-and-delete below still carry `owner_id` and `committed_at IS NULL`
 *    in their own predicates, and `server/repo/images.test.ts` calls both
 *    functions directly with a stranger's id — with no route and no pre-read in
 *    the path, so removing either half of either predicate still goes red there.
 *    What this read decides is whether to TOUCH R2 AT ALL; what the SQL decides
 *    is whether anything changes.
 * 3. If it is already committed, skip verification entirely and answer from the
 *    row already in hand. Re-fetching bytes would make a second commit fail for
 *    a reason unrelated to the caller — an object that has since been moved or
 *    expired — and idempotency that only holds while R2 is healthy is not
 *    idempotency.
 * 4. Fetch the head of the object and identify it.
 * 5. On rejection: the scoped DELETE, then the object, and only if the DELETE
 *    matched.
 * 6. On acceptance: the scoped CAS. Zero rows is classified, never assumed.
 */
routes.post('/images/:id/commit', auth, async (c) => {
  const db = currentDb(c);
  const user = currentUser(c);
  const id = pathParam(c, 'id');
  await limit(c, `images:commit:${user.id}`, IMAGE_COMMIT_LIMIT, IMAGE_COMMIT_WINDOW_MS);

  const image = await getOwnedImage(db, user.id, id);
  if (!image) throw new NotFoundError(id);

  if (image.committedAt !== null) return c.json({ image: toWire(image) });

  const head = await headObject(image.storageKey);
  // The client never uploaded, or uploaded somewhere else. An ordinary outcome
  // with a 4xx answer, not an error: the row stays, and the writer can retry
  // the PUT until the slot ages out.
  if (!head) throw new BadRequestError('object');

  /*
   * THE SIZE IS RE-READ FROM THE OBJECT AND RE-CHECKED.
   *
   * The presigned PUT binds `content-length`, so R2 itself refuses a different
   * size — but that is a claim about a code path in somebody else's service,
   * and `byte_size` is what the per-user quota is computed from. Cheap to
   * verify here; unbounded if the binding ever regresses.
   */
  const size = head.contentLength ?? 0;
  if (size <= 0 || size > MAX_IMAGE_BYTES) {
    return reject(c, db, user.id, id, image.storageKey, 'byteSize');
  }

  const bytes = await getRange(image.storageKey, SNIFF_BYTES);
  if (!bytes) throw new BadRequestError('object');

  const verdict = verify(bytes, image.contentType);
  if (typeof verdict === 'string') {
    return reject(c, db, user.id, id, image.storageKey, verdict);
  }

  const dimensions = readDimensions(bytes, verdict.type);
  const committed = await commitImage(db, user.id, id, {
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    byteSize: size,
  });
  if (committed) return c.json({ image: toWire(committed) });

  /*
   * The CAS matched nothing, and it says nothing about WHY. Three conditions
   * produce the same zero rows and they need three different answers.
   */
  return classifyRefusal(c, db, user.id, id);
});

/**
 * A commit that changed nothing, told apart by a scoped read AFTER the fact.
 *
 * The caller's ownership was established before R2 was touched, so by the time
 * this runs the possibilities are:
 *
 * - the row is gone or is no longer the caller's → 404, the same answer an
 *   absent image gets, deliberately (spec §8): a writer probing ids must not be
 *   able to tell "no such image" from "someone else's image" from "someone
 *   else's UNCOMMITTED image";
 * - it is committed → a concurrent commit won the race; 200, which is what
 *   idempotency means here;
 * - it is still UNCLAIMED → the only remaining half of the CAS is the byte
 *   quota, so this is a full account. 400 `quota` and not a 500: it is
 *   permanent until the writer frees space, and spec §8's client retries a 5xx
 *   five times for something that cannot succeed.
 *
 * The bytes are left in the bucket on the quota answer — see `commitImage` for
 * why, and for what removes them if the writer never comes back.
 */
async function classifyRefusal(
  c: Context<AppEnv>,
  db: Db,
  ownerId: string,
  id: string,
): Promise<Response> {
  const owned = await getOwnedImage(db, ownerId, id);
  if (!owned) throw new NotFoundError(id);
  if (owned.committedAt === null) throw new BadRequestError('quota');
  return c.json({ image: toWire(owned) });
}

/**
 * Reject-and-delete, with the SAME owner + unclaimed predicate as the commit.
 *
 * The object is removed only when the row delete matched, so a stranger naming
 * somebody else's id destroys neither. Best-effort on the R2 side and after the
 * row: the row is the thing that makes the object findable, so a leaked object
 * is recoverable bookkeeping and a leaked row is a broken image.
 */
async function reject(
  c: Context<AppEnv>,
  db: Db,
  ownerId: string,
  id: string,
  storageKey: string,
  detail: string,
): Promise<Response> {
  const removed = await deleteUnclaimedImage(db, ownerId, id);
  if (!removed) throw new NotFoundError(id);
  await deleteObject(storageKey).catch(() => undefined);
  throw new BadRequestError(detail);
}

// -------------------------------------------------------------------- read

/**
 * 302 to a five-minute signed GET.
 *
 * A REDIRECT AND NOT A PROXY: streaming a 12 MB object through a serverless
 * function costs its memory ceiling and its timeout, for bytes a CDN is built
 * to serve.
 *
 * An UNCOMMITTED image is a 404 and not a redirect. Its bytes have never been
 * looked at — the magic-byte check happens at commit — so serving one under its
 * declared `Content-Type` would be serving whatever the uploader chose to call
 * a PNG, which is the entire hazard the commit check exists to close.
 *
 * `no-store`, because the redirect embeds a signed URL with a five-minute life:
 * a cached 302 outlives the credential inside it and turns into a broken image
 * for as long as the cache holds it.
 */
routes.get('/images/:id', auth, async (c) => {
  const id = pathParam(c, 'id');
  const image = await getImage(currentDb(c), id);
  if (!image || image.committedAt === null) throw new NotFoundError(id);
  c.header('cache-control', 'private, no-store');
  return c.redirect(await presignGet(image.storageKey), 302);
});

// ------------------------------------------------------------- maintenance

/**
 * Both sweeps, owner only (spec §5.4, §6).
 *
 * ONE ROUTE FOR TWO SWEEPS. `sweepUncommitted` has nowhere else to be called
 * from — there is no cron in this deployment — and the two are the same kind of
 * operation with the same audience, so folding it in here is what stops it
 * being dead code that lets abandoned slots accumulate forever.
 *
 * OWNER ONLY because this is the route that deletes bytes across every writer's
 * work. `sweepBlankDrafts` is scoped to its caller and is therefore open to
 * writers; there is no equivalent scoping here, because an image's OWNER is not
 * the same person as the author of every post that references it — collecting
 * "my" images against only "my" documents would delete an image the moment a
 * colleague was the one who embedded it.
 *
 * MARK, THEN DELETE, AS TWO STATEMENTS. Not for atomicity — there is no
 * transaction here and there must not be — but because the quarantine is a
 * property measured ACROSS runs. A single statement could only ever ask
 * "unreferenced right now", which is the question rule 2 says is not safe to
 * act on.
 */
const MaintenanceQuery = z
  .object({ dryRun: z.enum(['1', 'true', '0', 'false']).optional() })
  .strict();

/** What one image looked like on the way out. */
function collectedToWire(image: CollectedImage): Record<string, unknown> {
  return {
    id: image.id,
    ownerId: image.ownerId,
    byteSize: image.byteSize,
    unreferencedSince: image.unreferencedSince,
  };
}

routes.post('/images/collect-orphans', requireOwner(), async (c) => {
  const db = currentDb(c);
  const query = readQuery(c, MaintenanceQuery);
  const dryRun = query.dryRun === '1' || query.dryRun === 'true';

  /*
   * THE DRY RUN WRITES NOTHING — no delete, and no MARK either. A preview that
   * ran the mark pass would start quarantine clocks, i.e. looking at the list
   * would move every image on it 24 hours closer to deletion, which is the
   * opposite of what a preview is for. It reads the stored clocks and
   * re-derives the live reference set: the same pair the real delete pass acts
   * on, so the list it shows is the list the next real run would take.
   */
  if (dryRun) {
    const preview = await previewOrphans(db);
    return c.json({
      dryRun: true,
      collected: preview.collected.length,
      collectedImages: preview.collected.map(collectedToWire),
      swept: preview.swept.length,
      sweptImages: preview.swept.map((s) => ({ id: s.id })),
      unreferenced: preview.unreferenced,
      more: preview.more,
      ...(await blockage(db, preview.blocked)),
    });
  }

  const marked = await markUnreferenced(db);
  const result = await collectOrphans(db);
  const swept = await sweepUncommitted(db);
  await releaseObjects([...result.collected, ...swept]);
  return c.json({
    dryRun: false,
    collected: result.collected.length,
    /*
     * PER-IMAGE ACCOUNTING, not just a count. This route destroys committed
     * media belonging to every writer in the deployment, and a writer who
     * committed an image and never placed it in a document had no way to learn
     * what had gone. The row is already deleted by the time this is rendered —
     * this response is the only record that it existed, so it is the one place
     * the question "what did that delete" can be answered from.
     */
    collectedImages: result.collected.map(collectedToWire),
    swept: swept.length,
    sweptImages: swept.map((s) => ({ id: s.id })),
    /** How many images are currently inside the quarantine window. */
    unreferenced: marked.unreferenced,
    /** Rows the mark pass rewrote, and whether a further batch is waiting. */
    marked: marked.changed,
    more: result.more,
    ...(await blockage(db, marked.blocked)),
  });
});

/**
 * Why nothing was collected, when the reason is a document nobody can read.
 *
 * An unwalkable node marks EVERY image referenced (plan rule 3) and that
 * direction is correct — what was wrong is that it was invisible. `{collected:
 * 0}` meant both "healthy store, nothing to do" and "collection has been dead
 * for months", and the owner had no way to find the offending row. So the flag
 * is reported, and the rows are NAMED.
 *
 * The second walk only happens when something is actually blocked: on a healthy
 * store this costs one boolean that the mark pass had already computed.
 */
async function blockage(db: Db, blocked: boolean): Promise<Record<string, unknown>> {
  if (!blocked) return { blocked: false, blockedBy: [] };
  return { blocked: true, blockedBy: await findUnwalkableDocs(db) };
}

/**
 * Rule 6: R2 deletion is best-effort and always AFTER the row is gone.
 *
 * Sequential and individually caught, so one failing key cannot abort the rest
 * — the rows are already deleted, and a sweep that throws halfway leaves the
 * remaining objects unreferenced by anything that will ever look for them
 * again.
 */
async function releaseObjects(objects: readonly SweptObject[]): Promise<void> {
  for (const { storageKey } of objects) {
    await deleteObject(storageKey).catch(() => undefined);
  }
}

/** Exported for the tests that pin the policy rather than re-deriving it. */
export { ALLOWED_CONTENT_TYPES, MAX_IMAGE_BYTES };

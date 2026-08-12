import { api } from './api';
import { ApiError } from './errors';
import { db } from './db';
import type { StoredImage } from './types';

/**
 * Images, after the cutover (plan §6.1).
 *
 * TWO THINGS CHANGED AND EVERYTHING ELSE IS DELIBERATELY THE SAME.
 *
 * 1. `storeImageFile` keeps its signature and still returns a `StoredImage`,
 *    but the bytes now go to object storage rather than to IndexedDB, and the
 *    `id` it returns is the SERVER's. Its three callers — `CoverPicker`, the
 *    paste/drop plugin in `extensions.ts`, and `ImageNode`'s "Save to this
 *    blog" — read `id`, `width` and `height` and nothing else, so none of them
 *    had to learn that an upload happened.
 * 2. `acquireImageURL` became scheme-agnostic: local blob first, then
 *    `/api/images/<id>`. That is what lets `coverImage.blobId` — a BARE id with
 *    no scheme, and the one the server's SQL extractor reads as
 *    `cover_image->>'blobId'` — resolve on both sides of the cutover with no
 *    change to the `CoverImage` type and no migration of the field.
 *
 * WHAT THIS FILE NO LONGER DOES: write to `db.images`. That store now means
 * exactly one thing — the pre-backend image library, the only copy of bytes no
 * server has — and it is what `src/data/migrate.ts` walks. Writing every new
 * upload into it as well would put permanently-duplicated blobs in a store
 * `clearCache` is forbidden to touch, and would put already-uploaded ids into
 * migration's own input set.
 *
 * THE COST, STATED: uploading an image now requires the network. Before the
 * cutover it did not. There is no queue for it — an image is bytes, not a
 * patch, and `pending` holds patches — so a failed upload is reported to the
 * writer and nothing is written into the document. The picture is not lost,
 * because it is still the file they picked.
 */

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/**
 * Kept identical to `server/repo/images.ts`'s `ALLOWED_CONTENT_TYPES`. A type
 * accepted here and refused there is a slot request that 400s after the writer
 * has already waited for a decode.
 */
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

/** Downscale anything wider than this before storing — memory and payload size. */
const MAX_EDGE = 2400;

/**
 * What the canvas re-encode produces. WebP because it is in the server's
 * allowed list, is what `sniffImageType` can identify, and compresses better
 * than PNG for photographs. `toBlob` may substitute PNG where WebP encoding is
 * unavailable, which is why the resulting `blob.type` is what gets declared and
 * never this constant.
 */
const REENCODE_TYPE = 'image/webp';
const REENCODE_QUALITY = 0.9;

/**
 * The one error class the three image surfaces catch.
 *
 * It carries the originating status where there was one, because
 * `src/data/migrate.ts` has to tell "this picture is unusable" from "the hour's
 * upload budget is gone" — the first excludes one image, the second must stop
 * the whole run and report `retryAfter`. Every caller that only wants a
 * sentence keeps reading `.message` and is unaffected.
 */
export class ImageError extends Error {
  readonly status?: number;
  readonly retryAfter?: number;

  constructor(message: string, from?: { status?: number; retryAfter?: number }) {
    super(message);
    this.name = 'ImageError';
    this.status = from?.status;
    this.retryAfter = from?.retryAfter;
  }
}

/**
 * Validate → decode → re-encode → upload → commit.
 *
 * Throws before anything is uploaded if the file is unusable, so a bad pick can
 * never leave a half-written record or clobber an existing cover, and the
 * caller's `catch` still gets an `ImageError` with a sentence a writer can act
 * on. Nothing is written into the document until the server has committed the
 * object.
 */
export async function storeImageFile(file: File): Promise<StoredImage> {
  if (!file) throw new ImageError('No file selected.');
  if (!ACCEPTED.includes(file.type)) {
    throw new ImageError(
      `That file type (${file.type || 'unknown'}) isn’t supported. Use JPEG, PNG, WebP, GIF or AVIF.`,
    );
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new ImageError(
      `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${
        MAX_IMAGE_BYTES / 1024 / 1024
      } MB.`,
    );
  }

  const prepared = await prepareForUpload(file);
  const id = await uploadPrepared(prepared);

  return {
    id,
    blob: prepared.blob,
    width: prepared.width,
    height: prepared.height,
    type: prepared.blob.type || file.type,
    createdAt: Date.now(),
  };
}

/** What `prepareForUpload` hands to the uploader. */
export interface PreparedImage {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * Decode, then RE-ENCODE EVERY NON-GIF, resizing on the way if it is oversized.
 *
 * THE UNCONDITIONAL RE-ENCODE IS THE POINT, and it is what changed here. The
 * pre-cutover version re-encoded only images wider than `MAX_EDGE`, so a
 * 1200×800 photograph straight off a phone was stored byte-for-byte — EXIF, GPS
 * coordinates and all. Spec §5.4 says the client strips EXIF by re-encoding
 * through a canvas and the server enforces it; the server's enforcement is
 * JPEG-only (`exifMarkerState` in `server/storage/magic.ts` says so), and PNG
 * (`eXIf`) and WebP (`EXIF` RIFF chunk) carry the same metadata with nothing on
 * either side checking. Re-encoding everything is what makes the claim true for
 * all three: a canvas has no way to carry a metadata chunk across, because it
 * decodes to pixels.
 *
 * GIF IS THE ONE EXCEPTION, and it is not an oversight: a canvas holds one
 * frame, so re-encoding an animated GIF silently destroys the animation. GIF
 * also cannot carry EXIF, so the exception costs nothing the rest of this
 * function is buying.
 *
 * FAILURE IS REFUSAL, NOT FALLBACK. If the decode or the encode cannot run,
 * this throws rather than uploading the original bytes. Uploading them would be
 * a silent downgrade of the EXIF guarantee — for a JPEG the server would refuse
 * the commit anyway (400 `exif`), and for a PNG or WebP nothing would refuse
 * it and the writer's address would be published.
 */
export async function prepareForUpload(file: Blob): Promise<PreparedImage> {
  const bitmap = await decode(file);
  const sourceW = bitmap.width;
  const sourceH = bitmap.height;

  if (file.type === 'image/gif') {
    if ('close' in bitmap) bitmap.close();
    return { blob: file, width: sourceW, height: sourceH };
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(sourceW, sourceH));
  const width = Math.max(1, Math.round(sourceW * scale));
  const height = Math.max(1, Math.round(sourceH * scale));

  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new ImageError(REENCODE_FAILED);
    ctx.drawImage(bitmap, 0, 0, width, height);
    const encoded = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, REENCODE_TYPE, REENCODE_QUALITY),
    );
    if (!encoded) throw new ImageError(REENCODE_FAILED);
    if (encoded.size > MAX_IMAGE_BYTES) {
      // Reachable in principle for a very large lossless re-encode; the server
      // would answer 400 `byteSize` and this is the same refusal, said earlier
      // and in a sentence.
      throw new ImageError(
        `That image is still ${(encoded.size / 1024 / 1024).toFixed(1)} MB after processing. The limit is ${
          MAX_IMAGE_BYTES / 1024 / 1024
        } MB.`,
      );
    }
    return { blob: encoded, width, height };
  } catch (err) {
    if (err instanceof ImageError) throw err;
    throw new ImageError(REENCODE_FAILED);
  } finally {
    if ('close' in bitmap) bitmap.close();
  }
}

const REENCODE_FAILED =
  'That image couldn’t be processed on this device, so it wasn’t uploaded. Try saving it as a JPEG or PNG first.';

async function decode(file: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== 'function') throw new ImageError(REENCODE_FAILED);
  try {
    return await createImageBitmap(file);
  } catch {
    throw new ImageError(
      'That image couldn’t be read — it may be corrupted or not a real image file.',
    );
  }
}

/**
 * Slot → PUT → commit, and the server's id.
 *
 * `PUT` WITH THE EXACT HEADERS THE SLOT RETURNED. Both the URL and the header
 * set are inputs to R2's signature, so adding a header, dropping one or letting
 * `fetch` infer a `content-type` from the `Blob` makes the request a 403
 * (`server/routes/images.ts` says the same thing from the other side).
 *
 * `credentials: 'omit'` for the same reason: the session is a `__Host-` cookie
 * for this origin, and sending anything to the storage host is both useless and
 * a disclosure. Every request to *this* app's own API goes through `api.ts`,
 * which sets `credentials: 'include'`; this one deliberately does not go
 * through it, because it is not this app's API.
 */
export async function uploadPrepared(prepared: PreparedImage): Promise<string> {
  const contentType = prepared.blob.type || 'application/octet-stream';
  const slot = await createSlot(contentType, prepared.blob.size);

  let res: Response;
  try {
    res = await fetch(slot.uploadUrl, {
      method: 'PUT',
      headers: slot.headers,
      body: prepared.blob,
      credentials: 'omit',
    });
  } catch {
    throw new ImageError(UPLOAD_UNREACHABLE);
  }
  if (!res.ok) {
    /*
     * The uncommitted row is left behind on purpose. `sweepUncommitted` removes
     * it after 24 hours and `MAX_OPEN_SLOTS` bounds how many can pile up; there
     * is no client-side delete route for a slot, and inventing a "cancel" call
     * that itself fails offline would only add a second thing to go wrong.
     */
    throw new ImageError(
      `The image couldn’t be uploaded (${res.status}). Check your connection and try again.`,
    );
  }

  try {
    const committed = await api.commitImage(slot.id);
    return committed.id;
  } catch (err) {
    throw asImageError(err, 'The image uploaded but the blog wouldn’t accept it');
  }
}

const UPLOAD_UNREACHABLE =
  'The image couldn’t be uploaded — you may be offline. It hasn’t been added to the post.';

async function createSlot(contentType: string, byteSize: number) {
  try {
    return await api.createImageSlot({ contentType, byteSize });
  } catch (err) {
    throw asImageError(err, 'The blog wouldn’t accept the image');
  }
}

/**
 * An `ApiError` turned into the one sentence the three image surfaces show.
 *
 * The named details are the ones a writer can act on. `storage` is the
 * deployment having no media storage configured at all
 * (`server/routes/images.ts` answers 400 `detail: 'storage'`, deliberately not
 * a 500, because it cannot change within a retry); `slots` and `quota` are
 * limits that clear with time; `exif` means the re-encode above did not run or
 * did not strip, which is a bug rather than a writer's problem, so it says so
 * plainly rather than blaming the file.
 */
function asImageError(err: unknown, prefix: string): ImageError {
  if (err instanceof ImageError) return err;
  if (!(err instanceof ApiError)) return new ImageError(`${prefix}.`);
  const from = { status: err.status, retryAfter: err.retryAfter };
  if (err.status === 0) return new ImageError(UPLOAD_UNREACHABLE, from);
  if (err.status === 429) {
    return new ImageError(
      'You’ve added a lot of images in the last hour. Wait a few minutes and try again.',
      from,
    );
  }
  switch (err.detail) {
    case 'storage':
      return new ImageError(
        'This blog has no image storage configured yet, so images can’t be uploaded.',
        from,
      );
    case 'slots':
      return new ImageError(
        'Too many uploads are already in progress. Try again in a moment.',
        from,
      );
    case 'quota':
      return new ImageError('This blog’s image storage is full.', from);
    case 'exif':
      return new ImageError(
        'The blog refused the image because it still carried camera metadata. This is a bug — please report it.',
        from,
      );
    case 'contentType':
      return new ImageError('That file isn’t the kind of image it says it is.', from);
    default:
      return new ImageError(`${prefix}${err.detail ? ` (${err.detail})` : ''}.`, from);
  }
}

// ------------------------------------------------------------------ resolving

/**
 * Object URLs are refcounted so two components showing the same cover don't
 * revoke each other's URL. Revoked only when the last holder releases.
 *
 * Server-backed ids never enter this map: there is nothing to revoke, and
 * `releaseImageURL` is already a no-op for an id it does not hold.
 */
const urls = new Map<string, { url: string; refs: number }>();

/**
 * THE SINGLE SCHEME-AGNOSTIC RESOLVER (plan §6.1). Takes a BARE id — no
 * `idb:`, no `asset:`; the callers strip the scheme with `imageIdFromSrc` and
 * `coverImage.blobId` never had one.
 *
 * Local store first, and that ordering is what keeps a pre-cutover library
 * readable: an un-migrated post's images exist only in `db.images`, and asking
 * the server for them would 404 every picture in the writer's whole archive.
 * Only when the local store misses is the id a server id, which is the case for
 * everything uploaded after the cutover and for everything migration rewrote.
 *
 * The fallback is a URL, not a fetch. `GET /api/images/:id` answers 302 to a
 * signed URL with `no-store`, so it belongs in an `<img src>` where the browser
 * follows the redirect and re-signs on every render; fetching it here would buy
 * nothing and lose the browser's own image handling.
 */
export async function acquireImageURL(blobId: string): Promise<string | null> {
  // An empty id is not a miss, it is a malformed document. Resolving it would
  // request `/api/images/` — a different route — and render its answer as an
  // image; `StoredImg` shows its placeholder instead.
  if (!blobId) return null;

  const existing = urls.get(blobId);
  if (existing) {
    existing.refs += 1;
    return existing.url;
  }
  const rec = await db.images.get(blobId);
  if (rec) {
    const url = URL.createObjectURL(rec.blob);
    urls.set(blobId, { url, refs: 1 });
    return url;
  }
  return api.imageUrl(blobId);
}

export function releaseImageURL(blobId: string) {
  const entry = urls.get(blobId);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs <= 0) {
    URL.revokeObjectURL(entry.url);
    urls.delete(blobId);
  }
}

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { readDimensions, sniffImageType } from '../../storage/magic';

/**
 * REVIEW PHOTOS (migration 1280) — the bytes and the rows.
 *
 * A customer's photo is untrusted in two ways a staff upload is not. It can be
 * anything with an image's name on it, so the type is decided by sniffing, never
 * by the declared `Content-Type`. And it very often comes straight off a phone,
 * carrying the GPS position of the customer's HOME in its metadata — so every
 * metadata block that can hold that is removed from the bytes before they are
 * stored. The storefront re-encodes photos through a canvas first, which strips
 * all of it anyway; this is the server not relying on that.
 */

export const MAX_REVIEW_PHOTOS = 4;
/** After the storefront's resize a photo is a few hundred KB; this is the ceiling
 *  for a client that skips the resize. */
export const MAX_REVIEW_PHOTO_BYTES = 10 * 1024 * 1024;
/** A dimension past this is a decompression bomb, not a photograph. */
const MAX_DIMENSION = 12_000;

export type ReviewPhotoType = 'image/jpeg' | 'image/png' | 'image/webp';

const EXTENSION: Record<ReviewPhotoType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export type CleanResult =
  | { ok: true; bytes: Uint8Array; type: ReviewPhotoType; width: number | null; height: number | null }
  | { ok: false; reason: 'type' | 'malformed' | 'too_large_dimensions' };

/**
 * Sniff, strip metadata, measure. A file that cannot be walked cleanly is
 * refused rather than stored as-is: "we could not find the GPS block" is not the
 * same as "there is no GPS block".
 */
export function cleanReviewPhoto(input: Uint8Array): CleanResult {
  const sniffed = sniffImageType(input);
  let bytes: Uint8Array | null;
  let type: ReviewPhotoType;
  switch (sniffed) {
    case 'image/jpeg':
      type = sniffed;
      bytes = stripJpegMetadata(input);
      break;
    case 'image/png':
      type = sniffed;
      bytes = stripPngMetadata(input);
      break;
    case 'image/webp':
      type = sniffed;
      bytes = stripWebpMetadata(input);
      break;
    default:
      return { ok: false, reason: 'type' };
  }
  if (!bytes) return { ok: false, reason: 'malformed' };

  const dims = readDimensions(bytes, type);
  if (dims && (dims.width > MAX_DIMENSION || dims.height > MAX_DIMENSION)) {
    return { ok: false, reason: 'too_large_dimensions' };
  }
  return { ok: true, bytes, type, width: dims?.width ?? null, height: dims?.height ?? null };
}

function u16be(b: Uint8Array, at: number): number {
  return (b[at]! << 8) | b[at + 1]!;
}
function u32be(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) >>> 0) + ((b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!);
}
function u32le(b: Uint8Array, at: number): number {
  return ((b[at + 3]! << 24) >>> 0) + ((b[at + 2]! << 16) | (b[at + 1]! << 8) | b[at]!);
}
function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/**
 * JPEG: drop APP1 (EXIF and XMP), APP13 (Photoshop/IPTC, which can carry a
 * location too) and COM segments. Everything else — including APP0 (JFIF) and
 * APP2 (the ICC colour profile, which makes a photo look right) — is kept.
 *
 * ORIENTATION LIVES IN EXIF AND GOES WITH IT. A phone photo that relied on the
 * orientation tag will display rotated. The storefront's canvas re-encode bakes
 * the rotation into the pixels before upload, which is why the brief requires
 * it; a client that skips it gets a sideways photo, never a located one.
 */
export function stripJpegMetadata(b: Uint8Array): Uint8Array | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let at = 2;
  while (at < b.length) {
    if (b[at] !== 0xff) return null;
    let marker = b[at + 1];
    let head = at + 2;
    /* Fill bytes before a marker. */
    while (marker === 0xff && head < b.length) {
      marker = b[head];
      head += 1;
    }
    if (marker === undefined) return null;
    /* Standalone markers carry no length. */
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(b.subarray(at, head));
      at = head;
      continue;
    }
    if (marker === 0xd9) {
      parts.push(b.subarray(at, head));
      return concat(parts);
    }
    if (head + 2 > b.length) return null;
    const length = u16be(b, head);
    if (length < 2) return null;
    const end = head + length;
    if (end > b.length) return null;
    if (marker === 0xda) {
      /* Start of scan: entropy-coded data follows, and no metadata segment can
         follow it that a viewer reads. Keep the rest verbatim. */
      parts.push(b.subarray(at));
      return concat(parts);
    }
    const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (!drop) parts.push(b.subarray(at, end));
    at = end;
  }
  return null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

/** PNG: drop the EXIF chunk and every free-text chunk. */
export function stripPngMetadata(b: Uint8Array): Uint8Array | null {
  if (b.length < 8 || PNG_SIGNATURE.some((v, i) => b[i] !== v)) return null;
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let at = 8;
  while (at + 12 <= b.length) {
    const length = u32be(b, at);
    const type = String.fromCharCode(b[at + 4]!, b[at + 5]!, b[at + 6]!, b[at + 7]!);
    const end = at + 12 + length;
    if (end > b.length) return null;
    if (!PNG_DROP.has(type)) parts.push(b.subarray(at, end));
    at = end;
    if (type === 'IEND') return concat(parts);
  }
  return null;
}

/**
 * WebP: drop the `EXIF` and `XMP ` chunks, clear their flags in `VP8X`, and
 * rewrite the RIFF size. Chunks are padded to an even length.
 */
export function stripWebpMetadata(b: Uint8Array): Uint8Array | null {
  if (b.length < 12) return null;
  const riff = String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!);
  const webp = String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!);
  if (riff !== 'RIFF' || webp !== 'WEBP') return null;
  const riffEnd = Math.min(b.length, 8 + u32le(b, 4));

  const chunks: Uint8Array[] = [];
  let at = 12;
  while (at + 8 <= riffEnd) {
    const fourcc = String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);
    const size = u32le(b, at + 4);
    const end = at + 8 + size + (size % 2);
    if (at + 8 + size > riffEnd) return null;
    if (fourcc !== 'EXIF' && fourcc !== 'XMP ') {
      const chunk = b.slice(at, Math.min(end, riffEnd));
      if (fourcc === 'VP8X' && chunk.length > 8) {
        /* Flags byte: 0x08 is EXIF, 0x04 is XMP. */
        chunk[8] = chunk[8]! & ~0x0c;
      }
      chunks.push(chunk);
    }
    at = end;
  }
  if (chunks.length === 0) return null;

  const body = concat(chunks);
  const out = new Uint8Array(12 + body.byteLength);
  out.set(b.subarray(0, 12), 0);
  const size = 4 + body.byteLength;
  out[4] = size & 0xff;
  out[5] = (size >>> 8) & 0xff;
  out[6] = (size >>> 16) & 0xff;
  out[7] = (size >>> 24) & 0xff;
  out.set(body, 12);
  return out;
}

// --------------------------------------------------------------------- rows

export interface ReviewPhoto {
  id: string;
  /** Where the storefront (or the admin) loads it from, relative to the API origin. */
  url: string;
  width: number | null;
  height: number | null;
}

/** Public photos are served from here; the admin reads the same bytes behind auth. */
export function reviewPhotoUrl(id: string): string {
  return `/api/public/reviews/photos/${id}`;
}

export function newPhotoId(): string {
  return `rvp_${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function storageKeyFor(id: string, type: ReviewPhotoType): string {
  return `reviews/${id}.${EXTENSION[type]}`;
}

export async function insertReviewPhoto(
  db: Db,
  input: {
    id: string;
    uploaderKey: string;
    storageKey: string;
    contentType: ReviewPhotoType;
    byteSize: number;
    width: number | null;
    height: number | null;
    now: number;
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO shop_review_photos
      (id, review_id, uploader_key, storage_key, content_type, byte_size, width, height, position, created_at)
    VALUES (${input.id}, NULL, ${input.uploaderKey}, ${input.storageKey}, ${input.contentType},
            ${input.byteSize}, ${input.width}, ${input.height}, 0, ${input.now})`);
}

/**
 * Attach uploaded photos to a freshly written review, in the order given.
 *
 * ONE GUARDED STATEMENT (never `db.transaction` — Neon HTTP). Only a photo this
 * uploader owns and that is not already on a review moves; the count of rows
 * that moved is returned, and the caller checks it against what was asked for
 * BEFORE writing the review, via `attachablePhotoCount`.
 */
export async function attachReviewPhotos(
  db: Db,
  reviewId: string,
  uploaderKey: string,
  photoIds: readonly string[],
): Promise<number> {
  if (photoIds.length === 0) return 0;
  const res = await db.execute(sql`
    UPDATE shop_review_photos AS p
       SET review_id = ${reviewId},
           position = w.ord - 1
      FROM unnest(${sql.param([...photoIds])}::text[]) WITH ORDINALITY AS w(id, ord)
     WHERE p.id = w.id
       AND p.uploader_key = ${uploaderKey}
       AND p.review_id IS NULL
    RETURNING p.id`);
  return res.rows.length;
}

/** How many of these ids this uploader could attach right now. */
export async function attachablePhotoCount(
  db: Db,
  uploaderKey: string,
  photoIds: readonly string[],
): Promise<number> {
  if (photoIds.length === 0) return 0;
  const res = await db.execute(sql`
    SELECT count(*)::int AS n
      FROM shop_review_photos
     WHERE id = ANY(${sql.param([...photoIds])}::text[])
       AND uploader_key = ${uploaderKey}
       AND review_id IS NULL`);
  return Number(res.rows[0]?.n ?? 0);
}

/** Photos for many reviews at once, in position order. No status filter — callers decide. */
export async function photosForReviews(
  db: Db,
  reviewIds: readonly string[],
): Promise<Map<string, ReviewPhoto[]>> {
  const out = new Map<string, ReviewPhoto[]>();
  if (reviewIds.length === 0) return out;
  const res = await db.execute(sql`
    SELECT id, review_id, width, height
      FROM shop_review_photos
     WHERE review_id = ANY(${sql.param([...reviewIds])}::text[])
     ORDER BY review_id, position, id`);
  for (const row of res.rows) {
    const reviewId = String(row.review_id);
    const list = out.get(reviewId) ?? [];
    list.push({
      id: String(row.id),
      url: reviewPhotoUrl(String(row.id)),
      width: row.width == null ? null : Number(row.width),
      height: row.height == null ? null : Number(row.height),
    });
    out.set(reviewId, list);
  }
  return out;
}

/**
 * The storage key of a photo, or null. `publicOnly` limits it to photos on an
 * APPROVED review — the rule that makes turning a review down take its photos
 * down with it.
 */
export async function photoStorage(
  db: Db,
  id: string,
  publicOnly: boolean,
): Promise<{ storageKey: string; contentType: string } | null> {
  const res = await db.execute(sql`
    SELECT p.storage_key, p.content_type
      FROM shop_review_photos p
      LEFT JOIN shop_reviews r ON r.id = p.review_id
     WHERE p.id = ${id}
       AND (${publicOnly}::boolean = false OR r.status = 'approved')`);
  const row = res.rows[0];
  return row ? { storageKey: String(row.storage_key), contentType: String(row.content_type) } : null;
}

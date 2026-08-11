import { db, newId } from './db';
import type { StoredImage } from './types';

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
/** Downscale anything wider than this before storing — memory and IDB size. */
const MAX_EDGE = 2400;

export class ImageError extends Error {}

/**
 * Validate → decode → (maybe) downscale → store.
 * Throws before writing anything if the file is unusable, so a bad upload
 * can never leave a half-written record or clobber an existing cover.
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

  const bitmap = await decode(file);
  const needsResize = Math.max(bitmap.width, bitmap.height) > MAX_EDGE;
  let blob: Blob = file;
  let width = bitmap.width;
  let height = bitmap.height;

  if (needsResize && file.type !== 'image/gif') {
    const scale = MAX_EDGE / Math.max(bitmap.width, bitmap.height);
    width = Math.round(bitmap.width * scale);
    height = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0, width, height);
      const resized = await new Promise<Blob | null>((res) =>
        canvas.toBlob(res, 'image/webp', 0.9),
      );
      if (resized) blob = resized;
      else {
        width = bitmap.width;
        height = bitmap.height;
      }
    }
  }
  if ('close' in bitmap) bitmap.close();

  const record: StoredImage = {
    id: newId('img_'),
    blob,
    width,
    height,
    type: blob.type || file.type,
    createdAt: Date.now(),
  };
  await db.images.add(record);
  return record;
}

async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new ImageError(
      'That image couldn’t be read — it may be corrupted or not a real image file.',
    );
  }
}

/**
 * Object URLs are refcounted so two components showing the same cover don't
 * revoke each other's URL. Revoked only when the last holder releases.
 */
const urls = new Map<string, { url: string; refs: number }>();

export async function acquireImageURL(blobId: string): Promise<string | null> {
  const existing = urls.get(blobId);
  if (existing) {
    existing.refs += 1;
    return existing.url;
  }
  const rec = await db.images.get(blobId);
  if (!rec) return null;
  const url = URL.createObjectURL(rec.blob);
  urls.set(blobId, { url, refs: 1 });
  return url;
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

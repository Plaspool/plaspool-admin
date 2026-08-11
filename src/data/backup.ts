import { db, newId } from './db';
import { IDB_SCHEME, docToText } from './doc';
import { createDraftShape } from './posts';
import type { DocNode, Post, Revision, StoredImage } from './types';

/**
 * The escape hatch.
 *
 * IndexedDB is the only durable store this app has. If it becomes unwritable
 * — quota, private mode, a corrupt database — the writer must still be able to
 * get their words out, and get them back somewhere else. So the bundle is a
 * COMPLETE round trip: posts, revision history, and the image bytes, with
 * `idb:` references rewritten to bundle-local ids on import.
 */

export const BUNDLE_FORMAT = 'publishing-studio/v2';

export interface BundleImage {
  id: string;
  type: string;
  width: number;
  height: number;
  /** base64, no data: prefix. */
  data: string;
}

export interface Bundle {
  format: typeof BUNDLE_FORMAT;
  exportedAt: string;
  posts: Post[];
  revisions: Revision[];
  images: BundleImage[];
}

export async function exportBundle(): Promise<Bundle> {
  const [posts, revisions, images] = await Promise.all([
    db.posts.toArray(),
    db.revisions.toArray(),
    db.images.toArray(),
  ]);

  return {
    format: BUNDLE_FORMAT,
    exportedAt: new Date().toISOString(),
    posts,
    revisions,
    images: await Promise.all(
      images.map(async (img) => ({
        id: img.id,
        type: img.type,
        width: img.width,
        height: img.height,
        data: await blobToBase64(img.blob),
      })),
    ),
  };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  // Chunked so a multi-megabyte image doesn't blow the argument limit.
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBlob(data: string, type: string): Blob {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

export function download(filename: string, contents: string, type: string) {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadJSONBundle(): Promise<number> {
  const bundle = await exportBundle();
  download(
    `blog-admin-backup-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(bundle),
    'application/json',
  );
  return bundle.posts.length;
}

export class ImportError extends Error {}

export interface ImportResult {
  posts: number;
  images: number;
  revisions: number;
}

/**
 * Import is additive and non-destructive: nothing already in the store is
 * modified or removed. Every incoming post gets a fresh id, so importing the
 * same bundle twice gives you two copies rather than silently overwriting
 * work you did since the export.
 */
export async function importBundle(json: string): Promise<ImportResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ImportError('That file isn’t valid JSON.');
  }
  const bundle = parsed as Partial<Bundle>;
  if (
    !bundle ||
    typeof bundle.format !== 'string' ||
    !bundle.format.startsWith('publishing-studio/') ||
    !Array.isArray(bundle.posts)
  ) {
    // Deliberately not naming the publication. `data/` is the layer that lifts
    // onto a server almost unchanged (ARCHITECTURE §1), and importing the brand
    // here would tie it to one deployment's identity for the sake of one noun.
    throw new ImportError('That doesn’t look like a backup file from this app.');
  }

  // Old ids → new ids, so documents keep pointing at the right images.
  const imageIdMap = new Map<string, string>();
  const postIdMap = new Map<string, string>();

  const images: StoredImage[] = (bundle.images ?? []).map((img) => {
    const fresh = newId('img_');
    imageIdMap.set(img.id, fresh);
    return {
      id: fresh,
      blob: base64ToBlob(img.data, img.type),
      width: img.width,
      height: img.height,
      type: img.type,
      createdAt: Date.now(),
    };
  });

  const posts: Post[] = bundle.posts.map((p) => {
    const fresh = newId('p_');
    postIdMap.set(p.id, fresh);
    return createDraftShape({
      ...p,
      id: fresh,
      // Slug uniqueness is re-derived on next save; clear to avoid collisions.
      slug: null,
      content: remapImages(p.content, imageIdMap),
      coverImage: p.coverImage
        ? {
            ...p.coverImage,
            blobId: imageIdMap.get(p.coverImage.blobId) ?? p.coverImage.blobId,
          }
        : null,
    });
  });

  const revisions: Revision[] = (bundle.revisions ?? [])
    .filter((r) => postIdMap.has(r.postId))
    .map((r) => ({
      ...r,
      id: newId('r_'),
      postId: postIdMap.get(r.postId)!,
      content: remapImages(r.content, imageIdMap),
    }));

  await db.transaction('rw', db.posts, db.revisions, db.images, async () => {
    if (images.length) await db.images.bulkAdd(images);
    await db.posts.bulkAdd(posts);
    if (revisions.length) await db.revisions.bulkAdd(revisions);
  });

  return { posts: posts.length, images: images.length, revisions: revisions.length };
}

/** Rewrite every `idb:<old>` reference in a document to its new blob id. */
function remapImages(doc: DocNode | undefined, map: Map<string, string>): DocNode {
  if (!doc) return { type: 'doc', content: [{ type: 'paragraph' }] };
  if (map.size === 0) return doc;
  const walk = (node: DocNode): DocNode => {
    let attrs = node.attrs;
    if (node.type === 'image' && typeof node.attrs?.src === 'string') {
      const src = node.attrs.src;
      if (src.startsWith(IDB_SCHEME)) {
        const next = map.get(src.slice(IDB_SCHEME.length));
        if (next) attrs = { ...node.attrs, src: `${IDB_SCHEME}${next}` };
      }
    }
    return {
      ...node,
      attrs,
      content: node.content?.map(walk),
    };
  };
  return walk(doc);
}

/** A plain-text fallback that is readable without any tooling at all. */
export function postToPlainText(post: Post): string {
  return [post.title || 'Untitled', post.subtitle, '', docToText(post.content)]
    .filter((s) => s !== undefined)
    .join('\n');
}

import Dexie, { type Table } from 'dexie';
import type { Post, Revision, StoredImage } from './types';

export class StudioDB extends Dexie {
  posts!: Table<Post, string>;
  revisions!: Table<Revision, string>;
  images!: Table<StoredImage, string>;

  constructor() {
    super('publishing-studio');
    this.version(1).stores({
      posts: 'id, status, updatedAt, publishedAt, deletedAt, category, slug',
      revisions: 'id, postId, [postId+revision], createdAt',
      images: 'id, createdAt',
    });
  }
}

export const db = new StudioDB();

/**
 * Storage health. IndexedDB can be unavailable (private mode, disabled
 * storage) or full. Silently swallowing that would mean a writer typing for an
 * hour into a store that never accepted a single write, so it is surfaced.
 */
export type StorageStatus =
  | { ok: true; usage?: number; quota?: number }
  | { ok: false; reason: 'blocked' | 'unavailable' | 'full'; detail: string };

export async function checkStorage(): Promise<StorageStatus> {
  try {
    // db.open() NEVER settles while an upgrade is blocked by another tab, so
    // awaiting it bare meant the "another tab is holding the database" notice
    // could never render — the user just watched skeletons forever.
    await Promise.race([
      db.open(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('blocked: database did not open')), 3000),
      ),
    ]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const reason = /blocked|version/i.test(detail) ? 'blocked' : 'unavailable';
    return { ok: false, reason, detail };
  }
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota && est.usage && est.usage / est.quota > 0.95) {
      return {
        ok: false,
        reason: 'full',
        detail: 'Local storage for this site is almost full.',
      };
    }
    return { ok: true, usage: est?.usage, quota: est?.quota };
  } catch {
    return { ok: true };
  }
}

// A blocked upgrade otherwise hangs every query forever with no explanation.
db.on('blocked', () => {
  console.warn('IndexedDB upgrade blocked by another tab holding the old version.');
});

/** Cheap, collision-resistant, sortable-ish id. No dependency needed. */
export function newId(prefix = ''): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `${prefix}${Date.now().toString(36)}${rand}`;
}

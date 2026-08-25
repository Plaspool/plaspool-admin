import { useCallback, useEffect, useRef, useState } from 'react';
import { StaleWriteError, savePost, type PostPatch } from '../data/posts';
import type { Post, Revision } from '../data/types';

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string; attempt: number }
  /** Someone else (another tab) advanced this post. We stop writing. */
  | { kind: 'conflict' }
  /** The post was permanently deleted underneath us. We stop writing. */
  | { kind: 'gone' };

const DEBOUNCE_MS = 800;
const MAX_ATTEMPTS = 5;
/** 1s, 2s, 4s, 8s, 16s — bounded, never a tight loop. */
const backoff = (attempt: number) => Math.min(16_000, 2 ** attempt * 500);

export interface Autosave {
  state: SaveState;
  queue: (patch: PostPatch) => void;
  /** Waits for any in-flight write, then persists everything queued. */
  flush: (kind?: Revision['kind']) => Promise<void>;
  hasPending: () => boolean;
  /** Adopt a revision after an external change is accepted (reload/overwrite). */
  rebase: (revision: number) => void;
}

/**
 * Autosave with a single-flight queue and optimistic concurrency.
 *
 * Invariants:
 *  - One write in flight at a time. Edits during a write are coalesced and
 *    flushed straight after it lands, so a fast typist never loses a tail.
 *  - Every write carries the revision it was based on. If another tab moved
 *    the post on, the write is REFUSED rather than clobbering — state becomes
 *    'conflict' and the UI asks the writer what to do.
 *  - Retries are bounded and backed off. A permanent failure stops, keeps the
 *    patch queued in memory, and says so. It never spins.
 *  - flush() genuinely waits for in-flight work instead of returning early,
 *    so Publish and Ctrl+S can never act on a stale row.
 */
export function useAutosave(
  postId: string | null,
  baseRevision: number | null,
  onSaved?: (p: Post) => void,
): Autosave {
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  const pending = useRef<PostPatch | null>(null);
  const pendingKind = useRef<Revision['kind']>('autosave');
  const inFlight = useRef<Promise<void> | null>(null);
  const timer = useRef<number | null>(null);
  const retry = useRef<number | null>(null);
  const attempts = useRef(0);
  /** Revision our current buffer is based on. Null until the post loads. */
  const base = useRef<number | null>(baseRevision);
  const halted = useRef(false);
  const savedCb = useRef(onSaved);
  savedCb.current = onSaved;

  useEffect(() => {
    base.current = baseRevision;
  }, [baseRevision]);

  // Reset everything when the editor moves to a different post.
  useEffect(() => {
    pending.current = null;
    pendingKind.current = 'autosave';
    attempts.current = 0;
    halted.current = false;
    setState({ kind: 'idle' });
  }, [postId]);

  const write = useCallback(async () => {
    if (!postId || halted.current) return;
    const patch = pending.current;
    if (!patch) return;
    const kind = pendingKind.current;
    pending.current = null;
    pendingKind.current = 'autosave';
    setState({ kind: 'saving' });
    try {
      const next = await savePost(postId, patch, {
        kind,
        baseRevision: base.current ?? undefined,
      });
      base.current = next.revision;
      attempts.current = 0;
      savedCb.current?.(next);
      setState({ kind: 'saved', at: Date.now() });
    } catch (err) {
      // Keep the work. Newer edits win over the re-queued older ones.
      pending.current = { ...patch, ...(pending.current ?? {}) };
      pendingKind.current = kind;

      if (err instanceof StaleWriteError) {
        halted.current = true;
        setState({ kind: 'conflict' });
        return;
      }
      if (err instanceof Error && /not found/i.test(err.message)) {
        halted.current = true;
        setState({ kind: 'gone' });
        return;
      }

      attempts.current += 1;
      const message = err instanceof Error ? err.message : 'Could not save';
      setState({ kind: 'error', message, attempt: attempts.current });
      if (attempts.current < MAX_ATTEMPTS) {
        if (retry.current) window.clearTimeout(retry.current);
        retry.current = window.setTimeout(() => void run(), backoff(attempts.current));
      }
    }
  }, [postId]);

  // Serialises writes: a caller always gets a promise for "my work is done".
  const run = useCallback((): Promise<void> => {
    const chain = (inFlight.current ?? Promise.resolve())
      .catch(() => {})
      .then(() => write());
    inFlight.current = chain;
    return chain.finally(() => {
      if (inFlight.current === chain) inFlight.current = null;
    });
  }, [write]);

  const queue = useCallback(
    (patch: PostPatch) => {
      // Even while halted we KEEP the work. Dropping keystrokes because a
      // conflict is outstanding is exactly the data loss the conflict
      // machinery exists to prevent — we stop writing, never stop recording.
      pending.current = { ...(pending.current ?? {}), ...patch };
      if (halted.current) return;
      setState((s) => (s.kind === 'saving' ? s : { kind: 'dirty' }));
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void run(), DEBOUNCE_MS);
    },
    [run],
  );

  /**
   * Wait for the in-flight write AND then persist whatever is queued.
   * Loops because a write can land while we were waiting on the previous one.
   */
  const flush = useCallback(
    async (kind: Revision['kind'] = 'manual') => {
      if (timer.current) window.clearTimeout(timer.current);
      if (retry.current) window.clearTimeout(retry.current);
      if (pending.current) pendingKind.current = kind;
      let guard = 0;
      while ((pending.current || inFlight.current) && guard++ < 10) {
        if (halted.current) return;
        await run();
      }
    },
    [run],
  );

  const rebase = useCallback((revision: number) => {
    base.current = revision;
    halted.current = false;
    attempts.current = 0;
    setState({ kind: 'idle' });
  }, []);

  useEffect(() => {
    const onHide = () => {
      if (pending.current) void flush('autosave');
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
    };
  }, [flush]);

  // Last-chance write when the editor unmounts (route change, close).
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
      if (retry.current) window.clearTimeout(retry.current);
      if (pending.current) void run();
    },
    [run],
  );

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pending.current || inFlight.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const hasPending = useCallback(
    () => pending.current != null || inFlight.current != null,
    [],
  );

  return { state, queue, flush, hasPending, rebase };
}

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './db';
import {
  clearPendingAfterSave,
  countPending,
  listPending,
  listPendingForReview,
  markPending,
  pendingSeq,
  queuePending,
  resolvePending,
  takePending,
} from './pending';

const A = 'u_alice';
const B = 'u_bob';

beforeEach(async () => {
  await db.pending.clear();
});

describe('I4 — the compound primary key', () => {
  it('keeps both users’ unsent writes for the same post', async () => {
    await queuePending({
      postId: 'p_9',
      userId: A,
      patch: { title: 'alice’s 500 words' },
      baseRevision: 3,
    });
    await queuePending({
      postId: 'p_9',
      userId: B,
      patch: { title: 'bob’s draft' },
      baseRevision: 3,
    });

    // With `postId` alone as the primary key this is 1, and Alice's row is the
    // one that silently disappeared.
    expect(await db.pending.count()).toBe(2);
    expect((await takePending('p_9', A))?.patch.title).toBe('alice’s 500 words');
    expect((await takePending('p_9', B))?.patch.title).toBe('bob’s draft');
  });

  it('returns nothing for a user with no row, so B never replays A’s patch', async () => {
    await queuePending({ postId: 'p_9', userId: A, patch: { title: 'a' }, baseRevision: 1 });

    expect(await takePending('p_9', B)).toBeUndefined();
    expect(await listPending(B)).toEqual([]);
    expect(await countPending(B)).toBe(0);
    expect(await countPending(A)).toBe(1);
  });

  it('counts a seq per user, not per post', async () => {
    await queuePending({ postId: 'p_9', userId: A, patch: { title: 'a1' }, baseRevision: 1 });
    await queuePending({ postId: 'p_9', userId: A, patch: { title: 'a2' }, baseRevision: 1 });
    await queuePending({ postId: 'p_9', userId: B, patch: { title: 'b1' }, baseRevision: 1 });

    expect(await pendingSeq('p_9', A)).toBe(2);
    expect(await pendingSeq('p_9', B)).toBe(1);
    expect(await pendingSeq('p_never', A)).toBe(0);
  });
});

describe('queueing', () => {
  it('replaces the patch with the newest failed save and keeps it durable', async () => {
    await queuePending({ postId: 'p_9', userId: A, patch: { title: 'first' }, baseRevision: 2 });
    const row = await queuePending({
      postId: 'p_9',
      userId: A,
      patch: { title: 'second' },
      baseRevision: 2,
    });

    expect(row.state).toBe('queued');
    expect(row.seq).toBe(2);

    db.close();
    await db.open();

    const reloaded = await takePending('p_9', A);
    expect(reloaded?.patch.title).toBe('second');
    expect(reloaded?.baseRevision).toBe(2);
  });
});

describe('the three terminal states', () => {
  beforeEach(async () => {
    await queuePending({
      postId: 'p_9',
      userId: A,
      patch: { title: '500 words' },
      baseRevision: 3,
    });
  });

  it('records a 409 as unresolved without touching the patch or the seq', async () => {
    const row = await markPending('p_9', A, { state: 'unresolved' });

    expect(row?.state).toBe('unresolved');
    expect(row?.seq).toBe(1);
    expect(row?.patch.title).toBe('500 words');
  });

  it('records a permanent 4xx as blocked with the server’s reason', async () => {
    await markPending('p_9', A, {
      state: 'blocked',
      detail: 'Document text exceeds 500 KB',
      path: 'content',
    });

    const row = await takePending('p_9', A);
    expect(row?.state).toBe('blocked');
    expect(row?.detail).toBe('Document text exceeds 500 KB');
    expect(row?.path).toBe('content');
  });

  it('lists only the rows a human has to end, and only this user’s', async () => {
    await queuePending({ postId: 'p_8', userId: A, patch: { title: 'retryable' }, baseRevision: 1 });
    await queuePending({ postId: 'p_7', userId: A, patch: { title: 'permanent' }, baseRevision: 1 });
    await queuePending({ postId: 'p_9', userId: B, patch: { title: 'theirs' }, baseRevision: 1 });
    await markPending('p_9', A, { state: 'unresolved' });
    await markPending('p_7', A, { state: 'blocked', detail: '422' });
    await markPending('p_9', B, { state: 'unresolved' });

    const review = await listPendingForReview(A);
    expect(review.map((r) => r.postId).sort()).toEqual(['p_7', 'p_9']);
    expect(review.every((r) => r.ownerUserId === A)).toBe(true);
  });
});

describe('the clear rule', () => {
  it('deletes a queued row the successful save carried', async () => {
    // The first attempt failed and queued the patch; the retry read the seq it
    // was about to send and then succeeded.
    await queuePending({ postId: 'p_9', userId: A, patch: { title: 'x' }, baseRevision: 1 });
    const carried = await pendingSeq('p_9', A);

    expect(await clearPendingAfterSave('p_9', A, carried)).toBe(true);
    expect(await takePending('p_9', A)).toBeUndefined();
  });

  it('does not delete an unresolved row, so a 409’s 500 words survive the next keystroke', async () => {
    await queuePending({
      postId: 'p_9',
      userId: A,
      patch: { title: '500 words typed offline' },
      baseRevision: 3,
    });
    // Replay 409'd: the overlay was replaced by the higher server revision and
    // `useAutosave` never saw an error, so no banner ever appeared.
    await markPending('p_9', A, { state: 'unresolved' });

    // The first keystroke after that saves successfully, carrying a seq that is
    // not older than the row's.
    expect(await clearPendingAfterSave('p_9', A, 99)).toBe(false);
    expect((await takePending('p_9', A))?.patch.title).toBe('500 words typed offline');
  });

  it('does not delete a blocked row', async () => {
    await queuePending({ postId: 'p_9', userId: A, patch: { title: 'too big' }, baseRevision: 1 });
    await markPending('p_9', A, { state: 'blocked', detail: '422' });

    expect(await clearPendingAfterSave('p_9', A, 99)).toBe(false);
    expect(await db.pending.count()).toBe(1);
  });

  it('does not delete a row newer than the save that succeeded', async () => {
    await queuePending({ postId: 'p_9', userId: A, patch: { title: 'seq 1' }, baseRevision: 1 });
    const carried = await pendingSeq('p_9', A);
    // While that save was in flight another one failed and queued newer text.
    await queuePending({ postId: 'p_9', userId: A, patch: { title: 'seq 2' }, baseRevision: 1 });

    expect(await clearPendingAfterSave('p_9', A, carried)).toBe(false);
    expect((await takePending('p_9', A))?.patch.title).toBe('seq 2');
  });

  it('is scoped to the user, so A’s save cannot clear B’s row', async () => {
    await queuePending({ postId: 'p_9', userId: B, patch: { title: 'bob' }, baseRevision: 1 });

    expect(await clearPendingAfterSave('p_9', A, 99)).toBe(false);
    expect(await db.pending.count()).toBe(1);
  });
});

describe('resolution', () => {
  it('deletes unconditionally, because a human was shown both versions and chose', async () => {
    await queuePending({ postId: 'p_9', userId: A, patch: { title: 'mine' }, baseRevision: 1 });
    await queuePending({ postId: 'p_9', userId: B, patch: { title: 'theirs' }, baseRevision: 1 });
    await markPending('p_9', A, { state: 'unresolved' });

    await resolvePending('p_9', A);

    expect(await takePending('p_9', A)).toBeUndefined();
    expect(await takePending('p_9', B)).toBeDefined();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturedConflictError, NotFeaturableError } from './errors';
import {
  featureOne,
  featuredSnapshot,
  loadFeatured,
  reorderRail,
  resetFeatured,
  subscribeFeatured,
  unfeatureOne,
} from './useFeatured';
import { api } from './api';
import type { FeaturedItem } from './types';

/**
 * The rail's store.
 *
 * WHY THERE IS A STORE AT ALL AND NOT A FETCH PER COMPONENT: the editor's
 * toggle, its "n of 4" counter and the featured manager are three views of ONE
 * four-row list, and two of them can be mounted a second apart. More
 * importantly they must never disagree — a counter reading "3 of 4" beside a
 * toggle that has just been refused is worse than either being absent.
 *
 * MODULE-SCOPED, so every test resets it. A leaked rail between cases is a test
 * that passes on the previous case's data.
 */

const item = (id: string, rank: number): FeaturedItem => ({
  id,
  slug: id,
  title: id.toUpperCase(),
  coverImage: null,
  publishedAt: 1,
  rank,
});

const USER = 'u_1';

beforeEach(() => {
  resetFeatured();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loading', () => {
  it('publishes the rail and reports ready', async () => {
    vi.spyOn(api, 'listFeatured').mockResolvedValue([item('p_a', 1)]);
    await loadFeatured(USER);
    expect(featuredSnapshot().status).toBe('ready');
    expect(featuredSnapshot().items.map((i) => i.id)).toEqual(['p_a']);
  });

  it('asks once for concurrent callers', async () => {
    const spy = vi.spyOn(api, 'listFeatured').mockResolvedValue([]);
    // The editor and the manager can mount within a frame of each other. The
    // dedupe is the in-flight PROMISE, so the second caller lands on the same
    // answer rather than being told to look again later.
    await Promise.all([loadFeatured(USER), loadFeatured(USER), loadFeatured(USER)]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('is unavailable, not empty, when the request fails with nothing cached', async () => {
    vi.spyOn(api, 'listFeatured').mockRejectedValue(new Error('offline'));
    await loadFeatured(USER);
    // AN EMPTY RAIL AND AN UNREACHABLE ONE ARE DIFFERENT ANSWERS. Rendering
    // "0 of 4" for a dropped connection invites an operator to feature a post
    // that is already featured, and then to be refused for no visible reason.
    expect(featuredSnapshot().status).toBe('unavailable');
  });

  it('keeps a good rail when a later refresh fails', async () => {
    const spy = vi.spyOn(api, 'listFeatured').mockResolvedValue([item('p_a', 1)]);
    await loadFeatured(USER);
    spy.mockRejectedValue(new Error('offline'));
    await loadFeatured(USER, { force: true });

    // A dropped connection has told us nothing about what is featured, so it
    // must not empty a manager that was working a moment ago.
    expect(featuredSnapshot().items.map((i) => i.id)).toEqual(['p_a']);
    expect(featuredSnapshot().status).toBe('ready');
  });

  it('drops the rail when the account changes', async () => {
    vi.spyOn(api, 'listFeatured').mockResolvedValue([item('p_a', 1)]);
    await loadFeatured(USER);
    vi.spyOn(api, 'listFeatured').mockResolvedValue([item('p_b', 1)]);
    await loadFeatured('u_2');

    // `logout()` empties Dexie and cannot reach a module variable, so without
    // this a second account on a shared machine sees the first one's rail.
    expect(featuredSnapshot().userId).toBe('u_2');
    expect(featuredSnapshot().items.map((i) => i.id)).toEqual(['p_b']);
  });

  it('notifies subscribers', async () => {
    vi.spyOn(api, 'listFeatured').mockResolvedValue([]);
    const seen = vi.fn();
    const stop = subscribeFeatured(seen);
    await loadFeatured(USER);
    expect(seen).toHaveBeenCalled();
    stop();
  });
});

describe('mutating', () => {
  beforeEach(async () => {
    vi.spyOn(api, 'listFeatured').mockResolvedValue([item('p_a', 1)]);
    await loadFeatured(USER);
  });

  it('adopts the rail a feature answers with', async () => {
    vi.spyOn(api, 'featurePost').mockResolvedValue([item('p_a', 1), item('p_b', 2)]);
    await featureOne(USER, 'p_b');
    // The response IS the new rail, so there is no second GET and no window in
    // which the counter and the toggle disagree.
    expect(featuredSnapshot().items.map((i) => i.id)).toEqual(['p_a', 'p_b']);
  });

  it('adopts the rail an unfeature answers with', async () => {
    vi.spyOn(api, 'unfeaturePost').mockResolvedValue([]);
    await unfeatureOne(USER, 'p_a');
    expect(featuredSnapshot().items).toEqual([]);
  });

  it('adopts the rail a reorder answers with', async () => {
    const reordered = [item('p_b', 1), item('p_a', 2)];
    vi.spyOn(api, 'reorderFeatured').mockResolvedValue(reordered);
    await reorderRail(USER, ['p_b', 'p_a']);
    expect(featuredSnapshot().items.map((i) => i.id)).toEqual(['p_b', 'p_a']);
  });

  it('adopts the rail a 409 REFUSAL carries, and still rethrows', async () => {
    const truth = [item('p_x', 1), item('p_y', 2)];
    vi.spyOn(api, 'featurePost').mockRejectedValue(
      new FeaturedConflictError('featured_full', truth, 4),
    );

    await expect(featureOne(USER, 'p_z')).rejects.toBeInstanceOf(FeaturedConflictError);
    /*
     * THE REFUSAL IS ALSO AN ANSWER. The server sends the current rail with
     * every 409 precisely so the admin can offer a swap, and adopting it here
     * means the manager and the counter are correct the moment the error is
     * raised — rather than showing the stale list the request was built from
     * until somebody reloads.
     */
    expect(featuredSnapshot().items.map((i) => i.id)).toEqual(['p_x', 'p_y']);
  });

  it('leaves the rail alone when a 422 refuses, because it says nothing about it', async () => {
    vi.spyOn(api, 'featurePost').mockRejectedValue(new NotFeaturableError('draft'));
    await expect(featureOne(USER, 'p_z')).rejects.toBeInstanceOf(NotFeaturableError);
    // "This post is a draft" is a fact about the POST. It carries no rail and
    // must not be read as one.
    expect(featuredSnapshot().items.map((i) => i.id)).toEqual(['p_a']);
  });

  it('ignores an answer for an account that has since been replaced', async () => {
    vi.spyOn(api, 'featurePost').mockResolvedValue([item('p_b', 1)]);
    const inFlight = featureOne(USER, 'p_b');
    vi.spyOn(api, 'listFeatured').mockResolvedValue([item('p_other', 1)]);
    await loadFeatured('u_2');
    await inFlight;

    // A late answer for a signed-out account is not this account's data, and
    // the only thing that can be done with it is to drop it.
    expect(featuredSnapshot().userId).toBe('u_2');
    expect(featuredSnapshot().items.map((i) => i.id)).toEqual(['p_other']);
  });
});

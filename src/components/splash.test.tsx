import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { brand } from '../brand';

/**
 * The WRAPPER's contract, not the engine's.
 *
 * `splash-engine.js` is asserted by `splash.local/checks.html`, which drives it
 * in a real browser with a real GPU — live checks covering the things that
 * cannot be reproduced in jsdom (specular cross-sections, seek determinism,
 * WebGL context loss, a surface that reports healthy while drawing nothing).
 * Re-testing any of that here would mean testing a mock.
 *
 * What IS this file's job is what `splash.ts` decides, none of which the engine
 * can know about: that the sequence gets its full six seconds, that it does not
 * ADD wait beyond that, that it only appears on the index route, that the brand
 * strings reach it, and — most importantly — that a failure in the decoration
 * cannot take down the boot it is decorating.
 *
 * `.test.tsx` and not `.test.ts` deliberately: `vitest.config.ts` splits `src/`
 * by extension, and only `.tsx` gets jsdom. As `.test.ts` this runs under node
 * and every DOM line here throws.
 */

const MIN_TOTAL_MS = 6000;

const mount = vi.fn();

vi.mock('./splash-engine', () => ({
  default: {
    version: 'test',
    presets: ['forge', 'glimmer', 'extrude'],
    mount: (host: HTMLElement, opts: Record<string, unknown>) => mount(host, opts),
  },
}));

/** A stand-in handle, plus the `onDone` the engine would have called. */
function fakeHandle() {
  return {
    element: document.createElement('div'),
    renderer: () => 'svg',
    painted: () => true,
    holding: () => true,
    finish: vi.fn(),
    destroy: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    duration: 1560,
  };
}

async function loadSplash() {
  // Fresh module each time: `splash.ts` holds per-mount state in a closure.
  vi.resetModules();
  return await import('./splash');
}

const hosts = () => document.querySelectorAll('[data-splash-host]');
const optsOf = () => mount.mock.calls[0][1] as Record<string, unknown>;
const fireDone = () => (mount.mock.calls[0][1] as { onDone: () => void }).onDone();

beforeEach(() => {
  mount.mockReset();
  mount.mockReturnValue(fakeHandle());
  window.location.hash = '';
  document.body.replaceChildren();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('startSplash', () => {
  it('mounts one host and passes the options the app depends on', async () => {
    const { startSplash } = await loadSplash();
    startSplash();

    expect(hosts()).toHaveLength(1);
    expect(mount).toHaveBeenCalledTimes(1);

    const opts = optsOf();
    /*
     * The re-brand contract: `src/brand.ts` is meant to be the only file a new
     * publication edits, so a boot screen with the name baked into it would be
     * the first thing to make that claim false.
     *
     * Compared against `brand` itself rather than against string literals, and
     * that distinction is the whole point — literals here would pass only while
     * nobody re-brands, which is exactly when this assertion stops being worth
     * anything. It caught nothing and broke immediately when the tagline
     * changed; this form would have caught a splash that ignored the contract.
     */
    expect(opts.brand).toEqual({ name: brand.name, tagline: brand.tagline });
    // The sequence is the point — a stray keypress must not discard it.
    expect(opts.skippable).toBe(false);
    // Plays on every visit to the index route, not once per six hours.
    expect(opts.once).toBe(false);
    // Production has no business parking a handle on `window`.
    expect(opts.debugHandle).toBe(false);
    // `auto` is what keeps the splash from disagreeing with `initTheme()`.
    expect(opts.theme).toBe('auto');
    expect(Array.isArray(opts.tips)).toBe(true);
  });

  /**
   * THE BUG THIS FILE EXISTS FOR.
   *
   * `finish()` exits from wherever the timeline is, including mid-intro. Wired
   * straight to the session resolving it fired within milliseconds on a warm
   * boot and the sequence read as a flicker — it shipped that way once.
   */
  it('gives the sequence its full six seconds even when the app is ready at once', async () => {
    vi.useFakeTimers();
    const { startSplash } = await loadSplash();
    const ready = startSplash();
    const h = mount.mock.results[0].value as ReturnType<typeof fakeHandle>;

    ready(); // the app is ready immediately, as it is on a warm boot

    await vi.advanceTimersByTimeAsync(MIN_TOTAL_MS - 200);
    expect(h.finish).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);
    expect(h.finish).toHaveBeenCalledTimes(1);
  });

  /**
   * The other half of the pairing: past the floor the splash must not add any
   * wait of its own. A slow boot is covered by the tips; it is not lengthened.
   */
  it('exits as soon as the app is ready if that is after the floor', async () => {
    vi.useFakeTimers();
    const { startSplash } = await loadSplash();
    const ready = startSplash();
    const h = mount.mock.results[0].value as ReturnType<typeof fakeHandle>;

    await vi.advanceTimersByTimeAsync(9000); // a genuinely slow boot
    expect(h.finish).not.toHaveBeenCalled(); // still holding: nobody said ready

    ready();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.finish).toHaveBeenCalledTimes(1);
  });

  it('does not appear on a deep link', async () => {
    // Someone opening a bookmarked post wants their post, not six seconds of
    // logo. Only the index route is a gateway.
    window.location.hash = '#/edit/abc123';
    const { startSplash, whenSplashDone } = await loadSplash();
    const ready = startSplash();

    expect(mount).not.toHaveBeenCalled();
    expect(hosts()).toHaveLength(0);
    expect(() => ready()).not.toThrow();
    await expect(whenSplashDone()).resolves.toBeUndefined();
  });

  it('treats the index route in all the shapes the hash router produces', async () => {
    for (const hash of ['', '#', '#/', '#/?status=draft']) {
      mount.mockReset();
      mount.mockReturnValue(fakeHandle());
      document.body.replaceChildren();
      window.location.hash = hash;
      const { startSplash } = await loadSplash();
      startSplash();
      expect(mount, `hash ${JSON.stringify(hash)} should mount`).toHaveBeenCalledTimes(1);
    }
  });

  it('removes the host and resolves whenSplashDone when the engine reports done', async () => {
    const { startSplash, whenSplashDone } = await loadSplash();
    startSplash();
    expect(hosts()).toHaveLength(1);

    fireDone();

    // Left behind, this is a fixed, full-viewport element over the whole app.
    expect(hosts()).toHaveLength(0);
    await expect(whenSplashDone()).resolves.toBeUndefined();
  });

  /**
   * The one that matters most. This runs at module scope in `main.tsx`, before
   * `createRoot`, so anything it throws is an app that never boots — and
   * `Boot` awaits `whenSplashDone()`, so a promise left unresolved here is an
   * index route that never redirects.
   */
  it('leaves no host, stays callable, and still resolves if the engine throws', async () => {
    mount.mockImplementation(() => {
      throw new Error('no WebGL, no SVG, no anything');
    });

    const { startSplash, whenSplashDone } = await loadSplash();
    let ready: (() => void) | undefined;
    expect(() => {
      ready = startSplash();
    }).not.toThrow();

    expect(hosts()).toHaveLength(0);
    expect(() => ready?.()).not.toThrow();
    await expect(whenSplashDone()).resolves.toBeUndefined();
  });

  it('survives a ready signal repeated, and one arriving after the engine is done', async () => {
    vi.useFakeTimers();
    const { startSplash } = await loadSplash();
    const ready = startSplash();
    const h = mount.mock.results[0].value as ReturnType<typeof fakeHandle>;

    fireDone();
    expect(() => {
      ready();
      ready();
    }).not.toThrow();

    await vi.advanceTimersByTimeAsync(MIN_TOTAL_MS + 500);
    // The handle was released on done, so no finish() reaches a dead instance.
    expect(h.finish).not.toHaveBeenCalled();
  });
});

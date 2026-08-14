import { brand } from '../brand';
import PlaSpoolSplash from './splash-engine';

/**
 * THE OPENING SEQUENCE, AND THE TWO RULES THAT DECIDE WHEN IT ENDS.
 *
 * The index route is a gateway, not a screen: `Boot` renders nothing, the
 * sequence plays over it, and by the time it lifts the app has decided whether
 * this person is signed in and moved them to `/dashboard` or `/login`. That is
 * why this mounts at module scope rather than from a component — it has to be
 * on screen before React's first paint, and a component cannot be.
 *
 * It ends when BOTH of these are true, and the pairing is the whole design:
 *
 *   1. `MIN_TOTAL_MS` has passed. The sequence is specified to run six seconds
 *      so two tips can be read. Wired straight to session readiness it fired
 *      about six milliseconds after mount on a warm boot and read as a flicker
 *      — it shipped that way once, which is what `splash.test.tsx` now pins.
 *   2. The host says the app is ready.
 *
 * Rule 1 alone would make a fast boot wait; rule 2 alone would cut the sequence
 * off. Together they mean the splash lasts *at least* six seconds and longer
 * only when the app itself is still working — it decorates wait, and past the
 * six-second floor it never adds any. `maxHoldMs` in the engine is the outer
 * backstop, so a boot that never finishes cannot strand anyone.
 *
 * NOT SKIPPABLE, deliberately. `skippable: false` is passed because the
 * sequence is the point; a stray keypress while the page loads should not
 * discard it.
 *
 * NOT once-per-session either. `once: false` — the engine's six-hour window is
 * off, because this now plays whenever someone lands on the index route.
 */

/** The floor. Two tips at `CH.tipMs` (2.1s) fit inside this; see the engine. */
const MIN_TOTAL_MS = 6000;

/**
 * Encouragement for someone running a shop, shown while the app boots.
 *
 * ONE SHORT LINE EACH, and that is a constraint rather than a style choice: at
 * 2.1s per tip with a 420ms crossfade there is roughly 1.7s of clean reading,
 * which is a headline plus about a dozen words. Longer copy here does not get
 * read, it gets glimpsed — so if these grow, `CH.tipMs` and `MIN_TOTAL_MS` have
 * to grow with them.
 *
 * Here rather than in the engine because the engine is brand-agnostic: it takes
 * `tips` as an option so `src/brand.ts` stays the only file a re-brand touches.
 */
const TIPS = [
  {
    title: 'Slow days are not the verdict',
    body: 'Every shop has more quiet mornings than busy ones.',
  },
  {
    title: 'Your easiest sale is a repeat',
    body: 'Someone who already bought costs far less to reach than a stranger.',
  },
  {
    title: 'Reshoot one photo today',
    body: 'A better first image beats a discount — and you pay for it once.',
  },
];

/**
 * Is this a fresh load of the index route?
 *
 * `createHashRouter`, so the route lives in `location.hash`: `''` and `'#'` are
 * the bare origin, `'#/'` is the index proper, and `'#/?q=1'` is the index with
 * a query. Anything else is a deep link — someone opening `/#/edit/:id` from a
 * bookmark wants their post, not six seconds of logo.
 */
function isIndexRoute(): boolean {
  const h = window.location.hash;
  return h === '' || h === '#' || h === '#/' || h.indexOf('#/?') === 0;
}

let doneResolve: (() => void) | null = null;
/**
 * Resolves when the sequence has left the screen — or immediately, if it never
 * started. `Boot` awaits this before routing, so the redirect cannot happen out
 * from under a splash that is still playing.
 */
let done: Promise<void> = Promise.resolve();

export function whenSplashDone(): Promise<void> {
  return done;
}

/**
 * Put the opening sequence on screen and return a function the host calls when
 * the app is ready.
 *
 * Total by construction: this runs at module scope before `createRoot`, so
 * anything it throws is an app that never boots. There is no version of "the
 * brand animation failed" that should cost a writer their app, so every failure
 * path here ends with the boot proceeding exactly as if this file did not exist.
 */
export function startSplash(): () => void {
  if (typeof document === 'undefined' || !isIndexRoute()) return () => {};

  let handle: ReturnType<typeof PlaSpoolSplash.mount> | null = null;
  let host: HTMLElement | null = null;

  done = new Promise<void>((resolve) => {
    doneResolve = resolve;
  });

  const settle = () => {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    handle = null;
    if (doneResolve) doneResolve();
    doneResolve = null;
  };

  try {
    host = document.createElement('div');
    /*
     * `pointer-events: none` even though this is not skippable: the overlay
     * should not be able to swallow a click meant for the app underneath as it
     * fades, and the engine arms no input listeners at all in this mode.
     */
    host.style.cssText =
      'position:fixed;inset:0;z-index:9999;pointer-events:none;background:var(--paper)';
    host.setAttribute('data-splash-host', '');
    document.body.appendChild(host);

    handle = PlaSpoolSplash.mount(host, {
      // `auto` reads `[data-theme]`, which `initTheme()` has already set by the
      // time this runs, so the splash cannot disagree with the app behind it.
      theme: 'auto',
      brand: { name: brand.name, tagline: brand.tagline },
      tips: TIPS,
      skippable: false,
      once: false,
      debugHandle: false,
      onDone: settle,
    });
  } catch {
    settle();
  }

  const mountedAt = Date.now();
  let ready = false;

  return () => {
    if (ready || !handle) return;
    ready = true;
    const wait = Math.max(0, MIN_TOTAL_MS - (Date.now() - mountedAt));
    setTimeout(() => {
      try {
        if (handle) handle.finish();
      } catch {
        // Best-effort; the engine's `maxHoldMs` is the real backstop.
      }
    }, wait);
  };
}

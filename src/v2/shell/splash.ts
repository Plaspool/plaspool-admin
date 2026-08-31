import { brand } from '../../brand';
import PlaSpoolSplash from '../../components/splash-engine';

/**
 * THE OPENING SEQUENCE, TURNED ON FOR v2 (owner's instruction, 2026-08-31).
 *
 * This is v1's orchestration (`src/components/splash.ts`) restated for v2, the
 * way the Gate restates v1's sign-in: the thin timing logic is COPIED so v2
 * imports no v1 screen, while the ENGINE (`splash-engine.js`) is imported
 * directly — it is a standalone, brand-agnostic ES5 asset with no CSS and no
 * imports of its own, shared the way a font is, so pulling it in cannot bleed
 * v1 styling or behaviour into this build. Flipping index.html back to v1
 * still restores v1 exactly.
 *
 * WHEN IT ENDS — both must be true, and the pairing is the design v1 shipped:
 *
 *   1. `MIN_TOTAL_MS` has passed (the sequence is specified to run six
 *      seconds so two tips can be read; wired straight to session readiness
 *      it fired milliseconds after mount on a warm boot and read as flicker).
 *   2. The host says the app is ready — for v2 that is the session leaving
 *      `unknown`, exactly the window the Gate spends rendering nothing. The
 *      splash decorates a blank the app was already showing; past the floor
 *      it never adds wait of its own. The engine's `maxHoldMs` backstops a
 *      boot that never finishes.
 *
 * `theme: 'light'`, NOT `'auto'`: v2 is a light-only build (`tokens.css`
 * forces `color-scheme: light` and sets no `[data-theme]`), and `auto` would
 * fall through to the OS preference — a dark splash lifting onto a light app
 * for every dark-mode machine.
 */

/** The floor. Two tips at the engine's 2.1s cadence fit inside it. */
const MIN_TOTAL_MS = 6000;

/** One short line each — at ~1.7s of clean reading per tip, longer copy gets
 *  glimpsed, not read. Copied from v1; a re-brand edits `src/brand.ts`, not
 *  the engine. */
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
 * A fresh load of the index only. `createHashRouter`, so the route lives in
 * the hash: `''` and `'#'` are the bare origin, `'#/'` the index, `'#/?…'`
 * the index with a query. Anything else is a deep link — someone opening
 * `#/orders/:id` from a bookmark wants their order, not six seconds of logo.
 */
function isIndexRoute(): boolean {
  const h = window.location.hash;
  return h === '' || h === '#' || h === '#/' || h.indexOf('#/?') === 0;
}

/**
 * Put the sequence on screen and return the function the host calls when the
 * app is ready. Total by construction: this runs at module scope before
 * `createRoot`, so every failure path ends with the boot proceeding exactly
 * as if this file did not exist.
 */
export function startSplash(): () => void {
  if (typeof document === 'undefined' || !isIndexRoute()) return () => {};

  let handle: ReturnType<typeof PlaSpoolSplash.mount> | null = null;
  let host: HTMLElement | null = null;

  const settle = () => {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    handle = null;
  };

  try {
    host = document.createElement('div');
    /* `pointer-events: none` even though this is not skippable: the overlay
       must not swallow a click meant for the app underneath as it fades, and
       the engine arms no input listeners in this mode. `--bg` is v2's ground
       (v1's `--paper` does not exist in this cascade). */
    host.style.cssText =
      'position:fixed;inset:0;z-index:9999;pointer-events:none;background:var(--bg)';
    host.setAttribute('data-splash-host', '');
    document.body.appendChild(host);

    handle = PlaSpoolSplash.mount(host, {
      theme: 'light',
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
        // Best-effort; the engine's maxHoldMs is the real backstop.
      }
    }, wait);
  };
}

/**
 * Types for `splash-engine.js`, which is plain JavaScript on purpose.
 *
 * The engine has to run as a classic `<script>` in `splash.local/`, where the
 * review harness and `checks.html` exercise it — that is the only place its
 * behaviour is actually asserted, and a harness cannot load a bundled module.
 * So the engine stays ES5 and the types live here instead of in it.
 *
 * Hand-written rather than generated: this file is the contract the app codes
 * against, and it deliberately describes a NARROWER surface than the engine
 * exposes. `_internals`, `verifyHandoff` and `reset` exist for the harness and
 * are omitted here so nothing in `src/` can start depending on them.
 */

/** One tip card. Both strings are required; the engine drops malformed items. */
export interface SplashTip {
  title: string;
  body: string;
}

export interface SplashOptions {
  /** Motion character. Unknown names fall back to `forge`. */
  preset?: 'forge' | 'glimmer' | 'extrude';
  /** `auto` reads `[data-theme]` then the OS preference — which is what the app wants. */
  theme?: 'auto' | 'light' | 'dark';
  autoplay?: boolean;
  /** Any pointerdown / keydown / touchstart / wheel exits early. Default true. */
  skippable?: boolean;
  /** Skip entirely if already shown within `seenWindowMs`. Default true. */
  once?: boolean;
  seenKey?: string;
  /** How long "seen" lasts. Default 6h. */
  seenWindowMs?: number;
  /**
   * Hard wall-clock ceiling from mount to `onDone`, enforced by a timer rather
   * than by rAF — so a frame-starved machine ends the splash SOONER, never
   * later. Default 1800.
   */
  maxMs?: number;
  /** The boot-screen layout: name, tagline, tip card, progress rail. Default true. */
  chrome?: boolean;
  /** Cycle tips after the intro until `finish()`. Default true. */
  hold?: boolean;
  /** Ceiling on the holding state, so a host that never calls `finish()` cannot strand the user. Default 30000. */
  maxHoldMs?: number;
  tips?: SplashTip[];
  /** Pin the first tip. Default: chosen at random, once, at mount. */
  tipStart?: number;
  tipLabel?: string;
  brand?: { name?: string; tagline?: string };
  /** Keep the finished mark up instead of fading. For review harnesses only. */
  holdAtEnd?: boolean;
  /**
   * `true` FORCES reduction on. It can never force it off — passing `false` is
   * identical to omitting it, because an OS accessibility setting is a floor
   * and not a default.
   */
  reducedMotion?: boolean;
  /** Take the SVG path even where WebGL works. */
  forceFallback?: boolean;
  zoom?: number;
  /** Parks the instance on `window.__splash`. Defaults true; the app passes false. */
  debugHandle?: boolean;
  /** Fires exactly once, and never after `destroy()`. */
  onDone?: () => void;
}

export interface SplashHandle {
  /** The overlay element the engine created inside the host. */
  element: HTMLElement;
  /** `'webgl' | 'svg'` — which path is running. NOT a health signal; see `painted()`. */
  renderer: () => string;
  /** Whether the surface currently has pixels on it. */
  painted: () => boolean;
  /**
   * Exit from wherever the timeline is, gracefully. This is the call the app
   * makes when it is ready.
   *
   * It exits from WHEREVER it is, including mid-intro — so a caller that wants
   * the opening sequence to complete must wait for `holding()` before calling
   * it, rather than assuming this will finish the animation first.
   */
  finish: () => void;
  /**
   * Has the opening sequence finished, leaving the splash waiting on the host?
   *
   * The signal to gate `finish()` on. Under reduced motion this is true from
   * the first frame — there is no sequence to wait for, which is the point.
   */
  holding: () => boolean;
  destroy: () => void;
  play: () => void;
  pause: () => void;
  seek: (t: number) => void;
  duration: number;
}

declare const PlaSpoolSplash: {
  version: string;
  mount: (host: HTMLElement, opts?: SplashOptions) => SplashHandle;
  presets: string[];
};

export default PlaSpoolSplash;

/**
 * THE BRAND CONTRACT — the one file you edit to make this app someone else's.
 *
 * Everything identifying a publication lives here: its name, its words, its
 * logos, its colour. Nothing else in `src/` hardcodes any of it. To re-brand:
 *
 *   1. Drop your files into `public/brand/`, keeping the filenames below.
 *      They are plain paths, not imports, so swapping a PNG needs no rebuild
 *      knowledge and no code change — replace the file and reload.
 *   2. Edit the strings in `brand` below.
 *   3. Update the matching block in `index.html`. That is the ONE duplicate,
 *      and it exists because social crawlers do not run JavaScript — see the
 *      note on `syncDocumentBrand` at the bottom. `src/brand.test.tsx` fails if
 *      the two ever disagree, so the duplication cannot silently rot.
 *
 * NAMING: assets are named for the background they sit ON, not for the colour
 * of their ink. `logo-dark.png` is the logo you put on a DARK surface, so its
 * ink is light. Vendors label these both ways round and it is a reliable source
 * of mix-ups — PlaSpool's own export had the two lockups inverted relative to
 * its two logomarks.
 */

/** One accent value set. Mirrors the `--accent-*` tokens in `styles/tokens.css`. */
export interface AccentRamp {
  /** Primary accent. Carries text, so it must clear 4.5:1 on the paper. */
  accent: string;
  /** Hover/pressed. Also carries text. */
  hover: string;
  /** Tint used behind accent text and as the focus-ring halo. */
  soft: string;
  /** Decorative hairline. Not a control boundary, so no contrast floor. */
  line: string;
  /** Drawn ON the accent — a tick, a label. Must clear 4.5:1 against `accent`. */
  ink: string;
}

export interface Brand {
  /** Publication name. Used as the accessible name of the logo and in the tab title. */
  name: string;
  /** Sits in the browser tab after the name, and in the social card title. */
  tagline: string;
  /** Meta description and social card description. Aim for ~155 characters. */
  description: string;
  /**
   * Canonical origin, no trailing slash. Social cards need absolute URLs, so
   * this is prefixed onto the asset paths when they are emitted as meta tags.
   */
  url: string;
  /** Optional social handles. Omit what you do not have. */
  social?: { twitter?: string };
  assets: {
    /** Full lockup (mark + wordmark) for light surfaces. `null` falls back to the name as text. */
    logoLight: string | null;
    /** Full lockup for dark surfaces. */
    logoDark: string | null;
    /** Square mark alone, for tight spaces. Light surfaces. */
    logomarkLight: string | null;
    /** Square mark alone. Dark surfaces. */
    logomarkDark: string | null;
    /** Favicon and app icon. Square, with its own background baked in. */
    icon: string;
    /**
     * Social share image. A square icon works as a `summary` card; a purpose-made
     * 1200×630 works as `summary_large_image` and looks considerably better.
     * Whichever you use, set `socialCard` to match.
     */
    ogImage: string;
    socialCard: 'summary' | 'summary_large_image';
  };
  /**
   * Optional accent override. `null` keeps the design system's own green.
   *
   * TWO RAMPS, NOT ONE COLOUR. A brand colour that reads on white almost never
   * reads on near-black — PlaSpool's navy is 14.87:1 on the light paper and
   * would be 1.4:1 on the dark one. Supplying a single value is how a re-brand
   * quietly breaks dark mode, so the type refuses to let you.
   *
   * `src/brand.test.tsx` measures whatever you put here and fails below AA.
   */
  accent: { light: AccentRamp; dark: AccentRamp } | null;
}

export const brand: Brand = {
  name: 'PlaSpool',
  tagline: 'Writing studio',
  description:
    'A local-first publishing studio. Write, organise and read your posts — all of it stored in your browser. No account, no server, no waiting.',
  url: 'https://blog-admin-app-gold.vercel.app',
  social: {},

  assets: {
    logoLight: '/brand/logo-light.png',
    logoDark: '/brand/logo-dark.png',
    logomarkLight: '/brand/logomark-light.png',
    logomarkDark: '/brand/logomark-dark.png',
    icon: '/brand/icon.png',
    // The supplied icon is 1024² — square, so `summary` is the honest card type.
    // Replace with a 1200×630 and switch to `summary_large_image` for a banner.
    ogImage: '/brand/icon.png',
    socialCard: 'summary',
  },

  /**
   * PlaSpool navy, measured against every surface it lands on:
   *   light  accent #231c50 → 14.87:1 paper · 15.52:1 raised · 13.62:1 sunken
   *   light  hover  #171041 → 16.95:1 · ink #ffffff on accent → 15.52:1
   *   dark   accent #9b93d4 →  6.61:1 paper ·  6.13:1 raised ·  5.72:1 sunken
   *   dark   hover  #b3abe0 →  8.64:1 · ink #191338 on accent →  6.31:1
   * The dark ramp is a lightened navy, not the brand hex: see the type's note.
   */
  accent: {
    light: {
      accent: '#231c50',
      hover: '#171041',
      soft: '#e9e7f3',
      line: '#b8b2d6',
      ink: '#ffffff',
    },
    dark: {
      accent: '#9b93d4',
      hover: '#b3abe0',
      soft: '#211d33',
      line: '#413a63',
      ink: '#191338',
    },
  },
};

/** Absolute URL for a brand asset, which social meta tags require. */
export function brandAssetUrl(path: string): string {
  return `${brand.url.replace(/\/$/, '')}${path}`;
}

/**
 * Push the brand into the document at boot.
 *
 * Two jobs. The tab title and favicon are set here rather than left to
 * `index.html` so they cannot drift from this file. The accent is injected as a
 * stylesheet rather than as inline custom properties on `<html>`, because
 * `tokens.css` defines `--accent` three times — once for light, once for
 * `prefers-color-scheme: dark`, and once for the explicit `[data-theme='dark']`
 * override — and an inline property would flatten all three into one value and
 * break the theme toggle.
 *
 * What this canNOT do is the social meta tags: a crawler fetches the HTML and
 * never runs this. Those stay literal in `index.html`, guarded by a test.
 */
export function syncDocumentBrand() {
  document.title = `${brand.name} — ${brand.tagline}`;

  const icon =
    document.querySelector<HTMLLinkElement>('link[rel="icon"]') ??
    document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'icon' }));
  icon.href = brand.assets.icon;

  if (!brand.accent) return;
  const { light, dark } = brand.accent;
  const vars = (r: AccentRamp) => `
    --accent: ${r.accent};
    --accent-hover: ${r.hover};
    --accent-soft: ${r.soft};
    --accent-line: ${r.line};
    --accent-ink: ${r.ink};`;

  const style = document.createElement('style');
  style.id = 'brand-accent';
  // Selectors mirror tokens.css exactly, so the cascade behaves identically.
  style.textContent = `
:root {${vars(light)}}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {${vars(dark)}}
}
:root[data-theme='dark'] {${vars(dark)}}`;
  document.head.appendChild(style);
}

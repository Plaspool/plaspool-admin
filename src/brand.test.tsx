// @vitest-environment jsdom
/**
 * The brand contract, enforced.
 *
 * Three things can silently break a re-brand, and none of them shows up by
 * looking at the app: `index.html` drifting from `src/brand.ts` (the app looks
 * right, the share card is stale), `public/manifest.webmanifest` drifting from
 * both (the app looks right, and the icon somebody installed on their phone
 * two months ago still carries the old name), and an accent that reads on one
 * theme but not the other (the app looks right to whoever picked the colour,
 * and is unreadable for everyone on the other setting). All three are measured
 * here.
 */
import { describe, expect, it } from 'vitest';
import { brand, brandAssetUrl, syncDocumentBrand, type AccentRamp } from './brand';
// Vite's `?raw` rather than `node:fs`: this project's tsconfig types are
// `["vite/client"]` only, so Node builtins do not typecheck here — and adding
// them would be wrong anyway, since nothing in `src/` runs in Node. `?raw` is
// declared by vite/client and reads the real file at transform time.
import html from '../index.html?raw';
import manifestSource from '../public/manifest.webmanifest?raw';

/** Pull a meta tag's content out of the raw HTML, whitespace-tolerant. */
function meta(attr: 'name' | 'property', key: string): string | null {
  const re = new RegExp(
    `<meta[^>]*\\b${attr}=["']${key}["'][^>]*\\bcontent=["']([^"']*)["']|` +
      `<meta[^>]*\\bcontent=["']([^"']*)["'][^>]*\\b${attr}=["']${key}["']`,
    'is',
  );
  const m = re.exec(html);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

describe('index.html carries the same brand as src/brand.ts', () => {
  const expectedTitle = `${brand.name} — ${brand.tagline}`;

  it('title matches', () => {
    expect(/<title>([^<]*)<\/title>/i.exec(html)?.[1]).toBe(expectedTitle);
  });

  it('description matches, on both the meta and the og tag', () => {
    expect(meta('name', 'description')).toBe(brand.description);
    expect(meta('property', 'og:description')).toBe(brand.description);
  });

  it('og title, site name and url match', () => {
    expect(meta('property', 'og:title')).toBe(expectedTitle);
    expect(meta('property', 'og:site_name')).toBe(brand.name);
    expect(meta('property', 'og:url')).toBe(brand.url);
  });

  it('og image is the configured asset, as an absolute URL', () => {
    // Relative paths are silently ignored by most crawlers, which is exactly
    // the kind of failure nobody notices until a link looks blank.
    const og = meta('property', 'og:image');
    expect(og).toBe(brandAssetUrl(brand.assets.ogImage));
    expect(og?.startsWith('http')).toBe(true);
  });

  it('the card type matches the shape of the image it will show', () => {
    expect(meta('name', 'twitter:card')).toBe(brand.assets.socialCard);
  });

  it('the favicon points at the configured icon', () => {
    expect(html).toContain(`href="${brand.assets.icon}"`);
  });

  it('no leftover default branding', () => {
    // The old hardcoded name must not linger anywhere in the shipped shell.
    expect(html).not.toMatch(/Blog Admin/);
  });
});

describe('the manifest carries the same brand as src/brand.ts', () => {
  /** Only the fields this file is the guard for. */
  interface ManifestIcon {
    src: string;
    sizes: string;
    type: string;
    purpose?: string;
  }
  interface Manifest {
    name: string;
    short_name: string;
    description: string;
    start_url: string;
    theme_color: string;
    background_color: string;
    display: string;
    icons: ManifestIcon[];
    shortcuts?: { name: string; url: string; icons?: ManifestIcon[] }[];
  }

  // Parsed once. A manifest that is not valid JSON is not "a failing
  // assertion" in any browser — it is a manifest the browser drops on the
  // floor with the install prompt still missing and nothing said about it.
  const manifest = JSON.parse(manifestSource) as Manifest;
  const iconAt = (size: string) => manifest.icons.find((i) => i.sizes === size);

  it('names the app the same thing', () => {
    expect(manifest.name).toBe(brand.name);
    // `short_name` is what fits under a launcher icon. Same word here because
    // the brand is one word; a longer name would need a real abbreviation.
    expect(manifest.short_name).toBe(brand.name);
  });

  it('describes it the same way as the meta description', () => {
    expect(manifest.description).toBe(brand.description);
  });

  it('tints the app with the light accent, the same value index.html sends', () => {
    if (!brand.accent) return;
    expect(manifest.theme_color).toBe(brand.accent.light.accent);
    expect(meta('name', 'theme-color')).toBe(brand.accent.light.accent);
    // The splash screen behind the launching app. Same navy, so the hand-off
    // from launcher to first paint has no flash of white in it.
    expect(manifest.background_color).toBe(brand.accent.light.accent);
  });

  it('points at the two launcher icons the brand declares', () => {
    expect(iconAt('192x192')?.src).toBe(brand.assets.icon192);
    expect(iconAt('512x512')?.src).toBe(brand.assets.icon512);
  });

  it('declares the large icon maskable, which only the padded artwork earns', () => {
    // Android crops a maskable icon to the launcher's own shape. Claiming it
    // for artwork that runs to its edges loses the corners of the mark, and
    // NOT claiming it puts the whole square on a white plate instead.
    expect(iconAt('512x512')?.purpose).toContain('maskable');
  });

  it('starts at a hash route, because the app is hash-routed', () => {
    // `/` alone is a legal start_url and would still work — it lands on the
    // index, which redirects. An installed app would then spend its first
    // frame on a redirect every launch.
    expect(manifest.start_url).toBe('/#/home');
    expect(manifest.display).toBe('standalone');
  });

  it('every shortcut goes to a hash route too', () => {
    for (const shortcut of manifest.shortcuts ?? []) {
      expect(shortcut.url.startsWith('/#/')).toBe(true);
    }
  });

  it('no leftover default branding', () => {
    expect(manifestSource).not.toMatch(/Blog Admin/);
  });
});

describe('the accent works in BOTH themes, not just the one it was picked in', () => {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = (hex: string) => {
    const h = hex.replace('#', '');
    const n = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };

  // Every surface an accent lands on, straight out of tokens.css.
  const SURFACES = {
    light: { paper: '#fbfaf7', raised: '#ffffff', sunken: '#f2f0ea' },
    dark: { paper: '#14140f', raised: '#1c1c16', sunken: '#232219' },
  };

  const check = (theme: 'light' | 'dark', ramp: AccentRamp) => {
    for (const [surface, bg] of Object.entries(SURFACES[theme])) {
      // `accent` and `hover` carry text, so AA applies on every surface.
      expect
        .soft(ratio(ramp.accent, bg), `${theme} accent on ${surface}`)
        .toBeGreaterThanOrEqual(4.5);
      expect
        .soft(ratio(ramp.hover, bg), `${theme} hover on ${surface}`)
        .toBeGreaterThanOrEqual(4.5);
    }
    // `ink` is drawn ON the accent — a tick, a button label.
    expect
      .soft(ratio(ramp.ink, ramp.accent), `${theme} ink on accent`)
      .toBeGreaterThanOrEqual(4.5);
    // `soft` is a tint that carries accent text and ink text.
    expect
      .soft(ratio(ramp.accent, ramp.soft), `${theme} accent on soft`)
      .toBeGreaterThanOrEqual(4.5);
  };

  it('light ramp clears AA on paper, raised and sunken', () => {
    if (!brand.accent) return; // no override: the design system's own green stands
    check('light', brand.accent.light);
  });

  it('dark ramp clears AA on paper, raised and sunken', () => {
    if (!brand.accent) return;
    check('dark', brand.accent.dark);
  });

  it('the two ramps are actually different', () => {
    if (!brand.accent) return;
    // A tenant pasting one brand hex into both is the failure this catches:
    // it looks fine to them and is unreadable for everyone on the other theme.
    expect(brand.accent.light.accent).not.toBe(brand.accent.dark.accent);
  });
});

describe('syncDocumentBrand', () => {
  it('sets the tab title and favicon from the config', () => {
    syncDocumentBrand();
    expect(document.title).toBe(`${brand.name} — ${brand.tagline}`);
    expect(
      document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.getAttribute('href'),
    ).toBe(brand.assets.icon);
  });

  it('injects the accent for all three theme selectors, never as an inline style', () => {
    syncDocumentBrand();
    const css = document.getElementById('brand-accent')?.textContent ?? '';
    if (!brand.accent) return;
    // Inline custom properties on <html> would flatten light and dark into one
    // value and break the theme toggle — the stylesheet is the whole point.
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('');
    expect(css).toContain(":root[data-theme='dark']");
    expect(css).toContain('prefers-color-scheme: dark');
    expect(css).toContain(brand.accent.light.accent);
    expect(css).toContain(brand.accent.dark.accent);
  });
});

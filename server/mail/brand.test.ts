/**
 * The house style, pinned.
 *
 * TWO KINDS OF ASSERTION HERE AND THEY EXIST FOR DIFFERENT REASONS.
 *
 * **The palette is compared against `src/styles/tokens.css` by reading the
 * file.** `brand.ts` copies those hex values by hand — it has to, because it runs
 * on the server with no CSS pipeline and a build step that parsed the stylesheet
 * would make sending mail depend on the front end compiling. A hand copy rots,
 * and the way it rots is silent: somebody adjusts the accent green on the site
 * and the emails keep the old one for a year, because nobody re-reads the refund
 * email. This test is the thing that makes the copy honest.
 *
 * **The email-HTML rules are asserted as structure.** These are the constraints
 * that are invisible until a customer opens the message in the one client nobody
 * tested — Outlook has no flexbox, Gmail strips `<head>`, every client blocks
 * remote images. Each of them is a rule `brand.ts`'s header states, and a rule
 * with no test is a rule the next edit quietly drops.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BRAND, badge, button, esc, facts, lineTable, shell, timeline } from './brand';

const TOKENS = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8');
const BRAND_TS = readFileSync(new URL('../../src/brand.ts', import.meta.url), 'utf8');

/** The value of a custom property in the stylesheet's `:root` block. */
function token(name: string): string {
  const match = new RegExp(`^\\s*--${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`, 'm').exec(TOKENS);
  return match ? match[1].toLowerCase() : '';
}

/**
 * A field of `brand.accent.light` / `.dark` in `src/brand.ts`.
 *
 * READ OUT OF THE SOURCE RATHER THAN IMPORTED, because `src/brand.ts` also
 * exports `syncDocumentBrand()`, which touches `document` — importing the module
 * into a server-side test would pull a DOM dependency into a suite that has no
 * DOM. The regex is anchored to the ramp block so the light and dark values
 * cannot be confused for each other.
 */
function ramp(mode: 'light' | 'dark', field: string): string {
  const block = new RegExp(`${mode}:\\s*\\{([^}]*)\\}`, 'm').exec(BRAND_TS);
  if (!block) return '';
  const match = new RegExp(`${field}:\\s*'(#[0-9a-fA-F]{3,8})'`).exec(block[1]);
  return match ? match[1].toLowerCase() : '';
}

describe('the palette is the site’s palette', () => {
  /*
   * Only the tokens `brand.ts` actually claims to mirror. Asserting the whole
   * stylesheet would fail the first time the site gained a colour emails do not
   * use, which teaches people to delete the test rather than fix the copy.
   */
  const MIRRORED: [keyof typeof BRAND, string][] = [
    ['paper', 'paper'],
    ['paperSunken', 'paper-sunken'],
    ['paperInset', 'paper-inset'],
    ['cardPaper', 'card-paper'],
    ['cardLine', 'card-line'],
    ['ink', 'ink'],
    ['ink2', 'ink-2'],
    ['ink3', 'ink-3'],
    ['ink4', 'ink-4'],
    ['rule', 'rule'],
    ['ruleStrong', 'rule-strong'],
    ['danger', 'danger'],
    ['dangerSoft', 'danger-soft'],
    ['warn', 'warn'],
    ['warnSoft', 'warn-soft'],
  ];

  it.each(MIRRORED)('BRAND.%s matches --%s in tokens.css', (key, cssName) => {
    const fromCss = token(cssName);
    expect(fromCss, `--${cssName} not found in tokens.css`).not.toBe('');
    expect(BRAND[key].toLowerCase()).toBe(fromCss);
  });
});

describe('the accent is the BRAND’s accent, not the stylesheet’s', () => {
  /*
   * THE MISTAKE THIS GUARDS, WHICH THIS FILE ALREADY MADE ONCE. `tokens.css`
   * declares `--accent` as a green, and `syncDocumentBrand()` in `src/brand.ts`
   * injects PlaSpool's navy over it at boot — so the green is never what anybody
   * sees, and an email built from the stylesheet is an email in a colour the shop
   * does not use. The first version of `brand.ts` shipped exactly that.
   */
  const RAMP: [keyof typeof BRAND, 'light' | 'dark', string][] = [
    ['accent', 'light', 'accent'],
    ['accentHover', 'light', 'hover'],
    ['accentSoft', 'light', 'soft'],
    ['accentLine', 'light', 'line'],
    ['accentInk', 'light', 'ink'],
    ['accentDark', 'dark', 'accent'],
    ['accentSoftDark', 'dark', 'soft'],
    ['accentLineDark', 'dark', 'line'],
  ];

  it.each(RAMP)('BRAND.%s matches brand.accent.%s.%s', (key, mode, field) => {
    const fromBrand = ramp(mode, field);
    expect(fromBrand, `accent.${mode}.${field} not found in src/brand.ts`).not.toBe('');
    expect(BRAND[key].toLowerCase()).toBe(fromBrand);
  });

  it('is NOT the stylesheet’s green, which is the whole point', () => {
    expect(BRAND.accent.toLowerCase()).not.toBe(token('accent'));
  });
});

describe('email HTML is not web HTML', () => {
  const page = shell({ title: 'A subject', preheader: 'A preheader', body: '<p>Body</p>' });

  it('LAYS OUT IN TABLES, because Outlook renders through Word', () => {
    // A div-based layout does not degrade there; it collapses into one unstyled
    // column. `role="presentation"` keeps the tables out of a screen reader.
    expect(page).toContain('role="presentation"');
    expect(page).not.toMatch(/display:\s*flex/);
    expect(page).not.toMatch(/display:\s*grid/);
  });

  it('INLINES EVERY COLOUR, because Gmail strips the head on forwarded mail', () => {
    // Anything that must be true of the message is on the element. The `<style>`
    // block carries only what cannot be inlined.
    expect(page).toContain(`background:${BRAND.paperSunken}`);
    expect(page).toContain(`background:${BRAND.cardPaper}`);
  });

  it('SIZES THE LOGO IN ATTRIBUTES, because Outlook ignores CSS on an image', () => {
    /*
     * The artwork is 4800px wide. Outlook falls back to the intrinsic size when
     * an image is sized only in CSS, so without `width`/`height` ATTRIBUTES the
     * masthead is a logo eight screens across.
     */
    expect(page).toMatch(/<img[^>]*\swidth="\d+"[^>]*\sheight="\d+"/);
  });

  it('gives the logo ALT TEXT, because images are blocked by default', () => {
    /*
     * Every major client blocks remote images for an unknown sender — exactly the
     * reader who has not yet decided to trust the shop. The alt text is what they
     * see instead, so it has to be the shop's name and not "logo" or "".
     */
    const alts = [...page.matchAll(/<img[^>]*\salt="([^"]*)"/g)].map((m) => m[1]);
    expect(alts.length).toBeGreaterThan(0);
    for (const alt of alts) expect(alt).toBe('PlaSpool');
  });

  it('SWAPS THE LOGO FOR DARK MODE WITHOUT EVER SHOWING BOTH', () => {
    /*
     * The dark lockup must be hidden INLINE, so a client that strips the head
     * shows exactly one — the light one. Visible-by-default would stack two
     * logos in every client that drops `<style>`, which is most of them on a
     * forwarded message.
     */
    const dark = /<img class="b-logo-dark"[^>]*style="([^"]*)"/.exec(page);
    expect(dark).not.toBeNull();
    expect(dark![1]).toContain('display:none');
    expect(page).toContain('.b-logo-dark  { display:block !important; }');
  });

  it('draws the card shadow as a cell, because box-shadow is unsupported in Outlook', () => {
    // The site's card is a hard 3px offset with no blur (`--card-lift`), and a
    // solid offset is the one shadow that can be drawn without the property.
    expect(page).toContain(`background:${BRAND.cardLine};padding:0 3px 3px 0`);
  });

  it('declares a preheader, so the inbox does not show the masthead three times', () => {
    expect(page).toContain('A preheader');
    expect(page).toContain('mso-hide:all');
  });

  it('declares both colour schemes and supplies explicit dark values', () => {
    /*
     * Apple Mail and Outlook.com invert a light message without asking, and their
     * per-element flip turns the accent muddy and leaves dark-on-dark text
     * unreadable — the failure this repo fixed on its own screens in PR #48.
     */
    expect(page).toContain('name="color-scheme"');
    expect(page).toContain('prefers-color-scheme: dark');
  });

  it('is a complete document with the title escaped', () => {
    const evil = shell({ title: 'Order <script>alert(1)</script>', body: '<p>x</p>' });
    expect(evil).toContain('<!doctype html>');
    expect(evil).toContain('&lt;script&gt;');
    expect(evil).not.toContain('<script>');
  });
});

describe('components', () => {
  it('escapes every value it is given', () => {
    // These take VALUES — a product title, a tracking number somebody typed.
    expect(lineTable([{ title: 'Mug <3', sku: 'M&M', qty: 1, amount: '1.00 NGN' }], [])).toContain(
      'Mug &lt;3',
    );
    expect(facts([{ label: 'Carrier', value: '<b>DHL</b>' }])).toContain('&lt;b&gt;DHL&lt;/b&gt;');
    expect(badge('<x>')).toContain('&lt;x&gt;');
    expect(button('<go>', 'https://a.test/?a=1&b=2')).toContain('&lt;go&gt;');
  });

  it('PADS THE CELL, NOT THE ANCHOR, so the whole button is clickable in Outlook', () => {
    // A padded inline anchor is clickable only on its text there, which turns a
    // 44px button into a 14px link — and the reader reports "there is no button".
    const html = button('View your order', 'https://shop.test/o/1');
    expect(html).toContain('display:block;padding:13px 26px');
  });

  it('escapes an ampersand in an href, which HTML requires anyway', () => {
    expect(button('Go', 'https://a.test/?a=1&b=2')).toContain('a=1&amp;b=2');
  });

  it('LINKS A ROW THAT CARRIES AN href, so a tracking page is clickable in Outlook', () => {
    const html = facts([{ label: 'Track', value: 'https://t.test/x', mono: true, href: 'https://t.test/x' }]);
    expect(html).toContain('href="https://t.test/x"');
    expect(html).toContain('text-decoration:underline');
  });

  it('REFUSES A NON-http SCHEME, keeping the text and dropping the link', () => {
    /*
     * A tracking URL is a courier's string on a row this admin renders into
     * markup. `esc` alone does not save an `href` — `javascript:alert(1)`
     * contains none of the five characters it replaces — so the scheme is
     * checked rather than escaped, and a refused one still shows its text.
     */
    const html = facts([{ label: 'Track', value: 'javascript:alert(1)', href: 'javascript:alert(1)' }]);
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href=');
    expect(html).toContain('javascript:alert(1)');
  });

  it('TICKS EVERY REACHED STEP AND LEAVES THE REST EMPTY', () => {
    /*
     * A tick is read as a symbol before it is read as a colour, which is what
     * makes the strip legible to a reader with a red/green deficiency — for whom
     * the old accent dot and danger dot were the same dot.
     */
    const html = timeline([
      { label: 'Placed', state: 'done' },
      { label: 'Paid', state: 'now' },
      { label: 'Shipped', state: 'next' },
    ]);
    expect([...html.matchAll(/&#10003;/g)]).toHaveLength(2); // done + now
    expect(html).not.toContain('&#10007;');
    // `now` is ink and bold; `next` is muted.
    expect(html).toContain(`color:${BRAND.ink}`);
    expect(html).toContain(`background:${BRAND.accent}`);
    expect(html).toContain(`background:${BRAND.paperInset}`);
  });

  it('CROSSES A STOPPED STEP, never ticks it', () => {
    // A cancelled order has not reached the end of the happy path, it left it —
    // and a tick there would tell a customer their refund shipped.
    const html = timeline([
      { label: 'Placed', state: 'done' },
      { label: 'Cancelled', state: 'stopped' },
    ]);
    expect(html).toContain('&#10007;');
    expect([...html.matchAll(/&#10003;/g)]).toHaveLength(1); // only 'Placed'
    expect(html).toContain(`background:${BRAND.danger}`);
  });

  it('LINKS THE STEPS WITH A CONTINUOUS RULE, coloured as far as the order has got', () => {
    /*
     * THE BUG THIS PINS. The first construction put the connector in its OWN cell
     * between two step cells — and because a step cell is sized by its label, not
     * by its 24px circle, the rule began ~15px clear of the circle it was meant to
     * join and read as an unrelated dash floating in the gap.
     *
     * Each step now owns half a rule on each side, pinned against its circle and
     * running to its cell edge, so adjacent halves meet at the shared boundary.
     * The assertion is therefore about HALVES: two per step, with the outermost
     * two transparent so the path begins and ends at a circle.
     */
    const html = timeline([
      { label: 'Placed', state: 'done' },
      { label: 'Paid', state: 'now' },
      { label: 'Shipped', state: 'next' },
    ]);

    const halves = [...html.matchAll(/border-top:2px solid ([^;]+);/g)].map((m) => m[1]);
    expect(halves).toHaveLength(6); // two per step

    // The run starts and ends at a circle, never in mid-air.
    expect(halves[0]).toBe('transparent');
    expect(halves[halves.length - 1]).toBe('transparent');

    /*
     * CONTINUITY, ASSERTED DIRECTLY: the right half of a step and the left half
     * of the next must agree, or the rule changes colour in the middle of the gap
     * instead of at a circle.
     */
    expect(halves[1]).toBe(halves[2]); // Placed→Paid, both accent
    expect(halves[3]).toBe(halves[4]); // Paid→Shipped, both pale
    expect(halves[1]).toBe(BRAND.accent);
    expect(halves[3]).toBe(BRAND.ruleStrong);
  });

  it('draws no visible rule at all for a single step', () => {
    // Both halves exist as spacers — which is what keeps the lone circle centred
    // rather than shunted to one edge — but neither is drawn.
    const html = timeline([{ label: 'Placed', state: 'now' }]);
    const halves = [...html.matchAll(/border-top:2px solid ([^;]+);/g)].map((m) => m[1]);
    expect(halves).toEqual(['transparent', 'transparent']);
  });

  it('does NOT stack the timeline on mobile, which would orphan the labels', () => {
    /*
     * `b-col` is the class the mobile query turns into a full-width block. On a
     * two-ROW node/label table that separates every label from its node.
     */
    const html = timeline([
      { label: 'Placed', state: 'done' },
      { label: 'Paid', state: 'now' },
    ]);
    expect(html).not.toContain('b-col');
  });

  it('esc covers the apostrophe, because URLs land inside attributes', () => {
    expect(esc(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

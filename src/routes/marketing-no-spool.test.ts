import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * `node:fs` FOR THE STYLESHEET AND NOTHING ELSE, and it is legal here only
 * because `tsconfig.app.json` now excludes test files from the bundle's build.
 * The alternative every other suite uses — Vite's `?raw` — cannot read a `.css`
 * file under vitest: the css pipeline answers before the query does and hands
 * back the empty string, which is a guard that passes by reading nothing. The
 * first assertion below is what caught that.
 */
const MARKETING_CSS = readFileSync('src/routes/marketing.css', 'utf8');

/*
 * VITE'S `?raw`, NOT `node:fs` — the rule `src/sw.test.ts` and
 * `src/brand.test.tsx` each state at their own first line, and which this file
 * was written in violation of. `tsconfig.app.json` declares
 * `types: ["vite/client"]` and nothing else, so a `node:fs` import here
 * typechecks under the root config and fails `tsc -b` — i.e. it passes
 * `vitest`, passes `tsc --noEmit`, and breaks `npm run build`, which is the
 * command the deployment runs.
 *
 * `import.meta.glob` is also a better fit for what this test is FOR: the
 * patterns are resolved by the bundler at build time, so a glob that stops
 * matching is a glob with no keys rather than a directory read that silently
 * returns nothing — and the first assertion below checks exactly that.
 */
const SOURCES: Record<string, string> = {
  ...import.meta.glob('./Marketing*.tsx', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob('./marketing/**/*.{ts,tsx}', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
  './marketing.css': MARKETING_CSS,
  /* The client itself, NOT its suite: `api-marketing.test.ts` asserts the noun
     is absent and therefore has to spell it, exactly as this file does. */
  ...import.meta.glob('../data/api-marketing.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
  ...import.meta.glob('../data/marketing-fixtures.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
};

/** Glob keys are relative to this file; the assertions read in repo terms. */
const repoPath = (key: string): string =>
  key.replace(/^\.\.\/data\//, 'src/data/').replace(/^\.\//, 'src/routes/');

/**
 * The section's naming promise, enforced against its own source instead of
 * against its rendering.
 *
 * ═══ WHAT IS BEING PROMISED ═══
 * Nothing about the rewards program's naming is fixed (spec D2): the program
 * name, the word for a point and the word for a returned item are all columns,
 * editable on day one, and the migration seeds them with a preset the owner is
 * expected to rename. Every screen therefore renders those four words from the
 * row it is drawing — never from a constant — which is exactly the kind of rule
 * that holds everywhere except the one place somebody was in a hurry.
 *
 * ═══ WHY A GREP AND NOT A RENDER ASSERTION ═══
 * Each suite already mounts its screen against fixtures whose labels are absurd
 * on purpose ("Bottle Caps", "canister") and checks the preset's noun is absent
 * from the output. That catches the word in a place the fixtures reach. It does
 * NOT catch the word in a branch the fixtures never take: an empty state for a
 * program shape nothing seeds, a 409 the suite doesn't provoke, a comment that
 * teaches the next reader the wrong thing, a placeholder in a form. Reading the
 * files as TEXT catches all of it, including the copy nobody rendered yet.
 *
 * Spec D11 asks for this on both streams — `server/marketing/**` is the other
 * half, where the literal is legal in exactly one place: migration 0011's seed
 * INSERT, which is where the preset's real wording is supposed to live.
 *
 * ═══ THE THING THIS TEST CANNOT DO ═══
 * It cannot see the generic word for the currency. "Points" is the seeded
 * DEFAULT, not the word — a screen that hardcodes it survives a rename with no
 * grep to catch it, because the string is unremarkable. The spec names that a
 * review responsibility; the one screen that can never interpolate a label —
 * the discounts placeholder, which fetches nothing to interpolate from — pins
 * it in its own suite instead.
 */

/**
 * Assembled from halves rather than typed, because this file is inside the tree
 * it reads. A literal here would be a guard that fails on itself.
 */
const NOUN = 'sp' + 'ool';
const HAS_NOUN = new RegExp(NOUN, 'i');

/**
 * THE SECOND NEEDLE, AND IT IS A PLACE RATHER THAN A PRODUCT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A PLACE NAME IS NOT A LABEL, AND THE RULE IS THE SAME ANYWAY.
 *
 * The programme collects where there are drivers — one city today, wherever the
 * owner switches a district on tomorrow. The served set is a column on
 * `marketing_service_areas` that a person who is not a developer edits from the
 * Areas screen, so a component that names the city is wrong for a second,
 * different reason from the label rule: not "a rename would produce a lie" but
 * "a switch-off would produce a lie".
 *
 * The concrete case this catches: the refusal panel a customer meets when their
 * address is outside the served set. It is tempting to write "We only collect in
 * <city> right now" because that is true this morning — and it stays on screen,
 * unchanged, the week the owner starts collecting somewhere else. The 409
 * carries `served`, the LIVE list of places, and every sentence about where we
 * collect must be rendered from it.
 *
 * Assembled from halves for the same reason the noun is: this file lives inside
 * the tree it reads.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const PLACE = 'ab' + 'uja';
const HAS_PLACE = new RegExp(PLACE, 'i');

const ROUTES = 'src/routes';

/**
 * Every source the marketing section renders words out of, DISCOVERED rather
 * than listed: a hardcoded list is a list that stops covering the screen added
 * after it was written, which is the same failure this test exists to catch one
 * level up.
 *
 * Wider than the three globs spec D11 names, by two files that are just as
 * capable of carrying the word into a rendering: the fixtures every suite draws
 * from, and the stylesheet (a `content:` property is copy). `QtyStepper.tsx` is
 * deliberately outside it — the component takes its words from callers, and its
 * callers are all in here.
 */
function sources(): string[] {
  return Object.keys(SOURCES).map(repoPath).sort();
}

const read = (file: string): string => {
  const key = Object.keys(SOURCES).find((k) => repoPath(k) === file);
  if (key === undefined) throw new Error(`no source read for ${file}`);
  return SOURCES[key];
};

describe('the marketing section’s sources', () => {
  /*
   * FIRST, THAT ANYTHING WAS READ AT ALL. A test that greps a list built by a
   * pattern passes triumphantly when the pattern matches nothing — and this one
   * runs from the repository root, on two operating systems, over directories
   * other tasks add files to. Green here has to mean "checked", so the count
   * and the names are asserted before the contents are.
   */
  it('are all found — a guard that reads no files is a guard that passes', () => {
    const files = sources();

    for (const screen of [
      'MarketingOverview',
      'MarketingReturns',
      'MarketingRewards',
      'MarketingCustomers',
      'MarketingBanners',
      'MarketingDiscounts',
    ]) {
      expect(files, screen).toContain(`${ROUTES}/${screen}.tsx`);
    }
    expect(files).toContain('src/data/api-marketing.ts');
    expect(files).toContain('src/routes/marketing/StageForm.tsx');

    // Six screens, their suites, the shared bits, the client, the fixtures, the
    // stylesheet. The floor is deliberately below today's count so that adding
    // a screen doesn't break this line, and far enough above zero to catch a
    // pattern that quietly stopped matching.
    expect(files.length).toBeGreaterThanOrEqual(12);
    for (const file of files) expect(read(file).length, file).toBeGreaterThan(0);
  });

  it('never write the seeded preset’s noun down', () => {
    /*
     * The word belongs to a row in a table, and to one INSERT in migration 0011
     * that puts it there. Anywhere in this tree it is a rename that will not
     * take: the program says "Loop Returns" in every list and this screen still
     * says the old word, in copy nobody thought to look at.
     */
    const guilty = sources().filter((file) => HAS_NOUN.test(read(file)));
    expect(guilty).toEqual([]);
  });

  it('never write the served city down either — the list is editable', () => {
    /*
     * Same grep, different lie. A screen that names the city is correct until
     * somebody switches a district off, and nothing about the failure announces
     * itself: the copy still reads plausibly, it is just no longer true.
     *
     * Every sentence about where we collect is rendered from data — the `served`
     * array a `409 outside_service_area` carries, or the areas endpoint's rows.
     */
    const guilty = sources().filter((file) => HAS_PLACE.test(read(file)));
    expect(guilty).toEqual([]);
  });

  it('is looking for two things that exist — neither needle is broken', () => {
    /*
     * The positive control both assertions above need. A grep whose pattern
     * stopped matching passes hardest of all, so each needle is shown finding
     * the string it was built from.
     */
    expect(HAS_NOUN.test(`a ${NOUN.toUpperCase()} of filament`)).toBe(true);
    expect(HAS_PLACE.test(`somewhere in ${PLACE}`)).toBe(true);
    /* …and the full legal name of the region is NOT the needle, which is why the
     * database may store it and this tree may not name the city. */
    expect(HAS_PLACE.test('Federal Capital Territory')).toBe(false);
  });

  it('spell no colour out in the section’s stylesheet', () => {
    /*
     * `marketing.css` is a mkt-prefixed copy of patterns from `shop.css` and
     * `dashboard.css`, and the copying is where a literal gets in: the sources
     * fade a tab strip from flat black, and pasting that lands `#000` in a file
     * whose whole claim is that both themes come free from `tokens.css`. One
     * literal is invisible in the light theme and wrong in the dark one, which
     * is the failure that ships.
     */
    const css = read(`${ROUTES}/marketing.css`);
    const literals = [
      ...css.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g),
    ].map((m) => m[0]);
    expect(literals).toEqual([]);
  });
});

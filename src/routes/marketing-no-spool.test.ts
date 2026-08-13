import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
  const screens = readdirSync(ROUTES)
    .filter((name) => /^Marketing.*\.tsx$/.test(name))
    .map((name) => `${ROUTES}/${name}`);
  /* `recursive` rather than one level: without it a directory here is dropped
     by the `isFile` filter in silence, and everything under it stops being
     checked with nothing going red — the same "list that quietly stopped
     covering things" this function exists to avoid, one level down. */
  const shared = readdirSync(`${ROUTES}/marketing`, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    // Windows joins the nested half with backslashes; the assertions below and
    // the failure messages are all written in the repository's own idiom.
    .map((entry) => `${entry.parentPath.replaceAll('\\', '/')}/${entry.name}`);
  return [
    ...screens,
    ...shared,
    'src/data/api-marketing.ts',
    'src/data/marketing-fixtures.ts',
    `${ROUTES}/marketing.css`,
  ];
}

const read = (file: string): string => readFileSync(file, 'utf8');

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

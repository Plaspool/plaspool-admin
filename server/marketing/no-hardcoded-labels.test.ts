/**
 * NOTHING IN THIS SUBSYSTEM MAY NAME THE SEEDED PRESET.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE REQUIREMENT THIS GUARDS (spec D2, D11): every customer-facing noun in the
 * rewards system is DATA. The program's name, the word for a point, the word for
 * a returnable unit — all of them are columns on `marketing_programs`, all of
 * them are editable in the UI on day one, and the shop is expected to rename the
 * preset the migration installs. "Spool Points" is a placeholder awaiting the
 * owner's review, not a fact about this application.
 *
 * So a server source that spells that noun has done one of two things, and both
 * are the same defect:
 *
 *   - matched on it — `if (program.key === 'spool-return')`, or a "Seeded preset"
 *     badge derived from the key rather than from the `seeded` column — which
 *     makes a rename silently change behaviour;
 *   - written it into copy — an email subject, an error message, a default label
 *     — which makes a rename silently produce a lie, in the one place the
 *     customer reads.
 *
 * Neither fails a test that does not exist for it. Both are invisible in review
 * six months from now, when the shop has renamed the program to "Reel Credits"
 * and one email still says something else. Hence a grep, which is blunt and
 * total and cannot be argued with.
 *
 * WHERE THE LITERAL IS ALLOWED TO LIVE, and nowhere else:
 *
 *   1. `server/db/migrations/0011_marketing.sql` — the seed INSERT. That is the
 *      data, and data is where a placeholder belongs. It is `ON CONFLICT DO
 *      NOTHING`, so re-running it can never resurrect a name the shop changed.
 *   2. This file, which has to spell the needle to search for it.
 *
 * THE FRONTEND HAS ITS OWN COPY of this guard (`src/routes/marketing-no-spool.test.ts`,
 * Stream B's B9) over `src/routes/Marketing*.tsx`, `src/routes/marketing/**` and
 * `api-marketing.ts`. Two guards rather than one shared walker because the two
 * halves are built by different streams against a frozen contract and share no
 * files; a single test would belong to neither.
 *
 * WHAT THIS CANNOT CATCH, named here so it is owned rather than assumed away
 * (spec D11): the generic word "points". A string that says "50 points awarded"
 * is just as wrong — the currency word is config too — and no grep can tell it
 * from prose. Any copy naming the currency must interpolate the program's or the
 * settings' labels, or be reworded label-free. That is a review responsibility.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The one noun the seed spells, and the only literal in this subsystem's
 *  source that may. Case-insensitive: `Spool`, `SPOOL` and `spool-return` are
 *  the same mistake. */
const NEEDLE = /spool/i;

/**
 * THE SECOND NEEDLE, AND IT IS A PLACE RATHER THAN A PRODUCT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A PLACE NAME IS NOT A LABEL, AND THE RULE IS THE SAME ANYWAY.
 *
 * The rewards programme operates where there are drivers. Today that is one
 * city; tomorrow it is wherever the owner switches a district on, and the whole
 * point of `marketing_service_areas` is that expanding is a Switch rather than a
 * deploy (plan §4). So the served set is DATA — editable, per-row, by a person
 * who is not a developer.
 *
 * Which means source that names the city is wrong for a second, different reason
 * from the label rule: not "a rename would produce a lie" but "a switch-off
 * would produce a lie". A route that special-cased the city, a component that
 * said "we only collect in <city>", a test asserting a district is served — each
 * is correct on the day it is written and false the first time somebody edits
 * the list it claims to describe.
 *
 * WHERE IT IS ALLOWED TO LIVE, and nowhere else:
 *
 *   1. `scripts/gen-service-areas.ts` and the SQL it generates — that is the
 *      data, and data is where a place belongs. (Neither is under this file's
 *      walk, so no exemption is needed for either: the region is stored under
 *      its full legal name, which is not this needle.)
 *   2. This file, which has to spell the needle to search for it.
 *
 * The frontend has its own copy over `src/routes/Marketing*.tsx`,
 * `src/routes/marketing/**` and `api-marketing.ts`.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const PLACE_NEEDLE = /abuja/i;

const ROOT = 'server/marketing';

/** Excluded by name, because a file that greps for a word contains it. */
const SELF = `${ROOT}/no-hardcoded-labels.test.ts`;

/** Where the literal legitimately lives — used below as the positive control
 *  that proves this needle can find anything at all. */
const SEED = 'server/db/migrations/0011_marketing.sql';

/**
 * Every `.ts` under `server/marketing`, as repo-relative POSIX paths.
 *
 * A WALK RATHER THAN A LIST WRITTEN BY HAND — the `server/nul-bytes.test.ts`
 * doctrine. A guard whose coverage is enumerated is a guard that stops covering
 * the file somebody adds next week, which is precisely the file most likely to
 * have been written in a hurry.
 */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

const sources = walk(ROOT).filter((path) => path !== SELF);
const production = sources.filter((path) => !path.endsWith('.test.ts'));
const suites = sources.filter((path) => path.endsWith('.test.ts'));

/** Every line carrying a needle, with enough context to name the offender. */
function hits(path: string, needle = NEEDLE): { path: string; line: number; text: string }[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((text, index) => ({ path, line: index + 1, text: text.trim() }))
    .filter((row) => needle.test(row.text));
}

describe('the walk itself', () => {
  /*
   * THE GUARD'S OWN GUARD. A grep that matches nothing passes, and a grep over
   * an empty file list passes hardest of all — so a directory rename, a moved
   * subsystem or a typo in `ROOT` would turn this whole file green and silent.
   * These two assertions are what make the green above mean something.
   */
  it('finds the sources it claims to be reading', () => {
    expect(sources).toContain(`${ROOT}/app.ts`);
    expect(sources).toContain(`${ROOT}/labels.ts`);
    expect(production.length).toBeGreaterThan(15);
    expect(suites.length).toBeGreaterThan(5);
  });

  it('is looking for something that exists — the seed still spells it', () => {
    /*
     * The positive control. If the migration is ever reworded so this fails, the
     * needle above is stale and every assertion below has been passing for the
     * wrong reason. It also states the rule from the other side: the placeholder
     * lives in the DATA, and this is where it is allowed to.
     */
    expect(hits(SEED).length).toBeGreaterThan(0);
  });
});

describe('the seeded preset’s nouns', () => {
  it('appear in no marketing source outside the migration seed', () => {
    /*
     * THE HARD RULE. Not one occurrence, not in a comment, not in a default, not
     * in a test-only branch — because a comment naming the preset is how the next
     * reader learns that matching on it is normal here.
     */
    /* `(path) => hits(path)` AND NEVER `flatMap(hits)`: `flatMap` calls its
     * callback with three arguments, so passing a function that grew a second
     * parameter hands it the INDEX as a needle — and the guard starts throwing
     * or, worse, matching nothing. It cost one red bar here to find. */
    const offenders = production.flatMap((path) => hits(path));
    expect(offenders.map((h) => `${h.path}:${h.line} ${h.text}`)).toEqual([]);
  });

  it('appear in no test FIXTURE either — suites name absurd things on purpose', () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE SUITES ARE SCANNED TOO, WITH ONE NARROW EXEMPTION: a line that asserts
     * the noun is ABSENT.
     *
     * Spec D11 requires every fixture in both streams to use absurd labels
     * ("Bottle Caps" / "canister"), and the reason is not tidiness. A suite whose
     * fixture is named after the seed cannot tell the difference between code
     * that reads a label from the row and code that hardcoded the same word —
     * both render the expected string, and the test passes either way. Absurd
     * fixtures make that distinction visible, and this keeps them absurd.
     *
     * The exemption is for assertions like `expect(rendered).not.toMatch(…)`,
     * which are this guard's own argument made at a different altitude: they
     * prove a specific RENDERED OUTPUT is free of the noun, where this file
     * proves the SOURCES are. Refusing them would delete the sharpest tests in
     * the subsystem to satisfy a rule written to protect them.
     * ═══════════════════════════════════════════════════════════════════════
     */
    const offenders = suites
      .flatMap((path) => hits(path))
      .filter((hit) => !/\.not\./.test(hit.text));
    expect(offenders.map((h) => `${h.path}:${h.line} ${h.text}`)).toEqual([]);
  });
});

describe('the served city', () => {
  it('appears in no marketing source at all — the served set is DATA', () => {
    /*
     * THE SAME RULE AS THE PRESET'S NOUNS, FOR A DIFFERENT REASON. A programme's
     * words change when somebody renames them; a city's status changes when
     * somebody switches a district off. Both make source that names them a lie,
     * and neither failure announces itself.
     *
     * TIGHTER THAN THE LABEL RULE, because there is no seed to exempt: this
     * subsystem stores the region under its full legal name, so not one file
     * under `server/marketing/**` — production or suite — has any business
     * spelling the city.
     */
    const offenders = sources.flatMap((path) => hits(path, PLACE_NEEDLE));
    expect(offenders.map((h) => `${h.path}:${h.line} ${h.text}`)).toEqual([]);
  });

  it('is a needle that can find something — the walk is not lying', () => {
    /*
     * The positive control the assertion above needs. A grep that matches
     * nothing passes, and a grep whose needle is broken passes hardest of all,
     * so this proves the pattern still finds the string it is looking for.
     */
    expect(PLACE_NEEDLE.test('somewhere in Abuja')).toBe(true);
    expect(PLACE_NEEDLE.test('ABUJA')).toBe(true);
    expect(PLACE_NEEDLE.test('Federal Capital Territory')).toBe(false);
  });
});

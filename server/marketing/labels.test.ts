/**
 * The one function that turns rows into words — and the one place a rename could
 * still leak a hardcoded noun.
 *
 * FIXTURE LABELS ARE ABSURD ON PURPOSE ("Bottle Caps" / "canister"), the
 * discipline spec D11 imposes on both streams. Every assertion below reads the
 * fixture's own words back by EQUALITY, so a `resolveLabels` that quietly
 * defaulted to a generic noun for a missing field would fail here rather than
 * ship a word no admin can change.
 *
 * The complementary check — that the seeded preset's own noun appears in no
 * source file — belongs to `no-hardcoded-labels.test.ts`, which is the one place
 * in this subsystem allowed to write that word down.
 */
import { describe, expect, it } from 'vitest';
import { awardSentence, awardedSubject, fmtPoints, fmtUnits } from '../../shared/marketing/copy';
import { resolveLabels } from './labels';
import type { ProgramLabelSource, SettingsLabelSource } from './labels';

/** A `unit_return` program: both label pairs present, as the kind CHECK demands. */
const caps: ProgramLabelSource = {
  name: 'Cap Returns',
  pointsLabelSingular: 'Bottle Cap',
  pointsLabelPlural: 'Bottle Caps',
  unitLabelSingular: 'canister',
  unitLabelPlural: 'canisters',
};

/** An `adhoc` program: points granted by hand, so there is nothing to count. */
const thanks: ProgramLabelSource = {
  name: 'Thank-yous',
  pointsLabelSingular: 'Token',
  pointsLabelPlural: 'Tokens',
  unitLabelSingular: null,
  unitLabelPlural: null,
};

/** The cross-program words, which differ from every program's on purpose. */
const settings: SettingsLabelSource = {
  pointsLabelSingular: 'Star',
  pointsLabelPlural: 'Stars',
};

describe('resolveLabels', () => {
  it('takes every word from the program when there is one', () => {
    // The settings words are deliberately different, so "used the program's" and
    // "used the settings'" cannot both pass.
    expect(resolveLabels(caps, settings)).toEqual({
      name: 'Cap Returns',
      points: { one: 'Bottle Cap', other: 'Bottle Caps' },
      unit: { one: 'canister', other: 'canisters' },
    });
  });

  it('falls back to the settings words when nothing is attached to a program', () => {
    /*
     * The real callers: a manual adjustment (`marketing_ledger.program_id` is
     * NULL for kind `manual`), a customer's balance tile, the checkout
     * adjustment label. Spec D2 splits the config in two for exactly this — a
     * surface that spans programs cannot borrow one program's noun.
     */
    expect(resolveLabels(null, settings)).toEqual({
      name: '',
      points: { one: 'Star', other: 'Stars' },
      unit: null,
    });
  });

  it('leaves the name EMPTY rather than inventing one for a cross-program surface', () => {
    /*
     * The tempting default is "Rewards". It would be a customer-facing noun
     * living in source, which is the single thing spec D2 exists to prevent —
     * and the grep guard in `no-hardcoded-labels.test.ts` cannot catch a generic
     * word. Empty is the honest value: there is no program here, so there is no
     * name, and every surface that renders one is a surface that has a program.
     */
    expect(resolveLabels(null, settings).name).toBe('');
  });

  it('reports no unit for a program that counts nothing', () => {
    // `adhoc`: the kind CHECK makes both unit columns NULL together.
    expect(resolveLabels(thanks, settings).unit).toBeNull();
    // …and the points words are still the program's, not the settings'.
    expect(resolveLabels(thanks, settings).points).toEqual({ one: 'Token', other: 'Tokens' });
  });

  it('refuses to build half a unit pair', () => {
    /*
     * `marketing_programs_kind_fields_ck` makes this unreachable through the
     * routes. It is asserted anyway because the failure mode is silent: a
     * `{one: 'canister', other: undefined}` reaches `fmtUnits`, and the plural
     * renders as "6 undefined" in an email a customer receives.
     */
    const half: ProgramLabelSource = { ...caps, unitLabelPlural: null };
    expect(resolveLabels(half, settings).unit).toBeNull();
    expect(resolveLabels({ ...caps, unitLabelSingular: null }, settings).unit).toBeNull();
  });

  it('produces the shape the shared copy functions read, which is the whole point', () => {
    /*
     * `shared/marketing/copy.ts` is imported by BOTH the server's mailer and the
     * admin UI so the award sentence cannot drift between the preview, the
     * toast, the timeline and the customer's inbox (spec D11). This asserts the
     * join: what this function returns is what those functions consume, so a
     * field renamed here breaks at compile time rather than in an email.
     */
    const labels = resolveLabels(caps, settings);
    expect(fmtPoints(1, labels)).toBe('1 Bottle Cap');
    expect(fmtPoints(50, labels)).toBe('50 Bottle Caps');
    expect(fmtUnits(6, labels)).toBe('6 canisters');
    expect(awardedSubject(labels, 50)).toBe('You earned 50 Bottle Caps');
    expect(awardSentence(labels, 5, 10, 'dara@example.test')).toBe(
      '5 accepted × 10 = 50 Bottle Caps to dara@example.test',
    );
  });

  it('falls back to a neutral unit word only through fmtUnits, never through the labels', () => {
    // The null stays null on the way out — `fmtUnits` owns the fallback so that
    // "this program has no unit" and "this program's unit is called 'unit'" stay
    // distinguishable to everything else.
    const labels = resolveLabels(thanks, settings);
    expect(labels.unit).toBeNull();
    expect(fmtUnits(2, labels)).toBe('2 units');
  });

  it('emits only words that came out of a row, and invents none of its own', () => {
    /*
     * THE D11 DISCIPLINE, STATED POSITIVELY. The usual form of this check greps
     * rendered output for the preset's noun; asserted the other way round it is
     * strictly stronger, because it fails for ANY word this function supplied
     * itself — "points", "Rewards", the preset's own noun, a word nobody has
     * thought of yet. Everything a caller reads must be traceable to a column.
     */
    const fromRows = [
      '', // the absent program name, which is the one non-word this may emit
      caps.name,
      caps.pointsLabelSingular,
      caps.pointsLabelPlural,
      caps.unitLabelSingular,
      caps.unitLabelPlural,
      thanks.name,
      thanks.pointsLabelSingular,
      thanks.pointsLabelPlural,
      settings.pointsLabelSingular,
      settings.pointsLabelPlural,
    ];

    const emitted = [
      resolveLabels(caps, settings),
      resolveLabels(thanks, settings),
      resolveLabels(null, settings),
    ].flatMap((l) => [l.name, l.points.one, l.points.other, l.unit?.one, l.unit?.other]);

    for (const word of emitted.filter((w) => typeof w === 'string')) {
      expect(fromRows).toContain(word);
    }
  });

  it('copies rather than aliases, so a caller cannot rename a program by mutating labels', () => {
    const labels = resolveLabels(caps, settings);
    labels.points.one = 'Doubloon';
    expect(caps.pointsLabelSingular).toBe('Bottle Cap');
  });
});

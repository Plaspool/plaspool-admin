import type { ProgramLabels } from '../../shared/marketing/copy';
import type { DbMarketingProgram, DbMarketingSettings } from './schema';

/**
 * Rows in, WORDS out — the choke point spec D2 and D11 route every
 * customer-facing noun through.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A FUNCTION AT ALL, WHEN THE COLUMNS ARE RIGHT THERE ON THE ROW.
 *
 * Because "the words for this thing" comes from two places and the choice
 * between them is a rule, not a lookup. A program row carries its own name and
 * its own points words; a manual adjustment carries NO program
 * (`marketing_ledger.program_id` is NULL for kind `manual`, and the coupling
 * CHECK only requires one for an award), and neither does a customer's balance
 * tile, which sums points earned under every program at once. Those surfaces
 * take the cross-program words from `marketing_settings` — spec D2's whole
 * reason for splitting the config in two.
 *
 * Written out at each call site, that rule is nine `?? settings.pointsLabel…`
 * expressions, and the tenth one is the one somebody writes as `'points'`.
 *
 * THE OUTPUT IS THE SHAPE `shared/marketing/copy.ts` READS, which is what makes
 * the award sentence identical in the inspection form, the confirm dialog, the
 * toast, the timeline event and the email (spec D11). This function is the only
 * bridge between a database row and that shared vocabulary, so the join is
 * type-checked in one place instead of assembled by hand five times.
 *
 * IT DOES NOT DECIDE WHICH ROW TO READ. A history row — a ledger `reason`, an
 * `inspected` event's data, a sent email body — carries the wording that was
 * true when it was WRITTEN and is displayed verbatim. Re-rendering one through
 * this function against today's labels is the rename-rewrites-the-past bug the
 * snapshot rule exists to prevent (spec D2d).
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * The five columns of a program that are words. `Pick` rather than a hand-written
 * interface so a column renamed in `schema.ts` breaks this at compile time, and
 * so a caller can hand over a narrow SELECT without inventing the columns it did
 * not read.
 */
export type ProgramLabelSource = Pick<
  DbMarketingProgram,
  | 'name'
  | 'pointsLabelSingular'
  | 'pointsLabelPlural'
  | 'unitLabelSingular'
  | 'unitLabelPlural'
>;

/** The cross-program half. Settings have no name and no unit — only the two
 * points words, because they are the only ones that mean anything on a surface
 * spanning every program. */
export type SettingsLabelSource = Pick<
  DbMarketingSettings,
  'pointsLabelSingular' | 'pointsLabelPlural'
>;

export function resolveLabels(
  program: ProgramLabelSource | null,
  settings: SettingsLabelSource,
): ProgramLabels {
  if (program === null) {
    return {
      /*
       * EMPTY, AND NOT "Rewards". There is no program here, so there is no
       * program name, and the obvious default would be a customer-facing noun
       * living in source — the one thing D2 makes impossible everywhere else.
       * The grep guard cannot catch a generic English word, so this is a
       * decision rather than an oversight: surfaces that render a name are
       * surfaces that have a program.
       */
      name: '',
      points: { one: settings.pointsLabelSingular, other: settings.pointsLabelPlural },
      unit: null,
    };
  }

  const { unitLabelSingular, unitLabelPlural } = program;

  return {
    name: program.name,
    points: { one: program.pointsLabelSingular, other: program.pointsLabelPlural },
    /*
     * BOTH OR NEITHER. `marketing_programs_kind_fields_ck` already ties the pair
     * together — an `adhoc` program has neither — so half a pair is unreachable
     * through the routes. It is guarded anyway because the failure is silent
     * rather than loud: a `{one: 'canister', other: undefined}` reaches
     * `fmtUnits`, and the plural renders "6 undefined" in a message a customer
     * receives. `null` routes it to `fmtUnits`'s neutral fallback instead.
     */
    unit:
      unitLabelSingular !== null && unitLabelPlural !== null
        ? { one: unitLabelSingular, other: unitLabelPlural }
        : null,
  };
}

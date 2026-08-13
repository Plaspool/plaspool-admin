/**
 * FROZEN at stream fork 2026-08-13 — edits require both streams' consent.
 *
 * THE CUSTOMER-FACING WORDING, IN ONE PLACE, because it is rendered by two
 * codebases that must not disagree. The admin UI shows the award sentence three
 * times (the live line under the inspection form, the confirm dialog, the
 * success toast) and previews the email subject while a program is being
 * renamed; the server renders the same two strings into the mail it actually
 * sends and into the ledger row's `reason`. Written twice, they drift the first
 * time somebody improves one of them, and the drift is invisible — the preview
 * says one thing, the customer's inbox says another, and the ledger says a
 * third. `server/shop/cart/totals/compute.ts` already imports `shared/commerce`
 * across the same boundary, so this is the house precedent, not a new one.
 *
 * NOTHING HERE MAY NAME A SPOOL. Every noun a customer reads — the program's
 * name, its points word, its unit word — arrives as `ProgramLabels` from the
 * program row. "Spool Points" exists only as seed data in migration 0011; both
 * streams run a grep test that fails if the literal appears in source.
 */

/**
 * The three words a program lends to every sentence about it.
 *
 * `unit` is null for programs that award points for a reason other than
 * returning something (the `adhoc` kind) — there is nothing being counted, so
 * there is no word for it, and a caller that formats a quantity anyway gets the
 * neutral fallback in `fmtUnits` rather than a lie.
 *
 * `{one, other}` is English-shaped on purpose: it is the smallest pair that
 * covers every language with a singular/plural split, and `Intl.PluralRules`
 * categories (zero/two/few/many) can be added to the struct later without a
 * migration, because these are columns on the program row, not enum values.
 */
export interface ProgramLabels {
  name: string;
  points: { one: string; other: string };
  unit: { one: string; other: string } | null;
}

/** Plural by magnitude, so a −1 adjustment reads "1 Bottle Cap", not "-1 Bottle Caps". */
function pick(n: number, forms: { one: string; other: string }): string {
  return Math.abs(n) === 1 ? forms.one : forms.other;
}

/**
 * A points amount in the program's own currency word.
 *
 * USE THIS FOR LIVE VALUES ONLY — a balance, a quantity being typed, a total
 * being previewed. History rows (ledger `reason`, timeline event data, sent
 * mail) carry the wording that was true when they were written and must be
 * displayed verbatim; re-formatting them through current labels is exactly the
 * rename-rewrites-the-past bug the snapshot rule exists to prevent.
 */
export function fmtPoints(n: number, labels: ProgramLabels): string {
  return `${n.toLocaleString()} ${pick(n, labels.points)}`;
}

/** A count of the thing being returned. Falls back to "unit(s)" for `adhoc` programs. */
export function fmtUnits(n: number, labels: ProgramLabels): string {
  const unit = labels.unit ?? { one: 'unit', other: 'units' };
  return `${n.toLocaleString()} ${pick(n, unit)}`;
}

/**
 * The award sentence, which travels: form → confirm → toast → timeline → email.
 *
 * One string in five places is what makes a dispute reconstructible — whatever
 * surface the customer or the admin quotes, it is the same sentence, and the
 * arithmetic that produced the points is inside it rather than implied.
 */
export function awardSentence(
  labels: ProgramLabels,
  qtyAccepted: number,
  pointsPerUnit: number,
  email: string,
): string {
  const points = qtyAccepted * pointsPerUnit;
  return `${qtyAccepted} accepted × ${pointsPerUnit} = ${fmtPoints(points, labels)} to ${email}`;
}

/** The award email's subject line, previewed in the program editor before a rename is saved. */
export function awardedSubject(labels: ProgramLabels, points: number): string {
  return `You earned ${fmtPoints(points, labels)}`;
}

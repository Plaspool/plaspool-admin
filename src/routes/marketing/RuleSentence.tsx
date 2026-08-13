import { awardedSubject, fmtPoints, fmtUnits, type ProgramLabels } from '../../data/api-marketing';
import '../marketing.css';

/**
 * A program's configuration, restated as the sentences a customer will meet.
 *
 * THE POINT OF THIS FILE IS THAT NOTHING IN IT IS SAVED. Two integers and four
 * words are a program's whole rule set, and read as a form they say almost
 * nothing: "minimum 4", "rate 7" and a pair of plural fields are four boxes an
 * operator can fill in correctly and still be surprised by what the shop tells a
 * customer. Rendered back as the sentence they produce — from the DRAFT values,
 * before anything is posted — a wrong plural, a rate typed into the minimum, or
 * a unit word that only reads well in the singular are all visible while they
 * are still free to fix.
 *
 * IT IS THE SAME FUNCTION THE EMAIL USES. `awardedSubject` comes from
 * `shared/marketing/copy.ts`, which `server/marketing/notify/mailer.ts` imports
 * to render the real mail; the preview below is therefore not an impression of
 * the subject line, it IS the subject line, computed here with unsaved values.
 * A preview written by hand would agree with the mail until somebody improved
 * one of them, and the disagreement would be invisible from either side.
 *
 * NOTHING HERE NAMES A CURRENCY OR A THING. Every noun in every sentence is
 * interpolated from the labels handed in; the only fixed words are the verbs
 * between them.
 */

/**
 * The parts of a program the sentences are made of.
 *
 * Numbers, not the editor's input strings: what to say about a half-typed rule
 * is the caller's decision, and `null` here means "nothing to say yet" rather
 * than "zero".
 */
export interface RuleDraft {
  kind: 'unit_return' | 'adhoc';
  labels: ProgramLabels;
  minUnitsPerReturn: number | null;
  pointsPerUnit: number | null;
}

/** A drafted value inside a sentence. Weight, so it reads as the thing being
 *  checked rather than as emphasis. */
function V({ children }: { children: string }) {
  return <span className="mktsentence__v">{children}</span>;
}

/**
 * The rules, in a sentence.
 *
 * The `adhoc` arm deliberately does NOT read "Points are granted manually", the
 * wording this component was specified with. The plural of the currency is
 * configuration — the whole reason this file exists — and a sentence that names
 * it "points" is a hardcoded noun that the section's grep guard cannot catch,
 * because "points" is also an ordinary English word (spec D11 names this exact
 * hole and makes it a review responsibility). The labels are in scope here, so
 * the sentence uses them and the hole closes.
 */
export function RuleSentence({ draft }: { draft: RuleDraft }) {
  const { labels, minUnitsPerReturn: min, pointsPerUnit: rate } = draft;

  if (draft.kind === 'adhoc') {
    return (
      <p className="mktsentence">
        <V>{labels.points.other}</V> are given out by hand — credit somebody from the Customers
        screen, for whatever reason you write down. Nothing is counted and nothing is sent back.
      </p>
    );
  }

  // A rule is not a rule until both halves of it are numbers. Saying half of one
  // ("Customers who send back at least 4 …") would read as a finished sentence
  // about a program that cannot yet award anything.
  if (min === null || rate === null) {
    return (
      <p className="mktsentence">
        Fill in the minimum and the rate and this will say, in your own words, exactly what a
        customer is promised.
      </p>
    );
  }

  const unit = labels.unit ?? { one: 'unit', other: 'units' };
  return (
    <p className="mktsentence">
      Customers who send back <V>{`at least ${fmtUnits(min, labels)}`}</V> earn{' '}
      <V>{fmtPoints(rate, labels)}</V> per accepted <V>{unit.one}</V>.
    </p>
  );
}

/**
 * The subject line of the award email, over draft labels.
 *
 * A rename is checked against the customer-facing artifact before it is saved —
 * which is the one place the wording is read by somebody who cannot ask what it
 * meant. `points` is the caller's: the honest sample is the smallest award the
 * rules can actually produce, so the line below is a real subject rather than an
 * invented figure.
 */
export function NamingPreview({ labels, points }: { labels: ProgramLabels; points: number }) {
  return (
    <div className="mktform__field">
      <span className="label">The email a customer gets</span>
      {/* `.mktmath` — the class the award sentence wears wherever it travels.
          This string comes out of the same module and goes into the same mail,
          so it is the same kind of thing on the page. */}
      <p className="mktmath">{awardedSubject(labels, points)}</p>
      <p className="mktform__hint">
        Rendered from the words above, by the same function that renders the mail itself.
      </p>
    </div>
  );
}

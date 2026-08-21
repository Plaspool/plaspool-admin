import { useCallback, useEffect, useId, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Award } from 'lucide-react';
import {
  fmtPoints,
  fmtUnits,
  labelsOf,
  marketingApi,
  type MarketingSettings,
  type Program,
  type ProgramDraft,
  type ProgramLabels,
  type ProgramPatch,
  type SettingsPatch,
} from '../data/api-marketing';
import { safeFormat } from '../data/when';
import { ApiError, NotFoundError, OfflineError, StaleWriteError } from '../data/errors';
import { useSession } from '../components/RequireAuth';
import { useToast } from '../components/Toast';
import { ConfirmDialog } from '../components/Dialog';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Feedback';
import { Switch } from '../components/ui/Switch';
import { useDelayed } from '../components/ui/useDelayed';
import { NamingPreview, RuleSentence, type RuleDraft } from './marketing/RuleSentence';
import './marketing.css';

/**
 * What the programs are called and what they pay — the screen a rename happens
 * on, which is the screen this whole section was designed around.
 *
 * THE WORDS ARE DATA AND THIS IS WHERE THE DATA IS EDITED. Every noun a customer
 * meets — the program's name, the word for one reward and for many, the word for
 * the thing they send back — is a column on a row, and every other surface in
 * the section renders whatever this screen last saved. Which is why the editor
 * is half form and half restatement: the panel beside it says, in the words
 * currently in the boxes, exactly what a customer will be promised and exactly
 * what the award email's subject line will read. A rename is verified against
 * the artifact before it is saved rather than discovered in an inbox afterwards.
 *
 * THE HANDLE IS NOT ON THE FORM AFTER CREATION, AND THAT IS THE SAFETY. `key` is
 * what ledger rows, return requests and the settings' default all point at, and
 * `ProgramPatch` structurally has no `key` and no `kind` — the server's schema is
 * `.strict()`, so a body carrying either is a 400 rather than an identity moving
 * under everything that references it. This file never puts either in a patch,
 * for the preset row or any other; create mode is the only place they exist, and
 * there they are chosen once.
 *
 * "SEEDED PRESET" COMES OFF THE `seeded` COLUMN, never off a key comparison. The
 * migration sets it on the row it wrote; matching a key string here would hard-
 * code the preset's noun into a screen whose entire premise is that the noun is
 * editable, and it would be wrong the day a second preset ships.
 *
 * OWNER-ONLY CONTROLS ARE ABSENT FOR WRITERS, never disabled — program writes and
 * the settings PATCH are `requireOwner` (spec's role matrix), and a disabled
 * button is a promise the server will refuse. A writer gets the same information
 * as a `.mktkv` and the same plain-words panel, because knowing what a program
 * pays is part of processing returns.
 */

// ============================================================================
// THE WORDS
// ============================================================================

/**
 * The copy for a `bad_request`, keyed by the field path the server named.
 *
 * The catalogue's treatment for a 400 is "inline, keyed by `detail`" — which
 * needs a sentence per field, because `pointsLabelPlural` is the server's name
 * for a box labelled "More than one". Programs and settings share the map:
 * `pointsLabelSingular` is the same field on both forms and would otherwise be
 * two sentences somebody has to keep in agreement.
 */
const FIELD_MESSAGE: Record<string, string> = {
  key: 'Lowercase letters, numbers, dashes and underscores, starting with a letter or a number.',
  kind: 'That kind wasn’t accepted.',
  name: 'A program needs a name — customers see it.',
  pointsLabelSingular: 'Say what one of them is called.',
  pointsLabelPlural: 'Say what more than one of them is called.',
  unitLabelSingular: 'Say what one of the things coming back is called.',
  unitLabelPlural: 'Say what more than one of them is called.',
  minUnitsPerReturn: 'The minimum has to be a whole number above zero.',
  pointsPerUnit: 'The rate has to be a whole number above zero.',
  status: 'That status wasn’t accepted.',
  redemptionEnabled: 'That wasn’t accepted.',
  redemptionRatePoints: 'How many are spent has to be a whole number above zero.',
  redemptionRateMinor: 'What they are worth has to be a whole number.',
  redemptionCurrency: 'Three uppercase letters — the ISO code, like NGN.',
  minRedeemPoints: 'A whole number, or zero for no minimum.',
  maxRedeemBps: 'Between 1 and 10000, where 10000 is the whole order.',
  // Spec #20: a raced Select is a FIELD error beside the field, not a missing
  // page — the program was there when the list was loaded and is not now.
  defaultReturnProgramId: 'That program isn’t there any more. Pick another one.',
};

const fieldMessage = (field: string): string =>
  FIELD_MESSAGE[field] ?? 'That value wasn’t accepted.';

/** The two things a program can be, and what each one means in a sentence. */
const KINDS: { value: Program['kind']; label: string; hint: string }[] = [
  {
    value: 'unit_return',
    label: 'Counted returns',
    hint: 'Customers send something back, and every accepted one is paid at a fixed rate.',
  },
  {
    value: 'adhoc',
    label: 'Given by hand',
    hint: 'Nothing is counted and nothing comes back — you credit people yourself, with a reason.',
  },
];

/** The program key's CHECK, restated. The hint under the box says it in words. */
const KEY_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Digits only: every number on these two forms is a non-negative integer, and
 *  a minus sign anywhere in them is a value the column would refuse. */
const INT_RE = /^\d+$/;

/**
 * A Select cannot offer an empty value — Radix reads `''` as "nothing chosen"
 * and would render this option's label nowhere. "No default" is a real choice
 * on this form (returns then have to name their program), so it travels as a
 * sentinel and becomes `null` on the wire.
 */
const NO_DEFAULT = 'none';

const WHEN = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

// ============================================================================
// THE FAILURES
// ============================================================================

function explainLoad(err: unknown, fallback = 'The programs didn’t load.'): string {
  if (err instanceof OfflineError) return 'The request didn’t reach the server.';
  if (err instanceof NotFoundError) return 'This deployment has no rewards routes yet.';
  if (err instanceof ApiError) {
    if (err.status === 403) return 'Your account isn’t allowed to read this.';
    if (err.status >= 500) {
      return err.requestId === undefined
        ? 'Something went wrong on the server.'
        : `Something went wrong on the server — reference ${err.requestId}.`;
    }
  }
  return fallback;
}

/** A write's failures, minus the ones the catalogue says to render inline. */
function explainWrite(err: unknown): string {
  if (err instanceof OfflineError) return 'The request didn’t reach the server.';
  if (err instanceof NotFoundError) return 'That program no longer exists.';
  if (err instanceof ApiError) {
    if (err.status === 403) return 'Only the owner can change this.';
    if (err.status >= 500) {
      return err.requestId === undefined
        ? 'Something went wrong on the server.'
        : `Something went wrong on the server — reference ${err.requestId}.`;
    }
  }
  return 'That didn’t go through.';
}

/**
 * The entity a 409 carried, under its own key.
 *
 * EVERY CONFLICT SHIPS THE RE-READ ROW (spec D7) precisely so the notice below
 * can offer it without a second request — `StaleWriteError.post` is the blog's
 * field and is null on everything in this section, so the payload is read off
 * the envelope instead. Typed loosely and checked, because it arrives from a
 * server written in another session.
 */
function carried<T extends { id?: string; revision?: number }>(
  err: unknown,
  key: string,
): T | null {
  if (!(err instanceof ApiError)) return null;
  const body = err.body;
  if (body === null || typeof body !== 'object') return null;
  const found = (body as Record<string, unknown>)[key];
  if (found === null || typeof found !== 'object') return null;
  return typeof (found as T).revision === 'number' ? (found as T) : null;
}

/** A refusal, and the field it belongs under. `null` is the whole form. */
interface Problem {
  field: string | null;
  message: string;
}

/** An operator-typed integer, or null when the box does not hold one. */
function int(raw: string): number | null {
  const trimmed = raw.trim();
  if (!INT_RE.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

// ============================================================================
// SCREEN
// ============================================================================

export default function MarketingRewards() {
  const [params] = useSearchParams();
  const editing = params.get('id');

  return (
    <div className="mktscr">
      {editing === null ? (
        <RewardsList />
      ) : (
        /* Remounted per program: the editor holds a draft of one row's wording,
           and carrying half a rename from one program into the next is the worst
           thing this screen could do quietly. */
        <ProgramEditor key={editing} id={editing} />
      )}
    </div>
  );
}

/** Who is signed in, for what to RENDER. The server still decides what happens. */
function useIsOwner(): boolean {
  const session = useSession();
  const user = session.status === 'unknown' ? null : session.user;
  return user?.role === 'owner';
}

// ============================================================================
// LIST
// ============================================================================

/**
 * THE TWO HALVES OF THIS SCREEN, AND WHY THEY ARE NOW TABS.
 *
 * They were stacked: a long settings panel — the word for a reward, its plural,
 * the spend rate, the currency, four minimums — and then the programs table
 * underneath it. So the table, which is what somebody opens Rewards to look at,
 * started below the fold and the screen opened on a form nobody came for.
 *
 * They are also different KINDS of thing. Settings are section-wide and are
 * touched once; programs are the rows you work with. Stacking those reads as one
 * long form where the bottom half happens to be a table.
 *
 * TABS RATHER THAN TWO ROUTES, and the tab lives in `?tab=`: the screen is one
 * fetch of one list either way, the rail already spends an entry on Rewards, and
 * a URL that names the half you were reading is what Back and a pasted link both
 * need. Programs is the default because it is the answer to the more common
 * question.
 */
type RewardsTab = 'programs' | 'settings';

const REWARDS_TABS: { key: RewardsTab; label: string }[] = [
  { key: 'programs', label: 'Programs' },
  { key: 'settings', label: 'Settings' },
];

function RewardsList() {
  const isOwner = useIsOwner();
  const [params] = useSearchParams();
  /* Anything else in `?tab=` is Programs rather than an error screen — a
     mistyped query is not a broken route. */
  const tab: RewardsTab = params.get('tab') === 'settings' ? 'settings' : 'programs';
  const [programs, setPrograms] = useState<Program[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const showSkeletons = useDelayed(loading);

  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    setProblem(null);
    return marketingApi
      .listPrograms(signal)
      .then((next) => {
        if (signal?.aborted) return;
        setPrograms(next);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (signal?.aborted) return;
        setProblem(explainLoad(err));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  return (
    <>
      <header className="mktscr__head">
        <div className="mktscr__headrow">
          <div>
            <h1 className="mktscr__title">Rewards</h1>
            <p className="mktscr__lede">
              What each program is called, what it pays, and what customers may do with what they
              have earned. Renaming is safe — every row already written keeps the words it was
              written in.
            </p>
          </div>
          {/* Creating a program is `requireOwner`, so for a writer the control
              is absent rather than disabled. */}
          {isOwner && (
            <Link
              className="btn btn--primary"
              to={{ pathname: '/marketing/rewards', search: '?id=new' }}
            >
              New program
            </Link>
          )}
        </div>
      </header>

      {/* The strip is absent for a writer, who has one half to look at and needs
          no control for choosing it. Settings are `requireOwner` on the server;
          a tab that led to a panel that is not rendered would be a door to a
          room this person is not in. */}
      {isOwner && (
        <nav className="mkttabs" aria-label="Which half of Rewards">
          {REWARDS_TABS.map((entry) => (
            <Link
              key={entry.key}
              className={`mkttabs__tab${tab === entry.key ? ' is-active' : ''}`}
              aria-current={tab === entry.key ? 'page' : undefined}
              /* Programs is the default, so it writes no param rather than
                 `?tab=programs` — the same rule the dashboard applies to every
                 default filter. */
              to={{
                pathname: '/marketing/rewards',
                search: entry.key === 'programs' ? '' : `?tab=${entry.key}`,
              }}
            >
              {entry.label}
            </Link>
          ))}
        </nav>
      )}

      <div className="mktscr__body">
        {/* The settings are their own request and their own failure: a 500 on
            them must not take the programs table with it, and the table is what
            somebody opened this screen for. */}
        {isOwner && tab === 'settings' && <SettingsPanel programs={programs} />}

        {tab === 'programs' && (
        <section className="mktpanel">
          <div className="mktpanel__head">
            <h2 className="mktpanel__title">Programs</h2>
          </div>

          {problem !== null ? (
            <div className="mktpanel__body">
              <div className="notice notice--danger" role="alert">
                <div>
                  <strong>The programs didn’t load.</strong> {problem}
                </div>
                <div className="notice__actions">
                  <button className="btn btn--outline btn--sm" onClick={() => void load()}>
                    Try again
                  </button>
                </div>
              </div>
            </div>
          ) : programs === null ? (
            loading && showSkeletons ? (
              <div className="mktpanel__body">
                {/* `.mktform__field` for its tight stack, not because this is a
                    field: three shimmering lines at about the rhythm the table's
                    first rows will land at. Ungapped they draw as one block. */}
                <div className="mktform__field" aria-hidden="true">
                  <Skeleton height={18} width="45%" />
                  <Skeleton height={18} width="70%" />
                  <Skeleton height={18} width="55%" />
                </div>
              </div>
            ) : null
          ) : programs.length === 0 ? (
            <div className="mktpanel__body">
              <p className="mktpanel__note">
                No programs yet. One is created for you when the section is installed — if this is
                empty, the migration has not been applied to this deployment.
              </p>
            </div>
          ) : (
            <ProgramsTable programs={programs} />
          )}
        </section>
        )}
      </div>
    </>
  );
}

/**
 * Every program as a row, with the two aggregates the list endpoint computes.
 *
 * `.mkttable` inside its scroller, and FOUR columns rather than the six a
 * program has facts: the labels ride as a sub-line under the name and the last
 * change rides under the status chip, because a config table with six columns is
 * a table that scrolls sideways on the phone this section is meant to be usable
 * from. The scroller is still there — it is the wrapper, never the page, that
 * moves.
 */
function ProgramsTable({ programs }: { programs: Program[] }) {
  return (
    <div className="mktpanel__body mktpanel__body--flush">
      <div className="mkttable__scroll">
        <table className="mkttable">
          <thead>
            <tr>
              <th scope="col">Program</th>
              <th scope="col">Rules</th>
              <th scope="col">Status</th>
              <th scope="col">Lifetime awarded</th>
            </tr>
          </thead>
          <tbody>
            {programs.map((program) => {
              const labels = labelsOf(program);
              return (
                <tr key={program.id}>
                  <td>
                    <Link
                      className="mkttable__link"
                      to={{
                        pathname: '/marketing/rewards',
                        search: `?id=${encodeURIComponent(program.id)}`,
                      }}
                    >
                      {program.name}
                    </Link>{' '}
                    {/* THE `seeded` COLUMN, not a key comparison: the chip means
                        "these words came out of the migration and nobody has
                        chosen them yet", which is a fact about the row. */}
                    {program.seeded && <span className="chip chip--draft">Seeded preset</span>}
                    <span className="mkttable__sub">
                      {program.pointsLabelSingular} · {program.pointsLabelPlural}
                      {program.unitLabelSingular !== null && ` · ${program.unitLabelSingular}`}
                    </span>
                  </td>
                  <td data-label="Rules">
                    {/* The rule in the program's own words, so two programs with
                        different units never read as the same rule. */}
                    {program.kind === 'unit_return' &&
                    program.minUnitsPerReturn !== null &&
                    program.pointsPerUnit !== null ? (
                      <span className="mktnum">
                        ≥ {fmtUnits(program.minUnitsPerReturn, labels)} · {program.pointsPerUnit}{' '}
                        per {labels.unit?.one ?? 'unit'}
                      </span>
                    ) : (
                      <span className="mkttable__sub">Given by hand</span>
                    )}
                  </td>
                  <td data-label="Status">
                    <span className={`chip mktchip--${program.status}`}>
                      {program.status === 'active' ? 'Active' : 'Paused'}
                    </span>
                    <span className="mkttable__sub">
                      Changed {safeFormat(WHEN, program.updatedAt)}
                    </span>
                  </td>
                  <td className="mkttable__num" data-label="Lifetime awarded">
                    {fmtPoints(program.awardedTotal, labels)}
                    {program.openReturns > 0 && (
                      <span className="mkttable__sub">{program.openReturns} open</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================================
// SETTINGS
// ============================================================================

/** The form's copy of the settings. Numbers are strings — a half-typed box is a
 *  string, and parsing on every keystroke turns "10" into 1 while it is typed. */
interface SettingsDraft {
  one: string;
  many: string;
  enabled: boolean;
  ratePoints: string;
  rateMinor: string;
  currency: string;
  minRedeem: string;
  maxBps: string;
  defaultProgramId: string;
}

const toDraft = (settings: MarketingSettings): SettingsDraft => ({
  one: settings.pointsLabelSingular,
  many: settings.pointsLabelPlural,
  enabled: settings.redemptionEnabled,
  ratePoints: String(settings.redemptionRatePoints),
  rateMinor: String(settings.redemptionRateMinor),
  currency: settings.redemptionCurrency,
  minRedeem: String(settings.minRedeemPoints),
  maxBps: String(settings.maxRedeemBps),
  defaultProgramId: settings.defaultReturnProgramId ?? NO_DEFAULT,
});

/**
 * The cross-program settings, which have no nav item of their own by design:
 * they are three decisions an owner makes once, and a seventh icon in the rail
 * for three decisions is a rail nobody scans.
 *
 * OWNER-ONLY, and rendered only for owners — so the request is not made at all
 * for a writer. `GET /settings` is `requireAuth` and would answer, but a screen
 * that fetches what it cannot show is a screen whose next reader adds a control.
 */
function SettingsPanel({ programs }: { programs: Program[] | null }) {
  const uid = useId();
  const { notify } = useToast();
  const [settings, setSettings] = useState<MarketingSettings | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [conflict, setConflict] = useState<MarketingSettings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    marketingApi
      .getSettings(ac.signal)
      .then((next) => {
        if (ac.signal.aborted) return;
        setSettings(next);
        setDraft(toDraft(next));
      })
      .catch((err: unknown) => {
        if (!ac.signal.aborted) setLoadProblem(explainLoad(err, 'The settings didn’t load.'));
      });
    return () => ac.abort();
  }, []);

  const errorFor = (field: string): string | null =>
    problem !== null && problem.field === field ? problem.message : null;

  /** Adopt an entity a 409 handed back — the losing form's values are replaced
   *  by the winning row's, which is what "theirs" means. */
  function adopt(fresh: MarketingSettings): void {
    setSettings(fresh);
    setDraft(toDraft(fresh));
    setConflict(null);
    setProblem(null);
  }

  async function save(): Promise<void> {
    if (settings === null || draft === null) return;
    setProblem(null);

    const one = draft.one.trim();
    const many = draft.many.trim();
    const ratePoints = int(draft.ratePoints);
    const rateMinor = int(draft.rateMinor);
    const minRedeem = int(draft.minRedeem);
    const maxBps = int(draft.maxBps);
    const currency = draft.currency.trim().toUpperCase();

    if (one === '') return setProblem({ field: 'pointsLabelSingular', message: fieldMessage('pointsLabelSingular') });
    if (many === '') return setProblem({ field: 'pointsLabelPlural', message: fieldMessage('pointsLabelPlural') });
    if (ratePoints === null || ratePoints < 1)
      return setProblem({ field: 'redemptionRatePoints', message: fieldMessage('redemptionRatePoints') });
    if (rateMinor === null)
      return setProblem({ field: 'redemptionRateMinor', message: fieldMessage('redemptionRateMinor') });
    /*
     * The column's own CHECK, refused here as well: `redemption_enabled` cannot
     * be true while the rate is zero, so posting it would be a 400 for a rule the
     * form already knows. The message goes under the RATE, because that is the
     * box that has to change — the switch is not the thing that is wrong.
     */
    if (draft.enabled && rateMinor === 0)
      return setProblem({
        field: 'redemptionRateMinor',
        message: 'Say what they are worth before letting customers spend them.',
      });
    if (minRedeem === null)
      return setProblem({ field: 'minRedeemPoints', message: fieldMessage('minRedeemPoints') });
    if (maxBps === null || maxBps < 1 || maxBps > 10000)
      return setProblem({ field: 'maxRedeemBps', message: fieldMessage('maxRedeemBps') });
    if (!/^[A-Z]{3}$/.test(currency))
      return setProblem({ field: 'redemptionCurrency', message: fieldMessage('redemptionCurrency') });

    const patch: SettingsPatch = {
      expectedRevision: settings.revision,
      pointsLabelSingular: one,
      pointsLabelPlural: many,
      redemptionEnabled: draft.enabled,
      redemptionRatePoints: ratePoints,
      redemptionRateMinor: rateMinor,
      redemptionCurrency: currency,
      minRedeemPoints: minRedeem,
      maxRedeemBps: maxBps,
      // A real `null`, and the one reason settings bodies are not run through
      // the client's empty-field pruner: "no default program" is a value.
      defaultReturnProgramId:
        draft.defaultProgramId === NO_DEFAULT ? null : draft.defaultProgramId,
    };

    setBusy(true);
    try {
      const next = await marketingApi.patchSettings(patch);
      setSettings(next);
      setDraft(toDraft(next));
      setConflict(null);
      notify('Settings saved');
    } catch (err) {
      const fresh = carried<MarketingSettings>(err, 'settings');
      if (err instanceof StaleWriteError && fresh !== null) setConflict(fresh);
      else if (err instanceof ApiError && err.status === 400 && err.detail !== undefined)
        setProblem({ field: err.detail, message: fieldMessage(err.detail) });
      else notify(explainWrite(err), { tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  const labels: ProgramLabels | null =
    draft === null
      ? null
      : { name: '', points: { one: draft.one || '…', other: draft.many || '…' }, unit: null };

  return (
    <section className="mktpanel">
      <div className="mktpanel__head">
        <h2 className="mktpanel__title">Settings</h2>
      </div>
      <div className="mktpanel__body">
        {loadProblem !== null && (
          <div className="notice notice--danger" role="alert">
            <div>
              <strong>The settings didn’t load.</strong> {loadProblem}
            </div>
          </div>
        )}

        {draft !== null && settings !== null && labels !== null && (
          <form
            className="mktform"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {conflict !== null && (
              <div className="notice notice--warn" role="alert">
                <div>
                  Somebody else saved these settings while this form was open. Nothing here was
                  written.
                </div>
                <div className="notice__actions">
                  <button
                    type="button"
                    className="btn btn--outline btn--sm"
                    onClick={() => adopt(conflict)}
                  >
                    Load theirs
                  </button>
                </div>
              </div>
            )}

            <div className="mktform__field">
              <span className="label">What a reward is called</span>
              <p className="mktform__hint">
                Used wherever an amount spans programs — a balance, a manual credit, the line at
                checkout. Each program keeps its own words for its own awards.
              </p>
              <div className="mktform__split">
                <div className="mktform__field">
                  <label className="label" htmlFor={`${uid}-one`}>
                    One award
                  </label>
                  <input
                    id={`${uid}-one`}
                    className="input"
                    value={draft.one}
                    maxLength={120}
                    onChange={(e) => setDraft({ ...draft, one: e.target.value })}
                  />
                  {errorFor('pointsLabelSingular') && (
                    <p className="mktform__error">{errorFor('pointsLabelSingular')}</p>
                  )}
                </div>
                <div className="mktform__field">
                  <label className="label" htmlFor={`${uid}-many`}>
                    More than one award
                  </label>
                  <input
                    id={`${uid}-many`}
                    className="input"
                    value={draft.many}
                    maxLength={120}
                    onChange={(e) => setDraft({ ...draft, many: e.target.value })}
                  />
                  {errorFor('pointsLabelPlural') && (
                    <p className="mktform__error">{errorFor('pointsLabelPlural')}</p>
                  )}
                </div>
              </div>
              {/* The two words, used. A plural that only reads well in a table
                  header is visible here before it is saved. */}
              <p className="mktform__hint">
                Balances read “{fmtPoints(1, labels)}” and “{fmtPoints(120, labels)}”.
              </p>
            </div>

            <div className="mktform__field">
              <span className="label">Spending at checkout</span>
              <div className="mktform__row">
                <Switch
                  checked={draft.enabled}
                  label="Let customers spend what they have earned"
                  onChange={(on) => {
                    /*
                     * GATED BY THE RATE, because the column is: the settings
                     * table CHECKs that redemption cannot be enabled while a
                     * reward is worth nothing. Refusing the flip here means the
                     * form never posts a body the database would reject, and the
                     * operator is told which box to fill in instead of which
                     * constraint they violated.
                     */
                    if (on && (int(draft.rateMinor) ?? 0) === 0) {
                      setProblem({
                        field: 'redemptionRateMinor',
                        message: 'Say what they are worth before letting customers spend them.',
                      });
                      return;
                    }
                    // The refusal above is cleared by the flip that succeeds:
                    // an error under a box somebody has just fixed is an error
                    // about nothing.
                    setProblem(null);
                    setDraft({ ...draft, enabled: on });
                  }}
                />
                <span className="mktform__hint">
                  {draft.enabled
                    ? 'On — the checkout offers a discount against a balance.'
                    : 'Off — balances are earned and shown, and nothing is spendable yet.'}
                </span>
              </div>
            </div>

            <div className="mktform__split">
              <div className="mktform__field">
                <label className="label" htmlFor={`${uid}-rate-points`}>
                  How many are spent
                </label>
                <input
                  id={`${uid}-rate-points`}
                  className="input"
                  inputMode="numeric"
                  value={draft.ratePoints}
                  maxLength={9}
                  onChange={(e) => setDraft({ ...draft, ratePoints: e.target.value })}
                />
                {errorFor('redemptionRatePoints') && (
                  <p className="mktform__error">{errorFor('redemptionRatePoints')}</p>
                )}
              </div>
              <div className="mktform__field">
                <label className="label" htmlFor={`${uid}-rate-minor`}>
                  What they take off
                </label>
                <input
                  id={`${uid}-rate-minor`}
                  className="input"
                  inputMode="numeric"
                  value={draft.rateMinor}
                  maxLength={9}
                  onChange={(e) => setDraft({ ...draft, rateMinor: e.target.value })}
                />
                {errorFor('redemptionRateMinor') ? (
                  <p className="mktform__error">{errorFor('redemptionRateMinor')}</p>
                ) : (
                  /*
                   * MINOR UNITS, SAID OUT LOUD. The rate is an integer rational —
                   * a numerator and a denominator, never a decimal — and this
                   * screen deliberately does not render it as money: the table of
                   * currency exponents lives in the shop's module, marketing does
                   * not import the shop, and a division by 100 here would be
                   * silently wrong for every currency that has no decimal places.
                   */
                  <p className="mktform__hint">
                    In minor units — 500 is five whole {draft.currency || 'units'} where the
                    currency has two decimal places.
                  </p>
                )}
              </div>
            </div>

            <div className="mktform__split">
              <div className="mktform__field">
                <label className="label" htmlFor={`${uid}-currency`}>
                  Currency
                </label>
                <input
                  id={`${uid}-currency`}
                  className="input"
                  value={draft.currency}
                  maxLength={3}
                  // Uppercased as it is typed rather than at submit: the column's
                  // CHECK is `~ '^[A-Z]{3}$'`, and a box that shows "ngn" while
                  // meaning NGN is a box that will be retyped.
                  onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })}
                />
                {errorFor('redemptionCurrency') && (
                  <p className="mktform__error">{errorFor('redemptionCurrency')}</p>
                )}
              </div>
              <div className="mktform__field">
                <label className="label" htmlFor={`${uid}-min-redeem`}>
                  Smallest amount spendable
                </label>
                <input
                  id={`${uid}-min-redeem`}
                  className="input"
                  inputMode="numeric"
                  value={draft.minRedeem}
                  maxLength={9}
                  onChange={(e) => setDraft({ ...draft, minRedeem: e.target.value })}
                />
                {errorFor('minRedeemPoints') ? (
                  <p className="mktform__error">{errorFor('minRedeemPoints')}</p>
                ) : (
                  <p className="mktform__hint">Zero for no minimum.</p>
                )}
              </div>
            </div>

            <div className="mktform__field">
              <label className="label" htmlFor={`${uid}-max-bps`}>
                Most of an order they may pay for
              </label>
              <input
                id={`${uid}-max-bps`}
                className="input"
                inputMode="numeric"
                value={draft.maxBps}
                maxLength={5}
                onChange={(e) => setDraft({ ...draft, maxBps: e.target.value })}
              />
              {errorFor('maxRedeemBps') ? (
                <p className="mktform__error">{errorFor('maxRedeemBps')}</p>
              ) : (
                <p className="mktform__hint">
                  In basis points, so a whole number can say a half:{' '}
                  {((int(draft.maxBps) ?? 0) / 100).toLocaleString()}% of an order. 10000 is all of
                  it.
                </p>
              )}
            </div>

            <div className="mktform__field">
              <span className="label">Program a return goes to by default</span>
              {programs === null ? (
                <p className="mktform__hint">Loading the programs…</p>
              ) : (
                <Select
                  label="Program a return goes to by default"
                  value={draft.defaultProgramId}
                  /*
                   * Paused programs are OFFERED, and said to be paused. Pausing
                   * the default is an ordinary thing to do, and dropping it from
                   * the list would leave this control showing a value it has no
                   * option for — blank, with the operator's saved choice
                   * invisible. Naming the state instead says what will happen:
                   * an intake against it answers `program_paused`.
                   */
                  options={[
                    { value: NO_DEFAULT, label: 'No default' },
                    ...programs
                      .filter((p) => p.kind === 'unit_return')
                      .map((p) => ({
                        value: p.id,
                        label: p.status === 'paused' ? `${p.name} — paused` : p.name,
                      })),
                  ]}
                  onChange={(value) => setDraft({ ...draft, defaultProgramId: value })}
                />
              )}
              {errorFor('defaultReturnProgramId') ? (
                <p className="mktform__error">{errorFor('defaultReturnProgramId')}</p>
              ) : (
                <p className="mktform__hint">
                  Used when a return is logged without naming a program. With no default, every
                  intake has to pick one.
                </p>
              )}
            </div>

            {problem !== null && problem.field === null && (
              <p className="mktform__error" role="alert">
                {problem.message}
              </p>
            )}

            <div className="mktform__actions">
              <button type="submit" className="btn btn--primary" disabled={busy}>
                Save settings
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}

// ============================================================================
// EDITOR
// ============================================================================

/** The form's copy of a program. Strings throughout, for the reason
 *  `SettingsDraft` gives: a number being typed is not yet a number. */
interface EditDraft {
  key: string;
  kind: Program['kind'];
  name: string;
  one: string;
  many: string;
  unitOne: string;
  unitMany: string;
  min: string;
  rate: string;
  status: Program['status'];
}

const BLANK: EditDraft = {
  key: '',
  kind: 'unit_return',
  name: '',
  one: '',
  many: '',
  unitOne: '',
  unitMany: '',
  min: '',
  rate: '',
  status: 'active',
};

const fromProgram = (program: Program): EditDraft => ({
  key: program.key,
  kind: program.kind,
  name: program.name,
  one: program.pointsLabelSingular,
  many: program.pointsLabelPlural,
  unitOne: program.unitLabelSingular ?? '',
  unitMany: program.unitLabelPlural ?? '',
  min: program.minUnitsPerReturn === null ? '' : String(program.minUnitsPerReturn),
  rate: program.pointsPerUnit === null ? '' : String(program.pointsPerUnit),
  status: program.status,
});

/** The draft, as the plain-words panel needs it. */
function ruleDraftOf(draft: EditDraft): RuleDraft {
  return {
    kind: draft.kind,
    labels: {
      name: draft.name,
      points: { one: draft.one || '…', other: draft.many || '…' },
      unit:
        draft.unitOne || draft.unitMany
          ? { one: draft.unitOne || '…', other: draft.unitMany || '…' }
          : null,
    },
    minUnitsPerReturn: int(draft.min),
    pointsPerUnit: int(draft.rate),
  };
}

/**
 * One program, or a new one.
 *
 * THERE IS NO `GET /programs/:id` IN THE CONTRACT and this screen does not
 * pretend otherwise: the editor reads the list and finds its row, which is one
 * request for a table that is three rows long on every deployment this ships to.
 * An id nothing matches is the `gone` treatment — an explanation and a way back,
 * never a retry.
 *
 * THERE IS NO DELETE, here or anywhere. Ledger rows, return requests and the
 * settings' default all point at a program; a program that stops being wanted is
 * paused, and its history stays legible.
 */
function ProgramEditor({ id }: { id: string }) {
  const creating = id === 'new';
  const uid = useId();
  const isOwner = useIsOwner();
  const navigate = useNavigate();
  const { notify } = useToast();

  const [program, setProgram] = useState<Program | null>(null);
  const [draft, setDraft] = useState<EditDraft>(BLANK);
  const [loading, setLoading] = useState(!creating);
  const [missing, setMissing] = useState(false);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [conflict, setConflict] = useState<Program | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);
  const showSkeletons = useDelayed(loading);

  useEffect(() => {
    if (creating) return;
    const ac = new AbortController();
    marketingApi
      .listPrograms(ac.signal)
      .then((all) => {
        if (ac.signal.aborted) return;
        const found = all.find((p) => p.id === id) ?? null;
        if (found === null) setMissing(true);
        else {
          setProgram(found);
          setDraft(fromProgram(found));
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setLoadProblem(explainLoad(err, 'The program didn’t load.'));
        setLoading(false);
      });
    return () => ac.abort();
  }, [creating, id]);

  const errorFor = (field: string): string | null =>
    problem !== null && problem.field === field ? problem.message : null;

  const backTo = { pathname: '/marketing/rewards', search: '' };

  /** Everything both halves of the submit need, or the field that is wrong. */
  function readDraft():
    | { ok: true; name: string; one: string; many: string; unit: { one: string; many: string; min: number; rate: number } | null }
    | { ok: false; problem: Problem } {
    const name = draft.name.trim();
    const one = draft.one.trim();
    const many = draft.many.trim();
    if (name === '') return { ok: false, problem: { field: 'name', message: fieldMessage('name') } };
    if (one === '')
      return { ok: false, problem: { field: 'pointsLabelSingular', message: fieldMessage('pointsLabelSingular') } };
    if (many === '')
      return { ok: false, problem: { field: 'pointsLabelPlural', message: fieldMessage('pointsLabelPlural') } };

    if (draft.kind === 'adhoc') return { ok: true, name, one, many, unit: null };

    const unitOne = draft.unitOne.trim();
    const unitMany = draft.unitMany.trim();
    const min = int(draft.min);
    const rate = int(draft.rate);
    if (unitOne === '')
      return { ok: false, problem: { field: 'unitLabelSingular', message: fieldMessage('unitLabelSingular') } };
    if (unitMany === '')
      return { ok: false, problem: { field: 'unitLabelPlural', message: fieldMessage('unitLabelPlural') } };
    if (min === null || min < 1)
      return { ok: false, problem: { field: 'minUnitsPerReturn', message: fieldMessage('minUnitsPerReturn') } };
    if (rate === null || rate < 1)
      return { ok: false, problem: { field: 'pointsPerUnit', message: fieldMessage('pointsPerUnit') } };
    return { ok: true, name, one, many, unit: { one: unitOne, many: unitMany, min, rate } };
  }

  async function create(): Promise<void> {
    const read = readDraft();
    if (!read.ok) return setProblem(read.problem);
    const key = draft.key.trim();
    if (!KEY_RE.test(key)) return setProblem({ field: 'key', message: fieldMessage('key') });

    const body: ProgramDraft = {
      key,
      kind: draft.kind,
      name: read.name,
      pointsLabelSingular: read.one,
      pointsLabelPlural: read.many,
      // Absent, not empty, for an `adhoc` program: the kind-coupling CHECK says
      // the four columns are all null or all set, and `''` is neither.
      ...(read.unit === null
        ? {}
        : {
            unitLabelSingular: read.unit.one,
            unitLabelPlural: read.unit.many,
            minUnitsPerReturn: read.unit.min,
            pointsPerUnit: read.unit.rate,
          }),
    };

    setBusy(true);
    setProblem(null);
    try {
      const made = await marketingApi.createProgram(body);
      notify(`${made.name} created`);
      navigate(backTo);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'duplicate_program_key')
        setProblem({ field: 'key', message: 'That handle is taken by another program.' });
      else if (err instanceof ApiError && err.status === 400 && err.detail !== undefined)
        setProblem({ field: err.detail, message: fieldMessage(err.detail) });
      else notify(explainWrite(err), { tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  async function update(): Promise<void> {
    if (program === null) return;
    const read = readDraft();
    if (!read.ok) return setProblem(read.problem);

    /*
     * NO `key`, NO `kind` — not for an ad-hoc program, not for the seeded preset,
     * not ever. The type has no room for either and the server's schema is
     * `.strict()`; between them, the identity every ledger row points at cannot
     * move because somebody edited a label.
     */
    const patch: ProgramPatch = {
      expectedRevision: program.revision,
      name: read.name,
      pointsLabelSingular: read.one,
      pointsLabelPlural: read.many,
      status: draft.status,
      ...(read.unit === null
        ? {}
        : {
            unitLabelSingular: read.unit.one,
            unitLabelPlural: read.unit.many,
            minUnitsPerReturn: read.unit.min,
            pointsPerUnit: read.unit.rate,
          }),
    };

    setBusy(true);
    setProblem(null);
    try {
      const next = await marketingApi.patchProgram(program.id, patch);
      setProgram(next);
      setDraft(fromProgram(next));
      setConflict(null);
      notify('Program saved');
    } catch (err) {
      const fresh = carried<Program>(err, 'program');
      if (err instanceof StaleWriteError && fresh !== null) setConflict(fresh);
      /* No `duplicate_program_key` arm here, deliberately: a patch cannot carry a
         key, so the only way to receive that code on this request is for the
         invariant above to have been broken — and answering it with a message
         under the Name box would say a handle collided while pointing at a field
         that is not the handle. It falls through to the generic write failure. */
      else if (err instanceof ApiError && err.status === 400 && err.detail !== undefined)
        setProblem({ field: err.detail, message: fieldMessage(err.detail) });
      else if (err instanceof NotFoundError) setMissing(true);
      else notify(explainWrite(err), { tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  /**
   * Pausing a program with returns already in flight is confirmed, not blocked.
   *
   * It is a legitimate thing to do — the point of pausing is to stop NEW requests
   * — and the confirmation exists to say so, because "paused" reads like a stop
   * button and the returns already booked are going to finish and be awarded
   * regardless. Nothing else on this form asks: renaming is safe by construction.
   */
  const pausing = program !== null && program.status === 'active' && draft.status === 'paused';
  const needsPauseConfirm = pausing && program !== null && program.openReturns > 0;

  function submit(): void {
    if (creating) {
      void create();
      return;
    }
    // The form is read BEFORE the confirmation, not after it: asking somebody to
    // agree to a pause and then refusing the save for an empty label is two
    // decisions in the wrong order, and the second one arrives behind a dialog
    // that has already closed.
    const read = readDraft();
    if (!read.ok) return setProblem(read.problem);
    if (needsPauseConfirm) {
      setConfirmPause(true);
      return;
    }
    void update();
  }

  // ------------------------------------------------------------------ states
  if (missing) {
    return (
      <>
        <header className="mktscr__head">
          <h1 className="mktscr__title">Rewards</h1>
        </header>
        <div className="mktscr__body">
          <div className="empty">
            <div className="empty__mark" aria-hidden="true">
              <Award />
            </div>
            <h2 className="empty__title">That program no longer exists</h2>
            <p className="empty__body">
              It may have been opened from a stale link. Programs are never deleted, so this is a
              link to something that was never there.
            </p>
            <Link className="btn btn--outline" to={backTo}>
              Back to programs
            </Link>
          </div>
        </div>
      </>
    );
  }

  if (!creating && program === null) {
    return (
      <>
        <header className="mktscr__head">
          <h1 className="mktscr__title">Rewards</h1>
        </header>
        <div className="mktscr__body">
          {loadProblem !== null ? (
            <div className="notice notice--danger" role="alert">
              <div>
                <strong>The program didn’t load.</strong> {loadProblem}
              </div>
              <div className="notice__actions">
                <Link className="btn btn--outline btn--sm" to={backTo}>
                  Back to programs
                </Link>
              </div>
            </div>
          ) : loading && showSkeletons ? (
            <div className="mktform__field" aria-hidden="true">
              <Skeleton height={20} width="40%" />
              <Skeleton height={20} width="65%" />
              <Skeleton height={20} width="55%" />
            </div>
          ) : null}
        </div>
      </>
    );
  }

  const rule = ruleDraftOf(draft);
  /* The smallest award the rules can produce — a real subject line rather than a
     figure nobody will ever see. A program that awards by hand has no rules to
     read one off, and one is the amount whose wording is easiest to get wrong. */
  const sample =
    rule.kind === 'unit_return' && rule.minUnitsPerReturn !== null && rule.pointsPerUnit !== null
      ? Math.max(1, rule.minUnitsPerReturn * rule.pointsPerUnit)
      : 1;

  return (
    <>
      <header className="mktscr__head">
        <div className="mktscr__headrow">
          <div>
            <Link className="btn btn--ghost btn--sm" to={backTo}>
              All programs
            </Link>
            <h1 className="mktscr__title">{creating ? 'New program' : draft.name || 'Program'}</h1>
            <p className="mktscr__lede">
              {creating
                ? 'The handle and the kind are chosen once. Everything else is wording you can change whenever you like.'
                : 'Every word here is shown to customers. Changing one changes what they are told from now on — never what they were told before.'}
            </p>
          </div>
        </div>
      </header>

      <div className="mktscr__body">
        {/*
          THREE GRID CHILDREN, and the third one is why this is not two columns
          of panels: above 900px the form sits left, the restatement sits right
          and the actions land under the form; below it the single column reads
          form → restatement → Save, which puts the plain-words panel directly
          above the button that commits it. A phone confirms what it is about to
          write immediately before writing it.
        */}
        <div className="mktgrid">
          {isOwner ? (
            /* `.mktgrid__col` on the FORM rather than on a div around it: the
               column already stacks its panels at the grid's own rhythm, and a
               `.mktform` here would add its gap on top of the panels' stacking
               margin. One spacing rule per stack. */
            <form
              className="mktgrid__col"
              id={`${uid}-form`}
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              {conflict !== null && (
                <div className="notice notice--warn" role="alert">
                  <div>
                    Somebody else saved this program while the form was open — it is now called{' '}
                    <strong>{conflict.name}</strong>. Nothing here was written.
                  </div>
                  <div className="notice__actions">
                    <button
                      type="button"
                      className="btn btn--outline btn--sm"
                      onClick={() => {
                        // No second fetch: the 409 carried the whole row.
                        setProgram(conflict);
                        setDraft(fromProgram(conflict));
                        setConflict(null);
                        setProblem(null);
                      }}
                    >
                      Load theirs
                    </button>
                  </div>
                </div>
              )}

              <section className="mktpanel">
                <div className="mktpanel__head">
                  <h2 className="mktpanel__title">What it’s called</h2>
                </div>
                <div className="mktpanel__body">
                  <div className="mktform">
                    {creating && (
                      <>
                        <div className="mktform__field">
                          <label className="label" htmlFor={`${uid}-key`}>
                            Handle
                          </label>
                          <input
                            id={`${uid}-key`}
                            className="input"
                            value={draft.key}
                            maxLength={120}
                            placeholder="bottle-returns"
                            onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                          />
                          {errorFor('key') ? (
                            <p className="mktform__error">{errorFor('key')}</p>
                          ) : (
                            <p className="mktform__hint">
                              Lowercase letters, numbers, dashes and underscores, starting with a
                              letter or a number. It is never shown to a customer and it can
                              never be changed — every award ever made points at it, which is
                              what makes renaming everything else safe.
                            </p>
                          )}
                        </div>

                        <div className="mktform__field">
                          <span className="label" id={`${uid}-kind-label`}>
                            What it awards for
                          </span>
                          <div
                            className="mktseg"
                            role="radiogroup"
                            aria-labelledby={`${uid}-kind-label`}
                          >
                            {KINDS.map((kind) => (
                              <label className="mktseg__opt" key={kind.value}>
                                <input
                                  className="visually-hidden"
                                  type="radio"
                                  name={`${uid}-kind`}
                                  value={kind.value}
                                  checked={draft.kind === kind.value}
                                  onChange={() => setDraft({ ...draft, kind: kind.value })}
                                />
                                <span>{kind.label}</span>
                              </label>
                            ))}
                          </div>
                          <p className="mktform__hint">
                            {KINDS.find((k) => k.value === draft.kind)?.hint} This is chosen once
                            as well.
                          </p>
                        </div>
                      </>
                    )}

                    <div className="mktform__field">
                      <label className="label" htmlFor={`${uid}-name`}>
                        Name
                      </label>
                      <input
                        id={`${uid}-name`}
                        className="input"
                        value={draft.name}
                        maxLength={300}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      />
                      {errorFor('name') ? (
                        <p className="mktform__error">{errorFor('name')}</p>
                      ) : (
                        <p className="mktform__hint">
                          Shown to customers everywhere — emails included.
                        </p>
                      )}
                    </div>

                    <div className="mktform__field">
                      <span className="label">What one award is called</span>
                      <div className="mktform__split">
                        <div className="mktform__field">
                          <label className="label" htmlFor={`${uid}-one`}>
                            One award
                          </label>
                          <input
                            id={`${uid}-one`}
                            className="input"
                            value={draft.one}
                            maxLength={120}
                            onChange={(e) => setDraft({ ...draft, one: e.target.value })}
                          />
                          {errorFor('pointsLabelSingular') && (
                            <p className="mktform__error">{errorFor('pointsLabelSingular')}</p>
                          )}
                        </div>
                        <div className="mktform__field">
                          <label className="label" htmlFor={`${uid}-many`}>
                            More than one award
                          </label>
                          <input
                            id={`${uid}-many`}
                            className="input"
                            value={draft.many}
                            maxLength={120}
                            onChange={(e) => setDraft({ ...draft, many: e.target.value })}
                          />
                          {errorFor('pointsLabelPlural') && (
                            <p className="mktform__error">{errorFor('pointsLabelPlural')}</p>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* The unit words describe the thing coming back, so a
                        program where nothing comes back does not have them —
                        and the column CHECK agrees: for `adhoc` all four rule
                        columns are null together. */}
                    {draft.kind === 'unit_return' && (
                      <div className="mktform__field">
                        <span className="label">What one returned thing is called</span>
                        <div className="mktform__split">
                          <div className="mktform__field">
                            <label className="label" htmlFor={`${uid}-unit-one`}>
                              One item
                            </label>
                            <input
                              id={`${uid}-unit-one`}
                              className="input"
                              value={draft.unitOne}
                              maxLength={120}
                              onChange={(e) => setDraft({ ...draft, unitOne: e.target.value })}
                            />
                            {errorFor('unitLabelSingular') && (
                              <p className="mktform__error">{errorFor('unitLabelSingular')}</p>
                            )}
                          </div>
                          <div className="mktform__field">
                            <label className="label" htmlFor={`${uid}-unit-many`}>
                              More than one item
                            </label>
                            <input
                              id={`${uid}-unit-many`}
                              className="input"
                              value={draft.unitMany}
                              maxLength={120}
                              onChange={(e) => setDraft({ ...draft, unitMany: e.target.value })}
                            />
                            {errorFor('unitLabelPlural') && (
                              <p className="mktform__error">{errorFor('unitLabelPlural')}</p>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </section>

              {draft.kind === 'unit_return' && (
                <section className="mktpanel">
                  <div className="mktpanel__head">
                    <h2 className="mktpanel__title">The rules</h2>
                  </div>
                  <div className="mktpanel__body">
                    <div className="mktform">
                      <div className="mktform__split">
                        <div className="mktform__field">
                          <label className="label" htmlFor={`${uid}-min`}>
                            Smallest request
                          </label>
                          <input
                            id={`${uid}-min`}
                            className="input"
                            inputMode="numeric"
                            value={draft.min}
                            maxLength={9}
                            onChange={(e) => setDraft({ ...draft, min: e.target.value })}
                          />
                          {errorFor('minUnitsPerReturn') ? (
                            <p className="mktform__error">{errorFor('minUnitsPerReturn')}</p>
                          ) : (
                            <p className="mktform__hint">
                              Fewer than this and a request is refused, so a driver is never sent
                              for one item.
                            </p>
                          )}
                        </div>
                        <div className="mktform__field">
                          <label className="label" htmlFor={`${uid}-rate`}>
                            Awarded for each accepted one
                          </label>
                          <input
                            id={`${uid}-rate`}
                            className="input"
                            inputMode="numeric"
                            value={draft.rate}
                            maxLength={9}
                            onChange={(e) => setDraft({ ...draft, rate: e.target.value })}
                          />
                          {errorFor('pointsPerUnit') ? (
                            <p className="mktform__error">{errorFor('pointsPerUnit')}</p>
                          ) : (
                            <p className="mktform__hint">
                              Copied onto every request when it is made, so changing it never
                              reprices a return somebody was already promised.
                            </p>
                          )}
                        </div>
                      </div>
                      <p className="mktform__hint">
                        Conditions beyond these two — expiry, multipliers, a busier season —
                        arrive as configuration on this row rather than as a new form.
                      </p>
                    </div>
                  </div>
                </section>
              )}

              {/* Create has no status: a new program is active, and pausing one
                  is a decision about a program that exists. The POST body has
                  no `status` field either (contract #2). */}
              {!creating && (
                <section className="mktpanel">
                  <div className="mktpanel__head">
                    <h2 className="mktpanel__title">Status</h2>
                  </div>
                  <div className="mktpanel__body">
                    <div className="mktform__field">
                      <div className="mktform__row">
                        <Switch
                          checked={draft.status === 'active'}
                          label="Accepting new return requests"
                          onChange={(on) =>
                            setDraft({ ...draft, status: on ? 'active' : 'paused' })
                          }
                        />
                        <span className="mktform__hint">
                          {draft.status === 'active' ? 'Active' : 'Paused'}
                        </span>
                      </div>
                      {errorFor('status') ? (
                        <p className="mktform__error">{errorFor('status')}</p>
                      ) : (
                        <p className="mktform__hint">
                          Paused programs stop accepting new return requests; open returns finish
                          normally. Programs are never deleted — everything ever awarded points
                          at them.
                        </p>
                      )}
                    </div>
                  </div>
                </section>
              )}

              {problem !== null && problem.field === null && (
                <p className="mktform__error" role="alert">
                  {problem.message}
                </p>
              )}
            </form>
          ) : (
            <div className="mktgrid__col">
              <ReadOnlyProgram program={program} />
            </div>
          )}

          <section className="mktpanel mktside">
            <div className="mktpanel__head">
              <h2 className="mktpanel__title">In plain words</h2>
            </div>
            <div className="mktpanel__body">
              {/* `.mktform`'s stack, on something that submits nothing: this
                  panel is the form restated, and reading at the form's own
                  rhythm is what lets the eye move between the two. */}
              <div className="mktform">
                <RuleSentence draft={rule} />
                <NamingPreview labels={rule.labels} points={sample} />
                <p className="mktform__hint">
                  A balance of one reads “{fmtPoints(1, rule.labels)}”, and of a hundred and twenty
                  “{fmtPoints(120, rule.labels)}”.
                </p>
                {program?.seeded === true && (
                  <p className="mktform__hint">
                    <span className="chip chip--draft">Seeded preset</span> These words came with
                    the section and are placeholders. Renaming is safe — everything already awarded
                    keeps the wording it was awarded in.
                  </p>
                )}
              </div>
            </div>
          </section>

          {isOwner && (
            <div className="mktform__actions">
              <button
                type="submit"
                form={`${uid}-form`}
                className="btn btn--primary"
                disabled={busy}
              >
                {creating ? 'Create program' : 'Save program'}
              </button>
              <Link className="btn btn--ghost" to={backTo}>
                Cancel
              </Link>
            </div>
          )}
        </div>
      </div>

      {program !== null && (
        <ConfirmDialog
          open={confirmPause}
          onClose={() => setConfirmPause(false)}
          onConfirm={() => void update()}
          sheet
          title={`Pause ${program.name}?`}
          /* A count of REQUESTS, so it is a plain number: "returns" is this
             section's own word for them, not one of the program's configurable
             nouns, and formatting it through the unit labels would say five
             canisters where five requests are meant. */
          description={`${program.openReturns} return${program.openReturns === 1 ? ' is' : 's are'} already open — they will be picked up, inspected and awarded as normal. Pausing only refuses new ones.`}
          confirmLabel="Pause it"
        />
      )}
    </>
  );
}

/**
 * A program as reference, for somebody who may not change it.
 *
 * `.mktkv` rather than disabled inputs: the role matrix makes program writes
 * owner-only, and a form full of dead boxes says "you could edit this" in the
 * one place the server will answer 403.
 */
function ReadOnlyProgram({ program }: { program: Program | null }) {
  /* Only reachable by typing `?id=new` as a writer — the control that leads
     here is absent for them. Said plainly rather than left blank. */
  if (program === null) {
    return (
      <section className="mktpanel">
        <div className="mktpanel__body">
          <p className="mktpanel__note">
            Only the owner can create a program. The words and rules of the ones that exist are
            below, on each program’s own page.
          </p>
        </div>
      </section>
    );
  }
  const labels = labelsOf(program);

  return (
    <section className="mktpanel">
      <div className="mktpanel__head">
        <h2 className="mktpanel__title">What it’s called</h2>
      </div>
      <div className="mktpanel__body">
        <div className="mktkv">
          <span className="mktkv__k">Name</span>
          <span className="mktkv__v">{program.name}</span>
          <span className="mktkv__k">Handle</span>
          <span className="mktkv__v mktkv__v--id">{program.key}</span>
          <span className="mktkv__k">One award</span>
          <span className="mktkv__v">{program.pointsLabelSingular}</span>
          <span className="mktkv__k">More than one</span>
          <span className="mktkv__v">{program.pointsLabelPlural}</span>
          {program.unitLabelSingular !== null && program.unitLabelPlural !== null && (
            <>
              <span className="mktkv__k">One returned thing</span>
              <span className="mktkv__v">{program.unitLabelSingular}</span>
              <span className="mktkv__k">More than one</span>
              <span className="mktkv__v">{program.unitLabelPlural}</span>
            </>
          )}
          <span className="mktkv__rule" />
          {program.minUnitsPerReturn !== null && (
            <>
              <span className="mktkv__k">Smallest request</span>
              <span className="mktkv__v">{fmtUnits(program.minUnitsPerReturn, labels)}</span>
            </>
          )}
          {program.pointsPerUnit !== null && (
            <>
              <span className="mktkv__k">Each accepted one</span>
              <span className="mktkv__v">{fmtPoints(program.pointsPerUnit, labels)}</span>
            </>
          )}
          <span className="mktkv__k">Status</span>
          <span className="mktkv__v">
            <span className={`chip mktchip--${program.status}`}>
              {program.status === 'active' ? 'Active' : 'Paused'}
            </span>
          </span>
          <span className="mktkv__k">Lifetime awarded</span>
          <span className="mktkv__v">{fmtPoints(program.awardedTotal, labels)}</span>
        </div>
      </div>
    </section>
  );
}

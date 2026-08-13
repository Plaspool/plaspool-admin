import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Award, RotateCcw, TicketPercent, Wallet } from 'lucide-react';
import {
  deriveBannerStatus,
  fmtPoints,
  fmtUnits,
  labelsOf,
  marketingApi,
  settingsLabels,
  type Banner,
  type DerivedBannerStatus,
  type LedgerEntry,
  type MarketingSummary,
  type Program,
  type ProgramLabels,
  type ReturnAction,
  type ReturnListItem,
} from '../data/api-marketing';
import { ApiError, NotFoundError, OfflineError } from '../data/errors';
import { Skeleton } from '../components/ui/Feedback';
import { useDelayed } from '../components/ui/useDelayed';
import { ACTION_VERB, STATUS_LABEL } from './marketing/StageForm';
import './marketing.css';

/**
 * The section's front door: what is waiting on somebody, what customers have
 * earned, and what the site is showing.
 *
 * THREE REGIONS, THREE REQUESTS, AND THAT IS DELIBERATE — the opposite call to
 * the shop's overview, which insists on one. The figures below are a workload,
 * not a reconciliation: "two waiting to be scheduled" and "no banners yet" are
 * true separately, and nothing here is subtracted from anything else. So each
 * region asks for its own and fails on its own — a 500 on the summary must not
 * take the first-run checklist down with it, because the checklist is what a
 * first-day operator opened this screen for and the summary is a row of zeros.
 *
 * `GET /summary` is the tiles and the three panels. `GET /programs` is the
 * checklist's first two lines (the seeded preset's `revision` is the only
 * honest signal for "nobody has looked at the placeholder wording yet"). `GET
 * /settings` is ONE WORD — the cross-program name for a point — and it is
 * fetched rather than assumed because there is no such word in this file: a
 * ledger row without it renders the bare number instead, which is the correct
 * degrade for a screen whose section can be renamed on day one.
 *
 * WHAT IT WILL NOT DO IS WRITE. Every row here carries the server's own next
 * action as a LINK to the screen that performs it. A dialog on this screen
 * would be a second, smaller copy of the queue's — with its own conflict
 * handling, its own re-fetch and its own drift — and the queue is one tap away.
 */

const HOUR = 3_600_000;

/**
 * The waiting bands, and they are the queue's own: a tile and the rows it
 * counts must not disagree about what "late" means, and the row in this
 * screen's own panel is the same row the queue draws. Text and colour, never
 * colour alone — `.mktage--danger` says nothing by itself.
 */
const WARN_MS = 48 * HOUR;
const DANGER_MS = 96 * HOUR;

/** How many ledger rows the panel is willing to draw. The server sends ≤8. */
const LEDGER_ROWS = 8;

const WHEN = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * "3h", "4d" — coarse on purpose, and the same bands the queue reads a wait in:
 * nobody chases a driver by the minute, and two screens describing one wait in
 * two vocabularies is two things to reconcile in a support call.
 *
 * Declared here rather than imported from the queue for the reason every screen
 * in this repository declares its own `WHEN`: a screen file is a screen, not a
 * module other screens reach into.
 */
function ago(ms: number): string {
  const hours = Math.floor(ms / HOUR);
  if (hours < 1) return 'under an hour';
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Which band a wait falls in — the queue's two thresholds, not a second set. */
function ageModifier(ms: number): string {
  if (ms >= DANGER_MS) return ' mktage--danger';
  if (ms >= WARN_MS) return ' mktage--warn';
  return '';
}

/**
 * The one step a return is waiting for, or null when it is waiting for nobody.
 *
 * `allowedActions[0]` — ordered by contract, the pipeline-advancing action
 * first (spec D4) — and never a status→action map of this screen's own. `note`
 * is not a step: it is the only action a closed return allows, and "Add a note"
 * is not what an operator scanning the oldest open returns is being asked for.
 */
function nextStep(row: ReturnListItem): ReturnAction | null {
  const first = row.allowedActions?.[0];
  return first === undefined || first === 'note' ? null : first;
}

/** A mark per ledger kind, because eight condensed rows are skimmed. */
const LEDGER_ICON = {
  return_award: Award,
  manual: Wallet,
  redemption: TicketPercent,
  redemption_release: RotateCcw,
} as const;

/**
 * A banner's DERIVED status, chipped.
 *
 * `draft` and `archived` borrow `base.css`'s chips unchanged; the three that
 * are about the clock get the `bnr` family, because "scheduled" already means
 * something else three panels to the left (a return with a driver booked).
 */
const BANNER_CHIP: Record<DerivedBannerStatus, string> = {
  draft: 'chip--draft',
  scheduled: 'bnrchip--scheduled',
  live: 'bnrchip--live',
  ended: 'bnrchip--ended',
  archived: 'chip--archived',
};

const BANNER_WHAT: Record<DerivedBannerStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  live: 'Live',
  ended: 'Ended',
  archived: 'Archived',
};

const PLACEMENT_WHAT: Record<Banner['placement'], string> = {
  top_bar: 'top bar',
  popup: 'popup',
  section: 'in-page section',
};

/** The failure, in a sentence an operator can act on. */
function explain(err: unknown): string {
  if (err instanceof OfflineError) return 'The request didn’t reach the server.';
  if (err instanceof NotFoundError) return 'This deployment has no marketing summary route yet.';
  if (err instanceof ApiError) {
    if (err.status === 403) return 'Your account isn’t allowed to read these.';
    if (err.status >= 500) {
      return err.requestId === undefined
        ? 'Something went wrong on the server.'
        : `Something went wrong on the server — reference ${err.requestId}.`;
    }
  }
  return 'The blog answered with an error.';
}

/** One line of the first-run card: what to do, why, and where. */
interface Step {
  key: string;
  what: string;
  why: string;
  to: string;
  go: string;
}

export default function MarketingOverview() {
  const [summary, setSummary] = useState<MarketingSummary | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Held back 250ms, for the reason the shop's overview gives: a warm route
  // answers faster than a person perceives, and a skeleton that flashes reads
  // as a fault rather than as loading.
  const showSkeletons = useDelayed(loading);

  /**
   * The two soft regions. `null` means UNKNOWN — in flight, or the request
   * failed — and unknown is not the same as empty anywhere below: the checklist
   * omits the lines it cannot vouch for rather than claiming a program nobody
   * has read is untouched, and the ledger drops the points word rather than
   * inventing one.
   */
  const [programs, setPrograms] = useState<Program[] | null>(null);
  const [points, setPoints] = useState<ProgramLabels | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    setProblem(null);
    return marketingApi
      .getSummary(signal)
      .then((next) => {
        if (signal?.aborted) return;
        setSummary(next);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (signal?.aborted) return;
        setProblem(explain(err));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  useEffect(() => {
    const ac = new AbortController();
    marketingApi
      .listPrograms(ac.signal)
      .then((next) => {
        if (!ac.signal.aborted) setPrograms(next);
      })
      .catch(() => {
        /* Soft: the checklist simply cannot speak for the preset. */
      });
    marketingApi
      .getSettings(ac.signal)
      .then((next) => {
        if (!ac.signal.aborted) setPoints(settingsLabels(next));
      })
      .catch(() => {
        /* Soft: the ledger renders bare numbers. See the state's own note. */
      });
    return () => ac.abort();
  }, []);

  /**
   * THE FIRST-RUN CHECKLIST, driven entirely by real state and self-removing.
   *
   * Nothing stores "dismissed" — there is nowhere to store it that would not be
   * a lie on the next browser — so every line is a question this screen can
   * actually answer, and a line disappears when the answer changes:
   *
   *  - the preset ships with placeholder words AND placeholder numbers, and one
   *    save answers both: `revision === 1` is the only signal either has, so the
   *    two lines go together. They are two lines because they are two decisions
   *    — what customers are told, and what they are owed — and the editor shows
   *    them as two panels.
   *  - nothing has ever moved through the pipeline: the ledger is append-only
   *    and nothing deletes from it, so an EMPTY `latestLedger` is an all-time
   *    fact rather than a quiet fortnight, and `oldestOpen` covers the returns
   *    that are in flight but have not been awarded yet.
   *  - no banner exists that the storefront could be shown.
   */
  const preset = programs?.find((program) => program.seeded) ?? null;
  /*
   * `?? []` for the reason the shop's overview gives its own lists: the route
   * that answers this is being written in another session against the same
   * frozen type, and a screen that reads `undefined.length` while that is
   * happening fails as a blank error page rather than as an empty panel.
   */
  const open = summary?.oldestOpen ?? [];
  const activity = summary?.latestLedger ?? [];
  const live = summary?.banners ?? [];

  const steps: Step[] = [];
  if (preset !== null && preset.revision === 1) {
    const to = `/marketing/rewards?id=${encodeURIComponent(preset.id)}`;
    steps.push({
      key: 'naming',
      what: 'Check the wording',
      why: 'The program ships with placeholder names. Everything a customer is shown — screens, emails, the storefront — is rendered from them.',
      to,
      go: 'Open the program',
    });
    steps.push({
      key: 'rules',
      what: 'Confirm the rules',
      why: 'The minimum per request and the rate per accepted item are placeholders too, and they price every award made under them.',
      to,
      go: 'Open the rules',
    });
  }
  if (summary !== null && activity.length === 0 && open.length === 0) {
    steps.push({
      key: 'return',
      what: 'Log the first return',
      why: 'The queue is where a return is booked, picked up, received and counted. Nothing has been through it yet.',
      to: '/marketing/returns',
      go: 'Open the queue',
    });
  }
  if (summary !== null && live.length === 0) {
    steps.push({
      key: 'banner',
      what: 'Put something on the site',
      why: 'The storefront asks for live banners every minute and there are none to give it.',
      to: '/marketing/banners',
      go: 'Open banners',
    });
  }

  return (
    <div className="mktscr">
      <header className="mktscr__head">
        <div className="mktscr__headrow">
          <div>
            <h1 className="mktscr__title">Marketing</h1>
            <p className="mktscr__lede">
              What is waiting on somebody, what customers have earned, and what the site is
              showing. Every figure here is a link into the screen that can change it.
            </p>
          </div>
        </div>
      </header>

      <div className="mktscr__body">
        {problem !== null && (
          <div className="notice notice--danger" role="alert">
            <div>
              <strong>The figures didn’t load.</strong> {problem}
            </div>
            <div className="notice__actions">
              <button className="btn btn--outline btn--sm" onClick={() => void load()}>
                Try again
              </button>
            </div>
          </div>
        )}

        {summary === null ? (
          loading && showSkeletons ? (
            <div className="mkttiles mkttiles--duo" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <div className="mktstat" key={i}>
                  <Skeleton height={11} width="60%" />
                  <Skeleton height={28} width="40%" />
                  <Skeleton height={13} width="85%" />
                </div>
              ))}
            </div>
          ) : null
        ) : (
          <Tiles summary={summary} points={points} />
        )}

        {/* Queued mail is made visible rather than fixed: nothing schedules the
            sweep (spec D6), so a number here that looked like a queue being
            worked through would imply a mechanism that is not running. */}
        {summary !== null && summary.pendingEmailIntents > 0 && (
          <div className="notice" role="status">
            <div>
              <strong>
                {summary.pendingEmailIntents.toLocaleString()} notification
                {summary.pendingEmailIntents === 1 ? ' is' : 's are'} waiting to be sent.
              </strong>{' '}
              Nothing schedules the mail sweep — they go out on the back of the next inspection.
            </div>
          </div>
        )}

        {summary === null ? (
          steps.length > 0 && <FirstSteps steps={steps} />
        ) : (
          <div className="mktgrid">
            <div className="mktgrid__col">
              <OpenReturns rows={open} />
            </div>
            <div className="mktgrid__col">
              {/*
                FIRST IN THIS COLUMN, not last: the card exists only while the
                three panels under it are empty, and a first-day operator should
                not have to scroll past three empty panels on a phone to find
                the only thing on the screen that tells them what to do.
              */}
              {steps.length > 0 && <FirstSteps steps={steps} />}
              <Ledger entries={activity} points={points} />
              <Banners banners={live} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// TILES
// ============================================================================

/**
 * The four workload figures, each a Link into the queue view it counted.
 *
 * THE WHOLE TILE IS THE TARGET (`a.mktstat`), not a small "view" link inside
 * it: two-up on a phone these are the biggest things on the screen and the
 * thumb is aiming at a number, not at a word under it.
 */
function Tiles({
  summary,
  points,
}: {
  summary: MarketingSummary;
  points: ProgramLabels | null;
}) {
  const { needsScheduling, outForPickup, toInspect, awarded30d } = summary.tiles;
  const stale = (ms: number | null): boolean => ms !== null && ms > WARN_MS;
  const oldest = (ms: number | null): string =>
    ms === null ? 'Nothing is waiting.' : `Oldest has waited ${ago(ms)}.`;

  return (
    <div className="mkttiles mkttiles--duo">
      <Tile
        label="Needs scheduling"
        value={needsScheduling.count}
        note={oldest(needsScheduling.oldestAgeMs)}
        alert={stale(needsScheduling.oldestAgeMs)}
        to="/marketing/returns?view=requested"
      />
      {/* Booked, not yet collected — which is why the figure beside it is the
          NEXT pickup rather than an age: this stage is waiting on a driver. */}
      <Tile
        label="Out for pickup"
        value={outForPickup.count}
        note={
          outForPickup.nextPickupAt === null
            ? 'No pickup is booked.'
            : `Next pickup ${WHEN.format(new Date(outForPickup.nextPickupAt))}.`
        }
        alert={false}
        to="/marketing/returns?view=scheduled"
      />
      <Tile
        label="To inspect"
        value={toInspect.count}
        note={oldest(toInspect.oldestAgeMs)}
        alert={stale(toInspect.oldestAgeMs)}
        to="/marketing/returns?view=received"
      />
      {/*
        THE LABEL MATCHES THE FIELD: `awarded30d` is a rolling thirty days, so
        the tile says thirty days rather than "this month" — a figure that
        resets on the 1st and one that does not are different numbers, and only
        one of them is being served.

        The count of RETURNS is the value and the points are the note, because
        the points word is configuration this screen may not have (settings is
        its own region, and it is allowed to fail): a headline that has to fall
        back to a bare integer is a headline that means nothing.
      */}
      <Tile
        label="Awarded · 30 days"
        value={awarded30d.returns}
        note={
          points === null
            ? `${awarded30d.points.toLocaleString()} earned across them.`
            : `${fmtPoints(awarded30d.points, points)} earned across them.`
        }
        alert={false}
        to="/marketing/returns?view=done"
      />
    </div>
  );
}

function Tile({
  label,
  value,
  note,
  alert,
  to,
}: {
  label: string;
  value: number;
  note: string;
  alert: boolean;
  to: string;
}) {
  return (
    <Link className={`mktstat${alert ? ' mktstat--alert' : ''}`} to={to}>
      <span className="mktstat__label">{label}</span>
      <span className="mktstat__value">{value.toLocaleString()}</span>
      <span className="mktstat__note">{note}</span>
    </Link>
  );
}

// ============================================================================
// PANELS
// ============================================================================

/**
 * The five returns that have been waiting longest, in the queue's own row.
 *
 * Same DOM as the queue (`.mktqrow`), so a row is a card on a phone and a line
 * of columns above 720px with nothing rendered twice — and so the two screens
 * cannot describe one return differently. What it does NOT copy is the queue's
 * keyboard spine: a roving tabindex belongs to the list somebody works through,
 * and five rows in a summary panel are five ordinary tab stops.
 */
function OpenReturns({ rows }: { rows: ReturnListItem[] }) {
  const now = Date.now();

  return (
    <section className="mktpanel">
      <div className="mktpanel__head">
        <h2 className="mktpanel__title">Oldest open returns</h2>
        <Link className="btn btn--ghost btn--sm" to="/marketing/returns">
          Open the queue
        </Link>
      </div>
      <div className="mktpanel__body">
        {rows.length === 0 ? (
          <p className="mktpanel__note">
            No open returns yet — log one from{' '}
            <Link className="mkttable__link" to="/marketing/returns">
              Returns
            </Link>{' '}
            when a customer asks.
          </p>
        ) : (
          <ul className="mktqueue" aria-label="Oldest open returns">
            {rows.map((row) => {
              const action = nextStep(row);
              const labels = labelsOf(row.program);
              const waited = now - row.createdAt;
              /* Inspection is a form with derived quantities and a confirmation
                 that restates the award, so it is deep-linked at itself rather
                 than opened here — the queue makes the same call. */
              const to =
                action === 'inspect'
                  ? `/marketing/returns?id=${encodeURIComponent(row.id)}&act=inspect`
                  : `/marketing/returns?id=${encodeURIComponent(row.id)}`;
              return (
                <li className="mktqrow" key={row.id}>
                  <span className="mktqrow__who">
                    <Link className="mktqrow__email" to={to}>
                      {row.customerEmail}
                    </Link>
                    <span className="mktqrow__id">{row.id}</span>
                  </span>

                  <span className="mktqrow__qty">{fmtUnits(row.qtyDeclared, labels)}</span>

                  <span className="mktqrow__meta">
                    <span className={`mktage${ageModifier(waited)}`}>waiting {ago(waited)}</span>
                    <span className={`chip mktchip--${row.status}`}>
                      {STATUS_LABEL[row.status]}
                    </span>
                  </span>

                  <span className="mktqrow__act">
                    {/* A LINK, not a button: this screen performs no
                        transitions. The verb is still the server's own, so the
                        thing an operator reads here is the thing they will be
                        asked to confirm one tap later. */}
                    <Link
                      className="btn btn--sm btn--outline"
                      aria-label={`${action === null ? 'View' : ACTION_VERB[action]} — ${row.customerEmail}`}
                      to={to}
                    >
                      {action === null ? 'View' : ACTION_VERB[action]}
                    </Link>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * The last few things that moved, in the words each row was written in.
 *
 * THE TITLE NAMES NO CURRENCY on purpose — "rewards activity", not the points
 * word — because the points word is configuration and this panel spans every
 * program. The `reason` on each row is a SNAPSHOT rendered when the entry was
 * written (spec D2d): it is printed verbatim, never re-rendered through today's
 * labels, which is why a row awarded before a rename still reads in the old
 * wording while the number beside it carries the current one. The number is
 * arithmetic on a live balance; the sentence is history.
 */
function Ledger({
  entries,
  points,
}: {
  entries: (LedgerEntry & { customerEmail: string })[];
  points: ProgramLabels | null;
}) {
  return (
    <section className="mktpanel">
      <div className="mktpanel__head">
        <h2 className="mktpanel__title">Latest rewards activity</h2>
        <Link className="btn btn--ghost btn--sm" to="/marketing/customers">
          Customers
        </Link>
      </div>
      <div className="mktpanel__body">
        {entries.length === 0 ? (
          <p className="mktpanel__note">
            Nothing has been earned or spent yet. Awards land here the moment a return is
            inspected.
          </p>
        ) : (
          <ul className="mktaudit">
            {entries.slice(0, LEDGER_ROWS).map((entry) => {
              const Icon = LEDGER_ICON[entry.kind];
              const up = entry.delta > 0;
              const size = Math.abs(entry.delta);
              return (
                <li className="mktaudit__row" key={entry.id}>
                  <span className="mktaudit__icon" aria-hidden="true">
                    <Icon className="ui-ic" />
                  </span>
                  <span className="mktaudit__body">
                    <span className="mktaudit__what">
                      <span className={up ? 'mktaudit__up' : 'mktaudit__down'}>
                        {up ? '+' : '−'}
                        {points === null ? size.toLocaleString() : fmtPoints(size, points)}
                      </span>{' '}
                      ·{' '}
                      <Link
                        className="mkttable__link"
                        to={`/marketing/customers?email=${encodeURIComponent(entry.customerEmail)}`}
                      >
                        {entry.customerEmail}
                      </Link>
                    </span>
                    <span className="mktaudit__why">{entry.reason}</span>
                  </span>
                  <span className="mktaudit__when">{WHEN.format(new Date(entry.createdAt))}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * What the site is showing, and what it is not.
 *
 * The chip is DERIVED — stored intent crossed with the clock, through the same
 * `deriveBannerStatus` the public endpoint's WHERE clause is written to match
 * (`shared/marketing/banners.ts`). A banner switched on with an expired window
 * says "Ended" here rather than "Live", which is the whole reason the rule is
 * one shared function instead of two implementations that agree until they do
 * not.
 */
function Banners({ banners }: { banners: Banner[] }) {
  const now = Date.now();

  return (
    <section className="mktpanel">
      <div className="mktpanel__head">
        <h2 className="mktpanel__title">Banners</h2>
        <Link className="btn btn--ghost btn--sm" to="/marketing/banners">
          All banners
        </Link>
      </div>
      {banners.length === 0 ? (
        <div className="mktpanel__body">
          <p className="mktpanel__note">
            Nothing is set up. The storefront asks for live banners every minute — the first one
            shows within a minute of being switched on.
          </p>
        </div>
      ) : (
        <div className="mktpanel__body mktpanel__body--flush">
          <div className="mkttable__scroll">
            <table className="mkttable">
              <thead>
                <tr>
                  <th scope="col">Banner</th>
                  <th scope="col">Showing</th>
                </tr>
              </thead>
              <tbody>
                {banners.map((banner) => {
                  const derived = deriveBannerStatus(banner, now);
                  return (
                    <tr key={banner.id}>
                      <td>
                        <Link
                          className="mkttable__link"
                          to={`/marketing/banners?id=${encodeURIComponent(banner.id)}`}
                        >
                          {banner.title}
                        </Link>
                        <span className="mkttable__sub">{PLACEMENT_WHAT[banner.placement]}</span>
                      </td>
                      <td>
                        <span className={`chip ${BANNER_CHIP[derived]}`}>
                          {BANNER_WHAT[derived]}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * The card that removes itself.
 *
 * Every line is a question the screen can answer from state it already has, so
 * there is no "done" flag anywhere and nothing to reset when a second person
 * signs in on a second machine. The numbers count what is LEFT rather than what
 * the list started with: a card still headed "3." with two lines gone reads as
 * a broken list instead of as progress.
 */
function FirstSteps({ steps }: { steps: Step[] }) {
  return (
    <section className="mktpanel">
      <div className="mktpanel__head">
        <h2 className="mktpanel__title">First steps</h2>
      </div>
      <div className="mktpanel__body">
        <ol className="mktsteps">
          {steps.map((step, i) => (
            <li className="mktsteps__item" key={step.key}>
              <span className="mktsteps__mark" aria-hidden="true">
                {i + 1}
              </span>
              <span className="mktsteps__body">
                <span className="mktsteps__what">{step.what}</span>
                <span className="mktsteps__why">{step.why}</span>
                <Link className="btn btn--ghost btn--sm mktsteps__go" to={step.to}>
                  {step.go}
                </Link>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

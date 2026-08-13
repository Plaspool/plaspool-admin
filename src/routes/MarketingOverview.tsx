import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Award,
  CalendarClock,
  Inbox,
  PackageSearch,
  PanelTop,
  RotateCcw,
  TicketPercent,
  Truck,
  Wallet,
} from 'lucide-react';
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
import { Select } from '../components/ui/Select';
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

        {/*
          ONE COLUMN, FULL WIDTH, IN THE ORDER THE MORNING IS READ: what to do
          first, then what is waiting, then what moved, then what the site is
          showing.

          It used to be two columns with the checklist and two panels stacked in
          a narrow right-hand rail. That rail made every table in it half a
          screen wide — a returns row had to choose between the address and the
          action, and a banner table had room for two columns — while the left
          column held one panel and a great deal of nothing. A summary screen is
          read top to bottom, not in parallel, so the panels get the whole
          measure and the checklist sits across the top where a first-day
          operator meets it before anything else.
        */}
        {steps.length > 0 && <FirstSteps steps={steps} />}

        {summary !== null && (
          <>
            <OpenReturns rows={open} />
            <Ledger entries={activity} points={points} />
            <Banners banners={live} />
          </>
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
        icon={CalendarClock}
        tone="warn"
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
        icon={Truck}
        tone="calm"
        to="/marketing/returns?view=scheduled"
      />
      <Tile
        label="To inspect"
        value={toInspect.count}
        note={oldest(toInspect.oldestAgeMs)}
        alert={stale(toInspect.oldestAgeMs)}
        icon={PackageSearch}
        tone="warn"
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
        icon={Award}
        tone="good"
        to="/marketing/returns?view=done"
      />
    </div>
  );
}

/**
 * A tile's colour, and why it is not decoration.
 *
 * THREE TONES, EACH MEANING SOMETHING: `warn` is a stage where the business is
 * the blocker, `calm` is one where somebody else is (a driver has it), and
 * `good` is money already earned. So the row reads as a state of the world
 * before a single number is — two amber tiles and a green one is "we owe two
 * things" at a glance from across a room.
 *
 * They are the design system's own `--warn`, `--ink-4` and `--accent`. No new
 * hue is introduced anywhere on this screen: a fourth colour would have to mean
 * a fourth thing, and there are only three kinds of waiting here.
 *
 * `alert` is separate and louder — it fires on AGE rather than on stage, and it
 * is what turns a warn tile from "this is our move" into "this has been our
 * move for two days".
 */
type Tone = 'warn' | 'calm' | 'good';

function Tile({
  label,
  value,
  note,
  alert,
  icon: Icon,
  tone,
  to,
}: {
  label: string;
  value: number;
  note: string;
  alert: boolean;
  icon: typeof Award;
  tone: Tone;
  to: string;
}) {
  return (
    <Link
      className={`mktstat mktstat--${tone}${alert ? ' mktstat--alert' : ''}`}
      to={to}
    >
      <span className="mktstat__top">
        <span className="mktstat__label">{label}</span>
        <span className="mktstat__mark" aria-hidden="true">
          <Icon className="ui-ic" />
        </span>
      </span>
      <span className="mktstat__value">{value.toLocaleString()}</span>
      <span className="mktstat__note">{note}</span>
    </Link>
  );
}

// ============================================================================
// PANEL FURNITURE — shared by all three panels below
// ============================================================================

/**
 * A panel's filter and sort, as two small Selects under its heading.
 *
 * CLIENT-SIDE, OVER ROWS THE SCREEN ALREADY HAS. Each panel holds at most a
 * handful of rows that arrived in one summary response, so filtering is an
 * array operation rather than a request — which is what makes it safe to offer
 * on a dashboard at all. Nothing here changes what was fetched, so a filter can
 * never disagree with a total shown above it: the counts in the tiles describe
 * the table, and these choose which of the rows on screen are drawn.
 *
 * The screen that OWNS each of these lists — the queue, Customers, Banners —
 * filters on the server against the whole table, and every panel head links to
 * it. This is triage; that is search.
 */
function PanelTools<F extends string, S extends string>({
  what,
  filter,
  sort,
}: {
  /** What the rows ARE, for the two aria-labels: "Filter banners", "Sort banners". */
  what: string;
  filter: { label: string; value: F; onChange: (v: F) => void; options: { value: F; label: string }[] };
  sort: { value: S; onChange: (v: S) => void; options: { value: S; label: string }[] };
}) {
  return (
    <div className="mkttools">
      <span className="mkttools__field">
        <span className="mkttools__label">{filter.label}</span>
        <Select
          size="sm"
          label={`Filter ${what}`}
          value={filter.value}
          onChange={filter.onChange}
          options={filter.options}
        />
      </span>
      <span className="mkttools__field">
        <span className="mkttools__label">Sort</span>
        <Select
          size="sm"
          label={`Sort ${what}`}
          value={sort.value}
          onChange={sort.onChange}
          options={sort.options}
        />
      </span>
    </div>
  );
}

/**
 * The two empty states every panel needs, and the reason they are two.
 *
 * "Nothing has happened yet" and "nothing matches what you asked for" are
 * different facts with different next actions — the first wants the screen that
 * creates one, the second wants the filter cleared — and a panel that answers
 * both with one sentence sends a first-day operator looking for a feature that
 * is working and an experienced one looking for data that is there. `filtered`
 * is what tells them apart: rows exist, none survived the choice above.
 */
function PanelEmpty({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: typeof Award;
  title: string;
  body: React.ReactNode;
  action?: { to: string; label: string };
}) {
  return (
    <div className="empty mktempty">
      <div className="empty__mark" aria-hidden="true">
        <Icon />
      </div>
      <p className="empty__title">{title}</p>
      <p className="empty__body">{body}</p>
      {action && (
        <Link className="btn btn--outline btn--sm" to={action.to}>
          {action.label}
        </Link>
      )}
    </div>
  );
}

/** The "you filtered them all away" half of the pair — same shape, no icon. */
function NoMatch({ onClear }: { onClear: () => void }) {
  return (
    <div className="empty mktempty">
      <p className="empty__title">Nothing matches</p>
      <p className="empty__body">There are rows here, but none of them fit that choice.</p>
      <button className="btn btn--ghost btn--sm" onClick={onClear}>
        Clear the filter
      </button>
    </div>
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
type ReturnFilter = 'all' | ReturnListItem['status'];
type ReturnSort = 'waiting' | 'newest' | 'quantity';

function OpenReturns({ rows }: { rows: ReturnListItem[] }) {
  const now = Date.now();
  const [filter, setFilter] = useState<ReturnFilter>('all');
  const [sort, setSort] = useState<ReturnSort>('waiting');

  /*
   * The stages OFFERED are the stages PRESENT, so the control never lists a
   * choice that empties the panel — on five rows a filter that can only ever
   * show nothing is a trap rather than a tool.
   */
  const stages = useMemo(
    () => [...new Set(rows.map((row) => row.status))],
    [rows],
  );

  const shown = useMemo(() => {
    const kept = filter === 'all' ? rows : rows.filter((row) => row.status === filter);
    const by: Record<ReturnSort, (a: ReturnListItem, b: ReturnListItem) => number> = {
      // Oldest first — the panel's whole premise, and the server's own ordering.
      waiting: (a, b) => a.createdAt - b.createdAt,
      newest: (a, b) => b.createdAt - a.createdAt,
      quantity: (a, b) => b.qtyDeclared - a.qtyDeclared,
    };
    return [...kept].sort(by[sort]);
  }, [rows, filter, sort]);

  /* A `<section>` is only a landmark once it has a name, and these are the
     units somebody navigates this screen by — so each panel points at its own
     heading rather than repeating the words in an `aria-label` that would then
     have to be kept in step with them. */
  const heading = useId();

  return (
    <section className="mktpanel mktpanel--returns" aria-labelledby={heading}>
      <div className="mktpanel__head">
        <h2 className="mktpanel__title" id={heading}>
          Oldest open returns
        </h2>
        <Link className="btn btn--ghost btn--sm" to="/marketing/returns">
          Open the queue
        </Link>
      </div>
      {rows.length > 0 && (
        <PanelTools
          what="returns"
          filter={{
            label: 'Stage',
            value: filter,
            onChange: setFilter,
            options: [
              { value: 'all' as const, label: 'Every stage' },
              ...stages.map((status) => ({ value: status, label: STATUS_LABEL[status] })),
            ],
          }}
          sort={{
            value: sort,
            onChange: setSort,
            options: [
              { value: 'waiting' as const, label: 'Waiting longest' },
              { value: 'newest' as const, label: 'Newest first' },
              { value: 'quantity' as const, label: 'Largest first' },
            ],
          }}
        />
      )}
      <div className="mktpanel__body">
        {rows.length === 0 ? (
          <PanelEmpty
            icon={Inbox}
            title="No open returns yet"
            body="Nothing has been booked, picked up or delivered. A return joins this list the moment one is logged."
            action={{ to: '/marketing/returns', label: 'Log a return' }}
          />
        ) : shown.length === 0 ? (
          <NoMatch onClear={() => setFilter('all')} />
        ) : (
          <ul className="mktqueue" aria-label="Oldest open returns">
            {shown.map((row) => {
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
type LedgerFilterKey = 'all' | 'earned' | 'spent';
type LedgerSort = 'newest' | 'largest';

function Ledger({
  entries,
  points,
}: {
  entries: (LedgerEntry & { customerEmail: string })[];
  points: ProgramLabels | null;
}) {
  const [filter, setFilter] = useState<LedgerFilterKey>('all');
  const [sort, setSort] = useState<LedgerSort>('newest');

  const shown = useMemo(() => {
    /*
     * EARNED AND SPENT, not the four wire kinds. `return_award` and `manual`
     * are both "the balance went up" and the operator reading a dashboard is
     * asking which direction, not which mechanism — the Customers screen filters
     * by kind, where the mechanism is the question. The sign is the truth here
     * anyway: a release is a credit however it is named.
     */
    const kept =
      filter === 'all'
        ? entries
        : entries.filter((e) => (filter === 'earned' ? e.delta > 0 : e.delta < 0));
    const by: Record<LedgerSort, (a: typeof kept[number], b: typeof kept[number]) => number> = {
      newest: (a, b) => b.createdAt - a.createdAt,
      largest: (a, b) => Math.abs(b.delta) - Math.abs(a.delta),
    };
    return [...kept].sort(by[sort]).slice(0, LEDGER_ROWS);
  }, [entries, filter, sort]);

  const heading = useId();

  return (
    <section className="mktpanel mktpanel--ledger" aria-labelledby={heading}>
      <div className="mktpanel__head">
        <h2 className="mktpanel__title" id={heading}>
          Latest rewards activity
        </h2>
        <Link className="btn btn--ghost btn--sm" to="/marketing/customers">
          Customers
        </Link>
      </div>
      {entries.length > 0 && (
        <PanelTools
          what="activity"
          filter={{
            label: 'Show',
            value: filter,
            onChange: setFilter,
            options: [
              { value: 'all' as const, label: 'Everything' },
              { value: 'earned' as const, label: 'Earned' },
              { value: 'spent' as const, label: 'Spent' },
            ],
          }}
          sort={{
            value: sort,
            onChange: setSort,
            options: [
              { value: 'newest' as const, label: 'Newest first' },
              { value: 'largest' as const, label: 'Largest first' },
            ],
          }}
        />
      )}
      <div className="mktpanel__body">
        {entries.length === 0 ? (
          <PanelEmpty
            icon={Wallet}
            title="Nothing earned or spent yet"
            body="An award lands here the moment a return is inspected, and so does anything credited by hand."
            action={{ to: '/marketing/customers', label: 'Open customers' }}
          />
        ) : shown.length === 0 ? (
          <NoMatch onClear={() => setFilter('all')} />
        ) : (
          <ul className="mktaudit">
            {shown.map((entry) => {
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
type BannerFilter = 'all' | DerivedBannerStatus;
type BannerSort = 'priority' | 'updated' | 'title';

function Banners({ banners }: { banners: Banner[] }) {
  const now = Date.now();
  const [filter, setFilter] = useState<BannerFilter>('all');
  const [sort, setSort] = useState<BannerSort>('priority');

  /* Derived once, because it is both the filter's subject and a column. */
  const derived = useMemo(
    () => new Map(banners.map((b) => [b.id, deriveBannerStatus(b, now)])),
    [banners, now],
  );

  /* Only the states actually present — see the queue's own note above. */
  const states = useMemo(
    () => [...new Set(banners.map((b) => derived.get(b.id)!))],
    [banners, derived],
  );

  const shown = useMemo(() => {
    const kept =
      filter === 'all' ? banners : banners.filter((b) => derived.get(b.id) === filter);
    const by: Record<BannerSort, (a: Banner, b: Banner) => number> = {
      // The storefront's own tie-break: highest priority wins a placement.
      priority: (a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt,
      updated: (a, b) => b.updatedAt - a.updatedAt,
      title: (a, b) => a.title.localeCompare(b.title),
    };
    return [...kept].sort(by[sort]);
  }, [banners, derived, filter, sort]);

  const heading = useId();

  return (
    <section className="mktpanel mktpanel--banners" aria-labelledby={heading}>
      <div className="mktpanel__head">
        <h2 className="mktpanel__title" id={heading}>
          Banners
        </h2>
        <Link className="btn btn--ghost btn--sm" to="/marketing/banners">
          All banners
        </Link>
      </div>
      {banners.length > 0 && (
        <PanelTools
          what="banners"
          filter={{
            label: 'Showing',
            value: filter,
            onChange: setFilter,
            options: [
              { value: 'all' as const, label: 'Every state' },
              ...states.map((state) => ({ value: state, label: BANNER_WHAT[state] })),
            ],
          }}
          sort={{
            value: sort,
            onChange: setSort,
            options: [
              { value: 'priority' as const, label: 'Priority' },
              { value: 'updated' as const, label: 'Recently changed' },
              { value: 'title' as const, label: 'By title' },
            ],
          }}
        />
      )}
      {banners.length === 0 ? (
        <div className="mktpanel__body">
          <PanelEmpty
            icon={PanelTop}
            title="Nothing is on the site"
            body="The storefront asks for live banners every minute — the first one shows within a minute of being switched on."
            action={{ to: '/marketing/banners', label: 'Write one' }}
          />
        </div>
      ) : shown.length === 0 ? (
        <div className="mktpanel__body">
          <NoMatch onClear={() => setFilter('all')} />
        </div>
      ) : (
        <div className="mktpanel__body mktpanel__body--flush">
          <div className="mkttable__scroll">
            <table className="mkttable">
              <thead>
                <tr>
                  <th scope="col">Banner</th>
                  <th scope="col">Showing</th>
                  <th scope="col" className="mkttable__num">
                    Priority
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((banner) => {
                  const state = derived.get(banner.id)!;
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
                        <span className={`chip ${BANNER_CHIP[state]}`}>{BANNER_WHAT[state]}</span>
                      </td>
                      {/* Only meaningful against the others in its placement,
                          which is why it sits beside the placement rather than
                          alone in a column of its own. */}
                      <td className="mkttable__num">{banner.priority}</td>
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
    <section className="mktpanel mktpanel--steps">
      <div className="mktpanel__head">
        <h2 className="mktpanel__title">First steps</h2>
        <span className="mktpanel__note">
          {steps.length} left — each one disappears once it is done.
        </span>
      </div>
      <div className="mktpanel__body">
        {/*
          ACROSS RATHER THAN DOWN. Four short instructions in a single column
          made a list nobody reads to the bottom of, and put the last of them
          below the fold on a laptop; side by side they are four cards a person
          takes in at once, and the numbers still say which comes first. They
          fall back to one column under 720px, where across is not an option.
        */}
        <ol className="mktsteps mktsteps--across">
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

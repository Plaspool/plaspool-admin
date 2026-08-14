import { useCallback, useEffect, useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Award, RotateCcw, Search, TicketPercent, Wallet, X } from 'lucide-react';
import {
  fmtPoints,
  marketingApi,
  settingsLabels,
  type CustomerRow,
  type CustomerSummary,
  type LedgerEntry,
  type LedgerFilter,
  type LedgerKind,
  type Program,
  type ProgramLabels,
} from '../data/api-marketing';
import { ApiError, NotFoundError, OfflineError } from '../data/errors';
import { useSession } from '../components/RequireAuth';
import { useToast } from '../components/Toast';
import { Dialog } from '../components/Dialog';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Feedback';
import { useDelayed } from '../components/ui/useDelayed';
import { STATUS_LABEL } from './marketing/StageForm';
import './marketing.css';

/**
 * What a customer has earned, and every reason it changed.
 *
 * A BALANCE IS THE SUM OF ITS HISTORY, so nothing on this screen edits anything.
 * The ledger is append-only in the database and append-only here: no row has a
 * control on it, a correction is a NEW entry with its own reason, and the one
 * write the screen can make — an adjustment — adds a line rather than altering
 * one. A history with a Save button beside it is a history somebody can quietly
 * rewrite, which is the argument the shop's own audit trail makes and the reason
 * this section's ledger carries `balanceAfter` on every row: the arithmetic was
 * done once, at the time, and is read back rather than recomputed.
 *
 * THE WORDS COME OFF THE SETTINGS, and there is not one of them in this file. A
 * balance spans programs — an award from one, a goodwill credit from another,
 * a discount taken at checkout — so the word for it is the CROSS-PROGRAM pair in
 * `marketing_settings`, fetched once at the top of the screen and threaded down.
 * When that request fails the figures render as bare numbers, because a screen
 * that invented a word for the currency would be wrong for every deployment that
 * renamed it (spec D2, D11).
 *
 * HISTORY IS RENDERED VERBATIM. Every ledger row's `reason` was written when the
 * entry was — in the labels of that day — and is printed exactly as stored. A
 * row awarded before a rename still reads in the old wording while the balance
 * above it reads in the new one, and that is correct: the number is a live fact,
 * the sentence is a record of what somebody was told.
 *
 * EMAIL IS THE KEY, and guests are the normal case. Checkout does not require an
 * account, so balances hang off a lowercase email with a customer id carried
 * alongside when there is one (spec D10) — which is why the detail is `?email=`
 * and why an address with no history answers zeros rather than 404. The
 * walk-in escape below depends on it: somebody who has never ordered online can
 * still be credited, from a page that exists the moment their address is typed.
 */

// ============================================================================
// THE WORDS
// ============================================================================

/** The directory is a lookup, not a list to read through: contract #15's
 *  "recently active" is the last fifteen, and everything else is a search. */
const DIRECTORY_LIMIT = 15;
const LEDGER_LIMIT = 25;

/**
 * The copy for a `bad_request`, keyed by the field path the server named.
 *
 * The catalogue's treatment for a 400 is "inline, keyed by `detail`" — which
 * needs a sentence per field, because `delta` is the server's name for a box
 * labelled Amount and a message quoting it names nothing the operator can see.
 */
const FIELD_MESSAGE: Record<string, string> = {
  email: 'That doesn’t look like an email address.',
  delta: 'How many, as a whole number above zero.',
  reason: 'Say why. It is written into the row and can never be edited.',
  programId: 'That program wasn’t accepted.',
  customerId: 'That customer id wasn’t accepted.',
};

const fieldMessage = (field: string): string =>
  FIELD_MESSAGE[field] ?? 'That value wasn’t accepted.';

/**
 * The ledger's filter, as tabs over `?kind=`.
 *
 * The labels say what HAPPENED rather than what the wire calls it: `awards`,
 * `manual` and `redemptions` are three kinds of row to a server and three
 * different stories to the person reading them. None of them names the currency
 * word — that is configuration, and this strip is chrome.
 */
const KIND_TABS: { key: LedgerFilter; label: string }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'awards', label: 'From returns' },
  { key: 'manual', label: 'By hand' },
  { key: 'redemptions', label: 'Spent at checkout' },
];

/**
 * The reasons an adjustment is usually made — as TEXT that lands in the box, not
 * as a code that travels.
 *
 * The wire carries one `reason` string and stores it forever, so a preset here
 * is a starting point for a sentence rather than an enum: "Goodwill" is picked
 * and then finished ("Goodwill — box arrived crushed"), and what the ledger row
 * says a year later is what was actually typed. "Other" fills in nothing on
 * purpose: it is the answer that means "none of these", and prefilling it with
 * the word "Other" would put a reason nobody chose into the permanent record.
 */
const REASONS: { value: string; label: string; text: string }[] = [
  { value: 'walk-in', label: 'Walk-in return', text: 'Walk-in return, counted at the counter' },
  { value: 'goodwill', label: 'Goodwill', text: 'Goodwill' },
  { value: 'correction', label: 'Correction', text: 'Correction of an earlier entry' },
  { value: 'other', label: 'Other', text: '' },
];

/**
 * A Select cannot offer an empty value — Radix reads `''` as "nothing chosen" —
 * so "no program" travels as a sentinel and becomes an ABSENT field on the wire.
 * Absent rather than null: `programId` is optional on contract #18 and a manual
 * credit that belongs to no program is the ordinary case.
 */
const NO_PROGRAM = 'none';

/** Digits only. An adjustment's size is a whole number; its DIRECTION is the
 *  Credit/Debit pair, so a minus sign typed into the box is not a value. */
const INT_RE = /^\d+$/;

/**
 * NOT VALIDATION — the server owns that, and its refusal is a 400 under the
 * field. This decides one thing only: whether the no-match state can offer to
 * credit what was typed. The search matches an email prefix OR a customer-id
 * prefix (#15), and offering to open `?email=cus_39fa` would create a balance
 * under an address that is not one.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const WHEN = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
});

const DAY = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const WHEN_DAY = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** A mark per ledger kind, because a long history is skimmed rather than read. */
const LEDGER_ICON: Record<LedgerKind, typeof Award> = {
  return_award: Award,
  manual: Wallet,
  redemption: TicketPercent,
  redemption_release: RotateCcw,
};

/** Midnight to midnight, in the reader's own zone, so entries group under the
 *  day they happened rather than under a UTC day nobody lived through. */
const dayKey = (ms: number): string => new Date(ms).toDateString();

// ============================================================================
// THE FIGURES
// ============================================================================

/**
 * A quantity in the words the settings hold — or the bare number when that
 * request failed.
 *
 * THE FALLBACK IS THE POINT. There is no word for the currency in this file, and
 * a screen that supplied one would be wrong for every deployment that renamed
 * it. A number with no noun beside it is honest; a number with the wrong noun is
 * not.
 */
const amountText = (n: number, points: ProgramLabels | null): string =>
  points === null ? n.toLocaleString() : fmtPoints(n, points);

/**
 * The refusal a debit below zero earns, in ONE place.
 *
 * It is said twice — live, from the balance this screen loaded, and again from
 * the balance a 409 `insufficient_balance` carried — and the second one is
 * authoritative because the balance may have moved while the dialog was open.
 * Same sentence either way: two wordings for one refusal is the operator reading
 * a new message for a problem they already understood.
 */
const belowZero = (balance: number, size: number, points: ProgramLabels | null): string =>
  `Balance is ${amountText(balance, points)} — a ${size.toLocaleString()} debit would go below zero.`;

/** A refusal, and the field it belongs under. `null` is the whole form. */
interface Problem {
  field: string | null;
  message: string;
}

/** An operator-typed whole number, or null when the box does not hold one. */
function int(raw: string): number | null {
  const trimmed = raw.trim();
  if (!INT_RE.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/** The balance a 409 carried, so the message quotes the server's figure rather
 *  than the one this screen loaded a minute ago. */
function carriedBalance(err: unknown): number | null {
  if (!(err instanceof ApiError)) return null;
  const body = err.body;
  if (body === null || typeof body !== 'object') return null;
  const found = (body as Record<string, unknown>).balance;
  return typeof found === 'number' ? found : null;
}

// ============================================================================
// THE FAILURES
// ============================================================================

function explainLoad(err: unknown, fallback = 'The customers didn’t load.'): string {
  if (err instanceof OfflineError) return 'The request didn’t reach the server.';
  if (err instanceof NotFoundError) return 'This deployment has no customers route yet.';
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
  if (err instanceof ApiError) {
    if (err.status === 403) return 'Only the owner can do this.';
    if (err.status === 429) return 'Too many changes too quickly — wait a moment and try again.';
    if (err.status >= 500) {
      return err.requestId === undefined
        ? 'Something went wrong on the server.'
        : `Something went wrong on the server — reference ${err.requestId}.`;
    }
  }
  return 'That didn’t go through.';
}

// ============================================================================
// URL
// ============================================================================

/** The same params with the defaults dropped rather than written. */
function withParams(
  base: URLSearchParams,
  patch: Record<string, string | null>,
): URLSearchParams {
  const next = new URLSearchParams(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '' || (key === 'kind' && value === 'all')) next.delete(key);
    else next.set(key, value);
  }
  return next;
}

const asSearch = (params: URLSearchParams): string => {
  const qs = params.toString();
  return qs === '' ? '' : `?${qs}`;
};

/** `?kind=nonsense` is a typo, not an error screen. */
function readKind(params: URLSearchParams): LedgerFilter {
  const raw = params.get('kind');
  return KIND_TABS.some((tab) => tab.key === raw) ? (raw as LedgerFilter) : 'all';
}

// ============================================================================
// SCREEN
// ============================================================================

export default function MarketingCustomers() {
  const [params] = useSearchParams();
  const email = params.get('email') ?? '';
  /* Fetched HERE rather than in each half: both need the same cross-program
     words, and a screen that asked for them twice would show one of the two
     halves' figures wordless for a moment on every navigation. */
  const points = usePointsLabels();

  return (
    <div className="mktscr">
      {email === '' ? (
        <Directory points={points} />
      ) : (
        /* Remounted per address: the ledger, its filter and any half-typed
           adjustment belong to ONE customer, and carrying either into the next
           one is the worst thing this screen could do quietly. */
        <CustomerPage key={email} email={email} points={points} />
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

/**
 * The cross-program words for a balance, or null while unknown.
 *
 * `GET /settings` is `requireAuth` — a writer reads it too, unlike the Rewards
 * panel that WRITES it — because knowing what somebody's balance is called is
 * part of answering a question about it. Soft on failure: see `amountText`.
 */
function usePointsLabels(): ProgramLabels | null {
  const [points, setPoints] = useState<ProgramLabels | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    marketingApi
      .getSettings(ac.signal)
      .then((settings) => {
        if (!ac.signal.aborted) setPoints(settingsLabels(settings));
      })
      .catch(() => {
        /* Soft: the figures render as bare numbers rather than as a wrong noun. */
      });
    return () => ac.abort();
  }, []);

  return points;
}

// ============================================================================
// DIRECTORY
// ============================================================================

/**
 * Finding somebody, which is the only thing this half does.
 *
 * The list is the union of everybody with a balance and a read-only search over
 * the shop's own customers (#15), so a person who has never earned anything is
 * still findable — and an empty search is not an empty result but the
 * recently-active list, which is what makes the screen worth opening before
 * anybody has typed.
 */
function Directory({ points }: { points: ProgramLabels | null }) {
  const [params, setParams] = useSearchParams();
  const isOwner = useIsOwner();
  const query = params.get('q') ?? '';

  const [draft, setDraft] = useState(query);
  const [rows, setRows] = useState<CustomerRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false);
  const showSkeletons = useDelayed(loading);

  /* The box follows the URL — a Back out of a search has to put the previous
     term back into it, or the box and the list below disagree. */
  useEffect(() => {
    setDraft(query);
  }, [query]);

  const load = useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      setProblem(null);
      return marketingApi
        .listCustomers({ query: query.trim() || undefined, limit: DIRECTORY_LIMIT }, signal)
        .then((page) => {
          if (signal?.aborted) return;
          setRows(page.items ?? []);
          setCursor(page.nextCursor ?? null);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (signal?.aborted) return;
          setProblem(explainLoad(err));
          setLoading(false);
        });
    },
    [query],
  );

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  async function showMore(): Promise<void> {
    if (cursor === null || paging) return;
    setPaging(true);
    try {
      const page = await marketingApi.listCustomers({
        query: query.trim() || undefined,
        cursor,
        limit: DIRECTORY_LIMIT,
      });
      setRows((prev) => [...(prev ?? []), ...(page.items ?? [])]);
      setCursor(page.nextCursor ?? null);
    } catch (err) {
      setProblem(explainLoad(err));
    } finally {
      setPaging(false);
    }
  }

  /*
   * ENTER SEARCHES, and it pushes rather than replaces: a search is somewhere
   * you went, so Back is the way out of it. The queue's box debounces into the
   * URL instead, because its list is what the operator is working through — here
   * the list is an answer to a question that has been asked.
   */
  const search = (term: string): void =>
    setParams((prev) => withParams(prev, { q: term.trim() }));

  const typed = query.trim();
  /* Lowercased, because the balance's own column is: `customer_email` is CHECKed
     `= lower(...)`, so `?email=Dara@Example.com` would open a page of zeros
     beside a real balance nobody could see. Only the TYPED address is folded —
     what the server served is left exactly as served. The search it was typed
     into is kept, like every other row's link, so "All customers" comes back to
     the question rather than to the whole directory. */
  const walkInTo = {
    pathname: '/marketing/customers',
    search: asSearch(withParams(params, { email: typed.toLowerCase() })),
  };

  return (
    <>
      <header className="mktscr__head">
        <div className="mktscr__headrow">
          <div>
            <h1 className="mktscr__title">Customers</h1>
            <p className="mktscr__lede">
              What each customer has earned, and every reason it changed. Nothing here can be
              edited — a balance is the sum of its history, and history is written once.
            </p>
          </div>
        </div>

        <form
          className="mktfilters"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            search(draft);
          }}
        >
          <div className="searchbox">
            <Search className="ui-ic" aria-hidden="true" />
            <input
              className="searchbox__input"
              type="search"
              value={draft}
              placeholder="Search by email or customer id"
              aria-label="Search by email or customer id"
              onChange={(e) => setDraft(e.target.value)}
            />
            {draft !== '' && (
              <button
                type="button"
                className="searchbox__clear"
                aria-label="Clear search"
                onClick={() => {
                  setDraft('');
                  search('');
                }}
              >
                <X className="ui-ic" aria-hidden="true" />
              </button>
            )}
          </div>
          <button type="submit" className="btn btn--outline">
            Search
          </button>
          <span className="mktform__hint">Guests earn under their checkout email.</span>
        </form>
      </header>

      <div className="mktscr__body">
        {problem !== null && (
          <div className="notice notice--danger" role="alert">
            <div>
              <strong>The customers didn’t load.</strong> {problem}
            </div>
            <div className="notice__actions">
              <button className="btn btn--outline btn--sm" onClick={() => void load()}>
                Try again
              </button>
            </div>
          </div>
        )}

        {rows === null ? (
          loading && showSkeletons ? (
            <div className="mktform__field" aria-hidden="true">
              <Skeleton height={18} width="55%" />
              <Skeleton height={18} width="40%" />
              <Skeleton height={18} width="62%" />
            </div>
          ) : null
        ) : rows.length === 0 ? (
          <div className="empty">
            <div className="empty__mark" aria-hidden="true">
              <Wallet />
            </div>
            <h2 className="empty__title">
              {typed === '' ? 'Nobody has earned anything yet' : 'Nobody matches that'}
            </h2>
            <p className="empty__body">
              {typed === ''
                ? 'Balances appear here the moment a return is inspected, or the first time somebody is credited by hand.'
                : 'Guests appear under their checkout email — check the spelling.'}
            </p>
            {/*
              THE WALK-IN ESCAPE. The brief's rule is that anybody can be credited
              for any reason, and somebody who bought at a counter has no online
              order to be found by — so an address that matches nothing is not a
              dead end. Contract #16 answers zeros rather than 404 for an unknown
              email, so the page this opens works immediately, adjustment dialog
              and all. Owner-only because the adjustment is (role matrix), and
              only for something shaped like an address: the search also matches
              customer ids, and crediting `cus_39fa` would open a balance under an
              address that is not one.
            */}
            {isOwner && EMAIL_RE.test(typed) && (
              <Link className="btn btn--outline" to={walkInTo}>
                Credit {typed} anyway →
              </Link>
            )}
          </div>
        ) : (
          <>
            <section className="mktpanel">
              <div className="mktpanel__head">
                <h2 className="mktpanel__title">
                  {typed === '' ? 'Recently active' : 'Matches'}
                </h2>
              </div>
              <div className="mktpanel__body mktpanel__body--flush">
                <div className="mkttable__scroll">
                  <table className="mkttable">
                    <thead>
                      <tr>
                        <th scope="col">Customer</th>
                        <th scope="col">Balance</th>
                        <th scope="col">Last change</th>
                        <th scope="col">When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.email}>
                          <td>
                            <Link
                              className="mkttable__link"
                              to={{
                                pathname: '/marketing/customers',
                                search: asSearch(withParams(params, { email: row.email })),
                              }}
                            >
                              {row.email}
                            </Link>{' '}
                            {/* `guest` is the server's own flag (no account, no
                                customer id), not a guess from a missing name —
                                a signed-up customer may have no display name. */}
                            {row.guest && <span className="chip mktchip--guest">Guest</span>}
                            {row.displayName !== null && (
                              <span className="mkttable__sub">{row.displayName}</span>
                            )}
                          </td>
                          <td className="mkttable__num" data-label="Balance">
                            {amountText(row.balance, points)}
                          </td>
                          <td data-label="Last change">
                            {row.lastEntry === null ? (
                              <span className="mkttable__sub">Nothing yet</span>
                            ) : (
                              <>
                                {/* Signed and bare: the column beside this one
                                    already carries the word, and repeating it on
                                    every row would crowd out the reason. */}
                                <span
                                  className={
                                    row.lastEntry.delta > 0 ? 'mktaudit__up' : 'mktaudit__down'
                                  }
                                >
                                  {row.lastEntry.delta > 0 ? '+' : '−'}
                                  {Math.abs(row.lastEntry.delta).toLocaleString()}
                                </span>
                                {/* Verbatim, like every other rendering of a
                                    stored reason on this screen. */}
                                <span className="mkttable__sub">{row.lastEntry.reason}</span>
                              </>
                            )}
                          </td>
                          <td className="mkttable__num" data-label="When">
                            {row.lastEntryAt === null
                              ? '—'
                              : WHEN_DAY.format(new Date(row.lastEntryAt))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            {/* The endpoint is a keyset walk, so a truncated answer has to say so
                — fifteen rows with a sixteenth match silently dropped is a search
                that lies about having found nothing. */}
            {cursor !== null && (
              <div className="mktpager">
                <button
                  className="btn btn--outline btn--sm"
                  disabled={paging}
                  onClick={() => void showMore()}
                >
                  {paging ? 'Loading…' : 'Show more'}
                </button>
                <span className="mktpager__note">
                  {rows.length.toLocaleString()} shown
                  {typed === '' ? ', most recently active first' : ''}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

// ============================================================================
// ONE CUSTOMER
// ============================================================================

function CustomerPage({ email, points }: { email: string; points: ProgramLabels | null }) {
  const [params] = useSearchParams();
  const isOwner = useIsOwner();
  const { notify } = useToast();
  const kind = readKind(params);

  const [summary, setSummary] = useState<CustomerSummary | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [ledgerProblem, setLedgerProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false);
  const showSkeletons = useDelayed(loading);
  /* The history has its own, because it has its own request: tied to the
     summary's flag, a ledger that answered second would sit in an empty panel
     with nothing in it saying why. */
  const showLedgerSkeletons = useDelayed(entries === null);
  const [adjusting, setAdjusting] = useState<{ open: boolean; seq: number }>({
    open: false,
    seq: 0,
  });

  /**
   * The programs, fetched only for an owner and allowed to fail.
   *
   * They exist on this screen for ONE control — which program a hand-made credit
   * is attributed to — and that control is inside a dialog only an owner can
   * open. A screen that fetched what it cannot show is a screen whose next
   * reader adds a control for it.
   */
  const [programs, setPrograms] = useState<Program[]>([]);

  const loadSummary = useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      setProblem(null);
      return marketingApi
        .getCustomer(email, signal)
        .then((next) => {
          if (signal?.aborted) return;
          setSummary(next);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (signal?.aborted) return;
          /* A 404 here is a DEPLOYMENT without the route, never an unknown
             customer: #16 answers zeros for an address nothing has touched, and
             the walk-in credit path depends on exactly that. */
          setProblem(explainLoad(err, 'This customer didn’t load.'));
          setLoading(false);
        });
    },
    [email],
  );

  const loadLedger = useCallback(
    (signal?: AbortSignal) => {
      setLedgerProblem(null);
      return marketingApi
        .getLedger(
          email,
          // `all` is the server's default, so it is not sent — and `withParams`
          // drops it from the URL for the same reason.
          { kind: kind === 'all' ? undefined : kind, limit: LEDGER_LIMIT },
          signal,
        )
        .then((page) => {
          if (signal?.aborted) return;
          setEntries(page.items ?? []);
          setCursor(page.nextCursor ?? null);
        })
        .catch((err: unknown) => {
          if (signal?.aborted) return;
          setLedgerProblem(explainLoad(err, 'The history didn’t load.'));
        });
    },
    [email, kind],
  );

  useEffect(() => {
    const ac = new AbortController();
    void loadSummary(ac.signal);
    return () => ac.abort();
  }, [loadSummary]);

  useEffect(() => {
    const ac = new AbortController();
    void loadLedger(ac.signal);
    return () => ac.abort();
  }, [loadLedger]);

  useEffect(() => {
    if (!isOwner) return;
    const ac = new AbortController();
    marketingApi
      .listPrograms(ac.signal)
      .then((next) => {
        if (!ac.signal.aborted) setPrograms(next);
      })
      .catch(() => {
        /* Soft: the dialog then attributes a credit to no program, which is a
           legal adjustment and the commonest one. */
      });
    return () => ac.abort();
  }, [isOwner]);

  async function showMore(): Promise<void> {
    if (cursor === null || paging) return;
    setPaging(true);
    try {
      const page = await marketingApi.getLedger(email, {
        kind: kind === 'all' ? undefined : kind,
        cursor,
        limit: LEDGER_LIMIT,
      });
      setEntries((prev) => [...(prev ?? []), ...(page.items ?? [])]);
      setCursor(page.nextCursor ?? null);
    } catch (err) {
      setLedgerProblem(explainLoad(err, 'The rest of the history didn’t load.'));
    } finally {
      setPaging(false);
    }
  }

  const backTo = {
    pathname: '/marketing/customers',
    search: asSearch(withParams(params, { email: null })),
  };

  const rows = entries ?? [];
  /*
   * Every debit ever made, which is what the two served figures mean together:
   * `lifetimeEarned` is the sum of the credits and `balance` is the sum of
   * everything, so the difference is the sum of the debits — releases included
   * on both sides, so they cancel exactly. Rendered only when it is positive:
   * if a deployment ever counts "earned" more narrowly than "every credit", the
   * subtraction stops meaning this, and a figure that has stopped meaning what
   * it says should not be shown at all.
   */
  const spent =
    summary === null ? 0 : Math.max(0, summary.lifetimeEarned - summary.balance);

  return (
    <>
      <header className="mktscr__head">
        <div className="mktscr__headrow">
          <div>
            <Link className="btn btn--ghost btn--sm" to={backTo}>
              All customers
            </Link>
            <h1 className="mktscr__title">{summary?.displayName ?? email}</h1>
            <p className="mktscr__lede">
              {email}{' '}
              {summary?.customerId === null && (
                <span className="chip mktchip--guest">Guest — no account</span>
              )}
            </p>
          </div>
          {/*
            OWNER-ONLY AND ABSENT FOR EVERYONE ELSE, never disabled: adjustments
            are `requireOwner` (role matrix) and a disabled button is a promise
            the server will refuse. Held back until the balance has landed as
            well — the dialog's live "balance after" line is arithmetic on a
            number that has to exist first.
          */}
          {isOwner && summary !== null && (
            <button
              className="btn btn--primary"
              onClick={() => setAdjusting((prev) => ({ open: true, seq: prev.seq + 1 }))}
            >
              Adjust balance…
            </button>
          )}
        </div>
      </header>

      <div className="mktscr__body">
        {problem !== null && (
          <div className="notice notice--danger" role="alert">
            <div>
              <strong>This customer didn’t load.</strong> {problem}
            </div>
            <div className="notice__actions">
              <button className="btn btn--outline btn--sm" onClick={() => void loadSummary()}>
                Try again
              </button>
            </div>
          </div>
        )}

        {summary === null ? (
          loading && showSkeletons ? (
            <div className="mkttiles" aria-hidden="true">
              <div className="mktstat">
                <Skeleton height={11} width="40%" />
                <Skeleton height={28} width="55%" />
                <Skeleton height={13} width="70%" />
              </div>
            </div>
          ) : null
        ) : (
          <div className="mkttiles">
            {/*
              ONE TILE. A per-program breakdown was considered and deferred: a
              balance is spent across programs at checkout, so splitting it into
              columns would show four numbers that cannot each be spent.
            */}
            <div className="mktstat">
              <span className="mktstat__label">Balance</span>
              <span className="mktstat__value">{amountText(summary.balance, points)}</span>
              <span className="mktstat__note">
                Earned {amountText(summary.lifetimeEarned, points)}
                {spent > 0 && ` · spent ${spent.toLocaleString()}`}
              </span>
            </div>
          </div>
        )}

        {/* A return already in flight, said out loud beside the credit button:
            everything it earns is awarded automatically when it is inspected, so
            crediting the same units by hand now is the double-award this line
            exists to prevent. */}
        {summary?.openReturn != null && (
          <div className="notice" role="status">
            <div>
              A return is already in progress —{' '}
              <strong>{STATUS_LABEL[summary.openReturn.status]}</strong>. Whatever is accepted is
              awarded when it is inspected.
            </div>
            <div className="notice__actions">
              <Link
                className="btn btn--outline btn--sm"
                to={`/marketing/returns?id=${encodeURIComponent(summary.openReturn.id)}`}
              >
                Open it
              </Link>
            </div>
          </div>
        )}

        <nav className="mkttabs" aria-label="What to show">
          {KIND_TABS.map((tab) => (
            <Link
              key={tab.key}
              className={`mkttabs__tab${kind === tab.key ? ' is-active' : ''}`}
              aria-current={kind === tab.key ? 'page' : undefined}
              to={{
                pathname: '/marketing/customers',
                // The cursor is not in the URL — "Show more" appends — so
                // changing the filter carries nothing of the old walk with it.
                search: asSearch(withParams(params, { kind: tab.key })),
              }}
            >
              {tab.label}
            </Link>
          ))}
        </nav>

        <section className="mktpanel">
          <div className="mktpanel__head">
            <h2 className="mktpanel__title">History</h2>
          </div>
          <div className="mktpanel__body">
            {ledgerProblem !== null && (
              <div className="notice notice--danger" role="alert">
                <div>
                  <strong>The history didn’t load.</strong> {ledgerProblem}
                </div>
                <div className="notice__actions">
                  <button className="btn btn--outline btn--sm" onClick={() => void loadLedger()}>
                    Try again
                  </button>
                </div>
              </div>
            )}

            {entries === null ? (
              showLedgerSkeletons ? (
                <div className="mktform__field" aria-hidden="true">
                  <Skeleton height={18} width="65%" />
                  <Skeleton height={18} width="48%" />
                </div>
              ) : null
            ) : rows.length === 0 ? (
              <p className="mktpanel__note">
                {kind === 'all'
                  ? 'Nothing has been earned or spent yet. Awards land here the moment a return is inspected.'
                  : 'Nothing of this kind. Everything this customer has done is under the first tab.'}
              </p>
            ) : (
              <>
                <ul className="mktaudit">
                  {rows.map((entry, i) => (
                    <LedgerRow
                      key={entry.id}
                      entry={entry}
                      points={points}
                      // The day heading is drawn by the FIRST entry of each day,
                      // so the list stays one flat <ul> — grouping into nested
                      // lists would break the reading order announced to a
                      // screen reader (`.mktaudit__day`'s own note).
                      startsDay={
                        i === 0 || dayKey(rows[i - 1].createdAt) !== dayKey(entry.createdAt)
                      }
                    />
                  ))}
                </ul>

                {cursor !== null && (
                  <div className="mktpager">
                    <button
                      className="btn btn--outline btn--sm"
                      disabled={paging}
                      onClick={() => void showMore()}
                    >
                      {paging ? 'Loading…' : 'Show earlier entries'}
                    </button>
                    <span className="mktpager__note">
                      {rows.length.toLocaleString()} shown, newest first
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      </div>

      {isOwner && summary !== null && (
        <AdjustBalance
          // Remounted on every open, which is how the fields come up empty
          // without an effect that reaches into them.
          key={adjusting.seq}
          open={adjusting.open}
          email={summary.email}
          customerId={summary.customerId}
          balance={summary.balance}
          points={points}
          programs={programs}
          onClose={() => setAdjusting((prev) => ({ ...prev, open: false }))}
          onDone={async (said) => {
            setAdjusting((prev) => ({ ...prev, open: false }));
            notify(said);
            // TOGETHER: the tile and the history are two views of one write, and
            // a screen showing the new balance above the old last row is a
            // screen somebody will report as having lost an entry.
            await Promise.all([loadSummary(), loadLedger()]);
          }}
        />
      )}
    </>
  );
}

/**
 * One entry, leading with the DIFFERENCE.
 *
 * The current balance is already in the tile above, so what is nowhere else is
 * what this row changed and what it was before — which the row carries as
 * `balanceAfter`, written at the time. `delta` and that figure are enough for
 * "120 → 180" with no window function on the server and no running total in the
 * client, and no way for the two to disagree.
 */
function LedgerRow({
  entry,
  points,
  startsDay,
}: {
  entry: LedgerEntry;
  points: ProgramLabels | null;
  startsDay: boolean;
}) {
  /* The fallback is unreachable through the type and deliberate anyway: the
     ledger's `kind` CHECK is written to be WIDENED (expiry is the named next
     one), and a row arriving with a kind this build has never heard of should
     be a generic mark rather than `undefined` rendered as a component. */
  const Icon = LEDGER_ICON[entry.kind] ?? Wallet;
  const up = entry.delta > 0;
  const size = Math.abs(entry.delta);
  const was = entry.balanceAfter - entry.delta;

  return (
    <>
      {/* Announced rather than `aria-hidden`, unlike the audit list this is a
          copy of: the row's own time is a clock time, so hiding the heading
          would leave a screen reader with entries that never say which day. */}
      {startsDay && <li className="mktaudit__day">{DAY.format(new Date(entry.createdAt))}</li>}
      <li className="mktaudit__row">
        <span className="mktaudit__icon" aria-hidden="true">
          <Icon className="ui-ic" />
        </span>
        <span className="mktaudit__body">
          <span className="mktaudit__what">
            <span className={up ? 'mktaudit__up' : 'mktaudit__down'}>
              {up ? '+' : '−'}
              {amountText(size, points)}
            </span>{' '}
            <span className="mktaudit__was">{was.toLocaleString()}</span>
            {/* `role="img"` so the arrow is announced as the word it stands for.
                A bare span with an `aria-label` is ignored by assistive
                technology, which would read "120 180". */}
            <span className="mktaudit__arrow" role="img" aria-label="became">
              →
            </span>
            {entry.balanceAfter.toLocaleString()}
          </span>
          {/*
            THE STORED SENTENCE, VERBATIM. It was rendered when the entry was
            written, in the labels of that day; re-rendering it through today's
            wording would rewrite history every time somebody renames a program.
          */}
          <span className="mktaudit__why">{entry.reason}</span>
        </span>
        <time className="mktaudit__when" dateTime={new Date(entry.createdAt).toISOString()}>
          {WHEN.format(new Date(entry.createdAt))}
        </time>
      </li>
    </>
  );
}

// ============================================================================
// ADJUSTMENT
// ============================================================================

/**
 * A credit or a debit, by hand, with a reason that is kept for good.
 *
 * THE BRIEF'S "ANY CUSTOMER FOR ANY REASON" LIVES HERE. It is the one write on
 * this screen and it ADDS a row — there is no edit and no delete, so a mistake
 * is corrected by a second entry that says so, and both are visible afterwards.
 *
 * DIRECTION IS A CHOICE, NOT A SIGN. `delta` is a signed integer on the wire and
 * a minus typed into a box is the classic way to credit sixty when forty was
 * meant to be taken away; the segmented pair makes the direction a thing you
 * pick, and the button underneath says which one it is before it is pressed.
 */
function AdjustBalance({
  open,
  email,
  customerId,
  balance,
  points,
  programs,
  onClose,
  onDone,
}: {
  open: boolean;
  email: string;
  customerId: string | null;
  balance: number;
  points: ProgramLabels | null;
  programs: Program[];
  onClose: () => void;
  /** Told what happened, in the same words the button offered. */
  onDone: (said: string) => void | Promise<void>;
}) {
  const uid = useId();
  const [direction, setDirection] = useState<'credit' | 'debit'>('credit');
  const [amount, setAmount] = useState('');
  const [programId, setProgramId] = useState(NO_PROGRAM);
  const [preset, setPreset] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  const errorFor = (field: string): string | null =>
    problem !== null && problem.field === field ? problem.message : null;

  const size = int(amount);
  const credit = direction === 'credit';
  const verb = credit ? 'Credit' : 'Debit';
  const after = size === null ? balance : credit ? balance + size : balance - size;
  const wouldGoBelow = size !== null && after < 0;

  async function submit(): Promise<void> {
    setProblem(null);
    if (size === null || size < 1)
      return setProblem({ field: 'delta', message: fieldMessage('delta') });
    const said = reason.trim();
    /* The server requires it (#18: reason nonempty) and so does this form. Not
       to save a request — to put the message under the box rather than in a
       toast, which is what the catalogue asks for a 400. */
    if (said === '') return setProblem({ field: 'reason', message: fieldMessage('reason') });

    setBusy(true);
    try {
      await marketingApi.adjust({
        email,
        delta: credit ? size : -size,
        reason: said,
        ...(programId === NO_PROGRAM ? {} : { programId }),
        /* Carried when it is known, because a later merge of a customer whose
           email changed is only possible over rows that recorded WHO as well as
           what (spec D10). Absent for a guest, which is most of them. */
        ...(customerId === null ? {} : { customerId }),
      });
      await onDone(`${credit ? 'Credited' : 'Debited'} ${amountText(size, points)}`);
    } catch (err) {
      const authoritative = carriedBalance(err);
      if (err instanceof ApiError && err.code === 'insufficient_balance' && authoritative !== null) {
        // Under the AMOUNT, because that is the box that has to change — the
        // balance is not something the operator can edit.
        setProblem({ field: 'delta', message: belowZero(authoritative, size, points) });
      } else if (err instanceof ApiError && err.status === 400 && err.detail !== undefined) {
        setProblem({ field: err.detail, message: fieldMessage(err.detail) });
      } else {
        setProblem({ field: null, message: explainWrite(err) });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      // Inert above 640px, a bottom sheet below it: a credit given at a counter
      // is given one-handed, with the customer standing there.
      sheet
      title="Adjust balance"
      description={email}
      // The form brings its own actions, so the dialog draws no footer of its
      // own — one row of buttons, in the order the fields lead to them.
      footer={<></>}
    >
      <form
        className="mktform"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="mktform__field">
          <span className="label" id={`${uid}-dir-label`}>
            Which way
          </span>
          {/* Native radios behind the labels: arrow-key movement, the single tab
              stop and the checked state are the browser's. See `.mktseg`. */}
          <div className="mktseg" role="radiogroup" aria-labelledby={`${uid}-dir-label`}>
            {(['credit', 'debit'] as const).map((option) => (
              <label className="mktseg__opt" key={option}>
                <input
                  className="visually-hidden"
                  type="radio"
                  name={`${uid}-dir`}
                  value={option}
                  checked={direction === option}
                  onChange={() => {
                    setDirection(option);
                    // The refusal under the amount was about the OTHER direction:
                    // an error left under a box somebody has just fixed is an
                    // error about nothing.
                    setProblem(null);
                  }}
                />
                <span>{option === 'credit' ? 'Credit' : 'Debit'}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="mktform__field">
          <label className="label" htmlFor={`${uid}-amount`}>
            Amount
          </label>
          {/*
            A plain box, NOT the `QtyStepper` the returns forms use. That control
            exists for quantities counted off a pallet one at a time; these are
            awards in tens and hundreds, and a stepper would be forty taps.
          */}
          <input
            id={`${uid}-amount`}
            className="input"
            inputMode="numeric"
            value={amount}
            maxLength={9}
            onChange={(e) => setAmount(e.target.value)}
          />
          {errorFor('delta') !== null && <p className="mktform__error">{errorFor('delta')}</p>}
        </div>

        {/*
          THE ANSWER TO WHAT WAS JUST TYPED, in `.mktmath` — the same treatment
          the inspection form gives its award line, and for the same reason: it
          is the arithmetic being agreed to, not a hint about the box above it.

          The below-zero case is stated but NOT blocked. The balance here was
          read when the page loaded and the server's is authoritative; refusing
          the submit would make this screen's stale copy the rule, and the 409
          says the same sentence with the real figure.
        */}
        {size !== null && size > 0 && (
          <p className={`mktmath${wouldGoBelow ? ' mktmath--zero' : ''}`}>
            {wouldGoBelow
              ? belowZero(balance, size, points)
              : `Balance after: ${amountText(after, points)}`}
          </p>
        )}

        {/* One program is not a choice, so it is not a control — and unlike a
            return, which must belong to a program, a hand-made credit need not
            belong to one at all. With a single program the field is left off the
            body rather than filled in with the only answer available. */}
        {programs.length > 1 && (
          <div className="mktform__field">
            <span className="label">Program</span>
            <Select
              label="Program"
              value={programId}
              options={[
                { value: NO_PROGRAM, label: 'No program' },
                ...programs.map((program) => ({ value: program.id, label: program.name })),
              ]}
              onChange={setProgramId}
            />
            {errorFor('programId') !== null ? (
              <p className="mktform__error">{errorFor('programId')}</p>
            ) : (
              <p className="mktform__hint">
                Which program this is on behalf of, if any. It changes nothing about the balance —
                it is how the entry reads later.
              </p>
            )}
          </div>
        )}

        <div className="mktform__field">
          <span className="label">Reason</span>
          <Select
            label="Reason"
            value={preset}
            placeholder="Pick a reason…"
            options={REASONS.map((r) => ({ value: r.value, label: r.label }))}
            onChange={(value) => {
              setPreset(value);
              const chosen = REASONS.find((r) => r.value === value);
              // The preset WRITES the box rather than replacing it: what is
              // stored is what the box says at submit, so an operator can add
              // "— box arrived crushed" to it and the row keeps the whole thing.
              if (chosen !== undefined) setReason(chosen.text);
            }}
          />
        </div>

        <div className="mktform__field">
          <label className="label" htmlFor={`${uid}-reason`}>
            What it says on the ledger
          </label>
          <textarea
            id={`${uid}-reason`}
            className="input"
            rows={2}
            value={reason}
            maxLength={2000}
            onChange={(e) => setReason(e.target.value)}
          />
          {errorFor('reason') !== null ? (
            <p className="mktform__error">{errorFor('reason')}</p>
          ) : (
            <p className="mktform__hint">
              Written into the entry as it stands and never edited afterwards — the next person to
              be asked about this reads exactly this.
            </p>
          )}
        </div>

        {problem !== null && problem.field === null && (
          <p className="mktform__error" role="alert">
            {problem.message}
          </p>
        )}

        <div className="mktform__actions">
          {/* The button says what it will do, in the words the balance is kept
              in — the confirmation is the label, so there is no second dialog
              asking the same question in different words. */}
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {size === null || size < 1 ? verb : `${verb} ${amountText(size, points)}`}
          </button>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

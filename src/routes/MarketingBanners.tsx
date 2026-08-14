import { useCallback, useEffect, useId, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PanelTop } from 'lucide-react';
import {
  deriveBannerStatus,
  marketingApi,
  type Banner,
  type BannerDraft,
  type BannerPatch,
  type DerivedBannerStatus,
} from '../data/api-marketing';
import { ApiError, NotFoundError, OfflineError, StaleWriteError } from '../data/errors';
import { useToast } from '../components/Toast';
import { ConfirmDialog } from '../components/Dialog';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Feedback';
import { Switch } from '../components/ui/Switch';
import { useDelayed } from '../components/ui/useDelayed';
import './marketing.css';

/**
 * What the storefront shows, and when.
 *
 * A BANNER'S STATUS IS NOT STORED — it is derived, here and in the public
 * endpoint's WHERE clause, from the same pure function
 * (`shared/marketing/banners.ts`). What the row keeps is an INTENT: draft, live,
 * archived. Crossed with the clock that becomes one of five words, and every
 * chip on this screen is that crossing rather than a column read back. Nothing
 * flips a status on a schedule — there is no cron to do it with — so a banner
 * whose window opens at nine opens at nine because the reader evaluates it, not
 * because something woke up.
 *
 * WHICH IS WHY "WHY NOT SHOWING?" EXISTS. The worst failure this screen can have
 * is agreeing with itself: a row that says Live while the site shows nothing,
 * with no way to tell which of the two is lying. So a row that is switched on
 * and still invisible says WHICH condition it failed — the window, or a
 * higher-priority banner in the same place — and it works those out by walking
 * the shared function over the same list the storefront would be served.
 *
 * EVERY WRITE HERE IS `requireAuth`, NOT `requireOwner` (the spec's role
 * matrix: banner work is content work, the posts precedent). So there is no role
 * gate anywhere in this file and no control that is present for one person and
 * absent for another — if that ever changes, the change is a server change
 * first, and a control drawn ahead of it is a form in front of a 403.
 *
 * THERE IS NO DELETE. Archiving is a status, the public read excludes it, and
 * the row stays on this screen under its own heading. A banner that ran is a
 * thing that happened, and the ledger doctrine of the section next door applies
 * to it as much as to a points row.
 */

// ============================================================================
// THE WORDS
// ============================================================================

/**
 * The copy for a `bad_request`, keyed by the field path the server named.
 *
 * The catalogue's treatment for a 400 is "inline, keyed by `detail`", which
 * needs a sentence per field: `ctaText` is the server's name for a box labelled
 * "Button text", and a message quoting the path names nothing on screen.
 */
const FIELD_MESSAGE: Record<string, string> = {
  title: 'A banner needs a title — it is the line people actually read.',
  body: 'That wasn’t accepted.',
  ctaText: 'A button needs words on it.',
  /*
   * THE COLUMN'S OWN CHECK, said in words: `cta_url ~ '^(https?://|/)'`. A path
   * on your own site is legal and useful — the storefront links "/returns" far
   * more often than it links out — so a message insisting on a full link would
   * refuse the commonest correct answer.
   */
  ctaUrl: 'A full https:// link, or a path on your own site starting with a slash.',
  placement: 'That place wasn’t accepted.',
  status: 'That status wasn’t accepted.',
  startsAt: 'That start couldn’t be read.',
  endsAt: 'The end has to come after the start.',
  /*
   * "ZERO OR MORE", NOT "A WHOLE NUMBER". `-1` IS a whole number, and a refusal
   * that describes what was typed as the thing it wanted is the error that
   * teaches nobody anything — the box is refused for being negative, so the
   * sentence has to say negative.
   */
  priority: 'A whole number, zero or more. The highest one wins where two banners share a place.',
};

const fieldMessage = (field: string): string =>
  FIELD_MESSAGE[field] ?? 'That value wasn’t accepted.';

/**
 * A derived status, chipped — the SAME five words and the same five classes the
 * Overview's banners panel uses.
 *
 * Duplicated rather than imported, on this section's stated
 * copy-don't-couple doctrine, but the duplication is the risk worth naming: two
 * screens calling one derived state by two names is the drift the shared
 * function was introduced to prevent, one layer up. Both suites pin the words.
 *
 * `draft` and `archived` borrow `base.css`'s own chips; the three that are about
 * the clock get the `bnr` family, because "scheduled" already means something
 * else in this section (a return with a driver booked).
 */
const CHIP: Record<DerivedBannerStatus, string> = {
  draft: 'chip--draft',
  scheduled: 'bnrchip--scheduled',
  live: 'bnrchip--live',
  ended: 'bnrchip--ended',
  archived: 'chip--archived',
};

const WHAT: Record<DerivedBannerStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  live: 'Live',
  ended: 'Ended',
  archived: 'Archived',
};

/** Where a banner goes, what it is called out loud, and what choosing it means. */
const PLACEMENTS: { value: Banner['placement']; label: string; hint: string }[] = [
  {
    value: 'top_bar',
    label: 'Top bar',
    hint: 'A strip across the top of every page. One line, read in passing — keep it short.',
  },
  {
    value: 'popup',
    label: 'Popup',
    hint: 'A card over a dimmed page, dismissable. The loudest one you have; spend it carefully.',
  },
  {
    value: 'section',
    label: 'In-page section',
    hint: 'A card in the flow of a page. Interrupts nobody, and can carry more words.',
  },
];

const PLACEMENT_WHAT: Record<Banner['placement'], string> = {
  top_bar: 'top bar',
  popup: 'popup',
  section: 'in-page section',
};

/** The order the table groups by, so "highest wins per place" is legible. */
const PLACEMENT_ORDER: Banner['placement'][] = ['top_bar', 'popup', 'section'];

const WHEN_DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const WHEN_AT = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** Digits only. Priority is a rank, and a negative rank means nothing to it. */
const INT_RE = /^\d+$/;

/** The `cta_url` CHECK, restated. Both halves are legal answers. */
const URL_RE = /^(https?:\/\/|\/)/;

/** Long enough to recognise the banner, short enough not to be the banner. */
const EXCERPT = 90;

// ============================================================================
// THE FAILURES
// ============================================================================

function explainLoad(err: unknown, fallback = 'The banners didn’t load.'): string {
  if (err instanceof OfflineError) return 'The request didn’t reach the server.';
  if (err instanceof NotFoundError) return 'This deployment has no banner routes yet.';
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
  if (err instanceof NotFoundError) return 'That banner no longer exists.';
  if (err instanceof ApiError) {
    if (err.status === 403) return 'Your account isn’t allowed to change this.';
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
 * Every conflict in this section ships the re-read row (spec D7) so the notice
 * below can offer it without a second request. `StaleWriteError.post` is the
 * blog's field and is null on everything here, so the payload is read off the
 * envelope instead — typed loosely and checked, because it arrives from a server
 * written in another session.
 */
function carried(err: unknown, key: string): Banner | null {
  if (!(err instanceof ApiError)) return null;
  const body = err.body;
  if (body === null || typeof body !== 'object') return null;
  const found = (body as Record<string, unknown>)[key];
  if (found === null || typeof found !== 'object') return null;
  return typeof (found as Banner).revision === 'number' ? (found as Banner) : null;
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
// URL
// ============================================================================

/** The same params with the defaults dropped rather than written. */
function withParams(
  base: URLSearchParams,
  patch: Record<string, string | null>,
): URLSearchParams {
  const next = new URLSearchParams(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
  }
  return next;
}

const asSearch = (params: URLSearchParams): string => {
  const qs = params.toString();
  return qs === '' ? '' : `?${qs}`;
};

const LIST_TO = { pathname: '/marketing/banners', search: '' };

// ============================================================================
// THE READ-TIME RULE, WALKED OUT LOUD
// ============================================================================

/**
 * Which of two live banners the storefront puts first.
 *
 * `priority DESC, createdAt DESC` — the public endpoint's own ORDER BY
 * (contract #29), restated so the evaluator below answers with the row the site
 * would actually choose rather than with a guess about ties.
 */
const above = (a: Banner, b: Banner): boolean =>
  a.priority !== b.priority ? a.priority > b.priority : a.createdAt > b.createdAt;

/**
 * The banner that takes this one's place, or null when nothing does.
 *
 * The public route serves EVERY live banner for a placement, ordered; "highest
 * wins per place" is what the site does with that list, and the priority column
 * on this screen says so. So a live row can be perfectly valid and still
 * invisible, which is precisely the state an operator cannot diagnose from a
 * status chip — hence this.
 */
function beatenBy(banner: Banner, all: Banner[], now: number): Banner | null {
  if (deriveBannerStatus(banner, now) !== 'live') return null;
  let top = banner;
  for (const other of all) {
    if (other.id === banner.id || other.placement !== banner.placement) continue;
    if (deriveBannerStatus(other, now) !== 'live') continue;
    if (above(other, top)) top = other;
  }
  return top.id === banner.id ? null : top;
}

/**
 * Why a banner somebody has switched ON is not on the site, in one sentence.
 *
 * Null for everything that is either showing or honestly off: a draft is not
 * "not showing", it is unfinished, and saying otherwise would put a complaint
 * under every row somebody is still writing.
 */
function whyNotShowing(banner: Banner, all: Banner[], now: number): string | null {
  if (banner.status !== 'live') return null;
  const derived = deriveBannerStatus(banner, now);
  if (derived === 'scheduled' && banner.startsAt !== null) {
    return `It is switched on, but its window doesn’t open until ${WHEN_AT.format(new Date(banner.startsAt))}.`;
  }
  if (derived === 'ended' && banner.endsAt !== null) {
    return `Its window closed on ${WHEN_AT.format(new Date(banner.endsAt))} — extend the end date to relaunch it.`;
  }
  const winner = beatenBy(banner, all, now);
  if (winner !== null) {
    return `A higher priority banner has the ${PLACEMENT_WHAT[banner.placement]} — “${winner.title}”, at ${winner.priority}.`;
  }
  return null;
}

/** A window as a phrase. Both ends are optional and each absence means something. */
function windowText(banner: { startsAt: number | null; endsAt: number | null }): string {
  const from = banner.startsAt === null ? null : WHEN_DAY.format(new Date(banner.startsAt));
  const to = banner.endsAt === null ? null : WHEN_DAY.format(new Date(banner.endsAt));
  if (from !== null && to !== null) return `${from} → ${to}`;
  if (from !== null) return `from ${from}`;
  if (to !== null) return `until ${to}`;
  return 'whenever it is on';
}

// ============================================================================
// SCREEN
// ============================================================================

export default function MarketingBanners() {
  const [params] = useSearchParams();
  const editing = params.get('id');

  return (
    <div className="mktscr">
      {editing === null ? (
        /* Remounted per banner: the editor holds a draft of one row's words and
           dates, and carrying half of one banner into the next is the worst
           thing this screen could do quietly. */
        <BannerList />
      ) : (
        <BannerEditor key={editing} id={editing} />
      )}
    </div>
  );
}

// ============================================================================
// LIST
// ============================================================================

function BannerList() {
  const [banners, setBanners] = useState<Banner[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const showSkeletons = useDelayed(loading);

  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    setProblem(null);
    return marketingApi
      .listBanners(signal)
      .then((next) => {
        if (signal?.aborted) return;
        setBanners(next);
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

  const now = Date.now();
  const live = banners?.filter((b) => b.status !== 'archived') ?? [];
  const archived = banners?.filter((b) => b.status === 'archived') ?? [];

  /*
   * Grouped by place, then by the order the storefront reads them in. #21 serves
   * every row in one answer with no paging, so this is a display order over a
   * complete list rather than a re-sort of somebody's page — and it is what makes
   * "the highest one wins here" a thing you can see instead of work out.
   */
  const sorted = [...live].sort((a, b) => {
    const place = PLACEMENT_ORDER.indexOf(a.placement) - PLACEMENT_ORDER.indexOf(b.placement);
    return place !== 0 ? place : above(a, b) ? -1 : 1;
  });

  return (
    <>
      <header className="mktscr__head">
        <div className="mktscr__headrow">
          <div>
            <h1 className="mktscr__title">Banners</h1>
            <p className="mktscr__lede">
              What the site shows, and when. Switched on and inside its window means showing — the
              storefront asks for the list every minute, so a change lands within one. Dates and
              times here are this device’s.
            </p>
          </div>
          {/* Content work, so any signed-in staff member may do it — there is no
              owner gate on this screen anywhere. */}
          <Link
            className="btn btn--primary"
            to={{ pathname: '/marketing/banners', search: '?id=new' }}
          >
            New banner
          </Link>
        </div>
      </header>

      <div className="mktscr__body">
        {problem !== null ? (
          <div className="notice notice--danger" role="alert">
            <div>
              <strong>The banners didn’t load.</strong> {problem}
            </div>
            <div className="notice__actions">
              <button className="btn btn--outline btn--sm" onClick={() => void load()}>
                Try again
              </button>
            </div>
          </div>
        ) : banners === null ? (
          loading && showSkeletons ? (
            <div className="mktform__field" aria-hidden="true">
              <Skeleton height={18} width="55%" />
              <Skeleton height={18} width="40%" />
              <Skeleton height={18} width="62%" />
            </div>
          ) : null
        ) : banners.length === 0 ? (
          <div className="empty">
            <div className="empty__mark" aria-hidden="true">
              <PanelTop />
            </div>
            <h2 className="empty__title">Nothing is set up yet</h2>
            <p className="empty__body">
              The storefront checks for live banners every minute — create one, switch it on, and it
              shows within a minute.
            </p>
            <Link
              className="btn btn--outline"
              to={{ pathname: '/marketing/banners', search: '?id=new' }}
            >
              New banner
            </Link>
          </div>
        ) : (
          <>
            <section className="mktpanel">
              <div className="mktpanel__head">
                <h2 className="mktpanel__title">Banners</h2>
              </div>
              {sorted.length === 0 ? (
                <div className="mktpanel__body">
                  <p className="mktpanel__note">
                    Everything here is archived. Create a banner, or switch an archived one back on
                    from its own page.
                  </p>
                </div>
              ) : (
                <BannerTable rows={sorted} all={live} now={now} />
              )}
            </section>

            {archived.length > 0 && (
              <section className="mktpanel">
                <div className="mktpanel__head">
                  <h2 className="mktpanel__title">Archived</h2>
                </div>
                <div className="mktpanel__body">
                  <p className="mktpanel__note">
                    Off the site and kept for the record. There is no delete here — a banner that
                    ran is a thing that happened.
                  </p>
                </div>
                {/* Judged against the live rows, not against each other: an
                    archived banner competes with nothing, so `all` stays the
                    same list the storefront would be served. */}
                <BannerTable rows={archived} all={live} now={now} />
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}

/**
 * The rows, in four columns rather than the six a banner has facts.
 *
 * The excerpt rides under the title and the window under the status chip, for
 * the reason the programs table gives: a config table with six columns is a
 * table that scrolls sideways on the phone this section is meant to be usable
 * from. The scroller is still there — it is the wrapper, never the page, that
 * moves — and "Why not showing?" lands as a third quiet line under the chip it
 * contradicts, which is where the question gets asked.
 */
function BannerTable({ rows, all, now }: { rows: Banner[]; all: Banner[]; now: number }) {
  return (
    <div className="mktpanel__body mktpanel__body--flush">
      <div className="mkttable__scroll">
        <table className="mkttable">
          <thead>
            <tr>
              <th scope="col">Banner</th>
              <th scope="col">Where</th>
              <th scope="col">Showing</th>
              <th scope="col">Priority</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((banner) => {
              const derived = deriveBannerStatus(banner, now);
              const why = whyNotShowing(banner, all, now);
              return (
                <tr key={banner.id}>
                  <td>
                    <Link
                      className="mkttable__link"
                      to={{
                        pathname: '/marketing/banners',
                        search: `?id=${encodeURIComponent(banner.id)}`,
                      }}
                    >
                      {banner.title}
                    </Link>
                    {banner.body.trim() !== '' && (
                      <span className="mkttable__sub">
                        {banner.body.length > EXCERPT
                          ? `${banner.body.slice(0, EXCERPT).trimEnd()}…`
                          : banner.body}
                      </span>
                    )}
                  </td>
                  <td data-label="Where">
                    <span className="chip">{PLACEMENT_WHAT[banner.placement]}</span>
                  </td>
                  <td data-label="Showing">
                    <span className={`chip ${CHIP[derived]}`}>{WHAT[derived]}</span>
                    <span className="mkttable__sub">{windowText(banner)}</span>
                    {/* The evaluator, one sentence long. It walks the same
                        function the public read is written against, so it can
                        never disagree with the site about whose fault it is. */}
                    {why !== null && <span className="mkttable__sub">Why not showing? {why}</span>}
                  </td>
                  <td className="mkttable__num" data-label="Priority">
                    {banner.priority.toLocaleString()}
                    <span className="mkttable__sub">
                      Changed {WHEN_DAY.format(new Date(banner.updatedAt))}
                    </span>
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
// EDITOR
// ============================================================================

/** The form's copy of a banner. Strings throughout: a number half-typed is not
 *  yet a number, and a datetime box holds the browser's own local text. */
interface EditDraft {
  title: string;
  body: string;
  ctaText: string;
  ctaUrl: string;
  placement: Banner['placement'];
  status: Banner['status'];
  startsAt: string;
  endsAt: string;
  priority: string;
}

const BLANK: EditDraft = {
  title: '',
  body: '',
  ctaText: '',
  ctaUrl: '',
  placement: 'top_bar',
  status: 'draft',
  startsAt: '',
  endsAt: '',
  priority: '0',
};

/**
 * Epoch-ms to what `<input type="datetime-local">` holds, IN LOCAL TIME.
 *
 * Deliberately not `toISOString().slice(0, 16)`, which is the one-liner
 * everybody reaches for and is UTC: it shows a Lagos operator a window an hour
 * off its own label, and saves that hour back. The box means local, so it is
 * built out of the local getters.
 */
function toLocalInput(ms: number | null): string {
  if (ms === null) return '';
  const at = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * And back. `null` for an empty box — a REAL value here, meaning "no boundary"
 * — and `NaN` for text no browser should have let through, which the form
 * reports on the field rather than posting.
 */
function whenOf(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return new Date(trimmed).getTime();
}

/** The same, safe to derive a status from: unreadable is treated as absent. */
const orNull = (ms: number | null): number | null =>
  ms === null || Number.isNaN(ms) ? null : ms;

const fromBanner = (banner: Banner): EditDraft => ({
  title: banner.title,
  body: banner.body,
  ctaText: banner.ctaText ?? '',
  ctaUrl: banner.ctaUrl ?? '',
  placement: banner.placement,
  status: banner.status,
  startsAt: toLocalInput(banner.startsAt),
  endsAt: toLocalInput(banner.endsAt),
  priority: String(banner.priority),
});

/**
 * One banner, or a new one.
 *
 * THERE IS NO `GET /banners/:id` IN THE CONTRACT and this screen does not
 * pretend otherwise: the editor reads the list (#21, every status, no paging)
 * and finds its row. An id nothing matches gets the `gone` treatment — an
 * explanation and a way back, never a retry.
 *
 * THE PREVIEW TAKEOVER RETURNS EARLY, AND THIS COMPONENT STAYS MOUNTED. `?preview=1`
 * renders the stage instead of the form, from the same `draft` state, so "Back
 * to editing" restores half-typed words with nothing saved and nothing stashed.
 * A separate route would have been a second component and a lost draft.
 */
function BannerEditor({ id }: { id: string }) {
  const creating = id === 'new';
  const uid = useId();
  const navigate = useNavigate();
  const { notify } = useToast();
  const [params] = useSearchParams();
  const previewing = params.get('preview') === '1';

  const [banner, setBanner] = useState<Banner | null>(null);
  const [draft, setDraft] = useState<EditDraft>(BLANK);
  const [device, setDevice] = useState<'desktop' | 'phone'>('desktop');
  const [loading, setLoading] = useState(!creating);
  const [missing, setMissing] = useState(false);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [conflict, setConflict] = useState<Banner | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const showSkeletons = useDelayed(loading);

  useEffect(() => {
    if (creating) return;
    const ac = new AbortController();
    marketingApi
      .listBanners(ac.signal)
      .then((all) => {
        if (ac.signal.aborted) return;
        const found = all.find((b) => b.id === id) ?? null;
        if (found === null) setMissing(true);
        else {
          setBanner(found);
          setDraft(fromBanner(found));
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setLoadProblem(explainLoad(err, 'The banner didn’t load.'));
        setLoading(false);
      });
    return () => ac.abort();
  }, [creating, id]);

  const errorFor = (field: string): string | null =>
    problem !== null && problem.field === field ? problem.message : null;

  /** Everything both halves of the submit need, or the field that is wrong. */
  function readDraft():
    | {
        ok: true;
        title: string;
        body: string;
        cta: { text: string; url: string } | null;
        startsAt: number | null;
        endsAt: number | null;
        priority: number;
      }
    | { ok: false; problem: Problem } {
    const title = draft.title.trim();
    if (title === '') return { ok: false, problem: { field: 'title', message: fieldMessage('title') } };

    /*
     * THE PAIR IS A COLUMN CHECK — `(cta_text IS NULL) = (cta_url IS NULL)` — so
     * half a button is refused here, on the half that is missing, rather than
     * arriving as a 400 naming whichever field the server's schema happened to
     * read first. A button with no destination and a destination with no button
     * are both real mistakes and each has its own box.
     */
    const text = draft.ctaText.trim();
    const url = draft.ctaUrl.trim();
    if (url !== '' && text === '')
      return { ok: false, problem: { field: 'ctaText', message: fieldMessage('ctaText') } };
    if (text !== '' && url === '')
      return { ok: false, problem: { field: 'ctaUrl', message: 'Say where the button goes.' } };
    if (url !== '' && !URL_RE.test(url))
      return { ok: false, problem: { field: 'ctaUrl', message: fieldMessage('ctaUrl') } };

    const startsAt = whenOf(draft.startsAt);
    const endsAt = whenOf(draft.endsAt);
    if (startsAt !== null && Number.isNaN(startsAt))
      return { ok: false, problem: { field: 'startsAt', message: fieldMessage('startsAt') } };
    if (endsAt !== null && Number.isNaN(endsAt))
      return { ok: false, problem: { field: 'endsAt', message: fieldMessage('endsAt') } };
    /* The window CHECK (`ends_at > starts_at`), mirrored: the message lands on
       the END, because a window is entered start-first and the end is the box
       that was got wrong. */
    if (startsAt !== null && endsAt !== null && endsAt <= startsAt)
      return { ok: false, problem: { field: 'endsAt', message: fieldMessage('endsAt') } };

    const priority = int(draft.priority);
    if (priority === null)
      return { ok: false, problem: { field: 'priority', message: fieldMessage('priority') } };

    return {
      ok: true,
      title,
      body: draft.body.trim(),
      cta: url === '' ? null : { text, url },
      startsAt,
      endsAt,
      priority,
    };
  }

  async function create(): Promise<void> {
    const read = readDraft();
    if (!read.ok) return setProblem(read.problem);

    /*
     * NO `status` — contract #22 has no such field and everything created here
     * lands as a draft. Nothing this screen makes goes live without somebody
     * switching it on afterwards, which is one deliberate act rather than a
     * typo in a form.
     *
     * AND NO NULLS: what a new row has no value for is ABSENT here, where a
     * patch would send `null`. The two are not the same request — `null` means
     * "clear the end date somebody set", and there is nothing on a row that does
     * not exist yet to clear. Sending it anyway would make this body depend on
     * the create schema being nullable as well as optional, which the contract
     * never says it is.
     */
    const body: BannerDraft = {
      title: read.title,
      placement: draft.placement,
      priority: read.priority,
      ...(read.body === '' ? {} : { body: read.body }),
      ...(read.cta === null ? {} : { ctaText: read.cta.text, ctaUrl: read.cta.url }),
      ...(read.startsAt === null ? {} : { startsAt: read.startsAt }),
      ...(read.endsAt === null ? {} : { endsAt: read.endsAt }),
    };

    setBusy(true);
    setProblem(null);
    try {
      const made = await marketingApi.createBanner(body);
      notify(`${made.title} created as a draft`);
      navigate(LIST_TO);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && err.detail !== undefined)
        setProblem({ field: err.detail, message: fieldMessage(err.detail) });
      else notify(explainWrite(err), { tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  async function update(): Promise<void> {
    if (banner === null) return;
    const read = readDraft();
    if (!read.ok) return setProblem(read.problem);

    /*
     * EVERY FIELD, INCLUDING THE NULLS. Banner patches are the one family of
     * body this section does NOT run through the client's empty-field pruner
     * (`api-marketing.ts` says so at `filled()`): "clear the end date" is a real
     * `null`, and a pruner would turn the one edit that removes a boundary into
     * a request that quietly changes nothing.
     */
    const patch: BannerPatch = {
      expectedRevision: banner.revision,
      title: read.title,
      body: read.body,
      ctaText: read.cta?.text ?? null,
      ctaUrl: read.cta?.url ?? null,
      placement: draft.placement,
      status: draft.status,
      startsAt: read.startsAt,
      endsAt: read.endsAt,
      priority: read.priority,
    };

    setBusy(true);
    setProblem(null);
    try {
      const next = await marketingApi.patchBanner(banner.id, patch);
      setBanner(next);
      setDraft(fromBanner(next));
      setConflict(null);
      notify('Banner saved');
    } catch (err) {
      const fresh = carried(err, 'banner');
      if (err instanceof StaleWriteError && fresh !== null) setConflict(fresh);
      else if (err instanceof ApiError && err.status === 400 && err.detail !== undefined)
        setProblem({ field: err.detail, message: fieldMessage(err.detail) });
      else if (err instanceof NotFoundError) setMissing(true);
      else notify(explainWrite(err), { tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  /**
   * Archiving is ONE decision, so it posts one field.
   *
   * Not the whole form: "archive this" and "save these words" are two different
   * intentions, and folding a half-finished edit into the request that takes a
   * banner off the site would save words nobody asked to save. The list is where
   * this ends up, because archiving is what you do when you are finished with it.
   */
  async function archive(): Promise<void> {
    if (banner === null) return;
    setBusy(true);
    try {
      await marketingApi.patchBanner(banner.id, {
        expectedRevision: banner.revision,
        status: 'archived',
      });
      notify(`${banner.title} archived`);
      navigate(LIST_TO);
    } catch (err) {
      const fresh = carried(err, 'banner');
      if (err instanceof StaleWriteError && fresh !== null) setConflict(fresh);
      else notify(explainWrite(err), { tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------ states
  if (missing) {
    return (
      <>
        <header className="mktscr__head">
          <h1 className="mktscr__title">Banners</h1>
        </header>
        <div className="mktscr__body">
          <div className="empty">
            <div className="empty__mark" aria-hidden="true">
              <PanelTop />
            </div>
            <h2 className="empty__title">That banner no longer exists</h2>
            <p className="empty__body">
              It may have been opened from a stale link. Banners are never deleted — an archived one
              is still listed, so this is a link to something that was never here.
            </p>
            <Link className="btn btn--outline" to={LIST_TO}>
              Back to banners
            </Link>
          </div>
        </div>
      </>
    );
  }

  if (!creating && banner === null) {
    return (
      <>
        <header className="mktscr__head">
          <h1 className="mktscr__title">Banners</h1>
        </header>
        <div className="mktscr__body">
          {loadProblem !== null ? (
            <div className="notice notice--danger" role="alert">
              <div>
                <strong>The banner didn’t load.</strong> {loadProblem}
              </div>
              <div className="notice__actions">
                <Link className="btn btn--outline btn--sm" to={LIST_TO}>
                  Back to banners
                </Link>
              </div>
            </div>
          ) : loading && showSkeletons ? (
            <div className="mktform__field" aria-hidden="true">
              <Skeleton height={20} width="45%" />
              <Skeleton height={20} width="60%" />
              <Skeleton height={20} width="35%" />
            </div>
          ) : null}
        </div>
      </>
    );
  }

  const schedule = {
    status: draft.status,
    startsAt: orNull(whenOf(draft.startsAt)),
    endsAt: orNull(whenOf(draft.endsAt)),
  };
  const derived = deriveBannerStatus(schedule, Date.now());

  /* The full-screen stage, from the same draft, with the form still mounted
     behind this return. */
  if (previewing) {
    return (
      <div className="bnrpreview bnrpreview--full">
        <div className="bnrpreview__back">
          <Link
            className="btn btn--outline btn--sm"
            to={{
              pathname: '/marketing/banners',
              search: asSearch(withParams(params, { preview: null })),
            }}
          >
            Back to editing
          </Link>
        </div>
        <div className="bnrpreview__tools">
          <DeviceToggle name={`${uid}-device`} device={device} onChange={setDevice} />
        </div>
        <Stage draft={draft} device={device} />
        <p className="bnrpreview__caption">
          An approximation, drawn in this admin’s own colours — not a screenshot of the storefront.
        </p>
      </div>
    );
  }

  return (
    <>
      <header className="mktscr__head">
        <div className="mktscr__headrow">
          <div>
            <Link className="btn btn--ghost btn--sm" to={LIST_TO}>
              All banners
            </Link>
            <h1 className="mktscr__title">{creating ? 'New banner' : draft.title || 'Banner'}</h1>
            <p className="mktscr__lede">
              {creating
                ? 'It lands as a draft. Nothing you write here reaches the site until you switch it on.'
                : 'Everything here is read by customers. The preview beside it is the same words, laid out where they will land.'}
            </p>
          </div>
        </div>
      </header>

      <div className="mktscr__body">
        {/*
          THREE GRID CHILDREN, and the third one is why this is not two columns
          of panels: above 900px the form sits left, the preview sits right and
          the actions land under the form; below it the single column reads form
          → preview → Save, which puts the drawing of what is about to be
          published directly above the button that publishes it. This screen is
          the reason the pipeline's sticky action bar is NOT used here — a
          config form's Save belongs under the thing it commits.
        */}
        <div className="mktgrid">
          <form
            className="mktgrid__col"
            id={`${uid}-form`}
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (creating) void create();
              else void update();
            }}
          >
            {conflict !== null && (
              <div className="notice notice--warn" role="alert">
                <div>
                  Somebody else saved this banner while the form was open — it is now titled{' '}
                  <strong>{conflict.title}</strong>. Nothing here was written.
                </div>
                <div className="notice__actions">
                  <button
                    type="button"
                    className="btn btn--outline btn--sm"
                    onClick={() => {
                      // No second fetch: the 409 carried the whole row.
                      setBanner(conflict);
                      setDraft(fromBanner(conflict));
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
                <h2 className="mktpanel__title">What it says</h2>
              </div>
              <div className="mktpanel__body">
                <div className="mktform">
                  <div className="mktform__field">
                    <label className="label" htmlFor={`${uid}-title`}>
                      Title
                    </label>
                    <input
                      id={`${uid}-title`}
                      className="input"
                      value={draft.title}
                      maxLength={300}
                      onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    />
                    {errorFor('title') ? (
                      <p className="mktform__error">{errorFor('title')}</p>
                    ) : (
                      <p className="mktform__hint">
                        The line people read in passing. In a top bar it may be all they read.
                      </p>
                    )}
                  </div>

                  <div className="mktform__field">
                    <label className="label" htmlFor={`${uid}-body`}>
                      Body
                    </label>
                    <textarea
                      id={`${uid}-body`}
                      className="input"
                      rows={3}
                      value={draft.body}
                      maxLength={2000}
                      onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                    />
                    {errorFor('body') ? (
                      <p className="mktform__error">{errorFor('body')}</p>
                    ) : (
                      <p className="mktform__hint">Optional. A top bar rarely has room for it.</p>
                    )}
                  </div>

                  <div className="mktform__field">
                    <span className="label">The button, if there is one</span>
                    <div className="mktform__split">
                      <div className="mktform__field">
                        <label className="label" htmlFor={`${uid}-cta-text`}>
                          Button text
                        </label>
                        <input
                          id={`${uid}-cta-text`}
                          className="input"
                          value={draft.ctaText}
                          maxLength={120}
                          onChange={(e) => setDraft({ ...draft, ctaText: e.target.value })}
                        />
                        {errorFor('ctaText') && (
                          <p className="mktform__error">{errorFor('ctaText')}</p>
                        )}
                      </div>
                      <div className="mktform__field">
                        <label className="label" htmlFor={`${uid}-cta-url`}>
                          Button link
                        </label>
                        <input
                          id={`${uid}-cta-url`}
                          className="input"
                          value={draft.ctaUrl}
                          maxLength={2000}
                          placeholder="/returns"
                          onChange={(e) => setDraft({ ...draft, ctaUrl: e.target.value })}
                        />
                        {errorFor('ctaUrl') && (
                          <p className="mktform__error">{errorFor('ctaUrl')}</p>
                        )}
                      </div>
                    </div>
                    <p className="mktform__hint">
                      Both or neither — a button with nowhere to go is refused by the column itself.
                    </p>
                  </div>
                </div>
              </div>
            </section>

            <section className="mktpanel">
              <div className="mktpanel__head">
                <h2 className="mktpanel__title">Where it goes</h2>
              </div>
              <div className="mktpanel__body">
                <div className="mktform">
                  <div className="mktform__field">
                    <span className="label">Place on the page</span>
                    <Select
                      label="Place on the page"
                      value={draft.placement}
                      options={PLACEMENTS.map((p) => ({ value: p.value, label: p.label }))}
                      onChange={(value) =>
                        setDraft({ ...draft, placement: value as Banner['placement'] })
                      }
                    />
                    {errorFor('placement') ? (
                      <p className="mktform__error">{errorFor('placement')}</p>
                    ) : (
                      <p className="mktform__hint">
                        {PLACEMENTS.find((p) => p.value === draft.placement)?.hint}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </section>

            <section className="mktpanel">
              <div className="mktpanel__head">
                <h2 className="mktpanel__title">When it shows</h2>
              </div>
              <div className="mktpanel__body">
                <div className="mktform">
                  <div className="mktform__split">
                    <div className="mktform__field">
                      <label className="label" htmlFor={`${uid}-starts`}>
                        Starts
                      </label>
                      <input
                        id={`${uid}-starts`}
                        className="input"
                        type="datetime-local"
                        value={draft.startsAt}
                        onChange={(e) => setDraft({ ...draft, startsAt: e.target.value })}
                      />
                      {errorFor('startsAt') ? (
                        <p className="mktform__error">{errorFor('startsAt')}</p>
                      ) : (
                        <p className="mktform__hint">Empty means the moment you switch it on.</p>
                      )}
                    </div>
                    <div className="mktform__field">
                      <label className="label" htmlFor={`${uid}-ends`}>
                        Ends
                      </label>
                      <input
                        id={`${uid}-ends`}
                        className="input"
                        type="datetime-local"
                        value={draft.endsAt}
                        onChange={(e) => setDraft({ ...draft, endsAt: e.target.value })}
                      />
                      {errorFor('endsAt') ? (
                        <p className="mktform__error">{errorFor('endsAt')}</p>
                      ) : (
                        <p className="mktform__hint">Empty means until you turn it off.</p>
                      )}
                    </div>
                  </div>
                  {/*
                    THE WINDOW IS EVALUATED WHEN THE SITE ASKS, not by anything
                    that wakes up here: there is no scheduler in this deployment
                    and this screen does not imply one. Which also means the
                    times are read in the reader's own zone, and this box is in
                    yours.
                  */}
                  <p className="mktform__hint">
                    Times are this device’s. Nothing flips a banner on a schedule — the site works
                    the window out each time it asks, which it does about once a minute.
                  </p>
                </div>
              </div>
            </section>

            <section className="mktpanel">
              <div className="mktpanel__head">
                <h2 className="mktpanel__title">Priority and status</h2>
              </div>
              <div className="mktpanel__body">
                <div className="mktform">
                  <div className="mktform__field">
                    <label className="label" htmlFor={`${uid}-priority`}>
                      Priority
                    </label>
                    <input
                      id={`${uid}-priority`}
                      className="input"
                      inputMode="numeric"
                      value={draft.priority}
                      maxLength={4}
                      onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
                    />
                    {errorFor('priority') ? (
                      <p className="mktform__error">{errorFor('priority')}</p>
                    ) : (
                      <p className="mktform__hint">
                        The highest wins where two banners share a place. Zero is fine while there
                        is only one.
                      </p>
                    )}
                  </div>

                  {/* Create has no switch: contract #22 takes no status and
                      everything lands as a draft, so a control here would be a
                      promise the endpoint has no field for. */}
                  {!creating && (
                    <div className="mktform__field">
                      <div className="mktform__row">
                        <Switch
                          checked={draft.status === 'live'}
                          label="Showing on the site"
                          onChange={(on) =>
                            setDraft({ ...draft, status: on ? 'live' : 'draft' })
                          }
                        />
                        <span className="mktform__hint">
                          {draft.status === 'live' ? 'Switched on' : 'Switched off'}
                        </span>
                      </div>
                      {/*
                        THE DERIVED SENTENCE, FROM THE BOXES rather than from the
                        saved row. Switching this on with a window that closed
                        last week has to say "Ended" BEFORE the save, or the
                        operator learns it from a chip on the list afterwards and
                        wonders which of the two screens is wrong.
                      */}
                      {errorFor('status') ? (
                        <p className="mktform__error">{errorFor('status')}</p>
                      ) : (
                        <p className="mktform__hint">{sentenceFor(derived, schedule)}</p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </section>

            {problem !== null && problem.field === null && (
              <p className="mktform__error" role="alert">
                {problem.message}
              </p>
            )}
          </form>

          <section className="mktpanel mktside">
            <div className="mktpanel__head">
              <h2 className="mktpanel__title">Preview</h2>
            </div>
            <div className="mktpanel__body">
              <div className="bnrpreview">
                <div className="bnrpreview__tools">
                  <DeviceToggle name={`${uid}-device`} device={device} onChange={setDevice} />
                  {/* On a phone the editor is one column and a pane beside it
                      would be a column of nothing, so the preview gets a screen
                      of its own. The link is here at every width because a
                      bigger look is worth having on a laptop too. */}
                  <Link
                    className="btn btn--ghost btn--sm"
                    to={{
                      pathname: '/marketing/banners',
                      search: asSearch(withParams(params, { preview: '1' })),
                    }}
                  >
                    Full screen
                  </Link>
                </div>
                <Stage draft={draft} device={device} />
                <p className="bnrpreview__caption">
                  An approximation, drawn in this admin’s own colours — not a screenshot of the
                  storefront.
                </p>
              </div>
            </div>
          </section>

          <div className="mktform__actions">
            <button type="submit" form={`${uid}-form`} className="btn btn--primary" disabled={busy}>
              {creating ? 'Create banner' : 'Save banner'}
            </button>
            <Link className="btn btn--ghost" to={LIST_TO}>
              Cancel
            </Link>
            {/* No delete, here or anywhere. Already-archived rows do not offer
                it again — the switch above is how one comes back. */}
            {banner !== null && banner.status !== 'archived' && (
              <button
                type="button"
                className="btn btn--ghost"
                disabled={busy}
                onClick={() => setConfirmArchive(true)}
              >
                Archive banner…
              </button>
            )}
          </div>
        </div>
      </div>

      {banner !== null && (
        <ConfirmDialog
          open={confirmArchive}
          onClose={() => setConfirmArchive(false)}
          onConfirm={() => void archive()}
          sheet
          title={`Archive ${banner.title}?`}
          description="It stops showing immediately and stays on this screen under Archived. There is no delete — switching an archived banner back on is how it returns."
          confirmLabel="Archive it"
        />
      )}
    </>
  );
}

/**
 * What saving would mean, in one sentence.
 *
 * Written in the future tense on purpose: this is a restatement of the FORM, and
 * the form has not been saved. "Live" and "Will be Live the moment you save" are
 * different claims, and only the second one is true of a box somebody is looking
 * at.
 */
function sentenceFor(
  derived: DerivedBannerStatus,
  schedule: { startsAt: number | null; endsAt: number | null },
): string {
  switch (derived) {
    case 'draft':
      return 'Off. Nothing is shown and nothing is scheduled — switch it on when the words are right.';
    case 'scheduled':
      return schedule.startsAt === null
        ? 'Waiting for its window to open.'
        : `Will start showing on ${WHEN_AT.format(new Date(schedule.startsAt))}.`;
    case 'live':
      return 'Will be Live the moment you save.';
    case 'ended':
      return schedule.endsAt === null
        ? 'Its window has closed — extend the end date to relaunch it.'
        : `Ended ${WHEN_AT.format(new Date(schedule.endsAt))} — extend the end date to relaunch it.`;
    case 'archived':
      return 'Archived — off the site and out of the way. Switching it on brings it back.';
  }
}

/**
 * THE TOGGLE IS A WIDTH, NOT A SKIN.
 *
 * What actually differs between a phone banner and a desktop one is how many
 * characters land on a line, and that is the thing worth looking at before
 * publishing — a title that reads well in a top bar at 1280px and wraps to three
 * lines at 375px is the commonest way one of these goes wrong.
 *
 * `.mktseg`, the section's own "one of these is current" control, rather than a
 * Select: there are two answers and hiding one of them behind a click is a poor
 * trade for a toggle somebody flips twice a minute.
 */
function DeviceToggle({
  name,
  device,
  onChange,
}: {
  name: string;
  device: 'desktop' | 'phone';
  onChange: (next: 'desktop' | 'phone') => void;
}) {
  return (
    <div className="mktseg" role="radiogroup" aria-label="Preview width">
      {(['desktop', 'phone'] as const).map((option) => (
        <label className="mktseg__opt" key={option}>
          <input
            className="visually-hidden"
            type="radio"
            name={name}
            value={option}
            checked={device === option}
            onChange={() => onChange(option)}
          />
          <span>{option === 'desktop' ? 'Desktop' : 'Phone'}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * The drawing.
 *
 * NOTHING IN HERE IS INTERACTIVE, and that is deliberate rather than unfinished:
 * a popup's × and a call-to-action button are part of the PICTURE of a banner,
 * and rendering them as real controls would put two dead buttons — one of which
 * navigates away from the admin — inside a panel whose whole job is to be looked
 * at. The text is left readable so the preview is worth something to somebody
 * who cannot see the layout.
 */
function Stage({ draft, device }: { draft: EditDraft; device: 'desktop' | 'phone' }) {
  const title = draft.title.trim() === '' ? 'Untitled banner' : draft.title.trim();
  const body = draft.body.trim();
  const cta = draft.ctaText.trim();

  const button =
    cta === '' ? null : (
      <span className="btn btn--sm btn--outline bnrpreview__cta">{cta}</span>
    );

  return (
    <div className={`bnrpreview__stage bnrpreview__stage--${device}`}>
      {draft.placement === 'top_bar' && (
        <div className="bnrpreview__topbar">
          <span>{title}</span>
          {button}
        </div>
      )}

      {draft.placement === 'popup' && (
        <>
          <div className="bnrpreview__scrim" />
          <div className="bnrpreview__card">
            <span className="bnrpreview__close" aria-hidden="true">
              ×
            </span>
            <span className="bnrpreview__title">{title}</span>
            {body !== '' && <span className="bnrpreview__body">{body}</span>}
            {button}
          </div>
        </>
      )}

      {draft.placement === 'section' && (
        <div className="bnrpreview__section">
          <span className="bnrpreview__title">{title}</span>
          {body !== '' && <span className="bnrpreview__body">{body}</span>}
          {button}
        </div>
      )}
    </div>
  );
}

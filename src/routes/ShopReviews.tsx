import { useCallback, useEffect, useState } from 'react';
import { useSearchParams, type To } from 'react-router-dom';
import { Gauge, MessageSquareText, Star, Trash2 } from 'lucide-react';
import { useSession } from '../components/RequireAuth';
import { Picker, type PickerItem } from '../components/ui/Picker';
import { Tabs, type TabItem } from '../components/ui/Tabs';
import {
  destroyReview,
  listReviews,
  moderateReview,
  type AdminReview,
  type ReviewStatus,
  type SentimentLabel,
} from '../data/api-reviews';
import { isoAttr, safeFormat } from '../data/when';
import './shop.css';
import './reviews.css';

/**
 * Customer reviews — the moderation queue (issue #5).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A QUEUE, NOT A TABLE. Every review arrives `pending` and is invisible to
 * every customer until somebody here approves it, so the job this screen
 * exists for is reading a paragraph and making one decision about it. A dense
 * grid optimises for scanning a hundred rows; this optimises for reading one
 * review properly — the whole body, never truncated, with the decision
 * directly under the text it is about.
 *
 * THE FILTER LIVES IN THE URL (`?status=`, `?sentiment=`, `?product=`), which
 * is what makes "the flagged ones" a link somebody can send a colleague, and
 * what makes the back button undo a filter rather than leave the screen.
 *
 * NOTHING HERE EDITS A REVIEW. The API offers a status and nothing else, and
 * that is deliberate on both sides: an admin surface that could rewrite a
 * customer's words would make every review on the site unciteable. The only
 * destructive action is delete, it is owner-only at the server, and it is
 * hidden from everyone else rather than offered and refused.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * The four states a review can be in, in the order the queue works them.
 *
 * ONE CONSTANT, TWO CONTROLS. It is the segmented strip at the top of the
 * screen AND the set of moves offered under each card, and those two must
 * never drift: a status reachable by filter but not by decision is a lane with
 * nothing that can enter it. `TabItem`'s shape is what the strip needs, and
 * the card takes the same rows minus the one it is already in.
 */
const STATUS_TABS: readonly TabItem<ReviewStatus>[] = [
  { value: 'pending', label: 'Pending', hint: 'Waiting on a decision' },
  { value: 'approved', label: 'Approved', hint: 'Live on the product page' },
  { value: 'flagged', label: 'Flagged', hint: 'Held back for a second look' },
  { value: 'rejected', label: 'Rejected', hint: 'Never shown to customers' },
];

/** `any` is the absent filter, not a sentiment — it is dropped from the URL
 *  rather than written, so `?sentiment=any` never appears in a sendable link. */
type SentimentFilter = SentimentLabel | 'any';

/* Capitalised, because these are read as words on a control and not as the
   enum values they happen to be underneath. */
const SENTIMENT_OPTIONS: readonly PickerItem<SentimentFilter>[] = [
  { value: 'any', label: 'Any sentiment' },
  { value: 'positive', label: 'Positive' },
  { value: 'neutral', label: 'Neutral' },
  { value: 'negative', label: 'Negative' },
];

/** The API sends epoch ms; the admin is one timezone and reads plain dates. */
const WHEN = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function Stars({ rating }: { rating: number }) {
  return (
    <span className="rvstars" role="img" aria-label={`${rating} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} className={`ui-ic${n <= rating ? ' rvstars__on' : ''}`} aria-hidden="true" />
      ))}
    </span>
  );
}

function ReviewCard({
  review,
  isOwner,
  busy,
  onModerate,
  onDestroy,
}: {
  review: AdminReview;
  isOwner: boolean;
  busy: boolean;
  onModerate: (status: ReviewStatus) => void;
  onDestroy: () => void;
}) {
  /* Every status except the one it already has. A button that sets a review
     to the state it is in is a button that looks broken when pressed. */
  const moves = STATUS_TABS.filter((s) => s.value !== review.status);

  return (
    <article className={`rvcard rvcard--${review.status}`}>
      <header className="rvcard__head">
        <Stars rating={review.rating} />
        <span className={`chip rvchip--${review.sentimentLabel}`}>{review.sentimentLabel}</span>
        <span className={`chip rvchip--status-${review.status}`}>{review.status}</span>
        <span className="rvcard__product">{review.productSlug}</span>
      </header>

      {review.title && <h3 className="rvcard__title">{review.title}</h3>}

      {/*
        THE WHOLE BODY, NEVER CLAMPED. A moderation decision is a judgement
        about the text, and a card that hides the second half of a review is a
        card that invites the decision to be made on the first half.
      */}
      <p className="rvcard__body">{review.body}</p>

      <dl className="rvcard__meta">
        <div>
          <dt>From</dt>
          <dd>
            {review.authorName}{' '}
            {/* The email is staff-only — the public projection cannot return
                it — and it is here because "is this the same person again"
                is the question moderation actually asks. */}
            <a className="rvcard__email" href={`mailto:${review.authorEmail}`}>
              {review.authorEmail}
            </a>
          </dd>
        </div>
        <div>
          <dt>Written</dt>
          <dd>
            <time dateTime={isoAttr(review.createdAt)}>
              {safeFormat(WHEN, review.createdAt)}
            </time>
          </dd>
        </div>
        {review.moderatedAt !== null && (
          <div>
            <dt>Last decision</dt>
            <dd>
              <time dateTime={isoAttr(review.moderatedAt)}>
                {safeFormat(WHEN, review.moderatedAt)}
              </time>
            </dd>
          </div>
        )}
      </dl>

      <footer className="rvcard__actions">
        {moves.map((move) => (
          <button
            key={move.value}
            type="button"
            className={`btn btn--sm${move.value === 'approved' ? ' btn--primary' : ' btn--outline'}`}
            disabled={busy}
            title={move.hint}
            onClick={() => onModerate(move.value)}
          >
            {move.value === 'pending' ? 'Return to pending' : move.label}
          </button>
        ))}

        {/* Owner-only, and absent rather than disabled for everyone else: a
            control that exists only to refuse is the app asking "are you
            sure?" about something it will not do. */}
        {isOwner && (
          <button
            type="button"
            className="btn btn--sm btn--danger rvcard__destroy"
            disabled={busy}
            onClick={onDestroy}
          >
            <Trash2 className="ui-ic" aria-hidden="true" />
            Delete
          </button>
        )}
      </footer>
    </article>
  );
}

export default function ShopReviews() {
  const session = useSession();
  /*
   * `offline` carries this device's last confirmed user, which is enough to
   * decide what to RENDER — the server still decides what may happen, and
   * DELETE is owner-only there regardless of what this hides or shows.
   * `unknown` never reaches here (`RequireAuth` paints nothing until the
   * session resolves) and is handled anyway rather than asserted away.
   */
  const user = session.status === 'unknown' ? null : session.user;
  const isOwner = user?.role === 'owner';

  const [params, setParams] = useSearchParams();
  const status = (params.get('status') as ReviewStatus | null) ?? 'pending';
  const sentiment = params.get('sentiment') as SentimentLabel | null;
  const product = params.get('product');

  const [reviews, setReviews] = useState<AdminReview[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** The one review currently being written to, so only its buttons freeze. */
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await listReviews({
        status,
        sentiment: sentiment ?? undefined,
        product: product ?? undefined,
      });
      setReviews(page.items);
      setCursor(page.nextCursor);
    } catch {
      setError('The queue could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [status, sentiment, product]);

  useEffect(() => {
    void load();
  }, [load]);

  /** The same params with one key changed — `null` drops it entirely. */
  function withFilter(key: string, value: string | null): URLSearchParams {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    return next;
  }

  function setFilter(key: string, value: string | null) {
    setParams(withFilter(key, value), { replace: true });
  }

  /**
   * The address this screen would have under a different status, for the strip
   * to point at. It keeps `replace` because every other filter here does: a
   * strip that pushed while the sentiment picker replaced would make Back walk
   * a history only half this row wrote.
   */
  const statusLink = (next: ReviewStatus): To => {
    const search = withFilter('status', next).toString();
    /* Search only, no pathname — `To` without one keeps the current path, so
       this never has to know the route it is mounted at. */
    return { search: search === '' ? '' : `?${search}` };
  };

  /**
   * A moderated review LEAVES THE LIST it was moderated in, because the list
   * is a filter on status and it no longer matches. Refetching the page
   * instead would be a scroll jump and a flash of everything else; removing
   * the one row says exactly what happened.
   */
  async function onModerate(review: AdminReview, next: ReviewStatus) {
    setBusyId(review.id);
    setError(null);
    try {
      await moderateReview(review.id, next);
      setReviews((prev) => prev.filter((r) => r.id !== review.id));
    } catch {
      setError(`Could not move that review to ${next}.`);
    } finally {
      setBusyId(null);
    }
  }

  async function onDestroy(review: AdminReview) {
    /* The one irreversible action in this screen, and the only place it asks.
       A rejected review is already invisible everywhere, so deleting is for
       a legal removal rather than for tidying — worth a sentence and a stop. */
    const ok = window.confirm(
      `Delete this review from ${review.authorName} permanently? This cannot be undone.`,
    );
    if (!ok) return;

    setBusyId(review.id);
    setError(null);
    try {
      await destroyReview(review.id);
      setReviews((prev) => prev.filter((r) => r.id !== review.id));
    } catch {
      setError('Could not delete that review.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="shopscr">
      <header className="shopscr__head">
        <h1 className="shopscr__title">Reviews</h1>
        <p className="shopscr__lede">
          Customer reviews arrive here before anybody sees them. Approving one puts
          it on the product page; everything else keeps it off.
        </p>
      </header>

      <div className="shopscr__body">
        <div className="rvfilters">
          {/*
            THE SAME SEGMENTED CONTROL THE ORDERS SCREEN USES for board/table,
            and links for the same reason: the status IS the address, so "the
            flagged ones" stays something you can send a colleague. It dropped
            `role="tab"` on the way — there is no `tabpanel` under it, only the
            same list re-filtered, and `tab` without a panel is ARIA that reads
            worse than none. `Tabs` argues the whole thing.
          */}
          <Tabs
            label="Review status"
            value={status}
            items={STATUS_TABS}
            to={statusLink}
            replace
          />

          <div className="rvfilters__right">
            {/*
              THE RETURNS DESK'S DROPDOWN, with its search field turned off.
              Three sentiments and an "any" cannot be narrowed by typing, so the
              field would be furniture — but the rest of that control is exactly
              right here: a leading icon naming what is being chosen, a tick on
              the row in force, and one dropdown shape across the admin instead
              of a native `<select>` the design system cannot reach into.
            */}
            <Picker
              label="Sentiment"
              value={sentiment ?? 'any'}
              items={SENTIMENT_OPTIONS}
              onChange={(next) => setFilter('sentiment', next === 'any' ? null : next)}
              icon={<Gauge className="ui-ic" aria-hidden="true" />}
              searchable={false}
              /* End-aligned: this sits at the right edge of the filter row, and
                 a popup hanging off its left would run off a narrow window. */
              align="end"
            />

            <label className="visually-hidden" htmlFor="rv-product">
              Filter by product slug
            </label>
            <input
              id="rv-product"
              className="input rvfilters__product"
              placeholder="Product slug"
              defaultValue={product ?? ''}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setFilter('product', (e.target as HTMLInputElement).value.trim() || null);
                }
              }}
            />
          </div>
        </div>

        {error && (
          <div className="notice notice--danger" role="alert">
            <span>{error}</span>
            <div className="notice__actions">
              <button type="button" className="btn btn--sm btn--outline" onClick={() => void load()}>
                Try again
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="rvlist" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="rvcard rvcard--skeleton">
                <div className="skeleton" style={{ height: '1rem', width: '40%' }} />
                <div className="skeleton" style={{ height: '3.5rem' }} />
                <div className="skeleton" style={{ height: '1rem', width: '60%' }} />
              </div>
            ))}
          </div>
        ) : reviews.length === 0 ? (
          <div className="empty">
            <div className="empty__mark" aria-hidden="true">
              <MessageSquareText />
            </div>
            <h2 className="empty__title">
              {status === 'pending' ? 'Nothing waiting' : `No ${status} reviews`}
            </h2>
            <p className="empty__body">
              {status === 'pending'
                ? 'Every review that has come in has been dealt with. New ones land here as customers write them.'
                : 'Nothing matches this filter yet.'}
            </p>
          </div>
        ) : (
          <>
            <div className="rvlist">
              {reviews.map((review) => (
                <ReviewCard
                  key={review.id}
                  review={review}
                  isOwner={isOwner}
                  busy={busyId === review.id}
                  onModerate={(next) => void onModerate(review, next)}
                  onDestroy={() => void onDestroy(review)}
                />
              ))}
            </div>

            {/* The API pages by cursor. This screen deliberately does not
                accumulate: a moderation queue is worked from the top, and a
                thousand-row page is a scroll position nobody keeps. */}
            {cursor !== null && (
              <p className="rvlist__more">
                More reviews match this filter. Work through these and reload.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

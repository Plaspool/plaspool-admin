import { useEffect, useMemo, useState } from 'react';
import { MessageSquare, Star, Trash2 } from 'lucide-react';
import {
  destroyReply,
  destroyReview,
  listReviews,
  loadThread,
  moderateReply,
  moderateReview,
  replyAsOwner,
  type AdminReply,
  type AdminReview,
  type ReviewStatus,
  type ReviewThread,
} from '../../data/api-reviews';
import { ApiError } from '../../data/errors';
import { BrandLogo } from '../../components/BrandLogo';
import { TextArea } from '../ui/Field';
import { getSession } from '../../data/session';
import { useAsync } from '../lib/useAsync';
import { dateTime, shortDate } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button, EmptyState, Stars, type BadgeTone } from '../ui/primitives';
import { DataTable, IdCell, TablePager, type Column } from '../ui/DataTable';
import { Defs } from '../ui/Defs';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

/**
 * REVIEWS — `/products/reviews`, the moderation queue.
 *
 * The one write moderation has is a STATUS MOVE — the rating, the words and
 * the sentiment are the customer's and are never edited here; an admin that
 * could rewrite a review would make every review on the site unciteable
 * (the API module's own words). Approve puts it on the storefront, reject
 * hides it, and both say so.
 */

const TABS: { value: ReviewStatus | 'all'; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'flagged', label: 'Flagged' },
  { value: 'all', label: 'All' },
];

const SENTIMENT_TONE: Record<AdminReview['sentimentLabel'], BadgeTone> = {
  positive: 'ok',
  neutral: 'neutral',
  negative: 'critical',
};

const STATUS_TONE: Record<ReviewStatus, BadgeTone> = {
  pending: 'warn',
  approved: 'ok',
  rejected: 'neutral',
  flagged: 'critical',
};

export default function Reviews() {
  const toast = useToast();
  const [tab, setTab] = useState<ReviewStatus | 'all'>('pending');
  const [search, setSearch] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const [nonce, setNonce] = useState(0);
  const [openReview, setOpenReview] = useState<AdminReview | null>(null);
  const [confirmDestroy, setConfirmDestroy] = useState<AdminReview | null>(null);

  const session = getSession();
  const isOwner = 'user' in session && session.user?.role === 'owner';

  const { data, error, loading } = useAsync(
    () =>
      listReviews({
        ...(tab === 'all' ? {} : { status: tab }),
        ...(cursor ? { cursor } : {}),
        limit: 25,
      }),
    [tab, cursor, nonce],
  );

  const all = data?.items ?? [];
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (r) =>
        r.body.toLowerCase().includes(q) ||
        (r.title ?? '').toLowerCase().includes(q) ||
        r.authorName.toLowerCase().includes(q) ||
        r.productSlug.toLowerCase().includes(q),
    );
  }, [all, search]);

  const reload = () => setNonce((n) => n + 1);

  async function moderate(review: AdminReview, status: ReviewStatus) {
    try {
      await moderateReview(review.id, status);
      toast.show(
        status === 'approved'
          ? 'Approved — now on the storefront'
          : status === 'rejected'
            ? 'Rejected — hidden from the storefront'
            : `Marked ${status}`,
      );
      setOpenReview(null);
      reload();
    } catch (cause) {
      toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
    }
  }

  async function destroy(review: AdminReview) {
    try {
      await destroyReview(review.id);
      toast.show('Review deleted');
      setConfirmDestroy(null);
      setOpenReview(null);
      reload();
    } catch (cause) {
      toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
    }
  }

  const columns: Column<AdminReview>[] = [
    {
      key: 'review',
      header: 'Review',
      primary: true,
      render: (r) => (
        <IdCell
          title={
            <span className="row" style={{ gap: 'var(--s2)' }}>
              <Stars value={r.rating} />
              <span>{r.title || <span className="muted">Untitled</span>}</span>
            </span>
          }
          meta={
            <>
              {r.authorName} · {r.body.length > 90 ? `${r.body.slice(0, 90)}…` : r.body}
            </>
          }
        />
      ),
    },
    {
      key: 'product',
      header: 'Product',
      label: 'Product',
      render: (r) => <span className="mono">/{r.productSlug}</span>,
    },
    {
      key: 'status', mobile: 'keep',
      header: 'Status',
      label: 'Status',
      tight: true,
      render: (r) => <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>,
    },
    {
      key: 'sentiment',
      header: 'Sentiment',
      label: 'Sentiment',
      tight: true,
      render: (r) => <Badge tone={SENTIMENT_TONE[r.sentimentLabel]}>{r.sentimentLabel}</Badge>,
    },
    {
      key: 'date',
      header: 'Date',
      label: 'Date',
      render: (r) => shortDate(r.createdAt),
    },
    {
      key: 'act', pin: true,
      header: <span className="sr">Actions</span>,
      label: 'Quick actions',
      tight: true,
      render: (r) =>
        r.status === 'pending' || r.status === 'flagged' ? (
          <span className="row" style={{ gap: 'var(--s1)' }}>
            <Button onClick={() => void moderate(r, 'approved')}>Approve</Button>
            <Button tone="plain" onClick={() => void moderate(r, 'rejected')}>
              Reject
            </Button>
          </span>
        ) : null,
    },
  ];

  return (
    <div className="page">
      <PageHeader icon={<Star />} title="Reviews" subtitle="Nothing shows on the storefront until it is approved." />

      {error ? (
        <Banner tone="critical" title="Couldn’t load reviews">
          {error}
        </Banner>
      ) : null}

      <DataTable
        caption="Reviews"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        onRowClick={setOpenReview}
        loading={loading}
        tabs={{
          value: tab,
          tabs: TABS,
          onChange: (next) => {
            setCursors([null]);
            setTab(next);
          },
        }}
        search={{
          value: search,
          placeholder: 'Filter the reviews on this page',
          onChange: setSearch,
        }}
        empty={
          search ? (
            <EmptyState
              icon={<MessageSquare />}
              title="No reviews match that filter"
              actions={<Button onClick={() => setSearch('')}>Clear filter</Button>}
            />
          ) : tab === 'pending' ? (
            <EmptyState
              icon={<MessageSquare />}
              title="Nothing awaiting moderation"
              body="New reviews land here first and stay off the storefront until approved."
            />
          ) : (
            <EmptyState
              icon={<MessageSquare />}
              title="No reviews here yet"
              body="Customers can review a product from its storefront page."
            />
          )
        }
        footer={
          <TablePager
            note={`${rows.length} shown`}
            canPrev={cursors.length > 1}
            canNext={Boolean(data?.nextCursor)}
            onPrev={() => setCursors((c) => c.slice(0, -1))}
            onNext={() => setCursors((c) => [...c, data?.nextCursor ?? null])}
          />
        }
      />

      {openReview ? (
        <Modal
          title={openReview.title || 'Review'}
          onClose={() => setOpenReview(null)}
          footer={
            <>
              {isOwner ? (
                <Button
                  tone="plain"
                  onClick={() => setConfirmDestroy(openReview)}
                  aria-label="Delete review"
                >
                  <Trash2 aria-hidden="true" />
                  Delete
                </Button>
              ) : null}
              <span className="spacer" />
              {openReview.status !== 'rejected' ? (
                <Button onClick={() => void moderate(openReview, 'rejected')}>Reject</Button>
              ) : null}
              {openReview.status !== 'approved' ? (
                <Button tone="primary" onClick={() => void moderate(openReview, 'approved')}>
                  Approve
                </Button>
              ) : null}
            </>
          }
        >
          <div className="stack">
            <div className="row" style={{ gap: 'var(--s2)' }}>
              <Stars value={openReview.rating} />
              <Badge tone={STATUS_TONE[openReview.status]}>{openReview.status}</Badge>
              <Badge tone={SENTIMENT_TONE[openReview.sentimentLabel]}>
                {openReview.sentimentLabel}
              </Badge>
            </div>
            <p style={{ fontSize: 'var(--t-md)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {openReview.body}
            </p>
            <Defs
              rows={[
                { label: 'Product', value: <span className="mono">/{openReview.productSlug}</span> },
                { label: 'Author', value: `${openReview.authorName} · ${openReview.authorEmail}` },
                {
                  label: 'Order',
                  value: openReview.orderId ? (
                    <a href={`#/orders/${openReview.orderId}`}>View order</a>
                  ) : (
                    'Not linked to an order'
                  ),
                },
                { label: 'Written', value: dateTime(openReview.createdAt) },
                ...(openReview.moderatedAt
                  ? [
                      {
                        label: 'Moderated',
                        value: `${dateTime(openReview.moderatedAt)}${openReview.moderatedBy ? ` · ${openReview.moderatedBy}` : ''}`,
                      },
                    ]
                  : []),
              ]}
            />
            {/* The thread. Only for an APPROVED review: nothing can be replied
                to until it is public, and the server refuses on the same rule —
                so offering a composer here would be a control that 404s. */}
            {openReview.status === 'approved' ? (
              <ThreadPanel
                review={openReview}
                isOwner={isOwner}
                onError={(message) => toast.show(message)}
              />
            ) : (
              <p className="field__hint">
                Replies open once this review is approved — there is nothing public
                to reply to before that.
              </p>
            )}
          </div>
        </Modal>
      ) : null}

      {confirmDestroy ? (
        <Modal
          title="Delete this review?"
          onClose={() => setConfirmDestroy(null)}
          footer={
            <>
              <Button onClick={() => setConfirmDestroy(null)}>Cancel</Button>
              <Button tone="critical" onClick={() => void destroy(confirmDestroy)}>
                Delete forever
              </Button>
            </>
          }
        >
          <p style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
            Deleting removes it everywhere, permanently. Rejecting instead keeps the record while
            hiding it from the storefront — usually the better move.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * The thread under one review: every reply whatever its status, the shop's
 * composer, and both reaction counts.
 *
 * ITS OWN COMPONENT, AND ITS OWN FETCH. The list route does not carry replies —
 * a reply query per row would be an N+1 on a moderation table nobody reads
 * threads from — so the panel loads when the modal opens and owns that state.
 *
 * PENDING REPLIES ARE SHOWN, GREYED AND BADGED. This is the moderation
 * surface: a queue that hid what it was queueing would be useless.
 */
function ThreadPanel({
  review,
  isOwner,
  onError,
}: {
  review: AdminReview;
  isOwner: boolean;
  onError: (message: string) => void;
}) {
  const [thread, setThread] = useState<ReviewThread | null>(null);
  const [draft, setDraft] = useState('');
  /** Which reply the composer is answering, or null for the review itself. */
  const [replyTo, setReplyTo] = useState<AdminReply | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    loadThread(review.id)
      .then((t) => {
        if (live) setThread(t);
      })
      .catch(() => {
        /* Swallowed to an empty thread rather than surfaced: the panel is an
           adjunct to the review, and a modal that refused to open because the
           replies could not be fetched would be worse than one without them. */
        if (live) setThread({ replies: [], reactions: { helpful: 0, unhelpful: 0 } });
      });
    return () => {
      live = false;
    };
  }, [review.id]);

  async function send() {
    const body = draft.trim();
    if (body.length < 2 || busy) return;
    setBusy(true);
    try {
      /* `replyTo?.id ?? null` — replying to a reply nests one level; replying to
         the review itself is top level. The server refuses a third level with a
         400 naming `parentId`, so the button below is hidden at depth 1 rather
         than the refusal being the user's first hint. */
      await replyAsOwner(review.id, body, replyTo?.id ?? null);
      setDraft('');
      setReplyTo(null);
      setThread(await loadThread(review.id));
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not post the reply.');
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(reply: AdminReply, status: ReviewStatus) {
    setBusy(true);
    try {
      await moderateReply(reply.id, status);
      setThread(await loadThread(review.id));
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not update the reply.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(reply: AdminReply) {
    setBusy(true);
    try {
      await destroyReply(reply.id);
      setThread(await loadThread(review.id));
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not delete the reply.');
    } finally {
      setBusy(false);
    }
  }

  if (thread === null) return <p className="field__hint">Loading the thread…</p>;

  return (
    <div className="thread">
      <div className="thread__counts">
        {/* The asymmetry is deliberate and this is the only surface that shows
            both — see 0620. Publicly there is no dislike number to organise
            around; here the owner gets the signal. */}
        <Badge tone="neutral">{thread.reactions.helpful} found this helpful</Badge>
        {thread.reactions.unhelpful > 0 ? (
          <Badge tone="warn">{thread.reactions.unhelpful} did not · staff only</Badge>
        ) : null}
      </div>

      {thread.replies.length === 0 ? (
        <p className="field__hint">No replies yet.</p>
      ) : (
        <ul className="thread__list">
          {thread.replies.map((reply) => (
            <li
              key={reply.id}
              className={`thread__item${reply.depth === 1 ? ' thread__item--nested' : ''}${
                reply.status === 'approved' ? '' : ' thread__item--muted'
              }`}
            >
              <div className="thread__head">
                {/* The shop's own replies wear the logomark, which is exactly
                    what the storefront does — one visual rule, both surfaces. */}
                {reply.authorKind === 'owner' ? (
                  <BrandLogo variant="mark" className="thread__avatar" />
                ) : (
                  <span className="thread__avatar thread__avatar--initial" aria-hidden="true">
                    {reply.authorName.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <strong>{reply.authorName}</strong>
                {reply.authorKind === 'owner' ? <Badge tone="info">Shop</Badge> : null}
                {reply.status !== 'approved' ? (
                  <Badge tone={STATUS_TONE[reply.status]}>{reply.status}</Badge>
                ) : null}
                <span className="spacer" />
                <span className="field__hint">{dateTime(reply.createdAt)}</span>
              </div>

              <p className="thread__body">{reply.body}</p>

              <div className="thread__actions">
                {/* Only CUSTOMER replies are moderated. An owner reply is
                    approved at birth, and offering to approve our own writing
                    would be a control with nothing behind it. */}
                {reply.authorKind === 'customer' && reply.status !== 'approved' ? (
                  <Button tone="primary" onClick={() => void setStatus(reply, 'approved')} disabled={busy}>
                    Approve
                  </Button>
                ) : null}
                {reply.authorKind === 'customer' && reply.status !== 'rejected' ? (
                  <Button tone="plain" onClick={() => void setStatus(reply, 'rejected')} disabled={busy}>
                    Reject
                  </Button>
                ) : null}
                {/* Depth 1 is the ceiling, so the reply button disappears there
                    rather than offering an action the server would refuse. */}
                {reply.depth === 0 ? (
                  <Button tone="plain" onClick={() => setReplyTo(reply)} disabled={busy}>
                    Reply
                  </Button>
                ) : null}
                {isOwner ? (
                  <Button
                    tone="plain"
                    aria-label={`Delete reply by ${reply.authorName}`}
                    onClick={() => void remove(reply)}
                    disabled={busy}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="thread__composer">
        <TextArea
          label={replyTo ? `Replying to ${replyTo.authorName}` : 'Reply as the shop'}
          value={draft}
          rows={3}
          placeholder="Answer as PlaSpool. This is public the moment you post it."
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="thread__composer-foot">
          {replyTo ? (
            <Button tone="plain" onClick={() => setReplyTo(null)} disabled={busy}>
              Reply to the review instead
            </Button>
          ) : (
            <span />
          )}
          <Button
            tone="primary"
            busy={busy}
            disabled={draft.trim().length < 2}
            onClick={() => void send()}
          >
            Post reply
          </Button>
        </div>
      </div>
    </div>
  );
}

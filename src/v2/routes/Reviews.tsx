import { useMemo, useState } from 'react';
import { MessageSquare, Star, Trash2 } from 'lucide-react';
import {
  destroyReview,
  listReviews,
  moderateReview,
  type AdminReview,
  type ReviewStatus,
} from '../../data/api-reviews';
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

/* TODO(tests): none — skipped this session, recorded in CLAUDE.md. Worth
 * pinning: destroy stays hidden for a writer role, and moderation never
 * touches the review's words. */

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
      key: 'act',
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

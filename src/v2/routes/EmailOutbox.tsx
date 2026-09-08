import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Archive,
  CheckCircle2,
  Eye,
  Inbox,
  Mail,
  MoreHorizontal,
  RefreshCw,
} from 'lucide-react';
import { shopApi, type OutboxBucket, type ShopOutboxItem } from '../../data/api-shop';
import { dateTime } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button, EmptyState } from '../ui/primitives';
import { DataTable, IdCell, type Column } from '../ui/DataTable';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu';
import { Modal } from '../ui/Modal';
import { Defs } from '../ui/Defs';
import { useToast } from '../ui/Toast';

/**
 * OUTBOX — `/emails/outbox`, the screen the "N emails will never send" banner
 * has pointed at in spirit since `emailBacklog` existed and in fact only now.
 *
 * Every order email is written as an INTENT in the same statement as the state
 * change that owed it, and a sweeper delivers them later (the whole design is
 * in `server/shop/orders/repo/emails.ts`). This screen is that table made
 * visible, with the two verbs the server grew in migration 0660's range:
 * retry (reset the counter AND sweep now) and dismiss (stop counting it).
 */

/** Mirrors EMAIL_ATTEMPT_LIMIT server-side — the "x of 8" on a queued row. */
const ATTEMPT_LIMIT = 8;

/** The dotted kinds, as sentences an operator scans rather than parses. */
const KIND_LABELS: Record<string, string> = {
  placed: 'Order placed',
  confirmation: 'Order confirmed',
  shipment: 'Order shipped',
  delivered: 'Order delivered',
  cancellation: 'Order cancelled',
  refund: 'Refund issued',
  refund_failed: 'Refund failed',
  review_invite: 'Review invitation',
  review_approved: 'Review approved',
  /* The one row addressed to US rather than to a customer (migration 0980),
     and the label says so for the reason `SYSTEM_TEMPLATE_STAGES` prefixes its
     twin `Staff — `: on a list of recipients and subjects there is nothing
     else to tell them apart. The wording follows the template's own name in
     `server/mail/defaults.ts`, so the outbox row and the template a reader
     goes on to edit say the same thing. */
  staff_new_order: 'New order — staff alert',
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

function statusBadge(i: ShopOutboxItem) {
  if (i.sentAt) return <Badge tone="ok">Sent</Badge>;
  if (i.dismissedAt) return <Badge>Dismissed</Badge>;
  if (i.attempts >= ATTEMPT_LIMIT) return <Badge tone="critical">Won’t send</Badge>;
  return (
    <Badge tone="info">
      Queued · try {Math.min(i.attempts + 1, ATTEMPT_LIMIT)} of {ATTEMPT_LIMIT}
    </Badge>
  );
}

const TABS: { value: OutboxBucket; label: string }[] = [
  { value: 'attention', label: 'Needs attention' },
  { value: 'queued', label: 'Queued' },
  { value: 'sent', label: 'Sent' },
  { value: 'dismissed', label: 'Dismissed' },
];

/** What an empty bucket means, said per bucket — an empty "needs attention"
 * is good news and should read like it. */
const EMPTY: Record<OutboxBucket, { title: string; body: string }> = {
  attention: {
    title: 'Nothing needs you',
    body: 'No email has given up trying. If one does, it appears here with the reason, and a Retry button that sends it straight away.',
  },
  queued: {
    title: 'Nothing waiting',
    body: 'Emails wait here for a few minutes at most, then get handed to the mail service.',
  },
  sent: {
    title: 'Nothing sent yet',
    body: 'Order emails appear here once they have been sent.',
  },
  dismissed: {
    title: 'Nothing dismissed',
    body: 'Dismissing a failed email stops it showing up on your Home screen. Retry brings it back.',
  },
};

export default function EmailOutbox() {
  const toast = useToast();
  const [bucket, setBucket] = useState<OutboxBucket>('attention');
  const [viewing, setViewing] = useState<ShopOutboxItem | null>(null);
  const [sending, setSending] = useState(false);
  const { data, error, loading, reload } = useAsync(
    (signal) => shopApi.listEmailOutbox(bucket, signal),
    [bucket],
  );

  /**
   * Run the sweep now rather than waiting for whatever is scheduled to.
   *
   * THE REASON THIS BUTTON EXISTS IS THE PREVIEW HOST. Production has an
   * external cron holding the `CRON_SECRET`, so its queue is seconds old and
   * this is only ever a nudge. `admin.dev.plaspool.com` has nothing: Vercel
   * fires cron entries for the PRODUCTION deployment alone, and the external
   * service authenticates with production's secret. So mail written on dev sat
   * unsent at `attempts = 0` indefinitely, while the ORDER still went `paid`
   * because the storefront's checkout-complete page settles the capture itself
   * — an outbox that never moves behind a shop that plainly works.
   *
   * It sweeps everything, not just mail: payments settle and commerce events
   * drain in the same pass, because they are one route and splitting them would
   * mean a second button for a distinction nobody making an order has.
   */
  async function sendQueued() {
    setSending(true);
    try {
      const res = await shopApi.sweepNow();
      const { sent, failed } = res.emails;
      if (sent > 0 && failed > 0) {
        /* `critical` and not a gentler tone because there is no gentler tone —
           Toast takes default | critical only — and a partial failure is the
           half a person has to act on. */
        toast.show(`${sent} sent, ${failed} failed — the reasons are on the rows.`, 'critical');
      } else if (sent > 0) {
        toast.show(sent === 1 ? '1 email sent' : `${sent} emails sent`);
      } else if (failed > 0) {
        toast.show('Nothing sent — every attempt failed. The reasons are on the rows.', 'critical');
      } else {
        toast.show('Nothing was waiting to send');
      }
    } catch (cause) {
      toast.show(
        cause instanceof Error && cause.message ? cause.message : 'Something went wrong.',
        'critical',
      );
    } finally {
      /* Cleared before the reload, not after: the button is what the person is
         looking at, and leaving it busy while a table refetches reads as a
         click that did not land. */
      setSending(false);
    }
    reload();
  }

  async function retry(i: ShopOutboxItem) {
    try {
      const res = await shopApi.retryEmailIntent(i.id);
      if (res.emails.sent > 0) {
        toast.show(res.emails.sent === 1 ? 'Sent' : `Sent — ${res.emails.sent} delivered`);
      } else if (res.emails.failed > 0) {
        toast.show('It failed again. The new reason is shown on the row.', 'critical');
      } else {
        toast.show('Queued — it will be sent shortly');
      }
    } catch (cause) {
      toast.show(
        cause instanceof Error && cause.message ? cause.message : 'Something went wrong.',
        'critical',
      );
    }
    reload();
  }

  async function dismiss(i: ShopOutboxItem) {
    try {
      await shopApi.dismissEmailIntent(i.id);
      toast.show('Dismissed — it won’t send, and won’t be counted');
    } catch (cause) {
      toast.show(
        cause instanceof Error && cause.message ? cause.message : 'Something went wrong.',
        'critical',
      );
    }
    reload();
  }

  const counts = data?.counts;
  const tabs = TABS.map((t) => ({
    value: t.value,
    label: counts && counts[t.value] > 0 ? `${t.label} · ${counts[t.value]}` : t.label,
  }));

  const columns: Column<ShopOutboxItem>[] = [
    {
      key: 'email',
      header: 'Email',
      primary: true,
      render: (i) => (
        <IdCell
          thumb={<Mail aria-hidden="true" />}
          title={i.subject}
          meta={`${kindLabel(i.kind)} · to ${i.to}`}
        />
      ),
    },
    {
      key: 'status',
      header: 'Status',
      label: 'Status',
      tight: true,
      mobile: 'keep',
      render: (i) => statusBadge(i),
    },
    {
      key: 'order',
      header: 'Order',
      label: 'Order',
      tight: true,
      render: (i) => (
        <Link className="mono" style={{ fontSize: 'var(--t-sm)' }} to={`/orders/${i.orderId}`}>
          {i.orderNumber}
        </Link>
      ),
    },
    {
      key: 'error',
      header: 'Last error',
      label: 'Last error',
      render: (i) =>
        i.lastError ? (
          <span
            className="muted"
            style={{
              fontSize: 'var(--t-sm)',
              display: 'inline-block',
              maxWidth: '18rem',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={i.lastError}
          >
            {i.lastError}
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      key: 'when',
      header: bucket === 'sent' ? 'Sent' : 'Created',
      label: bucket === 'sent' ? 'Sent' : 'Created',
      render: (i) => dateTime(bucket === 'sent' && i.sentAt ? i.sentAt : i.createdAt),
    },
    {
      key: 'act',
      pin: true,
      header: <span className="sr">Actions</span>,
      label: 'Actions',
      tight: true,
      render: (i) => (
        <Menu
          chrome="bare"
          buttonLabel={`Actions for ${i.subject}`}
          label={
            <span
              className="btn btn--plain btn--icon"
              style={{ display: 'inline-grid', placeItems: 'center' }}
            >
              <MoreHorizontal aria-hidden="true" />
            </span>
          }
        >
          {(close) => (
            <>
              <MenuItem
                icon={<Eye aria-hidden="true" />}
                onSelect={() => {
                  close();
                  setViewing(i);
                }}
              >
                View email…
              </MenuItem>
              {i.sentAt === null ? (
                <>
                  <MenuItem
                    icon={<RefreshCw aria-hidden="true" />}
                    onSelect={() => {
                      close();
                      void retry(i);
                    }}
                  >
                    Retry now
                  </MenuItem>
                  {i.dismissedAt === null ? (
                    <>
                      <MenuSeparator />
                      <MenuItem
                        icon={<Archive aria-hidden="true" />}
                        onSelect={() => {
                          close();
                          void dismiss(i);
                        }}
                      >
                        Dismiss
                      </MenuItem>
                    </>
                  ) : null}
                </>
              ) : null}
            </>
          )}
        </Menu>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        icon={<Inbox />}
        title="Sent emails"
        subtitle="Every order email the store still owes or has already sent. Retry the failed ones here."
        actions={
          <Button tone="default" busy={sending} onClick={() => void sendQueued()}>
            Send queued now
          </Button>
        }
      />

      {error ? (
        <Banner
          tone="critical"
          title="Couldn’t load sent emails"
          action={<Button onClick={reload}>Retry</Button>}
        >
          {error}
        </Banner>
      ) : null}

      <DataTable
        caption="Sent emails"
        columns={columns}
        rows={loading ? [] : (data?.items ?? [])}
        rowKey={(i) => i.id}
        loading={loading && !error}
        tabs={{ value: bucket, tabs, onChange: setBucket }}
        empty={
          <EmptyState
            icon={bucket === 'attention' ? <CheckCircle2 /> : <Inbox />}
            title={EMPTY[bucket].title}
            body={EMPTY[bucket].body}
          />
        }
        footer={
          data && counts && counts[bucket] > data.items.length ? (
            <>Showing the newest {data.items.length} of {counts[bucket]}.</>
          ) : null
        }
      />

      <p className="page__learn">
        “Sent” means handed to the mail provider. Retry resets the attempt counter and runs a
        sweep immediately; Dismiss stops a dead email being counted, and Retry undoes it.
      </p>

      {viewing ? (
        <Modal title={viewing.subject} onClose={() => setViewing(null)} wide>
          <div className="stack">
            <Defs
              rows={[
                { label: 'To', value: viewing.to },
                { label: 'Kind', value: kindLabel(viewing.kind) },
                { label: 'Created', value: dateTime(viewing.createdAt) },
                {
                  label: 'Status',
                  value: viewing.sentAt
                    ? `Sent ${dateTime(viewing.sentAt)}`
                    : viewing.dismissedAt
                      ? `Dismissed ${dateTime(viewing.dismissedAt)}`
                      : `${viewing.attempts} of ${ATTEMPT_LIMIT} attempts used`,
                },
              ]}
            />
            {viewing.lastError ? (
              <Banner tone="warn" title="Why it failed last time">
                {viewing.lastError}
              </Banner>
            ) : null}
            <div>
              <span className="field__label">
                The plain-text version. Most inboxes show the designed version of the same message instead
              </span>
              <pre
                className="mono"
                style={{
                  margin: 'var(--s2) 0 0',
                  padding: 'var(--s3)',
                  background: 'var(--surface-sunken)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r-md)',
                  fontSize: 'var(--t-sm)',
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  maxHeight: '20rem',
                  overflow: 'auto',
                }}
              >
                {viewing.body}
              </pre>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

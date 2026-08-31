import { useCallback, useEffect, useState } from 'react';
import { Lock, Mail, MoreHorizontal, Plus, Send, Trash2 } from 'lucide-react';
import {
  emailApi,
  missingUnsubscribe,
  type Audience,
  type BroadcastStatus,
  type EmailBroadcast,
  type EmailTemplate,
} from '../../data/api-email';
import { getSession } from '../../data/session';
import { hasDomain } from '../../../shared/roles';
import { dateTime } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button, EmptyState, type BadgeTone } from '../ui/primitives';
import { DataTable, IdCell, type Column } from '../ui/DataTable';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

/**
 * BROADCASTS — `/emails/broadcasts`.
 *
 * CREATING SENDS NOTHING: a broadcast snapshots its template into a draft
 * row and builds its recipient set, so the confirmation can name the REAL
 * count for this exact broadcast before anybody agrees to anything. `Send`
 * is the irreversible one, behind that counted confirmation — the single
 * most important control on this surface.
 *
 * The daily sweep drains a started broadcast; "Continue sending" exists for
 * the operator who does not want to wait until tomorrow.
 */

const STATUS_TONE: Record<BroadcastStatus, BadgeTone> = {
  draft: 'warn',
  sending: 'info',
  sent: 'ok',
  failed: 'critical',
};

function MarketingOnly() {
  return (
    <div className="page">
      <PageHeader icon={<Send />} title="Broadcasts" />
      <div className="card">
        <EmptyState
          icon={<Lock />}
          title="A marketing surface"
          body="Everything on the email side — templates, subscribers, broadcasts — belongs to the marketing role and the admins."
        />
      </div>
    </div>
  );
}

export default function EmailBroadcasts() {
  const toast = useToast();
  const session = getSession();
  /* The GATE IS THE DOMAIN, NOT A ROLE NAME: `hasDomain` reads the same
     `ROLE_INFO` table the server's permission middleware enforces, so who may
     stand here and who the API answers cannot drift apart. */
  const role = 'user' in session ? session.user?.role : undefined;
  const allowed = role !== undefined && hasDomain(role, 'marketing');

  const [broadcasts, setBroadcasts] = useState<EmailBroadcast[] | null>(null);
  const [audience, setAudience] = useState<Audience | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmSend, setConfirmSend] = useState<EmailBroadcast | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<EmailBroadcast | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [list, counts] = await Promise.all([
        emailApi.listBroadcasts(signal),
        emailApi.audience(signal).catch(() => null),
      ]);
      setBroadcasts(list);
      setAudience(counts);
      setLoadError(null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setLoadError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
    }
  }, []);

  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, allowed]);

  if (!allowed) return <MarketingOnly />;

  const adopt = (next: EmailBroadcast) =>
    setBroadcasts((list) => (list === null ? list : list.map((b) => (b.id === next.id ? next : b))));

  async function sendTest(b: EmailBroadcast) {
    try {
      await emailApi.sendTest(b.id);
      toast.show('Test sent to your own address');
    } catch (cause) {
      toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
    }
  }

  async function drain(b: EmailBroadcast) {
    try {
      const next = await emailApi.drainBroadcast(b.id);
      adopt(next);
      toast.show(`${next.sentCount} of ${next.recipientCount} sent`);
    } catch (cause) {
      toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
    }
  }

  const columns: Column<EmailBroadcast>[] = [
    {
      key: 'broadcast',
      header: 'Broadcast',
      primary: true,
      render: (b) => (
        <IdCell
          thumb={<Send aria-hidden="true" />}
          title={b.subject}
          meta={`Created ${dateTime(b.createdAt)} · ${b.createdBy}`}
        />
      ),
    },
    {
      key: 'status', mobile: 'keep',
      header: 'Status',
      label: 'Status',
      tight: true,
      render: (b) => <Badge tone={STATUS_TONE[b.status]}>{b.status}</Badge>,
    },
    {
      key: 'progress',
      header: 'Progress',
      label: 'Progress',
      render: (b) =>
        b.status === 'draft' ? (
          <span className="muted">{b.recipientCount} recipients waiting</span>
        ) : (
          <span className="num">
            {b.sentCount} of {b.recipientCount}
            {b.failedCount > 0 ? (
              <span style={{ color: 'var(--critical)' }}> · {b.failedCount} failed</span>
            ) : null}
          </span>
        ),
    },
    {
      key: 'finished',
      header: 'Finished',
      label: 'Finished',
      render: (b) =>
        b.finishedAt ? dateTime(b.finishedAt) : b.startedAt ? (
          <span className="muted">started {dateTime(b.startedAt)}</span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      key: 'act', pin: true,
      header: <span className="sr">Actions</span>,
      label: 'Actions',
      tight: true,
      render: (b) => (
        <Menu
          chrome="bare"
          buttonLabel={`Actions for ${b.subject}`}
          label={
            <span className="btn btn--plain btn--icon" style={{ display: 'inline-grid', placeItems: 'center' }}>
              <MoreHorizontal aria-hidden="true" />
            </span>
          }
        >
          {(close) => (
            <>
              <MenuItem
                onSelect={() => {
                  close();
                  void sendTest(b);
                }}
              >
                Send a test to yourself
              </MenuItem>
              {b.status === 'sending' ? (
                <MenuItem
                  onSelect={() => {
                    close();
                    void drain(b);
                  }}
                >
                  Continue sending now
                </MenuItem>
              ) : null}
              {b.status === 'draft' ? (
                <>
                  <MenuSeparator />
                  <MenuItem
                    critical
                    icon={<Send aria-hidden="true" />}
                    onSelect={() => {
                      close();
                      setConfirmSend(b);
                    }}
                  >
                    Send to {b.recipientCount}…
                  </MenuItem>
                  <MenuItem
                    critical
                    icon={<Trash2 aria-hidden="true" />}
                    onSelect={() => {
                      close();
                      setConfirmDelete(b);
                    }}
                  >
                    Delete draft…
                  </MenuItem>
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
        icon={<Send />}
        title="Broadcasts"
        subtitle={
          audience
            ? `${audience.subscribed} would receive the next one · ${audience.suppressed} unsubscribed`
            : 'A broadcast snapshots its template — editing the template later rewrites nothing already sent.'
        }
        actions={
          <Button tone="primary" size="lg" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" />
            New broadcast
          </Button>
        }
      />

      {loadError ? (
        <Banner tone="critical" title="Couldn’t load broadcasts" action={<Button onClick={() => void load()}>Retry</Button>}>
          {loadError}
        </Banner>
      ) : null}

      <DataTable
        caption="Broadcasts"
        columns={columns}
        rows={broadcasts ?? []}
        rowKey={(b) => b.id}
        loading={broadcasts === null && !loadError}
        empty={
          <EmptyState
            icon={<Send />}
            title="Nothing broadcast yet"
            body="Create one from a template — it lands as a draft with a real recipient count, and sends only when you confirm."
          />
        }
        footer={null}
      />

      <p className="page__learn">
        A started broadcast drains with the daily sweep; “Continue sending now” pushes the next
        batch without waiting.
      </p>

      {creating ? (
        <NewBroadcastModal
          onClose={() => setCreating(false)}
          onDone={(created) => {
            setCreating(false);
            void load();
            toast.show(`Draft ready — ${created.recipientCount} recipients when you send`);
          }}
        />
      ) : null}

      {confirmDelete ? (
        <Modal
          title="Delete this draft?"
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
              <Button
                tone="critical"
                onClick={() => {
                  const target = confirmDelete;
                  setConfirmDelete(null);
                  void (async () => {
                    try {
                      await emailApi.deleteBroadcast(target.id);
                      setBroadcasts((list) =>
                        list === null ? list : list.filter((b) => b.id !== target.id),
                      );
                      toast.show('Draft deleted');
                    } catch (cause) {
                      toast.show(
                        cause instanceof Error && cause.message
                          ? cause.message
                          : 'Something went wrong.',
                        'critical',
                      );
                      void load();
                    }
                  })();
                }}
              >
                <Trash2 aria-hidden="true" />
                Delete draft
              </Button>
            </>
          }
        >
          <p style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
            <strong>“{confirmDelete.subject}”</strong> has been sent to nobody — deleting it
            removes the snapshot for good. Broadcasts that have started sending keep their
            record and cannot be deleted.
          </p>
        </Modal>
      ) : null}

      {confirmSend ? (
        <Modal
          title={`Send to ${confirmSend.recipientCount} ${confirmSend.recipientCount === 1 ? 'person' : 'people'}?`}
          onClose={() => setConfirmSend(null)}
          footer={
            <>
              <Button onClick={() => setConfirmSend(null)}>Cancel</Button>
              <Button
                tone="critical"
                onClick={() => {
                  const target = confirmSend;
                  setConfirmSend(null);
                  void (async () => {
                    try {
                      const next = await emailApi.sendBroadcast(target.id);
                      adopt(next);
                      toast.show(
                        next.status === 'sent'
                          ? `Sent to ${next.sentCount}`
                          : `Sending — ${next.sentCount} of ${next.recipientCount} so far`,
                      );
                    } catch (cause) {
                      toast.show(
                        cause instanceof Error && cause.message ? cause.message : 'Something went wrong.',
                        'critical',
                      );
                      void load();
                    }
                  })();
                }}
              >
                <Send aria-hidden="true" />
                Send broadcast
              </Button>
            </>
          }
        >
          <p style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
            <strong>“{confirmSend.subject}”</strong> goes to every subscribed address — there is no
            recall. A test to your own inbox first costs nothing.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}

function NewBroadcastModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (broadcast: EmailBroadcast) => void;
}) {
  const toast = useToast();
  const [templates, setTemplates] = useState<EmailTemplate[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    emailApi
      .listTemplates()
      .then((list) => {
        if (live) setTemplates(list);
      })
      .catch(() => {
        if (live) setTemplates([]);
      });
    return () => {
      live = false;
    };
  }, []);

  async function pick(template: EmailTemplate) {
    setBusy(template.id);
    try {
      onDone(await emailApi.createBroadcast(template.id));
    } catch (cause) {
      toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
      setBusy(null);
    }
  }

  return (
    <Modal title="New broadcast" onClose={onClose} flush wide>
      <div style={{ padding: 'var(--s2) var(--s5) var(--s3)' }}>
        <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.5 }}>
          Pick the template to snapshot. Creating sends nothing — the draft shows its real
          recipient count first.
        </p>
      </div>
      {templates === null ? (
        <div className="stack" style={{ padding: '0 var(--s5) var(--s5)' }} aria-hidden="true">
          <span className="skel" style={{ width: '14rem' }} />
          <span className="skel" style={{ width: '11rem', opacity: 0.7 }} />
        </div>
      ) : templates.length === 0 ? (
        <div className="muted" style={{ padding: 'var(--s4) var(--s5) var(--s6)' }}>
          No templates yet — write one under Templates first.
        </div>
      ) : (
        templates.map((t) => {
          const blocked = missingUnsubscribe(t);
          return (
            <button
              key={t.id}
              type="button"
              className="pick"
              disabled={blocked || busy !== null}
              title={blocked ? 'Needs {{unsubscribe_url}} in both bodies before it can broadcast' : undefined}
              style={blocked ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
              onClick={() => void pick(t)}
            >
              <span className="pick__icon" aria-hidden="true">
                <Mail />
              </span>
              <span>
                <span className="pick__title">{t.name}</span>
                <span className="pick__body" style={{ display: 'block' }}>
                  {t.subject}
                </span>
              </span>
              {blocked ? (
                <Badge tone="warn">No unsubscribe link</Badge>
              ) : (
                <span className="pick__chev">{busy === t.id ? 'Creating…' : 'Pick'}</span>
              )}
            </button>
          );
        })
      )}
    </Modal>
  );
}

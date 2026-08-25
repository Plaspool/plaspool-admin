import { useCallback, useEffect, useState } from 'react';
import { Copy, Lock, Mail, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import {
  emailApi,
  isSystemTemplate,
  missingUnsubscribe,
  EMAIL_VARIABLES,
  SYSTEM_TEMPLATE_STAGES,
  type EmailTemplate,
  type TemplateDraft,
} from '../../data/api-email';
import { getSession } from '../../data/session';
import { dateTime } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button, EmptyState } from '../ui/primitives';
import { DataTable, IdCell, type Column } from '../ui/DataTable';
import { TextArea, TextField, Toggle } from '../ui/Field';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

/**
 * EMAIL TEMPLATES — `/emails/templates`.
 *
 * A row with a `systemKey` IS a system message: the application renders
 * customer mail from it. It can be edited, never renamed or deleted — and it
 * can be duplicated into an ordinary template for experiments.
 *
 * THE UNSUBSCRIBE RULE, checked live while editing: a broadcast may only
 * send from a template carrying {{unsubscribe_url}} in BOTH bodies. System
 * transactional templates are exempt — an order confirmation is not
 * marketing — except account.welcome, the one that genuinely subscribes.
 *
 * TODO(tests): none — skipped this session, recorded in CLAUDE.md. Worth
 * pinning: the live missingUnsubscribe warning matching the server's rule,
 * and system rows offering no Delete.
 */

function OwnerOnly() {
  return (
    <div className="page">
      <PageHeader icon={<Mail />} title="Email templates" />
      <div className="card">
        <EmptyState
          icon={<Lock />}
          title="Owner-only surface"
          body="Everything on the email side — templates, subscribers, broadcasts — belongs to the owner account."
        />
      </div>
    </div>
  );
}

export default function EmailTemplates() {
  const toast = useToast();
  const session = getSession();
  const isOwner = 'user' in session && session.user?.role === 'owner';

  const [templates, setTemplates] = useState<EmailTemplate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<'closed' | 'new' | EmailTemplate>('closed');
  const [confirmDelete, setConfirmDelete] = useState<EmailTemplate | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setTemplates(await emailApi.listTemplates(signal));
      setLoadError(null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setLoadError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
    }
  }, []);

  useEffect(() => {
    if (!isOwner) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, isOwner]);

  if (!isOwner) return <OwnerOnly />;

  async function duplicate(template: EmailTemplate) {
    try {
      const copy = await emailApi.duplicateTemplate(template.id);
      toast.show(`“${copy.name}” created`);
      void load();
    } catch (cause) {
      toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
    }
  }

  async function destroy(template: EmailTemplate) {
    try {
      await emailApi.deleteTemplate(template.id);
      toast.show(`“${template.name}” deleted`);
      setConfirmDelete(null);
      void load();
    } catch (cause) {
      toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
      setConfirmDelete(null);
    }
  }

  const columns: Column<EmailTemplate>[] = [
    {
      key: 'template',
      header: 'Template',
      primary: true,
      render: (t) => (
        <IdCell
          thumb={<Mail aria-hidden="true" />}
          title={t.name}
          meta={
            isSystemTemplate(t)
              ? (SYSTEM_TEMPLATE_STAGES[t.systemKey!] ?? `System — ${t.systemKey}`)
              : 'Custom template'
          }
        />
      ),
    },
    {
      key: 'subject',
      header: 'Subject',
      label: 'Subject',
      render: (t) => <span className="truncate" style={{ maxWidth: '18rem', display: 'inline-block' }}>{t.subject}</span>,
    },
    {
      key: 'kind',
      header: 'Kind',
      label: 'Kind',
      tight: true,
      render: (t) =>
        isSystemTemplate(t) ? <Badge tone="info">System</Badge> : <Badge>Custom</Badge>,
    },
    {
      key: 'unsub',
      header: 'Broadcastable',
      label: 'Broadcastable',
      tight: true,
      render: (t) =>
        missingUnsubscribe(t) ? (
          <Badge tone="warn">No unsubscribe link</Badge>
        ) : (
          <Badge tone="ok">Ready</Badge>
        ),
    },
    {
      key: 'updated',
      header: 'Updated',
      label: 'Updated',
      render: (t) => (
        <span className="muted">
          {dateTime(t.updatedAt)} · {t.updatedBy}
        </span>
      ),
    },
    {
      key: 'act',
      header: <span className="sr">Actions</span>,
      label: 'Actions',
      tight: true,
      render: (t) => (
        <Menu
          chrome="bare"
          buttonLabel={`Actions for ${t.name}`}
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
                  setEditing(t);
                }}
              >
                Edit template…
              </MenuItem>
              <MenuItem
                icon={<Copy aria-hidden="true" />}
                onSelect={() => {
                  close();
                  void duplicate(t);
                }}
              >
                Duplicate
              </MenuItem>
              {/* A system template cannot be deleted — the pipeline renders
                  from it. The control is absent, not disabled. */}
              {isSystemTemplate(t) ? null : (
                <>
                  <MenuSeparator />
                  <MenuItem
                    critical
                    icon={<Trash2 aria-hidden="true" />}
                    onSelect={() => {
                      close();
                      setConfirmDelete(t);
                    }}
                  >
                    Delete…
                  </MenuItem>
                </>
              )}
            </>
          )}
        </Menu>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        icon={<Mail />}
        title="Email templates"
        subtitle="System messages the store sends, and the custom ones you broadcast from."
        actions={
          <Button tone="primary" size="lg" onClick={() => setEditing('new')}>
            <Plus aria-hidden="true" />
            New template
          </Button>
        }
      />

      {loadError ? (
        <Banner tone="critical" title="Couldn’t load templates" action={<Button onClick={() => void load()}>Retry</Button>}>
          {loadError}
        </Banner>
      ) : null}

      <DataTable
        caption="Email templates"
        columns={columns}
        rows={templates ?? []}
        rowKey={(t) => t.id}
        onRowClick={setEditing}
        loading={templates === null && !loadError}
        empty={
          <EmptyState
            icon={<Mail />}
            title="No templates yet"
            body="The system defaults appear here once the mail migration has run."
          />
        }
        footer={null}
      />

      {editing !== 'closed' ? (
        <TemplateModal
          template={editing === 'new' ? null : editing}
          onClose={() => setEditing('closed')}
          onDone={() => {
            setEditing('closed');
            void load();
          }}
        />
      ) : null}

      {confirmDelete ? (
        <Modal
          title={`Delete “${confirmDelete.name}”?`}
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
              <Button tone="critical" onClick={() => void destroy(confirmDelete)}>
                Delete template
              </Button>
            </>
          }
        >
          <p style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
            Broadcasts already sent keep their snapshots — deleting the template rewrites nothing
            that reached an inbox.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}

function TemplateModal({
  template,
  onClose,
  onDone,
}: {
  template: EmailTemplate | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const creating = template === null;
  const system = template !== null && isSystemTemplate(template);

  const [name, setName] = useState(template?.name ?? '');
  const [subject, setSubject] = useState(template?.subject ?? '');
  const [html, setHtml] = useState(template?.html ?? '');
  const [text, setText] = useState(template?.text ?? '');
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const unsubMissing = missingUnsubscribe({ html, text, systemKey: template?.systemKey ?? null });

  async function commit() {
    if (!name.trim() || !subject.trim()) {
      setError('A template needs its name and subject.');
      return;
    }
    const draft: TemplateDraft = {
      name: name.trim(),
      subject: subject.trim(),
      html,
      text,
    };
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        const created = await emailApi.createTemplate(draft);
        toast.show(`“${created.name}” created`);
      } else {
        const saved = await emailApi.updateTemplate(template.id, draft);
        toast.show(`“${saved.name}” saved`);
      }
      onDone();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={creating ? 'New template' : template.name}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} onClick={() => void commit()}>
            {creating ? 'Create template' : 'Save template'}
          </Button>
        </>
      }
    >
      <div className="stack">
        {system ? (
          <Banner tone="info" title={SYSTEM_TEMPLATE_STAGES[template.systemKey!] ?? 'System template'}>
            The store renders this customer mail from this row. Edit freely — it cannot be renamed
            or deleted, and Duplicate makes a safe playground copy.
          </Banner>
        ) : null}

        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
          <div style={{ flex: 1 }}>
            <TextField
              label="Name"
              value={name}
              disabled={system}
              hint={system ? 'System templates keep their names.' : undefined}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div style={{ flex: 1.4 }}>
            <TextField label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
        </div>

        <span className="field__hint">
          Variables the server substitutes:{' '}
          {EMAIL_VARIABLES.map((v) => (
            <code key={v} className="mono" style={{ marginRight: 'var(--s2)' }}>
              {v}
            </code>
          ))}
          — the unsubscribe link must be in BOTH bodies for a broadcast to send.
        </span>

        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="field__label">HTML body</span>
          <Toggle label="Preview" checked={preview} onChange={setPreview} />
        </div>
        {preview ? (
          /* sandbox="" — no scripts, no navigation. Author-supplied HTML is
             NEVER rendered into this app's own DOM. */
          <iframe
            title="Template preview"
            sandbox=""
            srcDoc={html}
            style={{
              width: '100%',
              height: '16rem',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-md)',
              background: '#ffffff',
            }}
          />
        ) : (
          <textarea
            className="textarea mono"
            rows={10}
            value={html}
            aria-label="HTML body"
            spellCheck={false}
            onChange={(e) => setHtml(e.target.value)}
          />
        )}

        <TextArea
          label="Plain-text body"
          rows={5}
          value={text}
          hint="Both parts are delivered — a reader whose client shows text only still needs the whole message."
          onChange={(e) => setText((e.target as HTMLTextAreaElement).value)}
        />

        {unsubMissing ? (
          <Banner tone="warn" title="Not broadcastable yet">
            Add <code className="mono">{'{{unsubscribe_url}}'}</code> to both bodies. Saving is
            fine — a half-written template is a normal state to save and an abnormal one to
            broadcast.
          </Banner>
        ) : null}

        {error ? (
          <span className="field__error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </Modal>
  );
}

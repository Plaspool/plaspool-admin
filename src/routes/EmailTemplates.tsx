import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { LayoutTemplate, Plus, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '../components/Dialog';
import { Spinner } from '../components/ui/Feedback';
import {
  EMAIL_VARIABLES,
  emailApi,
  missingUnsubscribe,
  UNSUBSCRIBE_VAR,
  type EmailTemplate,
  type TemplateDraft,
} from '../data/api-email';
import { ApiError, OfflineError } from '../data/errors';
import './emails.css';

/**
 * The email surface's landing screen — the sidebar's Emails entry points here,
 * because `/emails` itself only redirects.
 *
 * "Template" means an EMAIL template on these three screens and a reading
 * layout everywhere else in the app (HANDOFF §1.8). The two have never met and
 * must not: `src/data/settings.ts`'s `template` is how an article is laid out
 * for a reader, and has nothing to do with what gets posted to Resend.
 */

/**
 * What a new template starts as.
 *
 * It already contains `{{unsubscribe_url}}` in both bodies, which is not
 * decoration: a template without it can be saved and can never be broadcast, so
 * seeding it means the normal path never trips the warning and the writer sees
 * where the link is expected to live before they have to be told.
 */
const STARTER: TemplateDraft = {
  name: 'Untitled template',
  subject: '',
  html:
    '<p>Hello {{name}},</p>\n' +
    '<p></p>\n' +
    '<p style="font-size:12px;color:#666">\n' +
    '  <a href="{{unsubscribe_url}}">Unsubscribe</a>\n' +
    '</p>\n',
  text: 'Hello {{name}},\n\n\n\nUnsubscribe: {{unsubscribe_url}}\n',
};

/**
 * Copied into each of the three email screens rather than shared, for the same
 * reason `MailNav` below is. `Forgot.tsx` is where the shape comes from: an
 * `OfflineError` is not a server refusal, a 429 says how long, and anything
 * else quotes the request id so an operator has something to search for.
 */
function messageFor(err: unknown, what: string): string {
  if (err instanceof OfflineError) return `Could not reach the server, so ${what}.`;
  if (err instanceof ApiError) {
    if (err.status === 403) return 'Only the owner can manage email templates.';
    if (err.status === 429) {
      return err.retryAfter
        ? `Too many requests. Try again in ${Math.ceil(err.retryAfter)} seconds.`
        : 'Too many requests. Try again shortly.';
    }
    if (err.status === 400) {
      return err.detail ? `The server refused the ${err.detail} field.` : 'The server refused that.';
    }
    return err.requestId
      ? `Something went wrong at our end, so ${what}. Reference ${err.requestId}.`
      : `Something went wrong at our end, so ${what}.`;
  }
  return `Something went wrong, so ${what}.`;
}

const dateOf = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export default function EmailTemplates() {
  /** `null` is "not loaded yet" and `[]` is "loaded, and there are none". */
  const [items, setItems] = useState<EmailTemplate[] | null>(null);
  const [error, setError] = useState('');
  /** The open editor. `id: null` means it is a template that does not exist yet. */
  const [editing, setEditing] = useState<{ id: string | null; draft: TemplateDraft } | null>(null);
  const [deleting, setDeleting] = useState<EmailTemplate | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setItems(await emailApi.listTemplates(signal));
    } catch (err) {
      if (signal?.aborted) return;
      setItems([]);
      setError(messageFor(err, 'the templates could not be listed'));
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  async function remove(template: EmailTemplate) {
    setError('');
    try {
      await emailApi.deleteTemplate(template.id);
      setItems((list) => (list ?? []).filter((t) => t.id !== template.id));
      if (editing?.id === template.id) setEditing(null);
    } catch (err) {
      setError(messageFor(err, 'the template is still there'));
    }
  }

  return (
    <div className="mailscr">
      <header className="mailscr__head">
        <h1 className="mailscr__title">Templates</h1>
        <p className="mailscr__lede">
          The HTML and plain-text bodies a broadcast is sent from, with <code>{'{{name}}'}</code> and{' '}
          <code>{'{{unsubscribe_url}}'}</code> substituted on the server. A template without an
          unsubscribe link can be saved but never sent.
        </p>
      </header>


      <div className="mailscr__body">
        {error && (
          <p className="notice notice--danger" role="alert">
            {error}
          </p>
        )}

        {editing ? (
          <TemplateEditor
            key={editing.id ?? 'new'}
            id={editing.id}
            initial={editing.draft}
            onDone={(saved) => {
              setItems((list) => {
                const rest = (list ?? []).filter((t) => t.id !== saved.id);
                return [saved, ...rest];
              });
              setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <>
            <div className="mailscr__actions">
              <button
                className="btn btn--primary"
                onClick={() => setEditing({ id: null, draft: STARTER })}
              >
                <Plus className="ui-ic" aria-hidden="true" />
                New template
              </button>
            </div>

            {items === null ? (
              <p className="mailscr__loading">
                <Spinner label="Loading templates" /> Loading templates…
              </p>
            ) : items.length === 0 ? (
              <div className="empty">
                <div className="empty__mark" aria-hidden="true">
                  <LayoutTemplate />
                </div>
                <h2 className="empty__title">No templates yet</h2>
                <p className="empty__body">
                  Nothing can be broadcast until there is a template to broadcast from.
                </p>
              </div>
            ) : (
              <ul className="maillist">
                {items.map((t) => (
                  <li className="maillist__row" key={t.id}>
                    <div className="maillist__main">
                      <p className="maillist__name">{t.name}</p>
                      <p className="maillist__meta">
                        {t.subject || 'No subject'} · edited {dateOf(t.updatedAt)}
                      </p>
                    </div>
                    {missingUnsubscribe(t) && (
                      <span className="chip chip--draft">no unsubscribe link</span>
                    )}
                    <div className="maillist__acts">
                      <button
                        className="btn btn--outline btn--sm"
                        onClick={() =>
                          setEditing({
                            id: t.id,
                            draft: { name: t.name, subject: t.subject, html: t.html, text: t.text },
                          })
                        }
                      >
                        Edit
                      </button>
                      <button
                        className="btn btn--danger btn--sm"
                        onClick={() => setDeleting(t)}
                        aria-label={`Delete ${t.name}`}
                      >
                        <Trash2 className="ui-ic" aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) void remove(deleting);
        }}
        title="Delete this template?"
        description={
          <>
            <strong>{deleting?.name}</strong> is removed for everyone. Broadcasts already sent from
            it keep their own copy of the wording, so nothing that has been delivered changes.
          </>
        }
        confirmLabel="Delete template"
        danger
      />
    </div>
  );
}

/**
 * Name, subject, the two bodies, and the preview.
 *
 * Mounted with `key={id ?? 'new'}` so switching templates rebuilds the whole
 * component: the draft lives in local state, and carrying it across a change of
 * subject would mean editing one template's HTML into another's.
 */
function TemplateEditor({
  id,
  initial,
  onDone,
  onCancel,
}: {
  id: string | null;
  initial: TemplateDraft;
  onDone: (saved: EmailTemplate) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<TemplateDraft>(initial);
  const [tab, setTab] = useState<'html' | 'text'>('html');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const htmlRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fieldId = useId();

  /**
   * Where the caret has to be put back after a chip insert.
   *
   * A controlled `<textarea>` re-renders with a new `value`, and the browser
   * answers that by dropping the caret at the end of the text — so inserting
   * `{{name}}` in the middle of a paragraph would throw the writer to the
   * bottom of the body every time. This runs after the commit that carries the
   * new value, which is the first moment `setSelectionRange` survives.
   */
  const [caret, setCaret] = useState<{ field: 'html' | 'text'; at: number } | null>(null);
  useEffect(() => {
    if (!caret) return;
    const el = caret.field === 'html' ? htmlRef.current : textRef.current;
    el?.focus();
    el?.setSelectionRange(caret.at, caret.at);
    setCaret(null);
  }, [caret]);

  function insert(token: string) {
    const field = tab;
    const el = field === 'html' ? htmlRef.current : textRef.current;
    const value = draft[field];
    // No element (or no selection, which is what jsdom reports for a textarea
    // that has never been focused) means "append": still useful, never wrong.
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? start;
    setDraft((d) => ({ ...d, [field]: value.slice(0, start) + token + value.slice(end) }));
    setCaret({ field, at: start + token.length });
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      const saved =
        id === null
          ? await emailApi.createTemplate(draft)
          : await emailApi.updateTemplate(id, draft);
      onDone(saved);
    } catch (err) {
      setError(messageFor(err, 'nothing was saved'));
      setBusy(false);
    }
  }

  const incomplete = missingUnsubscribe(draft);

  return (
    <section className="mailtpl">
      <div className="mailtpl__meta">
        <div className="mailtpl__field">
          <label className="label" htmlFor={`${fieldId}-name`}>
            Name
          </label>
          <input
            id={`${fieldId}-name`}
            className="input"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </div>
        <div className="mailtpl__field">
          <label className="label" htmlFor={`${fieldId}-subject`}>
            Subject
          </label>
          <input
            id={`${fieldId}-subject`}
            className="input"
            value={draft.subject}
            onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))}
          />
        </div>
      </div>

      {/*
        THE WARNING IS NOT A SAVE GUARD, AND THAT IS THE POINT (HANDOFF §3 B4).
        A template is a thing people write over several sittings, so refusing to
        save a half-finished one would only teach them to keep it in a text file
        somewhere else. The send is where it bites — `emailApi.sendBroadcast` is
        unreachable for a template in this state, on both sides.
      */}
      {incomplete && (
        <p className="notice notice--warn" role="status">
          Both bodies need <code>{UNSUBSCRIBE_VAR}</code> before this template can be broadcast.
          You can save it without one; you cannot send it.
        </p>
      )}

      <div className="mailtpl__tabs">
        <button
          className="mailtpl__tab"
          aria-pressed={tab === 'html'}
          onClick={() => setTab('html')}
        >
          HTML
        </button>
        <button
          className="mailtpl__tab"
          aria-pressed={tab === 'text'}
          onClick={() => setTab('text')}
        >
          Plain text
        </button>
        {/*
          Toggle buttons rather than `role="tab"`: the ARIA tab pattern promises
          arrow-key movement between tabs and a roving tabindex, and a pair of
          buttons wearing the role without implementing it is worse for a screen
          reader user than two honest buttons.
        */}
        <div className="mailtpl__vars">
          <span className="mailtpl__varslabel">Insert</span>
          {EMAIL_VARIABLES.map((v) => (
            <button key={v} className="mailtpl__var" onClick={() => insert(v)}>
              {v}
            </button>
          ))}
        </div>
      </div>

      {tab === 'html' ? (
        <div className="mailtpl__split">
          <textarea
            ref={htmlRef}
            className="mailtpl__source"
            aria-label="HTML body"
            spellCheck={false}
            value={draft.html}
            onChange={(e) => setDraft((d) => ({ ...d, html: e.target.value }))}
          />
          {/*
            THE SANDBOX ATTRIBUTE IS THE WHOLE SAFETY STORY OF THIS SCREEN.

            What goes in this frame is HTML that a person typed into the box on
            the left, and it renders in the admin app, on the admin origin, in a
            session that can list every user and send mail to every subscriber.
            `sandbox=""` — empty, meaning every restriction and no exception —
            withholds scripts, same-origin, forms, popups, top-level navigation
            and plugins all at once. Without it a `<script>` pasted in from a
            "free email template" download runs with this app's cookies.

            It is deliberately NOT `sandbox="allow-same-origin"`, which would
            hand the frame back the origin it is being kept away from, and
            deliberately not `srcDoc`-with-sanitising instead: a sanitiser is a
            list of things somebody thought of, and this is a browser boundary.
            The preview loses nothing by it — email clients do not run scripts
            either, so a template that needs one is already broken.
          */}
          <iframe
            className="mailtpl__preview"
            title="Preview of the HTML body"
            sandbox=""
            srcDoc={draft.html}
          />
        </div>
      ) : (
        <textarea
          ref={textRef}
          className="mailtpl__source mailtpl__source--full"
          aria-label="Plain-text body"
          spellCheck={false}
          value={draft.text}
          onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
        />
      )}

      {error && (
        <p className="notice notice--danger" role="alert">
          {error}
        </p>
      )}

      <div className="mailtpl__foot">
        <button className="btn btn--ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn btn--primary"
          onClick={() => void save()}
          disabled={busy || draft.name.trim() === ''}
        >
          {busy ? <Spinner size={12} label="Saving" /> : null}
          {busy ? 'Saving…' : 'Save template'}
        </button>
      </div>
    </section>
  );
}

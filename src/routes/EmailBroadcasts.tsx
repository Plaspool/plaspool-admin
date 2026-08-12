import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, Send } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { ProgressIndeterminate, Spinner } from '../components/ui/Feedback';
import {
  emailApi,
  missingUnsubscribe,
  UNSUBSCRIBE_VAR,
  type Audience,
  type BroadcastStatus,
  type EmailBroadcast,
  type EmailTemplate,
} from '../data/api-email';
import { ApiError, OfflineError } from '../data/errors';
import './emails.css';

/**
 * Broadcasts — one template, sent to everyone still subscribed.
 *
 * The send itself is the dangerous part and the reason this screen is mostly
 * confirmation: a broadcast is the only action in this app that reaches people
 * who are not its users, and it cannot be recalled. The flow is HANDOFF §3 B4's,
 * in that order and for that reason — pick a template, read the audience, send
 * one to yourself, then agree to a number.
 */

/**
 * How often the progress view re-reads the row.
 *
 * Two seconds because the drain works in batches and a broadcast is over in
 * seconds or in a day, never in between: a slower poll makes a small send look
 * stuck, and a faster one only asks the same aggregate again.
 */
const POLL_MS = 2000;

/** See `EmailTemplates.tsx` for why this is copied into each of the three. */
function messageFor(err: unknown, what: string): string {
  if (err instanceof OfflineError) return `Could not reach the server, so ${what}.`;
  if (err instanceof ApiError) {
    if (err.status === 403) return 'Only the owner can send broadcasts.';
    if (err.status === 409) {
      /*
       * The server's own activation rule refusing us — a template with no
       * unsubscribe link, or a broadcast someone else already started. Both are
       * permanent for this click, so neither is retried.
       */
      return 'The server refused to start this broadcast. Reload to see its current state.';
    }
    if (err.status === 429) {
      return err.retryAfter
        ? `Too many requests. Try again in ${Math.ceil(err.retryAfter)} seconds.`
        : 'Too many requests. Try again shortly.';
    }
    return err.requestId
      ? `Something went wrong at our end, so ${what}. Reference ${err.requestId}.`
      : `Something went wrong at our end, so ${what}.`;
  }
  return `Something went wrong, so ${what}.`;
}

/** Thousands separators, because 1284 and 12840 must not look alike at a glance. */
const count = (n: number): string => n.toLocaleString();

const dateOf = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

const STATUS_CHIP: Record<BroadcastStatus, string> = {
  draft: 'chip chip--draft',
  sending: 'chip',
  sent: 'chip chip--published',
  failed: 'chip chip--archived',
};

export default function EmailBroadcasts() {
  const [items, setItems] = useState<EmailBroadcast[] | null>(null);
  const [error, setError] = useState('');
  /** The broadcast being composed or watched. Null = the list. */
  const [open, setOpen] = useState<EmailBroadcast | null>(null);
  const [picking, setPicking] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setItems(await emailApi.listBroadcasts(signal));
    } catch (err) {
      if (signal?.aborted) return;
      setItems([]);
      setError(messageFor(err, 'the broadcasts could not be listed'));
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  /** Back to the list, with whatever the row has become folded into it. */
  function close(latest: EmailBroadcast | null) {
    if (latest) {
      setItems((list) => [latest, ...(list ?? []).filter((b) => b.id !== latest.id)]);
    }
    setOpen(null);
    setPicking(false);
  }

  return (
    <div className="mailscr">
      <header className="mailscr__head">
        <h1 className="mailscr__title">Broadcasts</h1>
        <p className="mailscr__lede">
          Sending is drained in batches rather than in one request, so a broadcast that is
          interrupted resumes instead of starting again — and nobody is emailed twice.
        </p>
      </header>


      <div className="mailscr__body">
        {error && (
          <p className="notice notice--danger" role="alert">
            {error}
          </p>
        )}

        {picking ? (
          <TemplatePicker
            onCancel={() => setPicking(false)}
            onCreated={(broadcast) => {
              setPicking(false);
              setOpen(broadcast);
            }}
          />
        ) : open === null ? (
          <>
            <div className="mailscr__actions">
              <button className="btn btn--primary" onClick={() => setPicking(true)}>
                <Send className="ui-ic" aria-hidden="true" />
                New broadcast
              </button>
            </div>

            {items === null ? (
              <p className="mailscr__loading">
                <Spinner label="Loading broadcasts" /> Loading broadcasts…
              </p>
            ) : items.length === 0 ? (
              <div className="empty">
                <div className="empty__mark" aria-hidden="true">
                  <Send />
                </div>
                <h2 className="empty__title">Nothing has been sent</h2>
                <p className="empty__body">
                  No broadcast has been created from this browser or any other.
                </p>
              </div>
            ) : (
              <ul className="maillist">
                {items.map((b) => (
                  <li className="maillist__row" key={b.id}>
                    <div className="maillist__main">
                      <p className="maillist__name">{b.subject || 'No subject'}</p>
                      <p className="maillist__meta">
                        {dateOf(b.createdAt)} · {count(b.sentCount)} sent
                        {b.failedCount > 0 ? ` · ${count(b.failedCount)} failed` : ''}
                      </p>
                    </div>
                    <span className={STATUS_CHIP[b.status]}>{b.status}</span>
                    <div className="maillist__acts">
                      <button className="btn btn--outline btn--sm" onClick={() => setOpen(b)}>
                        {b.status === 'draft' ? 'Continue' : 'Open'}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : open.status === 'draft' ? (
          <Composer broadcast={open} onStarted={setOpen} onCancel={() => close(open)} />
        ) : (
          <ProgressView broadcast={open} onDone={close} />
        )}
      </div>
    </div>
  );
}

/**
 * Step one: which template.
 *
 * A TEMPLATE WITH NO UNSUBSCRIBE VARIABLE CANNOT BE PICKED AT ALL. That is
 * HANDOFF §3 B4's "blocks starting a broadcast", and blocking here rather than
 * at the send is the difference between a rule and a trap: by the time someone
 * has read an audience count and sent themselves a test, they have decided, and
 * a refusal at that point reads as a bug.
 */
function TemplatePicker({
  onCreated,
  onCancel,
}: {
  onCreated: (broadcast: EmailBroadcast) => void;
  onCancel: () => void;
}) {
  const [items, setItems] = useState<EmailTemplate[] | null>(null);
  const [chosen, setChosen] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        setItems(await emailApi.listTemplates(ac.signal));
      } catch (err) {
        if (ac.signal.aborted) return;
        setItems([]);
        setError(messageFor(err, 'the templates could not be listed'));
      }
    })();
    return () => ac.abort();
  }, []);

  async function create() {
    setBusy(true);
    setError('');
    try {
      onCreated(await emailApi.createBroadcast(chosen));
    } catch (err) {
      setError(messageFor(err, 'no broadcast was created'));
      setBusy(false);
    }
  }

  return (
    <section className="mailbc">
      <h2 className="mailbc__step">Pick a template</h2>
      <p className="mailbc__hint">
        The wording is copied into the broadcast as it is now. Editing the template afterwards does
        not change what this broadcast sends.
      </p>

      {error && (
        <p className="notice notice--danger" role="alert">
          {error}
        </p>
      )}

      {items === null ? (
        <p className="mailscr__loading">
          <Spinner label="Loading templates" /> Loading templates…
        </p>
      ) : items.length === 0 ? (
        <p className="mailbc__hint">
          There are no templates yet. <Link to="/emails/templates">Write one first.</Link>
        </p>
      ) : (
        <ul className="maillist">
          {items.map((t) => {
            const blocked = missingUnsubscribe(t);
            return (
              <li className="maillist__row" key={t.id}>
                <label className="mailbc__pick">
                  <input
                    type="radio"
                    name="template"
                    value={t.id}
                    disabled={blocked}
                    checked={chosen === t.id}
                    onChange={() => setChosen(t.id)}
                  />
                  <span className="maillist__main">
                    <span className="maillist__name">{t.name}</span>
                    <span className="maillist__meta">
                      {blocked ? (
                        <>
                          Cannot be broadcast: both bodies need <code>{UNSUBSCRIBE_VAR}</code>.
                        </>
                      ) : (
                        t.subject || 'No subject'
                      )}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mailtpl__foot">
        <button className="btn btn--ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn btn--primary"
          onClick={() => void create()}
          disabled={busy || chosen === ''}
        >
          {busy ? <Spinner size={12} label="Preparing" /> : null}
          {busy ? 'Preparing…' : 'Continue'}
        </button>
      </div>
    </section>
  );
}

/**
 * Steps two to four: the audience, a test to yourself, and the confirmation.
 *
 * Nothing here sends anything to anybody else until the dialog below is agreed
 * to, and the dialog does not open with a number it read when the screen
 * mounted — see `ConfirmSend`.
 */
function Composer({
  broadcast,
  onStarted,
  onCancel,
}: {
  broadcast: EmailBroadcast;
  onStarted: (b: EmailBroadcast) => void;
  onCancel: () => void;
}) {
  const [audience, setAudience] = useState<Audience | null>(null);
  const [tested, setTested] = useState(false);
  const [testing, setTesting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        setAudience(await emailApi.audience(ac.signal));
      } catch (err) {
        if (ac.signal.aborted) return;
        setError(messageFor(err, 'the audience could not be counted'));
      }
    })();
    return () => ac.abort();
  }, []);

  async function test() {
    setTesting(true);
    setError('');
    try {
      await emailApi.sendTest(broadcast.id);
      setTested(true);
    } catch (err) {
      setError(messageFor(err, 'no test was sent'));
    }
    setTesting(false);
  }

  return (
    <section className="mailbc">
      <button className="btn btn--ghost btn--sm mailbc__back" onClick={onCancel}>
        <ChevronLeft className="ui-ic" aria-hidden="true" />
        All broadcasts
      </button>

      <h2 className="mailbc__step">{broadcast.subject || 'No subject'}</h2>
      <p className="mailbc__hint">
        Saved as a draft. Nothing has been sent to anyone yet.
      </p>

      {error && (
        <p className="notice notice--danger" role="alert">
          {error}
        </p>
      )}

      <div className="mailbc__audience">
        {audience === null ? (
          <p className="mailscr__loading">
            <Spinner label="Counting the audience" /> Counting the audience…
          </p>
        ) : (
          <>
            <p className="mailbc__aud">
              <span className="mailbc__audn">{count(audience.subscribed)}</span>
              <span className="mailbc__audl">subscribed — will receive this</span>
            </p>
            <p className="mailbc__aud">
              <span className="mailbc__audn">{count(audience.suppressed)}</span>
              <span className="mailbc__audl">unsubscribed — will be skipped</span>
            </p>
          </>
        )}
      </div>

      <div className="mailbc__row">
        <div>
          <p className="maillist__name">Send a test to yourself</p>
          <p className="maillist__meta">
            Goes to the address you signed in with, and to nobody else. The variables are
            substituted exactly as they will be in the real thing.
          </p>
        </div>
        <button className="btn btn--outline" onClick={() => void test()} disabled={testing}>
          {testing ? <Spinner size={12} label="Sending test" /> : null}
          {testing ? 'Sending…' : 'Send test to me'}
        </button>
      </div>

      {tested && (
        <p className="notice" role="status">
          A test has been sent to your own address. Check it renders before you send the rest.
        </p>
      )}

      <div className="mailtpl__foot">
        <button className="btn btn--ghost" onClick={onCancel}>
          Not yet
        </button>
        <button className="btn btn--danger" onClick={() => setConfirming(true)}>
          Send broadcast…
        </button>
      </div>

      <ConfirmSend
        open={confirming}
        broadcast={broadcast}
        onClose={() => setConfirming(false)}
        onStarted={(b) => {
          setConfirming(false);
          onStarted(b);
        }}
      />
    </section>
  );
}

/**
 * THE LAST THING BETWEEN A WRITER AND A FEW THOUSAND REAL INBOXES.
 *
 * Three decisions, each of which is the point of the control:
 *
 * 1. THE COUNT IS RE-READ WHEN THE DIALOG OPENS, never inherited from the
 *    screen behind it. A composer can sit open for an hour while an import
 *    runs in another tab; a number that was true when the page mounted is
 *    exactly the kind of stale fact that gets agreed to.
 * 2. WHILE IT IS BEING RE-READ THERE IS NO SEND BUTTON — not a disabled one
 *    with the old number still showing next to it. A dialog that displays a
 *    count is making a claim, and it must not make one it is in the middle of
 *    checking.
 * 3. CANCEL TAKES THE FOCUS AND THE SEND IS `btn--danger`. `ConfirmDialog`
 *    autofocuses its confirm button, which turns a stray Return keypress into
 *    a send; that is right for "delete this draft" and wrong here, so this
 *    dialog is built on `Dialog` directly rather than reusing it.
 */
function ConfirmSend({
  open,
  broadcast,
  onClose,
  onStarted,
}: {
  open: boolean;
  broadcast: EmailBroadcast;
  onClose: () => void;
  onStarted: (b: EmailBroadcast) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [recipients, setRecipients] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    setChecking(true);
    setError('');
    void (async () => {
      try {
        const [row, aud] = await Promise.all([
          emailApi.getBroadcast(broadcast.id, ac.signal),
          emailApi.audience(ac.signal),
        ]);
        /*
         * The broadcast's OWN recipient set is the truth when it has one: those
         * rows are what the drain walks, and a subscriber added after the
         * broadcast was created is not in it. A draft whose recipients are
         * built at send time reports zero, and then the live subscribed count
         * is the honest number — it is what the server is about to enumerate.
         */
        if (!ac.signal.aborted) setRecipients(row.recipientCount > 0 ? row.recipientCount : aud.subscribed);
      } catch (err) {
        if (!ac.signal.aborted) setError(messageFor(err, 'the recipient count could not be read'));
      } finally {
        if (!ac.signal.aborted) setChecking(false);
      }
    })();
    return () => ac.abort();
  }, [open, broadcast.id]);

  async function send() {
    setSending(true);
    setError('');
    try {
      onStarted(await emailApi.sendBroadcast(broadcast.id));
    } catch (err) {
      setError(messageFor(err, 'nothing was sent'));
      setSending(false);
    }
  }

  const ready = !checking && recipients !== null && error === '';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Send this broadcast?"
      width="32rem"
      footer={
        <>
          {/* Autofocused: the safe half of an irreversible choice is the one a
              reflex should land on. */}
          <button className="btn btn--outline" onClick={onClose} disabled={sending} autoFocus>
            Cancel
          </button>
          {ready && (
            <button className="btn btn--danger" onClick={() => void send()} disabled={sending}>
              {sending ? <Spinner size={12} label="Sending" /> : null}
              {sending ? 'Sending…' : `Send to ${count(recipients)} people`}
            </button>
          )}
        </>
      }
    >
      {error && (
        <p className="notice notice--danger" role="alert">
          {error}
        </p>
      )}

      {checking || recipients === null ? (
        <p className="mailscr__loading">
          <Spinner label="Checking the recipient count" /> Checking how many people this reaches…
        </p>
      ) : (
        <>
          {/* Grouped so the number and the sentence about it read as one
              thing: `.dialog__body` is a grid with a --s4 gap, which is the
              right distance between the count and the warning and far too much
              between the count and its own label. */}
          <div className="mailbc__countbox">
            <p className="mailbc__count">{count(recipients)}</p>
            <p className="mailbc__countl">
              {recipients === 1 ? 'person receives' : 'people receive'} “
              {broadcast.subject || 'No subject'}”
            </p>
          </div>
          <p className="mailbc__warn">
            Email cannot be recalled. Once this starts, the only thing that stops it is the
            recipient's unsubscribe link.
          </p>
        </>
      )}
    </Dialog>
  );
}

/**
 * What a send looks like while it is happening, and after.
 *
 * The indeterminate bar is deliberate even though `sentCount / recipientCount`
 * would draw a determinate one: the drain claims recipients in batches on the
 * server's schedule, so a bar that crawled to 40% and then sat there until
 * tomorrow's cron would be a worse lie than an honest "still going".
 */
function ProgressView({
  broadcast,
  onDone,
}: {
  broadcast: EmailBroadcast;
  onDone: (latest: EmailBroadcast) => void;
}) {
  const [row, setRow] = useState(broadcast);
  const [draining, setDraining] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (row.status !== 'sending') return;
    let live = true;
    let timer = 0;
    const tick = async () => {
      try {
        const next = await emailApi.getBroadcast(row.id);
        if (live) setRow(next);
      } catch {
        // A poll that fails is not worth a banner: the next one is two seconds
        // away, and the send is happening on the server either way.
      }
      if (live) timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    timer = window.setTimeout(() => void tick(), POLL_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [row.status, row.id]);

  async function drain() {
    setDraining(true);
    setError('');
    try {
      setRow(await emailApi.drainBroadcast(row.id));
    } catch (err) {
      setError(messageFor(err, 'the next batch was not sent'));
    }
    setDraining(false);
  }

  const done = row.sentCount + row.failedCount;

  return (
    <section className="mailbc" aria-live="polite">
      <button className="btn btn--ghost btn--sm mailbc__back" onClick={() => onDone(row)}>
        <ChevronLeft className="ui-ic" aria-hidden="true" />
        All broadcasts
      </button>

      <h2 className="mailbc__step">{row.subject || 'No subject'}</h2>
      <p className="mailbc__hint">
        {row.status === 'sending'
          ? 'Sending. This continues on the server whether or not this page stays open.'
          : row.status === 'sent'
            ? `Finished${row.finishedAt ? ` on ${dateOf(row.finishedAt)}` : ''}.`
            : 'This broadcast stopped before it finished. The addresses it did reach were not emailed twice.'}
      </p>

      {row.status === 'sending' && <ProgressIndeterminate label="Sending the broadcast" />}

      <div className="mailbc__audience">
        <p className="mailbc__aud">
          <span className="mailbc__audn">{count(row.sentCount)}</span>
          <span className="mailbc__audl">sent</span>
        </p>
        <p className="mailbc__aud">
          <span className="mailbc__audn">{count(row.failedCount)}</span>
          <span className="mailbc__audl">failed</span>
        </p>
        <p className="mailbc__aud">
          <span className="mailbc__audn">{count(Math.max(row.recipientCount - done, 0))}</span>
          <span className="mailbc__audl">still to go, of {count(row.recipientCount)}</span>
        </p>
      </div>

      {error && (
        <p className="notice notice--danger" role="alert">
          {error}
        </p>
      )}

      {row.status === 'sending' && (
        <div className="mailbc__row">
          <div>
            <p className="maillist__name">Waiting for the next batch</p>
            <p className="maillist__meta">
              The daily job sends the rest on its own. This button is only for not waiting until
              then.
            </p>
          </div>
          <button className="btn btn--outline" onClick={() => void drain()} disabled={draining}>
            {draining ? <Spinner size={12} label="Sending the next batch" /> : null}
            {draining ? 'Sending…' : 'Send the next batch now'}
          </button>
        </div>
      )}
    </section>
  );
}

/** See `EmailTemplates.tsx` for why this row is copied into each screen. */

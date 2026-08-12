import { useCallback, useEffect, useId, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { UserCheck } from 'lucide-react';
import { Spinner } from '../components/ui/Feedback';
import { Select } from '../components/ui/Select';
import { Switch } from '../components/ui/Switch';
import {
  emailApi,
  type EmailSubscriber,
  type SubscriberFilter,
} from '../data/api-email';
import { ApiError, OfflineError } from '../data/errors';
import './emails.css';

/**
 * The audience, and the record of who has asked to leave it.
 *
 * Unsubscribing is the one thing on these three screens that has to work
 * before anything else does: it is a one-click link in an email sent to
 * someone who may have no account here at all, so it is served without a
 * session and its effect is permanent until the same person opts back in.
 * A suppressed address is skipped by every broadcast, not filtered out of this
 * list — the row stays visible so an operator can see the shape of their
 * audience honestly.
 */

/** See `EmailTemplates.tsx` for why this is copied into each of the three. */
function messageFor(err: unknown, what: string): string {
  if (err instanceof OfflineError) return `Could not reach the server, so ${what}.`;
  if (err instanceof ApiError) {
    if (err.status === 403) return 'Only the owner can manage subscribers.';
    if (err.status === 409) return 'That address is already on the list.';
    if (err.status === 429) {
      return err.retryAfter
        ? `Too many requests. Try again in ${Math.ceil(err.retryAfter)} seconds.`
        : 'Too many requests. Try again shortly.';
    }
    if (err.status === 400) {
      return err.detail === 'email'
        ? 'That does not look like an email address.'
        : `The server refused that${err.detail ? ` (${err.detail})` : ''}.`;
    }
    return err.requestId
      ? `Something went wrong at our end, so ${what}. Reference ${err.requestId}.`
      : `Something went wrong at our end, so ${what}.`;
  }
  return `Something went wrong, so ${what}.`;
}

const dateOf = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

const FILTERS: { value: SubscriberFilter; label: string }[] = [
  { value: 'subscribed', label: 'Subscribed' },
  { value: 'unsubscribed', label: 'Unsubscribed' },
  { value: 'all', label: 'Everyone' },
];

/**
 * DELIBERATELY LOOSE, and it is not the authority on anything.
 *
 * The server validates every address again and the import is all-or-nothing on
 * what it receives, so the only job of this pattern is to keep a row that is
 * obviously not an address — a header cell, a blank line, a name column — out
 * of a body that would otherwise be refused whole because of it. A stricter
 * pattern here would reject real addresses (`+` tags, long TLDs, unicode
 * domains) that the server would have accepted, which is the worse failure:
 * a person silently dropped from a list they asked to be on.
 */
const LOOKS_LIKE_EMAIL = /^[^\s@,;"']+@[^\s@,;"']+\.[^\s@,;"']+$/;

/** One row of the file, with the verdict the preview table shows against it. */
interface CsvRow {
  /** 1-based line in the file, so the writer can go and look at it. */
  line: number;
  value: string;
  problem: string | null;
}

interface CsvPreview {
  fileName: string;
  rows: CsvRow[];
  /** Deduplicated, lower-cased, and the only thing that is ever POSTed. */
  emails: string[];
  /** Header columns that exist in the file and are not stored. */
  ignoredColumns: string[];
}

/**
 * A CSV reader, rather than a `split(',')`.
 *
 * Exported lists come out of other tools with quoted fields, commas inside
 * those fields, doubled quotes, CRLF endings and a BOM — `split` gets every one
 * of those wrong, and gets them wrong quietly, which on this screen means an
 * address that looks fine in the preview and bounces on the send.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  // A UTF-8 BOM would otherwise become part of the first cell, which is how a
  // header called "email" stops matching the word "email".
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      // CRLF is one ending, not two: consuming the LF here is what stops every
      // other row of a Windows-authored file being empty.
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * The file, turned into something a person can check before it is sent.
 *
 * The rule the whole screen turns on: ROWS THAT CANNOT BE USED ARE LEFT OUT OF
 * THE REQUEST, NOT SENT AND REFUSED. `/api/import`'s validate-all-then-write is
 * about the body the server receives — it either writes all of it or none of
 * it — so the client's job is to decide what goes in that body and to show that
 * decision first. Blocking the entire file because one row is a stray name
 * would make every real export unusable; sending it and having the server
 * refuse all 900 good addresses would be worse.
 */
function readSubscriberCsv(fileName: string, text: string): CsvPreview {
  const grid = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  let column = 0;
  let start = 0;
  let ignoredColumns: string[] = [];

  const header = grid[0] ?? [];
  const headerAt = header.findIndex((c) => /^e-?mail(\s+address)?$/i.test(c.trim()));
  if (headerAt !== -1) {
    column = headerAt;
    start = 1;
    /*
     * `email_subscribers` has an address, a source and two timestamps and
     * nothing else (HANDOFF §2 A6) — there is no name column to put a name in.
     * Saying so beats storing it nowhere and letting someone believe
     * `{{name}}` will resolve to what was in their spreadsheet.
     */
    ignoredColumns = header
      .map((c) => c.trim())
      .filter((c, i) => i !== headerAt && c !== '');
  }

  const rows: CsvRow[] = [];
  const emails: string[] = [];
  const seen = new Set<string>();

  for (let i = start; i < grid.length; i++) {
    const raw = (grid[i][column] ?? '').trim();
    const value = raw.toLowerCase();
    const line = i + 1;
    if (raw === '') {
      rows.push({ line, value: raw, problem: 'no address in this row' });
    } else if (!LOOKS_LIKE_EMAIL.test(raw)) {
      rows.push({ line, value: raw, problem: 'not an email address' });
    } else if (seen.has(value)) {
      rows.push({ line, value: raw, problem: 'already in this file' });
    } else {
      seen.add(value);
      emails.push(value);
      rows.push({ line, value: raw, problem: null });
    }
  }

  return { fileName, rows, emails, ignoredColumns };
}

/** How much of the preview table is drawn before it is cut off. */
const PREVIEW_ROWS = 12;

/**
 * `FileReader` RATHER THAN `file.text()`, and that is measured rather than
 * defensive: in jsdom 27 — the environment every `.test.tsx` in this repo runs
 * under — `new File(['…']).text` is `undefined`. Reaching for the newer method
 * would make the one screen that most needs a test the one screen that cannot
 * have one. `FileReader` is present in every browser this app supports and in
 * jsdom, and reads the same bytes.
 */
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('the file could not be read'));
    reader.readAsText(file);
  });
}

export default function EmailSubscribers() {
  const [filter, setFilter] = useState<SubscriberFilter>('subscribed');
  const [items, setItems] = useState<EmailSubscriber[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const fieldId = useId();

  const load = useCallback(async (which: SubscriberFilter, signal?: AbortSignal) => {
    try {
      const page = await emailApi.listSubscribers({ filter: which }, signal);
      setItems(page.items);
      setCursor(page.nextCursor);
    } catch (err) {
      if (signal?.aborted) return;
      setItems([]);
      setError(messageFor(err, 'the list could not be loaded'));
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    setItems(null);
    void load(filter, ac.signal);
    return () => ac.abort();
  }, [filter, load]);

  async function more() {
    if (cursor === null) return;
    try {
      const page = await emailApi.listSubscribers({ filter, cursor });
      setItems((list) => [...(list ?? []), ...page.items]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(messageFor(err, 'the next page could not be loaded'));
    }
  }

  async function add() {
    const email = adding.trim();
    if (email === '') return;
    setBusy(true);
    setError('');
    try {
      const subscriber = await emailApi.addSubscriber(email);
      setAdding('');
      // Prepended rather than re-fetched: a keyset list has no page this row
      // belongs to yet, and re-reading page one would throw away everything
      // already loaded below it.
      setItems((list) => [subscriber, ...(list ?? [])]);
    } catch (err) {
      setError(messageFor(err, 'nobody was added'));
    }
    setBusy(false);
  }

  return (
    <div className="mailscr">
      <header className="mailscr__head">
        <h1 className="mailscr__title">Subscribers</h1>
        <p className="mailscr__lede">
          Added by hand, imported from a file, or carried over from a purchase. Importing shows you
          the whole file first, and writes it in one piece or not at all.
        </p>
      </header>

      <MailNav />

      <div className="mailscr__body">
        {error && (
          <p className="notice notice--danger" role="alert">
            {error}
          </p>
        )}

        <div className="mailsub__bar">
          <Select
            value={filter}
            onChange={setFilter}
            options={FILTERS}
            label="Which subscribers to show"
          />
          <div className="mailsub__add">
            <label className="visually-hidden" htmlFor={`${fieldId}-add`}>
              Email address to add
            </label>
            <input
              id={`${fieldId}-add`}
              className="input"
              type="email"
              placeholder="someone@example.com"
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add();
              }}
            />
            <button
              className="btn btn--primary"
              onClick={() => void add()}
              disabled={busy || adding.trim() === ''}
            >
              Add
            </button>
          </div>
        </div>

        {/* The list is re-read rather than patched: an import can add hundreds
            of rows across every page of a keyset list, and there is no correct
            place to splice them in from here. */}
        <CsvImport
          onImported={() => {
            setError('');
            void load(filter);
          }}
        />

        {items === null ? (
          <p className="mailscr__loading">
            <Spinner label="Loading subscribers" /> Loading subscribers…
          </p>
        ) : items.length === 0 ? (
          <div className="empty">
            <div className="empty__mark" aria-hidden="true">
              <UserCheck />
            </div>
            <h2 className="empty__title">
              {filter === 'unsubscribed' ? 'Nobody has unsubscribed' : 'No subscribers yet'}
            </h2>
            <p className="empty__body">
              {filter === 'unsubscribed'
                ? 'Every address on the list still wants to hear from you.'
                : 'Add an address above, or import a file. Nobody is emailed by adding them.'}
            </p>
          </div>
        ) : (
          <>
            <ul className="maillist">
              {items.map((s) => (
                <li className="maillist__row" key={s.id}>
                  <div className="maillist__main">
                    <p className="maillist__name">{s.email}</p>
                    <p className="maillist__meta">
                      {s.source}
                      {s.consentAt ? ` · agreed ${dateOf(s.consentAt)}` : ' · no consent recorded'}
                    </p>
                  </div>
                  {s.unsubscribedAt ? (
                    <span className="chip chip--archived">unsubscribed</span>
                  ) : (
                    <span className="chip chip--published">subscribed</span>
                  )}
                </li>
              ))}
            </ul>
            {cursor !== null && (
              <div className="mailscr__actions">
                <button className="btn btn--outline" onClick={() => void more()}>
                  Load more
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Import, with the file shown before it is sent.
 *
 * The shape is `Migrate.tsx`'s, on purpose (HANDOFF §3 B4): everything that
 * cannot be undone is stated ABOVE the button, the list of what will happen is
 * on the screen rather than in a result page afterwards, and the button does
 * nothing at all until an explicit switch has been turned on. The thing being
 * consented to is different and worse here than there — Migrate publishes your
 * own drafts under your own name, this puts strangers on a list that will email
 * them — so the switch asks about THEM and not about the file.
 */
function CsvImport({ onImported }: { onImported: () => void }) {
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ added: number; skipped: number } | null>(null);
  const fieldId = useId();

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // The input is reset so that choosing the SAME file twice still fires a
    // change event — otherwise a corrected re-export appears to do nothing.
    event.target.value = '';
    if (!file) return;
    setError('');
    setDone(null);
    setAgreed(false);
    try {
      setPreview(readSubscriberCsv(file.name, await readText(file)));
    } catch {
      setPreview(null);
      setError('That file could not be read.');
    }
  }

  async function run() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const result = await emailApi.importSubscribers(preview.emails);
      setDone(result);
      setPreview(null);
      setAgreed(false);
      onImported();
    } catch (err) {
      setError(messageFor(err, 'nobody was imported'));
    }
    setBusy(false);
  }

  const usable = preview?.emails.length ?? 0;
  const rejected = preview ? preview.rows.filter((r) => r.problem !== null) : [];

  return (
    <section className="mailsub__import">
      <div className="mailsub__importhead">
        <div>
          <p className="maillist__name">Import a CSV</p>
          <p className="maillist__meta">
            One address per row. A column headed “email” is used if there is one, otherwise the
            first column. Nothing is sent to the server until you have seen what is in the file.
          </p>
        </div>
        <label className="btn btn--outline" htmlFor={`${fieldId}-file`}>
          Choose a file
        </label>
        <input
          id={`${fieldId}-file`}
          className="visually-hidden"
          type="file"
          accept=".csv,text/csv,text/plain"
          onChange={(e) => void choose(e)}
        />
      </div>

      {error && (
        <p className="notice notice--danger" role="alert">
          {error}
        </p>
      )}

      {done && (
        <p className="notice" role="status">
          Imported {done.added} {done.added === 1 ? 'address' : 'addresses'}
          {done.skipped > 0
            ? `, and left ${done.skipped} that ${done.skipped === 1 ? 'was' : 'were'} already on the list`
            : ''}
          .
        </p>
      )}

      {preview && (
        <>
          <p className="mailsub__summary" role="status">
            <strong>{preview.fileName}</strong>: {usable}{' '}
            {usable === 1 ? 'address' : 'addresses'} will be added
            {rejected.length > 0
              ? `, ${rejected.length} ${rejected.length === 1 ? 'row is' : 'rows are'} left out`
              : ''}
            .
          </p>

          {preview.ignoredColumns.length > 0 && (
            <p className="mailsub__note">
              Only the address is stored. {preview.ignoredColumns.join(', ')}{' '}
              {preview.ignoredColumns.length === 1 ? 'is' : 'are'} in the file and{' '}
              {preview.ignoredColumns.length === 1 ? 'is' : 'are'} not kept.
            </p>
          )}

          <div className="mailsub__tablewrap">
            <table className="mailsub__table">
              <caption className="visually-hidden">
                The first {Math.min(PREVIEW_ROWS, preview.rows.length)} rows of{' '}
                {preview.fileName}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Line</th>
                  <th scope="col">Address</th>
                  <th scope="col">What happens</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, PREVIEW_ROWS).map((r) => (
                  <tr key={r.line} className={r.problem ? 'is-rejected' : undefined}>
                    <td>{r.line}</td>
                    <td className="mailsub__addr">{r.value || '—'}</td>
                    <td>{r.problem ?? 'will be added'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {preview.rows.length > PREVIEW_ROWS && (
            <p className="mailsub__note">
              {preview.rows.length - PREVIEW_ROWS} more rows are in the file and are not shown
              here.
            </p>
          )}

          {/* The consent, and it is about the people in the file rather than
              about the file. An address that never agreed to hear from this
              publication is the one thing an import can do that no amount of
              later editing undoes — they have already been emailed by then. */}
          <div className="mailbc__row">
            <div>
              <p className="maillist__name">
                These {usable === 1 ? 'person' : 'people'} asked to hear from this publication
              </p>
              <p className="maillist__meta">
                Importing records consent against every address. Turn this on only if that is
                true — the first thing they get will be a broadcast.
              </p>
            </div>
            <Switch
              checked={agreed}
              onChange={setAgreed}
              label="These people asked to hear from this publication"
            />
          </div>

          <div className="mailtpl__foot">
            <button
              className="btn btn--ghost"
              onClick={() => {
                setPreview(null);
                setAgreed(false);
              }}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              className="btn btn--primary"
              onClick={() => void run()}
              disabled={busy || !agreed || usable === 0}
            >
              {busy ? <Spinner size={12} label="Importing" /> : null}
              {busy ? 'Importing…' : `Import ${usable} ${usable === 1 ? 'address' : 'addresses'}`}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** See `EmailTemplates.tsx` for why this row is copied into each screen. */
function MailNav() {
  return (
    <nav className="mailscr__nav" aria-label="Email sections">
      <Link className="mailscr__tab" to="/emails/templates">
        Templates
      </Link>
      <Link className="mailscr__tab" to="/emails/broadcasts">
        Broadcasts
      </Link>
      <Link className="mailscr__tab" to="/emails/subscribers" aria-current="page">
        Subscribers
      </Link>
    </nav>
  );
}

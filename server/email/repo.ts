import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { toEpochMs, toEpochMsOrNull, uniqueViolation } from '../db/client';
import { BadRequestError, PreconditionFailedError } from '../repo/errors';
import { tokenId } from '../repo/users';
import type { Db } from '../db/client';
import type { Post } from '../../shared/types';

/**
 * Email marketing, at rest (HANDOFF §2 A6).
 *
 * NOT `db.transaction`, ANYWHERE. The Neon HTTP driver throws unconditionally on
 * `transaction()` while PGlite supports it, so a transaction here would pass every
 * test in this repository and 500 in production — the trap
 * `server/repo/password-reset.ts` and `disableUser` both carry a note about. Every
 * write below is one statement, and the two places that genuinely need atomicity
 * get it from a guarded UPDATE rather than from a transaction: the draft→sending
 * CAS, and the per-recipient claim.
 */

// -------------------------------------------------------------------- errors

/**
 * A 409 about something on the email surface, carrying the thing.
 *
 * EXTENDS `PreconditionFailedError` RATHER THAN REPLACING IT, exactly as
 * `CategoryPreconditionFailedError` does and for the same two reasons: one of
 * these escaping to `server/middleware/errors.ts` is still a correct 409 rather
 * than a 500 (the safety property), and the payload is what could not be reused —
 * the shared class carries a `Post` and none of these are one.
 *
 * `entity` names the key the payload is rendered under, so a refusal about a
 * broadcast arrives as `{ error, operation, broadcast }` and a refusal about a
 * template as `{ error, operation, template }`. Every one of them answers a
 * question the UI has to answer immediately and cannot answer from the status
 * code: "this broadcast is already sending" wants the row so the progress view can
 * open on it, and "that name is taken" wants the existing template so the picker
 * can select it instead of a second round trip.
 */
export class EmailPreconditionFailedError extends PreconditionFailedError {
  readonly entity: 'template' | 'broadcast' | 'subscriber';
  readonly value: unknown;

  constructor(operation: string, entity: 'template' | 'broadcast' | 'subscriber', value: unknown) {
    // The base requires a non-null `Post` and this has none — the same contained
    // cast `CategoryPreconditionFailedError` documents. Nothing reads `.post` on
    // one of these; the renderer in `server/routes/email.ts` reads `.entity` and
    // `.value`, and the global fallback only ever serialises it.
    super(operation, {} as Post);
    this.name = 'EmailPreconditionFailedError';
    this.entity = entity;
    this.value = value;
  }
}

// ------------------------------------------------------------------- shapes

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  html: string;
  text: string;
  updatedAt: number;
  updatedBy: string | null;
  /**
   * Which system message this row IS, or `null` for one an operator wrote.
   *
   * The admin surface reads it three ways: to badge the row as a default, to
   * disable its delete button, and to offer "Duplicate" — which produces an
   * ordinary row with `null` here, editable and deletable like anything else.
   * `server/mail/defaults.ts` owns the vocabulary; migration 0320 deliberately
   * does NOT constrain it, so adding a message is a deploy and not a migration.
   */
  systemKey: string | null;
}

/**
 * A subscriber as the admin surface sees one.
 *
 * **NO `token`.** It is the entire authority of `POST /api/public/unsubscribe`, so
 * putting it in a list response would mean every admin screen, every browser
 * cache and every log of a 200 body holds a working "unsubscribe this person"
 * credential for the whole audience. The one place it is ever read is the send
 * path, which builds the link and hands it to the recipient it belongs to.
 */
export interface EmailSubscriber {
  id: string;
  email: string;
  name: string | null;
  source: 'customer' | 'manual' | 'import';
  consentAt: number | null;
  unsubscribedAt: number | null;
  createdAt: number;
}

export interface EmailBroadcast {
  id: string;
  templateId: string | null;
  subject: string;
  html: string;
  text: string;
  status: 'draft' | 'sending' | 'sent' | 'failed';
  createdBy: string | null;
  createdAt: number;
  scheduledAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  sentCount: number;
  failedCount: number;
  /**
   * How many recipients were enqueued, ever — the DENOMINATOR.
   *
   * Without it "412 sent" is a number with no scale: it could be nearly done or
   * barely started, and those are not the same thing to somebody watching a send
   * they cannot recall. Counted through `email_broadcast_recipients_dedupe_uq`
   * rather than stored, because unlike `sentCount` it does not move once the
   * audience is enqueued and a fourth counter to keep in step buys nothing.
   */
  recipientCount: number;
}

/** One claimed row, with everything the send needs and nothing it does not. */
export interface ClaimedRecipient {
  id: string;
  subscriberId: string;
  attempts: number;
  email: string;
  name: string | null;
  token: string;
  /** Non-null means this person opted out AFTER the audience was enqueued. */
  unsubscribedAt: number | null;
}

const TEMPLATE_COLUMNS = sql.raw(
  'id, name, subject, html, text, updated_at, updated_by, system_key',
);
const SUBSCRIBER_COLUMNS = sql.raw(
  'id, email, name, source, consent_at, unsubscribed_at, created_at',
);
/**
 * Bare column names, so the same list serves a `SELECT` and a `RETURNING`.
 *
 * `recipient_count` rides along as a correlated sub-select rather than as a fourth
 * stored counter: it is fixed the moment the audience is enqueued, so a column
 * would be one more thing to keep in step with the queue for a number that never
 * changes after the first statement.
 */
const BROADCAST_COLUMNS = sql.raw(
  `id, template_id, subject, html, text, status, created_by, created_at,
   scheduled_at, started_at, finished_at, sent_count, failed_count,
   (SELECT count(*) FROM email_broadcast_recipients r
     WHERE r.broadcast_id = email_broadcasts.id) AS recipient_count`,
);

function rowToTemplate(row: Record<string, unknown>): EmailTemplate {
  return {
    id: String(row.id),
    name: String(row.name),
    subject: String(row.subject),
    html: String(row.html),
    text: String(row.text),
    updatedAt: toEpochMs(row.updated_at),
    updatedBy: row.updated_by == null ? null : String(row.updated_by),
    systemKey: row.system_key == null ? null : String(row.system_key),
  };
}

function rowToSubscriber(row: Record<string, unknown>): EmailSubscriber {
  return {
    id: String(row.id),
    email: String(row.email),
    name: row.name == null ? null : String(row.name),
    source: row.source as EmailSubscriber['source'],
    consentAt: toEpochMsOrNull(row.consent_at),
    unsubscribedAt: toEpochMsOrNull(row.unsubscribed_at),
    createdAt: toEpochMs(row.created_at),
  };
}

function rowToBroadcast(row: Record<string, unknown>): EmailBroadcast {
  return {
    id: String(row.id),
    templateId: row.template_id == null ? null : String(row.template_id),
    subject: String(row.subject),
    html: String(row.html),
    text: String(row.text),
    status: row.status as EmailBroadcast['status'],
    createdBy: row.created_by == null ? null : String(row.created_by),
    createdAt: toEpochMs(row.created_at),
    scheduledAt: toEpochMsOrNull(row.scheduled_at),
    startedAt: toEpochMsOrNull(row.started_at),
    finishedAt: toEpochMsOrNull(row.finished_at),
    // `Number` and not `toEpochMs`: these are integer counters, not epoch-ms, and
    // PGlite and Neon agree about `integer` — the divergence is int8 only.
    sentCount: Number(row.sent_count),
    failedCount: Number(row.failed_count),
    // `count(*)` IS an int8 and therefore IS one of the values PGlite and Neon
    // disagree about — a number from one and a string from the other. `Number`
    // closes it; `toEpochMs` would be the wrong function for a value that is not
    // a timestamp.
    recipientCount: Number(row.recipient_count),
  };
}

// ---------------------------------------------------------------- templates

/** The index whose violation is a duplicate name rather than a bug. */
const TEMPLATE_NAME_UQ = 'email_templates_name_lower_uq';

/**
 * Every template, SYSTEM ONES FIRST.
 *
 * The order changed with migration 0320 and the reason is the screen: the nine
 * defaults are the ones an operator is looking for — they are the messages
 * customers actually receive — and sorting purely by `updated_at` buried them
 * under every draft as soon as somebody edited a broadcast template. Within each
 * group the old ordering stands, so an operator's own list still reads
 * most-recently-touched first.
 */
export async function listTemplates(db: Db): Promise<EmailTemplate[]> {
  const res = await db.execute(sql`
    SELECT ${TEMPLATE_COLUMNS} FROM email_templates
     ORDER BY (system_key IS NULL), system_key ASC, updated_at DESC, id DESC`);
  return res.rows.map(rowToTemplate);
}

/** One system template by its key, or `null`. The renderer's only read. */
export async function getSystemTemplate(
  db: Db,
  key: string,
): Promise<EmailTemplate | null> {
  const res = await db.execute(sql`
    SELECT ${TEMPLATE_COLUMNS} FROM email_templates WHERE system_key = ${key}`);
  return res.rows[0] ? rowToTemplate(res.rows[0]) : null;
}

/** Every system template in one read, keyed. What the sweep loads once a pass. */
export async function listSystemTemplates(db: Db): Promise<EmailTemplate[]> {
  const res = await db.execute(sql`
    SELECT ${TEMPLATE_COLUMNS} FROM email_templates
     WHERE system_key IS NOT NULL ORDER BY system_key ASC`);
  return res.rows.map(rowToTemplate);
}

/**
 * Insert one system template if it is not already there. Idempotent.
 *
 * `ON CONFLICT DO NOTHING` ON BOTH INDEXES, and the second one is the subtle
 * part. `system_key` conflicts are the ordinary case — the row is already
 * seeded — but `email_templates_name_lower_uq` can also fire, because an
 * operator may already have written their own template called "Welcome". A
 * seeder that raised on that would make the templates screen 500 for exactly the
 * operator who had used it most.
 *
 * The name is disambiguated instead: a system row whose preferred name is taken
 * seeds as "Welcome (system)". Ugly, and correct — the alternative is either a
 * crash or silently renaming somebody else's template out from under them.
 */
export async function seedSystemTemplate(
  db: Db,
  input: TemplateInput & { systemKey: string },
  now: number,
): Promise<EmailTemplate | null> {
  const res = await db.execute(sql`
    INSERT INTO email_templates (name, subject, html, text, updated_at, updated_by, system_key)
    SELECT CASE WHEN EXISTS (SELECT 1 FROM email_templates t WHERE lower(t.name) = lower(${input.name}))
                THEN ${input.name} || ' (system)' ELSE ${input.name} END,
           ${input.subject}, ${input.html}, ${input.text}, ${now}, NULL, ${input.systemKey}
     WHERE NOT EXISTS (SELECT 1 FROM email_templates s WHERE s.system_key = ${input.systemKey})
    ON CONFLICT DO NOTHING
    RETURNING ${TEMPLATE_COLUMNS}`);
  return res.rows[0] ? rowToTemplate(res.rows[0]) : null;
}

/**
 * Copy a template into a new, ordinary one.
 *
 * THE COPY IS NEVER A SYSTEM TEMPLATE — `system_key` is not carried over, and it
 * could not be even if this wanted to, because the unique index allows one row
 * per key. That is the point of the feature: duplicating `order.confirmation`
 * gives an operator something they can edit freely and delete, without touching
 * the row the order pipeline actually renders from.
 *
 * THE NAME IS DISAMBIGUATED HERE RATHER THAN BY THE CALLER, because "copy",
 * "copy 2", "copy 3" is a loop and a loop belongs next to the constraint it is
 * fighting. Bounded at 50: past that something is wrong with the caller, and a
 * refusal an operator can read beats an unbounded scan.
 */
export async function duplicateTemplate(
  db: Db,
  id: string,
  actorId: string,
  now: number,
): Promise<EmailTemplate | null> {
  const source = await getTemplate(db, id);
  if (source === null) return null;

  for (let n = 1; n <= 50; n += 1) {
    const name = n === 1 ? `${source.name} copy` : `${source.name} copy ${n}`;
    const res = await db.execute(sql`
      INSERT INTO email_templates (name, subject, html, text, updated_at, updated_by)
      SELECT ${name}, ${source.subject}, ${source.html}, ${source.text}, ${now},
             ${actorId}::uuid
       WHERE NOT EXISTS (SELECT 1 FROM email_templates t WHERE lower(t.name) = lower(${name}))
      RETURNING ${TEMPLATE_COLUMNS}`);
    if (res.rows[0]) return rowToTemplate(res.rows[0]);
  }
  throw new EmailPreconditionFailedError('duplicate', 'template', source.name);
}

export async function getTemplate(db: Db, id: string): Promise<EmailTemplate | null> {
  const res = await db.execute(sql`
    SELECT ${TEMPLATE_COLUMNS} FROM email_templates WHERE id = ${id}::uuid`);
  return res.rows[0] ? rowToTemplate(res.rows[0]) : null;
}

export interface TemplateInput {
  name: string;
  subject: string;
  html: string;
  text: string;
}

export async function createTemplate(
  db: Db,
  input: TemplateInput,
  actorId: string,
  now: number,
): Promise<EmailTemplate> {
  try {
    const res = await db.execute(sql`
      INSERT INTO email_templates (name, subject, html, text, updated_at, updated_by)
      VALUES (${input.name}, ${input.subject}, ${input.html}, ${input.text},
              ${now}, ${actorId}::uuid)
      RETURNING ${TEMPLATE_COLUMNS}`);
    return rowToTemplate(res.rows[0]);
  } catch (err) {
    // Translated rather than left to become a 500: a duplicate name is an
    // ordinary thing for an owner to do and a permanent condition, so it is a
    // refusal the caller can act on. Anything else is a real fault and re-thrown.
    if (uniqueViolation(err) === TEMPLATE_NAME_UQ) {
      const existing = await findTemplateByName(db, input.name);
      throw new EmailPreconditionFailedError('create', 'template', existing);
    }
    throw err;
  }
}

export async function updateTemplate(
  db: Db,
  id: string,
  input: TemplateInput,
  actorId: string,
  now: number,
): Promise<EmailTemplate | null> {
  try {
    const res = await db.execute(sql`
      UPDATE email_templates
         SET name = ${input.name}, subject = ${input.subject},
             html = ${input.html}, text = ${input.text},
             updated_at = ${now}, updated_by = ${actorId}::uuid
       WHERE id = ${id}::uuid
      RETURNING ${TEMPLATE_COLUMNS}`);
    return res.rows[0] ? rowToTemplate(res.rows[0]) : null;
  } catch (err) {
    if (uniqueViolation(err) === TEMPLATE_NAME_UQ) {
      const existing = await findTemplateByName(db, input.name);
      throw new EmailPreconditionFailedError('rename', 'template', existing);
    }
    throw err;
  }
}

async function findTemplateByName(db: Db, name: string): Promise<EmailTemplate | null> {
  const res = await db.execute(sql`
    SELECT ${TEMPLATE_COLUMNS} FROM email_templates WHERE lower(name) = lower(${name})`);
  return res.rows[0] ? rowToTemplate(res.rows[0]) : null;
}

/**
 * Delete, and it is deliberately NOT refused when a broadcast used the template.
 *
 * `email_broadcasts.template_id` is `ON DELETE SET NULL` and the subject, html and
 * text a broadcast sent are its own snapshot columns — so a deleted template takes
 * nothing away from the history. Refusing here would mean a template can never be
 * retired once it has been used once, which on this surface is "once ever".
 */
export async function deleteTemplate(db: Db, id: string): Promise<boolean> {
  /*
   * A SYSTEM TEMPLATE IS REFUSED, AND IT IS REFUSED TWICE.
   *
   * This read is what produces a 409 the admin screen can render — "that is a
   * default template" rather than a 500 with a Postgres trigger message in it.
   * The trigger from migration 0320 is the one that actually holds, because it
   * also holds for a caller that never comes through this function.
   *
   * The `WHERE system_key IS NULL` on the DELETE below is not redundant with
   * either of them: it closes the window between this read and that statement,
   * so a template that BECAME a system template in between is not deleted by a
   * decision made against the older row.
   */
  const existing = await getTemplate(db, id);
  if (existing === null) return false;
  if (existing.systemKey !== null) {
    throw new EmailPreconditionFailedError('delete', 'template', existing);
  }

  const res = await db.execute(sql`
    DELETE FROM email_templates
     WHERE id = ${id}::uuid AND system_key IS NULL RETURNING id`);
  return res.rows.length > 0;
}

// --------------------------------------------------------------- subscribers

/**
 * Lowercased and trimmed, exactly as `server/routes/auth.ts` and
 * `server/shop/cart/identity/customers.ts` each do for their own tables.
 *
 * A THIRD PRIVATE COPY, AND THAT IS NOT AN OVERSIGHT. The other two are one line
 * each in files this task does not own, and importing one of them would couple the
 * blog's marketing tables either to the auth router or to the shop's customer
 * identity. What keeps the copies honest is that the rule is also IN THE DATABASE:
 * `email_subscribers_email_ck` refuses any address that is not already lowercase,
 * so a caller that forgets this function fails loudly instead of quietly creating
 * a second subscriber for the same person.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The unsubscribe credential for a subscriber id.
 *
 * HMAC-SHA-256 UNDER `SESSION_SECRET`, NOT A BARE DIGEST — the construction
 * `server/repo/users.ts` documents for session and invite tokens, reused here
 * through the same function so there is one answer in this codebase to "how is an
 * unguessable handle derived". A bare `sha256(id)` would be offline-computable
 * from an id that appears in every admin list response, which would make every
 * subscriber's unsubscribe link derivable by anyone who ever saw the audience.
 *
 * Rotating `SESSION_SECRET` invalidates every outstanding unsubscribe link along
 * with every session — correct for a rotation, and the reason the token is STORED
 * rather than recomputed on read would be wrong here: it is stored so the lookup
 * is one indexed equality, and a rotation is followed by links that no longer
 * resolve rather than by links that resolve to the wrong person.
 */
export function subscriberToken(id: string): string {
  return tokenId(id);
}

export interface SubscriberInput {
  email: string;
  name?: string | null;
  source: EmailSubscriber['source'];
  /** Epoch-ms, or null for an address nobody has a consent record for. */
  consentAt?: number | null;
}

/**
 * Add one, idempotently.
 *
 * **AN EXISTING ADDRESS IS NEVER RESURRECTED.** `created: false` comes back with
 * the row exactly as it was, `unsubscribed_at` included. That is the whole point
 * of a suppression list: if adding an address again cleared the opt-out, then any
 * CSV import — or one owner pasting last year's list — would silently re-subscribe
 * everybody who had asked to stop, which is the one mistake on this surface with
 * legal weight as well as reputational weight.
 *
 * `ON CONFLICT DO NOTHING` and then a read, rather than a read and then an insert:
 * two imports running at once both find the address absent, and the unique index
 * is the authority for which one wins — the same shape `POST /api/import` uses for
 * `posts_pkey`.
 */
export async function addSubscriber(
  db: Db,
  input: SubscriberInput,
  now: number,
): Promise<{ subscriber: EmailSubscriber; created: boolean }> {
  const email = normaliseEmail(input.email);
  // Minted here, not by the database: `token` is an HMAC of it. See the note on
  // `email_subscribers.id` in migration 0008.
  const id = randomUUID();
  const name = (input.name ?? '').trim() || null;

  const inserted = await db.execute(sql`
    INSERT INTO email_subscribers (id, email, name, source, consent_at, token, created_at)
    VALUES (${id}::uuid, ${email}, ${name}, ${input.source}, ${input.consentAt ?? null},
            ${subscriberToken(id)}, ${now})
    ON CONFLICT (email) DO NOTHING
    RETURNING ${SUBSCRIBER_COLUMNS}`);

  if (inserted.rows[0]) return { subscriber: rowToSubscriber(inserted.rows[0]), created: true };

  const existing = await db.execute(sql`
    SELECT ${SUBSCRIBER_COLUMNS} FROM email_subscribers WHERE email = ${email}`);
  return { subscriber: rowToSubscriber(existing.rows[0]), created: false };
}

export type SubscriberFilter = 'subscribed' | 'unsubscribed' | 'all';

export interface SubscriberPage {
  items: EmailSubscriber[];
  /** Absent when this was the last page. Opaque; see `server/repo/cursor.ts`. */
  nextCursor: string | null;
}

/**
 * One page, newest first, by keyset.
 *
 * KEYSET AND NOT OFFSET, for the reason `server/repo/cursor.ts` gives at length: a
 * subscriber added while somebody scrolls pushes one row past the boundary of an
 * `OFFSET` page and it is never seen. On this table that is not cosmetic — the
 * rows are people, and "we could not find them in the list" is how an unsubscribe
 * request gets lost.
 */
export async function listSubscribers(
  db: Db,
  options: { filter: SubscriberFilter; limit: number; after?: { createdAt: number; id: string } },
): Promise<SubscriberPage> {
  const { filter, limit, after } = options;

  const suppression =
    filter === 'subscribed'
      ? sql`AND unsubscribed_at IS NULL`
      : filter === 'unsubscribed'
        ? sql`AND unsubscribed_at IS NOT NULL`
        : sql``;

  /*
   * SPELLED OUT RATHER THAN AS A ROW COMPARISON. `(created_at, id) < (?, ?)` is
   * the same predicate and reads better, but it binds a bigint and a uuid into one
   * anonymous row constructor and leaves the parameter types to inference — which
   * is exactly the kind of thing that works in PGlite and raises 22P02 against
   * Neon. Both branches here carry their own explicit cast.
   */
  const keyset = after
    ? sql`AND (created_at < ${after.createdAt}::bigint
               OR (created_at = ${after.createdAt}::bigint AND id < ${after.id}::uuid))`
    : sql``;

  const res = await db.execute(sql`
    SELECT ${SUBSCRIBER_COLUMNS} FROM email_subscribers
     WHERE TRUE ${suppression} ${keyset}
     ORDER BY created_at DESC, id DESC
     LIMIT ${limit + 1}`);

  // One more than asked for, so "is there another page" is answered by the read
  // rather than by a second count that can disagree with it.
  const rows = res.rows.slice(0, limit).map(rowToSubscriber);
  const last = rows[rows.length - 1];
  return {
    items: rows,
    nextCursor: res.rows.length > limit && last ? encodeSubscriberCursor(last) : null,
  };
}

/** Counts for the confirm dialog, which must state the REAL recipient count. */
export async function audienceCounts(db: Db): Promise<{ subscribed: number; suppressed: number }> {
  const res = await db.execute(sql`
    SELECT count(*) FILTER (WHERE unsubscribed_at IS NULL) AS subscribed,
           count(*) FILTER (WHERE unsubscribed_at IS NOT NULL) AS suppressed
      FROM email_subscribers`);
  return {
    subscribed: Number(res.rows[0].subscribed),
    suppressed: Number(res.rows[0].suppressed),
  };
}

/**
 * The cursor codec for this list.
 *
 * `server/repo/cursor.ts`'s `encodeCursor`/`requireCursor` are the shared pair and
 * are used by the route; these two exist only to keep the SORT NAME (`subscribers`)
 * and the tuple shape in one place, so a cursor minted here cannot be spent
 * against a different ordering. That binding is the property `requireCursor`
 * enforces and the reason it takes a sort key at all.
 */
export const SUBSCRIBER_SORT = 'subscribers';

function encodeSubscriberCursor(row: EmailSubscriber): string {
  return Buffer.from(
    JSON.stringify([SUBSCRIBER_SORT, [row.createdAt], row.id]),
    'utf8',
  ).toString('base64url');
}

// ------------------------------------------------------------------ import

/** Bounded because the whole file is read into memory and then validated whole. */
export const MAX_IMPORT_ROWS = 5000;

export interface CsvRow {
  email: string;
  name: string | null;
  /** 1-based, counting the header, so an error message names the line the
   * operator can see in their spreadsheet. */
  line: number;
}

/**
 * A CSV, to rows. RFC 4180 enough for the files people actually have.
 *
 * QUOTES ARE HANDLED, AND THAT IS NOT GOLD-PLATING. `split(',')` is the obvious
 * implementation and it breaks on `"Smith, John",jsmith@example.com` — a row every
 * export from every address book produces — by shifting every field one to the
 * right, which turns a name into an email address and imports garbage silently.
 * Doubled quotes (`""`) inside a quoted field are the escape RFC 4180 defines.
 *
 * A HEADER IS DETECTED, NOT REQUIRED. A file whose first line contains a cell
 * equal to `email` is treated as having one and the columns are located by name;
 * anything else is treated as `email[,name]` positionally. Requiring a header
 * would reject the single most common paste (one address per line); assuming one
 * would silently drop the first subscriber.
 */
export function parseSubscriberCsv(csv: string): CsvRow[] {
  const rows: CsvRow[] = [];
  const records = splitRecords(csv);
  if (records.length === 0) return rows;

  const first = records[0].cells.map((cell) => cell.trim().toLowerCase());
  const hasHeader = first.includes('email');
  const emailAt = hasHeader ? first.indexOf('email') : 0;
  const nameAt = hasHeader ? first.indexOf('name') : 1;

  for (const record of records.slice(hasHeader ? 1 : 0)) {
    // A wholly blank line is skipped rather than reported: a trailing newline is
    // universal, and an import that fails on one would fail on almost every file.
    if (record.cells.every((cell) => cell.trim() === '')) continue;
    const name = nameAt >= 0 ? (record.cells[nameAt] ?? '').trim() : '';
    rows.push({
      email: (record.cells[emailAt] ?? '').trim(),
      name: name === '' ? null : name,
      line: record.line,
    });
  }
  return rows;
}

function splitRecords(csv: string): { cells: string[]; line: number }[] {
  const records: { cells: string[]; line: number }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let started = line;

  const endCell = () => {
    cells.push(cell);
    cell = '';
  };
  const endRecord = () => {
    endCell();
    records.push({ cells, line: started });
    cells = [];
    started = line + 1;
  };

  for (let i = 0; i < csv.length; i += 1) {
    const ch = csv[i];
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else {
        if (ch === '\n') line += 1;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') endCell();
    else if (ch === '\r') continue; // CRLF: the \n does the work.
    else if (ch === '\n') {
      endRecord();
      line += 1;
    } else cell += ch;
  }
  if (cell !== '' || cells.length > 0) endRecord();
  return records;
}

/**
 * A shape that looks like an address, and nothing stricter.
 *
 * DELIBERATELY NOT AN RFC 5322 VALIDATOR. `users.email` is validated by length
 * alone (`server/routes/auth.ts`'s `LoginBody` says "format not validated"),
 * because every regex that claims to match the grammar rejects addresses that
 * exist. This one exists for a different job: an import is a bulk write of values
 * a human pasted, and the failure it has to catch is a column shifted by one — a
 * file whose "email" column holds `Smith, John`. One `@` with something on each
 * side catches that and rejects almost nothing real.
 */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+$/;

export interface ImportSummary {
  /** New rows. Named `added` rather than `imported` because the same summary
   * serves the CSV form and the parsed-array form, and only one of them is an
   * import of a file. */
  added: number;
  /** Addresses already on the list. Their existing state — including an opt-out —
   * is untouched; see `addSubscriber`. */
  skipped: number;
  total: number;
}

/**
 * VALIDATE EVERY ROW BEFORE WRITING ANY ROW (the rule `POST /api/import` states).
 *
 * Validating as each row is inserted leaves the rows before the bad one stored and
 * the ones after it not — a partial import the caller cannot distinguish from a
 * complete one, on a table where "did that address get added" is not a question
 * anyone can answer by looking at the file. `detail` names the LINE, which is the
 * one piece of information that makes a rejected 900-row file actionable, and it
 * is a position rather than a value so nothing a caller pasted comes back in a 400.
 */
export async function importSubscribers(
  db: Db,
  rows: CsvRow[],
  now: number,
  /**
   * `now` when the importer explicitly asserted that these people agreed to be
   * mailed, `null` when they did not.
   *
   * WHAT THE TIMESTAMP MEANS ON AN IMPORTED ROW, said out loud because it is not
   * what the column name suggests: it records when the OPERATOR asserted the
   * consent, not when the subscriber gave it. That is the only thing a bulk upload
   * can honestly record — the file says somebody has these addresses and nothing
   * else — and it is the same thing `POST /admin/email/subscribers` records for an
   * address typed in by hand. Without the assertion the row carries no timestamp
   * at all, because a date written anyway would be evidence that is not evidence.
   */
  consentAt: number | null,
): Promise<ImportSummary> {
  if (rows.length === 0) throw new BadRequestError('csv');
  if (rows.length > MAX_IMPORT_ROWS) throw new BadRequestError('csv');

  const seen = new Set<string>();
  for (const row of rows) {
    const email = normaliseEmail(row.email);
    if (!LOOKS_LIKE_EMAIL.test(email) || email.length > 320) {
      throw new BadRequestError(`csv.line.${row.line}`);
    }
    // A file that lists one address twice is refused rather than deduplicated:
    // silently collapsing it would make `imported + skipped` disagree with the
    // row count the operator is looking at.
    if (seen.has(email)) throw new BadRequestError(`csv.line.${row.line}`);
    seen.add(email);
  }

  let added = 0;
  let skipped = 0;
  for (const row of rows) {
    const outcome = await addSubscriber(
      db,
      { email: row.email, name: row.name, source: 'import', consentAt },
      now,
    );
    if (outcome.created) added += 1;
    else skipped += 1;
  }
  return { added, skipped, total: rows.length };
}

// ------------------------------------------------------------- unsubscribing

/**
 * Spend an unsubscribe link. Idempotent, and `null` only for a token nothing
 * matches.
 *
 * `unsubscribed_at IS NULL` GUARDS THE WRITE so a second click does not move the
 * timestamp — the date somebody opted out is a fact about them, and re-stamping it
 * every time a mail client prefetches the link would make it the date of the last
 * prefetch. The row comes back either way, because the page a person sees must say
 * "you are unsubscribed" whether this was the click that did it or the third one.
 */
export async function unsubscribeByToken(
  db: Db,
  token: string,
  now: number,
): Promise<EmailSubscriber | null> {
  const res = await db.execute(sql`
    UPDATE email_subscribers
       SET unsubscribed_at = ${now}
     WHERE token = ${token} AND unsubscribed_at IS NULL
    RETURNING ${SUBSCRIBER_COLUMNS}`);
  if (res.rows[0]) return rowToSubscriber(res.rows[0]);
  return findSubscriberByToken(db, token);
}

export async function findSubscriberByToken(
  db: Db,
  token: string,
): Promise<EmailSubscriber | null> {
  const res = await db.execute(sql`
    SELECT ${SUBSCRIBER_COLUMNS} FROM email_subscribers WHERE token = ${token}`);
  return res.rows[0] ? rowToSubscriber(res.rows[0]) : null;
}

/** The caller's own unsubscribe token, for a test send. `null` if they are not on
 * the list at all. */
export async function tokenForEmail(db: Db, email: string): Promise<string | null> {
  const res = await db.execute(sql`
    SELECT token FROM email_subscribers WHERE email = ${normaliseEmail(email)}`);
  return res.rows[0] ? String(res.rows[0].token) : null;
}

// ---------------------------------------------------------------- broadcasts

export async function createBroadcast(
  db: Db,
  snapshot: { templateId: string | null; subject: string; html: string; text: string },
  actorId: string,
  now: number,
): Promise<EmailBroadcast> {
  const res = await db.execute(sql`
    INSERT INTO email_broadcasts (id, template_id, subject, html, text, status,
                                  created_by, created_at)
    VALUES (${randomUUID()}::uuid, ${snapshot.templateId}::uuid,
            ${snapshot.subject}, ${snapshot.html}, ${snapshot.text}, 'draft',
            ${actorId}::uuid, ${now})
    RETURNING ${BROADCAST_COLUMNS}`);
  return rowToBroadcast(res.rows[0]);
}

export async function listBroadcasts(db: Db): Promise<EmailBroadcast[]> {
  const res = await db.execute(sql`
    SELECT ${BROADCAST_COLUMNS} FROM email_broadcasts
     ORDER BY created_at DESC, id DESC LIMIT 100`);
  return res.rows.map(rowToBroadcast);
}

export async function getBroadcast(db: Db, id: string): Promise<EmailBroadcast | null> {
  const res = await db.execute(sql`
    SELECT ${BROADCAST_COLUMNS} FROM email_broadcasts WHERE id = ${id}::uuid`);
  return res.rows[0] ? rowToBroadcast(res.rows[0]) : null;
}

/** Every broadcast the drain still owes work to, oldest first. */
export async function listSendingBroadcasts(db: Db, limit: number): Promise<EmailBroadcast[]> {
  const res = await db.execute(sql`
    SELECT ${BROADCAST_COLUMNS} FROM email_broadcasts
     WHERE status = 'sending'
     ORDER BY created_at ASC, id ASC
     LIMIT ${limit}`);
  return res.rows.map(rowToBroadcast);
}

/**
 * draft → sending, as a GUARDED UPDATE and never a read-then-write.
 *
 * Two owners pressing "send" at the same instant both pass a
 * `SELECT … WHERE status = 'draft'`, and both then enqueue an audience. The unique
 * dedupe index means the second enqueue inserts nothing, so the damage would be
 * bounded anyway — but the CAS is what makes `started_at` mean the moment the send
 * began rather than the moment the last duplicate request arrived, and it is what
 * lets the route answer the loser with a 409 that carries the row.
 *
 * Returns `null` when the row was not a draft. The caller re-reads to find out
 * whether that is "already sending" or "no such broadcast".
 */
export async function startBroadcast(
  db: Db,
  id: string,
  now: number,
): Promise<EmailBroadcast | null> {
  const res = await db.execute(sql`
    UPDATE email_broadcasts
       SET status = 'sending', started_at = ${now}
     WHERE id = ${id}::uuid AND status = 'draft'
    RETURNING ${BROADCAST_COLUMNS}`);
  return res.rows[0] ? rowToBroadcast(res.rows[0]) : null;
}

/**
 * Enqueue the audience: every subscriber who has not opted out, once.
 *
 * ONE STATEMENT, `INSERT … SELECT`, so an audience of five thousand is one round
 * trip to Neon rather than five thousand. `ON CONFLICT DO NOTHING` against the
 * dedupe index is what makes a duplicated call — a second press, a retried
 * request, a cron delivery Vercel documents as possibly duplicated — enqueue
 * nothing the second time.
 *
 * `gen_random_uuid()` for the recipient id, unlike `email_subscribers.id`: nothing
 * about a recipient row is derived from its id, so there is no reason to mint five
 * thousand of them in the process and send them over the wire.
 *
 * SUPPRESSION IS APPLIED HERE **AND** AT CLAIM TIME. Here it keeps the queue from
 * carrying rows that can never be sent; there it catches the person who opts out
 * between the two. Neither is sufficient alone, and `send.ts` tests both.
 */
export async function enqueueAudience(db: Db, broadcastId: string): Promise<number> {
  const res = await db.execute(sql`
    INSERT INTO email_broadcast_recipients (id, broadcast_id, subscriber_id, status)
    SELECT gen_random_uuid(), ${broadcastId}::uuid, s.id, 'pending'
      FROM email_subscribers s
     WHERE s.unsubscribed_at IS NULL
    ON CONFLICT (broadcast_id, subscriber_id) DO NOTHING
    RETURNING id`);
  return res.rows.length;
}

/** How the queue for one broadcast stands, for the detail view. */
export async function recipientCounts(
  db: Db,
  broadcastId: string,
): Promise<{ pending: number; sent: number; failed: number }> {
  const res = await db.execute(sql`
    SELECT count(*) FILTER (WHERE status = 'pending') AS pending,
           count(*) FILTER (WHERE status = 'sent') AS sent,
           count(*) FILTER (WHERE status = 'failed') AS failed
      FROM email_broadcast_recipients WHERE broadcast_id = ${broadcastId}::uuid`);
  const row = res.rows[0];
  return {
    pending: Number(row.pending),
    sent: Number(row.sent),
    failed: Number(row.failed),
  };
}

/**
 * The next batch, with the subscriber joined in.
 *
 * THE JOIN IS WHAT MAKES SUPPRESSION LATE. `unsubscribed_at` is read HERE, at the
 * moment of sending, rather than having been frozen onto the recipient row when
 * the audience was enqueued — so somebody who clicks unsubscribe while a broadcast
 * is draining is not mailed by the batch that had not reached them yet. That is
 * the whole reason this table carries no address snapshot, and it is the one place
 * this queue deliberately differs from `shop_order_email_intents`.
 */
export async function claimableRecipients(
  db: Db,
  broadcastId: string,
  limit: number,
): Promise<ClaimedRecipient[]> {
  const res = await db.execute(sql`
    SELECT r.id, r.subscriber_id, r.attempts,
           s.email, s.name, s.token, s.unsubscribed_at
      FROM email_broadcast_recipients r
      JOIN email_subscribers s ON s.id = r.subscriber_id
     WHERE r.broadcast_id = ${broadcastId}::uuid AND r.status = 'pending'
     ORDER BY r.id ASC
     LIMIT ${limit}`);
  return res.rows.map((row) => ({
    id: String(row.id),
    subscriberId: String(row.subscriber_id),
    attempts: Number(row.attempts),
    email: String(row.email),
    name: row.name == null ? null : String(row.name),
    token: String(row.token),
    unsubscribedAt: toEpochMsOrNull(row.unsubscribed_at),
  }));
}

/**
 * THE CLAIM, AND IT IS A CAS ON `attempts` — which is why there is no lease column.
 *
 * Two drains running at once (a cron and an owner pressing "continue") both read
 * `attempts = 0`; both then try `SET attempts = 1 WHERE attempts = 0`, and exactly
 * one matches. The loser skips the row WITHOUT SENDING, so concurrent drains
 * cannot double-deliver — the property a `claimed_at` column is usually added for,
 * obtained from a column that had to exist anyway.
 *
 * WHAT REMAINS, STATED PLAINLY: if the process dies between the claim and the
 * `status = 'sent'` write, the next drain retries and one subscriber may receive
 * the broadcast twice. That is the irreducible at-least-once property of an outbox
 * without a distributed transaction across the provider, and
 * `server/shop/orders/repo/emails.ts` says the same thing about order mail. It is
 * bounded to a crash window rather than being a race any two drains can lose.
 */
export async function claimRecipient(
  db: Db,
  id: string,
  attempts: number,
): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE email_broadcast_recipients
       SET attempts = attempts + 1
     WHERE id = ${id}::uuid AND status = 'pending' AND attempts = ${attempts}
    RETURNING id`);
  return res.rows.length > 0;
}

/** Delivered. The broadcast's counter moves in its own statement — see the note on
 * `sent_count` in migration 0008 for why the counter exists at all. */
export async function markRecipientSent(db: Db, id: string, broadcastId: string, now: number) {
  await db.execute(sql`
    UPDATE email_broadcast_recipients
       SET status = 'sent', sent_at = ${now}, last_error = NULL
     WHERE id = ${id}::uuid AND status = 'pending'`);
  await db.execute(sql`
    UPDATE email_broadcasts SET sent_count = sent_count + 1 WHERE id = ${broadcastId}::uuid`);
}

/**
 * Not delivered.
 *
 * `terminal` DECIDES WHETHER THIS ROW IS DONE. A transport failure with attempts
 * left stays `pending` and is retried by the next drain; one that has exhausted
 * them, and a recipient who has opted out since the audience was enqueued, become
 * `failed` — because a queue whose rows can never leave `pending` is a broadcast
 * that never finishes and a progress bar that never fills.
 *
 * `failed_count` moves only on the terminal write, so a message retried three
 * times and then delivered is counted once, as a success.
 */
export async function markRecipientFailed(
  db: Db,
  id: string,
  broadcastId: string,
  detail: string,
  terminal: boolean,
): Promise<void> {
  await db.execute(sql`
    UPDATE email_broadcast_recipients
       SET last_error = ${detail}, status = ${terminal ? 'failed' : 'pending'}
     WHERE id = ${id}::uuid AND status = 'pending'`);
  if (terminal) {
    await db.execute(sql`
      UPDATE email_broadcasts SET failed_count = failed_count + 1
       WHERE id = ${broadcastId}::uuid`);
  }
}

/**
 * sending → sent (or failed), once nothing is pending.
 *
 * `NOT EXISTS (… status = 'pending')` IS PART OF THE GUARD rather than something
 * the caller checks first: a drain that finished its batch and a concurrent drain
 * that is mid-flight would otherwise race, and the one that read "nothing pending"
 * a moment too early would close a broadcast that still owed people mail.
 *
 * `failed` ONLY WHEN NOTHING AT ALL WENT OUT. A broadcast that reached four
 * thousand people and could not reach six is a broadcast that was SENT, with a
 * `failedCount` of six beside it; calling it "failed" would put a red badge on the
 * most successful thing this surface does. Returns `null` when the broadcast is
 * not finishable yet, which is the ordinary answer between batches.
 */
export async function finishBroadcast(
  db: Db,
  id: string,
  now: number,
): Promise<EmailBroadcast | null> {
  const res = await db.execute(sql`
    UPDATE email_broadcasts
       SET status = CASE WHEN sent_count = 0 AND failed_count > 0 THEN 'failed' ELSE 'sent' END,
           finished_at = ${now}
     WHERE id = ${id}::uuid AND status = 'sending'
       AND NOT EXISTS (SELECT 1 FROM email_broadcast_recipients
                        WHERE broadcast_id = ${id}::uuid AND status = 'pending')
    RETURNING ${BROADCAST_COLUMNS}`);
  return res.rows[0] ? rowToBroadcast(res.rows[0]) : null;
}

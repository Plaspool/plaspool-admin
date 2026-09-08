/**
 * `server/email/repo.ts`'s broadcast-audience surface, on its own.
 *
 * There was no dedicated repo suite for this file before the "Not bought yet"
 * screen — `createBroadcast` and `enqueueAudience` were exercised only through
 * `server/email/send.ts` (the drain) and `server/routes/email.ts` (the HTTP
 * surface). Naming an audience needed a home neither of those files is.
 *
 * THE PROPERTY THIS FILE EXISTS TO PROVE: a `picked` broadcast enrols the
 * addresses it names as subscribers AS IT SENDS, through the same idempotent,
 * never-resurrecting `addSubscriber` every other entry point uses — so a
 * picked send is lawful (every recipient gets a working unsubscribe link)
 * without being a second, looser path into the subscriber table. Production
 * held ZERO subscriber rows when this was written, which is why that
 * property, not merely "the row gets inserted", is what these tests pin down.
 * The second property is that `all_subscribers` — every broadcast that has
 * ever existed until now — is completely unaffected: same statement, same
 * suppression, same everything, with `picked` adding a predicate rather than
 * a parallel path.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedDb } from '../test/harness';
import {
  addSubscriber,
  createBroadcast,
  enqueueAudience,
  listBroadcastAudience,
  markRecipientSent,
  markRecipientSkipped,
  setBroadcastAudience,
  tokenForEmail,
  unsubscribeByToken,
} from './repo';
import type { Db } from '../db/client';

let db: Db;
let close: () => Promise<void>;

const NOW = 1788800000000;

const BASE_SNAPSHOT = {
  templateId: null as string | null,
  subject: 'Hello {{name}}',
  html: '<p>hi {{name}}</p><a href="{{unsubscribe_url}}">out</a>',
  text: 'hi {{name}}\n\n{{unsubscribe_url}}',
};

/** `BASE_SNAPSHOT`, with an audience opinion layered on — `{}` means "say
 *  nothing", which is what every caller before Task 7 does. */
function snapshot(overrides: { audienceKind?: 'all_subscribers' | 'picked' }) {
  return { ...BASE_SNAPSHOT, ...overrides };
}

/** The seeded owner, so `created_by` satisfies its foreign key. */
let actor: string;

beforeAll(async () => {
  ({ db, close } = await migratedDb());
  const res = await db.execute(sql`
    INSERT INTO users (email, password_hash, display_name, role, created_at)
    VALUES ('audience@test.local', 'x', 'Audience', 'owner', ${NOW})
    RETURNING id`);
  actor = String(res.rows[0].id);
});
afterAll(() => close());

beforeEach(async () => {
  await db.execute(sql`TRUNCATE email_subscribers, email_broadcasts,
                                email_broadcast_recipients, email_broadcast_audience CASCADE`);
});

describe('createBroadcast records audienceKind', () => {
  it('defaults to all_subscribers when the caller says nothing about it', async () => {
    // The route this repo already serves does exactly this — no audience
    // field in its snapshot at all — and that has to keep meaning what it
    // always meant.
    const b = await createBroadcast(db, snapshot({}), actor, NOW);
    expect(b.audienceKind).toBe('all_subscribers');
    const row = await db.execute(sql`
      SELECT audience_kind FROM email_broadcasts WHERE id = ${b.id}::uuid`);
    expect(String(row.rows[0].audience_kind)).toBe('all_subscribers');
  });

  it('writes and reads back picked', async () => {
    const b = await createBroadcast(db, snapshot({ audienceKind: 'picked' }), actor, NOW);
    expect(b.audienceKind).toBe('picked');
  });
});

describe('setBroadcastAudience', () => {
  it('folds case and whitespace, and de-duplicates, the way normaliseEmail does', async () => {
    const b = await createBroadcast(db, snapshot({ audienceKind: 'picked' }), actor, NOW);
    const recorded = await setBroadcastAudience(db, b.id, [
      'A@Example.test',
      ' a@example.test ',
      'a@example.test',
    ]);
    expect(recorded).toBe(1);
    expect(await listBroadcastAudience(db, b.id)).toEqual(['a@example.test']);
  });

  it('drops blank addresses and records nothing for an all-blank list', async () => {
    const b = await createBroadcast(db, snapshot({ audienceKind: 'picked' }), actor, NOW);
    expect(await setBroadcastAudience(db, b.id, ['', '   '])).toBe(0);
    expect(await listBroadcastAudience(db, b.id)).toEqual([]);
  });

  it('a second call naming an address already on the list counts only the new one', async () => {
    const b = await createBroadcast(db, snapshot({ audienceKind: 'picked' }), actor, NOW);
    await setBroadcastAudience(db, b.id, ['a@example.test']);
    const second = await setBroadcastAudience(db, b.id, ['a@example.test', 'b@example.test']);
    expect(second).toBe(1);
    expect(await listBroadcastAudience(db, b.id)).toEqual(['a@example.test', 'b@example.test']);
  });
});

describe('enqueueAudience branches on audience_kind', () => {
  it('enrols a picked address that has never subscribed, with no consent date', async () => {
    const b = await createBroadcast(db, snapshot({ audienceKind: 'picked' }), actor, NOW);
    await setBroadcastAudience(db, b.id, ['new@example.test']);
    await enqueueAudience(db, b.id);

    const subs = await db.execute(sql`
      SELECT source, consent_at, token FROM email_subscribers
       WHERE email = 'new@example.test'`);
    expect(subs.rows).toHaveLength(1);
    expect(String(subs.rows[0].source)).toBe('customer');
    expect(subs.rows[0].consent_at).toBeNull();
    // The token is what makes the unsubscribe link exist. No token, no lawful send.
    expect(String(subs.rows[0].token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never resurrects somebody who unsubscribed', async () => {
    await addSubscriber(db, { email: 'gone@example.test', source: 'manual' }, NOW);
    const token = await tokenForEmail(db, 'gone@example.test');
    await unsubscribeByToken(db, token!, NOW);

    const b = await createBroadcast(db, snapshot({ audienceKind: 'picked' }), actor, NOW);
    await setBroadcastAudience(db, b.id, ['gone@example.test']);
    const enqueued = await enqueueAudience(db, b.id);

    expect(enqueued).toBe(0);
    const still = await db.execute(sql`
      SELECT unsubscribed_at FROM email_subscribers WHERE email = 'gone@example.test'`);
    expect(still.rows[0].unsubscribed_at).not.toBeNull();
  });

  it('an all_subscribers broadcast still enqueues everybody, unchanged', async () => {
    await addSubscriber(db, { email: 'a@example.test', source: 'manual' }, NOW);
    await addSubscriber(db, { email: 'b@example.test', source: 'manual' }, NOW);
    const b = await createBroadcast(db, snapshot({}), actor, NOW); // defaults
    expect(await enqueueAudience(db, b.id)).toBe(2);
  });

  it('keeps the picked list even for people it could not mail', async () => {
    // "Who did we pick" and "who did we reach" are different questions and the
    // difference is what an operator needs to see.
    const b = await createBroadcast(db, snapshot({ audienceKind: 'picked' }), actor, NOW);
    await setBroadcastAudience(db, b.id, ['gone@example.test']);
    await addSubscriber(db, { email: 'gone@example.test', source: 'manual' }, NOW);
    const token = await tokenForEmail(db, 'gone@example.test');
    await unsubscribeByToken(db, token!, NOW);
    await enqueueAudience(db, b.id);
    expect(await listBroadcastAudience(db, b.id)).toEqual(['gone@example.test']);
  });

  it('a picked broadcast reaches only the picked addresses, not every subscriber', async () => {
    // The property that actually distinguishes `picked` from `all_subscribers`:
    // an existing, perfectly mailable subscriber who was NOT named must not
    // receive a broadcast aimed at somebody else.
    await addSubscriber(db, { email: 'bystander@example.test', source: 'manual' }, NOW);
    const b = await createBroadcast(db, snapshot({ audienceKind: 'picked' }), actor, NOW);
    await setBroadcastAudience(db, b.id, ['new@example.test']);

    expect(await enqueueAudience(db, b.id)).toBe(1);
    const recipients = await db.execute(sql`
      SELECT s.email FROM email_broadcast_recipients r
      JOIN email_subscribers s ON s.id = r.subscriber_id
       WHERE r.broadcast_id = ${b.id}::uuid`);
    expect(recipients.rows.map((row) => String(row.email))).toEqual(['new@example.test']);
  });

  it('re-enqueuing the same picked broadcast adds nothing the second time', async () => {
    const b = await createBroadcast(db, snapshot({ audienceKind: 'picked' }), actor, NOW);
    await setBroadcastAudience(db, b.id, ['new@example.test']);
    expect(await enqueueAudience(db, b.id)).toBe(1);
    expect(await enqueueAudience(db, b.id)).toBe(0);
  });
});

describe('markRecipientSkipped', () => {
  it('marks the row skipped, records the reason, and does not count it as an attempt', async () => {
    await addSubscriber(db, { email: 'ada@example.test', source: 'manual' }, NOW);
    const b = await createBroadcast(db, snapshot({}), actor, NOW);
    await enqueueAudience(db, b.id);
    const before = await db.execute(sql`
      SELECT id FROM email_broadcast_recipients WHERE broadcast_id = ${b.id}::uuid`);
    const id = String(before.rows[0].id);

    await markRecipientSkipped(db, id, b.id, 'basket_empty');

    const row = await db.execute(sql`
      SELECT status, last_error, attempts FROM email_broadcast_recipients WHERE id = ${id}::uuid`);
    expect(String(row.rows[0].status)).toBe('skipped');
    expect(String(row.rows[0].last_error)).toBe('basket_empty');
    expect(Number(row.rows[0].attempts)).toBe(0);
  });

  it('does not touch a row that has already left pending', async () => {
    // Defensive: a terminal row must stay terminal — a skip landing on an
    // already-sent row would silently rewrite delivered history.
    await addSubscriber(db, { email: 'ada@example.test', source: 'manual' }, NOW);
    const b = await createBroadcast(db, snapshot({}), actor, NOW);
    await enqueueAudience(db, b.id);
    const before = await db.execute(sql`
      SELECT id FROM email_broadcast_recipients WHERE broadcast_id = ${b.id}::uuid`);
    const id = String(before.rows[0].id);
    await markRecipientSent(db, id, b.id, NOW);

    await markRecipientSkipped(db, id, b.id, 'basket_empty');

    const row = await db.execute(sql`
      SELECT status FROM email_broadcast_recipients WHERE id = ${id}::uuid`);
    expect(String(row.rows[0].status)).toBe('sent');
  });
});

/**
 * The drain, at the repository level — the two properties an HTTP test cannot
 * reach.
 *
 * **CONCURRENCY.** A cron and an owner pressing "continue" can drain the same
 * broadcast at the same instant. The claim is a CAS on `attempts`, so exactly one
 * of them sends to any given person; the route suite drives one caller at a time
 * and can never observe that.
 *
 * **THE CSV PARSER.** It is the only place in this feature where the input is a
 * file somebody else made, and the failure it exists to catch — a column shifted
 * one to the right by an unquoted comma — imports garbage silently rather than
 * failing.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedDb } from '../test/harness';
import {
  addSubscriber,
  createBroadcast,
  enqueueAudience,
  parseSubscriberCsv,
  recipientCounts,
  startBroadcast,
} from './repo';
import { drainAll, drainBroadcast, unsubscribeUrl } from './send';
import type { EmailBroadcast } from './repo';
import type { Db } from '../db/client';
import type { Mailer } from '../mail/port';

let db: Db;
let close: () => Promise<void>;

const NOW = 1786600000700;
const ORIGIN = 'https://studio.test';

const SNAPSHOT = {
  templateId: null,
  subject: 'Hello {{name}}',
  html: '<p>hi {{name}}</p><a href="{{unsubscribe_url}}">out</a>',
  text: 'hi {{name}}\n\n{{unsubscribe_url}}',
};

class Recorder implements Mailer {
  readonly sent: { to: string; subject: string; text: string; html: string }[] = [];
  send(message: { to: string; subject: string; text: string; html: string }): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

/** The seeded owner, so `created_by` satisfies its foreign key. */
let actor: string;

beforeAll(async () => {
  ({ db, close } = await migratedDb());
  const res = await db.execute(sql`
    INSERT INTO users (email, password_hash, display_name, role, created_at)
    VALUES ('sender@test.local', 'x', 'Sender', 'owner', ${NOW})
    RETURNING id`);
  actor = String(res.rows[0].id);
});
afterAll(() => close());

beforeEach(async () => {
  await db.execute(sql`TRUNCATE email_subscribers, email_broadcasts,
                                email_broadcast_recipients CASCADE`);
});

async function started(subscribers: string[]): Promise<EmailBroadcast> {
  for (const email of subscribers) {
    await addSubscriber(db, { email, source: 'manual' }, NOW);
  }
  const draft = await createBroadcast(db, SNAPSHOT, actor, NOW);
  const sending = await startBroadcast(db, draft.id, NOW);
  await enqueueAudience(db, draft.id);
  return sending!;
}

describe('two concurrent drains deliver once, because the claim is a CAS', () => {
  it('one sends and the other skips, without sending', async () => {
    /*
     * Both drains read `attempts = 0`; both try `SET attempts = 1 WHERE attempts = 0`;
     * one matches. The loser skips the row WITHOUT SENDING. That is the property a
     * `claimed_at` lease column is usually added for, obtained from a column that had
     * to exist anyway — the same construction `server/shop/orders/repo/emails.ts`
     * documents for the order outbox.
     */
    const broadcast = await started(['a@test.local']);
    const mailer = new Recorder();

    const [first, second] = await Promise.all([
      drainBroadcast(db, broadcast, mailer, ORIGIN, NOW),
      drainBroadcast(db, broadcast, mailer, ORIGIN, NOW),
    ]);

    expect(mailer.sent).toHaveLength(1);
    expect(first.sent + second.sent).toBe(1);
    expect(first.skipped + second.skipped).toBe(1);
    expect(await recipientCounts(db, broadcast.id)).toEqual({ pending: 0, sent: 1, failed: 0 });
  });
});

describe('one bad address does not stop the rest of the queue', () => {
  it('sends to everyone else and records the refusal on the one row', async () => {
    const broadcast = await started(['a@test.local', 'b@test.local', 'c@test.local']);
    let call = 0;
    const flaky: Mailer = {
      send: () => {
        call += 1;
        return call === 1 ? Promise.reject(new Error('nope')) : Promise.resolve();
      },
    };

    const summary = await drainBroadcast(db, broadcast, flaky, ORIGIN, NOW);
    expect(summary).toMatchObject({ sent: 2, retryable: 1, failed: 0 });
    expect(await recipientCounts(db, broadcast.id)).toEqual({ pending: 1, sent: 2, failed: 0 });
  });
});

describe('the batch bounds the work, not the queue', () => {
  it('drains in successive passes and closes the broadcast on the last one', async () => {
    const broadcast = await started(['a@test.local', 'b@test.local', 'c@test.local']);
    const mailer = new Recorder();

    for (let pass = 1; pass <= 3; pass += 1) {
      const summary = await drainBroadcast(db, broadcast, mailer, ORIGIN, NOW, 1);
      expect(summary.sent, `pass ${pass}`).toBe(1);
    }
    expect(mailer.sent).toHaveLength(3);

    const row = await db.execute(sql`
      SELECT status, sent_count, finished_at FROM email_broadcasts WHERE id = ${broadcast.id}::uuid`);
    expect(String(row.rows[0].status)).toBe('sent');
    expect(Number(row.rows[0].sent_count)).toBe(3);
    expect(row.rows[0].finished_at).not.toBeNull();
  });

  it('drainAll picks up every sending broadcast and reports how many it touched', async () => {
    const first = await started(['a@test.local']);
    // A second broadcast to the same audience — the dedupe is per (broadcast,
    // subscriber), so both owe this person a message.
    const draft = await createBroadcast(db, SNAPSHOT, actor, NOW + 1);
    const second = await startBroadcast(db, draft.id, NOW + 1);
    await enqueueAudience(db, draft.id);

    const mailer = new Recorder();
    const summary = await drainAll(db, mailer, ORIGIN, NOW);
    expect(summary).toMatchObject({ sent: 2, broadcasts: 2 });
    expect(await recipientCounts(db, first.id)).toMatchObject({ sent: 1 });
    expect(await recipientCounts(db, second!.id)).toMatchObject({ sent: 1 });
  });

  it('a second enqueue of the same audience adds nothing', async () => {
    // The dedupe index, exercised through the statement that relies on it: a
    // duplicated cron delivery — which Vercel documents as possible — must not be a
    // second copy of the message to everybody.
    const broadcast = await started(['a@test.local', 'b@test.local']);
    expect(await enqueueAudience(db, broadcast.id)).toBe(0);
    expect(await recipientCounts(db, broadcast.id)).toMatchObject({ pending: 2 });
  });
});

describe('the unsubscribe link', () => {
  it('is absolute and carries the token percent-encoded', () => {
    expect(unsubscribeUrl(ORIGIN, 'a b')).toBe(
      'https://studio.test/api/public/unsubscribe?token=a%20b',
    );
  });
});

describe('a broadcast nobody can be sent', () => {
  it('finishes immediately rather than sitting in `sending` forever', async () => {
    const broadcast = await started([]);
    const summary = await drainBroadcast(db, broadcast, new Recorder(), ORIGIN, NOW);
    expect(summary.sent).toBe(0);
    const row = await db.execute(sql`
      SELECT status FROM email_broadcasts WHERE id = ${broadcast.id}::uuid`);
    // Zero sent and zero failed is not a failure — there was nobody to send to.
    expect(String(row.rows[0].status)).toBe('sent');
  });
});

describe('startBroadcast is a CAS, not a read-then-write', () => {
  it('only one of two simultaneous starts wins', async () => {
    const draft = await createBroadcast(db, SNAPSHOT, actor, NOW);
    const [a, b] = await Promise.all([
      startBroadcast(db, draft.id, NOW),
      startBroadcast(db, draft.id, NOW + 5),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    // `started_at` therefore means the moment the send began, not the moment the
    // last duplicate request arrived.
    const row = await db.execute(sql`
      SELECT started_at FROM email_broadcasts WHERE id = ${draft.id}::uuid`);
    expect(Number(row.rows[0].started_at)).toBe(NOW);
  });

  it('returns null for a broadcast that is not a draft, and for one that is gone', async () => {
    const draft = await createBroadcast(db, SNAPSHOT, actor, NOW);
    expect(await startBroadcast(db, draft.id, NOW)).not.toBeNull();
    expect(await startBroadcast(db, draft.id, NOW)).toBeNull();
    expect(await startBroadcast(db, randomUUID(), NOW)).toBeNull();
  });
});

describe('parseSubscriberCsv', () => {
  it('locates columns by header name, in either order', () => {
    expect(parseSubscriberCsv('name,email\nAda,ada@test.local\n')).toEqual([
      { email: 'ada@test.local', name: 'Ada', line: 2 },
    ]);
    expect(parseSubscriberCsv('email,name\nada@test.local,Ada\n')).toEqual([
      { email: 'ada@test.local', name: 'Ada', line: 2 },
    ]);
  });

  it('treats a headerless file as email-first — the commonest paste', () => {
    // Requiring a header would reject one address per line; assuming one would
    // silently drop the first subscriber.
    expect(parseSubscriberCsv('ada@test.local\nbob@test.local\n')).toEqual([
      { email: 'ada@test.local', name: null, line: 1 },
      { email: 'bob@test.local', name: null, line: 2 },
    ]);
  });

  it('KEEPS A QUOTED COMMA IN ONE FIELD', () => {
    /*
     * The failure this parser exists for. `split(',')` shifts every field one to
     * the right on this input, so the email column holds `John` and the import
     * succeeds with garbage in it — which is exactly what nobody notices.
     */
    expect(parseSubscriberCsv('name,email\n"Smith, John",js@test.local\n')).toEqual([
      { email: 'js@test.local', name: 'Smith, John', line: 2 },
    ]);
  });

  it('unescapes a doubled quote, which is how RFC 4180 spells one', () => {
    expect(parseSubscriberCsv('name,email\n"Ada ""The Countess""",ada@test.local\n')[0].name).toBe(
      'Ada "The Countess"',
    );
  });

  it('survives CRLF and a trailing newline without inventing a blank subscriber', () => {
    // A trailing newline is universal, and an import that failed on one would fail
    // on almost every file a spreadsheet produces.
    expect(parseSubscriberCsv('email\r\nada@test.local\r\n\r\n')).toEqual([
      { email: 'ada@test.local', name: null, line: 2 },
    ]);
  });

  it('numbers lines from 1 INCLUDING the header, so a 400 names what the operator sees', () => {
    const rows = parseSubscriberCsv('email\na@test.local\nb@test.local\n');
    expect(rows.map((r) => r.line)).toEqual([2, 3]);
  });
});

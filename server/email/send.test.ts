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
import { basketUrl, storefrontOrigin } from '../shop/storefront-url';
import { assetOrigin } from '../mail/brand';
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
  /*
   * The basket half of this suite writes real carts. DELETE and not TRUNCATE,
   * for the reason `server/shop/admin/prospects.test.ts` gives: TRUNCATE refuses
   * a table another one references unless every referencing table is named in
   * the same statement. Carts go first so their lines go with them, freeing the
   * variants the products then take with them.
   */
  await db.execute(sql`DELETE FROM shop_carts`);
  await db.execute(sql`DELETE FROM shop_products`);
});

async function started(
  subscribers: string[],
  snapshot: typeof SNAPSHOT = SNAPSHOT,
): Promise<EmailBroadcast> {
  for (const email of subscribers) {
    await addSubscriber(db, { email, source: 'manual' }, NOW);
  }
  const draft = await createBroadcast(db, snapshot, actor, NOW);
  const sending = await startBroadcast(db, draft.id, NOW);
  await enqueueAudience(db, draft.id);
  return sending!;
}

/** The default snapshot with a body of the caller's choosing, in BOTH parts —
 *  the drain decides whether to resolve a basket by reading each of them. */
function bodied(body: string): typeof SNAPSHOT {
  return { ...SNAPSHOT, html: body, text: body };
}

let baskets = 0;

/**
 * A live cart with lines, addressed to `email` — the shape `basketFor` reads.
 *
 * A PRODUCT, A VARIANT AND A CURRENT PRICE PER LINE, because that is where a
 * basket's money actually comes from: `shop_cart_lines` deliberately stores no
 * price, so a fixture that skipped `shop_prices` would quote every line at zero
 * and the total assertions below would pass against nothing.
 */
async function giveBasket(
  email: string,
  lines: { title: string; qty: number; unitMinor: number; imageId?: string }[],
): Promise<void> {
  baskets += 1;
  const cartId = `cart_${baskets}`;
  await db.execute(sql`
    INSERT INTO shop_carts (id, customer_id, currency, status, email,
                            created_at, updated_at, expires_at, revision)
    VALUES (${cartId}, NULL, 'NGN', 'open', ${email}, ${NOW}, ${NOW}, ${NOW + 86_400_000}, 1)`);

  for (const [index, line] of lines.entries()) {
    const tag = `${baskets}_${index}`;
    await db.execute(sql`
      INSERT INTO shop_products (id, slug, title, description, description_text,
                                 status, category, cover_image_id,
                                 created_at, updated_at, author_id, revision)
      VALUES (${`prd_${tag}`}, ${`prd-${tag}`}, ${line.title},
              ${'{"type":"doc","content":[]}'}::jsonb, ${''},
              'active', 'test', NULL, ${NOW}, ${NOW}, ${actor}::uuid, 1)`);
    await db.execute(sql`
      INSERT INTO shop_variants (id, product_id, sku, option_values, position,
                                 status, image_id, created_at, updated_at)
      VALUES (${`var_${tag}`}, ${`prd_${tag}`}, ${`SKU-${tag}`}, ${'{"Colour":"Red"}'}::jsonb,
              0, 'active', ${line.imageId ?? null}, ${NOW}, ${NOW})`);
    /* `effective_to` left NULL: that is what "current" means, and the partial
       unique index `shop_prices_current_uq` is what makes it at most one. */
    await db.execute(sql`
      INSERT INTO shop_prices (id, variant_id, amount, currency, effective_from, created_at)
      VALUES (${`prc_${tag}`}, ${`var_${tag}`}, ${line.unitMinor}, 'NGN', ${NOW}, ${NOW})`);
    await db.execute(sql`
      INSERT INTO shop_cart_lines (id, cart_id, variant_id, qty, added_at)
      VALUES (${`ln_${tag}`}, ${cartId}, ${`var_${tag}`}, ${line.qty}, ${NOW})`);
  }
}

/** The one recipient row of a one-person broadcast. */
async function recipientRow(
  broadcastId: string,
): Promise<{ status: string; last_error: string | null; attempts: number }> {
  const res = await db.execute(sql`
    SELECT status, last_error, attempts FROM email_broadcast_recipients
     WHERE broadcast_id = ${broadcastId}::uuid`);
  const row = res.rows[0];
  return {
    status: String(row.status),
    last_error: row.last_error == null ? null : String(row.last_error),
    attempts: Number(row.attempts),
  };
}

/** Opt out AFTER the audience was enqueued — the mid-drain sequence. */
async function unsubscribeNow(email: string): Promise<void> {
  await db.execute(sql`
    UPDATE email_subscribers SET unsubscribed_at = ${NOW} WHERE email = ${email}`);
}

/**
 * The static text of a drizzle statement: its `sql` chunks, with the bound
 * parameters left out. Enough to tell one statement from another.
 */
function statementText(query: unknown): string {
  const node = query as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(node?.value)) return node.value.join('');
  if (!Array.isArray(node?.queryChunks)) return '';
  return node.queryChunks.map(statementText).join(' ');
}

/**
 * A `Db` whose BASKET READ fails and whose every other statement works.
 *
 * FAULT-INJECTED AT THE HANDLE RATHER THAN BY MOCKING THE MODULE, so the drain
 * runs the real `basketFor` against a database that refuses it — which is the
 * shape of the production failure (a dropped connection, a statement timeout,
 * a NUL in an address) rather than an invented one. The same proxy construction
 * `guardDb` uses, and for the same reason: `db` is a class instance whose
 * methods have to keep their own `this`.
 */
function dbThatCannotReadBaskets(): Db {
  return new Proxy(db, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop !== 'execute' || typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      return (query: unknown, ...rest: unknown[]) =>
        statementText(query).includes('shop_cart_lines')
          ? Promise.reject(new Error('connection terminated unexpectedly'))
          : method.apply(target, [query, ...rest]);
    },
  }) as Db;
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
    expect(await recipientCounts(db, broadcast.id)).toEqual({ pending: 0, sent: 1, failed: 0, skipped: 0 });
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
    expect(await recipientCounts(db, broadcast.id)).toEqual({ pending: 1, sent: 2, failed: 0, skipped: 0 });
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BASKET IS RESOLVED AT THE MOMENT OF SENDING, AND AN EMPTY ONE IS NOT
 * MAILED.
 *
 * The window between the pick and the batch that reaches it is minutes wide on
 * a real send, and "you left these behind" to somebody who has just paid is the
 * single most likely embarrassment in this whole feature. Every case here
 * asserts on THE MAILER as well as on the row: a test that only read the status
 * would pass against a drain that sent the message and then relabelled it.
 * ═══════════════════════════════════════════════════════════════════════════
 */
describe('a nudge whose basket emptied before the batch reached it', () => {
  it('is not mailed, and is recorded as skipped rather than failed', async () => {
    const broadcast = await started(['ada@test.local'], bodied('{{basket}} {{unsubscribe_url}}'));
    const mailer = new Recorder();
    // No cart at all for Ada: she bought, or emptied it, after she was picked.

    const summary = await drainBroadcast(db, broadcast, mailer, ORIGIN, NOW);

    expect(mailer.sent).toHaveLength(0);
    expect(summary.emptyBasket).toBe(1);
    expect(summary.sent).toBe(0);
    // NOT `failed`, and NOT `suppressed`: nothing went wrong and nobody opted out.
    expect(summary.failed).toBe(0);
    expect(summary.suppressed).toBe(0);

    const row = await recipientRow(broadcast.id);
    expect(row.status).toBe('skipped');
    expect(row.last_error).toBe('basket_empty');
    /*
     * ONE ATTEMPT, AND THAT IS CORRECT. The claim is a CAS that moves `attempts`
     * before the drain can know anything about the basket — it has to be, or the
     * row would sit pending for every future drain to decide about again.
     */
    expect(row.attempts).toBe(1);
  });

  it('still counts in the queue, so the buckets add up to the audience', async () => {
    // The reason `recipientCounts` grew a fourth bucket: without it this person
    // is simply missing from a detail view that is meant to account for everyone.
    const broadcast = await started(['ada@test.local'], bodied('{{basket}} {{unsubscribe_url}}'));
    await drainBroadcast(db, broadcast, new Recorder(), ORIGIN, NOW);

    expect(await recipientCounts(db, broadcast.id)).toEqual({
      pending: 0,
      sent: 0,
      failed: 0,
      skipped: 1,
    });
  });

  it('does not stop the batch: everyone else in it is still sent to', async () => {
    const broadcast = await started(
      ['ada@test.local', 'bob@test.local'],
      bodied('{{basket}} {{unsubscribe_url}}'),
    );
    await giveBasket('bob@test.local', [{ title: 'PLA Basic', qty: 1, unitMinor: 250_000 }]);
    const mailer = new Recorder();

    const summary = await drainBroadcast(db, broadcast, mailer, ORIGIN, NOW);

    expect(mailer.sent.map((m) => m.to)).toEqual(['bob@test.local']);
    expect(summary).toMatchObject({ sent: 1, emptyBasket: 1, failed: 0 });
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HOLE FIX ROUND 1 CLOSES: `usesBasket` MATCHES ONLY THE `{{basket}}`
 * BLOCK. A template that mentions `{{basket_total}}` or `{{basket_url}}` and
 * never the block itself used to compute `needsBasket = false` in
 * `drainBroadcast` — so nobody's basket was ever looked up, the reader saw
 * literal `{{basket_total}}` braces, and — the exact failure this whole
 * feature exists to prevent — NOBODY WAS EVER SKIPPED, so a person who had
 * already paid could still receive a message saying their basket was
 * waiting. `drainBroadcast` now asks the wider `needsBasket` predicate
 * (`shared/email/variables.ts`), which is true for any of the three basket
 * names. Both cases here use a body with `{{basket_total}}` and no
 * `{{basket}}` at all, on purpose.
 * ═══════════════════════════════════════════════════════════════════════════
 */
describe('a template that mentions the basket total or link, but never the block', () => {
  it('skips a recipient whose basket has emptied, even with no {{basket}} in the body', async () => {
    const broadcast = await started(
      ['ada@test.local'],
      bodied('Your basket is worth {{basket_total}} — see it here: {{unsubscribe_url}}'),
    );
    const mailer = new Recorder();
    // No cart at all for Ada: she bought, or emptied it, after she was picked.

    const summary = await drainBroadcast(db, broadcast, mailer, ORIGIN, NOW);

    expect(mailer.sent).toHaveLength(0);
    expect(summary.emptyBasket).toBe(1);
    expect(summary.sent).toBe(0);
    const row = await recipientRow(broadcast.id);
    expect(row.status).toBe('skipped');
    expect(row.last_error).toBe('basket_empty');
  });

  it('substitutes the real total for a recipient who does have a basket', async () => {
    await giveBasket('ada@test.local', [{ title: 'PLA Basic', qty: 2, unitMinor: 250_000 }]);
    const broadcast = await started(
      ['ada@test.local'],
      bodied('Your basket is worth {{basket_total}} — see it here: {{unsubscribe_url}}'),
    );
    const mailer = new Recorder();

    const summary = await drainBroadcast(db, broadcast, mailer, ORIGIN, NOW);

    expect(summary.sent).toBe(1);
    expect(summary.emptyBasket).toBe(0);
    const [message] = mailer.sent;
    // The real total, in both parts — not the block (the body never asked for
    // it), just the bare scalar `basketTotal` produces.
    expect(message.html).toContain('5000.00 NGN');
    expect(message.text).toContain('5000.00 NGN');
    expect(message.html).not.toContain('{{basket_total}}');
    expect(message.text).not.toContain('{{basket_total}}');
  });
});

describe('a broadcast that asks for no basket asks the database for none', () => {
  it('sends to somebody with no basket at all', async () => {
    const broadcast = await started(['ada@test.local'], bodied('Hello {{name}} {{unsubscribe_url}}'));
    const mailer = new Recorder();

    const summary = await drainBroadcast(db, broadcast, mailer, ORIGIN, NOW);

    expect(summary.sent).toBe(1);
    expect(summary.emptyBasket).toBe(0);
    expect(mailer.sent).toHaveLength(1);
  });

  it('sends even when the basket read itself is broken, because it never runs', async () => {
    /*
     * The cost half of `needsBasket`, asserted rather than described: an ordinary
     * newsletter must not pay a per-recipient basket query for a placeholder it
     * does not contain. A handle that fails every basket read is how that becomes
     * observable — if the drain looked one up anyway, this send would fail.
     */
    const broadcast = await started(['ada@test.local'], bodied('Hi {{name}} {{unsubscribe_url}}'));
    const mailer = new Recorder();

    const summary = await drainBroadcast(dbThatCannotReadBaskets(), broadcast, mailer, ORIGIN, NOW);

    expect(summary).toMatchObject({ sent: 1, emptyBasket: 0, retryable: 0 });
    expect(mailer.sent).toHaveLength(1);
  });
});

describe('the message carries the reader’s own basket', () => {
  it('puts the lines, the total and the basket link in both parts', async () => {
    await giveBasket('ada@test.local', [{ title: 'PLA Basic', qty: 2, unitMinor: 250_000 }]);
    const broadcast = await started(
      ['ada@test.local'],
      bodied('{{basket}} {{basket_total}} {{basket_url}} {{unsubscribe_url}}'),
    );
    const mailer = new Recorder();

    await drainBroadcast(db, broadcast, mailer, ORIGIN, NOW);

    const [message] = mailer.sent;
    expect(message.html).toContain('PLA Basic');
    /*
     * `5000.00 NGN`, NOT `₦5,000`. `basketBlock` prints money with the order
     * mailer's `formatAmount`, which is what every receipt this shop has ever
     * sent says — CLAUDE.md §7's naira symbol is an ADMIN SCREEN rule. A shopper
     * who gets this nudge and then a receipt for the same basket must see one
     * money format, not two.
     */
    expect(message.html).toContain('5000.00 NGN');
    // The block went in as MARKUP, unescaped — the one raw insertion in the renderer.
    expect(message.html).toContain('<table');
    expect(message.html).not.toContain('&lt;table');

    // `2 × PLA Basic`, with U+00D7 — the character every order email already uses.
    expect(message.text).toContain('2 × PLA Basic');
    expect(message.text).toContain('Basket total: 5000.00 NGN');
    expect(message.text).not.toContain('<table');

    // `{{basket_url}}` is the STOREFRONT's basket page, not this deployment's.
    expect(message.text).toContain(basketUrl());
    expect(message.text).not.toContain('{{basket');
  });

  it('serves the photographs from THIS deployment, not from the storefront', async () => {
    /*
     * `/api/public/images/…` is served by the admin and by nothing else — the
     * storefront is a separate Worker that carries no such route. Passing the
     * storefront's origin here type-checks perfectly and 404s every photograph in
     * every nudge, silently, in a delivered message no test renders. So the
     * source of the image URL is asserted directly.
     */
    await giveBasket('ada@test.local', [
      { title: 'PLA Basic', qty: 1, unitMinor: 250_000, imageId: 'img_1' },
    ]);
    const broadcast = await started(['ada@test.local'], bodied('{{basket}} {{unsubscribe_url}}'));
    const mailer = new Recorder();

    await drainBroadcast(db, broadcast, mailer, ORIGIN, NOW);

    const src = /<img[^>]*src="([^"]+)"/.exec(mailer.sent[0].html)?.[1] ?? '';
    expect(src).toBe(`${assetOrigin()}/api/public/images/img_1`);
    expect(src.startsWith(storefrontOrigin())).toBe(false);
    // Nor the origin the unsubscribe link is built from, which is a request-scoped
    // value the caller passes and the images have nothing to do with.
    expect(src.startsWith(ORIGIN)).toBe(false);
  });
});

describe('the basket check sits after the claim and after suppression', () => {
  it('a person who unsubscribes mid-drain is still passed over, and not as an empty basket', async () => {
    // Unchanged behaviour, asserted again because the claim loop moved — and
    // because reporting an opt-out as `emptyBasket` would hide the one of the two
    // an operator has to act on.
    const broadcast = await started(['gone@test.local'], bodied('{{basket}} {{unsubscribe_url}}'));
    await unsubscribeNow('gone@test.local');
    const mailer = new Recorder();

    const summary = await drainBroadcast(db, broadcast, mailer, ORIGIN, NOW);

    expect(mailer.sent).toHaveLength(0);
    expect(summary.suppressed).toBe(1);
    expect(summary.emptyBasket).toBe(0);
    expect((await recipientRow(broadcast.id)).status).toBe('failed');
  });

  it('a basket the database refuses is retried — not skipped, and never sent', async () => {
    /*
     * `basketFor` is a database call inside a loop whose contract is that nothing
     * throws. Both other answers are worse than a retry: `skipped` would claim
     * "they have already bought" on evidence nobody has, and sending anyway would
     * deliver the literal text `{{basket}}` to a reader.
     */
    const broadcast = await started(['ada@test.local'], bodied('{{basket}} {{unsubscribe_url}}'));
    await giveBasket('ada@test.local', [{ title: 'PLA Basic', qty: 1, unitMinor: 250_000 }]);
    const mailer = new Recorder();

    const summary = await drainBroadcast(
      dbThatCannotReadBaskets(),
      broadcast,
      mailer,
      ORIGIN,
      NOW,
    );

    expect(mailer.sent).toHaveLength(0);
    expect(summary).toMatchObject({ sent: 0, emptyBasket: 0, retryable: 1, failed: 0 });

    const row = await recipientRow(broadcast.id);
    expect(row.status).toBe('pending');
    expect(row.last_error).toBe('connection terminated unexpectedly');

    // And the retry delivers, because the row was left claimable.
    expect((await drainBroadcast(db, broadcast, mailer, ORIGIN, NOW)).sent).toBe(1);
  });
});

describe('drainAll adds the basket counter up across broadcasts', () => {
  it('reports both skips, rather than one or none', async () => {
    // `add()` names every field by hand, so a counter added to the summary and not
    // to that list reports zero the moment two broadcasts are drained together —
    // which is exactly the shape the cron runs in.
    const body = bodied('{{basket}} {{unsubscribe_url}}');
    await started(['ada@test.local'], body);
    // A second broadcast to the same one person, built the way the existing
    // `drainAll` case builds its own: adding a subscriber here would enqueue them
    // onto BOTH sends and make the arithmetic below say something else.
    const draft = await createBroadcast(db, body, actor, NOW + 1);
    await startBroadcast(db, draft.id, NOW + 1);
    await enqueueAudience(db, draft.id);
    const mailer = new Recorder();

    const summary = await drainAll(db, mailer, ORIGIN, NOW);

    expect(mailer.sent).toHaveLength(0);
    expect(summary).toMatchObject({ broadcasts: 2, emptyBasket: 2, sent: 0 });
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

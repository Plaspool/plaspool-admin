/**
 * The email-marketing surface, driven through the REAL app (HANDOFF §2 A6).
 *
 * WHAT THIS SUITE IS ACTUALLY FOR. Three of the properties below cannot be
 * observed from a repository test and are the ones that hurt if they are wrong:
 *
 * - **The unsubscribe POST works with no session and no `Origin` header.** It is
 *   mounted above `originGuard` for exactly that reason, and the only way to prove
 *   the mount is right is to send the request the guard would refuse — which is
 *   why several tests below go through `client.app.request` rather than the helper,
 *   since `server/test/http.ts` adds an `Origin` to every unsafe method by design.
 * - **A broadcast reaches a real transport.** The mailer is injected and the suite
 *   supplies a recorder, because a route that delivers to an address cannot be
 *   tested by having it hand the message back (`server/mail/port.ts`).
 * - **Suppression is late.** Somebody who unsubscribes while a broadcast is
 *   draining is not mailed by the batch that had not reached them yet.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../test/harness';
import { httpClient, json } from '../test/http';
import { MailNotConfiguredError } from '../mail/port';
import type { TestCtx } from '../test/harness';
import type { HttpClient } from '../test/http';
import type { Mailer } from '../mail/port';
import type { AuthUser } from '../../shared/types';

interface SentMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * A transport that records instead of sending, and can be made to fail.
 *
 * `assertConfigured` is implemented because the routes call it before doing any
 * work — a deployment with no key must answer 501 once rather than write five
 * thousand recipient rows that each fail eight times with the same message.
 */
class Recorder implements Mailer {
  readonly sent: SentMessage[] = [];
  configured = true;
  refuseWith: string | null = null;

  assertConfigured(): void {
    if (!this.configured) throw new MailNotConfiguredError(['RESEND_API_KEY']);
  }

  send(message: SentMessage): Promise<void> {
    if (this.refuseWith !== null) return Promise.reject(new Error(this.refuseWith));
    this.sent.push(message);
    return Promise.resolve();
  }
}

let ctx: TestCtx;
let mailer: Recorder;
let owner: HttpClient;

const TEMPLATE = {
  name: 'Spring news',
  subject: 'What we have been up to, {{name}}',
  html: '<p>Hello {{name}}</p><p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>',
  text: 'Hello {{name}}\n\nUnsubscribe: {{unsubscribe_url}}',
};

async function login(user: AuthUser): Promise<HttpClient> {
  const client = httpClient(ctx.db, { mailer });
  await client.signIn(user);
  return client;
}

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(() => ctx.close());

beforeEach(async () => {
  await ctx.db.execute(sql`TRUNCATE email_templates, email_subscribers, email_broadcasts,
                                    email_broadcast_recipients CASCADE`);
  await ctx.db.execute(sql`DELETE FROM auth_attempts`);
  await ctx.db.execute(sql`DELETE FROM sessions`);
  mailer = new Recorder();
  owner = await login(ctx.users.owner);
});

// ------------------------------------------------------------------- helpers

async function createTemplate(overrides: Partial<typeof TEMPLATE> = {}) {
  const res = await owner.post('/api/admin/email/templates', { ...TEMPLATE, ...overrides });
  expect(res.status).toBe(201);
  return (await json<{ template: { id: string } }>(res)).template;
}

async function addSubscriber(email: string, name?: string) {
  const res = await owner.post('/api/admin/email/subscribers', { email, name: name ?? null });
  expect(res.status).toBe(201);
  return (await json<{ subscriber: { id: string; email: string } }>(res)).subscriber;
}

async function createBroadcast(templateId: string) {
  const res = await owner.post('/api/admin/email/broadcasts', { templateId });
  expect(res.status).toBe(201);
  return (await json<{ broadcast: { id: string } }>(res)).broadcast;
}

interface Drained {
  sent: number;
  failed: number;
  suppressed: number;
  skipped: number;
  emptyBasket: number;
  retryable: number;
}

interface BroadcastRow {
  id: string;
  status: string;
  sentCount: number;
  failedCount: number;
  recipientCount: number;
  finishedAt: number | null;
  html: string;
  text: string;
}

/** The subscriber's raw unsubscribe token, which no route ever returns. */
async function tokenOf(email: string): Promise<string> {
  const res = await ctx.db.execute(sql`
    SELECT token FROM email_subscribers WHERE email = ${email}`);
  return String(res.rows[0].token);
}

// --------------------------------------------------------------------- guards

describe('the whole admin surface is owner-only', () => {
  it('403s a writer and 401s an anonymous caller on every route', async () => {
    const writer = await login(ctx.users.writer);
    const anon = httpClient(ctx.db, { mailer });

    const probes: [string, () => Promise<Response>, () => Promise<Response>][] = [
      [
        'GET /templates',
        () => writer.get('/api/admin/email/templates'),
        () => anon.get('/api/admin/email/templates'),
      ],
      [
        'POST /templates',
        () => writer.post('/api/admin/email/templates', TEMPLATE),
        () => anon.post('/api/admin/email/templates', TEMPLATE),
      ],
      [
        'GET /subscribers',
        () => writer.get('/api/admin/email/subscribers'),
        () => anon.get('/api/admin/email/subscribers'),
      ],
      [
        'POST /subscribers',
        () => writer.post('/api/admin/email/subscribers', { email: 'x@test.local' }),
        () => anon.post('/api/admin/email/subscribers', { email: 'x@test.local' }),
      ],
      [
        'GET /broadcasts',
        () => writer.get('/api/admin/email/broadcasts'),
        () => anon.get('/api/admin/email/broadcasts'),
      ],
      [
        'POST /drain',
        () => writer.post('/api/admin/email/drain'),
        () => anon.post('/api/admin/email/drain'),
      ],
    ];

    for (const [label, asWriter, asAnon] of probes) {
      expect((await asWriter()).status, `writer ${label}`).toBe(403);
      expect((await asAnon()).status, `anon ${label}`).toBe(401);
    }
  });
});

// ------------------------------------------------------------------ templates

describe('templates', () => {
  it('creates, reads, patches partially and deletes', async () => {
    const created = await createTemplate();

    /*
     * THE LIST ALSO CARRIES THE NINE SEEDED SYSTEM TEMPLATES (migration 0320) —
     * `GET /templates` calls `ensureSystemTemplates` before reading, so the first
     * request to this screen is what creates them.
     *
     * Asserted as "the operator's own template is in there, and the defaults are
     * too" rather than as an exact list, because the exact list is
     * `SYSTEM_KEYS.length + 1` and pinning that number here would make adding a
     * tenth system message fail a test about CRUD.
     */
    const list = await json<{ items: { id: string; systemKey: string | null }[] }>(
      await owner.get('/api/admin/email/templates'),
    );
    expect(list.items.map((t) => t.id)).toContain(created.id);
    expect(list.items.find((t) => t.id === created.id)?.systemKey).toBeNull();
    expect(list.items.filter((t) => t.systemKey !== null).length).toBeGreaterThan(0);
    /* System templates sort first, so the defaults are what an owner sees. */
    expect(list.items[0].systemKey).not.toBeNull();

    /*
     * A PARTIAL PATCH, which is the whole reason `PATCH` is not a full replace
     * here: the composer saves the HTML pane and the text pane independently, and
     * a full replace would let one editor's stale copy of the text part overwrite
     * another's.
     */
    const patched = await json<{ template: { subject: string; text: string } }>(
      await owner.patch(`/api/admin/email/templates/${created.id}`, { subject: 'New subject' }),
    );
    expect(patched.template.subject).toBe('New subject');
    expect(patched.template.text).toBe(TEMPLATE.text);

    expect((await owner.del(`/api/admin/email/templates/${created.id}`)).status).toBe(200);
    expect((await owner.get(`/api/admin/email/templates/${created.id}`)).status).toBe(404);
  });

  it('409s a duplicate name in ANY casing, carrying the row that already has it', async () => {
    const first = await createTemplate();
    const res = await owner.post('/api/admin/email/templates', {
      ...TEMPLATE,
      name: 'spring NEWS',
    });
    expect(res.status).toBe(409);
    const body = await json<{ error: string; operation: string; template: { id: string } }>(res);
    expect(body.error).toBe('precondition_failed');
    expect(body.operation).toBe('create');
    // The payload is not decoration: the picker selects the existing row rather
    // than making the owner go and find it.
    expect(body.template.id).toBe(first.id);
  });

  it('400s a variable this server cannot substitute, naming the FIELD', async () => {
    /*
     * The rule that points the opposite way from the unsubscribe gate below, and
     * the reason is asymmetric: an unknown placeholder is a literal `{{firstname}}`
     * mailed to the whole list the moment somebody presses send, with no second
     * chance to notice. It is refused at SAVE time.
     */
    const res = await owner.post('/api/admin/email/templates', {
      ...TEMPLATE,
      html: '<p>Hi {{firstname}}</p>{{unsubscribe_url}}',
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'html' });
  });

  it('SAVES a template with no unsubscribe variable — the asymmetry is deliberate', async () => {
    // Saving is allowed because a template is written over several sittings and a
    // draft that cannot be stored is a composer that cannot be used. Sending is
    // refused; that half is asserted under "broadcasts" below.
    const res = await owner.post('/api/admin/email/templates', {
      ...TEMPLATE,
      html: '<p>Hello {{name}}</p>',
      text: 'Hello {{name}}',
    });
    expect(res.status).toBe(201);
  });

  it('400s a blank name and an unknown key', async () => {
    expect(
      (await owner.post('/api/admin/email/templates', { ...TEMPLATE, name: '   ' })).status,
    ).toBe(400);
    expect(
      (await owner.post('/api/admin/email/templates', { ...TEMPLATE, colour: 'red' })).status,
    ).toBe(400);
  });

  it('400s an id that is not a uuid rather than 500ing on 22P02', async () => {
    const res = await owner.get('/api/admin/email/templates/not-a-uuid');
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'id' });
  });
});

// ---------------------------------------------------------------- subscribers

describe('subscribers', () => {
  it('adds one, and adding the same address again NEVER resurrects an opt-out', async () => {
    /*
     * The property with legal weight as well as reputational weight. If re-adding
     * cleared the opt-out then one owner pasting last year's list would
     * re-subscribe everybody who had asked to stop, silently.
     */
    const added = await addSubscriber('reader@test.local', 'Reader');
    await ctx.db.execute(sql`
      UPDATE email_subscribers SET unsubscribed_at = 1 WHERE id = ${added.id}::uuid`);

    const again = await owner.post('/api/admin/email/subscribers', {
      email: 'Reader@Test.local',
    });
    expect(again.status).toBe(200);
    const body = await json<{ created: boolean; subscriber: { unsubscribedAt: number | null } }>(
      again,
    );
    expect(body.created).toBe(false);
    expect(body.subscriber.unsubscribedAt).toBe(1);
  });

  it('normalises the address, so one person cannot become two subscribers', async () => {
    await addSubscriber('Reader@Test.local');
    const res = await owner.get('/api/admin/email/subscribers?filter=all');
    const body = await json<{ items: { email: string }[] }>(res);
    expect(body.items.map((s) => s.email)).toEqual(['reader@test.local']);
  });

  it('never returns the unsubscribe token', async () => {
    // It is a working "remove this person" credential for the whole audience; a
    // list response carrying it would put one in every browser cache and every log
    // of a 200 body.
    await addSubscriber('reader@test.local');
    const body = await owner.get('/api/admin/email/subscribers').then((r) => r.text());
    expect(body).not.toContain('token');
  });

  it('filters by suppression and pages by keyset', async () => {
    for (const n of [1, 2, 3]) await addSubscriber(`r${n}@test.local`);
    await ctx.db.execute(sql`
      UPDATE email_subscribers SET unsubscribed_at = 1 WHERE email = 'r2@test.local'`);

    const subscribed = await json<{ items: { email: string }[]; counts: unknown }>(
      await owner.get('/api/admin/email/subscribers?filter=subscribed'),
    );
    expect(subscribed.items.map((s) => s.email).sort()).toEqual([
      'r1@test.local',
      'r3@test.local',
    ]);
    expect(subscribed.counts).toEqual({ subscribed: 2, suppressed: 1 });
    // The same two numbers on their own route, because the confirm dialog before a
    // broadcast must state the REAL recipient count and a keyset page cannot
    // produce one — `items.length` is the page size.
    expect(await json(await owner.get('/api/admin/email/audience'))).toEqual({
      subscribed: 2,
      suppressed: 1,
    });

    const unsubscribed = await json<{ items: { email: string }[] }>(
      await owner.get('/api/admin/email/subscribers?filter=unsubscribed'),
    );
    expect(unsubscribed.items.map((s) => s.email)).toEqual(['r2@test.local']);

    // One row per page, walked to the end. The cursor is opaque and is spent
    // against the ordering that minted it.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 4 && (i === 0 || cursor); i += 1) {
      const url = `/api/admin/email/subscribers?filter=all&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page: { items: { email: string }[]; nextCursor: string | null } = await json(
        await owner.get(url),
      );
      seen.push(...page.items.map((s) => s.email));
      cursor = page.nextCursor;
    }
    expect(seen.sort()).toEqual(['r1@test.local', 'r2@test.local', 'r3@test.local']);
    expect(cursor).toBeNull();
  });

  it('400s a cursor minted for another sort rather than 500ing', async () => {
    const foreign = Buffer.from(JSON.stringify(['updated', [1], 'p_1']), 'utf8').toString(
      'base64url',
    );
    const res = await owner.get(`/api/admin/email/subscribers?cursor=${foreign}`);
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'cursor' });
  });

  it('400s an unknown query parameter', async () => {
    // Strict, like every other query schema here: `?fitler=unsubscribed` would
    // otherwise list the whole audience while the screen said "unsubscribed only".
    expect((await owner.get('/api/admin/email/subscribers?fitler=all')).status).toBe(400);
  });
});

describe('CSV import', () => {
  const post = (csv: string) => owner.post('/api/admin/email/subscribers/import', { csv });

  it('imports a header-ful file and reports what was already there', async () => {
    const first = await json<{ added: number; skipped: number; total: number }>(
      await post('email,name\na@test.local,Ada\nb@test.local,Bo\n'),
    );
    expect(first).toEqual({ added: 2, skipped: 0, total: 2 });

    const second = await json<{ added: number; skipped: number }>(
      await post('email,name\na@test.local,Ada\nc@test.local,Cy\n'),
    );
    expect(second).toEqual(expect.objectContaining({ added: 1, skipped: 1 }));
  });

  it('takes a headerless file — one address per line is the commonest paste', async () => {
    const body = await json<{ added: number }>(await post('a@test.local\nb@test.local\n'));
    expect(body.added).toBe(2);
  });

  it('takes an already-parsed list, held to exactly the same rules', async () => {
    /*
     * The composer parses and PREVIEWS the file so the writer sees which rows would
     * be refused, then posts the addresses it showed them. Both forms converge on
     * one list before validation — a second validation path would be a second set
     * of rules, and the looser one is always the one nobody remembers writing.
     */
    const ok = await json<{ added: number }>(
      await owner.post('/api/admin/email/subscribers/import', {
        emails: ['a@test.local', 'b@test.local'],
        consent: true,
      }),
    );
    expect(ok.added).toBe(2);

    const bad = await owner.post('/api/admin/email/subscribers/import', {
      emails: ['c@test.local', 'Smith John'],
    });
    expect(bad.status).toBe(400);
    expect(await json(bad)).toMatchObject({ detail: 'csv.line.2' });
  });

  it('records consent only when the importer actually asserted it', async () => {
    /*
     * The timestamp records when the OPERATOR asserted the consent, not when the
     * subscriber gave it — the only thing a bulk upload can honestly record. Absent
     * the assertion the row carries none, because a date written anyway is evidence
     * that is not evidence.
     */
    await owner.post('/api/admin/email/subscribers/import', {
      emails: ['asserted@test.local'],
      consent: true,
    });
    await owner.post('/api/admin/email/subscribers/import', { emails: ['silent@test.local'] });

    const rows = await ctx.db.execute(sql`
      SELECT email, consent_at FROM email_subscribers ORDER BY email`);
    expect(rows.rows[0].consent_at).not.toBeNull();
    expect(rows.rows[1].consent_at).toBeNull();
  });

  it('handles a quoted field containing a comma', async () => {
    /*
     * `split(',')` is the obvious implementation and it shifts every field one to
     * the right on this input — turning a name into an email address and importing
     * garbage without complaining.
     */
    await post('name,email\n"Smith, John",js@test.local\n');
    const res = await owner.get('/api/admin/email/subscribers');
    const body = await json<{ items: { email: string; name: string }[] }>(res);
    expect(body.items).toEqual([expect.objectContaining({ email: 'js@test.local', name: 'Smith, John' })]);
  });

  it('VALIDATES EVERY ROW BEFORE WRITING ANY ROW, and names the line', async () => {
    /*
     * The rule `POST /api/import` states. Validating as each row is inserted leaves
     * the rows before the bad one stored and the ones after it not — a partial
     * import the caller cannot distinguish from a complete one, on a table where
     * "did that address get added" is not answerable by looking at the file.
     */
    const res = await post('email,name\na@test.local,Ada\nSmith John,Bo\nc@test.local,Cy\n');
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'csv.line.3' });

    const after = await json<{ items: unknown[] }>(
      await owner.get('/api/admin/email/subscribers?filter=all'),
    );
    expect(after.items).toEqual([]);
  });

  it('refuses a file listing one address twice', async () => {
    // Deduplicating silently would make `imported + skipped` disagree with the row
    // count the operator is looking at in their spreadsheet.
    const res = await post('email\na@test.local\na@test.local\n');
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ detail: 'csv.line.3' });
  });

  it('marks an imported row as such, and imports no consent it was not given', async () => {
    await post('email\na@test.local\n');
    const body = await json<{ items: { consentAt: number | null; source: string }[] }>(
      await owner.get('/api/admin/email/subscribers'),
    );
    expect(body.items[0]).toEqual(
      expect.objectContaining({ consentAt: null, source: 'import' }),
    );
  });
});

// ----------------------------------------------------------------- broadcasts

describe('broadcasts', () => {
  it('snapshots the template, so editing it afterwards changes nothing', async () => {
    const template = await createTemplate();
    const created = await createBroadcast(template.id);

    await owner.patch(`/api/admin/email/templates/${template.id}`, {
      subject: 'Completely different',
    });

    const body = await json<{ broadcast: { subject: string; templateId: string } }>(
      await owner.get(`/api/admin/email/broadcasts/${created.id}`),
    );
    expect(body.broadcast.subject).toBe(TEMPLATE.subject);
    expect(body.broadcast.templateId).toBe(template.id);
  });

  it('REFUSES to send a snapshot missing {{unsubscribe_url}} from either part', async () => {
    /*
     * Required in BOTH parts, not either. A reader whose client renders the text
     * part — every plain-text client, every preview pane — sees only that half, so
     * an unsubscribe link present solely in the HTML is not present for them.
     */
    const htmlOnly = await createTemplate({
      name: 'html only',
      text: 'Hello {{name}}, no way out of this list',
    });
    const broadcast = await createBroadcast(htmlOnly.id);

    const res = await owner.post(`/api/admin/email/broadcasts/${broadcast.id}/send`);
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({
      error: 'precondition_failed',
      operation: 'send',
    });
    // And nothing was started: the CAS never ran.
    const after = await json<{ broadcast: BroadcastRow }>(
      await owner.get(`/api/admin/email/broadcasts/${broadcast.id}`),
    );
    expect(after.broadcast.status).toBe('draft');
    expect(mailer.sent).toEqual([]);
  });

  it('501s before enqueueing anything when no mailer is configured', async () => {
    /*
     * Asked once, up front. The alternative is five thousand recipient rows each
     * carrying eight attempts' worth of the same configuration error, and a
     * broadcast that ends `failed` for a reason nothing in the UI can tell apart
     * from a bad list.
     */
    mailer.configured = false;
    const broadcast = await createBroadcast((await createTemplate()).id);
    await addSubscriber('reader@test.local');

    const res = await owner.post(`/api/admin/email/broadcasts/${broadcast.id}/send`);
    expect(res.status).toBe(501);
    expect(await json(res)).toMatchObject({ error: 'not_implemented', feature: 'mail-delivery' });

    const counts = await json<{ recipients: { pending: number } }>(
      await owner.get(`/api/admin/email/broadcasts/${broadcast.id}`),
    );
    expect(counts.recipients.pending).toBe(0);
  });

  it('sends: substitutes server-side, escapes into the HTML, and finishes', async () => {
    await addSubscriber('reader@test.local', 'Ada & Co <VIP>');
    const broadcast = await createBroadcast((await createTemplate()).id);

    const res = await owner.post(`/api/admin/email/broadcasts/${broadcast.id}/send`);
    expect(res.status).toBe(200);
    const body = await json<{ broadcast: BroadcastRow; drained: Drained }>(res);
    expect(body.drained).toEqual({
      sent: 1,
      failed: 0,
      suppressed: 0,
      skipped: 0,
      // Nobody's basket was consulted: this template carries no {{basket}}.
      emptyBasket: 0,
      retryable: 0,
    });
    expect(body.broadcast).toEqual(
      expect.objectContaining({ status: 'sent', sentCount: 1, failedCount: 0 }),
    );
    expect(body.broadcast.finishedAt).not.toBeNull();
    // The denominator the progress view needs: "1 sent" means nothing without it.
    expect(body.broadcast.recipientCount).toBe(1);

    expect(mailer.sent).toHaveLength(1);
    const message = mailer.sent[0];
    expect(message.to).toBe('reader@test.local');
    expect(message.subject).toBe('What we have been up to, Ada & Co <VIP>');
    // The text part takes the name verbatim; the HTML part escapes it, because a
    // name is a value somebody else typed and mail clients render `<a>` and `<img>`
    // perfectly well.
    expect(message.text).toContain('Hello Ada & Co <VIP>');
    expect(message.html).toContain('Hello Ada &amp; Co &lt;VIP&gt;');
    // The link is absolute and built from the deployment's own allow-list, never
    // from a request header.
    const token = await tokenOf('reader@test.local');
    expect(message.html).toContain(`https://studio.test/api/public/unsubscribe?token=${token}`);
    expect(message.text).toContain(`https://studio.test/api/public/unsubscribe?token=${token}`);
  });

  it('falls back to the local part when a subscriber has no name', async () => {
    await addSubscriber('ada@test.local');
    const broadcast = await createBroadcast((await createTemplate()).id);
    await owner.post(`/api/admin/email/broadcasts/${broadcast.id}/send`);
    expect(mailer.sent[0].text).toContain('Hello ada');
  });

  it('SKIPS a subscriber who unsubscribed after the audience was enqueued', async () => {
    /*
     * SUPPRESSION IS LATE, and this is the test that says so. The recipient rows
     * are enqueued when "send" is pressed; the address and `unsubscribed_at` are
     * read through the join at CLAIM time, so somebody who clicks unsubscribe while
     * the broadcast is draining is passed over by the batch that had not reached
     * them yet. A snapshot taken at enqueue time would mail them anyway.
     */
    await addSubscriber('first@test.local');
    await addSubscriber('second@test.local');
    const broadcast = await createBroadcast((await createTemplate()).id);

    const first = await json<{ drained: Drained }>(
      await owner.post(`/api/admin/email/broadcasts/${broadcast.id}/send`, { limit: 1 }),
    );
    expect(first.drained.sent).toBe(1);

    // Everybody opts out between the batches.
    await ctx.db.execute(sql`UPDATE email_subscribers SET unsubscribed_at = 2`);

    const second = await json<{ broadcast: BroadcastRow; drained: Drained }>(
      await owner.post(`/api/admin/email/broadcasts/${broadcast.id}/drain`),
    );
    expect(second.drained).toEqual(
      expect.objectContaining({ sent: 0, failed: 1, suppressed: 1 }),
    );
    expect(mailer.sent).toHaveLength(1);
    // One went out, so the broadcast SENT — a red badge on the most successful
    // thing this surface does would be the wrong summary.
    expect(second.broadcast.status).toBe('sent');
    expect(second.broadcast.failedCount).toBe(1);
  });

  it('never enqueues an already-unsubscribed address at all', async () => {
    const gone = await addSubscriber('gone@test.local');
    await ctx.db.execute(sql`
      UPDATE email_subscribers SET unsubscribed_at = 1 WHERE id = ${gone.id}::uuid`);
    await addSubscriber('here@test.local');

    const broadcast = await createBroadcast((await createTemplate()).id);
    await owner.post(`/api/admin/email/broadcasts/${broadcast.id}/send`);

    expect(mailer.sent.map((m) => m.to)).toEqual(['here@test.local']);
    const body = await json<{ recipients: { pending: number; sent: number; failed: number } }>(
      await owner.get(`/api/admin/email/broadcasts/${broadcast.id}`),
    );
    expect(body.recipients).toEqual({ pending: 0, sent: 1, failed: 0, skipped: 0 });
  });

  it('409s a second send, so one press is one audience', async () => {
    await addSubscriber('reader@test.local');
    const broadcast = await createBroadcast((await createTemplate()).id);
    expect((await owner.post(`/api/admin/email/broadcasts/${broadcast.id}/send`)).status).toBe(200);

    const again = await owner.post(`/api/admin/email/broadcasts/${broadcast.id}/send`);
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({
      error: 'precondition_failed',
      operation: 'send',
      broadcast: { status: 'sent' },
    });
    expect(mailer.sent).toHaveLength(1);
  });

  it('records a transport refusal on the row and retries it, never throwing', async () => {
    await addSubscriber('reader@test.local');
    const broadcast = await createBroadcast((await createTemplate()).id);

    mailer.refuseWith = 'provider unreachable: connect ETIMEDOUT';
    const failed = await json<{ broadcast: BroadcastRow; drained: Drained }>(
      await owner.post(`/api/admin/email/broadcasts/${broadcast.id}/send`),
    );
    // Retryable, not terminal: the attempt budget is not spent.
    expect(failed.drained).toEqual(expect.objectContaining({ sent: 0, retryable: 1, failed: 0 }));
    expect(failed.broadcast.status).toBe('sending');

    const row = await ctx.db.execute(sql`
      SELECT attempts, last_error, status FROM email_broadcast_recipients`);
    expect(Number(row.rows[0].attempts)).toBe(1);
    expect(String(row.rows[0].last_error)).toContain('provider unreachable');
    expect(String(row.rows[0].status)).toBe('pending');

    mailer.refuseWith = null;
    const recovered = await json<{ broadcast: BroadcastRow; drained: Drained }>(
      await owner.post(`/api/admin/email/broadcasts/${broadcast.id}/drain`),
    );
    expect(recovered.drained.sent).toBe(1);
    expect(recovered.broadcast.status).toBe('sent');
    // Retried three times and delivered counts once, as a success.
    expect(recovered.broadcast.failedCount).toBe(0);
  });

  it('gives up after the attempt limit rather than starving the rest of the queue', async () => {
    await addSubscriber('reader@test.local');
    const broadcast = await createBroadcast((await createTemplate()).id);
    mailer.refuseWith = 'nope';

    await owner.post(`/api/admin/email/broadcasts/${broadcast.id}/send`);
    for (let i = 0; i < 8; i += 1) {
      await owner.post(`/api/admin/email/broadcasts/${broadcast.id}/drain`);
    }

    const body = await json<{ broadcast: BroadcastRow }>(
      await owner.get(`/api/admin/email/broadcasts/${broadcast.id}`),
    );
    // Nothing went out at all, so this one really is a failure.
    expect(body.broadcast.status).toBe('failed');
    expect(body.broadcast.failedCount).toBe(1);
    // The row is still there with its reason — nothing was deleted.
    const row = await ctx.db.execute(sql`
      SELECT status, attempts, last_error FROM email_broadcast_recipients`);
    expect(String(row.rows[0].status)).toBe('failed');
    expect(Number(row.rows[0].attempts)).toBe(8);
  });
});

describe('the test send', () => {
  it('goes to the CALLER’S OWN address and takes no recipient', async () => {
    /*
     * THE RECIPIENT IS NOT IN THE BODY, AND THAT IS THE DESIGN. A `{ to }` field
     * would make this an authenticated open relay: arbitrary HTML to an arbitrary
     * address over the shop's verified sending domain.
     */
    const broadcast = await createBroadcast((await createTemplate()).id);

    const rejected = await owner.post(`/api/admin/email/broadcasts/${broadcast.id}/test`, {
      to: 'somebody.else@example.com',
    });
    expect(rejected.status).toBe(400);
    expect(mailer.sent).toEqual([]);

    const res = await owner.post(`/api/admin/email/broadcasts/${broadcast.id}/test`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ sent: true, to: ctx.users.owner.email });
    expect(mailer.sent.map((m) => m.to)).toEqual([ctx.users.owner.email]);
    // Rendered, not raw: a test that shipped `{{name}}` would prove nothing about
    // what the audience will read.
    expect(mailer.sent[0].text).toContain('Hello Owner');
  });

  it('reports a failed send rather than 500ing on it', async () => {
    // The shape `POST /api/invites` uses: the caller can act on `sent: false`, and
    // a 500 would be retried five times for a provider outage that is not going to
    // clear in thirty seconds.
    const broadcast = await createBroadcast((await createTemplate()).id);
    mailer.refuseWith = 'provider refused the message: HTTP 422';
    const res = await owner.post(`/api/admin/email/broadcasts/${broadcast.id}/test`);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ sent: false });
  });
});

// ------------------------------------------------------------------ the drain

describe('the drain route', () => {
  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  const SECRET = 'a-test-cron-secret-at-least-16-chars';

  it('runs every sending broadcast for a GET carrying the cron bearer token', async () => {
    process.env.CRON_SECRET = SECRET;
    await addSubscriber('a@test.local');
    await addSubscriber('b@test.local');
    const broadcast = await createBroadcast((await createTemplate()).id);
    await owner.post(`/api/admin/email/broadcasts/${broadcast.id}/send`, { limit: 1 });
    expect(mailer.sent).toHaveLength(1);

    const res = await owner.get('/api/admin/email/drain', {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ sent: 1, broadcasts: 1 });
    expect(mailer.sent).toHaveLength(2);
  });

  it('caps ?limit at the batch size, like the POST always did', async () => {
    /*
     * THE ASYMMETRY THIS CLOSES. The GET used to read `Number(query.limit)` with
     * no schema while the POST went through `DrainBody`, so the cron — the only
     * caller that actually uses this method — was the one without a ceiling.
     *
     * It matters because of what a cron cannot do: `vercel.json` gives this
     * function `maxDuration: 30` and Vercel does not re-run a job it had to kill,
     * so an over-large batch is not a slow drain, it is one that never completes
     * and whose next attempt is tomorrow. `CRON_SECRET` bounds who may call it,
     * which is a different question from what the call costs.
     */
    process.env.CRON_SECRET = SECRET;
    const bearer = { headers: { authorization: `Bearer ${SECRET}` } };

    const tooBig = await owner.get('/api/admin/email/drain?limit=100000', bearer);
    expect(tooBig.status).toBe(400);
    expect((await json<{ detail: string }>(tooBig)).detail).toBe('limit');

    // A non-number is a refusal too, and not the silent `NaN || undefined`
    // fallback to the default that the bare-`Number` version produced.
    expect((await owner.get('/api/admin/email/drain?limit=abc', bearer)).status).toBe(400);

    // Strict, like every other query schema here.
    expect((await owner.get('/api/admin/email/drain?nope=1', bearer)).status).toBe(400);

    // And the ordinary calls still work: within the cap, and absent entirely.
    expect((await owner.get('/api/admin/email/drain?limit=10', bearer)).status).toBe(200);
    expect((await owner.get('/api/admin/email/drain', bearer)).status).toBe(200);
  });

  it('FAILS CLOSED when CRON_SECRET is not configured', async () => {
    /*
     * The one that would otherwise be a public endpoint. Vercel sends the
     * `Authorization` header only when `CRON_SECRET` is set on the project, and
     * `originGuard` waves every GET through — so a check written as "if a secret is
     * configured, compare it" lets everybody in on the default state of a new
     * project and of every preview deployment.
     */
    expect((await owner.get('/api/admin/email/drain')).status).toBe(401);
    expect(
      (
        await owner.get('/api/admin/email/drain', {
          headers: { authorization: `Bearer ${SECRET}` },
        })
      ).status,
    ).toBe(401);
  });

  it('does not accept a session cookie in place of the token, or the reverse', async () => {
    // A signed-in owner is not a cron. Keeping the two credentials separate is what
    // stops a leaked session driving the mailer and what stops the cron token
    // becoming a general-purpose admin credential.
    process.env.CRON_SECRET = SECRET;
    expect((await owner.get('/api/admin/email/drain')).status).toBe(401);

    const anon = httpClient(ctx.db, { mailer });
    expect((await anon.post('/api/admin/email/drain')).status).toBe(401);
    // ...and an operator can still run it by hand, over POST, with their session.
    expect((await owner.post('/api/admin/email/drain')).status).toBe(200);
  });
});

// ------------------------------------------------------------- unsubscribing

describe('the public unsubscribe link', () => {
  it('confirms on GET and unsubscribes on POST, with NO session and NO Origin', async () => {
    /*
     * THE MOUNT, ASSERTED. Both requests go through `client.app.request` rather
     * than the helper, because `server/test/http.ts` adds an `Origin` to every
     * unsafe method by design — and the whole reason this router is mounted above
     * `originGuard` is that its real callers (a mail provider's RFC 8058 one-click
     * POST, a link-scanning gateway) cannot supply one. Mounted below the guard,
     * every unsubscribe button in every message we send would be a 403.
     */
    await addSubscriber('reader@test.local');
    const token = await tokenOf('reader@test.local');
    const app = httpClient(ctx.db, { mailer }).app;

    const confirm = await app.request(`/api/public/unsubscribe?token=${token}`);
    expect(confirm.status).toBe(200);
    expect(confirm.headers.get('content-type')).toContain('text/html');
    // Never cached: this page names an email address, and `/api/public/*` is the
    // one prefix a shared cache has been told it MAY store.
    expect(confirm.headers.get('cache-control')).toBe('no-store');
    const page = await confirm.text();
    expect(page).toContain('reader@test.local');
    // A GET must not unsubscribe: mail clients and security scanners fetch every
    // URL in a message before a human sees it.
    expect(page).toContain('<form method="post"');

    const done = await app.request(`/api/public/unsubscribe?token=${token}`, { method: 'POST' });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('Unsubscribed');

    const row = await ctx.db.execute(sql`
      SELECT unsubscribed_at FROM email_subscribers WHERE email = 'reader@test.local'`);
    expect(row.rows[0].unsubscribed_at).not.toBeNull();
  });

  it('is idempotent, and does not re-stamp the date a person opted out', async () => {
    // Mail clients prefetch, gateways rescan, and people click twice. The date
    // somebody unsubscribed is a fact about them, not the date of the last prefetch.
    await addSubscriber('reader@test.local');
    const token = await tokenOf('reader@test.local');
    const app = httpClient(ctx.db, { mailer }).app;

    await app.request(`/api/public/unsubscribe?token=${token}`, { method: 'POST' });
    const first = await ctx.db.execute(sql`SELECT unsubscribed_at FROM email_subscribers`);
    const second = await app.request(`/api/public/unsubscribe?token=${token}`, { method: 'POST' });
    expect(second.status).toBe(200);
    const after = await ctx.db.execute(sql`SELECT unsubscribed_at FROM email_subscribers`);
    expect(String(after.rows[0].unsubscribed_at)).toBe(String(first.rows[0].unsubscribed_at));
  });

  it('answers a link a gateway mangled with a page, not a JSON envelope', async () => {
    const app = httpClient(ctx.db, { mailer }).app;
    const res = await app.request('/api/public/unsubscribe?token=deadbeef');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('not recognised');
  });

  it('IGNORES the tracking parameters a link-protection gateway appends', async () => {
    /*
     * The one query in this application that is not `.strict()`, and this is why:
     * Outlook Safe Links, Proofpoint and their kind rewrite every link they scan
     * and append their own parameters. A strict schema would turn one corporate
     * mail gateway into an unsubscribe outage for a whole company — a refusal the
     * sender never sees and the recipient reads as being ignored.
     */
    await addSubscriber('reader@test.local');
    const token = await tokenOf('reader@test.local');
    const app = httpClient(ctx.db, { mailer }).app;
    const res = await app.request(
      `/api/public/unsubscribe?token=${token}&utm_source=scanner&safelink=1`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('reader@test.local');
  });

  it('closes the loop: an unsubscribed reader is not in the next broadcast', async () => {
    await addSubscriber('leaving@test.local');
    await addSubscriber('staying@test.local');
    const app = httpClient(ctx.db, { mailer }).app;
    await app.request(`/api/public/unsubscribe?token=${await tokenOf('leaving@test.local')}`, {
      method: 'POST',
    });

    const broadcast = await createBroadcast((await createTemplate()).id);
    await owner.post(`/api/admin/email/broadcasts/${broadcast.id}/send`);
    expect(mailer.sent.map((m) => m.to)).toEqual(['staying@test.local']);
  });
});

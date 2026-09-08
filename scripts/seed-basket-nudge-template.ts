/**
 * Seed the starter "not bought yet" nudge template.
 *
 * AN ORDINARY TEMPLATE, `system_key` NULL. Migration 0320's trigger refuses to
 * delete a row that has one — right for the transactional messages this shop
 * always sends, wrong for a starter draft the owner should be free to rewrite
 * or bin on day one. This script never touches `system_key`, so the row it
 * creates is deletable like any template an operator wrote by hand.
 *
 * IDEMPOTENT BY NAME. `createTemplate` (`server/email/repo.ts`) already refuses
 * a duplicate name with `EmailPreconditionFailedError('create', 'template', …)`
 * carrying the existing row — this script catches exactly that and reports
 * "already exists" rather than a stack trace, so running it twice is harmless.
 *
 * `--check` PRINTS AND WRITES NOTHING, the same convention
 * `restore-description-revision.ts` uses: read the row it would either create
 * or find, print it, touch the database not at all.
 *
 * The body follows `server/mail/brand.ts`'s house shell — `shell()` wrapping
 * `h1()`/`p()`/`button()` — because a broadcast body is sent EXACTLY as
 * written with no shell applied (`server/mail/port.ts`); skip the shell here
 * and the message arrives unstyled. `{{basket}}` already renders its own
 * "Basket total" line in both parts, so `{{basket_total}}` is used in a
 * sentence instead of printed a second time next to it. `{{unsubscribe_url}}`
 * is mandatory — the server 412s a send without it — and both the html and
 * text parts carry every placeholder, because no client is meant to see only
 * one of them.
 *
 *   APP_ORIGINS="https://seed.invalid" \
 *     npx tsx --env-file=.dev.env scripts/seed-basket-nudge-template.ts --check
 *
 * Drop `--check` to write. Always prove it against `.dev.env` first.
 */
import { sql } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from '../server/db/schema';
import type { Db } from '../server/db/client';
import { createTemplate, EmailPreconditionFailedError } from '../server/email/repo';
import { shell, h1, p, button } from '../server/mail/brand';

const CHECK = process.argv.includes('--check');

const TEMPLATE_NAME = 'Basket left behind';

const SUBJECT = 'Still thinking it over?';

const BODY_HTML = [
  h1('Still thinking it over?'),
  p('You left some things in your basket. They’re still there, whenever you’re ready.'),
  '{{basket}}',
  button('Back to your basket', '{{basket_url}}'),
].join('\n');

const HTML = shell({
  title: SUBJECT,
  body: BODY_HTML,
  footer: 'You’re getting this because you have items in your basket. <a href="{{unsubscribe_url}}" style="color:inherit">Unsubscribe</a>.',
});

const TEXT = [
  'Still thinking it over?',
  '',
  'You left some things in your basket. They’re still there, whenever you’re ready.',
  '',
  '{{basket}}',
  '',
  'Back to your basket: {{basket_url}}',
  '',
  'Unsubscribe: {{unsubscribe_url}}',
].join('\n');

async function findOwnerId(db: Db): Promise<string> {
  const res = await db.execute(sql`
    SELECT id FROM users WHERE role = 'owner' AND disabled_at IS NULL
     ORDER BY created_at ASC LIMIT 1`);
  const row = res.rows[0];
  if (!row) throw new Error('no active owner account found to attribute this template to');
  return String(row.id);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const db = drizzle(neon(url), { schema }) as unknown as Db;

  console.log(`${CHECK ? 'WOULD CREATE' : 'CREATING'} template ${JSON.stringify(TEMPLATE_NAME)}`);
  console.log(`  subject: ${JSON.stringify(SUBJECT)}`);
  console.log('  html:');
  console.log(HTML.split('\n').map((line) => `    ${line}`).join('\n'));
  console.log('  text:');
  console.log(TEXT.split('\n').map((line) => `    ${line}`).join('\n'));

  if (CHECK) {
    console.log('\n--check: nothing written.');
    return;
  }

  const actorId = await findOwnerId(db);
  try {
    const created = await createTemplate(
      db,
      { name: TEMPLATE_NAME, subject: SUBJECT, html: HTML, text: TEXT },
      actorId,
      Date.now(),
    );
    console.log(`\nCREATED template ${created.id}`);
  } catch (err) {
    if (err instanceof EmailPreconditionFailedError && err.entity === 'template') {
      console.log(`\nSKIP: a template named ${JSON.stringify(TEMPLATE_NAME)} already exists.`);
      return;
    }
    throw err;
  }
}

await main();

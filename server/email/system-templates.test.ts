/**
 * The system templates: seeding, protection, override, and the fallback that
 * makes the whole feature safe to put in front of a payment capture.
 *
 * WHY THESE TESTS AND NOT OTHERS. CLAUDE.md §2 records that a green suite in this
 * repository has repeatedly meant nothing, because the suite drives routes
 * server-side where composition roots are replaced and scheduled paths never run.
 * The properties below were chosen to be the ones that CANNOT be true by accident:
 *
 *   * a `DELETE` is refused by the DATABASE, not only by the function above it;
 *   * an edited row actually reaches the renderer, which is the entire promise of
 *     putting these templates on a screen;
 *   * a BROKEN edited row does NOT reach the renderer, which is the promise that
 *     an owner cannot break a paid order by emptying a textarea;
 *   * seeding twice does not overwrite, which is what stops the next deploy
 *     silently reverting somebody's wording.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedDb } from '../test/harness';
import {
  deleteTemplate,
  duplicateTemplate,
  getSystemTemplate,
  listSystemTemplates,
  listTemplates,
} from './repo';
import { BUILT_IN, ensureSystemTemplates, loadTemplates, renderSystem } from './system-templates';
import { DEFAULT_TEMPLATES, SYSTEM_KEYS } from '../mail/defaults';
import type { Db } from '../db/client';

let db: Db;
let close: () => Promise<void>;

const NOW = 1786600000700;

/**
 * A REAL user row, because `email_templates.updated_by` is a foreign key.
 *
 * A made-up uuid fails with `23503` rather than passing — which is itself worth
 * knowing: `duplicateTemplate` records WHO made the copy, and a version that
 * quietly wrote `NULL` would lose that.
 */
let ACTOR: string;

beforeAll(async () => {
  ({ db, close } = await migratedDb());
  const res = await db.execute(sql`
    INSERT INTO users (email, password_hash, display_name, role, created_at)
    VALUES ('owner@test.local', 'x', 'Owner', 'owner', ${NOW})
    RETURNING id`);
  ACTOR = String(res.rows[0].id);
});
afterAll(() => close());

beforeEach(async () => {
  await db.execute(sql`TRUNCATE email_templates, email_subscribers, email_broadcasts,
                                email_broadcast_recipients CASCADE`);
});

describe('seeding', () => {
  it('creates one row per system message and is idempotent', async () => {
    expect(await ensureSystemTemplates(db, NOW)).toBe(SYSTEM_KEYS.length);
    expect((await listSystemTemplates(db)).map((t) => t.systemKey).sort()).toEqual(
      [...SYSTEM_KEYS].sort(),
    );

    // Second call creates nothing. This runs on every templates-screen load and
    // on every sweep, so a non-idempotent seeder would be nine writes a minute.
    expect(await ensureSystemTemplates(db, NOW + 1)).toBe(0);
    expect(await listSystemTemplates(db)).toHaveLength(SYSTEM_KEYS.length);
  });

  it('NEVER OVERWRITES AN EDITED TEMPLATE, which is what a deploy must not do', async () => {
    /*
     * The property an owner is relying on. If this seeder upserted, every deploy
     * would silently revert their wording — and they would find out from a
     * customer, because nobody re-reads the refund email.
     */
    await ensureSystemTemplates(db, NOW);
    await db.execute(sql`
      UPDATE email_templates SET subject = 'MY OWN WORDING'
       WHERE system_key = 'order.confirmation'`);

    expect(await ensureSystemTemplates(db, NOW + 1)).toBe(0);
    expect((await getSystemTemplate(db, 'order.confirmation'))?.subject).toBe('MY OWN WORDING');
  });

  it('survives an operator template that already has a default’s name', async () => {
    /*
     * `email_templates_name_lower_uq` is UNIQUE over `lower(name)`, so an owner
     * who has already written their own "Welcome" would otherwise make the
     * seeder — and therefore the whole templates screen — fail for exactly the
     * person who had used the feature most.
     */
    await db.execute(sql`
      INSERT INTO email_templates (name, subject, html, text, updated_at)
      VALUES ('welcome', 'Mine', '<p>mine</p>', 'mine', ${NOW})`);

    expect(await ensureSystemTemplates(db, NOW)).toBe(SYSTEM_KEYS.length);
    const seeded = await getSystemTemplate(db, 'account.welcome');
    expect(seeded).not.toBeNull();
    expect(seeded!.name).toBe('Welcome (system)');
  });

  it('sorts system templates to the top of the list', async () => {
    await db.execute(sql`
      INSERT INTO email_templates (name, subject, html, text, updated_at)
      VALUES ('Zebra', 'z', '<p>z</p>', 'z', ${NOW + 9999})`);
    await ensureSystemTemplates(db, NOW);

    const items = await listTemplates(db);
    expect(items[0].systemKey).not.toBeNull();
    // Even though the operator's row is the most recently touched.
    expect(items[items.length - 1].name).toBe('Zebra');
  });
});

describe('a system template cannot be deleted', () => {
  it('is refused by the repository with a precondition error', async () => {
    await ensureSystemTemplates(db, NOW);
    const target = (await getSystemTemplate(db, 'order.confirmation'))!;
    await expect(deleteTemplate(db, target.id)).rejects.toThrow();
    expect(await getSystemTemplate(db, 'order.confirmation')).not.toBeNull();
  });

  it('IS REFUSED BY THE DATABASE, for a caller that never goes through it', async () => {
    /*
     * THE ASSERTION THAT MATTERS. A guard in application code is a guard some
     * other caller does not go through — a migration, a psql session, a route
     * somebody adds next year. Deleting `order.confirmation` does not break the
     * admin screen, it breaks PAID ORDERS, silently, in a path deliberately built
     * to swallow its own failures. So the trigger from migration 0320 is asserted
     * directly, with raw SQL that bypasses every line of TypeScript.
     */
    await ensureSystemTemplates(db, NOW);
    await expect(
      db.execute(sql`DELETE FROM email_templates WHERE system_key = 'order.confirmation'`),
    ).rejects.toThrow();
    expect(await getSystemTemplate(db, 'order.confirmation')).not.toBeNull();
  });

  it('lets an ORDINARY template be deleted, so the guard is not just "nothing deletes"', async () => {
    const res = await db.execute(sql`
      INSERT INTO email_templates (name, subject, html, text, updated_at)
      VALUES ('Ordinary', 's', '<p>h</p>', 't', ${NOW}) RETURNING id`);
    expect(await deleteTemplate(db, String(res.rows[0].id))).toBe(true);
  });
});

describe('duplicate', () => {
  it('produces an ORDINARY row that can then be deleted', async () => {
    await ensureSystemTemplates(db, NOW);
    const source = (await getSystemTemplate(db, 'order.confirmation'))!;

    const copy = await duplicateTemplate(db, source.id, ACTOR, NOW + 1);
    expect(copy).not.toBeNull();
    // The escape hatch that makes "cannot be deleted" tolerable.
    expect(copy!.systemKey).toBeNull();
    expect(copy!.html).toBe(source.html);
    expect(copy!.name).toBe(`${source.name} copy`);
    expect(await deleteTemplate(db, copy!.id)).toBe(true);
  });

  it('disambiguates the name against the unique index rather than 409ing', async () => {
    await ensureSystemTemplates(db, NOW);
    const source = (await getSystemTemplate(db, 'order.refund'))!;

    const first = await duplicateTemplate(db, source.id, ACTOR, NOW + 1);
    const second = await duplicateTemplate(db, source.id, ACTOR, NOW + 2);
    expect(first!.name).toBe(`${source.name} copy`);
    expect(second!.name).toBe(`${source.name} copy 2`);
  });
});

describe('the edited row is what renders — and a broken one is not', () => {
  it('an edited template reaches the renderer', async () => {
    // The entire promise of putting these on a screen.
    await ensureSystemTemplates(db, NOW);
    await db.execute(sql`
      UPDATE email_templates
         SET subject = 'Bespoke {{order_number}}', text = 'Bespoke body {{order_number}}'
       WHERE system_key = 'order.confirmation'`);

    const set = await loadTemplates(db);
    expect(set.get('order.confirmation').subject).toBe('Bespoke {{order_number}}');
  });

  it('A WHITESPACE-ONLY BODY FALLS BACK, so an emptied textarea cannot mail a blank page', async () => {
    /*
     * `email_templates_bodies_ck` refuses the empty string but says nothing about
     * whitespace, and an owner who selects-all-and-deletes in the editor produces
     * exactly that. Sending it would deliver a blank message to a paying customer.
     */
    await ensureSystemTemplates(db, NOW);
    await db.execute(sql`
      UPDATE email_templates SET text = '   ' WHERE system_key = 'order.confirmation'`);

    const set = await loadTemplates(db);
    expect(set.get('order.confirmation').text).toBe(
      DEFAULT_TEMPLATES['order.confirmation'].text,
    );
  });

  it('AN UNREADABLE DATABASE FALLS BACK RATHER THAN THROWING', async () => {
    /*
     * THE PROPERTY THAT MAKES THIS FEATURE ADMISSIBLE AT ALL. The order pipeline
     * renders inside the same statement as the capture, so a `loadTemplates` that
     * could throw would be a `throw` inside a payment capture. A handle whose
     * every query fails must produce the built-ins, not an exception.
     */
    const broken = {
      execute: () => Promise.reject(new Error('connection reset')),
    } as unknown as Db;

    const set = await loadTemplates(broken);
    expect(set.get('order.confirmation').subject).toBe(
      DEFAULT_TEMPLATES['order.confirmation'].subject,
    );
  });

  it('an unseeded database falls back for every key', async () => {
    // No `ensureSystemTemplates` call: the table is empty.
    const set = await loadTemplates(db);
    for (const key of SYSTEM_KEYS) {
      expect(set.get(key)).toEqual(BUILT_IN.get(key));
    }
  });
});

describe('renderSystem', () => {
  it('substitutes scalars and fills in the support address', async () => {
    await ensureSystemTemplates(db, NOW);
    /* Was `account.password_reset` until that template went with the password
       routes. Any single-URL template proves the same substitution. */
    const message = await renderSystem(db, 'account.invite', 'a@test.local', {
      inviter_name: 'Amara',
      invite_url: 'https://shop.test/#/',
      expiry_days: '7',
    });

    expect(message.to).toBe('a@test.local');
    expect(message.subject).toBe('You have been invited to the PlaSpool admin');
    expect(message.text).toContain('https://shop.test/#/');
    expect(message.html).toContain('href="https://shop.test/#/"');
    // The scalar substitution, not just the URL.
    expect(message.text).toContain('Amara');
    // Nobody has to remember to pass it, so no footer can ship the raw placeholder.
    expect(message.html).not.toContain('{{support_email}}');
    expect(message.text).not.toContain('{{support_email}}');
  });

  it('ESCAPES A SCALAR INTO THE HTML AND LEAVES THE TEXT PART ALONE', async () => {
    /*
     * The invite message interpolated a display name straight into markup before
     * migration 0320: a writer whose name contained `<` produced broken markup,
     * and one who chose an `<a>` tag as their name produced a link in an email the
     * application sent. Closed by construction now rather than by remembering.
     */
    await ensureSystemTemplates(db, NOW);
    const message = await renderSystem(db, 'account.invite', 'b@test.local', {
      inviter_name: '<script>alert(1)</script>',
      invite_url: 'https://shop.test/invite',
      expiry_days: '7',
    });

    expect(message.html).toContain('&lt;script&gt;');
    expect(message.html).not.toContain('<script>');
    // No markup to escape INTO, and `&amp;` in a text part is a bug the reader sees.
    expect(message.text).toContain('<script>alert(1)</script>');
  });
});

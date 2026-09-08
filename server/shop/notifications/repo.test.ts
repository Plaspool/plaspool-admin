import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { BadRequestError, NotFoundError, StaleWriteError } from '../../repo/errors';
import {
  getNotificationSettings,
  normalizeRecipients,
  patchNotificationSettings,
} from './repo';

/**
 * `shop_notification_settings` — the row that decides who the shop emails when
 * an order is paid (migration 0980), against a real migrated database.
 *
 * THE CLAIM WORTH PINNING HARDEST IS THE EMPTY LIST. This row is the deliberate
 * opposite of `shop_delivery_settings.served_regions` one directory over, where
 * an empty array is refused because "serve nowhere" would shut the shop. Here
 * "nobody extra" is the ordinary state, and a later change that copied the
 * neighbouring constraint would make the settings screen unsavable for every
 * shop that has not typed an address in.
 */

let ctx: TestCtx;
const NOW = 1_788_900_000_000;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await ctx.db.execute(sql`
    UPDATE shop_notification_settings
       SET order_recipients = '{}', notify_team = true, notify_on_order = true,
           revision = 1, updated_by = NULL
     WHERE id = 'main'`);
});

const write = (patch: Parameters<typeof patchNotificationSettings>[1], expectedRevision = 1) =>
  patchNotificationSettings(ctx.db, patch, {
    expectedRevision,
    actorId: ctx.users.owner.id,
    now: NOW,
  });

describe('the seeded row', () => {
  /* The owner asked for notifications that work the moment they deploy. A shop
     that never opens the settings screen is still telling its staff. */
  it('is the feature switched ON, with nobody typed in', async () => {
    expect(await getNotificationSettings(ctx.db)).toEqual({
      orderRecipients: [],
      notifyTeam: true,
      notifyOnOrder: true,
      revision: 1,
      updatedAt: expect.any(Number),
      updatedBy: null,
    });
  });
});

describe('normalizeRecipients', () => {
  /* An owner who types " sales@plaspool.com " has said something correct, and a
     validation error about whitespace is pedantry. */
  it('trims what it stores', () => {
    expect(normalizeRecipients(['  sales@plaspool.com  '])).toEqual(['sales@plaspool.com']);
  });

  /* Same inbox, two spellings. Two rows would be two identical emails. */
  it('drops a second spelling of the same address, keeping the first', () => {
    expect(normalizeRecipients(['Sales@Plaspool.com', 'sales@plaspool.com'])).toEqual([
      'Sales@Plaspool.com',
    ]);
  });

  /* The empty row a list editor leaves behind when somebody adds a field and
     changes their mind. Dropped rather than refused — refusing would make the
     screen unsavable for a reason the operator cannot see. */
  it('drops a blank entry rather than refusing the save', () => {
    expect(normalizeRecipients(['   ', 'ops@plaspool.com', ''])).toEqual(['ops@plaspool.com']);
  });

  it('allows an empty result — "nobody extra" is a real answer', () => {
    expect(normalizeRecipients([])).toEqual([]);
    expect(normalizeRecipients(['  '])).toEqual([]);
  });

  /*
   * A 400 NAMING THE FIELD, NEVER A 23514 SURFACING AS A 500. The realistic
   * mistake is pasting two addresses into one box or pasting a name where an
   * address belongs, and both have to come back as something a person can act on.
   */
  it('refuses anything that is not plausibly an address', () => {
    for (const bad of [
      'sales at plaspool',
      'sales@plaspool',
      'a@b.co, c@d.co',
      'Jane Okafor',
      '@plaspool.com',
    ]) {
      expect(() => normalizeRecipients([bad])).toThrow(BadRequestError);
    }
  });
});

describe('the write', () => {
  it('stores a list and moves the revision', async () => {
    const settings = await write({ orderRecipients: ['ops@plaspool.com'] });
    expect(settings.orderRecipients).toEqual(['ops@plaspool.com']);
    expect(settings.revision).toBe(2);
    expect(settings.updatedBy).toBe(ctx.users.owner.id);
    expect(settings.updatedAt).toBe(NOW);
  });

  it('changes only what it names', async () => {
    await write({ orderRecipients: ['ops@plaspool.com'] });
    const settings = await write({ notifyOnOrder: false }, 2);
    expect(settings).toMatchObject({
      orderRecipients: ['ops@plaspool.com'],
      notifyTeam: true,
      notifyOnOrder: false,
    });
  });

  /*
   * ═════════════════════════════════════════════════════════════════════════
   * CLEARING THE LIST IS A SAVE, NOT AN ERROR — see the file header. The
   * neighbouring `servedRegions` refuses exactly this, and copying that
   * refusal here would break every shop that means "just the team".
   * ═════════════════════════════════════════════════════════════════════════
   */
  it('accepts an empty list and stores it as empty', async () => {
    await write({ orderRecipients: ['ops@plaspool.com'] });
    const settings = await write({ orderRecipients: [] }, 2);
    expect(settings.orderRecipients).toEqual([]);
    expect((await getNotificationSettings(ctx.db))!.orderRecipients).toEqual([]);
  });

  it('turns the master switch off and leaves the recipients alone', async () => {
    await write({ orderRecipients: ['ops@plaspool.com'] });
    const settings = await write({ notifyOnOrder: false, notifyTeam: false }, 2);
    expect(settings.notifyOnOrder).toBe(false);
    expect(settings.notifyTeam).toBe(false);
    expect(settings.orderRecipients).toEqual(['ops@plaspool.com']);
  });

  /* Two settings tabs must not quietly overwrite each other — the CAS is in the
     UPDATE's own WHERE, so there is no read-compare-write window to lose. */
  it('refuses a save based on a revision somebody else has already moved', async () => {
    await write({ notifyTeam: false });
    await expect(write({ notifyTeam: true })).rejects.toThrow(StaleWriteError);
    expect((await getNotificationSettings(ctx.db))!.notifyTeam).toBe(false);
  });

  /* Unreachable through any route. It still has to be told apart from a stale
     write, because the two need completely different words on the screen. */
  it('tells a missing row apart from a stale one', async () => {
    await ctx.db.execute(sql`DELETE FROM shop_notification_settings WHERE id = 'main'`);
    await expect(write({ notifyTeam: false })).rejects.toThrow(NotFoundError);
    expect(await getNotificationSettings(ctx.db)).toBeNull();
    await ctx.db.execute(sql`
      INSERT INTO shop_notification_settings
        (id, order_recipients, notify_team, notify_on_order, revision, updated_at)
      VALUES ('main', '{}', true, true, 1, ${NOW})`);
  });

  /* A bare array bind is a 22P02, so the cast in `textArray` is load-bearing —
     and the empty case needs `'{}'::text[]` because `ARRAY[]` has no element
     type Postgres can infer. Both paths are exercised above; this pins the one
     that has more than one element, which is where a hand-rolled join breaks. */
  it('binds a multi-element array without a 22P02', async () => {
    const settings = await write({
      orderRecipients: ['a@plaspool.com', 'b@plaspool.com', 'c@plaspool.com'],
    });
    expect(settings.orderRecipients).toHaveLength(3);
  });
});

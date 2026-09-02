import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../test/harness';
import type { TestCtx } from '../test/harness';
import {
  TRANSFER_TTL_MS,
  acceptTransfer,
  cancelTransfer,
  pendingTransfer,
  proposeTransfer,
} from './ownership';

/**
 * Handing the store to somebody else, at the repo level.
 *
 * THE ONE PROPERTY EVERY CASE HERE ORBITS: the instance has exactly one owner
 * at every instant. `shared/roles.ts` calls that singularity a construction
 * rather than a count, and this is the only code in the application allowed to
 * move it — so the interesting tests are not "does it work" but "what happens
 * when it half-works". Two sequential updates would pass a naive happy-path
 * test and leave a window with two owners; the assertions below count owners
 * after every outcome, including the refused ones.
 */

let ctx: TestCtx;
const NOW = 1_800_000_000_000;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM ownership_transfers`);
  await ctx.db.execute(sql`UPDATE users SET disabled_at = NULL`);
  await ctx.db.execute(sql`UPDATE users SET role = 'owner' WHERE email = 'owner@test.local'`);
  await ctx.db.execute(sql`UPDATE users SET role = 'writer' WHERE email = 'writer@test.local'`);
  await ctx.db.execute(
    sql`UPDATE users SET role = 'developer' WHERE email = 'developer@test.local'`,
  );
});

const roleOf = async (email: string): Promise<string> => {
  const res = await ctx.db.execute(sql`SELECT role FROM users WHERE email = ${email}`);
  return String(res.rows[0].role);
};

const ownerCount = async (): Promise<number> => {
  const res = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM users WHERE role = 'owner'`);
  return Number(res.rows[0].n);
};

const propose = (toUserId: string, now = NOW) =>
  proposeTransfer(ctx.db, { fromUserId: ctx.users.owner.id, toUserId, now });

describe('proposing a transfer', () => {
  it('records who is handing what to whom, and shows up as pending', async () => {
    const made = await propose(ctx.users.writer.id);
    expect(made.ok).toBe(true);

    const live = await pendingTransfer(ctx.db, NOW);
    expect(live).toMatchObject({
      fromUserId: ctx.users.owner.id,
      toUserId: ctx.users.writer.id,
      fromEmail: ctx.users.owner.email,
      toEmail: ctx.users.writer.email,
      expiresAt: NOW + TRANSFER_TTL_MS,
    });

    /* NOTHING HAS MOVED YET. The owner asked for the recipient to accept, so a
       proposal that changed a role on its own would be the feature they said
       they did not want. */
    expect(await roleOf(ctx.users.writer.email)).toBe('writer');
    expect(await ownerCount()).toBe(1);
  });

  it('refuses a second proposal while one is live', async () => {
    expect((await propose(ctx.users.writer.id)).ok).toBe(true);

    const second = await propose(ctx.users.developer.id);
    expect(second).toEqual({ ok: false, reason: 'already_pending' });

    /*
     * The refusal comes off the partial unique index, not a count read first —
     * which is what makes it hold when two tabs propose in the same instant.
     * Two live proposals would be two people each told the store is theirs.
     */
    const rows = await ctx.db.execute(sql`
      SELECT count(*)::int AS n FROM ownership_transfers
       WHERE accepted_at IS NULL AND cancelled_at IS NULL`);
    expect(Number(rows.rows[0].n)).toBe(1);
  });

  it('refuses a disabled recipient, and a recipient who is already the owner', async () => {
    await ctx.db.execute(
      sql`UPDATE users SET disabled_at = ${NOW} WHERE email = ${ctx.users.writer.email}`,
    );
    expect(await propose(ctx.users.writer.id)).toEqual({ ok: false, reason: 'bad_recipient' });

    /* Handing it to yourself is not a transfer, and the swap would demote and
       promote the same row. */
    expect(await propose(ctx.users.owner.id)).toEqual({ ok: false, reason: 'bad_recipient' });
    expect(await pendingTransfer(ctx.db, NOW)).toBeNull();
  });
});

describe('accepting', () => {
  it('promotes and demotes in the same breath — never two owners, never none', async () => {
    const made = await propose(ctx.users.writer.id);
    if (!made.ok) throw new Error('setup failed');

    const now = await acceptTransfer(ctx.db, {
      id: made.transfer.id,
      actorId: ctx.users.writer.id,
      now: NOW + 1,
    });

    expect(now).toMatchObject({ id: ctx.users.writer.id, role: 'owner' });
    expect(await roleOf(ctx.users.writer.email)).toBe('owner');
    /* The outgoing owner becomes a DEVELOPER: owner-grade access everywhere,
       minus the power to remove or demote the new owner. Handing over must not
       lock the previous owner out of their own store. */
    expect(await roleOf(ctx.users.owner.email)).toBe('developer');
    expect(await ownerCount()).toBe(1);

    // Spent, and no longer offered to anybody.
    expect(await pendingTransfer(ctx.db, NOW + 2)).toBeNull();
  });

  it('is refused for anybody who is not the named recipient', async () => {
    const made = await propose(ctx.users.writer.id);
    if (!made.ok) throw new Error('setup failed');

    const stolen = await acceptTransfer(ctx.db, {
      id: made.transfer.id,
      actorId: ctx.users.developer.id,
      now: NOW + 1,
    });

    expect(stolen).toBeNull();
    expect(await roleOf(ctx.users.developer.email)).toBe('developer');
    expect(await ownerCount()).toBe(1);
    // Still live for the person it was actually meant for.
    expect(await pendingTransfer(ctx.db, NOW + 1)).not.toBeNull();
  });

  it('is refused once it has lapsed, and nothing moves', async () => {
    const made = await propose(ctx.users.writer.id);
    if (!made.ok) throw new Error('setup failed');

    const late = NOW + TRANSFER_TTL_MS + 1;
    expect(await pendingTransfer(ctx.db, late)).toBeNull();
    expect(
      await acceptTransfer(ctx.db, { id: made.transfer.id, actorId: ctx.users.writer.id, now: late }),
    ).toBeNull();
    expect(await roleOf(ctx.users.writer.email)).toBe('writer');
    expect(await ownerCount()).toBe(1);
  });

  it('is refused when the proposer is no longer the owner', async () => {
    /*
     * THE CASE THE `demote` GUARD EXISTS FOR. Somebody proposes a transfer,
     * ownership moves elsewhere by another route, and the stale proposal is
     * then accepted. Without `AND role = 'owner'` on the demotion the recipient
     * would be promoted while the real owner kept the role — two owners, from a
     * row that looked perfectly valid.
     */
    const made = await propose(ctx.users.writer.id);
    if (!made.ok) throw new Error('setup failed');

    await ctx.db.execute(
      sql`UPDATE users SET role = 'developer' WHERE email = ${ctx.users.owner.email}`,
    );
    await ctx.db.execute(
      sql`UPDATE users SET role = 'owner' WHERE email = ${ctx.users.developer.email}`,
    );

    expect(
      await acceptTransfer(ctx.db, {
        id: made.transfer.id,
        actorId: ctx.users.writer.id,
        now: NOW + 1,
      }),
    ).toBeNull();

    expect(await roleOf(ctx.users.writer.email)).toBe('writer');
    expect(await ownerCount()).toBe(1);
  });

  it('is refused for a recipient revoked between proposal and acceptance', async () => {
    const made = await propose(ctx.users.writer.id);
    if (!made.ok) throw new Error('setup failed');

    await ctx.db.execute(
      sql`UPDATE users SET disabled_at = ${NOW} WHERE email = ${ctx.users.writer.email}`,
    );

    expect(
      await acceptTransfer(ctx.db, {
        id: made.transfer.id,
        actorId: ctx.users.writer.id,
        now: NOW + 1,
      }),
    ).toBeNull();

    /*
     * AND THE OUTGOING OWNER KEEPS THE ROLE. This is the assertion that would
     * catch a swap written as two statements: the demotion must not survive a
     * promotion that did not happen, or the store is left with no owner at all
     * and `disableUser`'s last-owner guard has nothing to protect.
     */
    expect(await roleOf(ctx.users.owner.email)).toBe('owner');
    expect(await ownerCount()).toBe(1);
  });
});

describe('cancelling', () => {
  it('lets the sender withdraw, after which acceptance does nothing', async () => {
    const made = await propose(ctx.users.writer.id);
    if (!made.ok) throw new Error('setup failed');

    expect(
      await cancelTransfer(ctx.db, {
        id: made.transfer.id,
        actorId: ctx.users.owner.id,
        now: NOW + 1,
      }),
    ).toBe(true);
    expect(await pendingTransfer(ctx.db, NOW + 2)).toBeNull();
    expect(
      await acceptTransfer(ctx.db, {
        id: made.transfer.id,
        actorId: ctx.users.writer.id,
        now: NOW + 3,
      }),
    ).toBeNull();
    expect(await ownerCount()).toBe(1);
  });

  it('lets the RECIPIENT decline — the same row, the same outcome', async () => {
    const made = await propose(ctx.users.writer.id);
    if (!made.ok) throw new Error('setup failed');

    expect(
      await cancelTransfer(ctx.db, {
        id: made.transfer.id,
        actorId: ctx.users.writer.id,
        now: NOW + 1,
      }),
    ).toBe(true);
    expect(await pendingTransfer(ctx.db, NOW + 2)).toBeNull();
  });

  it('refuses a stranger, so declining is not a thing bystanders can do', async () => {
    const made = await propose(ctx.users.writer.id);
    if (!made.ok) throw new Error('setup failed');

    expect(
      await cancelTransfer(ctx.db, {
        id: made.transfer.id,
        actorId: ctx.users.developer.id,
        now: NOW + 1,
      }),
    ).toBe(false);
    expect(await pendingTransfer(ctx.db, NOW + 2)).not.toBeNull();
  });

  it('frees the slot, so a withdrawn proposal can be replaced', async () => {
    const first = await propose(ctx.users.writer.id);
    if (!first.ok) throw new Error('setup failed');
    await cancelTransfer(ctx.db, {
      id: first.transfer.id,
      actorId: ctx.users.owner.id,
      now: NOW + 1,
    });

    /* The partial unique index counts only PENDING rows, so a cancelled one
       must not wedge the instance out of ever transferring again. */
    const second = await propose(ctx.users.developer.id, NOW + 2);
    expect(second.ok).toBe(true);
  });
});

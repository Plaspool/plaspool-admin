import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED_PASSWORD, freshDb } from '../../test/harness';
import { httpClient } from '../../test/http';
import type { TestCtx } from '../../test/harness';
import type { HttpClient } from '../../test/http';
import type { AuthUser } from '../../../shared/types';
import { createCustomer, createCustomerSession } from '../cart/identity/customers';
import { SHOP_SESSION_COOKIE } from '../cart/identity/cookies';
import { givePurchase } from './test/purchases';

/**
 * Review replies and reactions (migration 0620), driven through the REAL app.
 *
 * The claims worth testing here are the ones a repo-level suite would miss:
 * that two levels is the ceiling and a third is refused with a reason rather
 * than a constraint violation; that a customer reply is invisible until
 * approved while an owner reply is visible at once; that one customer is one
 * vote no matter how many times they click; and — the one most likely to be
 * got wrong — that the DISLIKE tally never reaches the public wire while the
 * helpful count does.
 */

let ctx: TestCtx;
let owner: HttpClient;
let anon: HttpClient;
let shopper: { id: string; cookie: string };
let other: { id: string; cookie: string };

const SUBMIT = '/api/shop/reviews/submit';
const ADMIN = '/api/shop/reviews';
const PUBLIC_LIST = '/api/public/reviews';
const MINE = '/api/shop/reviews/reactions/mine';

async function login(user: AuthUser): Promise<HttpClient> {
  const client = httpClient(ctx.db);
  expect(
    (await client.post('/api/auth/login', { email: user.email, password: SEED_PASSWORD }))
      .status,
  ).toBe(200);
  return client;
}

async function signedInCustomer(
  email: string,
  displayName: string | null,
): Promise<{ id: string; cookie: string }> {
  const customer = await createCustomer(ctx.db, { email, displayName });
  const session = await createCustomerSession(ctx.db, customer.id);
  return { id: customer.id, cookie: `${SHOP_SESSION_COOKIE}=${session.token}` };
}

let nextIp = 0;
function ipOf(cookie?: string): { headers: Record<string, string> } {
  nextIp += 1;
  const headers: Record<string, string> = { 'x-real-ip': `198.51.100.${nextIp % 250}` };
  if (cookie) headers.cookie = cookie;
  return { headers };
}

beforeAll(async () => {
  ctx = await freshDb();
  owner = await login(ctx.users.owner);
  anon = httpClient(ctx.db);
  shopper = await signedInCustomer('shopper@example.com', 'Dara');
  other = await signedInCustomer('other@example.com', 'Tunde');
  /* Both must have BOUGHT the product to reply to or vote on its reviews —
     the purchase gate (brief §2). Everything in this file is about threads,
     so the purchase is fixture, not subject. */
  await givePurchase(ctx.db, { slug: 'pla-basic', customerId: shopper.id });
  await givePurchase(ctx.db, { slug: 'pla-basic', customerId: other.id });
});

afterAll(async () => {
  await ctx?.close();
});

/**
 * An APPROVED review to hang threads off — the fixture everything needs.
 *
 * A NEW AUTHOR EACH TIME, because one customer may review one product once.
 * Reusing `shopper` would 403 every call after the first; and the reviews here
 * all have to sit on `pla-basic` so the public list can find them together.
 */
let authors = 0;
async function approvedReview(): Promise<string> {
  authors += 1;
  const author = await signedInCustomer(`author-${authors}@example.com`, 'Author');
  await givePurchase(ctx.db, { slug: 'pla-basic', customerId: author.id });
  const res = await anon.post(
    SUBMIT,
    {
      productSlug: 'pla-basic',
      rating: 5,
      body: 'Prints clean, great colour, would recommend to anyone.',
      authorName: 'Dara',
    },
    ipOf(author.cookie),
  );
  expect(res.status).toBe(201);
  const { reviewId } = (await res.json()) as { reviewId: string };
  expect((await owner.patch(`${ADMIN}/${reviewId}`, { status: 'approved' })).status).toBe(200);
  return reviewId;
}

const publicItems = async (): Promise<
  Array<{ id: string; replies: unknown[]; helpfulCount: number }>
> => {
  const res = await anon.get(`${PUBLIC_LIST}?product=pla-basic`);
  const body = (await res.json()) as {
    items: Array<{ id: string; replies: unknown[]; helpfulCount: number }>;
  };
  return body.items;
};

const publicReview = async (id: string) => (await publicItems()).find((r) => r.id === id);

// ---------------------------------------------------------------- replies

describe('customer replies', () => {
  it('needs a customer session', async () => {
    const reviewId = await approvedReview();
    const res = await anon.post(`${ADMIN}/${reviewId}/replies`, { body: 'Me too!' }, ipOf());
    expect(res.status).toBe(401);
  });

  it('lands PENDING and is invisible publicly until approved', async () => {
    const reviewId = await approvedReview();
    const res = await anon.post(
      `${ADMIN}/${reviewId}/replies`,
      { body: 'I had the same experience with mine.' },
      ipOf(shopper.cookie),
    );
    expect(res.status).toBe(201);
    const { replyId, status } = (await res.json()) as { replyId: string; status: string };
    expect(status).toBe('pending');

    // Invisible.
    expect((await publicReview(reviewId))?.replies).toEqual([]);

    // …until a human says otherwise.
    expect((await owner.patch(`/api/shop/replies/${replyId}`, { status: 'approved' })).status).toBe(
      200,
    );
    const replies = (await publicReview(reviewId))?.replies as Array<Record<string, unknown>>;
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      id: replyId,
      depth: 0,
      parentId: null,
      authorKind: 'customer',
      // The session's display name, not anything the body could have said.
      authorName: 'Dara',
    });
  });

  it('never puts the replier\'s email or customer id on the public wire', async () => {
    const reviewId = await approvedReview();
    const res = await anon.post(
      `${ADMIN}/${reviewId}/replies`,
      { body: 'A perfectly ordinary reply about filament.' },
      ipOf(shopper.cookie),
    );
    const { replyId } = (await res.json()) as { replyId: string };
    await owner.patch(`/api/shop/replies/${replyId}`, { status: 'approved' });

    const replies = (await publicReview(reviewId))?.replies as Array<Record<string, unknown>>;
    expect(Object.keys(replies[0]!).sort()).toEqual([
      'authorKind',
      'authorName',
      'body',
      'createdAt',
      'depth',
      'id',
      'parentId',
    ]);
  });

  it('refuses a reply to a review that is not approved — and says only "gone"', async () => {
    // A different answer for "missing" and "pending" would tell an anonymous
    // caller which pending reviews exist.
    const res = await anon.post(
      `${ADMIN}/rev_nope/replies`,
      { body: 'Replying into the void.' },
      ipOf(shopper.cookie),
    );
    expect(res.status).toBe(404);
  });
});

describe('the owner reply', () => {
  it('is approved the moment it is written, and bylined as the SHOP', async () => {
    const reviewId = await approvedReview();
    const res = await owner.post(`${ADMIN}/${reviewId}/staff-replies`, {
      body: 'Thanks Dara — glad it printed well for you.',
    });
    expect(res.status).toBe(201);

    // Visible immediately: no moderation step.
    const replies = (await publicReview(reviewId))?.replies as Array<Record<string, unknown>>;
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ authorKind: 'owner', authorName: 'PlaSpool', depth: 0 });
  });

  it('records WHICH staff member wrote it, and never publishes that', async () => {
    const reviewId = await approvedReview();
    const res = await owner.post(`${ADMIN}/${reviewId}/staff-replies`, {
      body: 'We have sent you a replacement spool.',
    });
    const { reply } = (await res.json()) as { reply: { staffUserId: string | null } };
    // Admin sees the author…
    expect(reply.staffUserId).toBe(ctx.users.owner.id);
    // …the public sees the shop.
    const replies = (await publicReview(reviewId))?.replies as Array<Record<string, unknown>>;
    expect(replies[0]).not.toHaveProperty('staffUserId');
    expect(replies[0]!.authorName).toBe('PlaSpool');
  });

  it('needs staff auth', async () => {
    const reviewId = await approvedReview();
    expect(
      (await anon.post(`${ADMIN}/${reviewId}/staff-replies`, { body: 'Not the owner.' })).status,
    ).toBe(401);
  });
});

describe('thread depth', () => {
  it('allows a reply TO a reply', async () => {
    const reviewId = await approvedReview();
    const first = await owner.post(`${ADMIN}/${reviewId}/staff-replies`, {
      body: 'Thanks for the kind words.',
    });
    const { reply } = (await first.json()) as { reply: { id: string } };

    const second = await anon.post(
      `${ADMIN}/${reviewId}/replies`,
      { parentId: reply.id, body: 'Seconding this, mine arrived quickly too.' },
      ipOf(shopper.cookie),
    );
    expect(second.status).toBe(201);
    const { replyId } = (await second.json()) as { replyId: string };
    await owner.patch(`/api/shop/replies/${replyId}`, { status: 'approved' });

    const replies = (await publicReview(reviewId))?.replies as Array<Record<string, unknown>>;
    expect(replies.find((r) => r.id === replyId)).toMatchObject({
      depth: 1,
      parentId: reply.id,
    });
  });

  it('REFUSES a third level, naming the field rather than leaking a constraint', async () => {
    // Two levels is the design. A 23514 from the CHECK would name a constraint
    // the caller has never heard of; this is refused before the insert.
    const reviewId = await approvedReview();
    const a = await owner.post(`${ADMIN}/${reviewId}/staff-replies`, { body: 'Level zero.' });
    const { reply: lvl0 } = (await a.json()) as { reply: { id: string } };
    const b = await owner.post(`${ADMIN}/${reviewId}/staff-replies`, {
      parentId: lvl0.id,
      body: 'Level one.',
    });
    const { reply: lvl1 } = (await b.json()) as { reply: { id: string } };

    const c = await owner.post(`${ADMIN}/${reviewId}/staff-replies`, {
      parentId: lvl1.id,
      body: 'Level two, which must not exist.',
    });
    expect(c.status).toBe(400);
    expect(await c.json()).toMatchObject({ error: 'bad_request', detail: 'parentId' });
  });

  it('refuses a parent that belongs to a DIFFERENT review', async () => {
    const [one, two] = [await approvedReview(), await approvedReview()];
    const a = await owner.post(`${ADMIN}/${one}/staff-replies`, { body: 'On review one.' });
    const { reply } = (await a.json()) as { reply: { id: string } };

    const crossed = await owner.post(`${ADMIN}/${two}/staff-replies`, {
      parentId: reply.id,
      body: 'Trying to graft this onto review two.',
    });
    expect(crossed.status).toBe(404);
  });
});

// -------------------------------------------------------------- reactions

describe('reactions', () => {
  it('needs a session to vote, but not to read the count', async () => {
    const reviewId = await approvedReview();
    expect(
      (await anon.put(`${ADMIN}/${reviewId}/reactions`, { kind: 'helpful' }, ipOf())).status,
    ).toBe(401);
    // The count is public and readable by anyone.
    expect((await publicReview(reviewId))?.helpfulCount).toBe(0);
  });

  it('is ONE vote per customer however many times they click', async () => {
    const reviewId = await approvedReview();
    for (let i = 0; i < 4; i += 1) {
      const res = await anon.put(
        `${ADMIN}/${reviewId}/reactions`,
        { kind: 'helpful' },
        ipOf(shopper.cookie),
      );
      expect(res.status).toBe(200);
    }
    expect((await publicReview(reviewId))?.helpfulCount).toBe(1);
  });

  it('counts two different customers separately', async () => {
    const reviewId = await approvedReview();
    await anon.put(`${ADMIN}/${reviewId}/reactions`, { kind: 'helpful' }, ipOf(shopper.cookie));
    await anon.put(`${ADMIN}/${reviewId}/reactions`, { kind: 'helpful' }, ipOf(other.cookie));
    expect((await publicReview(reviewId))?.helpfulCount).toBe(2);
  });

  it('flips from helpful to unhelpful without leaving both behind', async () => {
    const reviewId = await approvedReview();
    await anon.put(`${ADMIN}/${reviewId}/reactions`, { kind: 'helpful' }, ipOf(shopper.cookie));
    expect((await publicReview(reviewId))?.helpfulCount).toBe(1);

    const flipped = await anon.put(
      `${ADMIN}/${reviewId}/reactions`,
      { kind: 'unhelpful' },
      ipOf(shopper.cookie),
    );
    expect(flipped.status).toBe(200);
    expect(await flipped.json()).toMatchObject({ viewerReaction: 'unhelpful', helpfulCount: 0 });
    expect((await publicReview(reviewId))?.helpfulCount).toBe(0);
  });

  it('clears with an explicit null rather than a second identical click', async () => {
    const reviewId = await approvedReview();
    await anon.put(`${ADMIN}/${reviewId}/reactions`, { kind: 'helpful' }, ipOf(shopper.cookie));
    const cleared = await anon.put(
      `${ADMIN}/${reviewId}/reactions`,
      { kind: null },
      ipOf(shopper.cookie),
    );
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ viewerReaction: null, helpfulCount: 0 });
  });

  it('NEVER puts the dislike tally on the public wire', async () => {
    /*
     * The claim 0620 exists to keep: a public dislike count is a scoreboard for
     * brigading. The owner still gets the signal in the admin; the shopper does
     * not get a number to organise around.
     */
    const reviewId = await approvedReview();
    await anon.put(`${ADMIN}/${reviewId}/reactions`, { kind: 'unhelpful' }, ipOf(shopper.cookie));
    await anon.put(`${ADMIN}/${reviewId}/reactions`, { kind: 'unhelpful' }, ipOf(other.cookie));

    const review = (await publicReview(reviewId)) as unknown as Record<string, unknown>;
    expect(review.helpfulCount).toBe(0);
    expect(review).not.toHaveProperty('unhelpfulCount');
    expect(JSON.stringify(review)).not.toContain('unhelpful');
  });

  it('refuses a reaction on a review that is not approved', async () => {
    expect(
      (await anon.put(`${ADMIN}/rev_nope/reactions`, { kind: 'helpful' }, ipOf(shopper.cookie)))
        .status,
    ).toBe(404);
  });
});

describe('the viewer\'s own reactions', () => {
  it('is a SEPARATE route from the cacheable public list, and says which ones are mine', async () => {
    /*
     * WHY IT IS NOT ON `/api/public/reviews`: that router sits above
     * `sessionMiddleware` and every response there carries `Cache-Control:
     * public`, so a shared cache may hand one reader's copy to another. A
     * per-viewer field on it is threat T6 — one shopper seeing another's votes.
     */
    const reviewId = await approvedReview();
    await anon.put(`${ADMIN}/${reviewId}/reactions`, { kind: 'helpful' }, ipOf(shopper.cookie));

    const res = await anon.get(`${MINE}?reviews=${reviewId}`, ipOf(shopper.cookie));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reactions: { [reviewId]: 'helpful' } });
  });

  it('answers an EMPTY map for a logged-out reader rather than a 401', async () => {
    // A signed-out shopper reading a product page is not an error; the
    // storefront should draw unfilled buttons, not handle a refusal on a read.
    const reviewId = await approvedReview();
    const res = await anon.get(`${MINE}?reviews=${reviewId}`, ipOf());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reactions: {} });
  });

  it('does not report ANOTHER customer\'s vote as mine', async () => {
    const reviewId = await approvedReview();
    await anon.put(`${ADMIN}/${reviewId}/reactions`, { kind: 'helpful' }, ipOf(other.cookie));
    const res = await anon.get(`${MINE}?reviews=${reviewId}`, ipOf(shopper.cookie));
    expect(await res.json()).toEqual({ reactions: {} });
  });
});

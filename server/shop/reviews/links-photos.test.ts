import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import { httpClient } from '../../test/http';
import type { TestCtx } from '../../test/harness';
import type { HttpClient } from '../../test/http';
import { createCustomer, createCustomerSession } from '../cart/identity/customers';
import { SHOP_SESSION_COOKIE } from '../cart/identity/cookies';
import { givePurchase } from './test/purchases';
import { mintReviewLinkToken } from './review-link';
import { cleanReviewPhoto, stripJpegMetadata, stripPngMetadata, stripWebpMetadata } from './photos';

/**
 * REVIEW LINKS AND REVIEW PHOTOS (migration 1280), through the REAL
 * `createApp()` — the composition root is where the customer resolver is wired,
 * and CLAUDE.md §2 records twice what a test app hides.
 *
 * R2 is the only thing stubbed: `putObject` records what would be stored, so
 * the test can assert the STORED bytes carry no location metadata.
 */
const stored = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock('../../storage/r2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../storage/r2')>()),
  putObject: vi.fn(async (key: string, bytes: Uint8Array) => {
    stored.set(key, bytes);
  }),
  presignGet: vi.fn(async (key: string) => `https://r2.test/${key}?get`),
}));

let ctx: TestCtx;
let owner: HttpClient;
let anon: HttpClient;

let ips = 0;
function ip(extra: Record<string, string> = {}): Record<string, string> {
  ips += 1;
  return { 'x-real-ip': `203.0.113.${(ips % 250) + 1}`, ...extra };
}

function reviewBody(over: Record<string, unknown> = {}) {
  return {
    productSlug: 'link-product',
    rating: 5,
    body: 'Printed beautifully, no stringing at all on the first roll.',
    ...over,
  };
}

// ------------------------------------------------------------------ fixtures

const GPS = Array.from('GPSLatitude 9.0765N', (ch) => ch.charCodeAt(0));

/** A tiny but walkable JPEG: SOI, APP0, APP1 (EXIF with a "GPS" payload), SOF0, SOS, data, EOI. */
function jpegWithGps(): Uint8Array {
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...GPS];
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xe1, 0x00, exif.length + 2, ...exif,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00,
    0x12, 0x34, 0x56,
    0xff, 0xd9,
  ]);
}

function chunk(type: string, data: number[]): number[] {
  const len = data.length;
  /* CRC is not checked by the stripper, so zeros are fine here. */
  return [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255,
    ...Array.from(type, (c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
}

function pngWithText(): Uint8Array {
  const ihdr = [0, 0, 0, 4, 0, 0, 0, 5, 8, 6, 0, 0, 0];
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', ihdr),
    ...chunk('tEXt', GPS),
    ...chunk('eXIf', GPS),
    ...chunk('IDAT', [1, 2, 3]),
    ...chunk('IEND', []),
  ]);
}

function le32(n: number): number[] {
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
}

function webpWithExif(): Uint8Array {
  const vp8x = [0x0c, 0, 0, 0, 3, 0, 0, 4, 0, 0];
  const exif = [...GPS]; // odd length on purpose — exercises the pad byte
  const vp8l = [0x2f, 3, 0x40, 0, 0];
  const body = [
    ...Array.from('VP8X', (c) => c.charCodeAt(0)), ...le32(vp8x.length), ...vp8x,
    ...Array.from('EXIF', (c) => c.charCodeAt(0)), ...le32(exif.length), ...exif, ...(exif.length % 2 ? [0] : []),
    ...Array.from('VP8L', (c) => c.charCodeAt(0)), ...le32(vp8l.length), ...vp8l, 0,
  ];
  return new Uint8Array([
    ...Array.from('RIFF', (c) => c.charCodeAt(0)), ...le32(4 + body.length),
    ...Array.from('WEBP', (c) => c.charCodeAt(0)), ...body,
  ]);
}

function containsGps(bytes: Uint8Array): boolean {
  return Buffer.from(bytes).includes(Buffer.from('GPSLatitude'));
}

beforeAll(async () => {
  ctx = await freshDb();
  owner = httpClient(ctx.db);
  await owner.signIn(ctx.users.owner);
  anon = httpClient(ctx.db);
});

afterAll(async () => {
  await ctx?.close();
});

// ------------------------------------------------------------------ bytes

describe('location metadata is removed from every photo before it is stored', () => {
  it('JPEG: APP1 goes, the image data stays', () => {
    const input = jpegWithGps();
    expect(containsGps(input)).toBe(true);
    const out = stripJpegMetadata(input)!;
    expect(containsGps(out)).toBe(false);
    expect(Buffer.from(out).includes(Buffer.from([0x12, 0x34, 0x56]))).toBe(true);
    const cleaned = cleanReviewPhoto(input);
    expect(cleaned).toMatchObject({ ok: true, type: 'image/jpeg', width: 3, height: 2 });
  });

  it('PNG: tEXt and eXIf go', () => {
    const out = stripPngMetadata(pngWithText())!;
    expect(containsGps(out)).toBe(false);
    expect(cleanReviewPhoto(pngWithText())).toMatchObject({ ok: true, type: 'image/png', width: 4, height: 5 });
  });

  it('WebP: the EXIF chunk goes, its flag is cleared and the RIFF size still adds up', () => {
    const out = stripWebpMetadata(webpWithExif())!;
    expect(containsGps(out)).toBe(false);
    const riffSize = out[4]! | (out[5]! << 8) | (out[6]! << 16) | (out[7]! << 24);
    expect(riffSize + 8).toBe(out.length);
    expect(out[20]! & 0x0c).toBe(0);
  });

  it('refuses something that is not an image, whatever it is called', () => {
    expect(cleanReviewPhoto(new TextEncoder().encode('<html><script>1</script>'))).toEqual({
      ok: false,
      reason: 'type',
    });
  });

  it('refuses a truncated JPEG rather than storing it unwalked', () => {
    expect(cleanReviewPhoto(jpegWithGps().subarray(0, 30))).toMatchObject({ ok: false });
  });
});

// ------------------------------------------------------------------ links

describe('review links', () => {
  it('the owner copies a link off a paid order, and it opens that order’s products', async () => {
    const purchase = await givePurchase(ctx.db, { slug: 'link-product', email: 'guest1@example.com' });

    const res = await owner.post(`/api/shop/admin/orders/${purchase.orderId}/review-link`);
    expect(res.status).toBe(200);
    const { url, expiresAt } = (await res.json()) as { url: string; expiresAt: number };
    expect(url).toMatch(/^https:\/\/[^/]+\/review\?token=/);
    expect(expiresAt).toBeGreaterThan(Date.now());

    const token = new URL(url).searchParams.get('token')!;
    const opened = await anon.get(`/api/shop/reviews/link?token=${encodeURIComponent(token)}`, {
      headers: ip(),
    });
    expect(opened.status).toBe(200);
    expect(opened.headers.get('cache-control')).toBe('no-store');
    const page = (await opened.json()) as Record<string, unknown>;
    expect(page).toMatchObject({
      firstName: 'Test',
      products: [{ slug: 'link-product', title: 'Test link-product', reviewed: false }],
    });
    /* Nothing about the buyer beyond a first name crosses the origin. */
    expect(JSON.stringify(page)).not.toContain('guest1@example.com');
  });

  it('refuses to mint one for an unpaid order', async () => {
    const pending = await givePurchase(ctx.db, { slug: 'link-product', status: 'pending' });
    const res = await owner.post(`/api/shop/admin/orders/${pending.orderId}/review-link`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ detail: 'order_not_paid' });
  });

  it('a stranger cannot mint one', async () => {
    const purchase = await givePurchase(ctx.db, { slug: 'link-product' });
    const res = await anon.post(`/api/shop/admin/orders/${purchase.orderId}/review-link`);
    expect(res.status).toBe(401);
  });

  it('writes a review WITHOUT a session, as the buyer on the order, and only once', async () => {
    const purchase = await givePurchase(ctx.db, { slug: 'link-product', email: 'Guest2@Example.com' });
    const { token } = mintReviewLinkToken(purchase.orderId, Date.now());

    const first = await anon.post(SUBMIT, reviewBody({ reviewLink: token }), { headers: ip() });
    expect(first.status).toBe(201);
    const { reviewId } = (await first.json()) as { reviewId: string };
    const row = await ctx.db.execute(sql`
      SELECT order_id, author_email, author_name, status FROM shop_reviews WHERE id = ${reviewId}`);
    expect(row.rows[0]).toMatchObject({
      order_id: purchase.orderId,
      author_email: 'Guest2@Example.com',
      author_name: 'Test',
      status: 'pending',
    });

    const again = await anon.post(SUBMIT, reviewBody({ reviewLink: token }), { headers: ip() });
    expect(again.status).toBe(403);
    expect(await again.json()).toMatchObject({ reason: 'already_reviewed' });
  });

  it('cannot review a product that was not on the linked order', async () => {
    const purchase = await givePurchase(ctx.db, { slug: 'link-product', email: 'guest3@example.com' });
    await givePurchase(ctx.db, { slug: 'other-product', email: 'someone-else@example.com' });
    const { token } = mintReviewLinkToken(purchase.orderId, Date.now());
    const res = await anon.post(SUBMIT, reviewBody({ reviewLink: token, productSlug: 'other-product' }), {
      headers: ip(),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'purchase_required' });
  });

  it('refuses a forged, tampered or expired link', async () => {
    const purchase = await givePurchase(ctx.db, { slug: 'link-product', email: 'guest4@example.com' });
    const { token } = mintReviewLinkToken(purchase.orderId, Date.now());
    const expired = mintReviewLinkToken(purchase.orderId, Date.now() - 10_000, 1).token;
    const [payload, sig] = token.split('.');
    const otherPayload = Buffer.from(JSON.stringify({ o: 'ord_someone', exp: Date.now() + 1e9 })).toString('base64url');

    for (const bad of ['nonsense', `${otherPayload}.${sig}`, `${payload}.${'0'.repeat(64)}`, expired]) {
      const res = await anon.post(SUBMIT, reviewBody({ reviewLink: bad }), { headers: ip() });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ reason: 'review_link_invalid' });
    }
  });

  it('answers the storefront’s preflight with credentials allowed', async () => {
    const res = await anon.request('/api/shop/reviews/photos', {
      method: 'OPTIONS',
      headers: { 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });
});

// ------------------------------------------------------------------ photos

const SUBMIT = '/api/shop/reviews/submit';

async function upload(file: Uint8Array, type: string, extra: Record<string, string> = {}, cookie?: string) {
  const form = new FormData();
  form.set('file', new Blob([file], { type }), 'photo');
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return anon.request('/api/shop/reviews/photos', {
    method: 'POST',
    body: form,
    headers: ip(cookie ? { cookie } : {}),
  });
}

describe('review photos', () => {
  it('upload through a link → attach on submit → public only once approved', async () => {
    const purchase = await givePurchase(ctx.db, { slug: 'photo-product', email: 'photos@example.com' });
    const { token } = mintReviewLinkToken(purchase.orderId, Date.now());

    const up = await upload(jpegWithGps(), 'image/jpeg', { reviewLink: token });
    expect(up.status).toBe(201);
    const { photoId } = (await up.json()) as { photoId: string };

    /* The STORED bytes, not the uploaded ones, are what matter. */
    const [key, bytes] = [...stored.entries()].find(([k]) => k.includes(photoId))!;
    expect(key).toBe(`reviews/${photoId}.jpg`);
    expect(containsGps(bytes)).toBe(false);

    /* Not public while it is on no review. */
    expect((await anon.get(`/api/public/reviews/photos/${photoId}`)).status).toBe(404);

    const sub = await anon.post(
      SUBMIT,
      reviewBody({ productSlug: 'photo-product', reviewLink: token, photoIds: [photoId] }),
      { headers: ip() },
    );
    expect(sub.status).toBe(201);
    const { reviewId, photoCount } = (await sub.json()) as { reviewId: string; photoCount: number };
    expect(photoCount).toBe(1);

    /* Pending: still not public, but the moderator sees it. */
    expect((await anon.get(`/api/public/reviews/photos/${photoId}`)).status).toBe(404);
    const staff = await owner.get(`/api/shop/reviews/photos/${photoId}`, { redirect: 'manual' });
    expect(staff.status).toBe(302);
    const list = (await (await owner.get('/api/shop/reviews?status=pending')).json()) as {
      items: { id: string; photos: { id: string }[] }[];
    };
    expect(list.items.find((r) => r.id === reviewId)?.photos.map((p) => p.id)).toEqual([photoId]);

    await owner.patch(`/api/shop/reviews/${reviewId}`, { status: 'approved' });
    const pub = await anon.get(`/api/public/reviews/photos/${photoId}`, { redirect: 'manual' });
    expect(pub.status).toBe(302);
    expect(pub.headers.get('location')).toContain(`reviews/${photoId}.jpg`);

    const reviews = (await (await anon.get('/api/public/reviews?product=photo-product')).json()) as {
      items: { photos: { id: string; url: string; width: number }[] }[];
    };
    expect(reviews.items[0]!.photos).toEqual([
      { id: photoId, url: `/api/public/reviews/photos/${photoId}`, width: 3, height: 2 },
    ]);

    /* Turned down: the photo goes with it. */
    await owner.patch(`/api/shop/reviews/${reviewId}`, { status: 'rejected' });
    expect((await anon.get(`/api/public/reviews/photos/${photoId}`)).status).toBe(404);
  });

  it('a signed-in buyer uploads with their session', async () => {
    const row = await createCustomer(ctx.db, { email: 'session-photos@example.com', displayName: 'Ada' });
    const session = await createCustomerSession(ctx.db, row.id);
    const cookie = `${SHOP_SESSION_COOKIE}=${session.token}`;
    await givePurchase(ctx.db, { slug: 'session-photo', customerId: row.id });

    const up = await upload(pngWithText(), 'image/png', {}, cookie);
    expect(up.status).toBe(201);
    const { photoId } = (await up.json()) as { photoId: string };

    const sub = await anon.post(SUBMIT, reviewBody({ productSlug: 'session-photo', photoIds: [photoId] }), {
      headers: ip({ cookie }),
    });
    expect(sub.status).toBe(201);
    expect(await sub.json()).toMatchObject({ photoCount: 1 });
  });

  it('nobody can attach somebody else’s photo', async () => {
    const a = await givePurchase(ctx.db, { slug: 'photo-product', email: 'owner-a@example.com' });
    const b = await givePurchase(ctx.db, { slug: 'photo-product', email: 'owner-b@example.com' });
    const up = await upload(jpegWithGps(), 'image/jpeg', { reviewLink: mintReviewLinkToken(a.orderId, Date.now()).token });
    const { photoId } = (await up.json()) as { photoId: string };

    const res = await anon.post(
      SUBMIT,
      reviewBody({
        productSlug: 'photo-product',
        reviewLink: mintReviewLinkToken(b.orderId, Date.now()).token,
        photoIds: [photoId],
      }),
      { headers: ip() },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ detail: 'photoIds' });
  });

  it('no session and no link is a 401; a non-image is refused', async () => {
    expect((await upload(jpegWithGps(), 'image/jpeg')).status).toBe(401);

    const purchase = await givePurchase(ctx.db, { slug: 'photo-product', email: 'html@example.com' });
    const res = await upload(new TextEncoder().encode('<svg onload=alert(1)>'), 'image/jpeg', {
      reviewLink: mintReviewLinkToken(purchase.orderId, Date.now()).token,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ detail: 'file_type' });
  });

  it('refuses more than four photos on one review', async () => {
    const purchase = await givePurchase(ctx.db, { slug: 'photo-product', email: 'five@example.com' });
    const res = await anon.post(
      SUBMIT,
      reviewBody({
        productSlug: 'photo-product',
        reviewLink: mintReviewLinkToken(purchase.orderId, Date.now()).token,
        photoIds: ['a', 'b', 'c', 'd', 'e'],
      }),
      { headers: ip() },
    );
    expect(res.status).toBe(400);
  });
});

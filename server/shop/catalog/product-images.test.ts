/**
 * Product images: the write-time existence check, and the storefront's resolved
 * URLs (HANDOFF §2 A5.2 and A5.4).
 *
 * WHAT WAS WRONG. `shop_products.cover_image_id` and `image_ids` were
 * shape-validated and nothing more — `routes.ts` bounded their length and
 * `products.ts` stored whatever arrived. `{"coverImageId":"not-an-image"}` was
 * accepted, persisted, shipped on the storefront response and rendered as a
 * broken image, with the first thing capable of noticing being a customer's
 * browser. There is no foreign key to lean on: contract R3 forbids one across the
 * subsystem boundary, so the check is a statement the write path runs.
 *
 * AND THE URLS WERE NEVER RESOLVED AT ALL. The storefront shipped raw ids and
 * left every consumer to invent `/api/public/images/:id` for itself — including
 * the normalisation of the optional `asset:` prefix, which is the exact step
 * whose omission `server/repo/public-projection.ts` records as a live 404.
 *
 * Repository assertions call the repository; the two routes go through the real
 * app, for the split `routes.test.ts` states — the seam is where the defects are.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, SEED_PASSWORD, type TestCtx } from '../../test/harness';
import { httpClient, json, type HttpClient } from '../../test/http';
import { BadRequestError } from '../../repo/errors';
import { createProduct, getProduct, publishProduct, saveProduct } from './products';
import { toStorefrontProduct, toStorefrontVariant } from './mapping';
import { rejection } from './test/catalog-harness';
import type { Product, VariantWithPrice } from './types';

let ctx: TestCtx;
let http: HttpClient;
const actor = () => ctx.users.owner;

beforeAll(async () => {
  ctx = await freshDb();
  http = httpClient(ctx.db);
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM shop_products`);
  await ctx.db.execute(sql`DELETE FROM images`);
});

/**
 * An image row placed directly, so a test controls `committed_at`.
 *
 * The route path to a committed image is slot → presigned PUT → magic-byte check
 * → commit, none of which is what this suite is about, and two of which need R2.
 */
async function seedImage(id: string, committed = true): Promise<string> {
  const user = actor();
  const now = Date.now();
  await ctx.db.execute(sql`
    INSERT INTO images (id, owner_id, storage_key, content_type, width, height,
                        byte_size, checksum, created_at, committed_at,
                        unreferenced_since)
    VALUES (${id}, ${user.id}::uuid, ${`images/${user.id}/${id}`},
            'image/png', NULL, NULL, 1000, NULL, ${now},
            ${committed ? now : null}, NULL)`);
  return id;
}

async function productCount(): Promise<number> {
  const res = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM shop_products`);
  return Number(res.rows[0].n);
}

/** The stored columns, read raw — the mapper is not the thing under test. */
async function storedRefs(id: string): Promise<{ cover: string | null; gallery: string[] }> {
  const res = await ctx.db.execute(
    sql`SELECT cover_image_id, image_ids FROM shop_products WHERE id = ${id}`,
  );
  const row = res.rows[0];
  return {
    cover: row.cover_image_id == null ? null : String(row.cover_image_id),
    gallery: Array.isArray(row.image_ids) ? row.image_ids.map(String) : [],
  };
}

// ------------------------------------------------------------------- create

describe('createProduct validates every image id', () => {
  it('accepts a committed image as cover and as a gallery entry', async () => {
    await seedImage('img_cover');
    await seedImage('img_one');
    await seedImage('img_two');

    const product = await createProduct(ctx.db, actor(), {
      title: 'Photographed',
      coverImageId: 'img_cover',
      imageIds: ['img_one', 'img_two'],
    });

    expect(product.coverImageId).toBe('img_cover');
    expect(product.imageIds).toEqual(['img_one', 'img_two']);
  });

  it('refuses an unknown cover with detail "coverImageId", writing nothing', async () => {
    const before = await productCount();
    const err = await rejection<BadRequestError>(
      createProduct(ctx.db, actor(), { title: 'Broken', coverImageId: 'img_invented' }),
    );
    expect(err).toBeInstanceOf(BadRequestError);
    // The FIELD NAME, never the value — a 400 that echoed the id back would be
    // the error contract's one rule about `detail` broken on a new route.
    expect(err.detail).toBe('coverImageId');
    expect(await productCount()).toBe(before);
  });

  it('refuses an unknown gallery entry with detail "imageIds"', async () => {
    await seedImage('img_real');
    const err = await rejection<BadRequestError>(
      createProduct(ctx.db, actor(), {
        title: 'Half Broken',
        imageIds: ['img_real', 'img_invented'],
      }),
    );
    expect(err.detail).toBe('imageIds');
  });

  it('names the COVER when both fields are wrong, so a form marks one control', async () => {
    const err = await rejection<BadRequestError>(
      createProduct(ctx.db, actor(), {
        coverImageId: 'img_invented',
        imageIds: ['img_also_invented'],
      }),
    );
    expect(err.detail).toBe('coverImageId');
  });

  it('refuses an UNCOMMITTED image — a slot is on a countdown to not existing', async () => {
    /*
     * `sweepUncommitted` removes an uncommitted row within 24 hours and nobody
     * has magic-byte checked its bytes, so storing its id is storing something
     * that is scheduled to stop being true. `getPublicImage` applies the same
     * `committed_at IS NOT NULL` conjunct, so a write admitted here is a write
     * the public read can actually serve.
     */
    await seedImage('img_open', false);
    const err = await rejection<BadRequestError>(
      createProduct(ctx.db, actor(), { coverImageId: 'img_open' }),
    );
    expect(err.detail).toBe('coverImageId');
  });

  it('accepts an asset:- or idb:-prefixed id and stores it verbatim', async () => {
    /*
     * Normalised for the CHECK and not for the COLUMN. The reference walk, the
     * public serving check and the URL projection all normalise on read, so
     * rewriting what a client sent would change stored data for no gain — and a
     * check that did not normalise would refuse exactly the prefixed form the
     * rest of the system goes out of its way to accept.
     */
    await seedImage('img_schemed');
    const product = await createProduct(ctx.db, actor(), {
      title: 'Prefixed',
      coverImageId: 'asset:img_schemed',
      imageIds: ['idb:img_schemed'],
    });
    const stored = await storedRefs(product.id);
    expect(stored.cover).toBe('asset:img_schemed');
    expect(stored.gallery).toEqual(['idb:img_schemed']);
  });

  it('refuses an empty id in either field — null is how a cover is cleared', async () => {
    // Every consumer downstream already skips an empty id — the projection, the
    // orphan collector's `<> ''` guards, the public reference check — so storing
    // one is accepting a value that provably means nothing.
    expect(
      (await rejection<BadRequestError>(createProduct(ctx.db, actor(), { coverImageId: '' })))
        .detail,
    ).toBe('coverImageId');
    expect(
      (await rejection<BadRequestError>(createProduct(ctx.db, actor(), { imageIds: [''] })))
        .detail,
    ).toBe('imageIds');
  });

  it('is untouched by a product that names no images at all', async () => {
    const product = await createProduct(ctx.db, actor(), { title: 'No Pictures' });
    expect(product.coverImageId).toBeNull();
    expect(product.imageIds).toEqual([]);
  });

  it('accepts an image ANOTHER user uploaded', async () => {
    // Reads are universal in this deployment (`getImage` documents why). An
    // owner-scoped check would make a product built from a colleague's
    // photograph unsavable, with a refusal nobody could explain.
    const user = ctx.users.writer;
    const now = Date.now();
    await ctx.db.execute(sql`
      INSERT INTO images (id, owner_id, storage_key, content_type, width, height,
                          byte_size, checksum, created_at, committed_at,
                          unreferenced_since)
      VALUES ('img_writers', ${user.id}::uuid, 'images/writer/img_writers', 'image/png',
              NULL, NULL, 1000, NULL, ${now}, ${now}, NULL)`);

    const product = await createProduct(ctx.db, actor(), { coverImageId: 'img_writers' });
    expect(product.coverImageId).toBe('img_writers');
  });
});

// --------------------------------------------------------------------- save

describe('saveProduct validates the PATCH and never the merge', () => {
  it('refuses a patch that introduces an unknown cover', async () => {
    const product = await createProduct(ctx.db, actor(), { title: 'Editable' });
    const err = await rejection<BadRequestError>(
      saveProduct(ctx.db, product.id, { coverImageId: 'img_invented' }, { actor: actor() }),
    );
    expect(err.detail).toBe('coverImageId');
    // Nothing moved: not the revision, not the columns.
    expect((await getProduct(ctx.db, product.id))?.revision).toBe(1);
  });

  it('still saves a product whose STORED cover has already been collected', async () => {
    /*
     * The rule `patch.description` follows, applied to the same file's other
     * validator. A product carrying a dead id — collected, imported, or written
     * before this check existed — must stay editable; validating the MERGE would
     * make that one id refuse every future save, and the only route that could
     * clear it is the one being refused. GAUNTLET II Part 2a Round 1 #1 in its
     * general form: a validator narrower than what the store already contains
     * turns an edit into a permanent stop.
     */
    await seedImage('img_doomed');
    const product = await createProduct(ctx.db, actor(), {
      title: 'Legacy',
      coverImageId: 'img_doomed',
      imageIds: ['img_doomed'],
    });
    await ctx.db.execute(sql`DELETE FROM images WHERE id = 'img_doomed'`);

    const saved = await saveProduct(
      ctx.db,
      product.id,
      { title: 'Legacy Renamed' },
      { actor: actor() },
    );

    expect(saved.title).toBe('Legacy Renamed');
    expect(saved.coverImageId).toBe('img_doomed');
  });

  it('clears the cover with null rather than with an empty string', async () => {
    await seedImage('img_removable');
    const product = await createProduct(ctx.db, actor(), { coverImageId: 'img_removable' });
    const cleared = await saveProduct(
      ctx.db,
      product.id,
      { coverImageId: null },
      { actor: actor() },
    );
    expect(cleared.coverImageId).toBeNull();
  });

  it('accepts a patch that replaces the gallery with committed ids', async () => {
    await seedImage('img_a');
    await seedImage('img_b');
    const product = await createProduct(ctx.db, actor(), { imageIds: ['img_a'] });
    const saved = await saveProduct(
      ctx.db,
      product.id,
      { imageIds: ['img_a', 'img_b'] },
      { actor: actor() },
    );
    expect(saved.imageIds).toEqual(['img_a', 'img_b']);
  });
});

// ------------------------------------------------------- the URL projection

/* This suite is about the IMAGE URL projection. Every call passes the same
   empty ladder so the new argument never varies — bulk pricing is covered in
   `bulk-tiers.test.ts` and `compute.test.ts`, where it is the subject. */
const NO_TIERS = { bulkTiers: [] };

describe('toStorefrontProduct', () => {
  const base: Product = {
    id: 'prd_x',
    slug: 'x',
    title: 'X',
    description: { type: 'doc', content: [] },
    status: 'active',
    category: '',
    tags: [],
    coverImageId: null,
    imageIds: [],
    overview: null,
    overviewFallback: '',
    bulkDiscountEnabled: true,
    createdAt: 0,
    updatedAt: 0,
    publishedAt: null,
    deletedAt: null,
    seoTitle: null,
    seoDescription: null,
    authorId: 'u',
    revision: 1,
  };

  it('resolves the cover and the gallery through the shared URL rule', () => {
    const out = toStorefrontProduct({
      ...base,
      coverImageId: 'img_cover',
      imageIds: ['img_one', 'img_two'],
    }, NO_TIERS);
    expect(out.coverImageUrl).toBe('/api/public/images/img_cover');
    expect(out.imageUrls).toEqual([
      '/api/public/images/img_one',
      '/api/public/images/img_two',
    ]);
  });

  it('strips the asset:/idb: prefix before building the URL', () => {
    // Unnormalised this is `/api/public/images/asset:img_cover`, which 404s on a
    // live product — the exact failure `public-projection.ts` records for covers.
    const out = toStorefrontProduct({
      ...base,
      coverImageId: 'asset:img_cover',
      imageIds: ['idb:img_one'],
    }, NO_TIERS);
    expect(out.coverImageUrl).toBe('/api/public/images/img_cover');
    expect(out.imageUrls).toEqual(['/api/public/images/img_one']);
  });

  it('is null for no cover, and drops empty gallery entries', () => {
    expect(toStorefrontProduct(base, NO_TIERS).coverImageUrl).toBeNull();
    expect(toStorefrontProduct({ ...base, coverImageId: '' }, NO_TIERS).coverImageUrl).toBeNull();
    expect(toStorefrontProduct({ ...base, imageIds: ['', 'img_one'] }, NO_TIERS).imageUrls).toEqual([
      '/api/public/images/img_one',
    ]);
  });

  it('leaves every other field exactly as it found it', () => {
    // It is additive, not a projection that filters: the storefront contract
    // this suite inherits is "the product, plus URLs".
    //
    // `overview` IS THE ONE EXCEPTION, and it is deliberate rather than a leak.
    // Migration 0580 makes the storefront's `overview` a RESOLVED string —
    // hand-written, else the stored summary, else derived — so that the
    // storefront owns no fallback logic. `Product.overview` is `string | null`
    // and `StorefrontProduct.overview` is `string`; a null passing through
    // unchanged would be the bug.
    const input: Product = { ...base, coverImageId: 'img_cover', imageIds: ['img_one'] };
    const out = toStorefrontProduct(input, NO_TIERS);
    const { overview: _resolved, ...passthrough } = input;
    expect(out).toMatchObject(passthrough);
    expect(input.overview).toBeNull();
    expect(out.overview).toBe('');
    // And the additions are the ONLY additions. `overview` is not among them:
    // it is already a key of `Product`, and the projection RESOLVES it in place
    // rather than adding a field beside it.
    expect(Object.keys(out).sort()).toEqual(
      [...Object.keys(input), 'coverImageUrl', 'imageUrls', 'bulkTiers'].sort(),
    );
  });
});

describe('toStorefrontVariant', () => {
  /*
   * A COLOUR'S OWN PHOTOGRAPH, resolved by the same rule as the product's cover.
   *
   * The variant carried a bare `imageId` and nothing else, so the storefront had
   * no way to draw it without re-deriving `/api/public/images/:id` on the far
   * side of the network — the second definition of the public URL that
   * `mapping.ts` exists to prevent. It drew a generated SVG instead, which meant
   * a photograph uploaded in the admin never reached a customer.
   */
  const variant: VariantWithPrice = {
    id: 'v1',
    productId: 'p1',
    sku: 'SKU-1',
    optionValues: { Colour: 'Black' },
    position: 0,
    weightGrams: null,
    status: 'active',
    imageId: null,
    colorHex: '#000000',
    compareAtMinor: null,
    costMinor: null,
    createdAt: 0,
    updatedAt: 0,
    price: null,
    available: null,
    /* None of these is what this test is about — it exercises image resolution —
       but `VariantWithPrice` requires them, so the fixture states them rather
       than leaving the file failing `tsc -b`. */
    backorderable: false,
    everOrdered: false,
  };

  it('resolves the image through the shared URL rule', () => {
    expect(toStorefrontVariant({ ...variant, imageId: 'img_black' }).imageUrl).toBe(
      '/api/public/images/img_black',
    );
  });

  it('strips the asset:/idb: prefix, like the cover does', () => {
    expect(toStorefrontVariant({ ...variant, imageId: 'asset:img_black' }).imageUrl).toBe(
      '/api/public/images/img_black',
    );
    expect(toStorefrontVariant({ ...variant, imageId: 'idb:img_black' }).imageUrl).toBe(
      '/api/public/images/img_black',
    );
  });

  it('is null when nobody has photographed this colour, and for an empty id', () => {
    // Null is the state the storefront falls back on, so it must not become
    // `/api/public/images/` — a different route, not this one with a bad id.
    expect(toStorefrontVariant(variant).imageUrl).toBeNull();
    expect(toStorefrontVariant({ ...variant, imageId: '' }).imageUrl).toBeNull();
  });

  it('adds imageUrl, REMOVES costMinor, and changes nothing else', () => {
    /*
     * This test used to say "adds exactly one field" — migration 0420 amends
     * the contract on purpose. What the shop pays per unit is admin-only, and
     * this projection is the one place it leaves the wire; `compareAtMinor`
     * stays, because the sale strikethrough is the reason it exists.
     */
    const input = { ...variant, imageId: 'img_black', compareAtMinor: 2500, costMinor: 1200 };
    const out = toStorefrontVariant(input);
    const { costMinor: _hidden, ...visible } = input;
    expect(out).toMatchObject(visible);
    expect(out.compareAtMinor).toBe(2500);
    expect('costMinor' in out).toBe(false);
    expect(Object.keys(out).sort()).toEqual(
      [...Object.keys(variant).filter((k) => k !== 'costMinor'), 'imageUrl'].sort(),
    );
  });
});

// ------------------------------------------------------------- through HTTP

describe('the routes', () => {
  async function login(): Promise<void> {
    const res = await http.post('/api/auth/login', {
      email: 'owner@test.local',
      password: SEED_PASSWORD,
    });
    expect(res.status).toBe(200);
  }

  beforeEach(login);

  it('POST /admin/products is a 400 naming the field, not a 422 or a 500', async () => {
    /*
     * 400 `bad_request` and not 422 `invalid_document`: 422 is about a DOCUMENT
     * failing `shared/validate.ts`, and this is a field whose value names no row.
     * And emphatically not a 500 — spec §8's client retries a 5xx five times over
     * ~30 seconds for a request that can never succeed.
     */
    const res = await http.post('/api/shop/admin/products', {
      title: 'Broken',
      coverImageId: 'img_invented',
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'coverImageId' });
  });

  it('PATCH /admin/products/:id is a 400 naming imageIds', async () => {
    const created = await http.post('/api/shop/admin/products', { title: 'Patchable' });
    const { product } = await json<{ product: { id: string } }>(created);
    const res = await http.patch(`/api/shop/admin/products/${product.id}`, {
      patch: { imageIds: ['img_invented'] },
      baseRevision: 1,
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'imageIds' });
  });

  it('GET /products/:slug carries coverImageUrl and imageUrls', async () => {
    await seedImage('img_shop_cover');
    await seedImage('img_shop_one');
    const product = await createProduct(ctx.db, actor(), {
      title: 'Storefront Product',
      coverImageId: 'asset:img_shop_cover',
      imageIds: ['img_shop_one'],
    });
    const live = await publishProduct(ctx.db, product.id, actor());

    http.clearCookies();
    const res = await http.get(`/api/shop/products/${live.slug}`);
    expect(res.status).toBe(200);
    const body = await json<{
      product: { coverImageUrl: string | null; imageUrls: string[]; coverImageId: string };
    }>(res);

    expect(body.product.coverImageUrl).toBe('/api/public/images/img_shop_cover');
    expect(body.product.imageUrls).toEqual(['/api/public/images/img_shop_one']);
    // The raw ids stay, so an admin client that already reads them is unbroken.
    expect(body.product.coverImageId).toBe('asset:img_shop_cover');
  });

  it('GET /products carries them on every item in the list', async () => {
    await seedImage('img_list');
    const product = await createProduct(ctx.db, actor(), {
      title: 'Listed Product',
      coverImageId: 'img_list',
    });
    await publishProduct(ctx.db, product.id, actor());

    http.clearCookies();
    const res = await http.get('/api/shop/products');
    const body = await json<{ items: { id: string; coverImageUrl: string | null }[] }>(res);
    const item = body.items.find((i) => i.id === product.id);
    expect(item?.coverImageUrl).toBe('/api/public/images/img_list');
  });

  it('the ADMIN routes do NOT carry them', async () => {
    /*
     * Deliberate. Those URLs resolve only while an ACTIVE product references the
     * image, so on the admin surface — which exists to show drafts, archived and
     * trashed products — every one of them would 404. A guaranteed-broken link is
     * worse than no link: a form would render it.
     */
    await seedImage('img_admin');
    const product = await createProduct(ctx.db, actor(), {
      title: 'Draft Product',
      coverImageId: 'img_admin',
    });

    const res = await http.get(`/api/shop/admin/products/${product.id}`);
    const body = await json<{ product: Record<string, unknown> }>(res);
    expect(body.product).not.toHaveProperty('coverImageUrl');
    expect(body.product).not.toHaveProperty('imageUrls');
    expect(body.product.coverImageId).toBe('img_admin');
  });

  it('the resolved URL is the route that actually serves the image', async () => {
    /*
     * The end of the whole chain, and the reason A5 is one task rather than four:
     * upload → product write → active product → public serve. The URL the
     * projection emits is fetched, and it reaches `getPublicImage` — which
     * answers on the PRODUCT scope alone, since no post in this store has ever
     * named the image.
     *
     * A 400 `storage` is the expected end here: the reference check passed and
     * the redirect could not be signed because the suite has no R2 configured.
     * A 404 would mean the product scope never matched.
     */
    await seedImage('img_end_to_end');
    const product = await createProduct(ctx.db, actor(), {
      title: 'Served Product',
      coverImageId: 'img_end_to_end',
    });
    await publishProduct(ctx.db, product.id, actor());

    http.clearCookies();
    const slug = (await getProduct(ctx.db, product.id))?.slug;
    const page = await http.get(`/api/shop/products/${slug}`);
    const { product: shown } = await json<{ product: { coverImageUrl: string } }>(page);

    const image = await http.get(shown.coverImageUrl);
    expect(image.status).not.toBe(404);
    expect(await json(image)).toMatchObject({ error: 'bad_request', detail: 'storage' });
  });

  it('and a DRAFT product’s image is a 404 on that same URL', async () => {
    // The narrow half, proven through the route rather than through the repo:
    // the projection emits a URL for a draft only on the admin surface (which it
    // does not), and the serving route refuses it regardless.
    await seedImage('img_draft_end');
    await createProduct(ctx.db, actor(), {
      title: 'Unannounced',
      coverImageId: 'img_draft_end',
    });

    http.clearCookies();
    const res = await http.get('/api/public/images/img_draft_end');
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({ error: 'gone' });
  });
});

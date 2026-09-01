import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { httpClient, json } from '../../test/http';
import type { HttpClient } from '../../test/http';

/**
 * Managed shop categories (migration 0200), driven through the REAL app.
 *
 * Route suites go through the whole stack — router, origin guard, session
 * middleware, the shop app's `onError` — because the seam between the repository
 * and HTTP is where this feature's defects are: the 409 payloads are assembled
 * in `onError`, and the public/admin split is a mounting decision, not a
 * function call.
 */

interface CategoryRow {
  id: string | null;
  slug: string | null;
  name: string;
  blurb: string;
  accentHex: string | null;
  position: number;
  count: number;
  managed: boolean;
}

interface PublicRow {
  slug: string;
  name: string;
  blurb: string;
  accentHex: string | null;
  position: number;
  count: number;
}

let ctx: TestCtx;
let http: HttpClient;

beforeAll(async () => {
  ctx = await freshDb();
  http = httpClient(ctx.db);
});

afterAll(async () => {
  await ctx?.close();
});

async function login(): Promise<void> {
  await http.signIn({ email: 'owner@test.local' });
}

async function createProduct(title: string, category: string): Promise<{ id: string }> {
  const res = await http.post('/api/shop/admin/products', { title, category });
  expect(res.status).toBe(201);
  return (await json<{ product: { id: string } }>(res)).product;
}

async function publish(id: string): Promise<void> {
  const res = await http.post(`/api/shop/admin/products/${id}/publish`, {});
  expect(res.status).toBe(200);
}

async function createCategory(body: Record<string, unknown>): Promise<CategoryRow> {
  const res = await http.post('/api/shop/admin/categories', body);
  expect(res.status).toBe(201);
  return (await json<{ category: CategoryRow }>(res)).category;
}

const adminList = async (): Promise<CategoryRow[]> =>
  (await json<{ items: CategoryRow[] }>(await http.get('/api/shop/admin/categories'))).items;

const publicList = async (): Promise<PublicRow[]> =>
  (await json<{ items: PublicRow[] }>(await http.get('/api/shop/categories'))).items;

const find = <T extends { name: string }>(rows: T[], name: string): T | undefined =>
  rows.find((r) => r.name === name);

// ---------------------------------------------------------------------- read

describe('the public list', () => {
  it('needs no session, because a shop that requires a login to see what it sells has no customers', async () => {
    const res = await http.get('/api/shop/categories');
    expect(res.status).toBe(200);
  });

  it('refuses a query parameter rather than ignoring it', async () => {
    expect((await http.get('/api/shop/categories?limit=5')).status).toBe(400);
  });

  it('is managed rows only — an unmanaged value has no slug to route to', async () => {
    await login();
    await createProduct('Freehand', 'Typed Straight In');

    expect(find(await adminList(), 'Typed Straight In')).toMatchObject({
      id: null,
      slug: null,
      managed: false,
      count: 1,
    });
    expect(find(await publicList(), 'Typed Straight In')).toBeUndefined();
  });

  /*
   * The two predicates must agree or a tile reads "6 spools" and its page shows
   * four. `listProducts`' storefront predicate is `deleted_at IS NULL AND status
   * = 'active'`; this is the same rule from the other side.
   */
  it('counts only what a customer can actually buy', async () => {
    await login();
    const category = await createCategory({ name: 'Counted' });
    expect(category.slug).toBe('counted');

    const draft = await createProduct('Counted Draft', 'Counted');
    const live = await createProduct('Counted Live', 'Counted');
    await publish(live.id);

    // The admin list sees both, because its filter must be able to select drafts.
    expect(find(await adminList(), 'Counted')?.count).toBe(2);
    // The storefront sees only the published one.
    expect(find(await publicList(), 'Counted')?.count).toBe(1);
    expect(draft.id).toBeTruthy();
  });

  it('returns a category with no products at all, so the storefront decides about empty tiles', async () => {
    await login();
    await createCategory({ name: 'Empty Shelf' });
    expect(find(await publicList(), 'Empty Shelf')).toMatchObject({ count: 0 });
  });
});

// -------------------------------------------------------------------- create

describe('creating a category', () => {
  it('allocates a slug from the name and keeps the presentation fields', async () => {
    await login();
    const created = await createCategory({
      name: 'ABS & ASA',
      blurb: 'Heat-resistant engineering plastics.',
      accentHex: '#C42B2B',
      position: 3,
    });
    expect(created).toMatchObject({
      slug: 'abs-asa',
      name: 'ABS & ASA',
      blurb: 'Heat-resistant engineering plastics.',
      // Lowercased rather than refused: a colour picker emitting uppercase is
      // not a client error, and the check constraint accepts one casing.
      accentHex: '#c42b2b',
      position: 3,
      managed: true,
    });
  });

  /* "Adopt the category I have been typing" and "create a new one" are the same
   * request, and the client cannot tell them apart without asking. */
  it('adopts a name already in use as free text, reporting its products', async () => {
    await login();
    await createProduct('Adoptable', 'Adopt Me');
    expect(find(await adminList(), 'Adopt Me')).toMatchObject({ managed: false, count: 1 });

    const adopted = await createCategory({ name: 'Adopt Me' });
    expect(adopted).toMatchObject({ managed: true, count: 1, slug: 'adopt-me' });
  });

  /* Not a disagreement, just an occupied URL — suffixed and retried rather than
   * reported, which is the opposite of how a duplicate NAME is handled. */
  it('suffixes a colliding slug instead of failing', async () => {
    await login();
    const first = await createCategory({ name: 'Resin' });
    const second = await createCategory({ name: 'Resin!' });
    expect(first.slug).toBe('resin');
    expect(second.slug).toBe('resin-2');
  });

  it('refuses a duplicate name in any casing, with a 409 carrying the row that won', async () => {
    await login();
    await createCategory({ name: 'PLA Basic' });

    const res = await http.post('/api/shop/admin/categories', { name: 'pla basic' });
    expect(res.status).toBe(409);
    const body = await json<{ error: string; operation: string; category: CategoryRow }>(res);
    expect(body.error).toBe('precondition_failed');
    expect(body.operation).toBe('create');
    expect(body.category).toMatchObject({ name: 'PLA Basic', managed: true });
  });

  it('needs a session', async () => {
    await http.post('/api/auth/logout', {});
    expect((await http.post('/api/shop/admin/categories', { name: 'Nope' })).status).toBe(401);
  });
});

// -------------------------------------------------------------------- update

describe('renaming a category', () => {
  it('rewrites every product carrying the old value and reports how many moved', async () => {
    await login();
    const category = await createCategory({ name: 'Oldname' });
    await createProduct('Mover One', 'Oldname');
    await createProduct('Mover Two', 'Oldname');

    const res = await http.patch(`/api/shop/admin/categories/${category.id}`, {
      name: 'Newname',
    });
    expect(res.status).toBe(200);
    const body = await json<{ category: CategoryRow; movedProducts: number }>(res);
    expect(body.movedProducts).toBe(2);
    expect(body.category).toMatchObject({ name: 'Newname', count: 2 });
    expect(find(await adminList(), 'Oldname')).toBeUndefined();
  });

  /*
   * THE RULE `ProductPatch` STATES: a published URL is a promise, not a value
   * that follows the heading around. A rename that silently moved `/store/abs`
   * would 404 every link anyone had shared.
   */
  it('does not touch the slug', async () => {
    await login();
    const category = await createCategory({ name: 'Stable Slug' });
    expect(category.slug).toBe('stable-slug');

    const res = await http.patch(`/api/shop/admin/categories/${category.id}`, {
      name: 'Completely Different',
    });
    const body = await json<{ category: CategoryRow }>(res);
    expect(body.category.slug).toBe('stable-slug');
  });

  it('moves the slug only when asked, putting it through slugify', async () => {
    await login();
    const category = await createCategory({ name: 'Movable' });
    const res = await http.patch(`/api/shop/admin/categories/${category.id}`, {
      slug: 'Brand New Slug',
    });
    const body = await json<{ category: CategoryRow }>(res);
    expect(body.category.slug).toBe('brand-new-slug');
  });

  it('clears the accent when sent null, which is a real choice and not an omission', async () => {
    await login();
    const category = await createCategory({ name: 'Tinted', accentHex: '#123456' });
    expect(category.accentHex).toBe('#123456');

    const cleared = await json<{ category: CategoryRow }>(
      await http.patch(`/api/shop/admin/categories/${category.id}`, { accentHex: null }),
    );
    expect(cleared.category.accentHex).toBeNull();

    // A patch that does not mention it leaves it alone.
    const untouched = await json<{ category: CategoryRow }>(
      await http.patch(`/api/shop/admin/categories/${category.id}`, { blurb: 'Just copy.' }),
    );
    expect(untouched.category.accentHex).toBeNull();
    expect(untouched.category.blurb).toBe('Just copy.');
  });

  /* Merging two managed rows is a different operation with a different
   * confirmation, and doing it silently would destroy one of them. */
  it('refuses a rename onto another managed name', async () => {
    await login();
    await createCategory({ name: 'Target Taken' });
    const source = await createCategory({ name: 'Source Row' });

    const res = await http.patch(`/api/shop/admin/categories/${source.id}`, {
      name: 'target taken',
    });
    expect(res.status).toBe(409);
    const body = await json<{ operation: string; category: CategoryRow }>(res);
    expect(body.operation).toBe('rename');
    expect(body.category).toMatchObject({ name: 'Target Taken' });
  });

  it('404s an id that does not exist', async () => {
    await login();
    expect((await http.patch('/api/shop/admin/categories/cat_nope', { name: 'X' })).status).toBe(
      404,
    );
  });
});

// -------------------------------------------------------------------- delete

describe('deleting a category', () => {
  it('deletes one nothing uses', async () => {
    await login();
    const category = await createCategory({ name: 'Unused Row' });
    expect((await http.del(`/api/shop/admin/categories/${category.id}`)).status).toBe(200);
    expect(find(await adminList(), 'Unused Row')).toBeUndefined();
  });

  /* Silently orphaning twelve products' category into unmanaged free text is
   * exactly the state this table exists to end. */
  it('refuses one still in use, with a 409 carrying the count', async () => {
    await login();
    const category = await createCategory({ name: 'In Use' });
    await createProduct('Still Here', 'In Use');

    const res = await http.del(`/api/shop/admin/categories/${category.id}`);
    expect(res.status).toBe(409);
    const body = await json<{ operation: string; category: CategoryRow }>(res);
    expect(body.operation).toBe('delete');
    expect(body.category).toMatchObject({ name: 'In Use', count: 1 });
  });

  it('moves the products first when given a reassignment target', async () => {
    await login();
    const category = await createCategory({ name: 'Reassign From' });
    await createProduct('Reassigned', 'Reassign From');

    const res = await http.del(
      `/api/shop/admin/categories/${category.id}?reassign=Reassign%20To`,
    );
    expect(res.status).toBe(200);
    expect(await json<{ movedProducts: number }>(res)).toEqual({ movedProducts: 1 });

    expect(find(await adminList(), 'Reassign From')).toBeUndefined();
    // The target need not be managed: it becomes an in-use unmanaged value.
    expect(find(await adminList(), 'Reassign To')).toMatchObject({ managed: false, count: 1 });
  });

  /* `-` IS A REAL CHOICE distinct from absence: it means make them
   * uncategorised, which somebody has to be able to say out loud. A query
   * parameter cannot carry the empty string, which is why the marker exists. */
  it('accepts the `-` marker as "make them uncategorised"', async () => {
    await login();
    const category = await createCategory({ name: 'To Uncategorised' });
    await createProduct('Orphan', 'To Uncategorised');

    const res = await http.del(`/api/shop/admin/categories/${category.id}?reassign=-`);
    expect(res.status).toBe(200);
    expect(await json<{ movedProducts: number }>(res)).toEqual({ movedProducts: 1 });
    // `''` is the absence of a category, so it is not a row in the list.
    expect(find(await adminList(), '')).toBeUndefined();
  });
});

/**
 * Managed blog categories — the client half of HANDOFF §2 A3.
 *
 * WRITTEN BEFORE THE ROUTE EXISTS, AND DELIBERATELY SO. Three surfaces need the
 * same list at the same time (the dashboard filter, the editor's Details panel,
 * and the Settings > Categories section) and they are built by three different
 * agents in parallel. A shared module pinned to the contract is what stops each
 * of them inventing its own shape and its own derivation — which is exactly how
 * the free-text era ended up with the dashboard and `MetaPanel` deriving the
 * category list independently from the Dexie cache.
 *
 * A SEPARATE MODULE RATHER THAN A BLOCK IN `api.ts`, for the same reason
 * `commerce-schema.ts` re-exports its subsystems instead of declaring them: a
 * file four concurrent writers append to is a file that loses a block. It is not
 * a different convention — `apiFetch` below is `api.ts`'s own request function,
 * so the error envelope, the `credentials: 'include'` rule and the §8 status
 * table are all still the shared ones.
 */
import { apiFetch } from './api';

/**
 * One row of `GET /api/categories`.
 *
 * `id` IS NULLABLE AND THAT NULL IS THE WHOLE POINT: the route answers the UNION
 * of the managed `categories` table and the values actually in use on posts, so
 * a category typed by hand before the table existed still appears in every
 * picker. A null id means "in use, not managed" — it can be selected and it can
 * be adopted (POST it to create the managed row), but it cannot be renamed or
 * deleted, because there is no row to name.
 */
export interface CategorySummary {
  id: string | null;
  name: string;
  /** Posts carrying this exact `posts.category`, DRAFTS INCLUDED (admin surface). */
  count: number;
  /** True when a `categories` row backs it. False = legacy free text. */
  managed: boolean;
}

/** What a rename answers: the new row, and how many posts the one UPDATE moved. */
export interface CategoryRenameResult {
  category: CategorySummary;
  movedPosts: number;
}

/** What a delete answers. `movedPosts` is 0 unless `reassign` was given. */
export interface CategoryDeleteResult {
  movedPosts: number;
}

const seg = (value: string): string => encodeURIComponent(value);

export const categoriesApi = {
  /** Every selectable category, managed or merely in use. Requires a session. */
  async list(signal?: AbortSignal): Promise<CategorySummary[]> {
    const res = await apiFetch<{ categories: CategorySummary[] }>('/categories', { signal });
    return res.categories;
  },

  /** Promote a name to a managed row. Idempotent-ish: a duplicate name is a 409. */
  async create(name: string): Promise<CategorySummary> {
    const res = await apiFetch<{ category: CategorySummary }>('/categories', {
      method: 'POST',
      body: { name },
      subject: 'Category',
    });
    return res.category;
  },

  /**
   * Rename, which also rewrites every post carrying the old value.
   *
   * The count comes back because the UI promises it BEFORE the click ("N posts
   * will move") and has to be able to say what actually happened after it.
   */
  async rename(id: string, name: string): Promise<CategoryRenameResult> {
    return await apiFetch<CategoryRenameResult>(`/categories/${seg(id)}`, {
      method: 'PATCH',
      body: { name },
      id,
      subject: 'Category',
    });
  },

  /**
   * Owner-only. Refused with 409 while posts still carry the name, unless
   * `reassign` is supplied — `''` means "make them uncategorised", which is a
   * real choice and not the same as omitting the parameter.
   */
  async remove(id: string, reassign?: string): Promise<CategoryDeleteResult> {
    return await apiFetch<CategoryDeleteResult>(`/categories/${seg(id)}`, {
      method: 'DELETE',
      // `undefined` is dropped by `url()`; `''` must survive, so it is sent as
      // an explicit empty-string marker the route reads as "uncategorise".
      query: reassign === undefined ? undefined : { reassign: reassign === '' ? '-' : reassign },
      id,
      subject: 'Category',
    });
  },
};

export type CategoriesApi = typeof categoriesApi;

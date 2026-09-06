import { Hono } from 'hono';
import { z } from 'zod';
import { pathParam, readJson, readQuery, str } from '../../../middleware/errors';
import { requireAuth } from '../../../middleware/session';
import { currentDb } from '../../../app-env';
import type { AppEnv } from '../../../app-env';
import { BadRequestError, NotFoundError } from '../../../repo/errors';
import { committedImageIds } from '../../../repo/images';
import { normalizeBlobId } from '../../../repo/public-projection';
import { SHOP_CURRENCY } from '../../currency';
import { ADD_ON_STATUSES } from '../../../../shared/commerce/add-ons';
import type { AddOnRule, AddOnStatus } from '../../../../shared/commerce/add-ons';
import { createAddOn, getAddOn, listAddOns, updateAddOn } from './repo';
import type { AddOnPatch } from './repo';
import { RulesSchema } from './rules-schema';
import type { Db } from '../../../db/client';

/**
 * /admin/add-ons (spec §8). requireAuth() like /admin/products — whoever may
 * price a product may price an extra; permissions.ts puts the prefix in the
 * products domain. No DELETE: an add-on is retired by archiving it.
 */
const auth = requireAuth();
const MAX_INT4 = 2_147_483_647;
const Status = z.enum(ADD_ON_STATUSES as [AddOnStatus, ...AddOnStatus[]]);

const Fields = z
  .object({
    title: str().trim().min(1).max(120),
    description: str().max(400).nullable(),
    imageId: str().min(1).max(200).nullable(),
    priceMinor: z.number().int().min(0).max(MAX_INT4),
    status: Status,
    rules: RulesSchema,
    position: z.number().int().min(-1_000_000).max(1_000_000),
  })
  .strict();

const CreateBody = Fields.partial({ description: true, imageId: true, status: true, position: true }).strict();
const PatchBody = z
  .object({ baseRevision: z.number().int().positive(), patch: Fields.partial().strict() })
  .strict();
const ListQuery = z.object({ status: Status.optional() }).strict();

/** '' and whitespace mean "no description"; the column refuses ''. */
const blankToNull = (value: string | null | undefined): string | null | undefined =>
  value === undefined ? undefined : value === null ? null : value.trim() === '' ? null : value.trim();

/** Same check products make for a cover: an unknown id is a 400 naming the field. */
async function checkImage(db: Db, imageId: string | null | undefined): Promise<void> {
  if (imageId == null) return;
  const known = await committedImageIds(db, [imageId]);
  if (!known.has(normalizeBlobId(imageId))) throw new BadRequestError('imageId');
}

export const addOnRoutes = new Hono<AppEnv>();

addOnRoutes.get('/admin/add-ons', auth, async (c) => {
  const q = readQuery(c, ListQuery);
  return c.json({ items: await listAddOns(currentDb(c), q.status) });
});

addOnRoutes.post('/admin/add-ons', auth, async (c) => {
  const db = currentDb(c);
  const body = await readJson(c, CreateBody);
  await checkImage(db, body.imageId);
  const addOn = await createAddOn(
    db,
    {
      title: body.title,
      description: blankToNull(body.description) ?? null,
      imageId: body.imageId ?? null,
      priceMinor: body.priceMinor,
      currency: SHOP_CURRENCY,
      status: body.status,
      rules: body.rules as AddOnRule[],
      position: body.position,
    },
    Date.now(),
  );
  return c.json({ addOn }, 201);
});

addOnRoutes.get('/admin/add-ons/:id', auth, async (c) => {
  const id = pathParam(c, 'id');
  const addOn = await getAddOn(currentDb(c), id);
  if (!addOn) throw new NotFoundError(id);
  return c.json({ addOn });
});

addOnRoutes.patch('/admin/add-ons/:id', auth, async (c) => {
  const db = currentDb(c);
  const id = pathParam(c, 'id');
  const body = await readJson(c, PatchBody);
  await checkImage(db, body.patch.imageId);
  const patch: AddOnPatch = {
    ...body.patch,
    description: blankToNull(body.patch.description),
    rules: body.patch.rules as AddOnRule[] | undefined,
  };
  return c.json({ addOn: await updateAddOn(db, id, body.baseRevision, patch, Date.now()) });
});

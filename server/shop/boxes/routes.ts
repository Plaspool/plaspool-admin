import { Hono } from 'hono';
import { z } from 'zod';
import { pathParam, readJson, str } from '../../middleware/errors';
import { requireAuth } from '../../middleware/session';
import { currentDb, currentUser } from '../../app-env';
import type { AppEnv } from '../../app-env';
import { NotFoundError } from '../../repo/errors';
import { BOX_PAGE_LIMITS as L, readBoxPage } from '../../../shared/commerce/mystery-box';
import { revalidateProductById } from '../catalog/revalidate';
import { breakUpBox, buildBox } from './fills';
import { getMysteryBox, saveMysteryBox } from './settings';

/**
 * Settings → Mystery box (migration 1240). On the `settings` domain in
 * `permissions.ts`, beside delivery and notification settings.
 */
export const mysteryBoxRoutes = new Hono<AppEnv>();

const auth = requireAuth();

const cueText = str().max(L.cueText);
const PageBody = z
  .object({
    howItWorks: z
      .object({ title: str().max(L.title), steps: z.array(str().max(L.step)).max(L.steps) })
      .strict(),
    cues: z
      .object({
        lowStock: z
          .object({ enabled: z.boolean(), threshold: z.number().int().min(1).max(L.threshold), text: cueText })
          .strict(),
        justDropped: z
          .object({ enabled: z.boolean(), hours: z.number().int().min(1).max(L.hours), text: cueText })
          .strict(),
        sellingFast: z
          .object({ enabled: z.boolean(), minimum: z.number().int().min(1).max(L.minimum), text: cueText })
          .strict(),
        soldOut: z.object({ enabled: z.boolean(), text: cueText }).strict(),
      })
      .strict(),
  })
  .strict();

const SaveBody = z
  .object({
    expectedRevision: z.number().int().min(1),
    enabled: z.boolean(),
    mode: z.enum(['pack', 'built', 'auto']),
    shortfall: z.enum(['hold', 'backup', 'cancel_refund']),
    name: str().max(200),
    size: str().max(40),
    overview: str().max(500),
    page: PageBody,
    /** A TipTap document; null leaves the stored description alone. */
    description: z.unknown().nullable(),
    coverImageId: str().min(1).max(200).nullable(),
    imageIds: z.array(str().min(1).max(200)).max(50),
    priceMinor: z.number().int().min(0).max(1_000_000_000).nullable(),
    itemCount: z.number().int().min(1).max(1000).nullable(),
    main: z.array(str().min(1).max(300)).max(5000),
    backup: z.array(str().min(1).max(300)).max(5000),
  })
  .strict();

const BuildBody = z
  .object({
    sizeVariantId: str().min(1).max(300),
    variantIds: z.array(str().min(1).max(300)).min(1).max(1000),
  })
  .strict();

/** `GET /admin/mystery-box` — everything the Settings screen shows. */
mysteryBoxRoutes.get('/admin/mystery-box', auth, async (c) =>
  c.json({ mysteryBox: await getMysteryBox(currentDb(c)) }),
);

/** `PUT /admin/mystery-box` — save the whole screen, behind its revision. */
mysteryBoxRoutes.put('/admin/mystery-box', auth, async (c) => {
  const body = await readJson(c, SaveBody);
  const db = currentDb(c);
  const mysteryBox = await saveMysteryBox(db, { ...body, page: readBoxPage(body.page) }, currentUser(c), Date.now());
  /* The shop caches the box's page: its words, size and pictures change here. */
  if (mysteryBox.box) revalidateProductById(db, mysteryBox.box.productId);
  return c.json({ mysteryBox });
});

/** `POST /admin/mystery-box/built` — pack a box ahead of any sale. */
mysteryBoxRoutes.post('/admin/mystery-box/built', auth, async (c) => {
  const body = await readJson(c, BuildBody);
  const db = currentDb(c);
  const id = await buildBox(db, { ...body, actorId: currentUser(c).id, now: Date.now() });
  return c.json({ id, mysteryBox: await getMysteryBox(db) }, 201);
});

/** `POST /admin/mystery-box/built/:id/break-up` — unpack a built box; its items go back on the shelf. */
mysteryBoxRoutes.post('/admin/mystery-box/built/:id/break-up', auth, async (c) => {
  const db = currentDb(c);
  const id = pathParam(c, 'id');
  if (!(await breakUpBox(db, id, Date.now()))) throw new NotFoundError(id);
  return c.json({ mysteryBox: await getMysteryBox(db) });
});

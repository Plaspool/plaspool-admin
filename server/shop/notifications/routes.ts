import { Hono } from 'hono';
import { z } from 'zod';
import { readJson, str } from '../../middleware/errors';
import { requireAdmin, requireAuth } from '../../middleware/session';
import { currentDb, currentUser } from '../../app-env';
import { NotFoundError } from '../../repo/errors';
import { getNotificationSettings, patchNotificationSettings } from './repo';
import {
  countPushSubscriptions,
  deletePushSubscription,
  pushConfigured,
  pushPublicKey,
  savePushSubscription,
} from './push';
import type { AppEnv } from '../../app-env';

/**
 * The notification surface — `/admin/notification-settings` (migration 0980).
 *
 * MOUNTED INTO `shopApp()` AT `'/'`, exactly as `settings/routes.ts` is, so the
 * paths below are relative to `/api/shop`. Guards attach PER ROUTE, never
 * `use('*', …)`: a blanket guard on a router that `app.route(prefix, router)`
 * flattens applies to paths this file has never heard of and turns a would-be
 * 404 into a 401.
 *
 * THE DOMAIN IS `settings`, which `server/middleware/permissions.ts` grants
 * over this prefix and which only the owner and developers hold. That rule is
 * not optional decoration: without it the prefix falls through to the
 * `/api/shop/admin/` catch-all, which is `danger` — the screen would then work
 * for exactly the same two roles by accident, and nothing would say so until
 * somebody widened `danger` for an unrelated reason.
 *
 * THE READ IS `requireAuth` AND THE WRITE IS `requireAdmin`, the shape
 * `/admin/delivery-settings` uses. The domain gate has already refused everyone
 * without `settings` by the time either runs; `requireAdmin` is the second lock
 * on the half that changes where money-shaped news is sent.
 *
 * THERE IS NO POST AND NO DELETE. The row is a CHECK-pinned singleton seeded by
 * migration 0980 — a shop has one answer to "who gets told", and a route that
 * could create or remove it would be a route that can leave the shop silent.
 */
export const notificationSettingsRoutes = new Hono<AppEnv>();

const auth = requireAuth();

/**
 * An address, as far as a request schema can tell.
 *
 * `.trim()` BEFORE THE CEILING, so `"  a@b.co  "` is measured as the eight
 * characters it will be stored as rather than the twelve that were typed. The
 * ceiling is 320, which is RFC 5321's 64-character local part plus `@` plus a
 * 255-character domain; it is not the real check — `normalizeRecipients` in the
 * repo decides whether this is plausibly an address at all — it is here so a
 * megabyte of text never reaches it.
 *
 * THERE IS DELIBERATELY NO FLOOR, and the reason is the order Zod applies these
 * in. `.trim()` runs BEFORE `.min()`, so a `.min(3)` measures the empty row a
 * list editor leaves behind — somebody added a field and changed their mind —
 * as zero characters and refuses the whole save with a 400 that names a field
 * the operator cannot see anything wrong with. It would also make
 * `normalizeRecipients`' own decision about a blank entry — drop it, for
 * exactly that reason — dead code that no request can reach. One place decides
 * this, and it is the one whose comment explains it.
 */
const RECIPIENT = str().trim().max(320);

const NotificationSettingsBody = z
  .object({
    /** Required, as on every settings patch in this codebase. A screen that
     *  could save without one is two tabs quietly overwriting each other. */
    expectedRevision: z.number().int().min(1),
    /**
     * ABSENT LEAVES THE LIST ALONE; `[]` CLEARS IT, and that is a legitimate
     * save rather than a refusal — see migration 0980's header. This is the
     * deliberate opposite of `servedRegions` next door, where an empty list
     * would have meant "serve nowhere" and shut the shop.
     *
     * The cap is 50 because this is a hand-typed list for the two or three
     * addresses that have no admin account. A shop needing more of them wants
     * a distribution list at its mail provider, which is one address here.
     */
    orderRecipients: z.array(RECIPIENT).max(50).optional(),
    notifyTeam: z.boolean().optional(),
    notifyOnOrder: z.boolean().optional(),
  })
  .strict();

/**
 * READ BY ANY HOLDER OF `settings`, which is the owner and developers.
 */
notificationSettingsRoutes.get('/admin/notification-settings', auth, async (c) => {
  const settings = await getNotificationSettings(currentDb(c));
  /*
   * UNREACHABLE THROUGH ANY ROUTE, and answered rather than invented. Migration
   * 0980 seeds this row and nothing deletes it, so `null` means a hand-run
   * DELETE or a restore from before the migration. A settings screen showing
   * invented values the save button cannot write would be a screen that looks
   * fine over a broken deployment.
   */
  if (settings === null) throw new NotFoundError('notification_settings');
  return c.json({ settings });
});

notificationSettingsRoutes.patch('/admin/notification-settings', requireAdmin(), async (c) => {
  const { expectedRevision, ...patch } = await readJson(c, NotificationSettingsBody);
  const settings = await patchNotificationSettings(currentDb(c), patch, {
    expectedRevision,
    actorId: currentUser(c).id,
    now: Date.now(),
  });
  return c.json({ settings });
});

/* ══════════════════════════════════════════════════════════════════════════
   WEB PUSH — the devices a person may be buzzed on (migration 1040).

   A SEPARATE ROUTER FROM THE SETTINGS ABOVE, and a separate permissions
   prefix, because they answer different questions for different people.
   `/admin/notification-settings` is `settings`: who the SHOP tells, an
   owner's decision. These are `orders`: whether THIS person's phone buzzes,
   which belongs to anybody who packs a parcel and would be absurd to make an
   owner-only privilege — the packer is the one carrying the phone.

   EVERY ROUTE ACTS ON `currentUser(c)` AND NEVER ON AN ID FROM THE BODY. A
   route that took a user id would let any signed-in person register a device
   against a colleague and read their notifications; there is no legitimate
   caller for that, so the capability does not exist.
   ══════════════════════════════════════════════════════════════════════════ */
export const pushRoutes = new Hono<AppEnv>();

const SubscribeBody = z
  .object({
    /** The push service's URL for this device. `https://` and bounded, matching
     *  the CHECK on the column so a refusal is a 400 naming the field rather
     *  than a 23514 surfacing as a 500. */
    endpoint: str().trim().min(12).max(2000).startsWith('https://'),
    keys: z
      .object({
        p256dh: str().trim().min(16).max(255),
        auth: str().trim().min(8).max(255),
      })
      .strict(),
    /** Which machine this is, for the person's own list. Optional: a browser
     *  that sends none is registered anyway rather than refused. */
    userAgent: str().trim().max(400).optional(),
  })
  .strict();

const UnsubscribeBody = z.object({ endpoint: str().trim().min(12).max(2000) }).strict();

/**
 * The key a browser needs before it can subscribe, and whether push exists here.
 *
 * SERVED OVER THE WIRE RATHER THAN BAKED INTO THE BUNDLE. A `VITE_` variable
 * would be read at BUILD time (CLAUDE.md §5), so setting the key would do
 * nothing until the next deploy — and the owner setting three variables and
 * seeing no change is exactly the failure this avoids. The public key is not a
 * secret; it is published to every subscribing browser by design.
 */
pushRoutes.get('/admin/push/key', auth, (c) =>
  c.json({ publicKey: pushPublicKey(), configured: pushConfigured() }),
);

/** How many devices the CALLER has registered — what their settings row shows. */
pushRoutes.get('/admin/push/devices', auth, async (c) =>
  c.json({
    configured: pushConfigured(),
    devices: await countPushSubscriptions(currentDb(c), currentUser(c).id),
  }),
);

/**
 * Register this browser, or refresh the keys of one already registered.
 *
 * IDEMPOTENT ON THE ENDPOINT — see `savePushSubscription`. A browser that
 * re-subscribes (which they do, on their own schedule, rotating keys) must not
 * become a second row that delivers the same order twice.
 */
pushRoutes.post('/admin/push/subscribe', auth, async (c) => {
  const body = await readJson(c, SubscribeBody);
  await savePushSubscription(currentDb(c), currentUser(c).id, body, Date.now());
  return c.json({ ok: true, configured: pushConfigured() });
});

/**
 * Forget this browser.
 *
 * NOT SCOPED TO THE CALLER'S OWN ROWS, and that is deliberate: an endpoint is
 * minted by a push service and is unguessable, so holding one is proof enough
 * of being the device. Scoping it to `user_id` would strand rows on a shared
 * machine where a colleague signed in after you — the row follows the last
 * person to subscribe, and the person turning it off is the one at the browser.
 */
pushRoutes.post('/admin/push/unsubscribe', auth, async (c) => {
  const { endpoint } = await readJson(c, UnsubscribeBody);
  const removed = await deletePushSubscription(currentDb(c), endpoint);
  /* `ok` regardless of whether a row existed. A browser unsubscribing twice, or
     one whose row a 410 already pruned, has got what it asked for. */
  return c.json({ ok: true, removed });
});

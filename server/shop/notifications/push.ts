/**
 * Web Push — the buzz that reaches a phone with the admin closed.
 *
 * ═══════════════════ WHY THIS EXISTS AT ALL ═══════════════════
 * Migration 0980 shipped three ways to say "an order came in": an email, a row
 * in the bell, and a notification the admin raises while somebody has it open.
 * The third is only as awake as the page, so the case the owner cares about —
 * an order at eleven at night, laptop shut — was carried by email alone. This
 * closes it: the browser's push service delivers with every tab gone.
 *
 * ═══════════════════ THE DEFAULT IMPORT IS LOAD-BEARING ═══════════════════
 * `web-push` IS COMMONJS, and CLAUDE.md §5 records what that costs when it is
 * imported as a namespace: `vite.server.config.ts` builds with `ssr`, which
 * EXTERNALISES node_modules, so Node's own ESM loader resolves this in
 * production while vite-node interops it in vitest. Measured here on 3.6.7,
 * exactly as papaparse behaved:
 *
 *     import * as webpush from 'web-push'   ->  webpush.sendNotification === undefined
 *     import webpush from 'web-push'        ->  works
 *
 * A namespace import is therefore a 500 on every deployment and a green suite,
 * and a NAMED import (`import { sendNotification }`) is worse — the same lexer
 * blindness makes it a link-time SyntaxError under Node. `push-loader.test.ts`
 * runs this file's own import line through `node --input-type=module` so the
 * guard cannot rot.
 *
 * ═══════════════════ IT NEVER THROWS ═══════════════════
 * Every entry point here answers with a count. The caller is the commerce-event
 * consumer, where an exception is a sweep that stops at its first problem
 * forever — the same rule `queueStaffOrderEmail` carries and for the same
 * reason. A push that fails is a notification nobody got, which is exactly what
 * the email is for.
 */
import webpush from 'web-push';
import { sql } from 'drizzle-orm';
import { getEnv } from '../../env';
import { ID, newId } from './ids';
import type { Db } from '../../db/client';

/** What a browser hands us when it subscribes. Shapes fixed by the protocol. */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string | null;
}

/** The message a device receives. Kept small: push payloads are size-capped and
 *  everything here is re-read from the API when the notification is tapped. */
export interface PushPayload {
  title: string;
  body: string;
  /** Hash route to open — the service worker's notificationclick reads it. */
  url: string;
  /** Collapses repeats for the same subject rather than stacking them. */
  tag: string;
}

interface Vapid {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * The three variables, or `null` when push is not set up.
 *
 * READ PER CALL, NEVER AT MODULE SCOPE, matching `server/mail/resend.ts`: a
 * module-scope read makes a missing variable an import-time crash that takes
 * the whole API down instead of turning one feature off.
 */
function vapid(): Vapid | null {
  const env = getEnv();
  const publicKey = env.VAPID_PUBLIC_KEY.trim();
  const privateKey = env.VAPID_PRIVATE_KEY.trim();
  /* A subject is REQUIRED by the spec — push services reject a JWT without one
   * — but it is the one of the three a deployment is likeliest to forget, and
   * refusing to push over a missing contact address would be a worse outcome
   * than defaulting it. `mailto:` prefix added if the owner typed a bare
   * address, which is the obvious mistake. */
  const raw = env.VAPID_SUBJECT.trim();
  const subject = raw === '' ? '' : raw.includes(':') ? raw : `mailto:${raw}`;
  if (publicKey === '' || privateKey === '') return null;
  return { publicKey, privateKey, subject: subject === '' ? 'mailto:support@plaspool.com' : subject };
}

/** Whether this deployment can push at all. The single gate every caller asks. */
export function pushConfigured(): boolean {
  return vapid() !== null;
}

/** The key a browser needs to subscribe, or `null` when push is not set up. */
export function pushPublicKey(): string | null {
  return vapid()?.publicKey ?? null;
}

/**
 * Register (or refresh) one device.
 *
 * UPSERT ON THE ENDPOINT, not on the person. A browser re-subscribing hands
 * back the endpoint it already has — with rotated keys, which is a thing push
 * services genuinely do — and keying on `user_id` would either duplicate the
 * device or throw away the person's other one.
 *
 * The user_id is REWRITTEN on conflict on purpose: a shared machine where one
 * colleague signs out and another signs in produces the same endpoint for a
 * different person, and the row must follow whoever is actually signed in or
 * the notifications go to the wrong inbox.
 */
export async function savePushSubscription(
  db: Db,
  userId: string,
  input: PushSubscriptionInput,
  now: number,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO shop_push_subscriptions
      (id, user_id, endpoint, p256dh, auth, user_agent, created_at)
    VALUES (${newId(ID.pushSubscription)}, ${userId}::uuid, ${input.endpoint},
            ${input.keys.p256dh}, ${input.keys.auth},
            ${input.userAgent ?? null}::text, ${now})
    ON CONFLICT (endpoint) DO UPDATE
       SET user_id    = EXCLUDED.user_id,
           p256dh     = EXCLUDED.p256dh,
           auth       = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent`);
}

/** Forget one device — the person turned notifications off, or the browser did. */
export async function deletePushSubscription(db: Db, endpoint: string): Promise<number> {
  /* RETURNING and a row count, not `rowCount`: the driver's result type here
     does not carry one, and counting what came back is the shape the rest of
     this codebase uses for the same question. */
  const res = await db.execute(
    sql`DELETE FROM shop_push_subscriptions WHERE endpoint = ${endpoint} RETURNING 1`,
  );
  return res.rows.length;
}

/** How many devices one person has registered — what the settings screen shows. */
export async function countPushSubscriptions(db: Db, userId: string): Promise<number> {
  const res = await db.execute(
    sql`SELECT count(*)::int AS n FROM shop_push_subscriptions WHERE user_id = ${userId}::uuid`,
  );
  return Number(res.rows[0]?.n ?? 0);
}

interface Row {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Push one message to every device belonging to any of `userIds`.
 *
 * @returns how many devices actually received it. Zero is an ordinary answer —
 * push is not set up, nobody has subscribed, or every device is gone.
 *
 * DEAD SUBSCRIPTIONS ARE DELETED, NOT RETRIED. A push service answers 404 or
 * 410 for an endpoint that no longer exists — the browser was uninstalled, the
 * permission revoked, the profile wiped — and that is permanent by definition.
 * Leaving those rows would mean every future order paying for a round trip that
 * cannot succeed, growing without bound as devices come and go. Any OTHER
 * status is left alone: a 429 or a 503 is the service having a moment, and
 * deleting a live device over it would silently unsubscribe somebody.
 */
export async function sendPushToUsers(
  db: Db,
  userIds: readonly string[],
  payload: PushPayload,
  now: number,
): Promise<number> {
  try {
    const config = vapid();
    if (config === null || userIds.length === 0) return 0;

    const res = await db.execute(sql`
      SELECT id, endpoint, p256dh, auth
        FROM shop_push_subscriptions
       WHERE user_id = ANY(${sql.param(userIds)}::uuid[])`);
    const rows = res.rows as unknown as Row[];
    if (rows.length === 0) return 0;

    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
    const body = JSON.stringify(payload);

    const gone: string[] = [];
    const delivered: string[] = [];

    /* Sequential rather than Promise.all: a shop has a handful of devices, and
     * this runs inside a sweep that `vercel.json` caps at maxDuration 30 — one
     * push service being slow must not multiply into a parallel pile-up that
     * eats the budget the payments settling actually needs. */
    for (const row of rows) {
      try {
        await webpush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          body,
          { TTL: PUSH_TTL_SECONDS },
        );
        delivered.push(row.id);
      } catch (cause) {
        const status = (cause as { statusCode?: number } | null)?.statusCode;
        if (status === 404 || status === 410) gone.push(row.id);
        else {
          // Name and message only — never the endpoint, which identifies a device.
          console.error(
            '[push]',
            JSON.stringify({
              name: cause instanceof Error ? cause.name : 'unknown',
              message: cause instanceof Error ? cause.message : String(cause),
              status: status ?? null,
            }),
          );
        }
      }
    }

    if (gone.length > 0) {
      await db.execute(
        sql`DELETE FROM shop_push_subscriptions WHERE id = ANY(${sql.param(gone)}::text[])`,
      );
    }
    if (delivered.length > 0) {
      await db.execute(sql`
        UPDATE shop_push_subscriptions SET last_success_at = ${now}
         WHERE id = ANY(${sql.param(delivered)}::text[])`);
    }

    return delivered.length;
  } catch (cause) {
    /* The outer net. Anything unexpected — a driver error, a malformed row —
     * is a notification nobody got, never a sweep that dies. */
    console.error(
      '[push]',
      JSON.stringify({
        name: cause instanceof Error ? cause.name : 'unknown',
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    );
    return 0;
  }
}

/**
 * How long a push service may hold an undelivered message.
 *
 * Six hours: long enough to survive a phone that is off overnight-ish, short
 * enough that nobody is woken at dawn about an order already packed. A push
 * outliving its own usefulness is worse than one that never arrived, because
 * the reader acts on it.
 */
const PUSH_TTL_SECONDS = 6 * 60 * 60;

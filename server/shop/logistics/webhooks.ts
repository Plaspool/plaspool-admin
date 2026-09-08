import { Hono } from 'hono';
import type { AppEnv } from '../../app-env';
import { currentDb } from '../../app-env';
import { loadTemplates } from '../../email/system-templates';
import { readOrder } from '../orders/repo/orders';
import { readFulfillmentByProviderRef } from '../orders/repo/courier';
import { resolveLogisticsDeps } from './deps';
import { LogisticsError } from './port';
import type { ProviderId, WebhookEvent } from './port';
import { logWebhook } from './repo';
import { accessLinkFor, applyCourierUpdate } from './service';

/**
 * THE COURIERS' INBOUND DOOR (spec §5.5).
 *
 * ═══ WHY THIS IS A SEPARATE ROUTER FROM `routes.ts` ═══
 *
 * The split is a security boundary, not tidiness — the same one
 * `payments/routes.ts` draws between `createWebhookRoutes` and
 * `createPaymentRoutes`, and for the same measured reason. `server/index.ts`
 * mounts this ABOVE `originGuard` and ABOVE `sessionMiddleware`: a courier's
 * callback is a server-to-server POST with no `Origin` header, and the guard
 * refuses exactly that on an unsafe method. Mounted with everything else, every
 * genuine delivery would be a 403 and the couriers would retry each one for
 * days — which is precisely what happened to the Paystack webhook
 * (AMENDMENTS A-PAY-001).
 *
 * THE EXEMPTION COSTS NOTHING AN ATTACKER CAN USE, and the argument is worth
 * restating rather than pointing at: CSRF borrows a victim's AMBIENT authority
 * — their cookie. These two routes read no cookie, resolve no session and trust
 * nothing whatever about the caller. Their entire authority is a signature over
 * the raw body (HMAC-SHA256 for Fez, HMAC-SHA512 for Terminal), which a
 * cross-origin form post cannot produce. Being mounted above the session
 * middleware is a PROPERTY rather than an accident: `c.get('user')` is
 * undefined here, so these handlers are structurally incapable of coming to
 * depend on who is signed in.
 *
 * ═══ THE FOUR THINGS EVERY DELIVERY GETS ═══
 *
 * 1. RAW BYTES, CAPPED. `arrayBuffer()` and never `c.req.json()` — signature
 *    schemes sign bytes, and a re-serialise changes them. The 1 MB cap is on
 *    the bytes actually read, never on `content-length`, because a header is a
 *    claim: this endpoint is public and unauthenticated by session, so without
 *    it anyone can make the process buffer and HMAC 100 MB before the signature
 *    can possibly fail.
 * 2. VERIFY BEFORE PARSE. `parseWebhook` throws rather than returning a flag,
 *    so there is no path to the body that forgot to check.
 * 3. 401 AND NOTHING ABOUT WHY. Not a 500 (which a courier retries for days,
 *    turning one forged request into a sustained one) and not a 200 (which
 *    tells a forger their body was accepted). A wrong key, a tampered body, a
 *    stale timestamp and an unconfigured courier are indistinguishable from
 *    outside, deliberately.
 * 4. LOGGED, VERIFIED OR NOT. `shop_logistics_webhooks` is what lets the
 *    settings screen answer "does this courier's traffic reach us at all" — a
 *    question a refused delivery is part of the answer to. The payload is
 *    stored; `listRecentWebhooks` does not return it.
 *
 * ═══ WHY THE WORK IS DONE INLINE, WITH NO `waitUntil` ═══
 *
 * Payments defers its processing because a capture fans out into an outbox, a
 * checkout completion and an order. This is one parcel and one snapshot, and
 * `recordCourierSnapshot` decides "did anything change" inside its own UPDATE —
 * so a courier retrying a 5xx replays a no-op rather than adding a second
 * `courier_update` to a customer-visible history. Idempotency is what makes
 * answering after the write honest here.
 *
 * ═══ IT DECIDES NOTHING ABOUT STATUSES ═══
 *
 * `applyCourierUpdate` is the one place that knows what a courier's word does
 * to a parcel, shared with the refresh button and the sweep, so the three can
 * never drift into three readings of `delivered`. This file owns the HTTP: the
 * bytes, the cap, the refusal, the log line, and nothing else.
 */

const MAX_WEBHOOK_BYTES = 1024 * 1024;

/** The couriers that have an inbound door. One route each, named rather than looped over a runtime value. */
const PROVIDERS: readonly ProviderId[] = ['fez', 'terminal'];

export function createLogisticsWebhookRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  for (const provider of PROVIDERS) {
    app.post(`/shop/logistics/${provider}/webhook`, async (c) => {
      const db = currentDb(c);
      const deps = resolveLogisticsDeps();
      const now = deps.now();

      const buffer = await c.req.arrayBuffer();
      if (buffer.byteLength > MAX_WEBHOOK_BYTES) {
        /* BEFORE the log, on purpose: writing a row for a body we refused to
           read would be storing an attacker's payload on their say-so. */
        return c.json({ error: 'payload_too_large' }, 413);
      }
      const raw = new Uint8Array(buffer);

      /*
       * The stored payload is best-effort and NEVER a reason to fail. A body
       * that is not JSON is exactly the body worth having a row for, so it is
       * recorded as a marker rather than dropped — the column is `jsonb` and
       * NOT NULL, so a raw string would take the whole insert down with it.
       */
      const payloadOf = (): unknown => {
        try {
          return JSON.parse(Buffer.from(raw).toString('utf8')) as unknown;
        } catch {
          return { unparseable: true };
        }
      };
      const reject = async (): Promise<Response> => {
        await logWebhook(db, {
          provider,
          providerRef: null,
          rawStatus: null,
          verified: false,
          applied: 'rejected',
          payload: payloadOf(),
          now,
        });
        return c.json({ error: 'bad_signature' }, 401);
      };

      /*
       * A COURIER WITH NO CREDENTIALS ON THIS DEPLOYMENT CANNOT VERIFY ANYTHING,
       * so it takes the same 401 a bad signature takes — and says no more than
       * that. "Fez is not configured here" is a true statement about our
       * deployment and it is not one to hand an unauthenticated caller.
       */
      const adapter = deps.providerFor(provider);
      if (!adapter) return reject();

      let event: WebhookEvent | null;
      try {
        event = adapter.parseWebhook(raw, c.req.raw.headers, now);
      } catch (err) {
        /* Only a classified refusal is a 401. Anything else is ours and belongs
           in the error handler, with a request id, as a 500. */
        if (!(err instanceof LogisticsError)) throw err;
        return reject();
      }

      /*
       * `null` IS A REAL EVENT WE HAVE NOTHING TO DO WITH — Terminal's
       * `transaction.success`, say. It verified, so it is logged as verified,
       * and it is a 200: a 401 would make the courier retry a wallet notice for
       * three days.
       */
      if (!event) {
        await logWebhook(db, {
          provider,
          providerRef: null,
          rawStatus: null,
          verified: true,
          applied: 'ignored',
          payload: payloadOf(),
          now,
        });
        return c.json({ ok: true, ignored: true });
      }

      /*
       * A REFERENCE WE CANNOT PLACE IS A 200, NOT A 404. It is a permanent
       * condition — a parcel booked on another deployment, or one whose order
       * has been purged — and an error answer would only buy days of retries
       * for something no retry can fix. The row is what makes it visible.
       */
      const parcel = await readFulfillmentByProviderRef(db, provider, event.providerRef);
      if (!parcel) {
        await logWebhook(db, {
          provider,
          providerRef: event.providerRef,
          rawStatus: event.rawStatus,
          verified: true,
          applied: 'unmatched',
          payload: payloadOf(),
          now,
        });
        return c.json({ ok: true, unmatched: true });
      }

      const order = await readOrder(db, parcel.orderId);
      const outcome = await applyCourierUpdate(db, parcel, event, {
        now,
        /* No request origin is involved: the customer's link is built from the
           STOREFRONT's origin, never this admin's and never a `Host` header. */
        link: order ? accessLinkFor(order, now) : null,
        templates: await loadTemplates(db),
        label: adapter.label,
      });

      await logWebhook(db, {
        provider,
        providerRef: event.providerRef,
        rawStatus: event.rawStatus,
        verified: true,
        /* `ignored` for a redelivery that told us what we already knew — which
           is the ordinary case, not the exceptional one. */
        applied: outcome.changed || outcome.transitioned ? 'applied' : 'ignored',
        payload: payloadOf(),
        now,
      });

      return c.json({ ok: true, changed: outcome.changed, transitioned: outcome.transitioned });
    });
  }

  return app;
}

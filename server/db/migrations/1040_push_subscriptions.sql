-- THE DEVICES THE SHOP MAY BUZZ WHEN AN ORDER IS PAID (range 1040-1059).
--
-- Migration 0980 gave the shop three ways to say "an order came in": an email,
-- a row in the bell, and a notification raised by the admin while somebody has
-- it open. The third one has a hole its own design admits — a page that is not
-- running cannot raise anything — so the case the owner actually cares about,
-- an order at eleven at night with the laptop shut, was covered by email alone.
--
-- Web Push closes it. The browser holds a subscription on the shop's behalf and
-- its push service delivers even with every tab closed; this table is where
-- those subscriptions live.
--
-- 1040 AND NOT 1000: two other branches have both already claimed 1000
-- (broadcast_audience and courier_places) and a third holds 1020, so the next
-- free range is this one. Read the folder across every branch before picking a
-- number, not just the one you are on.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ONE ROW PER DEVICE, NOT PER PERSON.
--
-- A subscription is minted by a specific browser on a specific machine, and the
-- endpoint IS its identity — the same person signing in on a phone and a laptop
-- gets two rows and expects both to buzz. So endpoint carries the UNIQUE
-- constraint and user_id merely says whose it is. That also makes re-subscribing
-- idempotent: a browser handing back an endpoint it already registered updates
-- the keys rather than growing a duplicate that would deliver twice.
--
-- ON DELETE CASCADE, unlike the ON DELETE SET NULL on shop_notification_settings
-- .updated_by. That column records WHO DID something and the record outlives the
-- account; this table records a live permission a person granted, and an account
-- that is gone has no devices to buzz. Leaving orphans would mean pushing to
-- somebody who has left the team.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- NOTHING SECRET IS STORED HERE AND THE COLUMN NAMES SAY SO ONLY IF YOU KNOW
-- THE PROTOCOL, so: p256dh and auth are the BROWSER's public key and a random
-- per-subscription salt, both minted by the client and both useless without the
-- endpoint they belong to. The signing key that proves the shop sent a message
-- is VAPID_PRIVATE_KEY, an environment variable, and it is never written here.
CREATE TABLE IF NOT EXISTS shop_push_subscriptions (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  /* The push service's URL for this device. Its identity, hence the UNIQUE. */
  endpoint text NOT NULL,
  /* The browser's public key and auth secret, base64url, as the client gave
   * them. Sizes are fixed by the protocol; the checks below refuse a row that
   * could never encrypt rather than discovering it at send time. */
  p256dh text NOT NULL,
  auth text NOT NULL,
  /* Which machine this is, so a person can tell their phone from their desk and
   * turn one off. Free text from the browser and never parsed. NULL for a
   * client that sent none. */
  user_agent text,
  created_at bigint NOT NULL,
  /* When a push to it last succeeded. NULL until one does. Nothing reads this
   * yet; it exists so a stale device can be found later without a migration. */
  last_success_at bigint,
  CONSTRAINT shop_push_subscriptions_endpoint_uq UNIQUE (endpoint),
  CONSTRAINT shop_push_subscriptions_endpoint_ck
    CHECK (endpoint LIKE 'https://%' AND length(endpoint) BETWEEN 12 AND 2000),
  CONSTRAINT shop_push_subscriptions_p256dh_ck CHECK (length(p256dh) BETWEEN 16 AND 255),
  CONSTRAINT shop_push_subscriptions_auth_ck CHECK (length(auth) BETWEEN 8 AND 255)
);--> statement-breakpoint
-- Every send reads "the devices belonging to the people who should be told", so
-- the lookup is by user_id and this is the index that serves it. The endpoint
-- UNIQUE above already covers the upsert's own lookup.
CREATE INDEX IF NOT EXISTS shop_push_subscriptions_user_idx
  ON shop_push_subscriptions (user_id);--> statement-breakpoint

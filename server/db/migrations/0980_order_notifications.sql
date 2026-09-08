-- WHO THE SHOP TELLS WHEN AN ORDER IS PAID (range 0980-0999; owner's queue,
-- 2026-09-08).
--
-- Every message this outbox has ever carried goes to a CUSTOMER. This one goes
-- to US: the moment a payment captures, the people who pack the parcels get an
-- email saying an order came in, what it came to, and a link that opens it in
-- the admin. It exists because the admin's in-app bell only rings for somebody
-- who is looking at the admin, and an order placed at eleven at night is one
-- nobody sees until the morning unless something reaches an inbox.
--
-- DELIBERATELY NOT WEB PUSH. A push subscription needs VAPID keys, which only
-- the owner can mint and set, so the "nobody has the admin open" case is
-- covered by email instead. Email is also the only one of the three that keeps
-- working when the phone is off.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE DEFAULT IS ON, AND THE RECIPIENTS ARE DERIVED.
--
-- The owner asked for notifications that work the moment they deploy, not for
-- a feature that sits inert until somebody finds the settings screen. So
-- notify_on_order and notify_team are both seeded TRUE, and with an empty
-- order_recipients the message still goes somewhere: to every account on the
-- team roster whose role holds the orders domain. A shop that has never opened
-- this screen is a shop whose staff are already being told.
--
-- AN EMPTY order_recipients IS THEREFORE A LEGITIMATE STATE AND NOT A BROKEN
-- ONE. This is the point where a reader coming from 0760 will expect a
-- cardinality > 0 the way served_regions has one, so it is worth saying why
-- there is none: there, an empty list would have meant "serve nowhere" and shut
-- the shop with one cleared field. Here it means "nobody EXTRA", which is the
-- ordinary case — the hand-typed list is for a warehouse address or a manager
-- who has no admin account, and most shops have neither. Making it
-- unrepresentable would force an operator to invent an address in order to say
-- "just the team".
--
-- What IS forbidden is a NULL or an empty-string ELEMENT, because both are an
-- address the mailer would try to send to and neither can ever be one.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A CHECK-PINNED SINGLETON, following shop_delivery_settings (0760) and
-- marketing_settings (0011): a shop has one answer to "who gets told", and a
-- table that could hold two would leave two answers for whichever row sorted
-- first. There is no POST and no DELETE on the routes for the same reason.
CREATE TABLE IF NOT EXISTS shop_notification_settings (
  id text PRIMARY KEY,
  /* Addresses somebody typed in, on top of the team. See the header for why an
   * empty list is the ordinary state rather than a misconfiguration. */
  order_recipients text[] NOT NULL DEFAULT '{}',
  /* Also mail everyone on the roster who handles orders. TRUE so a fresh
   * deployment notifies the people who already exist. */
  notify_team boolean NOT NULL DEFAULT true,
  /* The master switch. Off means the paid-order mail is not queued at all —
   * the in-app bell and the desktop notification are separate and unaffected. */
  notify_on_order boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1,
  updated_at bigint NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT shop_notification_settings_id_ck CHECK (id = 'main'),
  CONSTRAINT shop_notification_settings_revision_ck CHECK (revision > 0),
  /* The array's own shape, the marketing_service_areas.aliases idiom: a CHECK
   * may not contain a subquery and unnest in one is a subquery, so a NULL and
   * an empty element are found with array_position rather than by unnesting.
   * NO cardinality clause, unlike 0760 — see the header. */
  CONSTRAINT shop_notification_settings_recipients_ck CHECK (
    array_position(order_recipients, NULL) IS NULL
    AND array_position(order_recipients, '') IS NULL
  )
);--> statement-breakpoint
-- THE SEED IS THE FEATURE SWITCHED ON, with nobody typed in.
--
-- ON CONFLICT DO NOTHING so a re-run cannot switch a shop that has since turned
-- the mail off back on again. The timestamp is this migration's own date; the
-- first real save overwrites it.
INSERT INTO shop_notification_settings
  (id, order_recipients, notify_team, notify_on_order, revision, updated_at)
VALUES ('main', '{}', true, true, 1, 1788825600000)
ON CONFLICT (id) DO NOTHING;--> statement-breakpoint
-- AND THE OUTBOX HAS TO ADMIT THE NEW KIND.
--
-- DROP-THEN-ADD, NOT ALTER CONSTRAINT: Postgres cannot widen a CHECK in place.
-- 0320, 0380 and 0640 all made this exact move on this exact constraint; this
-- is the fifth value list the column has carried, and the full list is restated
-- rather than appended to because there is no syntax for appending. The new
-- predicate is strictly WIDER than 0640's, so no existing row can fail it and
-- the ADD cannot be the statement that breaks the deploy.
--
-- staff_new_order IS THE FIRST KIND ON THIS TABLE WHOSE READER IS STAFF, and
-- it rides here anyway for 0640's reason: this outbox already drains, already
-- dedupes on a key and already stops at EMAIL_ATTEMPT_LIMIT. A second table to
-- send one message would be a second sweeper and a second set of failure modes.
-- The consequence is named rather than hidden: to_email on these rows is a
-- colleague's address, so anything that reads the outbox as "what we told the
-- customer" must filter this kind out.
ALTER TABLE shop_order_email_intents
  DROP CONSTRAINT shop_order_email_intents_kind_ck;--> statement-breakpoint
ALTER TABLE shop_order_email_intents
  ADD CONSTRAINT shop_order_email_intents_kind_ck CHECK (
    kind IN ('placed', 'confirmation', 'shipment', 'delivered',
             'cancellation', 'refund', 'refund_failed',
             'review_invite', 'review_approved', 'staff_new_order')
  );--> statement-breakpoint

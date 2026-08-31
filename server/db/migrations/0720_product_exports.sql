-- PRODUCT EXPORTS (range 0720-0739; owner's queue, 2026-08-31).
--
-- HAND-WRITTEN IN FULL — commerce tables are invisible to drizzle-kit.
-- Declared in `server/db/commerce-schema.ts`.
--
-- WHAT IT HOLDS. "Export products as CSV, and email me the download" needs the
-- file to OUTLIVE the request: the mail transport carries no attachments
-- (`server/mail/resend.ts` posts subject/text/html and nothing else, by
-- design), so what the email carries is a LINK, and a link needs a row to
-- resolve against. The CSV itself is stored inline — a catalog is a few
-- hundred rows of text, not media — so there is no bucket, no lifecycle, and
-- nothing to orphan.
--
-- THE TOKEN IS THE CREDENTIAL, HMAC'd LIKE EVERY OTHER ONE. The link lands in
-- an inbox and gets clicked from phones and other browsers, so the download
-- route cannot demand the admin session; a 256-bit token in the query string
-- is its whole authority, stored as `tokenId()` output (HMAC under
-- SESSION_SECRET) so a database dump alone unlocks nothing. Expiry is
-- enforced at read time against created_at — seven days, in the route — so
-- there is no sweeper to schedule.
--
-- requested_email IS SNAPSHOTTED, not joined: the answer to "where did this
-- file go" must not change when an admin later edits their address.
--
-- requested_by IS uuid WITH NO FOREIGN KEY, the rule every commerce table
-- follows about users (see shop_order_events.actor_id): contract §3 lists
-- users as read-only from this side, and an FK is a constraint added to a
-- table this subsystem does not own.
CREATE TABLE product_exports (
  id text PRIMARY KEY,
  requested_by uuid NOT NULL,
  requested_email text NOT NULL,
  csv text NOT NULL,
  row_count integer NOT NULL,
  token_hash text NOT NULL,
  created_at bigint NOT NULL,
  downloaded_at bigint,
  CONSTRAINT product_exports_row_count_ck CHECK (row_count >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX product_exports_token_uq ON product_exports (token_hash);--> statement-breakpoint

-- SYSTEM EMAIL TEMPLATES, AND A DESIGNED HTML PART FOR TRANSACTIONAL MAIL
-- (range 0320-0339).
--
-- HAND-WRITTEN IN FULL, for the reason every migration in this range is:
-- `drizzle.config.ts` declares only `server/db/schema.ts`, so drizzle-kit has
-- never seen `shop_order_email_intents` or `email_templates` and can neither
-- generate nor undo this DDL.
--
-- Three changes, and they are in one migration because they are one feature:
-- order mail gets an HTML part, the lifecycle gets the two states it was
-- missing, and the templates the system sends become rows an owner can edit.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. `shop_order_email_intents.html` — NULLABLE, AND IT STAYS NULLABLE.
--
-- The intent row is the record of what a customer was told; until now it held
-- only `body`, the plain-text part, and the HTML was invented at delivery time
-- by running that text through a tag-wrapper. That is why every order email
-- this shop has ever sent is a stack of bare `<p>` elements.
--
-- NOT `NOT NULL DEFAULT ''`: there are delivered rows in this table with no
-- HTML part, and they are HISTORY. Backfilling them with a generated document
-- would write a record of a message that was never sent in that form — the one
-- thing an audit column must never do. `NULL` reads as "this predates the HTML
-- part", the sweeper falls back to deriving one exactly as it does today, and
-- the distinction survives.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE shop_order_email_intents
  ADD COLUMN html text;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. TWO MORE KINDS: `placed` and `delivered`.
--
-- The lifecycle had four messages and two holes in it. A customer got nothing
-- between pressing pay and the payment settling — which on this deployment can
-- be a full minute, because the outbox sweep does the work rather than the
-- webhook — and nothing when the parcel arrived, so the last thing they ever
-- heard was "on its way".
--
-- DROP-THEN-ADD RATHER THAN `ALTER CONSTRAINT`: Postgres has no way to widen a
-- CHECK in place. The window between the two statements is inside one
-- migration run against a table whose only writer is the order pipeline, and
-- the new predicate is strictly WIDER than the old one — so no existing row can
-- fail it and the ADD cannot be the statement that breaks the deploy.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE shop_order_email_intents
  DROP CONSTRAINT shop_order_email_intents_kind_ck;--> statement-breakpoint
ALTER TABLE shop_order_email_intents
  ADD CONSTRAINT shop_order_email_intents_kind_ck CHECK (
    kind IN ('placed', 'confirmation', 'shipment', 'delivered',
             'cancellation', 'refund')
  );--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. `email_templates.system_key` — WHICH SYSTEM MESSAGE THIS ROW IS.
--
-- `NULL` for every template an operator wrote, which is every row that exists
-- today; non-null for the nine the application sends by itself. That nullable
-- column is the whole feature:
--
--   * The admin can show system templates as defaults, badge them, and refuse
--     to delete them — `DELETE` is guarded in `server/email/repo.ts` and, more
--     importantly, by the trigger below, because a guard in application code is
--     a guard some other caller does not go through.
--
--   * Duplicating one produces an ordinary row with `system_key = NULL`, which
--     is then editable and deletable like anything else. That is the escape
--     hatch that makes "cannot be deleted" tolerable.
--
-- WHY A COLUMN AND NOT A SEPARATE `system_email_templates` TABLE. The admin
-- screen lists both kinds together, the broadcast composer can send from
-- either, and `email_broadcasts.template_id` already points here. A second
-- table would mean a UNION in every read and a nullable FK per table in
-- `email_broadcasts` — for one flag.
--
-- NO FOREIGN KEY TO A KEYS TABLE, and no enum. The valid keys live in
-- `server/mail/defaults.ts` and change with the application, not with the data;
-- a CHECK listing them here would mean a migration every time a message is
-- added, and an enum type would mean a migration plus a lock. The seeder is the
-- only writer of this column and it writes from that constant.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE email_templates
  ADD COLUMN system_key text;--> statement-breakpoint

-- One row per system message. Functional-index territory is avoided here on
-- purpose — the key is already exact-cased and machine-generated, so a plain
-- UNIQUE is enough, unlike `email_templates_name_lower_uq` which guards a name
-- a human types.
CREATE UNIQUE INDEX email_templates_system_key_uq
  ON email_templates (system_key) WHERE system_key IS NOT NULL;--> statement-breakpoint

ALTER TABLE email_templates
  ADD CONSTRAINT email_templates_system_key_ck CHECK (
    system_key IS NULL OR (system_key <> '' AND system_key = btrim(system_key))
  );--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- THE DELETE GUARD, IN THE DATABASE.
--
-- ⚠️  A SYSTEM TEMPLATE IS NOT DELETABLE, AND THIS IS WHERE THAT IS TRUE.
--
-- `server/email/repo.ts` refuses it too, and that refusal is what produces a
-- decent 409 for the admin screen. This trigger is the one that holds when the
-- next caller is a migration, a psql session at 2am, or a route somebody adds
-- next year that reaches `DELETE FROM email_templates` without going through
-- `deleteTemplate`.
--
-- The reason it matters more than an ordinary "are you sure": deleting
-- `order.confirmation` does not break the admin screen, it breaks PAID ORDERS —
-- silently, at the next capture, in a code path that is deliberately built to
-- swallow its own failures so a mail problem cannot roll back a payment. The
-- renderer falls back to the built-in default and the customer is still served,
-- so nothing would even alert; the operator's edits would simply be gone.
--
-- RAISES rather than silently skipping. A `DELETE` that quietly affects no rows
-- is how an operator concludes the row is already gone and stops looking.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION email_templates_block_system_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'email_templates: % is a system template and cannot be deleted', OLD.system_key
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER email_templates_no_system_delete
  BEFORE DELETE ON email_templates
  FOR EACH ROW WHEN (OLD.system_key IS NOT NULL)
  EXECUTE FUNCTION email_templates_block_system_delete();--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- NO SEED ROWS IN THIS FILE, AND THAT IS DELIBERATE.
--
-- The nine templates are ~200 lines of generated HTML each. Pasting them here
-- would put a second copy of every message in a file that cannot be regenerated,
-- and the copies would disagree the first time `server/mail/brand.ts` changed.
--
-- `ensureSystemTemplates()` in `server/email/system-templates.ts` seeds them
-- instead — `INSERT … ON CONFLICT (system_key) DO NOTHING`, so it is idempotent,
-- it runs from the admin templates list and from the sweep, and an operator's
-- edits are never overwritten by a later deploy. `server/mail/defaults.ts` stays
-- the single source of the wording.
-- ═══════════════════════════════════════════════════════════════════════════

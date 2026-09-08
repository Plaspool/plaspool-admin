-- BROADCAST AUDIENCE (range 0980-0999; owner's answers 2026-09-08).
--
-- WARNING (2026-09-08): the dev database's ledger high-water was measured at
-- 1786600005400 the same day this migration's journal entry was corrected to
-- 1786600005200 -- BELOW that mark. Drizzle only applies a journal entry above
-- the ledger's high-water mark, so a plain db:migrate run against dev will
-- SILENTLY SKIP this migration: no error, no output saying so. Apply it to dev
-- BY HAND -- split this file on the statement-breakpoint marker comment and
-- run each statement -- then verify both dev and production against
-- information_schema and pg_constraint, per CLAUDE.md section 4.
--
-- HAND-WRITTEN IN FULL, for the reason every email migration is: drizzle-kit has
-- never seen these tables and can neither generate nor undo this DDL.
--
-- Until now a broadcast meant EVERY subscriber. enqueueAudience is one INSERT
-- ... SELECT over email_subscribers with no predicate but the suppression check.
-- The new "Not bought yet" screen picks specific people out of a list, so a
-- broadcast needs to be able to say who it was for.
--
-- WHY A SNAPSHOT TABLE AND NOT A DERIVATION FROM THE RECIPIENTS. The answer to
-- "who did we pick" has to survive the send, INCLUDING the people who
-- unsubscribed between the pick and the drain and were therefore never enqueued.
-- Deriving the audience later from email_broadcast_recipients would silently
-- redefine the question as "who did we reach", and the gap between those two
-- numbers is exactly what an operator needs to see.

ALTER TABLE email_broadcasts
  ADD COLUMN audience_kind text NOT NULL DEFAULT 'all_subscribers';

--> statement-breakpoint
ALTER TABLE email_broadcasts
  ADD CONSTRAINT email_broadcasts_audience_kind_ck
  CHECK (audience_kind IN ('all_subscribers', 'picked'));

--> statement-breakpoint
-- The addresses a "picked" broadcast was aimed at, folded, one row each.
--
-- EMAIL AND NOT subscriber_id, DELIBERATELY. At the moment of picking, most of
-- these people have no email_subscribers row at all -- production held ZERO
-- subscribers when this was written. The row is created at send time by
-- addSubscriber, which is what mints the unsubscribe token; storing an id here
-- would mean creating the subscriber at PICK time, so opening the composer and
-- changing your mind would leave a mailing list behind it.
CREATE TABLE email_broadcast_audience (
  broadcast_id uuid NOT NULL REFERENCES email_broadcasts(id) ON DELETE CASCADE,
  email        text NOT NULL,
  PRIMARY KEY (broadcast_id, email),
  CONSTRAINT email_broadcast_audience_email_ck
    CHECK (email <> '' AND email = lower(email))
);

--> statement-breakpoint
-- A FOURTH RECIPIENT STATUS: skipped.
--
-- A nudge whose template carries {{basket}} and whose recipient's basket is
-- EMPTY by the time the drain reaches them must not be sent -- they bought, or
-- emptied it, or their cart expired, in the minutes between the pick and the
-- batch. Mailing "you left these behind" to somebody who has just paid is the
-- single most likely embarrassment in this feature.
--
-- NOT REUSED AS 'failed'. A failed row that is not a failure is a lie in the one
-- table an operator consults when a send looks wrong. Widening the CHECK costs
-- two statements and email_broadcast_recipients is empty in production.
ALTER TABLE email_broadcast_recipients
  DROP CONSTRAINT email_broadcast_recipients_status_ck;

--> statement-breakpoint
ALTER TABLE email_broadcast_recipients
  ADD CONSTRAINT email_broadcast_recipients_status_ck
  CHECK (status IN ('pending', 'sent', 'failed', 'skipped'));

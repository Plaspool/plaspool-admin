-- OWNERSHIP TRANSFERS — handing the store to somebody else (range 0800-0819).
--
-- HAND-WRITTEN IN FULL. Declared in `server/db/schema.ts`; consumed by
-- `server/repo/ownership.ts` and the transfer routes.
--
-- WHAT THIS CHANGES ABOUT AN INVARIANT THAT WAS DELIBERATE. `shared/roles.ts`
-- says "THE OWNER IS SINGULAR BY CONSTRUCTION, not by count": `owner` was
-- never mintable through the API, role changes refused it in BOTH directions,
-- and the instance always had exactly the owner it was seeded with. That was a
-- good property and it is NOT being loosened — `PATCH /users/:id/role` still
-- refuses `owner` at the Zod enum and still carries `AND role <> 'owner'` in
-- its statement.
--
-- What changes is that there is now ONE route that may move it, and it moves it
-- as a SWAP rather than as two edits: the same guarded statement that promotes
-- the recipient demotes the outgoing owner to `developer`. There is no instant
-- at which the instance has two owners or none, which is exactly the property
-- two sequential role updates could not offer.
--
-- WHY A TABLE AND NOT A COLUMN. The owner asked for the recipient to accept
-- rather than for the swap to happen on click, so a transfer is a THING with a
-- lifetime: proposed, then accepted or cancelled or expired. A `pending_owner`
-- column on `users` could hold the target but not who proposed it, when, or
-- whether it lapsed — and "who tried to hand the store to whom" is exactly the
-- history you want when somebody asks why their role changed.
--
-- SEVEN DAYS, matching `INVITE_TTL_MS`. A proposal nobody accepts should not
-- sit live forever: the outgoing owner may have changed their mind and moved
-- on, and an acceptance months later would move the store under them.
CREATE TABLE ownership_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE CASCADE on both sides: a transfer describes two accounts, and if
  -- either stops existing the proposal is meaningless rather than merely stale.
  -- Nothing in this application hard-deletes a user today (the foreign keys
  -- from posts and invites forbid it), so this is about not leaving a trap for
  -- whoever changes that.
  from_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,

  -- Exactly one of these is ever set, and which one is the whole state machine:
  -- both NULL is pending, accepted_at is done, cancelled_at is withdrawn or
  -- declined. Expiry is the clock rather than a column, like invites.
  accepted_at bigint,
  cancelled_at bigint,

  -- Handing the store to yourself is not a transfer, and the swap statement
  -- would demote and promote the same row.
  CONSTRAINT ownership_transfers_distinct_ck CHECK (from_user_id <> to_user_id),
  -- A row cannot be both accepted and cancelled. Without this, a cancel racing
  -- an accept could record both and leave no answer to "what happened".
  CONSTRAINT ownership_transfers_outcome_ck
    CHECK (accepted_at IS NULL OR cancelled_at IS NULL)
);--> statement-breakpoint

-- AT MOST ONE PENDING TRANSFER FOR THE WHOLE INSTANCE, enforced here rather
-- than by a route that counts first.
--
-- The alternative — one pending transfer per recipient — is not the rule that
-- matters: two live proposals naming different people are two people who each
-- believe they are about to own the store, and whichever accepts first silently
-- voids the other. A partial unique index on a constant expression is how you
-- say "at most one row in this state" in Postgres, and it holds under
-- concurrency in a way a SELECT-then-INSERT never does.
CREATE UNIQUE INDEX ownership_transfers_one_pending_uq
  ON ownership_transfers ((true))
  WHERE accepted_at IS NULL AND cancelled_at IS NULL;--> statement-breakpoint

-- The recipient's screen asks "is there one for me" on every load, and the
-- sender's asks "is there one from me".
CREATE INDEX ownership_transfers_to_idx ON ownership_transfers (to_user_id);--> statement-breakpoint
CREATE INDEX ownership_transfers_from_idx ON ownership_transfers (from_user_id);--> statement-breakpoint

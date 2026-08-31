-- ADMIN ROLES (range 0680-0699; owner's queue, 2026-08-31).
--
-- HAND-WRITTEN IN FULL, like everything in this folder. Declared in
-- `server/db/schema.ts`; the role vocabulary itself lives in `shared/roles.ts`
-- so the permission middleware and the team screen read one table.
--
-- WHAT IT WIDENS. `users.role` has been a two-value column since the first
-- migration: owner and writer. The owner asked for a team model — developer
-- (owner-grade, several allowed), content writer (products + blog), supply
-- chain (stock + fulfilment), support (orders + customers), marketing
-- (campaigns + broadcasts). Postgres cannot widen a CHECK in place, so both
-- are DROP-then-ADD, the same shape every kind-check widening in this folder
-- has taken (0320, 0380, 0640).
--
-- 'writer' KEEPS ITS STORED VALUE and gains a display name ("Content writer")
-- rather than being renamed. Two production rows and every author_id join
-- would otherwise need a data migration for a cosmetic change; the label
-- lives in shared/roles.ts where labels belong.
--
-- 'owner' STAYS LEGAL ON invites.role DELIBERATELY, even though no route will
-- ever mint one again (shared/roles.ts: the owner is singular by
-- construction, enforced at the invite and role-change routes). The invites
-- table holds HISTORY — accepted and expired rows — and a CHECK that outlaws
-- a value history may already carry is a migration that fails on real data.
ALTER TABLE users DROP CONSTRAINT users_role_ck;--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_role_ck CHECK (
  role IN ('owner', 'developer', 'writer', 'supply_chain', 'support', 'marketing')
);--> statement-breakpoint
ALTER TABLE invites DROP CONSTRAINT invites_role_ck;--> statement-breakpoint
ALTER TABLE invites ADD CONSTRAINT invites_role_ck CHECK (
  role IN ('owner', 'developer', 'writer', 'supply_chain', 'support', 'marketing')
);--> statement-breakpoint

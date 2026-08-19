-- SINGLE-USE KEYS FOR THE STOREFRONT IDENTITY BRIDGE (customer auth, range 0220-0239).
--
-- HAND-WRITTEN IN FULL, as every commerce migration is: `drizzle.config.ts`
-- declares only `server/db/schema.ts`, so drizzle-kit has never seen the shop's
-- tables and can neither generate these statements nor emit DDL to undo them.
--
-- WHAT THIS TABLE IS. One row per assertion that has ALREADY BEEN SPENT. The
-- primary key is the whole mechanism: a replay is an INSERT that violates it,
-- which is a refusal the route can explain, rather than a second session.
--
-- WHY NOT lookup-then-insert. Two concurrent posts of one assertion both read
-- "not spent" and both mint a session. The unique violation is the only version
-- that holds under concurrency, and it is the same argument
-- `findOrCreateCustomerByEmail` makes for its ON CONFLICT.
--
-- WHY NO FOREIGN KEY to `shop_customers`. The jti is spent before a customer is
-- necessarily resolved, and a spent key must stay spent even if the customer row
-- is later deleted. Referential integrity here would trade a replay defence for
-- a cascade.
--
-- `used_at` IS bigint EPOCH-MS, never timestamptz -- the rule every table in
-- this database follows. It exists only so the opportunistic sweep has
-- something to compare; nothing reads it for business purposes.

CREATE TABLE "shop_auth_assertions" (
  "jti" text PRIMARY KEY NOT NULL,
  "used_at" bigint NOT NULL
);
--> statement-breakpoint
-- The sweep deletes by age, so it is the only access path that is not the PK.
CREATE INDEX "shop_auth_assertions_used_at_idx" ON "shop_auth_assertions" ("used_at");

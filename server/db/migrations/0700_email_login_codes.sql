-- EMAIL LOGIN CODES — TWO-FACTOR FOR THE ADMIN (range 0700-0719; owner's
-- queue, 2026-08-31).
--
-- HAND-WRITTEN IN FULL. Declared in `server/db/schema.ts`; consumed by
-- `server/repo/login-challenges.ts` and the login routes.
--
-- WHAT IT IS. After a correct password, an account with `two_factor_email`
-- set is not signed in: it is handed a CHALLENGE — a 256-bit ticket proving
-- the password step happened, paired with a 6-digit code that goes to the
-- account's inbox. Only the pair mints a session. The mail is the second
-- factor the owner asked for; it rides the transport that already sends
-- password resets, so no new provider is involved.
--
-- DEFAULT false, THEN UPDATE true — AND THE ORDER IS THE POINT. The DDL
-- default is what every row created WITHOUT naming the column gets, and that
-- includes every test-harness seed in this repository; defaulting true would
-- put an email hop inside every suite's login helper. The UPDATE flips the
-- rows that exist at apply time — the real admins, who are the people the
-- owner asked to protect. New real accounts get true from `createUser`
-- (accept-invite names the column explicitly), so the DDL default is only
-- ever load-bearing for code that has not decided — which is exactly the
-- code that cannot complete a challenge.
ALTER TABLE users
  ADD COLUMN two_factor_email boolean NOT NULL DEFAULT false;--> statement-breakpoint
UPDATE users SET two_factor_email = true;--> statement-breakpoint

-- THE CHALLENGES. One row per password-verified login attempt on a protected
-- account. `ticket_hash` and `code_hash` are HMACs under SESSION_SECRET, the
-- same treatment session and invite tokens get (`server/repo/users.ts`
-- tokenId) — a database dump on its own must be inert. `attempts` is CAS'd on
-- verify so five wrong guesses spend the challenge; `resends` bounds how much
-- mail one password-holder can aim at an inbox. Epoch-ms bigints throughout,
-- like every timestamp in this schema. ON DELETE CASCADE: a deleted account
-- owes nobody a pending login.
CREATE TABLE auth_login_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_hash text NOT NULL,
  code_hash text NOT NULL,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  resends integer NOT NULL DEFAULT 0,
  consumed_at bigint,
  CONSTRAINT auth_login_challenges_attempts_ck CHECK (attempts >= 0),
  CONSTRAINT auth_login_challenges_resends_ck CHECK (resends >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX auth_login_challenges_ticket_uq
  ON auth_login_challenges (ticket_hash);--> statement-breakpoint

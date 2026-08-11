ALTER TABLE "posts" ADD COLUMN "lifecycle_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Everything below is hand-appended: drizzle-kit cannot model a trigger.
--
-- THE DEFECT (spec §4.2). A lifecycle op re-reads and re-bases on every retry
-- and re-checked its precondition against the NEW row, so the CAS pinned a
-- revision the operation had never derived from and the precondition only ever
-- rejected "already in the target state". A concurrent INVERSE op returns the
-- row to a state the precondition accepts, so the retry fired and silently
-- reversed a deliberate human action. Measured: a `trash` that lost to a
-- concurrent trash-then-restore re-trashed the post, and the next `emptyTrash`
-- hard-deleted it and CASCADEd away every revision.
--
-- WHY A NEW COLUMN AND NOT A BETTER PREDICATE. A predicate over current state
-- alone cannot distinguish "never left draft" from "was trashed and restored
-- back to draft" — the row looks identical. And refusing every retry is also
-- wrong: `publish` derives its slug and excerpt from the row it read, and a
-- concurrent CONTENT edit should be re-derived from rather than 409'd at a
-- human. So the question the predicate has to ask is not "what state is the row
-- in" but "did a LIFECYCLE change happen since I read", which needs a counter.
--
-- WHY A TRIGGER AND NOT `lifecycle_generation = lifecycle_generation + 1` IN
-- THE REPOSITORY. A counter the application increments is only honest about
-- writes that went through the application, and a CAS predicate must not depend
-- on that: an import, a backfill, a retention sweep or a hand-run UPDATE moves
-- `deleted_at` without going anywhere near `server/repo/posts.ts`. Here the
-- database owns the column outright — it is recomputed from OLD on every
-- UPDATE, so it cannot be set, skipped or faked by any writer.
--
-- WHAT MOVES IT: `status`, `published_at`, `deleted_at`. Those three and no
-- others, so `savePost` — which sets none of them, deliberately, so a PATCH
-- body cannot smuggle a status change past the lifecycle rules — leaves the
-- generation alone and a lifecycle retry racing an autosave still wins.
CREATE OR REPLACE FUNCTION posts_bump_lifecycle_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.status, NEW.published_at, NEW.deleted_at)
     IS DISTINCT FROM (OLD.status, OLD.published_at, OLD.deleted_at) THEN
    NEW.lifecycle_generation := OLD.lifecycle_generation + 1;
  ELSE
    NEW.lifecycle_generation := OLD.lifecycle_generation;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS posts_lifecycle_generation ON posts;--> statement-breakpoint
CREATE TRIGGER posts_lifecycle_generation
  BEFORE UPDATE ON posts
  FOR EACH ROW EXECUTE FUNCTION posts_bump_lifecycle_generation();

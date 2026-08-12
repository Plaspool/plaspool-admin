-- 0005 — the index the public list needs, and does not have.
--
-- `listPublicPosts` orders by `(published_at DESC NULLS LAST, id ASC)` behind
-- `PUBLIC_POST_PREDICATE`. Without a partial index matching both, every public
-- request sorts the entire published set — a performance cliff with no error
-- anywhere to notice it, on the one route that is meant to absorb anonymous
-- traffic.
--
-- THE PREDICATE MUST MATCH `PUBLIC_POST_PREDICATE` EXACTLY, all four conjuncts.
-- A partial index only serves a query the planner can prove is contained by its
-- predicate; drop or reword a conjunct here and the index silently stops being
-- used rather than failing. `server/repo/public.ts` derives the runtime
-- predicate from one named record and `public.test.ts` pins this file against
-- it, so the two cannot drift apart quietly.
--
-- The fourth conjunct is not redundant: `status = 'published'` does NOT imply
-- `published_at IS NOT NULL` — `createPost` binds the two independently and
-- `POST /api/import` forwards both from a bundle.
--
-- PARTIAL, so drizzle-kit cannot model it; hand-written for the same reason
-- `posts.search` and the lifecycle trigger are. Numbered in the blog's 000x
-- range — the concurrent shop session owns 01xx, so this applies cleanly on top
-- of a database already carrying those.
CREATE INDEX IF NOT EXISTS "posts_public_published_idx"
	ON posts (published_at DESC NULLS LAST, id ASC)
	WHERE status = 'published'
	  AND deleted_at IS NULL
	  AND slug IS NOT NULL
	  AND published_at IS NOT NULL;

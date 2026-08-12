/**
 * The route catalogue behind docs/api/index.html.
 *
 * Extracted from the route sources, not from memory. Each entry names the file
 * it came from so a reader can check the claim, and so a route that moves takes
 * its documentation with it.
 *
 * Field notes:
 *   auth   one of: public | session | customer | writer | owner | webhook | cron | guest
 *   body   a literal request-body sketch; `null` means the route reads no body
 *   res    the success body sketch, keyed by status
 *   errs   [status, code, when]
 */

/* eslint-disable */
window.API_SURFACES = [
  {
    id: 'shop',
    name: 'Shop API',
    tagline: 'Storefront, cart, checkout, orders and payments.',
    blurb:
      'Everything a storefront needs: a public catalogue, an anonymous cart that survives sign-in, a checkout that reserves stock before it takes money, customer-visible orders, and a Paystack-backed payment flow. Admin routes for the same objects sit under <code>/api/shop/admin/*</code> and need a writer or owner session.',
    baseNote:
      'Storefront and admin routes are mounted under <code>/api/shop</code>. Payments carry their own full paths and are mounted at <code>/api</code>, which is why they read <code>/api/shop/payments/*</code> rather than being nested twice.',
  },
  {
    id: 'blog',
    name: 'Blog API',
    tagline: 'Authoring, publishing, revisions, media and backup.',
    blurb:
      'The publishing studio\'s own API: an invite-only account system, posts with compare-and-swap writes and an append-only revision log, presigned image upload, and a full export/import bundle. <strong>This is an authenticated admin API.</strong> Anonymous reading lives on its own surface — see the <strong>Public</strong> tab, and the "Public reading" section below for how the two relate.',
    baseNote:
      'Every route is mounted under <code>/api</code>. Nothing here is reachable without a session except <code>GET /api/health</code>, the three unauthenticated auth routes, and the separate <strong>Public API</strong> surface under <code>/api/public/*</code>.',
  },
  {
    id: 'public',
    name: 'Public API',
    tagline: 'Anonymous reading: published posts, images, feed, sitemap, taxonomy.',
    blurb:
      '<strong>No credential at all.</strong> This is the only surface that needs no cookie, no token and no header — anyone on the internet may call every route here, and every route is a <code>GET</code>. It exposes <strong>published posts only</strong>: a post that is a draft, archived, trashed, slug-less or published-without-a-date is not merely hidden from the list, it is unreachable by any route on this surface. Responses are cacheable, cross-origin readable from any origin, and carry <code>ETag</code>/<code>Last-Modified</code> so revalidation is cheap.',
    baseNote:
      'Every route is mounted under <code>/api/public</code>, <strong>above the session middleware</strong> — a handler here structurally cannot read a cookie, so a <code>Cache-Control: public</code> response is incapable of varying by reader. The response body is a deliberately narrow projection, not the admin <code>Post</code> with fields blanked out.',
  },
];

window.API_ROUTES = [
  /* ══════════════════════════════════════════════════════════════════════
     BLOG — Service
     ══════════════════════════════════════════════════════════════════════ */
  {
    surface: 'blog',
    group: 'Service',
    m: 'GET',
    p: '/api/health',
    auth: 'public',
    src: 'server/index.ts:109',
    sum: 'Liveness probe.',
    desc:
      'Registered above the database middleware on purpose: a probe that cannot answer without <code>DATABASE_URL</code> reports the environment rather than the process. It touches no database and reads no session.',
    res: { 200: `{ "ok": true }` },
    errs: [],
  },

  /* ── BLOG — Auth ────────────────────────────────────────────────────── */
  {
    surface: 'blog',
    group: 'Auth & invites',
    m: 'POST',
    p: '/api/auth/login',
    auth: 'public',
    src: 'server/routes/auth.ts:107',
    sum: 'Exchange an email and password for a session cookie.',
    desc:
      'An unknown email still costs a full scrypt verification against a dummy hash, so response timing does not distinguish "no such account" from "wrong password". A disabled account is answered identically too — all three are a plain 401.',
    body: `{
  "email": "writer@example.com",   // 1..320 chars, format not validated
  "password": "correct horse .."   // 1..1024 chars
}`,
    res: {
      200: `{ "user": { "id": "…", "email": "…", "displayName": "…", "role": "owner" | "writer" } }`,
    },
    sets: ['<code>__Host-studio_session</code> — HttpOnly, Secure, SameSite=Lax, Path=/'],
    rl: 'Two buckets, in order: <code>login:&lt;ip&gt;</code> at 20 / 15 min, then <code>login:&lt;ip&gt;|&lt;email&gt;</code> at 5 / 15 min. A successful login forgets only the narrow bucket — the IP bucket is never cleared.',
    errs: [
      [400, 'bad_request', '<code>detail</code> is <code>content-type</code>, <code>body</code>, <code>email</code>, <code>password</code>, or an unknown key name'],
      [401, 'unauthenticated', 'Wrong password, unknown email, or a disabled account — indistinguishable by design'],
      [429, 'rate_limited', 'Either bucket exhausted; carries <code>Retry-After</code>'],
    ],
  },
  {
    surface: 'blog',
    group: 'Auth & invites',
    m: 'POST',
    p: '/api/auth/logout',
    auth: 'public',
    src: 'server/routes/auth.ts:184',
    sum: 'Destroy the current session and clear the cookie.',
    desc:
      'Deliberately not behind <code>requireAuth</code>. Logging out of a session that is already gone should succeed, not 401, so the cookie is cleared unconditionally and the row is deleted only if one is found.',
    body: null,
    res: { 200: `{ "ok": true }` },
    errs: [[403, 'forbidden', 'Missing or unrecognised <code>Origin</code> header']],
  },
  {
    surface: 'blog',
    group: 'Auth & invites',
    m: 'GET',
    p: '/api/auth/me',
    auth: 'session',
    src: 'server/routes/auth.ts:193',
    sum: 'The account behind the current cookie.',
    desc: 'The cheapest way for a client to decide, at boot, whether it holds a live session.',
    res: { 200: `{ "user": { "id": "…", "email": "…", "displayName": "…", "role": "owner" | "writer" } }` },
    errs: [[401, 'unauthenticated', 'No session cookie, or the session has expired']],
  },
  {
    surface: 'blog',
    group: 'Auth & invites',
    m: 'POST',
    p: '/api/auth/accept-invite',
    auth: 'public',
    src: 'server/routes/auth.ts:197',
    sum: 'Redeem an invite token and create the account.',
    desc:
      'The body carries no <code>email</code> and no <code>role</code> — both come from the invite row, which is the authority. Accepting an invite for an address that already has an account hands the invite back rather than burning it.',
    body: `{
  "token": "…",                // 1..512 chars
  "password": "…",             // 1..1024, and at least 10 chars
  "displayName": "Ada L."      // 1..200, must be non-blank after trim
}`,
    res: { 201: `{ "user": { "id": "…", "email": "…", "displayName": "…", "role": "writer" } }` },
    sets: ['<code>__Host-studio_session</code>'],
    rl: '<code>accept:&lt;ip&gt;</code> at 20 / 15 min, checked before the body is parsed.',
    errs: [
      [400, 'bad_request', '<code>detail</code>: <code>password</code> (under 10 chars), <code>displayName</code> (blank), <code>invite</code> (unknown, spent or expired token), <code>email</code> (that address already has an account)'],
      [429, 'rate_limited', ''],
    ],
  },
  {
    surface: 'blog',
    group: 'Auth & invites',
    m: 'POST',
    p: '/api/invites',
    auth: 'owner',
    src: 'server/routes/auth.ts:239',
    sum: 'Invite a writer.',
    desc:
      'The response is the only place the raw token ever appears — the database stores an HMAC digest of it. The <code>url</code> is built from the first configured <code>APP_ORIGINS</code> entry, never from the request\'s <code>Host</code> header, so a forged host cannot mint a link pointing somewhere else.',
    body: `{
  "email": "new.writer@example.com",  // 1..320
  "role": "writer"                    // "owner" | "writer", default "writer"
}`,
    res: {
      201: `{
  "invite": {
    "id": "…", "email": "…", "role": "writer",
    "expiresAt": 1760000000000,
    "url": "https://studio.example.com/#/accept-invite?token=…"
  }
}`,
    },
    errs: [
      [400, 'bad_request', '<code>detail: "email"</code> when the address already has an account'],
      [401, 'unauthenticated', ''],
      [403, 'forbidden', 'Session is a writer, not the owner'],
    ],
  },
  {
    surface: 'blog',
    group: 'Auth & invites',
    m: 'GET',
    p: '/api/invites',
    auth: 'owner',
    src: 'server/routes/auth.ts:277',
    sum: 'List invites that are still open.',
    desc: 'Accepted and expired invites are excluded. Ordered newest first. Tokens are never returned.',
    res: {
      200: `{ "items": [ { "id": "…", "email": "…", "role": "writer",
            "createdAt": 0, "expiresAt": 0, "invitedBy": "…" } ] }`,
    },
    errs: [[401, 'unauthenticated', ''], [403, 'forbidden', '']],
  },
  {
    surface: 'blog',
    group: 'Auth & invites',
    m: 'DELETE',
    p: '/api/invites/:id',
    auth: 'owner',
    src: 'server/routes/auth.ts:281',
    sum: 'Revoke an unaccepted invite.',
    params: [['id', 'Invite id. Must be a UUID.']],
    res: { 200: `{ "ok": true }` },
    errs: [
      [400, 'bad_request', '<code>detail: "id"</code> — not a UUID'],
      [401, 'unauthenticated', ''],
      [403, 'forbidden', ''],
      [404, 'gone', 'Nothing was revoked — already accepted, expired, or never existed'],
    ],
  },

  /* ── BLOG — Posts ───────────────────────────────────────────────────── */
  {
    surface: 'blog',
    group: 'Posts',
    m: 'GET',
    p: '/api/posts',
    auth: 'session',
    src: 'server/routes/posts.ts:165',
    sum: 'List posts, with keyset pagination.',
    desc:
      'Returns <code>ListPost</code> — every field of <code>Post</code> <em>except</em> <code>content</code>, plus <code>authorName</code>. Any authenticated user sees every author\'s posts.<br><br><strong>The cursor is bound to the sort key that minted it.</strong> Spending an <code>updated</code> cursor under <code>oldest</code> is a 400, never a quietly wrong page. Change the sort and start from no cursor.<br><br><code>search</code> is full-text, not substring: it runs <code>websearch_to_tsquery(\'english\', …)</code>, so <code>ost</code> does not match <code>post</code>, and a query of nothing but stopwords returns zero rows.',
    query: [
      ['status', '<code>all</code> | <code>draft</code> | <code>published</code> | <code>archived</code> | <code>trash</code>. Default <code>all</code>. Every value except <code>trash</code> excludes trashed posts.'],
      ['sort', '<code>updated</code> | <code>published</code> | <code>oldest</code> | <code>alphabetical</code> | <code>drafts-first</code>. Default <code>updated</code>.'],
      ['search', 'Full-text query over title, subtitle and body.'],
      ['category', 'Exact match. An empty string means no filter.'],
      ['tag', 'Posts carrying this tag.'],
      ['cursor', 'Opaque, from the previous page\'s <code>nextCursor</code>.'],
      ['limit', 'Integer 1–100, default 24. Out of range is <strong>rejected, not clamped</strong>.'],
    ],
    res: {
      200: `{
  "items": [ { "id": "…", "title": "…", "subtitle": "…", "slug": "…" | null,
               "excerpt": "…", "excerptSource": "derived" | "author",
               "coverImage": { … } | null, "category": "…", "tags": ["…"],
               "template": "magazine"|"minimal"|"editorial"|"technical"|null,
               "status": "draft"|"published"|"archived",
               "createdAt": 0, "updatedAt": 0,
               "publishedAt": 0 | null, "deletedAt": 0 | null,
               "wordCount": 0, "readingTime": 0,
               "authorId": "…", "authorName": "…", "revision": 1 } ],
  "nextCursor": "…" | null
}`,
    },
    errs: [
      [400, 'bad_request', '<code>detail</code>: <code>limit</code> (out of range), <code>cursor</code> (undecodable, or minted under a different sort), <code>search</code>/<code>category</code>/<code>tag</code> (NUL byte), or an unknown query key'],
      [401, 'unauthenticated', ''],
    ],
  },
  {
    surface: 'blog',
    group: 'Posts',
    m: 'GET',
    p: '/api/posts/:id',
    auth: 'session',
    src: 'server/routes/posts.ts:182',
    sum: 'One post, including its document body.',
    params: [['id', 'Post id.']],
    desc: 'A post that never existed and a post that was destroyed are the same 404 — the id is never echoed back.',
    res: { 200: `{ "post": { …, "content": { "type": "doc", "content": [ … ] } } }` },
    errs: [[401, 'unauthenticated', ''], [404, 'gone', 'Absent or destroyed']],
  },
  {
    surface: 'blog',
    group: 'Posts',
    m: 'POST',
    p: '/api/posts',
    auth: 'session',
    src: 'server/routes/posts.ts:192',
    sum: 'Create a draft.',
    desc:
      'The body is optional in full — <code>POST</code> with no body at all creates an empty untitled draft. <code>slug</code>, <code>status</code>, <code>authorId</code> and <code>id</code> are server-authored and are <strong>rejected</strong> if you send them. The author is the session user; the post starts at revision 1 with a matching revision-1 snapshot.',
    body: `{
  "title":    "…",
  "subtitle": "…",
  "excerpt":  "…",
  "category": "…",
  "tags":     ["…"],                 // max 64
  "template": "magazine" | "minimal" | "editorial" | "technical" | null,
  "content":  { "type": "doc", "content": [ … ] },
  "coverImage": {
    "blobId": "…", "alt": "…", "focalPoint": "…",
    "width": 1200, "height": 630
  } | null
}`,
    res: { 201: `{ "post": { … } }` },
    errs: [
      [400, 'bad_request', 'Parse failure, or an unknown key such as <code>slug</code> or <code>status</code>'],
      [401, 'unauthenticated', ''],
      [422, 'invalid_document', 'Carries <code>path</code> and <code>reason</code> — see Document validation'],
    ],
  },
  {
    surface: 'blog',
    group: 'Posts',
    m: 'PATCH',
    p: '/api/posts/:id',
    auth: 'session',
    src: 'server/routes/posts.ts:227',
    sum: 'Save a post, with compare-and-swap.',
    params: [['id', 'Post id.']],
    desc:
      'Writable by the post\'s author or by the owner.<br><br><strong>Send <code>baseRevision</code>.</strong> Without it you are last-write-wins; with it, a save that lost a race comes back as a 409 carrying <code>expected</code>, <code>actual</code> <em>and the server\'s current post</em> — so a "load theirs" button needs no second request. A losing save writes nothing at all, <code>updated_at</code> included.<br><br><code>kind</code> may be <code>autosave</code> (default) or <code>manual</code>. <code>publish</code> and <code>status</code> are server-authored kinds and are refused, because those snapshots are never pruned.',
    body: `{
  "patch": { … same fields as POST /api/posts … },
  "baseRevision": 12,          // the revision you read
  "kind": "autosave" | "manual"
}`,
    res: { 200: `{ "post": { …, "revision": 13 } }` },
    errs: [
      [400, 'bad_request', 'Parse failure or unknown key'],
      [401, 'unauthenticated', ''],
      [403, 'forbidden', 'Not the author and not the owner'],
      [404, 'gone', 'Checked before authorization, so a missing post never leaks as a 403'],
      [409, 'stale_write', '<code>{ error, expected, actual, post }</code> — someone else saved first'],
      [422, 'invalid_document', ''],
    ],
    notes: [
      'Every tenth autosave triggers a best-effort prune that keeps the newest 30 autosaves plus every manual and lifecycle snapshot. A prune failure never fails the save.',
    ],
  },
  {
    surface: 'blog',
    group: 'Posts',
    m: 'POST',
    p: '/api/posts/:id/publish',
    alt: ['/api/posts/:id/unpublish', '/api/posts/:id/archive', '/api/posts/:id/unarchive', '/api/posts/:id/trash', '/api/posts/:id/restore'],
    auth: 'session',
    src: 'server/routes/posts.ts:287',
    sum: 'Six lifecycle transitions, one shape.',
    params: [['id', 'Post id.']],
    body: null,
    desc:
      'Author or owner. <strong>These routes read no body and take no <code>baseRevision</code>.</strong> The server re-reads, re-derives and re-attempts up to three times, pinning the post\'s lifecycle generation on the first read — so a concurrent <em>content</em> edit does not block the transition, but a concurrent <em>lifecycle</em> change does, and you get a 409 instead of having your intent silently re-applied.<br><br>Publishing writes a labelled snapshot into the revision log, so the history explains the status change rather than showing an unexplained revision jump.',
    res: { 200: `{ "post": { …, "status": "published", "revision": 14 } }` },
    errs: [
      [401, 'unauthenticated', ''],
      [403, 'forbidden', ''],
      [404, 'gone', ''],
      [409, 'stale_write', 'A concurrent lifecycle change won the race'],
      [409, 'precondition_failed', '<code>{ error, operation, post }</code> — an illegal transition, e.g. publishing an already-published post. Not a race'],
    ],
  },
  {
    surface: 'blog',
    group: 'Posts',
    m: 'POST',
    p: '/api/posts/:id/duplicate',
    auth: 'session',
    src: 'server/routes/posts.ts:306',
    sum: 'Copy a post into a new draft.',
    params: [['id', 'Source post id.']],
    body: null,
    desc:
      'Requires only <em>read</em> on the source, deliberately — copying someone else\'s post into your own draft does not modify theirs. The copy resets author to you, and clears slug, status and every timestamp.',
    res: { 201: `{ "post": { …, "status": "draft", "revision": 1 } }` },
    errs: [[401, 'unauthenticated', ''], [404, 'gone', '']],
  },
  {
    surface: 'blog',
    group: 'Posts',
    m: 'DELETE',
    p: '/api/posts/:id',
    auth: 'owner',
    src: 'server/routes/posts.ts:329',
    sum: 'Destroy a post permanently.',
    params: [['id', 'Post id.']],
    desc:
      '<strong>Owner only, and irreversible.</strong> Cascades to every revision of the post. Writers get a 403 — to remove their own work they use <code>POST /api/posts/:id/trash</code>.',
    res: { 200: `{ "ok": true }` },
    errs: [
      [401, 'unauthenticated', ''],
      [403, 'forbidden', 'Session is a writer'],
      [404, 'gone', 'Already destroyed'],
    ],
  },
  {
    surface: 'blog',
    group: 'Posts',
    m: 'POST',
    p: '/api/posts/sweep-blank',
    auth: 'session',
    src: 'server/routes/posts.ts:362',
    sum: 'Reap your own abandoned empty drafts.',
    desc:
      'Scoped to the calling user, so it can never touch another writer\'s work. A draft is only blank if its document is genuinely empty — an image-only, divider-only or unparseable document counts as content, which is the safe direction to fail. A 60-second grace period protects a draft that is open in another tab.',
    body: `{ "exceptId": "…" }        // optional; the draft you have open`,
    res: { 200: `{ "swept": 2 }` },
    errs: [[400, 'bad_request', ''], [401, 'unauthenticated', '']],
  },
  {
    surface: 'blog',
    group: 'Posts',
    m: 'POST',
    p: '/api/trash/empty',
    auth: 'owner',
    src: 'server/routes/posts.ts:383',
    sum: 'Hard-delete every trashed post.',
    body: null,
    desc: '<strong>Owner only, irreversible, and cascades to revisions.</strong> Atomic: all or nothing.',
    res: { 200: `{ "emptied": 7 }` },
    errs: [[401, 'unauthenticated', ''], [403, 'forbidden', '']],
  },

  /* ── BLOG — Revisions ───────────────────────────────────────────────── */
  {
    surface: 'blog',
    group: 'Revisions',
    m: 'GET',
    p: '/api/posts/:id/revisions',
    auth: 'session',
    src: 'server/routes/revisions.ts:50',
    sum: 'A post\'s revision history, newest first.',
    params: [['id', 'Post id.']],
    query: [
      ['cursor', 'From the previous page. Bound to the revision ordering — a post-list cursor is rejected here.'],
      ['limit', 'Integer 1–100, default 24.'],
    ],
    desc:
      'Returns metadata only — <code>content</code> is never included, so listing a long history stays cheap. Fetch a body with <code>GET /api/revisions/:revId</code>. The parent post is read and authorized first, so revision ids cannot be probed.',
    res: {
      200: `{
  "items": [ { "id": "…", "postId": "…", "revision": 14, "createdAt": 0,
               "authorId": "…", "title": "…", "subtitle": "…",
               "wordCount": 812,
               "kind": "autosave" | "manual" | "publish" | "status",
               "note": "…" } ],
  "nextCursor": "…" | null
}`,
    },
    errs: [[400, 'bad_request', ''], [401, 'unauthenticated', ''], [404, 'gone', '']],
  },
  {
    surface: 'blog',
    group: 'Revisions',
    m: 'GET',
    p: '/api/revisions/:revId',
    auth: 'session',
    src: 'server/routes/revisions.ts:70',
    sum: 'One revision, with its document body.',
    params: [['revId', 'Revision id.']],
    desc: 'The revision\'s parent post is fetched and authorized. If the parent is gone, so is this — 404.',
    res: { 200: `{ "revision": { …, "content": { "type": "doc", "content": [ … ] } } }` },
    errs: [[401, 'unauthenticated', ''], [404, 'gone', 'Unknown revision, or its parent post is gone']],
  },
  {
    surface: 'blog',
    group: 'Revisions',
    m: 'POST',
    p: '/api/posts/:id/revisions/:revId/restore',
    auth: 'session',
    src: 'server/routes/revisions.ts:88',
    sum: 'Restore an old version — forward, never backward.',
    params: [['id', 'Post id.'], ['revId', 'Revision to restore. Must belong to this post.']],
    body: null,
    desc:
      'Author or owner. Restoring writes the old content as a <em>new</em> revision, so nothing is rewound and the pre-restore version stays reachable in the history.<br><br>No <code>baseRevision</code> by design: a restore is a deliberate human action and must not be refused by a concurrent autosave. The lookup is scoped to the post, so you cannot pull another post\'s revision in.',
    res: { 200: `{ "post": { …, "revision": 15 } }` },
    errs: [
      [401, 'unauthenticated', ''],
      [403, 'forbidden', ''],
      [404, 'gone', 'Unknown post, or that revision does not belong to it'],
      [422, 'invalid_document', 'The restored document is re-validated'],
    ],
  },

  /* ── BLOG — Backup ──────────────────────────────────────────────────── */
  {
    surface: 'blog',
    group: 'Backup',
    m: 'GET',
    p: '/api/export',
    auth: 'owner',
    src: 'server/routes/backup.ts:50',
    sum: 'Download the whole library as a bundle.',
    desc:
      'Owner only — it contains every writer\'s drafts and full history. <code>images</code> is present in the shape but always empty: image bytes live in R2 and are not inlined.',
    rl: '<code>export:&lt;userId&gt;</code> at 5 / hour.',
    res: {
      200: `{
  "format": "publishing-studio/v2",
  "exportedAt": "2026-08-12T04:00:00.000Z",
  "posts":     [ { … full Post, including content … } ],
  "revisions": [ { … full Revision, including content … } ],
  "images":    []
}`,
    },
    errs: [[401, 'unauthenticated', ''], [403, 'forbidden', ''], [429, 'rate_limited', '']],
  },
  {
    surface: 'blog',
    group: 'Backup',
    m: 'POST',
    p: '/api/import',
    auth: 'session',
    src: 'server/routes/backup.ts:118',
    sum: 'Import a bundle of posts.',
    desc:
      '<strong>Everything is validated before anything is written.</strong> The first bad document is a 422 naming <code>posts[i].&lt;path&gt;</code>, and no row is created — a bundle imports completely or not at all.<br><br>Two things the bundle cannot carry back: <code>revisions</code> and <code>images</code> are accepted, counted under <code>ignored</code>, and never restored. <code>authorId</code> is always the importing session regardless of what the bundle says, and <code>revision</code>, <code>wordCount</code> and <code>readingTime</code> are re-derived.<br><br>A post whose id already exists is skipped, not overwritten.',
    rl: '<code>import:&lt;userId&gt;</code> at 5 / hour, <strong>checked before the body is parsed</strong> — so a malformed bundle still spends one of the five.',
    body: `{
  "format": "publishing-studio/v2",   // must start with "publishing-studio/"
  "exportedAt": "…",
  "posts": [ {
    "id": "…",                        // required
    "title": "…", "subtitle": "…",
    "slug": "…" | null,
    "excerpt": "…", "excerptSource": "derived" | "author",
    "content": { "type": "doc", … },
    "coverImage": { … } | null,
    "category": "…", "tags": ["…"],
    "template": "…" | null,
    "status": "draft" | "published" | "archived",
    "createdAt": 0, "updatedAt": 0,
    "publishedAt": 0 | null, "deletedAt": 0 | null
  } ],                                // max 20 000
  "revisions": [],                    // counted, never restored
  "images": []                        // counted, never restored
}`,
    res: {
      200: `{ "imported": 12, "skipped": 3,
  "ignored": { "revisions": 480, "images": 0 } }`,
    },
    errs: [
      [400, 'bad_request', '<code>detail: "format"</code> (wrong prefix), <code>"posts.id"</code> (duplicate id inside the bundle), or a parse failure'],
      [401, 'unauthenticated', ''],
      [422, 'invalid_document', '<code>path</code> is <code>posts[i].&lt;field&gt;</code>. Nothing was written'],
      [429, 'rate_limited', ''],
    ],
  },

  /* ── BLOG — Images ──────────────────────────────────────────────────── */
  {
    surface: 'blog',
    group: 'Images',
    m: 'POST',
    p: '/api/images',
    auth: 'session',
    src: 'server/routes/images.ts:139',
    sum: 'Reserve an upload slot and get a presigned PUT.',
    desc:
      '<strong>Step 1 of 2.</strong> The returned <code>uploadUrl</code> and <code>headers</code> are signature inputs — send them verbatim, unchanged, or R2 rejects the upload. Content type and content length are bound into the signature, so the slot cannot be used to upload something other than what you declared.<br><br>Limits per owner: 10 open uncommitted slots, 1 GiB total, 12 MiB per image. Allowed types are JPEG, PNG, GIF, WebP and AVIF.',
    rl: '<code>images:&lt;userId&gt;</code> at 120 / hour, checked before the body is parsed.',
    body: `{
  "contentType": "image/jpeg",   // must be in the allow-list
  "byteSize": 482113,            // > 0 and <= 12 MiB
  "checksum": "…"                // optional; stored, not yet used
}`,
    res: {
      201: `{
  "id": "img_…",
  "uploadUrl": "https://…",      // PUT the bytes here, verbatim
  "headers": { "content-type": "image/jpeg", "content-length": "482113" },
  "expiresIn": 300
}`,
    },
    errs: [
      [400, 'bad_request', '<code>detail</code>: <code>contentType</code> (not allowed), <code>byteSize</code> (≤0 or over 12 MiB), <code>slots</code> (10 already open), <code>quota</code> (would exceed 1 GiB), <code>storage</code> (R2 is not configured — a 400 because it is permanent for this request, and the reserved row is rolled back)'],
      [401, 'unauthenticated', ''],
      [429, 'rate_limited', ''],
    ],
  },
  {
    surface: 'blog',
    group: 'Images',
    m: 'POST',
    p: '/api/images/:id/commit',
    auth: 'session',
    src: 'server/routes/images.ts:331',
    sum: 'Confirm the upload, after the bytes are in place.',
    params: [['id', 'The slot id from step 1.']],
    body: null,
    desc:
      '<strong>Step 2 of 2, and it does not trust you.</strong> The server re-reads the object\'s real size, pulls the first 64 KiB, and identifies the format from <em>magic bytes</em>. If the sniffed type does not equal the type you declared, the row and the object are both deleted.<br><br>For JPEG it also enforces the EXIF strip: an image whose EXIF state is <code>present</code> — or <code>unknown</code>, because the buffer ran out — is rejected and deleted. "Cannot tell" is treated as "reject", not "accept".<br><br>Idempotent: committing an already-committed slot returns 200 with the same body.',
    rl: '<code>images:commit:&lt;userId&gt;</code> at 240 / hour, applied before any R2 call — so a stranger cannot use this route to spend your egress.',
    res: {
      200: `{ "image": { "id": "img_…", "contentType": "image/jpeg",
             "width": 1600, "height": 900, "byteSize": 482113,
             "createdAt": 0, "committedAt": 0 } }`,
    },
    errs: [
      [400, 'bad_request', '<code>detail</code>: <code>object</code> (nothing at the key), <code>byteSize</code> (real size out of range), <code>contentType</code> (unsniffable, or sniffed ≠ declared), <code>exif</code> (JPEG EXIF present or indeterminate), <code>quota</code>'],
      [401, 'unauthenticated', ''],
      [404, 'gone', 'Unknown id, or someone else\'s slot — the two are byte-identical, so this cannot be used as an existence oracle'],
      [429, 'rate_limited', ''],
    ],
  },
  {
    surface: 'blog',
    group: 'Images',
    m: 'GET',
    p: '/api/images/:id',
    auth: 'session',
    src: 'server/routes/images.ts:456',
    sum: 'Redirect to a short-lived signed URL for the bytes.',
    params: [['id', 'Committed image id.']],
    desc:
      'Answers <strong>302</strong>, not the bytes — follow the <code>Location</code> to a presigned GET valid for 5 minutes. Carries <code>cache-control: private, no-store</code> so the redirect itself is never cached.<br><br>Any authenticated user may fetch any committed image; there is no per-owner scope on reads. An uncommitted image is a 404.',
    res: { 302: `Location: https://…  (presigned, 5 minutes)` },
    errs: [[401, 'unauthenticated', ''], [404, 'gone', 'Absent, or uploaded but never committed']],
  },
  {
    surface: 'blog',
    group: 'Images',
    m: 'POST',
    p: '/api/images/collect-orphans',
    auth: 'owner',
    src: 'server/routes/images.ts:501',
    sum: 'Garbage-collect unreferenced images.',
    query: [['dryRun', '<code>1</code> or <code>true</code> to preview. Anything else runs for real.']],
    body: null,
    desc:
      'Owner only — it deletes bytes across every writer\'s work. Collection is <strong>two-phase with a 24-hour quarantine</strong>: a mark pass stamps images the reference walk did not reach, and only images unreferenced <em>continuously</em> for 24 hours are deleted. Cutting an image out of one post to paste it into another therefore cannot lose it.<br><br>The reference set is re-derived inside the delete statement, so a stale mark can never outvote a live reference. References are found in post bodies, cover images, revisions and trashed posts.<br><br><code>dryRun=1</code> writes nothing at all — not even the mark pass, since stamping clocks during a preview would move every listed image a day closer to deletion.<br><br>If a malformed document blocks the walk, the response says so: <code>blocked</code> and <code>blockedBy</code> name the offending rows, so "nothing to collect" and "stuck for months" are distinguishable.',
    res: {
      200: `{
  "dryRun": false,
  "collected": 4,
  "collectedImages": [ { "id": "…", "ownerId": "…",
                         "byteSize": 0, "unreferencedSince": 0 } ],
  "swept": 2,
  "sweptImages": [ { "id": "…" } ],
  "unreferenced": 9,
  "marked": 5,                 // omitted on a dry run
  "more": false,               // true if the batch was bounded — call again
  "blocked": false,
  "blockedBy": [ { "source": "post" | "revision", "id": "…" } ]
}`,
    },
    errs: [
      [400, 'bad_request', 'Unknown query key, or a bad <code>dryRun</code> value'],
      [401, 'unauthenticated', ''],
      [403, 'forbidden', ''],
    ],
  },

  /* ══════════════════════════════════════════════════════════════════════
     SHOP — Catalog
     ══════════════════════════════════════════════════════════════════════ */
  {
    surface: 'shop',
    group: 'Catalog (public)',
    m: 'GET',
    p: '/api/shop/products',
    auth: 'public',
    src: 'server/shop/catalog/routes.ts:203',
    sum: 'Browse active products.',
    desc: 'Only active products. Keyset pagination, same cursor discipline as the blog list — the cursor is bound to its sort.',
    query: [
      ['sort', '<code>newest</code> | <code>price_asc</code> | <code>price_desc</code> | <code>alphabetical</code>. Default <code>newest</code>.'],
      ['category', 'Exact match.'],
      ['cursor', 'From the previous page.'],
      ['limit', 'Integer 1–100, default 24.'],
    ],
    res: {
      200: `{
  "items": [ { "id": "…", "slug": "…" | null, "title": "…",
               "description": { "type": "doc", … },
               "status": "active", "category": "…", "tags": ["…"],
               "coverImageId": "…" | null, "imageIds": ["…"],
               "createdAt": 0, "updatedAt": 0,
               "publishedAt": 0 | null, "deletedAt": null,
               "authorId": "…", "revision": 3 } ],
  "nextCursor": "…" | null
}`,
    },
    errs: [[400, 'bad_request', 'Bad query or cursor']],
  },
  {
    surface: 'shop',
    group: 'Catalog (public)',
    m: 'GET',
    p: '/api/shop/products/:slug',
    auth: 'public',
    src: 'server/shop/catalog/routes.ts:215',
    sum: 'One active product, with its purchasable variants.',
    params: [['slug', 'Product slug.']],
    desc: 'Each variant carries its current price, live availability and whether it can be backordered — everything a product page needs in one request.',
    res: {
      200: `{ "product": { …,
    "variants": [ { "id": "…", "productId": "…", "sku": "…",
                    "optionValues": { "size": "M" },
                    "position": 0, "weightGrams": 250 | null,
                    "status": "active" | "discontinued",
                    "createdAt": 0, "updatedAt": 0,
                    "price": { "amount": 1999, "currency": "GBP" } | null,
                    "available": 12 | null,
                    "backorderable": false } ] } }`,
    },
    errs: [[400, 'bad_request', ''], [404, 'gone', 'No active product with that slug']],
  },
  {
    surface: 'shop',
    group: 'Catalog (public)',
    m: 'GET',
    p: '/api/shop/variants/:id/availability',
    auth: 'public',
    src: 'server/shop/catalog/routes.ts:233',
    sum: 'Live stock for one variant.',
    params: [['id', 'Variant id.']],
    desc: 'A cheap poll for a product page that has been open a while. <code>available</code> is null when the variant is not stock-tracked.',
    res: { 200: `{ "variantId": "…", "available": 12 | null, "backorderable": false }` },
    errs: [[400, 'bad_request', ''], [404, 'gone', '']],
  },
  {
    surface: 'shop',
    group: 'Catalog (admin)',
    m: 'GET',
    p: '/api/shop/admin/products',
    auth: 'session',
    src: 'server/shop/catalog/routes.ts:251',
    sum: 'List products in any state.',
    query: [
      ['status', '<code>draft</code> | <code>active</code> | <code>archived</code> | <code>trash</code>.'],
      ['sort', 'As the public list.'],
      ['category', ''],
      ['cursor', ''],
      ['limit', 'Integer 1–100, default 24.'],
    ],
    desc: 'The same list as the storefront but with unpublished products included.',
    res: { 200: `{ "items": [ { … Product … } ], "nextCursor": "…" | null }` },
    errs: [[400, 'bad_request', ''], [401, 'unauthenticated', '']],
  },
  {
    surface: 'shop',
    group: 'Catalog (admin)',
    m: 'GET',
    p: '/api/shop/admin/products/:id',
    auth: 'session',
    src: 'server/shop/catalog/routes.ts:257',
    sum: 'One product by id, any state, with variants.',
    params: [['id', 'Product id.']],
    res: { 200: `{ "product": { …, "variants": [ { … } ] } }` },
    errs: [[400, 'bad_request', ''], [401, 'unauthenticated', ''], [404, 'gone', '']],
  },
  {
    surface: 'shop',
    group: 'Catalog (admin)',
    m: 'POST',
    p: '/api/shop/admin/products',
    auth: 'session',
    src: 'server/shop/catalog/routes.ts:266',
    sum: 'Create a draft product.',
    desc:
      'The body may be omitted entirely. <code>slug</code> and <code>status</code> are server-authored and rejected if sent — a product becomes active through <code>/publish</code>, and its slug is derived on the way.',
    body: `{
  "title": "…",
  "description": { "type": "doc", … },
  "category": "…",              // <= 400 chars
  "tags": ["…"],                // <= 64
  "coverImageId": "…" | null,   // <= 300 chars
  "imageIds": ["…"]             // <= 100 entries
}`,
    res: { 201: `{ "product": { …, "status": "draft", "revision": 1 } }` },
    errs: [[400, 'bad_request', ''], [401, 'unauthenticated', ''], [422, 'invalid_document', '']],
  },
  {
    surface: 'shop',
    group: 'Catalog (admin)',
    m: 'PATCH',
    p: '/api/shop/admin/products/:id',
    auth: 'session',
    src: 'server/shop/catalog/routes.ts:277',
    sum: 'Edit a product, with compare-and-swap.',
    params: [['id', 'Product id.']],
    desc:
      'Same CAS contract as posts, with one difference worth knowing: the 409 body carries <code>product</code>, not <code>post</code>. It is the full current row from a single re-read, so a "load theirs" needs no follow-up request.',
    body: `{
  "patch": { … same fields as POST … },
  "baseRevision": 3,
  "note": "…"                   // optional, <= 400 chars
}`,
    res: { 200: `{ "product": { …, "revision": 4 } }` },
    errs: [
      [400, 'bad_request', ''],
      [401, 'unauthenticated', ''],
      [403, 'forbidden', 'Missing or unrecognised <code>Origin</code>'],
      [404, 'gone', ''],
      [409, 'stale_write', '<code>{ error, expected, actual, product }</code>'],
      [409, 'precondition_failed', '<code>{ error, operation, product }</code>'],
      [422, 'invalid_document', ''],
    ],
  },
  {
    surface: 'shop',
    group: 'Catalog (admin)',
    m: 'POST',
    p: '/api/shop/admin/products/:id/publish',
    alt: ['/api/shop/admin/products/:id/unpublish', '/api/shop/admin/products/:id/archive', '/api/shop/admin/products/:id/unarchive', '/api/shop/admin/products/:id/restore'],
    auth: 'session',
    src: 'server/shop/catalog/routes.ts:312',
    sum: 'Five lifecycle transitions.',
    params: [['id', 'Product id.']],
    body: null,
    desc: 'No body, no <code>baseRevision</code> — same design as the post lifecycle routes. An illegal transition is a <code>precondition_failed</code> 409, not a race.',
    res: { 200: `{ "product": { … } }` },
    errs: [[401, 'unauthenticated', ''], [403, 'forbidden', ''], [404, 'gone', ''], [409, 'precondition_failed', '']],
  },
  {
    surface: 'shop',
    group: 'Catalog (admin)',
    m: 'DELETE',
    p: '/api/shop/admin/products/:id',
    auth: 'session',
    src: 'server/shop/catalog/routes.ts:326',
    sum: 'Move a product to trash.',
    params: [['id', 'Product id.']],
    desc: '<strong>A soft delete.</strong> Unlike <code>DELETE /api/posts/:id</code>, this is reversible — the product comes back with <code>/restore</code>, and the response is the trashed row.',
    res: { 200: `{ "product": { …, "status": "trash" } }` },
    errs: [[401, 'unauthenticated', ''], [404, 'gone', ''], [409, 'precondition_failed', '']],
  },
  {
    surface: 'shop',
    group: 'Catalog (admin)',
    m: 'POST',
    p: '/api/shop/admin/products/:id/variants',
    auth: 'session',
    src: 'server/shop/catalog/routes.ts:330',
    sum: 'Add a variant.',
    params: [['id', 'Product id.']],
    body: `{
  "sku": "TEE-BLK-M",                    // required, 1..200
  "optionValues": { "colour": "black", "size": "M" },
  "position": 0,
  "weightGrams": 250,                    // 0..10 000 000, or null
  "onHand": 40,                          // opening stock
  "backorderable": false
}`,
    res: { 201: `{ "variant": { … } }` },
    errs: [[400, 'bad_request', ''], [401, 'unauthenticated', ''], [404, 'gone', ''], [409, 'precondition_failed', '']],
  },
  {
    surface: 'shop',
    group: 'Catalog (admin)',
    m: 'PATCH',
    p: '/api/shop/admin/variants/:id',
    auth: 'session',
    src: 'server/shop/catalog/routes.ts:341',
    sum: 'Edit a variant.',
    params: [['id', 'Variant id.']],
    desc: 'Price is not editable here — it is an append-only series with its own route, so a price change never silently rewrites history.',
    body: `{
  "sku": "…",
  "optionValues": { … },
  "position": 1,
  "weightGrams": 250 | null,
  "status": "active" | "discontinued"
}`,
    res: { 200: `{ "variant": { … } }` },
    errs: [[400, 'bad_request', ''], [401, 'unauthenticated', ''], [404, 'gone', '']],
  },
  {
    surface: 'shop',
    group: 'Catalog (admin)',
    m: 'PUT',
    p: '/api/shop/admin/variants/:id/price',
    auth: 'session',
    src: 'server/shop/catalog/routes.ts:351',
    sum: 'Set the current price.',
    params: [['id', 'Variant id.']],
    desc:
      '<strong><code>amount</code> is in minor units.</strong> £19.99 is <code>1999</code>. Sending <code>19.99</code> is a 400 — there are no floats anywhere in this API.<br><br>Prices are an append-only series: this closes the previous row and opens a new one, so an old order can still be explained by the price that was live when it was placed.',
    body: `{
  "amount": 1999,       // integer minor units, >= 0
  "currency": "GBP"     // exactly three uppercase letters (ISO 4217)
}`,
    res: {
      200: `{ "price": { "id": "…", "variantId": "…",
             "amount": 1999, "currency": "GBP",
             "effectiveFrom": 0, "effectiveTo": null, "createdAt": 0 } }`,
    },
    errs: [
      [400, 'bad_request', '<code>detail: "amount"</code> (not a non-negative integer) or <code>"currency"</code> (not three uppercase letters)'],
      [401, 'unauthenticated', ''],
      [404, 'gone', ''],
    ],
  },
  {
    surface: 'shop',
    group: 'Catalog (admin)',
    m: 'GET',
    p: '/api/shop/admin/variants/:id/prices',
    auth: 'session',
    src: 'server/shop/catalog/routes.ts:372',
    sum: 'The full price history for a variant.',
    params: [['id', 'Variant id.']],
    res: { 200: `{ "prices": [ { …, "effectiveFrom": 0, "effectiveTo": 0 | null } ] }` },
    errs: [[401, 'unauthenticated', ''], [404, 'gone', '']],
  },
  {
    surface: 'shop',
    group: 'Catalog (admin)',
    m: 'POST',
    p: '/api/shop/admin/inventory/:variantId/adjust',
    auth: 'session',
    src: 'server/shop/catalog/routes.ts:380',
    sum: 'Move stock by a relative delta.',
    params: [['variantId', 'Variant id.']],
    desc:
      'Relative, never absolute — two concurrent adjustments both land, where two absolute sets would lose one. <code>reason</code> is required and must be non-blank: every stock movement is explained in the ledger.',
    body: `{
  "delta": -3,                  // non-zero integer; 0 is a 400
  "reason": "damaged in transit" // 1..400 chars, non-blank
}`,
    res: {
      200: `{ "inventory": { "variantId": "…", "onHand": 37, "reserved": 2,
                 "available": 35, "backorderable": false,
                 "updatedAt": 0 } }`,
    },
    errs: [
      [400, 'bad_request', '<code>detail: "delta"</code> (zero or non-integer) or <code>"reason"</code> (blank)'],
      [401, 'unauthenticated', ''],
      [404, 'gone', ''],
    ],
  },

  /* ── SHOP — Cart ────────────────────────────────────────────────────── */
  {
    surface: 'shop',
    group: 'Cart',
    m: 'POST',
    p: '/api/shop/cart',
    auth: 'public',
    src: 'server/shop/cart/routes/cart.ts:55',
    sum: 'Create a cart — or hand back the one you already have.',
    body: null,
    desc:
      '<strong>Safe to call on every page load.</strong> If the <code>__Host-shop_cart</code> cookie already names a live cart you get <code>200</code> with that cart and no rate-limit charge; only a genuinely new cart is <code>201</code> and spends a slot.<br><br>Carts are anonymous. Signing in later merges the anonymous cart into the customer\'s, and the merge is reported in <code>changes</code>.',
    res: { 200: 'The cart view — see the panel below.', 201: 'Same shape; a new cart was created and the cookie was set.' },
    sets: ['<code>__Host-shop_cart</code> — on creation, or when a merge changes the cart id'],
    rl: '<code>shop-cart-new:&lt;ip&gt;</code> at 20 / hour, charged only when a cart is actually created.',
    errs: [[403, 'forbidden', 'Missing or unrecognised <code>Origin</code>'], [429, 'rate_limited', '']],
    cartView: true,
  },
  {
    surface: 'shop',
    group: 'Cart',
    m: 'GET',
    p: '/api/shop/cart',
    auth: 'public',
    src: 'server/shop/cart/routes/cart.ts:76',
    sum: 'The current cart.',
    desc:
      'Never creates a cart and never rate-limits. With no cookie, or a cookie naming a cart that is gone, you get a well-formed empty answer rather than a 404 — a fresh visitor is not an error.<br><br><strong><code>preview</code> is null if <em>any</em> line cannot be priced</strong> — a partial total would be a lie, so none is offered.',
    res: { 200: `{ "cart": null, "lines": [], "preview": null, "changes": [] }   // fresh visitor` },
    errs: [],
    cartView: true,
  },
  {
    surface: 'shop',
    group: 'Cart',
    m: 'POST',
    p: '/api/shop/cart/lines',
    auth: 'public',
    src: 'server/shop/cart/routes/cart.ts:83',
    sum: 'Add a line.',
    desc: 'Requires an existing cart — call <code>POST /api/shop/cart</code> first. Returns the whole cart view, so a client never needs a follow-up read.',
    body: `{
  "variantId": "…",      // 1..128
  "qty": 2,              // 1..10 000
  "baseRevision": 4      // optional; opt in to conflict detection
}`,
    res: { 201: 'The cart view.' },
    rl: '<code>shop-cart-write:&lt;cartId&gt;</code> at 120 / 10 min.',
    errs: [
      [400, 'bad_request', ''],
      [404, 'gone', 'No cart cookie, or the cart is gone'],
      [409, 'stale_write', '<code>{ error, expected, actual, cart }</code>'],
      [409, 'precondition_failed', '<code>{ error, operation, cart }</code>'],
      [429, 'rate_limited', ''],
    ],
    cartView: true,
  },
  {
    surface: 'shop',
    group: 'Cart',
    m: 'PATCH',
    p: '/api/shop/cart/lines/:id',
    auth: 'public',
    src: 'server/shop/cart/routes/cart.ts:97',
    sum: 'Change a line\'s quantity.',
    params: [['id', 'Cart line id.']],
    body: `{ "qty": 3, "baseRevision": 5 }`,
    res: { 200: 'The cart view.' },
    rl: '<code>shop-cart-write:&lt;cartId&gt;</code> at 120 / 10 min.',
    errs: [[400, 'bad_request', ''], [404, 'gone', ''], [409, 'stale_write', ''], [409, 'precondition_failed', ''], [429, 'rate_limited', '']],
    cartView: true,
  },
  {
    surface: 'shop',
    group: 'Cart',
    m: 'DELETE',
    p: '/api/shop/cart/lines/:id',
    auth: 'public',
    src: 'server/shop/cart/routes/cart.ts:128',
    sum: 'Remove a line.',
    params: [['id', 'Cart line id.']],
    desc: 'The body is optional in full — send nothing, or send a <code>baseRevision</code> to make the removal conflict-aware.',
    body: `{ "baseRevision": 6 }     // optional; the whole body may be omitted`,
    res: { 200: 'The cart view.' },
    rl: '<code>shop-cart-write:&lt;cartId&gt;</code> at 120 / 10 min.',
    errs: [[400, 'bad_request', ''], [404, 'gone', ''], [409, 'stale_write', ''], [429, 'rate_limited', '']],
    cartView: true,
  },

  /* ── SHOP — Checkout ────────────────────────────────────────────────── */
  {
    surface: 'shop',
    group: 'Checkout',
    m: 'POST',
    p: '/api/shop/checkout/start',
    auth: 'public',
    src: 'server/shop/cart/routes/checkout.ts:49',
    sum: 'Reserve stock and begin checkout.',
    body: null,
    desc:
      '<strong>This is where stock is actually held.</strong> Reservations expire, so a checkout that is abandoned returns the stock without anyone intervening.<br><br>If stock ran out between browsing and here, the answer is a 409 naming exactly which variants fell short and by how much — enough to render "only 2 left" against the right line without another request.',
    res: { 200: `{ "reservations": [ { "id": "…", "variantId": "…", "qty": 2, "expiresAt": 0 } ] }` },
    rl: '<code>shop-checkout:&lt;cartId&gt;</code> at 10 / 15 min.',
    errs: [
      [403, 'forbidden', ''],
      [404, 'gone', 'No cart'],
      [409, 'precondition_failed', '<code>{ error, operation: "checkout_start" }</code> — the cart is empty'],
      [409, 'insufficient_stock', '<code>{ error, shortfalls: [ { variantId, requested, available } ] }</code>'],
      [429, 'rate_limited', ''],
    ],
  },
  {
    surface: 'shop',
    group: 'Checkout',
    m: 'PUT',
    p: '/api/shop/checkout/addresses',
    auth: 'public',
    src: 'server/shop/cart/routes/checkout.ts:81',
    sum: 'Set shipping (and optionally billing) address.',
    desc: 'Setting the address is what determines the tax zone and unlocks shipping options — the response returns both, so this is one request rather than three.',
    body: `{
  "shipping": {
    "name": "…",            // 1..200, required
    "line1": "…",           // 1..200, required
    "line2": "…" | null,
    "city": "…",            // 1..120, required
    "region": "…" | null,
    "postalCode": "…" | null,
    "countryCode": "GB",    // exactly two uppercase letters, required
    "phone": "…" | null
  },
  "billing": { … } | null,  // defaults to the shipping address
  "baseRevision": 6
}`,
    res: {
      200: `{ "zone": "UK",
  "options": [ { "id": "std", "label": "Standard (3–5 days)",
                 "amount": { "amount": 395, "currency": "GBP" },
                 "taxable": true } ] }`,
    },
    errs: [
      [400, 'bad_request', '<code>detail: "countryCode"</code> is the common one — it must be two uppercase letters'],
      [403, 'forbidden', ''],
      [404, 'gone', ''],
      [409, 'stale_write', ''],
      [409, 'precondition_failed', ''],
    ],
  },
  {
    surface: 'shop',
    group: 'Checkout',
    m: 'GET',
    p: '/api/shop/checkout/shipping-options',
    auth: 'public',
    src: 'server/shop/cart/routes/checkout.ts:94',
    sum: 'Shipping options for the current address.',
    desc: '<strong>Returns <code>[]</code> until a shipping address is set</strong> — rates depend on the destination, so there is nothing honest to return before then. That empty array is not an error.',
    res: { 200: `{ "options": [ { "id": "…", "label": "…", "amount": { "amount": 395, "currency": "GBP" }, "taxable": true } ] }` },
    errs: [[404, 'gone', 'No cart']],
  },
  {
    surface: 'shop',
    group: 'Checkout',
    m: 'PUT',
    p: '/api/shop/checkout/shipping',
    auth: 'public',
    src: 'server/shop/cart/routes/checkout.ts:100',
    sum: 'Choose a shipping option.',
    body: `{ "optionId": "std", "baseRevision": 7 }`,
    res: { 200: `{ "shipping": { "id": "std", "label": "…", "amount": { "amount": 395, "currency": "GBP" }, "taxable": true } }` },
    errs: [[400, 'bad_request', ''], [403, 'forbidden', ''], [404, 'gone', ''], [409, 'stale_write', ''], [409, 'precondition_failed', '']],
  },
  {
    surface: 'shop',
    group: 'Checkout',
    m: 'POST',
    p: '/api/shop/checkout/freeze',
    auth: 'public',
    src: 'server/shop/cart/routes/checkout.ts:119',
    sum: 'Lock the totals before taking payment.',
    desc:
      '<strong>Call this immediately before creating a payment intent.</strong> It computes and freezes the totals, and extends the stock reservations once, so the number you show the customer is the number they are charged.<br><br>Three distinct 409s here, and they mean different things: some line became unbuyable, a currency disagreement was detected, or a general precondition (empty cart, unusable currency) failed.',
    body: `{ "baseRevision": 8 }     // optional; the whole body may be omitted`,
    res: {
      200: `{ "totals": {
    "currency": "GBP",
    "lines": [ { "variantId": "…", "qty": 2,
                 "unit":      { "amount": 1999, "currency": "GBP" },
                 "lineTotal": { "amount": 3998, "currency": "GBP" },
                 "taxable": true,
                 "taxAmount": { "amount": 800, "currency": "GBP" } } ],
    "shipping": { "id": "std", "label": "…", "amount": { … }, "taxable": true } | null,
    "tax": { "zone": "UK", "label": "VAT", "rateBps": 2000 },
    "adjustments": [ { "code": "…", "label": "…", "amount": { … } } ],
    "subtotal":        { "amount": 3998, "currency": "GBP" },
    "adjustmentTotal": { "amount": 0,    "currency": "GBP" },
    "shippingTotal":   { "amount": 395,  "currency": "GBP" },
    "taxTotal":        { "amount": 879,  "currency": "GBP" },
    "grandTotal":      { "amount": 5272, "currency": "GBP" },
    "rounding": "half-up"
} }`,
    },
    errs: [
      [400, 'bad_request', ''],
      [403, 'forbidden', ''],
      [404, 'gone', ''],
      [409, 'unavailable_lines', '<code>{ error, variantIds: [ … ] }</code>'],
      [409, 'currency_mismatch', '<code>{ error, expected, found: [ { where, currency } ] }</code>'],
      [409, 'precondition_failed', '<code>{ error, operation }</code> — empty cart, unusable currency'],
    ],
  },
  {
    surface: 'shop',
    group: 'Checkout',
    m: 'GET',
    p: '/api/shop/checkout/totals',
    auth: 'public',
    src: 'server/shop/cart/routes/checkout.ts:149',
    sum: 'Read back the frozen totals.',
    desc: 'A 404 here means the cart is not frozen yet — call <code>/checkout/freeze</code> first.',
    res: { 200: `{ "totals": { … the frozen totals … } }` },
    errs: [[404, 'gone', 'No cart, or not frozen']],
  },
  {
    surface: 'shop',
    group: 'Checkout',
    m: 'GET',
    p: '/api/shop/admin/cart/maintenance',
    auth: 'cron',
    src: 'server/shop/cart/routes/checkout.ts:185',
    sum: 'Scheduled maintenance drain (cron).',
    desc:
      'Authenticated by <code>Authorization: Bearer &lt;CRON_SECRET&gt;</code> — no session, no cookie. It fails closed: an absent or under-16-character secret is a 401, so a misconfigured deployment cannot leave this route open.<br><br>This deployment runs on Vercel Hobby, where cron is <strong>once per day</strong>. The job therefore drains until empty against a wall-clock budget rather than doing one fixed batch, and reports <code>exhausted</code> when it ran out of budget with work left.',
    query: [['limit', 'Batch size. Defaults to 50.']],
    res: {
      200: `{
  "drain": { "scanned": 0, "applied": 0, "ignored": 0,
             "parked": 0, "abandoned": 0 },
  "sweep": { "released": 0, "failed": 0 },
  "passes": 3,
  "exhausted": false
}`,
    },
    errs: [[401, 'unauthenticated', 'Absent, short or wrong secret']],
  },
  {
    surface: 'shop',
    group: 'Checkout',
    m: 'POST',
    p: '/api/shop/admin/cart/maintenance',
    auth: 'session',
    src: 'server/shop/cart/routes/checkout.ts:190',
    sum: 'Run maintenance by hand.',
    desc: 'The same work as the cron route, for a human with a writer session. <strong>The two credentials are not interchangeable</strong> — a session will not authenticate the GET, and the cron secret will not authenticate this.',
    body: `{ "limit": 200 }     // optional, 1..1000`,
    res: { 200: 'The same maintenance summary as the cron route.' },
    errs: [[400, 'bad_request', ''], [401, 'unauthenticated', ''], [403, 'forbidden', '']],
  },

  /* ── SHOP — Customer ────────────────────────────────────────────────── */
  {
    surface: 'shop',
    group: 'Customer identity',
    m: 'GET',
    p: '/api/shop/customer/me',
    auth: 'public',
    src: 'server/shop/cart/routes/customer.ts:58',
    sum: 'The signed-in customer, if any.',
    desc: 'Never 401s. A signed-out visitor gets <code>{"customer": null}</code>, which is a normal state for a storefront rather than an error.',
    res: { 200: `{ "customer": { "id": "…", "email": "…" | null, "displayName": "…" | null, "createdAt": 0 } | null }` },
    errs: [],
  },
  {
    surface: 'shop',
    group: 'Customer identity',
    m: 'POST',
    p: '/api/shop/customer/session',
    auth: 'public',
    src: 'server/shop/cart/routes/customer.ts:73',
    sum: 'Request a magic sign-in link.',
    desc:
      '<strong>Always 202, whether or not that address has an account.</strong> The email format is deliberately not validated and the answer never varies — this endpoint cannot be used to enumerate customers.<br><br><strong>Not wired in the default deployment:</strong> with no mail delivery configured it answers <code>501 not_implemented</code>, checked before any row is created.',
    body: `{ "email": "customer@example.com" }   // 1..320, normalised to lowercase`,
    res: { 202: `{ "sent": true }` },
    rl: 'Two buckets: <code>shop-magic:&lt;ip&gt;</code> at 20 / 15 min, then <code>shop-magic:&lt;ip&gt;|&lt;email&gt;</code> at 5 / 15 min.',
    errs: [
      [400, 'bad_request', ''],
      [403, 'forbidden', ''],
      [429, 'rate_limited', ''],
      [501, 'not_implemented', '<code>{ error, feature: "magic-link delivery" }</code>'],
    ],
  },
  {
    surface: 'shop',
    group: 'Customer identity',
    m: 'POST',
    p: '/api/shop/customer/session/redeem',
    auth: 'public',
    src: 'server/shop/cart/routes/customer.ts:105',
    sum: 'Exchange a magic token for a customer session.',
    desc: 'A bad or expired token is a <strong>400</strong>, not a 401 — the caller has no session to be unauthenticated with, and the fix is a new link rather than credentials.',
    body: `{ "token": "…" }     // 1..512`,
    res: { 200: `{ "customer": { "id": "…", "email": "…", "displayName": "…", "createdAt": 0 } }` },
    sets: ['<code>__Host-shop_session</code>'],
    rl: '<code>shop-redeem:&lt;ip&gt;</code> at 20 / 15 min.',
    errs: [[400, 'bad_request', '<code>detail: "token"</code> — unknown or expired'], [403, 'forbidden', ''], [429, 'rate_limited', '']],
  },
  {
    surface: 'shop',
    group: 'Customer identity',
    m: 'POST',
    p: '/api/shop/customer/logout',
    auth: 'public',
    src: 'server/shop/cart/routes/customer.ts:136',
    sum: 'Sign the customer out.',
    body: null,
    desc: 'Clears <code>__Host-shop_session</code> only. The cart cookie and any writer session are left alone — signing out of the storefront must not empty the basket or log an admin out of the studio.',
    res: { 200: `{ "ok": true }` },
    errs: [[403, 'forbidden', '']],
  },

  /* ── SHOP — Orders ──────────────────────────────────────────────────── */
  {
    surface: 'shop',
    group: 'Orders (customer)',
    m: 'GET',
    p: '/api/shop/orders',
    auth: 'customer',
    src: 'server/shop/orders/routes.ts:171',
    sum: 'The signed-in customer\'s orders.',
    query: [['cursor', ''], ['limit', 'Integer 1–100, default 24.']],
    desc: 'Customer-scoped in SQL, not in application code. The customer projection strips <code>checkoutId</code> and <code>paymentIntentId</code>.',
    res: {
      200: `{
  "items": [ { "order": { "id": "…", "orderNumber": "…",
                          "email": "…", "currency": "GBP",
                          "subtotal": 3998, "shippingTotal": 395,
                          "taxTotal": 879, "grandTotal": 5272,
                          "refundedTotal": 0,
                          "status": "pending"|"paid"|"fulfilled"|
                                    "cancelled"|"refunded"|"partially_refunded",
                          "shippingAddress": { … }, "billingAddress": { … },
                          "placedAt": 0, "paidAt": 0 | null,
                          "fulfilledAt": 0 | null, "cancelledAt": 0 | null,
                          "revision": 2 },
               "lines": [ { "id": "…", "lineNo": 1, "variantId": "…",
                            "sku": "…", "title": "…",
                            "optionValues": { … }, "qty": 2,
                            "unitAmount": 1999, "lineTotal": 3998,
                            "fulfilledQty": 0 } ] } ],
  "nextCursor": "…" | null
}`,
    },
    errs: [[400, 'bad_request', ''], [401, 'unauthenticated', 'No customer session']],
  },
  {
    surface: 'shop',
    group: 'Orders (customer)',
    m: 'GET',
    p: '/api/shop/orders/:orderNumber',
    auth: 'guest',
    src: 'server/shop/orders/routes.ts:182',
    sum: 'One order — by customer session, or by guest token.',
    params: [['orderNumber', 'The order number. Carries a check character, validated before any lookup.']],
    query: [['token', 'A signed guest token, from the order confirmation email. Up to 4000 chars.']],
    desc:
      'Two ways in: a customer session (scoped in SQL by customer id), or a signed guest token so someone who checked out without an account can still track their order.<br><br><strong>The order number is taken from the verified token, not from the URL</strong>, and the two must match — so a valid token for one order cannot be pointed at another.<br><br>Absent, not yours, bad token and expired token are all a single 404. There is no way to probe which.',
    res: { 200: `{ "order": { … customer projection … }, "lines": [ { … } ] }` },
    errs: [
      [400, 'bad_request', '<code>detail: "orderNumber"</code> — failed the check character'],
      [404, 'gone', 'Absent, not yours, bad token, or expired token — indistinguishable'],
    ],
  },
  {
    surface: 'shop',
    group: 'Orders (customer)',
    m: 'GET',
    p: '/api/shop/orders/:orderNumber/events',
    auth: 'guest',
    src: 'server/shop/orders/routes.ts:187',
    sum: 'The order\'s timeline.',
    params: [['orderNumber', 'Order number.']],
    query: [['token', 'Guest token, as above.']],
    desc: 'The customer-safe history — placed, paid, shipped, delivered. Same auth rules as the order itself.',
    res: { 200: `{ "events": [ { "id": "…", "type": "…", "message": "…", "occurredAt": 0, "actorId": "…" | null } ] }` },
    errs: [[400, 'bad_request', ''], [404, 'gone', '']],
  },
  {
    surface: 'shop',
    group: 'Orders (admin)',
    m: 'GET',
    p: '/api/shop/admin/orders',
    auth: 'session',
    src: 'server/shop/orders/routes.ts:250',
    sum: 'All orders.',
    query: [
      ['status', '<code>pending</code> | <code>paid</code> | <code>fulfilled</code> | <code>cancelled</code> | <code>refunded</code> | <code>partially_refunded</code>'],
      ['cursor', ''],
      ['limit', 'Integer 1–100, default 24.'],
    ],
    desc: 'The full order rows, including <code>checkoutId</code> and <code>paymentIntentId</code> that the customer view strips.',
    res: { 200: `{ "items": [ { "order": { … full row … }, "lines": [ … ] } ], "nextCursor": "…" | null }` },
    errs: [[400, 'bad_request', ''], [401, 'unauthenticated', '']],
  },
  {
    surface: 'shop',
    group: 'Orders (admin)',
    m: 'GET',
    p: '/api/shop/admin/orders/:id',
    auth: 'session',
    src: 'server/shop/orders/routes.ts:255',
    sum: 'Everything about one order.',
    params: [['id', 'Order id (not the order number).']],
    desc: 'One request for the whole support view: lines, fulfilments, timeline, the emails that were queued or sent, and the live payment status pulled through the payment port.',
    res: {
      200: `{
  "order": { … full row … },
  "lines": [ … ],
  "fulfillments": [ { "id": "…", "orderId": "…",
                      "status": "pending"|"shipped"|"delivered"|"cancelled",
                      "carrier": "…" | null, "trackingNumber": "…" | null,
                      "shippedAt": 0 | null, "deliveredAt": 0 | null,
                      "createdAt": 0, "revision": 1,
                      "lines": [ { "id": "…", "orderLineId": "…", "qty": 1 } ] } ],
  "timeline": [ { … } ],
  "emails":   [ { "id": "…", "kind": "…", "to": "…", "subject": "…",
                  "createdAt": 0, "sentAt": 0 | null,
                  "attempts": 1, "lastError": "…" | null } ],
  "payment":  { … } | null
}`,
    },
    errs: [[400, 'bad_request', ''], [401, 'unauthenticated', ''], [404, 'gone', '']],
  },
  {
    surface: 'shop',
    group: 'Orders (admin)',
    m: 'POST',
    p: '/api/shop/admin/orders/:id/fulfillments',
    auth: 'session',
    src: 'server/shop/orders/routes.ts:280',
    sum: 'Create a fulfilment (a shipment).',
    params: [['id', 'Order id.']],
    desc: 'Partial fulfilment is normal: name the lines and quantities going in this box. An order can carry several fulfilments.',
    body: `{
  "lines": [ { "orderLineId": "…", "qty": 1 } ],   // 1..1000 entries
  "carrier": "Royal Mail" | null,
  "trackingNumber": "…" | null
}`,
    res: { 201: `{ "fulfillment": { … } }` },
    errs: [[400, 'bad_request', ''], [401, 'unauthenticated', ''], [404, 'gone', ''], [409, 'precondition_failed', '']],
  },
  {
    surface: 'shop',
    group: 'Orders (admin)',
    m: 'PATCH',
    p: '/api/shop/admin/fulfillments/:id',
    auth: 'session',
    src: 'server/shop/orders/routes.ts:308',
    sum: 'Advance a fulfilment.',
    params: [['id', 'Fulfilment id.']],
    desc:
      '<code>pending</code> is not accepted — a fulfilment starts there and only moves forward.<br><br>Marking one <code>shipped</code> may send the customer a shipment email, and returns <code>order</code> as well: non-null once <em>every</em> line is fulfilled and the order itself has moved on, null while the order is still partially shipped. The tracking link in that email is built from the configured origin allow-list, never the request\'s <code>Host</code>.',
    body: `{ "status": "shipped" | "delivered" | "cancelled" }`,
    res: { 200: `{ "fulfillment": { … }, "order": { … } | null }    // "order" only on "shipped"` },
    errs: [[400, 'bad_request', ''], [401, 'unauthenticated', ''], [404, 'gone', ''], [409, 'precondition_failed', '']],
  },
  {
    surface: 'shop',
    group: 'Orders (admin)',
    m: 'POST',
    p: '/api/shop/admin/orders/:id/cancel',
    auth: 'owner',
    src: 'server/shop/orders/routes.ts:384',
    sum: 'Cancel an order.',
    params: [['id', 'Order id.']],
    body: null,
    desc: 'Owner only. Refunding money is a separate, explicit action — see the payments refund route.',
    res: { 200: `{ "order": { …, "status": "cancelled", "cancelledAt": 0 } }` },
    errs: [[401, 'unauthenticated', ''], [403, 'forbidden', ''], [404, 'gone', ''], [409, 'precondition_failed', '']],
  },
  {
    surface: 'shop',
    group: 'Orders (admin)',
    m: 'POST',
    p: '/api/shop/admin/sweep',
    auth: 'owner',
    src: 'server/shop/orders/routes.ts:364',
    sum: 'Drain queued order events and send pending emails.',
    body: null,
    desc:
      'Owner only. Events are drained first, then the emails they produced are sent, so one call settles the whole backlog in the right order.<br><br><strong>Nothing schedules this today</strong> — it is a manual route. Order emails do not go out until someone (or something) calls it.',
    res: {
      200: `{
  "events": { "applied": 3, "ignored": 0, "parked": 0,
              "dispositions": [ { "eventId": "…", "type": "…", "disposition": "…" } ] },
  "emails": { "sent": 2, "failed": 0, "skipped": 1 }
}`,
    },
    errs: [[400, 'bad_request', ''], [401, 'unauthenticated', ''], [403, 'forbidden', '']],
  },

  /* ── SHOP — Payments ────────────────────────────────────────────────── */
  {
    surface: 'shop',
    group: 'Payments',
    m: 'POST',
    p: '/api/shop/payments/webhook',
    auth: 'webhook',
    src: 'server/shop/payments/routes.ts:164',
    sum: 'Paystack webhook receiver.',
    desc:
      '<strong>Its entire authority is an HMAC-SHA512 over the raw request bytes.</strong> It reads no cookie and resolves no session, which is why it is exempt from the <code>Origin</code> guard that every other unsafe method obeys — a server-to-server POST has no <code>Origin</code>, and CSRF has nothing to borrow from a route that trusts no ambient credential.<br><br>Bodies are capped at 1 MiB, measured on actual bytes. A forged body is never a 200 and never a 500.<br><br>Repeat deliveries are safe: the event is recorded before the response is acknowledged, and a duplicate answers 200 with <code>duplicate: true</code>.',
    body: `The provider's raw event payload, read as bytes and never re-serialised.`,
    headers: ['The provider signature header, verified against the raw body.'],
    res: { 200: `{ "received": true, "duplicate": false }` },
    errs: [
      [400, 'bad_request', 'Unparseable payload'],
      [401, 'invalid_signature', 'Signature verification failed'],
      [413, 'payload_too_large', 'Over 1 MiB'],
    ],
  },
  {
    surface: 'shop',
    group: 'Payments',
    m: 'POST',
    p: '/api/shop/payments/intents',
    auth: 'public',
    src: 'server/shop/payments/routes.ts:236',
    sum: 'Create a payment intent for a frozen checkout.',
    desc:
      '<strong>There is no <code>amount</code> field, on purpose.</strong> The amount is read from the frozen checkout totals server-side, so a client cannot choose what it pays.<br><br><code>idempotencyKey</code> is required: replaying the same key returns the same intent with a 200 instead of creating a second one, so a retried request after a dropped connection cannot double-charge.<br><br>Follow <code>authorizationUrl</code> to the provider\'s hosted payment page.',
    body: `{
  "checkoutId": "…",        // 1..200; must be frozen
  "email": "…",             // 3..320
  "idempotencyKey": "…"     // 8..200; your own key, stable across retries
}`,
    res: {
      201: `{ "id": "…", "checkoutId": "…",
  "status": "requires_payment",
  "amount": 5272, "currency": "GBP",
  "authorizationUrl": "https://checkout.paystack.com/…" | null,
  "refundedTotal": 0 }`,
      200: 'Identical body — an idempotent replay of a key that already created an intent.',
    },
    errs: [
      [400, 'bad_request', ''],
      [403, 'forbidden', 'Missing <code>Origin</code>'],
      [404, 'gone', 'Unknown checkout, or it is not frozen'],
    ],
  },
  {
    surface: 'shop',
    group: 'Payments',
    m: 'GET',
    p: '/api/shop/payments/intents/:id',
    auth: 'public',
    src: 'server/shop/payments/routes.ts:254',
    sum: 'Read an intent\'s public state.',
    params: [['id', 'Payment intent id.']],
    desc: 'The public projection omits <code>idempotencyKey</code> and <code>lastError</code>.',
    res: { 200: `{ "id": "…", "checkoutId": "…", "status": "…", "amount": 5272, "currency": "GBP", "authorizationUrl": "…" | null, "refundedTotal": 0 }` },
    errs: [[400, 'bad_request', ''], [404, 'gone', '']],
  },
  {
    surface: 'shop',
    group: 'Payments',
    m: 'POST',
    p: '/api/shop/payments/intents/:id/confirm',
    auth: 'public',
    src: 'server/shop/payments/routes.ts:273',
    sum: 'Ask the provider what really happened.',
    params: [['id', 'Payment intent id.']],
    body: null,
    desc:
      '<strong>Call this when the customer lands back on your return URL.</strong> It reads no body and believes nothing the client says — it asks the provider directly and applies the answer through the same code path the webhook uses, so a customer who returns before the webhook arrives still sees a settled order.<br><br>Safe to call repeatedly. If the provider still says <code>requires_payment</code>, the intent comes back unchanged.',
    res: { 200: `{ … the public intent, at its current state … }` },
    errs: [[400, 'bad_request', ''], [403, 'forbidden', ''], [404, 'gone', 'Unknown intent, or it never reached the provider']],
  },
  {
    surface: 'shop',
    group: 'Payments (admin)',
    m: 'GET',
    p: '/api/shop/admin/payments/intents/:id',
    auth: 'owner',
    src: 'server/shop/payments/routes.ts:320',
    sum: 'The full intent, with its refunds.',
    params: [['id', 'Payment intent id.']],
    desc: 'Owner only. Adds the fields the public projection hides — provider id, idempotency key, last error, revision.',
    res: {
      200: `{ "intent": { …, "providerIntentId": "…", "idempotencyKey": "…",
               "lastError": "…" | null, "createdAt": 0, "updatedAt": 0,
               "revision": 2 },
  "refunds": [ { "id": "…", "intentId": "…", "amount": 500,
                 "currency": "GBP", "reason": "…" | null,
                 "providerRefundId": "…" | null, "idempotencyKey": "…",
                 "status": "pending"|"succeeded"|"failed",
                 "createdAt": 0, "updatedAt": 0, "createdBy": "…" } ] }`,
    },
    errs: [[400, 'bad_request', ''], [401, 'unauthenticated', ''], [403, 'forbidden', ''], [404, 'gone', '']],
  },
  {
    surface: 'shop',
    group: 'Payments (admin)',
    m: 'POST',
    p: '/api/shop/admin/payments/intents/:id/refunds',
    auth: 'owner',
    src: 'server/shop/payments/routes.ts:334',
    sum: 'Refund, in full or in part.',
    params: [['id', 'Payment intent id.']],
    desc:
      'Owner only. <code>amount</code> is in minor units; partial refunds are allowed and the running sum is checked against what was captured, so you cannot refund more than you took.<br><br><code>idempotencyKey</code> is required — a replay returns the existing refund with a 200 rather than issuing a second one.',
    body: `{
  "amount": 500,            // integer minor units, > 0
  "reason": "…",            // optional, <= 500 chars
  "idempotencyKey": "…"     // 8..200, required
}`,
    res: { 201: `{ "refund": { … } }`, 200: 'Identical body — an idempotent replay.' },
    errs: [[400, 'bad_request', ''], [401, 'unauthenticated', ''], [403, 'forbidden', ''], [404, 'gone', ''], [409, 'precondition_failed', 'Would exceed the captured amount']],
  },
  {
    surface: 'shop',
    group: 'Payments (admin)',
    m: 'POST',
    p: '/api/shop/admin/payments/intents/:id/cancel',
    auth: 'owner',
    src: 'server/shop/payments/routes.ts:347',
    sum: 'Cancel an unpaid intent.',
    params: [['id', 'Payment intent id.']],
    body: null,
    res: { 200: `{ … the public intent, now cancelled … }` },
    errs: [[401, 'unauthenticated', ''], [403, 'forbidden', ''], [404, 'gone', ''], [409, 'precondition_failed', 'Already captured']],
  },
  {
    surface: 'shop',
    group: 'Payments (admin)',
    m: 'POST',
    p: '/api/shop/admin/payments/events/drain',
    auth: 'owner',
    src: 'server/shop/payments/routes.ts:357',
    sum: 'Process queued payment events.',
    body: null,
    desc: 'Owner only. Processes a batch of 50. Webhook events are normally drained automatically after each delivery; this is the manual handle for a backlog.',
    res: { 200: `{ "processed": 12 }` },
    errs: [[401, 'unauthenticated', ''], [403, 'forbidden', '']],
  },

  /* ══════════════════════════════════════════════════════════════════════
     PUBLIC — Reading
     ══════════════════════════════════════════════════════════════════════ */
  {
    surface: 'public',
    group: 'Reading',
    m: 'GET',
    p: '/api/public/posts',
    auth: 'public',
    src: 'server/routes/public.ts:529',
    sum: 'List published posts, with keyset pagination.',
    desc:
      'Published posts only, and the filter is not something you can name: there is no <code>status</code> query key and no way to spell one — <code>?status=draft</code> is a <strong>400 naming the unknown key</strong>, not a silently ignored field. Visibility is decided by one SQL predicate (see the guide), never by the request.<br><br>Items are the <strong>public projection</strong>: <code>authorId</code>, <code>deletedAt</code>, <code>revision</code>, <code>status</code>, <code>excerptSource</code> and <code>createdAt</code> are absent, and <code>authorName</code> is reshaped into <code>author: { name }</code>. <code>content</code> is absent from the list — read the detail route for the document.<br><br><code>search</code> is full-text (<code>websearch_to_tsquery(\'english\', …)</code>), not substring, so <code>ost</code> does not match <code>post</code>. <strong>A request carrying a non-empty <code>search</code> is rate limited and cached for only 10 seconds</strong>; every other list request carries no limiter at all.',
    query: [
      ['sort', '<code>published</code> (default, newest published first) | <code>oldest</code> | <code>alphabetical</code>. Nothing else — <code>updated</code> and <code>drafts-first</code> are <strong>not offered</strong>, the first because it would expose editing activity on published posts. <code>oldest</code> means <strong>oldest published</strong> (<code>published_at ASC</code>), not oldest created.'],
      ['search', 'Full-text query. Non-empty ⇒ rate limited and short-cached.'],
      ['category', 'Exact match.'],
      ['tag', 'Posts carrying this tag.'],
      ['cursor', 'Opaque, from the previous page\'s <code>nextCursor</code>. Bound to the sort that minted it.'],
      ['limit', 'Integer 1–100, default 24. Out of range is <strong>rejected, not clamped</strong>.'],
    ],
    res: {
      200: `{
  "items": [ { "id": "…", "slug": "…", "title": "…", "subtitle": "…",
               "excerpt": "…",
               "coverImage": { "url": "/api/public/images/img_x",
                               "alt": "…", "focalPoint": "50% 50%",
                               "width": 1200, "height": 630 } | null,
               "category": "…", "tags": ["…"],
               "template": "magazine"|"minimal"|"editorial"|"technical"|null,
               "publishedAt": 0,          // never null on this surface
               "updatedAt": 0,
               "wordCount": 0, "readingTime": 0,
               "author": { "name": "Ada L." } } ],
  "nextCursor": "…" | null
}`,
      304: 'No body. Sent when <code>If-None-Match</code> matches, or (absent that) <code>If-Modified-Since</code> is at or after <code>Last-Modified</code>.',
    },
    rl: 'Only when <code>search</code> is non-empty: <code>public:&lt;ip&gt;</code> at <strong>300 / minute</strong>, shared with the image route, and charged <strong>before</strong> the query runs. Plain list requests are unlimited and protected by the edge cache instead.',
    errs: [
      [400, 'bad_request', '<code>detail</code>: <code>limit</code> (out of range or non-numeric), <code>cursor</code> (undecodable, or minted under a different sort), <code>sort</code> (a value this surface does not offer), <code>search</code>/<code>category</code>/<code>tag</code> (NUL byte), or <strong>any unknown query key — including <code>status</code></strong>'],
      [429, 'rate_limited', 'Search bucket exhausted; carries <code>Retry-After</code>'],
    ],
    notes: [
      'Caching: <code>Cache-Control: public, s-maxage=60, stale-while-revalidate=300</code> — but <code>public, s-maxage=10</code> when <code>search</code> is present, because a full-text query is unbounded in cardinality and would otherwise fill the edge with one entry per phrase anyone ever typed.',
      '<code>ETag</code> on every response; <code>Last-Modified</code> is the newest <code>updatedAt</code> in the page and is <strong>omitted entirely for an empty result set</strong> rather than invented.',
    ],
  },
  {
    surface: 'public',
    group: 'Reading',
    m: 'GET',
    p: '/api/public/posts/:slug',
    auth: 'public',
    src: 'server/routes/public.ts:542',
    sum: 'One published post by slug, including its document body.',
    params: [['slug', 'The post\'s slug. A NUL byte is a 400, not a 404.']],
    desc:
      'The list shape plus <code>content</code>, and nothing else. <strong>An unpublished slug and an absent slug are the same 404, from the same code path</strong> — a draft, an archived post, a trashed post and a slug that never existed are byte-for-byte one response, so unpublished slugs cannot be enumerated.<br><br><code>content</code> is the stored TipTap/ProseMirror document, <strong>unrewritten</strong>: inline images still carry <code>asset:&lt;id&gt;</code> sources. Resolve them yourself as <code>/api/public/images/&lt;id&gt;</code> — the cover image, by contrast, arrives already resolved to that URL.',
    res: {
      200: `{ "post": { … every list field …,
             "content": { "type": "doc", "content": [ … ] } } }`,
      304: 'No body — conditional request satisfied.',
    },
    errs: [
      [400, 'bad_request', '<code>detail: "slug"</code> — a NUL byte in the path segment'],
      [404, 'gone', 'Absent <em>or</em> not published. Deliberately indistinguishable, and it carries <code>Cache-Control: public, s-maxage=30</code> — a positive TTL on the 404, because this route has no rate limiter and unknown-slug probing would otherwise reach Postgres every time'],
    ],
    notes: [
      'Caching: <code>Cache-Control: public, s-maxage=300, stale-while-revalidate=3600</code>, plus <code>ETag</code> and a <code>Last-Modified</code> of the post\'s <code>updatedAt</code>.',
      'No rate limiter.',
    ],
  },

  /* ── PUBLIC — Media ─────────────────────────────────────────────────── */
  {
    surface: 'public',
    group: 'Media',
    m: 'GET',
    p: '/api/public/images/:id',
    auth: 'public',
    src: 'server/routes/public.ts:555',
    sum: 'Redirect to a short-lived presigned URL for a publicly referenced image.',
    params: [['id', 'Image id. An <code>asset:</code> or <code>idb:</code> prefix is stripped before lookup.']],
    desc:
      'Answers <strong>302</strong> with a <code>Location</code> pointing at a presigned R2 URL that is valid for <strong>five minutes</strong>. It never proxies the bytes.<br><br><strong>Only images referenced by the CURRENT content or cover of a currently published post are served.</strong> Not a revision — an image cut from a published post stops being public the moment the cut is saved. Not a draft, archived or trashed post. Not an uncommitted upload slot. Unknown, uncommitted and not-publicly-referenced are one <code>404</code> from one SQL statement, so the three cannot be told apart.<br><br>This is the deliberate mirror image of the orphan collector, which counts revisions and drafts so it never deletes a byte somebody needs. This check fails the other way: it would rather refuse a byte somebody wanted than publish a private one.',
    res: {
      302: 'No body. The <code>Location</code> header carries a presigned URL, valid for five minutes.',
    },
    rl: '<code>public:&lt;ip&gt;</code> at <strong>300 / minute</strong> — the same single bucket the search list uses — charged on <strong>every</strong> request to this route, before the database is touched.',
    errs: [
      [400, 'bad_request', '<code>detail: "id"</code> (NUL byte in the path), or <code>detail: "storage"</code> when the deployment has no R2 configured — a <strong>4xx on purpose</strong>, because a missing bucket does not change during 30 seconds of a client\'s 5xx backoff'],
      [404, 'gone', 'Unknown id, uncommitted upload, or not referenced by any currently published post'],
      [429, 'rate_limited', 'Carries <code>Retry-After</code>'],
    ],
    notes: [
      'Caching: <code>Cache-Control: private, no-store</code>. The redirect embeds a five-minute credential, so a cached copy of it would outlive its own signature. The object <em>behind</em> the redirect is cached by R2\'s own headers.',
      'No <code>ETag</code>, no <code>Last-Modified</code> and no conditional handling on this route — it is a redirect, not a body.',
    ],
  },

  /* ── PUBLIC — Feeds ─────────────────────────────────────────────────── */
  {
    surface: 'public',
    group: 'Feeds',
    m: 'GET',
    p: '/api/public/feed.xml',
    auth: 'public',
    src: 'server/routes/public.ts:603',
    sum: 'RSS 2.0 of the 20 most recently published posts.',
    body: null,
    desc:
      'Content type <code>application/rss+xml; charset=UTF-8</code>. Newest published first, capped at <strong>20</strong> items. Each <code>&lt;item&gt;</code> carries <code>title</code>, <code>link</code>, <code>guid isPermaLink="true"</code>, <code>pubDate</code>, <code>description</code> (the excerpt), <code>dc:creator</code> (the byline only — never an id, never an email) and one <code>&lt;category&gt;</code> per tag.<br><br>Links are absolute, built from the <strong>first configured <code>APP_ORIGINS</code> entry</strong> as <code>&lt;origin&gt;/posts/&lt;slug&gt;</code> — never from the request\'s <code>Host</code> header.<br><br>Every text value is stripped of characters XML 1.0 forbids (control characters other than tab/LF/CR, lone surrogates, U+FFFE/U+FFFF) and then escaped for all five predefined entities. Stripped rather than escaped because <code>&amp;#11;</code> is exactly as illegal as a raw U+000B, and one of them anywhere would make every post vanish from every reader.',
    res: {
      200: `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>https://example.com</title>
    <link>https://example.com</link>
    <description>Published posts</description>
    <item>
      <title>…</title>
      <link>https://example.com/posts/a-slug</link>
      <guid isPermaLink="true">https://example.com/posts/a-slug</guid>
      <pubDate>Tue, 12 Aug 2026 09:00:00 GMT</pubDate>
      <description>…</description>
      <dc:creator>Ada L.</dc:creator>
      <category>tag</category>
    </item>
  </channel>
</rss>`,
      304: 'No body — conditional request satisfied.',
    },
    errs: [
      [400, 'bad_request', '<code>detail: "origins"</code> — no <code>APP_ORIGINS</code> configured. A 4xx rather than a 500 or a feed full of relative links, which would be silently useless in every reader'],
    ],
    notes: [
      'Caching: <code>Cache-Control: public, s-maxage=600</code>, plus <code>ETag</code> and a <code>Last-Modified</code> of the newest <code>updatedAt</code> in the feed.',
      'No rate limiter.',
    ],
  },
  {
    surface: 'public',
    group: 'Feeds',
    m: 'GET',
    p: '/api/public/sitemap.xml',
    auth: 'public',
    src: 'server/routes/public.ts:611',
    sum: 'sitemaps.org 0.9 urlset of every published post.',
    body: null,
    desc:
      'Content type <code>application/xml; charset=UTF-8</code>. One <code>&lt;url&gt;</code> per published post — <code>&lt;loc&gt;</code> built from the first <code>APP_ORIGINS</code> entry, <code>&lt;lastmod&gt;</code> the post\'s <code>updatedAt</code> as an ISO 8601 instant. Newest published first.<br><br>No byline: the query does not even join the users table, because the narrowest query that answers the question is the one that cannot leak the answer to another.<br><br><strong>The 50 000-URL cap is said out loud.</strong> At the ceiling the document carries an XML comment saying a sitemap index is required beyond this point, rather than silently truncating and dropping published posts out of every search index with nothing to notice.',
    res: {
      200: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/posts/a-slug</loc>
    <lastmod>2026-08-12T09:00:00.000Z</lastmod>
  </url>
</urlset>`,
      304: 'No body — conditional request satisfied.',
    },
    errs: [
      [400, 'bad_request', '<code>detail: "origins"</code> — no <code>APP_ORIGINS</code> configured'],
    ],
    notes: [
      'Caching: <code>Cache-Control: public, s-maxage=600</code>, with <code>ETag</code> and <code>Last-Modified</code>.',
      'No rate limiter.',
    ],
  },

  /* ── PUBLIC — Taxonomy ──────────────────────────────────────────────── */
  {
    surface: 'public',
    group: 'Taxonomy',
    m: 'GET',
    p: '/api/public/categories',
    auth: 'public',
    src: 'server/routes/public.ts:593',
    sum: 'Categories of published posts, with counts.',
    desc:
      '<strong>Of published posts</strong> — the emphasis is the whole point. An unbounded <code>DISTINCT category</code> would publish the working vocabulary of every draft in the system, with counts, which is a pre-announcement signal. This runs behind the same predicate as everything else on the surface.<br><br>Ordered by count descending, then name ascending. The empty string is excluded: it means "uncategorised", not a category named <code>""</code>.',
    res: {
      200: `{ "items": [ { "name": "Engineering", "count": 12 } ] }`,
      304: 'No body — conditional request satisfied.',
    },
    errs: [],
    notes: [
      'Caching: <code>Cache-Control: public, s-maxage=60, stale-while-revalidate=300</code> with an <code>ETag</code>, but <strong>no <code>Last-Modified</code></strong> — the query is a <code>GROUP BY</code> aggregate and selects no timestamp, so there is no newest row to name and inventing one would be a date a cache acts on.',
      'No rate limiter.',
    ],
  },
  {
    surface: 'public',
    group: 'Taxonomy',
    m: 'GET',
    p: '/api/public/tags',
    auth: 'public',
    src: 'server/routes/public.ts:598',
    sum: 'Tags of published posts, with counts.',
    desc:
      'Same predicate and same reasoning as the categories route: draft and trashed vocabulary never appears. Ordered by count descending, then tag ascending; the empty tag is excluded.',
    res: {
      200: `{ "items": [ { "name": "typescript", "count": 7 } ] }`,
      304: 'No body — conditional request satisfied.',
    },
    errs: [],
    notes: [
      'Caching: <code>public, s-maxage=60, stale-while-revalidate=300</code>, <code>ETag</code> only — no <code>Last-Modified</code>, for the same reason as categories.',
      'No rate limiter.',
    ],
  },
];

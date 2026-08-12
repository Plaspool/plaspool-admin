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
      'Every route is mounted under <code>/api</code>. Nothing here is reachable without a session except <code>GET /api/health</code>, the five unauthenticated auth routes (<code>login</code>, <code>logout</code>, <code>accept-invite</code>, <code>forgot</code>, <code>reset</code>), and the separate <strong>Public API</strong> surface under <code>/api/public/*</code>. <strong>27 of these routes are owner-only</strong>, not merely authenticated — every one of the seventeen under <code>/api/admin/email/*</code>, the whole <strong>Team</strong> group, invites, export, <code>DELETE /api/categories/:id</code> and the two destructive post routes.',
  },
  {
    id: 'public',
    name: 'Public API',
    tagline: 'Anonymous reading: published posts, images, feed, sitemap, taxonomy.',
    blurb:
      '<strong>No credential at all.</strong> This is the only surface that needs no cookie, no token and no header — anyone on the internet may call every route here. The reading routes expose <strong>published posts only</strong>: a post that is a draft, archived, trashed, slug-less or published-without-a-date is not merely hidden from the list, it is unreachable by any route on this surface. Those responses are cacheable, cross-origin readable from any origin, and carry <code>ETag</code>/<code>Last-Modified</code> so revalidation is cheap.<br><br><strong>One pair of routes here is not a cacheable read.</strong> <code>/api/public/unsubscribe</code> is a <code>GET</code> and a <code>POST</code> that answer <em>HTML</em>, carry <code>no-store</code>, and — on the <code>POST</code> — write. They share this path prefix because that is where "no credential of ours" lives on the wire; they do not share the router, and the Unsubscribe section below says why.',
    baseNote:
      'The reading routes are mounted under <code>/api/public</code> in one router, <strong>above the session middleware</strong> — a handler there structurally cannot read a cookie, so a <code>Cache-Control: public</code> response is incapable of varying by reader. The response body is a deliberately narrow projection, not the admin <code>Post</code> with fields blanked out. The unsubscribe pair is a <em>separate</em> router mounted at the same prefix, deliberately kept out of the cacheable one.',
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
    src: 'server/index.ts:157',
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
    src: 'server/routes/auth.ts:233',
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
    src: 'server/routes/auth.ts:310',
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
    src: 'server/routes/auth.ts:319',
    sum: 'The account behind the current cookie.',
    desc: 'The cheapest way for a client to decide, at boot, whether it holds a live session.',
    res: { 200: `{ "user": { "id": "…", "email": "…", "displayName": "…", "role": "owner" | "writer" } }` },
    errs: [[401, 'unauthenticated', 'No session cookie, or the session has expired']],
  },
  {
    surface: 'blog',
    group: 'Auth & invites',
    m: 'PATCH',
    p: '/api/auth/me',
    auth: 'session',
    src: 'server/routes/auth.ts:339',
    sum: 'Change your own display name.',
    desc:
      'The first UPDATE of <code>users.display_name</code> the app has ever had — and it needs no backfill, because <code>posts.author_name</code> is not a column. Every route that returns an <code>authorName</code> derives it from a live <code>JOIN users ON users.id = posts.author_id</code>, so a rename is visible on existing posts, the revision log, the export bundle and the public feed the moment this returns.<br><br>The field is optional: <code>{}</code> is a no-op that returns the caller unchanged. The name is trimmed, must be non-blank <em>after</em> trimming (three spaces is a 400, not a stored name), and is capped at 200 — the same ceiling <code>POST /api/auth/accept-invite</code> applies, so a name cannot be created at one length and edited to another. There is no <code>role</code> and no <code>email</code> key, so sending either is a 400 rather than a silently ignored field.',
    body: `{
  "displayName": "Ada L."      // optional, 1..200, non-blank after trim
}`,
    res: { 200: `{ "user": { "id": "…", "email": "…", "displayName": "…", "role": "owner" | "writer" } }` },
    errs: [
      [400, 'bad_request', '<code>detail: "displayName"</code> — empty, blank after trim, or over 200 — or an unknown key name such as <code>role</code>'],
      [401, 'unauthenticated', 'No session cookie, or the session has expired'],
    ],
  },
  {
    surface: 'blog',
    group: 'Auth & invites',
    m: 'POST',
    p: '/api/auth/change-password',
    auth: 'session',
    src: 'server/routes/auth.ts:369',
    sum: 'Change your password while signed in, ending every OTHER session.',
    desc:
      'The signed-in counterpart to <code>forgot</code>&nbsp;→&nbsp;<code>reset</code>, and the difference is entirely what it does to sessions. <code>POST /api/auth/reset</code> destroys <em>every</em> session, because a reset is what someone does when they believe an intruder holds one. This route destroys every session <strong>except the caller\'s</strong>: the cookie you sent keeps working and is not reissued, while every other device is signed out immediately. Any unspent password-reset link for the account dies with it.<br><br><strong>A wrong <code>currentPassword</code> is a 400, not a 401.</strong> The session is valid — that is what got you past the guard — so a 401 would name the wrong credential, and the client maps every 401 onto "your session expired" and raises the re-authentication overlay: a typo in one field would look exactly like a dead session mid-edit. <code>detail</code> is <code>currentPassword</code>, and neither password ever appears in a response body.<br><br><code>newPassword</code> is judged by the same <code>assertCredentials</code> that governs account creation, so a value under 10 characters comes back as <code>detail: "password"</code> — the field name that check reports, not the body key.',
    body: `{
  "currentPassword": "…",   // 1..1024
  "newPassword":     "…"    // 1..1024, and at least 10 chars
}`,
    res: { 200: `{ "ok": true, "otherSessionsEnded": 2 }` },
    rl: '<code>chpw:&lt;userId&gt;</code> at 5 / 15 min, checked before the body is parsed. Keyed on the ACCOUNT and not the IP: the threat is somebody at an unlocked laptop guessing the existing password, so moving between networks must not reset the count. A successful change forgets the bucket.',
    errs: [
      [400, 'bad_request', '<code>detail</code>: <code>currentPassword</code> (wrong), <code>password</code> (the new one is under 10 chars), <code>content-type</code>, <code>body</code>, or an unknown key name'],
      [401, 'unauthenticated', 'No session — never "wrong current password"'],
      [429, 'rate_limited', 'Bucket exhausted; carries <code>Retry-After</code>'],
    ],
  },
  {
    surface: 'blog',
    group: 'Auth & invites',
    m: 'POST',
    p: '/api/auth/forgot',
    auth: 'public',
    src: 'server/routes/auth.ts:718',
    sum: 'Mail a password-reset link.',
    desc:
      '<strong>Always 202, for every address.</strong> An unknown email, a real one and a disabled account produce the same status, the same body and the same visible work — a 404 for "no such account" would be a complete user list for an invite-only instance, handed out unauthenticated.<br><br><strong>The mailer check runs <em>before</em> the account lookup, and the order is the whole point.</strong> Placed where it naturally falls — inside the send, i.e. after the lookup — an unconfigured deployment would 501 for a known address and 202 for an unknown one, rebuilding the enumeration oracle out of the failure path and more reliably than any timing channel. Asked first, an unconfigured deployment answers <code>501</code> for everybody alike and a configured one answers <code>202</code> for everybody alike.<br><br>A send that is attempted and <em>fails</em> is swallowed for the caller and logged for the operator, for the same reason: only a real account ever reaches the send, so any error escaping there would confirm the account exists. The link is built from the first configured <code>APP_ORIGINS</code> entry, never from the request\'s <code>Host</code>, and works once within an hour.',
    body: `{
  "email": "writer@example.com"   // 1..320
}`,
    res: { 202: `{ "sent": true }` },
    rl: 'Two buckets, in order: <code>forgot:&lt;ip&gt;</code> at 20 / 15 min before the body is read, then <code>forgot:&lt;ip&gt;|&lt;email&gt;</code> at 5 / 15 min — the narrow one is what stops a single host mail-bombing one inbox, and it cannot move above the parse because the address it keys on is in the body.',
    errs: [
      [400, 'bad_request', '<code>detail</code>: <code>email</code>, <code>content-type</code>, <code>body</code>, or an unknown key name'],
      [429, 'rate_limited', 'Either bucket exhausted; carries <code>Retry-After</code>'],
      [501, 'not_implemented', '<code>{ error, feature }</code> — the deployment has no mailer wired. Answered for <strong>every</strong> address, which is what keeps it from being an oracle'],
    ],
  },
  {
    surface: 'blog',
    group: 'Auth & invites',
    m: 'POST',
    p: '/api/auth/reset',
    auth: 'public',
    src: 'server/routes/auth.ts:839',
    sum: 'Spend a reset link and set a new password.',
    desc:
      '<strong>No cookie is set — resetting does not sign you in.</strong> The sweep inside the claim exists to end every session the account holds, and handing back a fresh one in the same response would make this the only way to turn a token glimpsed in a mailbox into a live session without ever typing the new password.<br><br><strong>Unknown, expired, already-spent and belongs-to-a-disabled-account are one 400 <code>detail: "token"</code></strong>, from one statement: the claim carries <code>used_at IS NULL</code>, <code>expires_at &gt; now</code> and a join to a non-disabled user in its own <code>WHERE</code>, so a second racer updates zero rows rather than winning. A 400 and not a 500 because none of the four can ever become valid, and the client retries a 500 five times.<br><br>The password is judged and hashed <em>before</em> the token is claimed, so a too-short password costs a round trip instead of burning the user\'s only link. The change and the session sweep are a single CTE and cannot half-apply.',
    body: `{
  "token": "…",        // 1..512, from the emailed link
  "password": "…"      // 1..1024, and at least 10 chars
}`,
    res: { 200: `{ "ok": true }` },
    rl: '<code>reset:&lt;ip&gt;</code> at 20 / 15 min. By IP alone: the token names the account, and consulting it to build a limiter key would mean reading the token before the limiter bounds the work.',
    errs: [
      [400, 'bad_request', '<code>detail: "token"</code> (unknown, expired, spent, or the account is disabled — indistinguishable) or <code>detail: "password"</code> (under 10 chars)'],
      [403, 'forbidden', 'Missing or unrecognised <code>Origin</code> header'],
      [429, 'rate_limited', 'Carries <code>Retry-After</code>'],
    ],
  },
  {
    surface: 'blog',
    group: 'Auth & invites',
    m: 'GET',
    p: '/api/auth/sessions',
    auth: 'session',
    src: 'server/routes/auth.ts:441',
    sum: 'Your own live sessions.',
    desc:
      'Reads the <code>sessions.user_agent</code> and <code>sessions.last_seen_at</code> columns, which have been maintained since the table was created for exactly this screen. <code>last_seen_at</code> is written on <em>every</em> resolve rather than only when the 30-day window slides, so "last used" is accurate to the minute rather than to the fortnight.<br><br><strong>Own sessions only, with no owner override.</strong> An owner who needs to end somebody else\'s sessions uses <code>POST /api/users/:id/disable</code>, which revokes the account as well — quietly signing a writer out while leaving them able to sign straight back in would be theatre.<br><br>Expired rows are omitted rather than greyed out: <code>resolveSession</code> deletes one the next time it is presented, so an expired row is a session that has already ended, and offering it for revocation would only produce a 404. <code>id</code> is the row\'s primary key, which is <code>HMAC-SHA-256(token, SESSION_SECRET)</code> — it is the handle <code>DELETE</code> below needs and it is <em>not</em> a credential: nothing anywhere accepts it as an input, and it cannot be turned back into the token it names.',
    res: {
      200: `{ "items": [ { "id": "<64 hex>", "createdAt": 0, "lastSeenAt": 0,
              "expiresAt": 0, "userAgent": "…" | null,
              "current": true } ] }`,
    },
    errs: [[401, 'unauthenticated', '']],
  },
  {
    surface: 'blog',
    group: 'Auth & invites',
    m: 'DELETE',
    p: '/api/auth/sessions/:id',
    auth: 'session',
    src: 'server/routes/auth.ts:464',
    sum: 'Revoke one of your own sessions.',
    params: [['id', 'Session id, from <code>GET /api/auth/sessions</code>. Any string; no format is enforced.']],
    desc:
      'Revoking the CURRENT session is allowed and ends it — a logout that leaves the cookie in the browser, so the next request 401s and the client clears it. Refusing would be a rule to learn for no benefit.<br><br><strong>Somebody else\'s session id and an id that never existed are the same 404.</strong> The DELETE carries <code>user_id</code> in its WHERE clause rather than reading first, so the two cases are the same zero rows — which is also what stops this route answering "does this id belong to somebody" for anyone holding a session. No UUID check, because <code>sessions.id</code> is a <code>text</code> primary key: a malformed value matches nothing rather than raising SQLSTATE 22P02.',
    res: { 200: `{ "ok": true }` },
    errs: [
      [400, 'bad_request', '<code>detail: "id"</code> — a NUL byte in the path segment'],
      [401, 'unauthenticated', ''],
      [404, 'gone', 'No such session for this account — including one that belongs to somebody else'],
    ],
  },
  {
    surface: 'blog',
    group: 'Auth & invites',
    m: 'POST',
    p: '/api/auth/accept-invite',
    auth: 'public',
    src: 'server/routes/auth.ts:474',
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
    src: 'server/routes/auth.ts:667',
    sum: 'Invite a writer, and mail them the link.',
    desc:
      'The response is the only place the raw token ever appears — the database stores an HMAC digest of it. The <code>url</code> is built from the first configured <code>APP_ORIGINS</code> entry, never from the request\'s <code>Host</code> header, so a forged host cannot mint a link pointing somewhere else.<br><br><strong>The link is mailed when the deployment has a mailer, and the URL stays in the response either way.</strong> An invite is the only way a second person ever gets into an invite-only instance, so making it depend on a working mail provider would mean an outage locks the team out of growing. <code>emailed</code> says which happened. A deployment with no <code>RESEND_API_KEY</code> is not an incident and is not logged as one; a send that is attempted and fails is logged for the operator and still answers 201, because the invite row is already committed and failing would only prompt the owner to mint a second live token for the same address.',
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
  },
  "emailed": true
}`,
    },
    errs: [
      [400, 'bad_request', '<code>detail: "email"</code> when the address already has an account'],
      [401, 'unauthenticated', ''],
      [403, 'forbidden', 'Session is a writer, not the owner'],
    ],
    notes: [
      'Unlike <code>POST /api/auth/forgot</code>, this deliberately does <strong>not</strong> 501 when no mailer is configured. Forgot must, for enumeration reasons that do not apply here — an owner already knows whether the address they just typed has an account.',
    ],
  },
  {
    surface: 'blog',
    group: 'Auth & invites',
    m: 'GET',
    p: '/api/invites',
    auth: 'owner',
    src: 'server/routes/auth.ts:537',
    sum: 'Open invites, and optionally the history.',
    desc:
      'Open invites by default, newest first. Tokens are never returned — <code>token_hash</code> is enumerated out of the SELECT rather than dropped by the mapper.<br><br>Accepted and expired rows have always survived in the table but nothing could ask for them, so "did we ever invite this address" was unanswerable through the API. <code>?include=</code> opts each history bucket in; the default stays the short list an owner acts on.<br><br><code>state</code> is derived from the same clock reading the filter used, so a client comparing <code>expiresAt</code> against its own clock cannot disagree with the server about a row a few seconds from expiry. <strong>Accepted beats expired:</strong> a spent invite whose seven days have since elapsed is labelled <code>accepted</code>, because calling it <code>expired</code> would invite an owner to re-send to somebody who already has an account. <code>invitedByName</code> saves a second, owner-only round trip to render one cell; the uuid stays beside it.',
    query: [
      ['include', 'Comma-separated. <code>accepted</code>, <code>expired</code>, or both. An unrecognised member is a 400, not a silently ignored word.'],
    ],
    res: {
      200: `{ "items": [ { "id": "…", "email": "…", "role": "writer",
              "createdAt": 0, "expiresAt": 0, "acceptedAt": 0 | null,
              "invitedBy": "…", "invitedByName": "Ada L.",
              "state": "open" | "accepted" | "expired" } ] }`,
    },
    errs: [
      [400, 'bad_request', '<code>detail: "include"</code> (unknown member) or an unknown query key name'],
      [401, 'unauthenticated', ''],
      [403, 'forbidden', ''],
    ],
  },
  {
    surface: 'blog',
    group: 'Auth & invites',
    m: 'DELETE',
    p: '/api/invites/:id',
    auth: 'owner',
    src: 'server/routes/auth.ts:556',
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

  /* ── BLOG — Team ────────────────────────────────────────────────────── */
  {
    surface: 'blog',
    group: 'Team',
    m: 'GET',
    p: '/api/users',
    auth: 'owner',
    src: 'server/routes/users.ts:70',
    sum: 'Every account, with post counts.',
    desc:
      'Owner-only, like invites and export: this list is the email address of every person with a login, which is exactly what the rest of the auth surface is written to keep an attacker from assembling.<br><br><strong>No pagination</strong>, and that is a decision rather than an omission — accounts exist only by invite, one at a time, issued by an owner. Ordered oldest first. <code>password_hash</code> is enumerated out of the SELECT rather than dropped by the mapper, so a column added to <code>users</code> later cannot arrive in a response by default.<br><br><code>postCount</code> <strong>includes trashed posts.</strong> The question it answers is "what does disabling this person leave behind", and a trashed post is restorable until somebody empties the trash — a count that omitted them would read as zero for a writer whose entire body of work is one <code>POST /api/trash/empty</code> from being destroyed. An account with nothing written still appears.',
    res: {
      200: `{ "items": [ { "id": "…", "email": "…", "displayName": "…",
              "role": "owner" | "writer", "createdAt": 0,
              "disabledAt": 0 | null, "postCount": 0 } ] }`,
    },
    errs: [[401, 'unauthenticated', ''], [403, 'forbidden', 'Session is a writer, not the owner']],
  },
  {
    surface: 'blog',
    group: 'Team',
    m: 'POST',
    p: '/api/users/:id/disable',
    auth: 'owner',
    src: 'server/routes/users.ts:90',
    sum: 'Revoke an account and destroy every session it holds.',
    params: [['id', 'User id. Must be a UUID.']],
    body: null,
    desc:
      'Marking <code>disabled_at</code> is not revocation on its own: <code>resolveSession</code> refuses a disabled user\'s session but the rows survive, so clearing the column later would bring back every cookie ever issued — including the one on the laptop that prompted the revocation. Both happen in one statement. <code>sessionsEnded</code> reports how many died, which is the only feedback distinguishing revoking a live account from tidying a dormant one.<br><br><strong>Idempotent.</strong> Disabling an already-disabled user is a 200 with <code>sessionsEnded: 0</code> and keeps the original disable time; a 409 for "already disabled" would make an ordinary double-click an error when the state asked for is the state you get.<br><br><strong>Two refusals, both 409 <code>precondition_failed</code>, told apart by <code>operation</code>.</strong> <code>disable_last_owner</code> is checked FIRST and fires when the target is the only owner who can still sign in — every route here is owner-only, so revoking them locks the door from the inside and the recovery is <code>scripts/set-owner-password.ts</code> against the production database. <code>disable_self</code> fires for any other attempt to revoke yourself. The order matters: with the guard in front, an active owner who is not the caller implies a second active owner exists, so the last-owner case is only ever reachable as "you, on a one-owner blog" — and "promote somebody first" is more useful there than "ask a colleague", of whom there is none.',
    res: { 200: `{ "ok": true, "sessionsEnded": 3 }` },
    errs: [
      [400, 'bad_request', '<code>detail: "id"</code> — not a UUID'],
      [401, 'unauthenticated', ''],
      [403, 'forbidden', 'Session is a writer, not the owner'],
      [404, 'gone', 'No account with that id'],
      [409, 'precondition_failed', 'Carries <code>operation</code> (<code>disable_last_owner</code> or <code>disable_self</code>) and <code>userId</code>. <strong>No <code>post</code> field</strong> — there is no post, which is why these are written with <code>c.json</code> rather than thrown'],
    ],
  },
  {
    surface: 'blog',
    group: 'Team',
    m: 'POST',
    p: '/api/users/:id/enable',
    auth: 'owner',
    src: 'server/routes/users.ts:162',
    sum: 'Reinstate a revoked account.',
    params: [['id', 'User id. Must be a UUID.']],
    body: null,
    desc:
      'Clears <code>disabled_at</code> and nothing else — <strong>deliberately not the mirror of disable.</strong> Disabling destroyed the session rows, so enabling restores the ability to log in and no more: the user types their password again, and the cookie on the laptop that prompted the revocation does not come back. Idempotent, and there are no refusals: no state exists in which restoring somebody\'s access locks anybody out.',
    res: { 200: `{ "ok": true }` },
    errs: [
      [400, 'bad_request', '<code>detail: "id"</code> — not a UUID'],
      [401, 'unauthenticated', ''],
      [403, 'forbidden', ''],
      [404, 'gone', 'No account with that id'],
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

  /* ── BLOG — Categories ──────────────────────────────────────────────── */
  {
    surface: 'blog',
    group: 'Categories',
    m: 'GET',
    p: '/api/categories',
    auth: 'session',
    src: 'server/routes/categories.ts:155',
    sum: 'Every selectable category: the managed list unioned with the values actually in use.',
    desc:
      'A <code>FULL OUTER JOIN</code>, because both sides have rows the other does not. <strong><code>id: null</code> means "in use, not managed"</strong> — a category typed as free text before the <code>categories</code> table existed. Such a row can be selected and can be <em>adopted</em> (POST the name to create the managed row), but it cannot be renamed or deleted, because there is no row to name. <code>managed</code> is the same fact as <code>id !== null</code>.<br><br>Categories are matched <strong>case-insensitively</strong> throughout: \'Design\' and \'design\' are one entry with one count, and the managed spelling wins wherever there is one.<br><br><strong>Counts include drafts, archived and trashed posts</strong> — every row in <code>posts</code>. That is the opposite rule from <code>GET /api/public/categories</code>, deliberately: this count is the exact row set a rename will move, so the UI\'s "N posts will move" is a promise the server keeps. <code>\'\'</code> never appears; it means uncategorised, not a category named the empty string.<br><br>No query parameters and no pagination: this is an invite-only blog\'s category vocabulary, and every consumer is a picker that renders the whole list. Ordered case-insensitively by name.',
    res: {
      200: `{
  "categories": [
    { "id": "…" | null, "name": "Design", "count": 12, "managed": true }
  ]
}`,
    },
    errs: [[401, 'unauthenticated', '']],
  },
  {
    surface: 'blog',
    group: 'Categories',
    m: 'POST',
    p: '/api/categories',
    auth: 'session',
    src: 'server/routes/categories.ts:164',
    sum: 'Promote a name to a managed row.',
    desc:
      '<strong>Writers may create, not only the owner.</strong> A writer inventing a category is the ordinary act this feature exists to make survivable — refusing it pushes them back to typing one into the post, which is where the typo categories came from.<br><br>The name is trimmed, then bounded at <strong>400 bytes</strong> (<code>MAX_CATEGORY_BYTES</code>, the same ceiling <code>posts.category</code> carries because it feeds the <code>search</code> tsvector). Bytes and not characters: a 200-character name of four-byte glyphs is 800 bytes, and a name over the bound is one a later rename could not write into <code>posts.category</code> without failing SQLSTATE 54000 mid-UPDATE.<br><br><code>count</code> comes back non-zero when the name was <strong>already in use as free text</strong>, which is the ordinary call rather than an edge case: "manage the category I have been typing for six months" is the same request as "create a new one".',
    body: `{
  "name": "Design"   // trimmed; non-blank; ≤ 400 BYTES
}`,
    res: { 201: `{ "category": { "id": "…", "name": "Design", "count": 0, "managed": true } }` },
    errs: [
      [400, 'bad_request', '<code>detail</code>: <code>name</code> (blank after trimming, or over 400 bytes), <code>content-type</code>, <code>body</code>, or an unknown key name'],
      [401, 'unauthenticated', ''],
      [409, 'precondition_failed', 'A managed row already has that name <strong>in some casing</strong>. The body is <code>{ error, operation: "create", category, requestId }</code> — the existing row rides along so a picker can select it without a second request'],
    ],
  },
  {
    surface: 'blog',
    group: 'Categories',
    m: 'PATCH',
    p: '/api/categories/:id',
    auth: 'session',
    src: 'server/routes/categories.ts:178',
    sum: 'Rename, and rewrite every post carrying the old value.',
    params: [['id', 'Category id. Must be a UUID.']],
    desc:
      '<strong>One statement, therefore one implicit transaction.</strong> Split into two round trips, a failure between them leaves the list saying \'Product Design\' and every post saying \'Design\'. <code>db.transaction</code> is not available on this path — the Neon HTTP driver rejects it unconditionally.<br><br><strong>A rename is also the merge tool</strong>, which falls out of the case-insensitive rule rather than being bolted on: renaming \'design\' to \'Design\' normalises every casing in the blog, and renaming onto an existing <em>unmanaged</em> value folds that legacy value into this row. Renaming onto another <strong>managed</strong> name is refused — merging two managed rows is a different operation and doing it silently destroys one of them.<br><br><code>movedPosts</code> and <code>category.count</code> are different numbers and both are true: the first is how many posts left the old name, the second is how many carry the new one afterwards (larger when a merge happened).<br><br><strong>It moves neither <code>posts.revision</code> nor <code>posts.updatedAt</code>.</strong> A category rename is not an edit of anybody\'s text: bumping <code>revision</code> would 409 every open editor for a typo fix, and bumping <code>updatedAt</code> would reorder the dashboard, which sorts by it. <code>lifecycle_generation</code> is untouched too, so a concurrent publish still wins.',
    body: `{
  "name": "Product Design"   // same rules as create
}`,
    res: {
      200: `{
  "category": { "id": "…", "name": "Product Design", "count": 12, "managed": true },
  "movedPosts": 9
}`,
    },
    errs: [
      [400, 'bad_request', '<code>detail</code>: <code>id</code> (not a UUID, or a NUL byte), <code>name</code>, <code>content-type</code>, <code>body</code>, or an unknown key name'],
      [401, 'unauthenticated', ''],
      [404, 'gone', 'No managed row with that id'],
      [409, 'precondition_failed', 'The new name belongs to another managed row, in some casing. <code>{ error, operation: "rename", category, requestId }</code>, and <strong>nothing moved</strong> — the whole statement rolled back'],
    ],
  },
  {
    surface: 'blog',
    group: 'Categories',
    m: 'DELETE',
    p: '/api/categories/:id',
    auth: 'owner',
    src: 'server/routes/categories.ts:188',
    sum: 'Delete a managed category, optionally moving the posts that use it.',
    params: [['id', 'Category id. Must be a UUID.']],
    query: [
      ['reassign', 'Where the posts should go. <strong>Absent</strong> means "only delete if nothing uses it" — in use, the request is refused. <code>-</code> means <strong>uncategorised</strong> (<code>posts.category = \'\'</code>), which is a real choice and not the same as omitting the parameter. Any other value is the new category name, and it does <strong>not</strong> have to be a managed one: <code>posts.category</code> is free text, so an unknown target simply becomes an in-use unmanaged value in the next list.'],
    ],
    desc:
      '<strong>The one owner-only route on this surface.</strong> It is the only operation that rewrites <code>posts.category</code> in bulk, on posts the caller did not write, with no undo.<br><br>The refusal is decided <em>inside</em> the delete statement (<code>AND (SELECT n FROM used) = 0</code>) rather than by a read followed by a delete, so "refused" and "deleted" cannot both be answers to one request. There is deliberately <strong>no foreign key</strong> from <code>posts</code> to <code>categories</code>: an FK would make every pre-existing free-text category unstorable and would turn this refusal into a raw 23503 the route could not explain.<br><br>A category literally named <code>-</code> cannot be a reassignment target; that is the cost of having a spelling for "no category" that survives a query string.',
    res: { 200: `{ "movedPosts": 12 }` },
    errs: [
      [400, 'bad_request', '<code>detail</code>: <code>id</code> (not a UUID, or a NUL byte), <code>reassign</code> (over 400 bytes), or an unknown query key name — <code>?reassing=Ops</code> is a refusal, not a silently ignored parameter'],
      [401, 'unauthenticated', ''],
      [403, 'forbidden', 'Session is a writer, not the owner'],
      [404, 'gone', 'No managed row with that id'],
      [409, 'precondition_failed', 'Posts still carry the name and no <code>?reassign</code> was given. <code>{ error, operation: "delete", category, requestId }</code>, where <code>category.count</code> is how many — the number the reassign dialog opens with'],
    ],
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

  /* ── BLOG — Email marketing ─────────────────────────────────────────── */
  {
    surface: 'blog',
    group: 'Email marketing',
    m: 'GET',
    p: '/api/admin/email/templates',
    auth: 'owner',
    src: 'server/routes/email.ts:314',
    sum: 'Every template, both bodies in full.',
    desc:
      '<strong>The whole admin email surface is owner-only, not <code>requireAuth</code>.</strong> A writer publishing a bad post is a post that can be unpublished; a writer pressing "send" is five thousand messages that cannot be recalled, to a list whose consent the owner is answerable for.<br><br><strong>No pagination and no projection</strong> — <code>html</code> and <code>text</code> come back complete rather than as a preview. Two screens need both: the editor opens a template without a second request, and the broadcast composer decides which templates may be <em>picked</em> by scanning each body for <code>{{unsubscribe_url}}</code>. A managed set of a few rows makes the same case <code>GET /api/categories</code> does for having no cursor — a page here is a limit the composer would immediately have to defeat.',
    res: {
      200: `{ "items": [ { "id": "…", "name": "Welcome", "subject": "…",
              "html": "<p>…</p>", "text": "…",
              "updatedAt": 0, "updatedBy": "…" | null } ] }`,
    },
    errs: [[401, 'unauthenticated', ''], [403, 'forbidden', 'Session is a writer, not the owner']],
  },
  {
    surface: 'blog',
    group: 'Email marketing',
    m: 'GET',
    p: '/api/admin/email/templates/:id',
    auth: 'owner',
    src: 'server/routes/email.ts:318',
    sum: 'One template.',
    params: [['id', 'Template id. Must be a UUID.']],
    desc:
      'The id is checked for a NUL byte and then for UUID shape, in that order, before any statement runs. Both halves matter: every id on this surface is a <code>uuid</code> column, and a segment that is not one reaches the driver as SQLSTATE 22P02 — scrubbed to a 500, which the client then retries five times for a request that can never succeed.',
    res: { 200: `{ "template": { … } }` },
    errs: [
      [400, 'bad_request', '<code>detail: "id"</code> — a NUL byte, or not a UUID'],
      [401, 'unauthenticated', ''],
      [403, 'forbidden', ''],
      [404, 'gone', 'No template with that id'],
    ],
  },
  {
    surface: 'blog',
    group: 'Email marketing',
    m: 'POST',
    p: '/api/admin/email/templates',
    auth: 'owner',
    src: 'server/routes/email.ts:325',
    sum: 'Create a template.',
    desc:
      'All four fields are required. <code>name</code> and <code>subject</code> are trimmed and must be non-blank afterwards; <code>name</code> is trimmed because <code>email_templates_name_ck</code> requires <code>name = btrim(name)</code>, a check that exists so \' Welcome\' and \'Welcome\' cannot become two rows the composer\'s picker renders identically.<br><br><strong>Only two variables exist, and the list is enforced at SAVE time.</strong> <code>{{name}}</code> and <code>{{unsubscribe_url}}</code> — whitespace-tolerant, so <code>{{ name }}</code> is the same placeholder. Anything else is a 400 naming the <em>field</em> it appeared in, because a template carrying <code>{{firstname}}</code> is not one that renders badly: it is one that mails the literal string to every subscriber, once, unrecallably.<br><br><strong>A template missing <code>{{unsubscribe_url}}</code> still saves.</strong> That asymmetry is deliberate — a template is written over several sittings, and a save that failed until both bodies were finished would mean the composer could not store work in progress. The gate is at send time; see <code>POST …/broadcasts/:id/send</code>.',
    body: `{
  "name":    "Welcome",     // 1..200, trimmed, non-blank after trim, unique case-insensitively
  "subject": "…",           // 1..400, trimmed, non-blank after trim
  "html":    "<p>…</p>",    // 1..200 000 chars
  "text":    "…"            // 1..200 000 chars
}`,
    res: { 201: `{ "template": { … } }` },
    errs: [
      [400, 'bad_request', '<code>detail</code>: <code>name</code>, <code>subject</code>, <code>html</code> or <code>text</code> — blank after trimming, over the ceiling, or carrying a placeholder this server cannot substitute; also <code>content-type</code>, <code>body</code>, or an unknown key name'],
      [401, 'unauthenticated', ''],
      [403, 'forbidden', ''],
      [409, 'precondition_failed', 'A template already has that name <strong>in some casing</strong>. <code>{ error, operation: "create", template, requestId }</code> — the existing row rides along under its own key, so a client reads one shape per entity rather than a generic envelope'],
    ],
  },
  {
    surface: 'blog',
    group: 'Email marketing',
    m: 'PATCH',
    p: '/api/admin/email/templates/:id',
    auth: 'owner',
    src: 'server/routes/email.ts:332',
    sum: 'Edit a template — a real partial patch.',
    params: [['id', 'Template id. Must be a UUID.']],
    desc:
      '<strong>All four fields are optional and the patch is merged onto the stored row, not a full replace under a <code>PATCH</code> verb.</strong> The composer saves the HTML pane and the text pane independently, and a full replace would send the pane that was not open back from whatever the client last read — which is how one editor\'s stale copy of the text part silently overwrites another\'s.<br><br><strong>An empty patch is a 400, not a no-op.</strong> <code>{}</code> would be a write that changes nothing except <code>updated_at</code> and <code>updated_by</code> — a silent claim that somebody edited this. A refusal is cheaper to explain than that row is.<br><br>The merged result is re-validated as a whole, so the variable scan and the trim rules apply to what will actually be stored rather than only to the fields that moved. There is no <code>baseRevision</code> on this surface: templates carry no revision column.',
    body: `{
  "name":    "…",   // every field optional; at least one required
  "subject": "…",
  "html":    "…",
  "text":    "…"
}`,
    res: { 200: `{ "template": { … } }` },
    errs: [
      [400, 'bad_request', '<code>detail: "body"</code> for an empty patch; otherwise the same field names <code>POST</code> reports'],
      [401, 'unauthenticated', ''],
      [403, 'forbidden', ''],
      [404, 'gone', 'No template with that id — including one deleted between the read and the write'],
      [409, 'precondition_failed', '<code>{ error, operation: "rename", template, requestId }</code> — the new name belongs to another template, in some casing'],
    ],
  },
  {
    surface: 'blog',
    group: 'Email marketing',
    m: 'DELETE',
    p: '/api/admin/email/templates/:id',
    auth: 'owner',
    src: 'server/routes/email.ts:354',
    sum: 'Delete a template.',
    params: [['id', 'Template id. Must be a UUID.']],
    desc:
      '<strong>Deliberately not refused when a broadcast has used it.</strong> <code>email_broadcasts.template_id</code> is <code>ON DELETE SET NULL</code>, and the subject, HTML and text a broadcast sent are its own snapshot columns — so a deleted template takes nothing away from the history and "what did we send in March" stays answerable. Refusing would mean a template can never be retired once it has been used, which on this surface is "once ever".',
    res: { 200: `{ "ok": true }` },
    errs: [
      [400, 'bad_request', '<code>detail: "id"</code>'],
      [401, 'unauthenticated', ''],
      [403, 'forbidden', ''],
      [404, 'gone', 'Already deleted, or never existed'],
    ],
  },
  {
    surface: 'blog',
    group: 'Email marketing',
    m: 'GET',
    p: '/api/admin/email/subscribers',
    auth: 'owner',
    src: 'server/routes/email.ts:362',
    sum: 'One page of the list, with the audience totals alongside.',
    query: [
      ['filter', '<code>subscribed</code> (default) | <code>unsubscribed</code> | <code>all</code>.'],
      ['cursor', 'Opaque, from the previous page. Up to 512 chars, and bound to this list\'s ordering — spending a post cursor here is a 400, never a wrong page.'],
      ['limit', 'Integer 1–100, default 24. Out of range is rejected, not clamped.'],
    ],
    desc:
      '<strong>No <code>token</code> in the projection, ever.</strong> The token is the entire authority of <code>POST /api/public/unsubscribe</code>, so putting it in a list response would mean every admin screen, every browser cache and every log of a 200 body holds a working "unsubscribe this person" credential for the whole audience. The only place it is read is the send path, which builds one link and hands it to the recipient it belongs to.<br><br>Keyset by <code>createdAt</code>, newest first — not <code>OFFSET</code>, because a subscriber added while somebody scrolls pushes one row past an offset page boundary and it is never seen. On this table that is not cosmetic: the rows are people, and "we could not find them in the list" is how an unsubscribe request gets lost.<br><br><strong>The query schema is strict</strong>, like every other in this application, and here the reason is sharp: <code>?fitler=unsubscribed</code> silently ignored would list the whole audience while the screen said "unsubscribed only" — which on this table is a list of people who asked not to be here.<br><br><code>counts</code> rides along because the confirm dialog before a broadcast has to state a real number; see <code>GET /api/admin/email/audience</code> for why it is also its own route.',
    res: {
      200: `{
  "items": [ { "id": "…", "email": "ada@example.test",   // always lowercase
               "name": "Ada L." | null,
               "source": "customer" | "manual" | "import",
               "consentAt": 0 | null,
               "unsubscribedAt": 0 | null,
               "createdAt": 0 } ],
  "nextCursor": "…" | null,
  "counts": { "subscribed": 1284, "suppressed": 37 }
}`,
    },
    errs: [
      [400, 'bad_request', '<code>detail</code>: <code>filter</code>, <code>cursor</code> (undecodable, or minted under another ordering), <code>limit</code>, or an unknown query key'],
      [401, 'unauthenticated', ''],
      [403, 'forbidden', ''],
    ],
  },
  {
    surface: 'blog',
    group: 'Email marketing',
    m: 'POST',
    p: '/api/admin/email/subscribers',
    auth: 'owner',
    src: 'server/routes/email.ts:387',
    sum: 'Add one address by hand.',
    desc:
      '<strong>An existing address is never resurrected.</strong> Adding one that is already on the list answers <code>200</code> with <code>created: false</code> and the row exactly as it was — <code>unsubscribedAt</code> included. That is the whole point of a suppression list: if adding an address again cleared the opt-out, then any import, or one owner pasting last year\'s list, would silently re-subscribe everybody who had asked to stop.<br><br><strong><code>consentAt</code> is set to now for a manual add and left null by an import.</strong> An owner typing one address in has, by doing so, asserted that this person agreed; a file of nine hundred rows asserts only that the owner has the file. Manufacturing a timestamp for the import case would produce evidence that is not evidence.<br><br>The address is lowercased and trimmed before it is stored, and the check is only that it contains an <code>@</code> — <code>email_subscribers_email_ck</code> refuses anything not already lowercase, so a caller that skips the normalisation fails loudly rather than quietly creating a second row for the same person.',
    body: `{
  "email": "ada@example.test",   // 1..320; lowercased and trimmed
  "name":  "Ada L." | null       // optional, <= 200
}`,
    res: {
      201: `{ "subscriber": { … }, "created": true }`,
      200: `{ "subscriber": { … }, "created": false }   // already on the list, untouched`,
    },
    errs: [
      [400, 'bad_request', '<code>detail: "email"</code> (no <code>@</code>, or over 320), <code>content-type</code>, <code>body</code>, or an unknown key name'],
      [401, 'unauthenticated', ''],
      [403, 'forbidden', ''],
    ],
  },
  {
    surface: 'blog',
    group: 'Email marketing',
    m: 'POST',
    p: '/api/admin/email/subscribers/import',
    auth: 'owner',
    src: 'server/routes/email.ts:406',
    sum: 'Bulk-add addresses, all-or-nothing.',
    desc:
      '<strong>Two body shapes, and both are load-bearing.</strong> <code>{ csv }</code> is the file, parsed <em>here</em> — the server has to be able to do it, because "the client validated it" is not a property a server may assume. <code>{ emails }</code> is the same import after the composer has already parsed and previewed it, so the writer sees which rows would be refused before anything is written. The two converge on one list of rows before any validation runs, so the file path and the previewed path are held to exactly the same rules.<br><br><strong>Every row is validated before any row is written.</strong> Validating as each is inserted leaves the rows before the bad one stored and the ones after it not — a partial import the caller cannot tell from a complete one. A malformed address, or one the file lists twice, is a 400 whose <code>detail</code> names the <strong>line number</strong>: a position rather than a value, so nothing a caller pasted comes back in the error. A duplicate is refused rather than deduplicated, because silently collapsing it would make <code>added + skipped</code> disagree with the row count the operator is looking at.<br><br><strong><code>consent</code> is optional and its absence is meaningful, not a default.</strong> Present, the rows record when the <em>operator</em> asserted these people agreed — which is the only thing a bulk upload can honestly record. Absent, the rows carry no consent timestamp at all.<br><br>Addresses already on the list count as <code>skipped</code> and are left exactly as they are, opt-outs included.',
    body: `{
  "csv": "email,name\\nada@example.test,Ada L.\\n",   // <= 1 000 000 chars
  "consent": true                                    // optional; must be literal true
}

// …or, equivalently, the already-previewed form:
{
  "emails": ["ada@example.test"],                    // 1..5000 entries, each <= 320
  "consent": true
}`,
    res: { 200: `{ "added": 812, "skipped": 88, "total": 900 }` },
    rl: '<code>emailimport:&lt;userId&gt;</code> at <strong>5 / hour</strong>, checked before the body is parsed — the same number export and import use, and for the same reason: generous for a human pressing a button, useless for a loop. An import is a bulk write of attacker-shaped text through a parser.',
    errs: [
      [400, 'bad_request', '<code>detail: "csv.line.&lt;n&gt;"</code> — that line is not a usable address, or the file lists it twice. <code>detail: "csv"</code> for an empty file or one over 5 000 rows. Otherwise <code>content-type</code>, <code>body</code>, or an unknown key name'],
      [401, 'unauthenticated', ''],
      [403, 'forbidden', ''],
      [429, 'rate_limited', 'Carries <code>Retry-After</code>'],
    ],
  },
  {
    surface: 'blog',
    group: 'Email marketing',
    m: 'GET',
    p: '/api/admin/email/audience',
    auth: 'owner',
    src: 'server/routes/email.ts:447',
    sum: 'How many people a broadcast would reach.',
    desc:
      '<strong>This cannot come off the subscriber list, which is why it is a route and not a field.</strong> That list is a keyset <em>page</em>, so <code>items.length</code> is the page size — the single most dangerous number this surface could put in front of somebody about to email a few thousand people.<br><br>Two counted aggregates over one indexed column is the cheapest honest answer, and the confirm dialog asks for it at the moment it is needed rather than trusting a count fetched three screens ago.',
    res: { 200: `{ "subscribed": 1284, "suppressed": 37 }` },
    errs: [[401, 'unauthenticated', ''], [403, 'forbidden', '']],
  },
  {
    surface: 'blog',
    group: 'Email marketing',
    m: 'GET',
    p: '/api/admin/email/broadcasts',
    auth: 'owner',
    src: 'server/routes/email.ts:431',
    sum: 'Every broadcast, with the current audience beside it.',
    desc:
      'Newest first, and unpaginated for the same reason templates are. <code>recipientCount</code> is the <strong>denominator</strong>: without it "412 sent" is a number with no scale — nearly done and barely started are not the same thing to somebody watching a send they cannot recall. It is counted rather than stored, because unlike <code>sentCount</code> it does not move once the audience is enqueued.<br><br><code>audience</code> is the live list total, not a property of any broadcast: it is what a <em>new</em> broadcast would reach today.',
    res: {
      200: `{
  "items": [ { "id": "…", "templateId": "…" | null,   // null once the template is deleted
               "subject": "…", "html": "…", "text": "…",   // the SNAPSHOT, not the template
               "status": "draft" | "sending" | "sent" | "failed",
               "createdBy": "…" | null, "createdAt": 0,
               "scheduledAt": 0 | null,
               "startedAt": 0 | null, "finishedAt": 0 | null,
               "sentCount": 0, "failedCount": 0,
               "recipientCount": 1284 } ],
  "audience": { "subscribed": 1284, "suppressed": 37 }
}`,
    },
    errs: [[401, 'unauthenticated', ''], [403, 'forbidden', '']],
  },
  {
    surface: 'blog',
    group: 'Email marketing',
    m: 'POST',
    p: '/api/admin/email/broadcasts',
    auth: 'owner',
    src: 'server/routes/email.ts:467',
    sum: 'Create a draft from a template, snapshotting it.',
    desc:
      '<strong>The three snapshot columns are filled here and never again.</strong> Editing the template afterwards changes nothing about this broadcast — which is what makes "what did we send in March" answerable, and why deleting a template is allowed to leave <code>templateId: null</code> behind.<br><br><code>subject</code> is an override for this send only; omit it and the template\'s own subject is snapshotted. The template is not touched either way.<br><br><strong>An unknown <code>templateId</code> is a 400, not a 404.</strong> The id is a field in the body rather than the thing being addressed, so it is bad input to this request rather than a missing resource — the same reading a malformed UUID gets, and both report <code>detail: "templateId"</code>.',
    body: `{
  "templateId": "…",     // 1..64, must be a UUID naming an existing template
  "subject": "…"         // optional, 1..400; overrides the template's subject for this send
}`,
    res: { 201: `{ "broadcast": { …, "status": "draft", "sentCount": 0 } }` },
    errs: [
      [400, 'bad_request', '<code>detail</code>: <code>templateId</code> (not a UUID, or no such template), <code>subject</code> (blank after trimming), <code>content-type</code>, <code>body</code>, or an unknown key name'],
      [401, 'unauthenticated', ''],
      [403, 'forbidden', ''],
    ],
  },
  {
    surface: 'blog',
    group: 'Email marketing',
    m: 'GET',
    p: '/api/admin/email/broadcasts/:id',
    auth: 'owner',
    src: 'server/routes/email.ts:451',
    sum: 'One broadcast, with how its queue stands.',
    params: [['id', 'Broadcast id. Must be a UUID.']],
    desc:
      'The progress view polls this. <code>recipients</code> counts the queue rows by status, so <code>pending + sent + failed</code> is <code>broadcast.recipientCount</code> once the audience has been enqueued and zero before it has.<br><br><code>failed</code> includes people who <em>unsubscribed after the audience was enqueued</em> as well as transport failures — see <code>drained.suppressed</code> on the send and drain routes, which is the number that tells the two apart.',
    res: {
      200: `{
  "broadcast": { … },
  "recipients": { "pending": 872, "sent": 412, "failed": 0 }
}`,
    },
    errs: [
      [400, 'bad_request', '<code>detail: "id"</code>'],
      [401, 'unauthenticated', ''],
      [403, 'forbidden', ''],
      [404, 'gone', 'No broadcast with that id'],
    ],
  },
  {
    surface: 'blog',
    group: 'Email marketing',
    m: 'POST',
    p: '/api/admin/email/broadcasts/:id/send',
    auth: 'owner',
    src: 'server/routes/email.ts:498',
    sum: 'Start the send, and drain the first batch inline.',
    params: [['id', 'Broadcast id. Must be a UUID.']],
    desc:
      '<strong>The unsubscribe gate is here, and it is required in BOTH bodies.</strong> A broadcast whose snapshot HTML or snapshot text lacks <code>{{unsubscribe_url}}</code> is refused — not either-or, because a reader whose client renders the text part sees only that half, and a link present solely in the HTML is not present for them. The check is against the <strong>broadcast\'s snapshot</strong> and not the template: fixing the template after the broadcast was created does not fix the broadcast.<br><br><strong>The first batch is drained inline, because the alternative is a lie.</strong> Being told a broadcast is "sending" while nothing has left the building — until a cron runs some time in the next 24 hours — is the failure shape this codebase keeps finding. One batch inline means the owner watches the first fifty land and can tell immediately whether the provider is configured, whether the template renders, and whether the audience is who they expected. The rest is drained by <code>/drain</code> and by the daily cron.<br><br><strong>The mailer is asked whether it is configured <em>before</em> the audience is enqueued.</strong> Discovered inside the first send instead, a deployment with no <code>RESEND_API_KEY</code> would produce five thousand recipient rows each carrying eight attempts\' worth of the same configuration error, and a broadcast that ends <code>failed</code> for a reason nothing in the UI can distinguish from a bad list. One 501 instead.<br><br>Starting is a compare-and-swap on <code>draft</code>. Losing it means the row is not a draft any more, and the refusal carries the re-read broadcast rather than a guess about which of "somebody else started it" and "it has already run" happened.',
    body: `{ "limit": 50 }     // optional; 1..50, the whole body may be omitted`,
    res: {
      200: `{
  "broadcast": { …, "status": "sending" },
  "drained": { "sent": 50, "failed": 0,
               "suppressed": 0,    // of failed: opted out after being enqueued
               "skipped": 0,       // claimed by a concurrent drain
               "retryable": 0 }    // transport refusals the next drain will retry
}`,
    },
    errs: [
      [400, 'bad_request', '<code>detail: "id"</code>, or <code>limit</code> out of range'],
      [401, 'unauthenticated', ''],
      [403, 'forbidden', ''],
      [404, 'gone', 'No broadcast with that id'],
      [409, 'precondition_failed', '<code>{ error, operation: "send", broadcast, requestId }</code> — <strong>three different causes under one code</strong>: a snapshot missing <code>{{unsubscribe_url}}</code> in either body, a deployment with no <code>APP_ORIGINS</code> to build the link from, or a broadcast that was not a draft when the CAS ran'],
      [501, 'not_implemented', '<code>{ error, feature }</code> — no mailer is configured. Asked once, before anything is enqueued'],
    ],
  },
  {
    surface: 'blog',
    group: 'Email marketing',
    m: 'POST',
    p: '/api/admin/email/broadcasts/:id/drain',
    auth: 'owner',
    src: 'server/routes/email.ts:537',
    sum: 'Continue a send already under way.',
    params: [['id', 'Broadcast id. Must be a UUID.']],
    desc:
      'Idempotent. A broadcast with nothing pending drains zero and is closed by the same call, so a client may poll this without deciding first whether there is work.<br><br><strong>Only a <code>sending</code> broadcast may be drained</strong> — a draft has no queue and a finished one has nothing left, and both are the same 409 carrying the row so the caller can see which.<br><br>Suppression is applied <em>late</em>, at the moment of sending rather than when the audience was enqueued: the claim reads <code>unsubscribed_at</code> through a join, so somebody who clicks unsubscribe mid-drain is passed over by the batch that had not reached them yet, and is counted in <code>suppressed</code> rather than <code>sent</code>.',
    body: `{ "limit": 50 }     // optional; 1..50, the whole body may be omitted`,
    res: { 200: `{ "broadcast": { … }, "drained": { "sent": 50, "failed": 0, "suppressed": 0, "skipped": 0, "retryable": 0 } }` },
    errs: [
      [400, 'bad_request', '<code>detail: "id"</code>, or <code>limit</code> out of range'],
      [401, 'unauthenticated', ''],
      [403, 'forbidden', ''],
      [404, 'gone', ''],
      [409, 'precondition_failed', '<code>{ error, operation: "drain", broadcast, requestId }</code> — the broadcast is not <code>sending</code>, or the deployment has no <code>APP_ORIGINS</code>'],
      [501, 'not_implemented', 'No mailer is configured'],
    ],
    notes: [
      'A recipient is retried until <strong>8 attempts</strong> and then written off as <code>failed</code> — the same ceiling the order outbox uses, deliberately, because two retry limits in one application is two things to reason about and one of them is always the one nobody remembers.',
    ],
  },
  {
    surface: 'blog',
    group: 'Email marketing',
    m: 'POST',
    p: '/api/admin/email/broadcasts/:id/test',
    auth: 'owner',
    src: 'server/routes/email.ts:570',
    sum: 'Send the rendered message to yourself.',
    params: [['id', 'Broadcast id. Must be a UUID.']],
    desc:
      '<strong>The recipient is not in the body, and that is the whole design of this route.</strong> A <code>{ to }</code> field would make it an authenticated open relay: a route taking arbitrary HTML and an arbitrary address and sending the first to the second over the deployment\'s verified sending domain. The address comes from the session — the one address the caller has already proved they control.<br><br><strong>Unlike <code>/send</code>, this does not require <code>{{unsubscribe_url}}</code></strong>, because seeing what a half-finished template looks like is what a test send is for.<br><br>The link in the test message carries the caller\'s <em>own</em> unsubscribe token if they happen to be on the list, and a marker otherwise — which the public page answers with "this link is not recognised". That is the truth about a test message, and better than the alternatives: minting a real token for a non-subscriber would put them on the list by previewing, and omitting the link would hide the one thing a test most needs to prove is present.<br><br><strong>A failed send is reported, not thrown.</strong> <code>sent: false</code> is a 200 the caller can act on; a 500 would be retried five times by the client\'s policy for a provider outage that will not clear in thirty seconds. The failure is logged with the error\'s name and message only — never the object, never the body.',
    body: `{}                  // the body must be empty; it may be omitted entirely`,
    res: { 200: `{ "sent": true, "to": "owner@example.test" }` },
    rl: '<code>emailtest:&lt;userId&gt;</code> at <strong>10 / 15 min</strong>. A test send is a real message to a real inbox, and the owner\'s own inbox is still an inbox somebody has to read.',
    errs: [
      [400, 'bad_request', '<code>detail: "id"</code>, or any key at all in the body'],
      [401, 'unauthenticated', ''],
      [403, 'forbidden', ''],
      [404, 'gone', 'No broadcast with that id'],
      [409, 'precondition_failed', '<code>{ error, operation: "send", broadcast, requestId }</code> — no <code>APP_ORIGINS</code> to build the unsubscribe link from'],
      [429, 'rate_limited', 'Carries <code>Retry-After</code>'],
      [501, 'not_implemented', 'No mailer is configured'],
    ],
  },
  {
    surface: 'blog',
    group: 'Email marketing',
    m: 'GET',
    p: '/api/admin/email/drain',
    auth: 'cron',
    src: 'server/routes/email.ts:656',
    sum: 'Scheduled drain of every sending broadcast (cron).',
    query: [['limit', 'Recipients per broadcast, default 50. This route reads the value directly rather than through a schema, so a zero or unparseable value falls back to the default instead of 400ing, unknown query keys are ignored, and — <strong>unlike the <code>POST</code> below — the value is not capped at 50</strong>.']],
    desc:
      '<strong>Authenticated by <code>Authorization: Bearer &lt;CRON_SECRET&gt;</code> — no session, no cookie</strong>, the arrangement the cart\'s maintenance route already uses. Vercel invokes a cron with an HTTP <code>GET</code> and that header; an operator wants to run the same work with the session they already have, which is the <code>POST</code> below. <strong>The two credentials are not interchangeable</strong>, which is what stops a leaked session becoming a way to drive the mailer and stops the cron token becoming a general-purpose admin credential.<br><br>It <strong>fails closed</strong>: an absent or under-16-character secret is a 401, so a misconfigured deployment cannot leave this route open — and it must, because the origin guard waves every <code>GET</code> through and this token is the only thing in front of the endpoint.<br><br><strong><code>assertConfigured</code> is deliberately NOT called here.</strong> The cron runs unattended, and a daily 501 from a scheduled job on a deployment that has no mailer is an alarm about a decision somebody has already made. Per-recipient failures are recorded on the rows either way, which is where an operator would look.<br><br>At most <strong>5</strong> sending broadcasts are looked at per invocation, one batch each rather than one broadcast to completion — so a huge send cannot starve a small one queued behind it, and no single invocation outgrows the 30-second function ceiling. A backlog drains over successive runs.',
    res: {
      200: `{ "sent": 50, "failed": 0, "suppressed": 0,
  "skipped": 0, "retryable": 0,
  "broadcasts": 1 }          // how many sending broadcasts this pass touched`,
    },
    errs: [[401, 'unauthenticated', 'Absent, short or wrong secret']],
    notes: [
      'Scheduled daily at <strong>05:41 UTC</strong> in <code>vercel.json</code>, an hour after the cart\'s own maintenance run rather than alongside it: both drains take the same database, and Hobby\'s ±59 minute jitter means two jobs booked any closer can still land together.',
      'Two crons is the Hobby ceiling. A third needs a plan, not a config line.',
    ],
  },
  {
    surface: 'blog',
    group: 'Email marketing',
    m: 'POST',
    p: '/api/admin/email/drain',
    auth: 'owner',
    src: 'server/routes/email.ts:661',
    sum: 'Run the drain by hand.',
    desc: 'The same work as the cron route, for a human with an owner session. A session will not authenticate the <code>GET</code>, and the cron secret will not authenticate this.',
    body: `{ "limit": 50 }     // optional; 1..50, the whole body may be omitted`,
    res: { 200: 'The same summary as the cron route.' },
    errs: [
      [400, 'bad_request', '<code>limit</code> out of range, or an unknown key name'],
      [401, 'unauthenticated', ''],
      [403, 'forbidden', 'Session is a writer, not the owner'],
    ],
  },

  /* ══════════════════════════════════════════════════════════════════════
     SHOP — Dashboard
     ══════════════════════════════════════════════════════════════════════ */
  {
    surface: 'shop',
    group: 'Dashboard (admin)',
    m: 'GET',
    p: '/api/shop/admin/stats',
    auth: 'session',
    src: 'server/shop/admin/routes.ts:91',
    sum: 'The whole shop dashboard, in one request.',
    query: [
      ['threshold', 'What counts as low stock: <code>available &lt;= threshold</code>. Integer 0–1 000 000, default 5. <code>0</code> is the sold-out list.'],
    ],
    desc:
      'Five fixed aggregates, run in parallel — the count of statements does not grow with the number of orders. No new table, no rollup, no cache: every number is computed from the rows that already exist, because a materialised summary that drifts is a dashboard that is confidently wrong.<br><br><strong>Money is grouped by currency and never summed across it.</strong> <code>ordersByStatus</code> is keyed on <code>(status, currency)</code> and a status with no orders has <em>no row at all</em> — a zero row would have to carry a currency there is no order to take one from. Render a zero client-side for an absent status.<br><br><code>revenue</code> windows are <strong>trailing, not calendar</strong>: there is no store timezone anywhere in this deployment, so a "today" boundary computed in UTC would move under half its readers. All three are measured backwards from <code>generatedAt</code>, over <code>paidAt</code> (an unplaced or unpaid order is not revenue however recent) and net of refunds.<br><br><code>lowStock</code> is a <strong>head, not the list</strong> — at most 20 rows, with <code>lowStockMore</code> saying whether there are others. The full list is <code>GET /api/shop/admin/inventory?belowOnly=1</code>.<br><br><code>emails.stuck</code> is separated from <code>emails.pending</code> because nothing will ever retry it: the sweeper stops at 8 attempts and leaves the row with its <code>lastError</code>. <code>sent</code> means <em>handed to the mailer</em>, which on a deployment with no real mailer wired says nothing about anybody\'s inbox.',
    res: {
      200: `{
  "generatedAt": 1786600000000,
  "ordersByStatus": [ { "status": "paid", "currency": "GBP",
                       "count": 12, "total": 145900 } ],   // total is GROSS
  "revenue":        [ { "currency": "GBP", "last24h": 5400,
                       "last7d": 41200, "last30d": 145900 } ],  // net of refunds
  "lowStockThreshold": 5,
  "lowStock": [ { "variantId": "var_…", "sku": "TEE-M",
                  "optionValues": { "Size": "M" },
                  "variantStatus": "active",
                  "productId": "prd_…", "productTitle": "Logo T-Shirt",
                  "productStatus": "active",
                  "onHand": 3, "reserved": 1, "available": 2,   // may be NEGATIVE
                  "backorderable": false, "updatedAt": 0 } ],
  "lowStockMore": false,
  "emails": { "pending": 2, "stuck": 0, "sent": 41 },
  "latestOrders": [ { "id": "ord_…", "orderNumber": "2026-000042-K",
                      "email": "…", "status": "paid", "currency": "GBP",
                      "grandTotal": 5272, "placedAt": 0 } ]      // no lines
}`,
    },
    errs: [
      [400, 'bad_request', '<code>detail: "threshold"</code> — not an integer, negative, or above 1 000 000; or an unknown query key'],
      [401, 'unauthenticated', ''],
    ],
  },
  {
    surface: 'shop',
    group: 'Dashboard (admin)',
    m: 'GET',
    p: '/api/shop/admin/customers',
    auth: 'session',
    src: 'server/shop/admin/routes.ts:103',
    sum: 'Buyers — which is not the same list as accounts.',
    query: [['cursor', 'Opaque, from the previous page\'s <code>nextCursor</code>.'], ['limit', 'Integer 1–100, default 24.']],
    desc:
      '<strong>Guest checkout is why this is not a read of <code>shop_customers</code>.</strong> <code>shop_orders.customer_id</code> is nullable by design, so a list built from the accounts table shows the people who signed in and omits the people who bought. This aggregates over <strong>orders</strong>, grouped by <code>lower(email)</code>, and LEFT JOINs the account on for the two things an order does not carry — so <code>customerId: null</code> and <code>displayName: null</code> is the <em>ordinary</em> row, not a degenerate one.<br><br>The folded address is the row\'s identity everywhere: the group key, the join predicate, the sort tiebreak and the cursor\'s id. <code>Buyer@Example.test</code> and <code>buyer@example.test</code> are one person.<br><br><code>totalSpent</code> is <strong>paid orders only, net of refunds</strong>; <code>orderCount</code> counts every order whatever its status, and <code>paidCount</code> is the subset the money came from. The currency is taken from the buyer\'s most recent order rather than summed across codes.<br><br>Keyset by last purchase, newest first. An account that has never ordered does not appear here.',
    res: {
      200: `{
  "items": [ { "email": "buyer@example.test",   // folded; the cursor's id
               "customerId": "cus_…" | null,
               "displayName": "Ada L." | null,
               "orderCount": 3, "paidCount": 2,
               "totalSpent": 6500,               // MINOR UNITS, net of refunds
               "currency": "GBP",
               "lastOrderAt": 0,
               "lastOrderId": "ord_…",
               "lastOrderNumber": "2026-000042-K",
               "lastOrderStatus": "fulfilled" } ],
  "nextCursor": "…" | null
}`,
    },
    errs: [
      [400, 'bad_request', '<code>detail</code>: <code>cursor</code> (undecodable, or minted under another ordering), <code>limit</code> (out of range — <strong>rejected, not clamped</strong>), or an unknown query key'],
      [401, 'unauthenticated', ''],
    ],
  },
  {
    surface: 'shop',
    group: 'Dashboard (admin)',
    m: 'GET',
    p: '/api/shop/admin/inventory',
    auth: 'session',
    src: 'server/shop/admin/routes.ts:108',
    sum: 'Stock across the shop, lowest first.',
    query: [
      ['belowOnly', '<code>1</code> or <code>0</code> only. <code>1</code> keeps just the variants at or under <code>threshold</code>. Any other spelling — including <code>true</code> — is a 400.'],
      ['threshold', 'Integer 0–1 000 000, default 5. Ignored unless <code>belowOnly=1</code>.'],
      ['cursor', ''],
      ['limit', 'Integer 1–100, default 24.'],
    ],
    desc:
      '<code>available</code> is <code>onHand - reserved</code>, <strong>derived in the statement and never stored</strong> — two columns that must sum to a third are three ways to be inconsistent. It is a number to show an operator; the number a sale is decided on is the <code>WHERE</code> clause of the reservation.<br><br><strong><code>available</code> can be negative, and that is not corrupt data.</strong> A backorderable variant is deliberately sold past zero, so an oversold backorder sorts to the top of the list rather than being clamped out of it.<br><br>Trashed products are excluded — nobody is restocking those — but <strong>drafts and archived products are not</strong>: their units are still on a shelf. <code>productStatus</code> says which is which.<br><br><code>belowOnly</code> is spelled as two literals rather than coerced from anything truthy, because <code>?belowOnly=false</code> is a string every truthiness test in JavaScript calls true: a filter that reads as applied, is not, and reports nothing.',
    res: {
      200: `{
  "items": [ { "variantId": "var_…", "sku": "TEE-M",
               "optionValues": { "Size": "M" },
               "variantStatus": "active",
               "productId": "prd_…", "productTitle": "Logo T-Shirt",
               "productStatus": "draft"|"active"|"archived",
               "onHand": 3, "reserved": 1, "available": 2,
               "backorderable": false, "updatedAt": 0 } ],
  "nextCursor": "…" | null
}`,
    },
    errs: [
      [400, 'bad_request', '<code>detail</code>: <code>belowOnly</code> (not <code>0</code>/<code>1</code>), <code>threshold</code>, <code>cursor</code>, <code>limit</code>, or an unknown query key'],
      [401, 'unauthenticated', ''],
    ],
  },
  {
    surface: 'shop',
    group: 'Dashboard (admin)',
    m: 'GET',
    p: '/api/shop/admin/categories',
    auth: 'session',
    src: 'server/shop/admin/routes.ts:120',
    sum: 'Every product category in use, with counts.',
    desc:
      '<strong>This deliberately inverts the published-only rule, and the inversion is the feature.</strong> <code>GET /api/public/categories</code> groups over published posts because a reading surface must not publish the working vocabulary of every draft. This route is behind a session and feeds the category filter on the admin product list — a filter that must be able to select drafts, archived products <em>and the trash</em>, because the list it filters can show all three. So: every row of <code>shop_products</code>, no status filter and no <code>deleted_at</code> filter.<br><br><strong>Grouped by the raw value, not by <code>lower(category)</code>.</strong> The product list filters with an exact, case-sensitive <code>category</code> comparison, so a folded list would offer <code>Design</code> while three products are spelled <code>design</code>, and selecting it would return a subset with nothing to explain the missing rows. Two spellings are two rows — which is also the only way an operator ever finds out they have a typo to fix.<br><br>The empty category is omitted: <code>\'\'</code> is what an uncategorised product carries, and an empty <code>?category=</code> means "no filter" on the product list, so an <code>\'\'</code> option could not be selected. Takes no query parameters at all; the list is bounded by how many distinct values a shop has typed.',
    res: { 200: `{ "items": [ { "name": "Mugs", "count": 4 } ] }` },
    errs: [
      [400, 'bad_request', 'Any query parameter at all — this route takes none'],
      [401, 'unauthenticated', ''],
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
    src: 'server/shop/catalog/routes.ts:211',
    sum: 'Browse active products.',
    desc: 'Only active products. Keyset pagination, same cursor discipline as the blog list — the cursor is bound to its sort.<br><br>Every item carries <code>coverImageUrl</code> and <code>imageUrls</code> beside the raw ids: the same <code>/api/public/images/:id</code> rule <code>PublicCoverImage.url</code> publishes, with the optional <code>asset:</code>/<code>idb:</code> prefix stripped. <strong>The admin list does not carry them</strong> — those URLs resolve only while an <em>active</em> product references the image, so on a draft every one of them would 404.',
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
               "coverImageUrl": "/api/public/images/img_x" | null,
               "imageUrls": ["/api/public/images/img_y"],
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
    src: 'server/shop/catalog/routes.ts:224',
    sum: 'One active product, with its purchasable variants.',
    params: [['slug', 'Product slug.']],
    desc: 'Each variant carries its current price, live availability and whether it can be backordered — everything a product page needs in one request.<br><br><code>coverImageUrl</code> and <code>imageUrls</code> resolve the product\'s image ids to the public media route. The raw <code>coverImageId</code>/<code>imageIds</code> stay beside them, so a client that already reads the ids is unbroken. <strong>Fetching one of those URLs works only while this product is active</strong> — unpublishing takes the pictures down in the same moment it takes the page down.',
    res: {
      200: `{ "product": { …,
    "coverImageUrl": "/api/public/images/img_x" | null,
    "imageUrls": ["/api/public/images/img_y"],
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
    src: 'server/shop/catalog/routes.ts:242',
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
    src: 'server/shop/catalog/routes.ts:260',
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
    src: 'server/shop/catalog/routes.ts:266',
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
    src: 'server/shop/catalog/routes.ts:275',
    sum: 'Create a draft product.',
    desc:
      'The body may be omitted entirely. <code>slug</code> and <code>status</code> are server-authored and rejected if sent — a product becomes active through <code>/publish</code>, and its slug is derived on the way.<br><br><strong>Every image id must name a committed image.</strong> There is no foreign key (contract R3 forbids one across a subsystem boundary), so the write path checks it: an id that is unknown, or that names an upload slot nobody has committed, is a <code>400</code> naming the field. An <code>asset:</code>/<code>idb:</code> prefix is normalised for the check and the id is stored exactly as sent. An empty string is not an id in either field — <code>null</code> is how a cover is cleared.',
    body: `{
  "title": "…",
  "description": { "type": "doc", … },
  "category": "…",              // <= 400 chars
  "tags": ["…"],                // <= 64
  "coverImageId": "…" | null,   // <= 300 chars, must name a committed image
  "imageIds": ["…"]             // <= 100 entries, each must name a committed image
}`,
    res: { 201: `{ "product": { …, "status": "draft", "revision": 1 } }` },
    errs: [
      [400, 'bad_request', '<code>detail: "coverImageId"</code> or <code>detail: "imageIds"</code> — an id that names no committed image (the <em>field name</em>, never the id itself); otherwise an unknown key or a NUL byte'],
      [401, 'unauthenticated', ''],
      [422, 'invalid_document', ''],
    ],
  },
  {
    surface: 'shop',
    group: 'Catalog (admin)',
    m: 'PATCH',
    p: '/api/shop/admin/products/:id',
    auth: 'session',
    src: 'server/shop/catalog/routes.ts:286',
    sum: 'Edit a product, with compare-and-swap.',
    params: [['id', 'Product id.']],
    desc:
      'Same CAS contract as posts, with one difference worth knowing: the 409 body carries <code>product</code>, not <code>post</code>. It is the full current row from a single re-read, so a "load theirs" needs no follow-up request.<br><br><strong>Image ids in the PATCH are checked; the merged result is not.</strong> Same rule <code>description</code> follows: a product whose <em>stored</em> cover has since been collected stays editable, because a validator applied to the merge would refuse every future save and the only route that could clear the dead id is the one being refused.',
    body: `{
  "patch": { … same fields as POST … },
  "baseRevision": 3,
  "note": "…"                   // optional, <= 400 chars
}`,
    res: { 200: `{ "product": { …, "revision": 4 } }` },
    errs: [
      [400, 'bad_request', '<code>detail: "coverImageId"</code> / <code>"imageIds"</code> — an id in this patch names no committed image'],
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
    src: 'server/shop/catalog/routes.ts:321',
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
    src: 'server/shop/catalog/routes.ts:335',
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
    src: 'server/shop/catalog/routes.ts:339',
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
    src: 'server/shop/catalog/routes.ts:350',
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
    src: 'server/shop/catalog/routes.ts:360',
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
    src: 'server/shop/catalog/routes.ts:381',
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
    src: 'server/shop/catalog/routes.ts:389',
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
    src: 'server/shop/orders/routes.ts:182',
    sum: 'The signed-in customer\'s orders. <strong>Unreachable on this deployment — see below.</strong>',
    query: [['cursor', ''], ['limit', 'Integer 1–100, default 24.']],
    desc:
      'Customer-scoped in SQL, not in application code. The customer projection strips <code>checkoutId</code> and <code>paymentIntentId</code>.<br><br><strong>Wired on 2026-08-12; it answered 401 to every caller before that</strong>, including a customer holding a valid <code>__Host-shop_session</code>. Orders reaches the customer identity through a port (<code>server/shop/orders/ports.ts</code>) and the composed app registered only <code>{ mailer }</code>, so <code>resolveDeps</code> fell back to <code>NO_CUSTOMER</code> and the handler\'s first act — <code>if (!customer) throw new UnauthenticatedError()</code> — fired for everybody. <code>server/index.ts</code> now also registers <code>customer: resolveShopCustomer</code>, Cart\'s reader for that cookie, which goes through the same <code>resolveCustomerSession</code> as <code>shopSessionMiddleware</code> so a session slides its expiry identically on both paths.<br><br><strong>Why the suite never caught it:</strong> <code>server/shop/orders/test/app.ts</code> registers a resolver of its own, deliberately, so those tests prove the route and say nothing about the registration. <code>server/shop/composition.test.ts</code> now covers the registration itself, with nothing registered.<br><br>The 401 for an anonymous caller is unchanged and is the honest answer: resolving the writer session instead would make a shop owner\'s orders list return <em>every</em> customer\'s orders under a URL a storefront calls.',
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
    errs: [
      [400, 'bad_request', ''],
      [401, 'unauthenticated', 'No customer session — <strong>and today, no customer resolver either, so this is the answer for everyone</strong>'],
    ],
  },
  {
    surface: 'shop',
    group: 'Orders (customer)',
    m: 'GET',
    p: '/api/shop/orders/:orderNumber',
    auth: 'guest',
    src: 'server/shop/orders/routes.ts:193',
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
    src: 'server/shop/orders/routes.ts:198',
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
    src: 'server/shop/orders/routes.ts:275',
    sum: 'All orders, with an exact-match search.',
    query: [
      ['status', '<code>pending</code> | <code>paid</code> | <code>fulfilled</code> | <code>cancelled</code> | <code>refunded</code> | <code>partially_refunded</code>'],
      ['search', 'An <strong>exact</strong> order number or an <strong>exact</strong> email address, up to 320 chars. Composes with <code>status</code>. An empty value is no filter.'],
      ['cursor', ''],
      ['limit', 'Integer 1–100, default 24.'],
    ],
    desc:
      'The full order rows, including <code>checkoutId</code> and <code>paymentIntentId</code> that the customer view strips.<br><br><strong><code>search</code> is exact on both branches, and neither is a <code>LIKE</code>.</strong> A term that parses as an order number — <em>check character validated before any statement runs</em> — becomes <code>orderNumber = …</code> against a unique index, at most one row. Anything else becomes <code>lower(email) = lower(…)</code> against the index migration 0160 builds for exactly that comparison. A substring search would be a sequential scan of every order per keystroke, and would let one customer\'s address be discovered by typing fragments.<br><br><strong>A mistyped order number is a clean empty page, not a 400</strong> — the opposite of <code>/api/shop/orders/:orderNumber</code>, where the number <em>is</em> the request. Here it is a search term: it falls through to the address branch and matches nothing, from an indexed comparison rather than a scan.<br><br>An empty <code>?search=</code> (or one that is only whitespace) means <strong>no filter</strong>, the same rule the product list applies to <code>?category=</code> — a cleared search box behaves like no search box. Cursors are interchangeable between the searched and unsearched list: it is the same ordering with one more predicate.',
    res: { 200: `{ "items": [ { "order": { … full row … }, "lines": [ … ] } ], "nextCursor": "…" | null }` },
    errs: [
      [400, 'bad_request', '<code>detail</code>: <code>search</code> (over 320 chars, or a NUL byte), <code>cursor</code>, <code>limit</code>, or an unknown query key'],
      [401, 'unauthenticated', ''],
    ],
  },
  {
    surface: 'shop',
    group: 'Orders (admin)',
    m: 'GET',
    p: '/api/shop/admin/orders/:id',
    auth: 'session',
    src: 'server/shop/orders/routes.ts:283',
    sum: 'Everything about one order.',
    params: [['id', 'Order id (not the order number).']],
    desc:
      'One request for the whole support view: lines, fulfilments, timeline, the emails that were queued or sent, and the payment status pulled through the payment port.<br><br><code>payment</code> is <code>null</code> when the order names no payment intent, and that is now the only thing null means. <strong>Wired on 2026-08-12; before that it was null on every order ever placed</strong> — <code>server/index.ts</code> registered only <code>{ mailer }</code>, so <code>resolveDeps</code> fell back to <code>payments: null</code> and the field short-circuited before <code>paymentIntentId</code> was consulted. That was the dangerous shape of this bug: an operator reads an empty payment panel as "this order was never paid" rather than as "nobody wired the port". <code>order.status</code> and <code>order.paidAt</code> remain the authoritative answer to whether money arrived.<br><br>The port is read-only by design: contract §5 gives Orders no way to <em>change</em> payment state, only to display it. For the full intent record — provider reference, authorization URL, error history — use the owner-only <code>GET /api/shop/admin/payments/intents/:id</code>, which reads Payments directly.',
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
  "payment":  { … } | null      // ALWAYS null today — the port is unregistered
}`,
    },
    errs: [[400, 'bad_request', ''], [401, 'unauthenticated', ''], [404, 'gone', '']],
  },
  {
    surface: 'shop',
    group: 'Orders (admin)',
    m: 'GET',
    p: '/api/shop/admin/orders/by-number/:orderNumber',
    auth: 'session',
    src: 'server/shop/orders/routes.ts:308',
    sum: 'Everything about one order, by the number on the receipt.',
    params: [['orderNumber', 'The customer-facing number, e.g. <code>2026-000042-K</code>. Carries a check character, validated before any lookup.']],
    desc:
      'The number is what a customer reads off their receipt and quotes on the phone; every other admin order route addresses <code>shop_orders.id</code>. <strong>The response body is byte-identical to <code>GET /api/shop/admin/orders/:id</code></strong> — lines, fulfilments, timeline, email intents and the payment panel — assembled by the same function, so the two cannot drift.<br><br>A failed check character is a <strong>400, not a 404</strong>: it proves the number was mistyped without touching the database, and it keeps 22 of every 23 guesses off the query path. A well-formed number nobody has is a 404.<br><br><strong>This is not an authorization boundary.</strong> The order number is sequential by construction and therefore guessable, which is why the customer-facing lookup scopes by a resolved customer id or a signed token in the SQL. This route is unscoped and is safe only behind the session guard — where every other admin order read already sits.',
    res: { 200: `{ "order": { … }, "lines": [ … ], "fulfillments": [ … ],
  "timeline": [ … ], "emails": [ … ],
  "payment": { … } | null }      // ALWAYS null today — see the :id route` },
    errs: [
      [400, 'bad_request', '<code>detail: "orderNumber"</code> — failed the check character, or a NUL byte in the path'],
      [401, 'unauthenticated', ''],
      [404, 'gone', 'A well-formed number with no order behind it'],
    ],
  },
  {
    surface: 'shop',
    group: 'Orders (admin)',
    m: 'POST',
    p: '/api/shop/admin/orders/:id/fulfillments',
    auth: 'session',
    src: 'server/shop/orders/routes.ts:316',
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
    src: 'server/shop/orders/routes.ts:344',
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
    src: 'server/shop/orders/routes.ts:420',
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
    src: 'server/shop/orders/routes.ts:400',
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
      'Answers <strong>302</strong> with a <code>Location</code> pointing at a presigned R2 URL that is valid for <strong>five minutes</strong>. It never proxies the bytes.<br><br><strong>Two scopes, OR-ed.</strong> An image is served if it is referenced by the CURRENT content or cover of a currently published <em>post</em>, <strong>or</strong> by the cover or gallery of a currently active <em>product</em> (<code>status = \'active\' AND deleted_at IS NULL</code>) — the same predicate the storefront product routes apply, so an image is servable exactly when the page that would show it is reachable.<br><br>Neither scope counts history or anything unpublished. Not a post revision — an image cut from a published post stops being public the moment the cut is saved. Not a draft, archived or trashed post. Not a draft, archived or trashed product, and not a product revision. Not an uncommitted upload slot. Unknown, uncommitted and not-publicly-referenced are one <code>404</code> from one SQL statement, so the three cannot be told apart.<br><br>This is the deliberate mirror image of the orphan collector, which counts post revisions <em>and</em> products in every state so it never deletes a byte somebody needs. This check fails the other way: it would rather refuse a byte somebody wanted than publish a private one.',
    res: {
      302: 'No body. The <code>Location</code> header carries a presigned URL, valid for five minutes.',
    },
    rl: '<code>public:&lt;ip&gt;</code> at <strong>300 / minute</strong> — the same single bucket the search list uses — charged on <strong>every</strong> request to this route, before the database is touched.',
    errs: [
      [400, 'bad_request', '<code>detail: "id"</code> (NUL byte in the path), or <code>detail: "storage"</code> when the deployment has no R2 configured — a <strong>4xx on purpose</strong>, because a missing bucket does not change during 30 seconds of a client\'s 5xx backoff'],
      [404, 'gone', 'Unknown id, uncommitted upload, or not referenced by any currently published post or currently active product'],
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

  /* ── PUBLIC — CORS ──────────────────────────────────────────────────── */
  {
    surface: 'public',
    group: 'CORS',
    m: 'OPTIONS',
    p: '/api/public/*',
    auth: 'public',
    src: 'server/routes/public.ts:500',
    sum: 'The preflight for every route on this surface.',
    body: null,
    desc:
      '<strong>It exists so a cross-origin <code>fetch</code> carrying <code>If-None-Match</code> can reach the GET behind it.</strong> A conditional request sends a non-simple header, which triggers a preflight; this router answers only <code>GET</code>, so an unrouted <code>OPTIONS</code> was a 404 and the real request never followed — revalidation was unreachable from a browser on another origin.<br><br>Answered directly rather than by a CORS library, because the allow-list is a constant and there is nothing to negotiate.<br><br><strong><code>Access-Control-Allow-Credentials</code> is deliberately absent</strong>, here as on every response from this surface. A preflight is exactly where a browser asks for it, and the answer is the same no: these routes read no cookie, and advertising credential support on a <code>Cache-Control: public</code> surface is how a cached response ends up varying by reader.',
    res: {
      204: 'No body. <code>Access-Control-Allow-Methods: GET, HEAD, OPTIONS</code>, the allowed and exposed header lists, and <code>Access-Control-Max-Age: 86400</code> so a browser preflights once a day rather than once a request.',
    },
    errs: [],
    notes: [
      'The matching <code>Access-Control-Allow-Origin</code> is set on every response from this surface — including error responses, which need their own hook because <code>toResponse</code> builds a fresh <code>Response</code> that inherits nothing a middleware set.',
    ],
  },

  /* ── PUBLIC — Unsubscribe ───────────────────────────────────────────── */
  {
    surface: 'public',
    group: 'Unsubscribe',
    m: 'GET',
    p: '/api/public/unsubscribe',
    auth: 'public',
    src: 'server/routes/email.ts:815',
    sum: 'The confirmation page behind an unsubscribe link.',
    query: [
      ['token', 'The subscriber\'s token from their message — exactly <strong>64 lowercase hex characters</strong>. Anything else is treated as no token at all.'],
    ],
    desc:
      '<strong>Answers HTML, not JSON.</strong> The caller is a person in a mail client, not a program. A JSON error envelope is the correct answer everywhere else in this application and a dead end here. The page is self-contained — no stylesheet, no script, no font — because it is rendered in whatever browser a mail client happens to open, frequently an in-app webview with no network beyond the first request.<br><br><strong>The GET does not unsubscribe anybody.</strong> Mail clients, security scanners and link previewers fetch every URL in a message before a human sees it; a GET that removed the address would mean Outlook\'s own link scanner unsubscribing people on delivery. This renders a confirmation with a real <code>&lt;form method="post"&gt;</code> — which needs no JavaScript, and is why the POST accepts a plain form submission.<br><br><strong>Unknown query parameters are ignored here — the one route in this application that is not <code>.strict()</code> about its query.</strong> This URL sits in strangers\' mailboxes for years and is rewritten in transit by corporate link-protection gateways, which append their own tracking parameters to every link they scan. A strict schema would turn one such gateway into an unsubscribe outage for an entire company: a refusal the sender never sees and the recipient reads as being ignored. The <em>token</em> is still checked exactly, which is what keeps a NUL byte out of a bound parameter.<br><br>Three outcomes, and an already-unsubscribed address gets the "you are unsubscribed" page rather than an error.',
    res: {
      200: 'HTML. Either the confirmation page (<code>Unsubscribe &lt;address&gt;?</code>) or, if this address has already opted out, the done page.',
      404: 'HTML. "This link is not recognised" — deliberately vague, because the four ways to arrive here (a truncated link, one a gateway rewrote badly, one from before <code>SESSION_SECRET</code> was rotated, and an address no longer on the list) are indistinguishable from outside and the reader can act on the same answer regardless. <strong>Not an enumeration defence</strong> — a 256-bit HMAC is not guessable, so there is nothing to enumerate.',
    },
    rl: '<code>unsub:&lt;ip&gt;</code> at <strong>120 / 15 min</strong>. Deliberately generous: an unsubscribe link is clicked by somebody who has just decided they are done with this sender, and a 429 at that moment is the worst possible answer. It exists only so an unauthenticated endpoint cannot be driven in a loop, and a corporate NAT unsubscribing en masse must stay comfortably under it.',
    errs: [[429, 'rate_limited', 'Carries <code>Retry-After</code>']],
    notes: [
      'Headers: <code>Cache-Control: no-store</code> and <code>X-Robots-Tag: noindex, nofollow</code>. The page names an email address, and <code>/api/public/*</code> is the one path prefix a shared cache has been told it MAY store — so without <code>no-store</code> a cache could hold the body of a URL that is, by construction, forwarded and clicked from mailboxes. <code>noindex</code> is the same reasoning one step further out: a link that reaches a crawler must not become a search result carrying somebody\'s address.',
      'Mounted <strong>above <code>sessionMiddleware</code></strong>, so <code>c.get(\'user\')</code> is undefined and this route cannot come to depend on who is signed in — the person clicking is, almost by definition, signed in to nothing.',
    ],
  },
  {
    surface: 'public',
    group: 'Unsubscribe',
    m: 'POST',
    p: '/api/public/unsubscribe',
    auth: 'public',
    src: 'server/routes/email.ts:826',
    sum: 'Actually opt out. No session, no account, no <code>Origin</code>.',
    query: [['token', 'As above — 64 lowercase hex characters.']],
    body: null,
    desc:
      '<strong>The one mutating route on this surface</strong>, and the reason the unsubscribe pair lives in its own router rather than inside the cacheable public one: a POST that flips a column has no business in a router whose entire design is "cannot vary by cookie, therefore may be cached".<br><br><strong>Mounted above the <code>Origin</code> guard, beside the payments webhook.</strong> The guard refuses any unsafe method without an allow-listed <code>Origin</code>, and this endpoint has two callers that cannot supply one: RFC 8058 one-click unsubscribe, which mail providers send as a server-to-server POST with no <code>Origin</code> at all, and any browser or link-scanning gateway that strips it. The exemption costs nothing an attacker can use — CSRF borrows a victim\'s <em>ambient</em> authority, their cookie, and this route reads no cookie, resolves no session and trusts nothing about the caller. Its entire authority is a 256-bit HMAC in the query string, which a cross-origin form post cannot produce; and anybody who already holds the token can call the endpoint directly, so the guard would protect nothing while breaking every real unsubscribe path.<br><br><strong>Idempotent, and a second click does not move the timestamp.</strong> The write is guarded by <code>unsubscribed_at IS NULL</code>: the date somebody opted out is a fact about them, and re-stamping it every time a mail client prefetches the link would make it the date of the last prefetch. The row comes back either way, so the page says "you are unsubscribed" whether this was the click that did it or the third.<br><br>The address is <em>not</em> deleted. It stays as a suppression row, which is what stops the next import silently re-subscribing them.',
    res: {
      200: 'HTML. The done page, naming the address.',
      404: 'HTML. The same "link not recognised" page the GET renders.',
    },
    rl: '<code>unsub:&lt;ip&gt;</code> at 120 / 15 min — the same bucket as the GET, so a confirm-then-submit costs two.',
    errs: [[429, 'rate_limited', 'Carries <code>Retry-After</code>']],
    notes: [
      'Accepts a plain form submission — no JSON body, no content type negotiation, no JavaScript. The token is read from the query string, exactly as the GET reads it.',
    ],
  },
];

import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { pathParam, readQuery, str, toResponse } from '../middleware/errors';
import { clientIp, limit } from '../middleware/ratelimit';
import { configuredOrigins } from '../middleware/origin';
import { NotFoundError, BadRequestError } from '../repo/errors';
import {
  MAX_SITEMAP_URLS,
  getPublicPostBySlug,
  listPublicPosts,
  publicCategories,
  publicFeedPosts,
  publicSitemapEntries,
  publicTags,
} from '../repo/public';
import type { PublicSitemapEntry, PublicTerm } from '../repo/public';
import { listPublicFeatured } from '../repo/featured';
import { getPublicImage } from '../repo/public-images';
import { R2NotConfiguredError, presignGet } from '../storage/r2';
import { currentDb } from '../app-env';
import type { AppEnv } from '../app-env';
import type { PublicPost } from '../../shared/types';

/**
 * The public reading API (plan Parts 2 and 4) — every route GET, unauthenticated
 * and cross-origin readable.
 *
 * THIS ROUTER IS MOUNTED ABOVE `sessionMiddleware` (plan D1, threat T6). Nothing
 * here may read a cookie, and the mount is what makes that structural rather
 * than conventional: `c.get('user')` is `undefined` on every request that
 * reaches this file, so a `Cache-Control: public` response is INCAPABLE of
 * varying by reader even if a later edit tries. See the comment at the mount in
 * `server/index.ts`.
 *
 * NOTHING IN THIS FILE DECIDES VISIBILITY. Every query goes through
 * `server/repo/public.ts`'s `PUBLIC_POST_PREDICATE` and every image through
 * `server/repo/public-images.ts`. The routes shape and cache; they do not
 * filter, and there is deliberately no way to spell `status` on the wire.
 *
 * IT IS A FACTORY, because the feed and the sitemap need the origin the APP was
 * constructed with. `originGuard` publishes that as `c.get('origins')` and this
 * router is mounted above it (deliberately — threat T6), so the value is not
 * reachable from a handler. Reading `configuredOrigins()` instead made the links
 * depend on the process environment rather than on `deps.origins`, which is
 * visible the moment an app is built with an explicit allow-list: the harness
 * passes `https://studio.test` and the feed emitted `http://localhost:5173`.
 * `createApp` hands them in instead.
 */

export interface PublicRouterDeps {
  /** Exact-match allow-list; the first entry is the feed's base URL. */
  origins?: readonly string[];
}

// --------------------------------------------------------------------- CORS

/**
 * `Access-Control-Allow-Origin: *`, and NEVER `Allow-Credentials` (plan D7).
 *
 * With `*` the credentials header is invalid anyway, and the combination is
 * exactly what turns a public read API into a session-riding one. It is never
 * set here, and the header the browser would need to send a cookie is therefore
 * never granted.
 *
 * SCOPED TO `/public/*`, NOT `'*'`. `app.route(API_PREFIX, routes)` flattens
 * this router into the parent, so `routes.use('*')` would become `/api/*` there
 * and would put a wildcard CORS header on the authenticated API — the precise
 * mistake `server/routes/posts.ts` documents for `requireAuth`.
 */
const CORS_HEADER = 'access-control-allow-origin';
const CORS_VALUE = '*';

/**
 * WITHOUT THESE TWO, THE CONDITIONAL-REQUEST WORK IS UNREACHABLE FROM A BROWSER.
 *
 * Cross-origin JavaScript can only read a response header that is on the
 * CORS-safelist or named in `Access-Control-Expose-Headers` — and `ETag` and
 * `Last-Modified` are on neither by default. So `fetch()` from another origin
 * got the validators, could not see them, and could never send them back.
 *
 * `If-None-Match` and `If-Modified-Since` are likewise NOT safelisted REQUEST
 * headers, so sending one triggers a preflight. This router answers only GET,
 * so an unrouted `OPTIONS` was a 404 and the real request never followed.
 *
 * curl, CDNs, crawlers and feed readers were unaffected throughout — none of
 * them enforce CORS. The gap was browsers only, which is exactly the client
 * that most needs revalidation to be cheap.
 */
const EXPOSED_HEADERS = 'ETag, Last-Modified, Retry-After';
const PREFLIGHT_HEADERS = 'If-None-Match, If-Modified-Since';

// ---------------------------------------------------------------- validators

/**
 * OPAQUE VALIDATORS — a SHA-256 prefix over the serialized public body (D6).
 *
 * NOT `revision`, and not any internal counter. `revision` is the autosave
 * counter the projection drops as internal state (D3/T4); re-emitting it as an
 * ETag would let an anonymous `curl -I` every 30 seconds report an author's
 * in-progress editing in near real time — at higher resolution than the
 * `updated` sort this surface removes for exactly that reason.
 *
 * A hash over the bytes we are about to send changes when, and only when, the
 * PUBLIC view changes, and says nothing else.
 */
function etagFor(body: string): string {
  return `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
}

/**
 * RFC 9110 `If-None-Match`, not string equality against one value.
 *
 * Three things a naive `header === etag` gets wrong, and all three are ordinary
 * traffic: a `W/` weak prefix (which every intermediary is allowed to add), a
 * comma-separated candidate list, and `*`.
 */
export function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  if (header.trim() === '*') return true;
  return header
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === etag);
}

/**
 * RFC 9110 `If-Modified-Since` — the header feed readers and crawlers actually
 * revalidate with, and which this surface previously honoured on no route.
 *
 * TRUNCATED TO WHOLE SECONDS ON BOTH SIDES. An HTTP-date has no sub-second
 * precision, so `Last-Modified` for `t = 1786519567813` is emitted as the second
 * `...67`, and comparing the client's echo of it against the raw millisecond
 * value makes every revalidation a spurious 200 — the exact failure the header
 * exists to avoid.
 *
 * AN UNPARSEABLE VALUE IS IGNORED, NOT AN ERROR (RFC 9110 §13.1.3): a
 * recipient that cannot read the date must behave as if the header were absent.
 */
export function ifModifiedSinceHits(
  header: string | undefined,
  lastModified: number | undefined,
): boolean {
  if (header === undefined || lastModified === undefined) return false;
  const since = Date.parse(header);
  if (Number.isNaN(since)) return false;
  return Math.floor(lastModified / 1000) <= Math.floor(since / 1000);
}

/**
 * The newest `updatedAt` in a result set, or `undefined` for an empty one.
 *
 * UNDEFINED RATHER THAN `Date.now()` OR THE EPOCH. A `Last-Modified` invented
 * for an empty collection is a lie a cache will act on; omitting the header
 * says only that we do not know, which is true.
 */
export function newestUpdatedAt(
  rows: readonly { updatedAt: number }[],
): number | undefined {
  let newest: number | undefined;
  for (const row of rows) {
    if (Number.isFinite(row.updatedAt) && (newest === undefined || row.updatedAt > newest)) {
      newest = row.updatedAt;
    }
  }
  return newest;
}

// ------------------------------------------------------------------- caching

/** Plan D6's table, in one place rather than spelled at each call site. */
export const CACHE = {
  list: 'public, s-maxage=60, stale-while-revalidate=300',
  /**
   * SHORT, because a full-text query is unbounded in cardinality: cached at the
   * list TTL it would pollute the edge with one entry per phrase anyone ever
   * typed, while also being the only rate-limited list path.
   */
  search: 'public, s-maxage=10',
  /**
   * ITS OWN ENTRY, NOT `list`, even though the numbers happen to match today.
   *
   * The storefront's contract asks for a separate cache identity for the rail
   * — it already gives the fetch its own Next.js tag — because curation changes
   * far less often than the post list, and sharing one means every publish
   * blows away the rail's cache. Sharing the CONSTANT is the same mistake one
   * level down: the first time either TTL should move, whoever moves it has to
   * notice that two unrelated surfaces are reading it.
   */
  featured: 'public, s-maxage=60, stale-while-revalidate=300',
  detail: 'public, s-maxage=300, stale-while-revalidate=3600',
  /**
   * A POSITIVE TTL ON A 404, deliberately. Detail reads carry no limiter, so
   * unknown-slug probing would otherwise reach Postgres on every request.
   */
  notFound: 'public, s-maxage=30',
  feed: 'public, s-maxage=600',
  /** The 302 embeds a five-minute credential; a cached one outlives it. */
  image: 'private, no-store',
} as const;

const JSON_TYPE = 'application/json; charset=UTF-8';
const RSS_TYPE = 'application/rss+xml; charset=UTF-8';
const XML_TYPE = 'application/xml; charset=UTF-8';

interface SendOptions {
  /** Epoch ms of the newest row in the answer; omitted for an empty set. */
  lastModified?: number;
  extra?: Record<string, string>;
}

/**
 * A cacheable public body, with its validators and its conditional answer.
 *
 * A `304` CARRIES THE VALIDATORS AND NO BODY. It also carries the same
 * `Cache-Control` and the same CORS header, so a revalidating client is told the
 * same caching story as a client that got the bytes.
 *
 * `If-None-Match` WINS WHEN BOTH ARE PRESENT (RFC 9110 §13.1.3). The entity tag
 * is the stronger validator and the date is then ignored entirely — not AND-ed,
 * not OR-ed: a client that sends a stale tag and a fresh date must get the
 * bytes.
 */
function send(
  c: { req: { header(name: string): string | undefined } },
  body: string,
  contentType: string,
  cacheControl: string,
  opts: SendOptions = {},
): Response {
  const etag = etagFor(body);
  const headers: Record<string, string> = {
    'cache-control': cacheControl,
    etag,
    [CORS_HEADER]: CORS_VALUE,
    ...(opts.extra ?? {}),
  };
  if (opts.lastModified !== undefined) {
    headers['last-modified'] = new Date(opts.lastModified).toUTCString();
  }

  const ifNoneMatch = c.req.header('if-none-match');
  const notModified =
    ifNoneMatch !== undefined
      ? ifNoneMatchHits(ifNoneMatch, etag)
      : ifModifiedSinceHits(c.req.header('if-modified-since'), opts.lastModified);
  if (notModified) return new Response(null, { status: 304, headers });

  return new Response(body, { status: 200, headers: { ...headers, 'content-type': contentType } });
}

// -------------------------------------------------------------- rate limiting

/**
 * ONE BUCKET, `public:<ip>`, SHARED BY THE TWO EXPENSIVE ROUTES (plan D8).
 *
 * The limiter writes a Postgres row per call, so putting it on the cheap,
 * edge-cacheable routes would make them the expensive ones. It is applied to
 * exactly two things: a list request carrying `search` (a full-text query the
 * public partial index does not serve) and the image route (a jsonb `EXISTS`
 * plus an R2 presign). Plain list, detail, feed and sitemap carry NO limiter and
 * are protected by `s-maxage` at the edge.
 *
 * One key means one bucket, which is what `public:<clientIp(c)>` says. The
 * number is generous for a page of images and useless as a loop.
 *
 * WHAT THIS TRUSTS: `clientIp` reads `x-real-ip`, so the bucket is only as
 * trustworthy as the edge in front of the function (documented in
 * `server/middleware/ratelimit.ts`, flagged in plan D8).
 */
export const PUBLIC_LIMIT = 300;
export const PUBLIC_LIMIT_WINDOW_MS = 60_000;

const publicLimit = (c: Parameters<typeof clientIp>[0]): Promise<void> =>
  limit(c, `public:${clientIp(c)}`, PUBLIC_LIMIT, PUBLIC_LIMIT_WINDOW_MS);

// --------------------------------------------------------------------- list

/**
 * STRICT, AND THERE IS NO WAY TO SPELL `status` (threat T1).
 *
 * An unknown key is a 400 rather than a silently ignored field — `?statuss=draft`
 * refused rather than answered — and the six keys below are the whole of what a
 * public caller may say. `sort` cannot name `updated` (it exposes editing
 * activity on published posts) or `drafts-first` (meaningless when every row is
 * published).
 */
const ListQuery = z
  .object({
    category: str().optional(),
    tag: str().optional(),
    search: str().optional(),
    cursor: str().optional(),
    /** `pageLimit` decides the range; this only makes `?limit=abc` a 400 here. */
    limit: z.coerce.number().int().optional(),
    sort: z.enum(['published', 'oldest', 'alphabetical']).optional(),
  })
  .strict();

// ------------------------------------------------------------------- detail

/**
 * ABSENT AND UNPUBLISHED ARE THE SAME 404, FROM THE SAME CODE PATH (T7).
 *
 * `getPublicPostBySlug` returns `null` for both, so there is no branch here that
 * could tell them apart, and this response is built in one place so the two
 * cannot drift into different bodies or different headers.
 *
 * Built here rather than thrown as `NotFoundError` for one reason: the thrown
 * form goes through `toResponse`, which builds a fresh `Response` and therefore
 * cannot carry D6's short positive `Cache-Control`. The body is spec §8's `gone`
 * either way.
 */
function detailNotFound(c: { get(key: 'requestId'): string | undefined }): Response {
  const requestId = c.get('requestId') ?? '';
  return new Response(JSON.stringify({ error: 'gone', requestId }), {
    status: 404,
    headers: {
      'content-type': JSON_TYPE,
      'cache-control': CACHE.notFound,
      [CORS_HEADER]: CORS_VALUE,
    },
  });
}

// ----------------------------------------------------------------- taxonomy

/** `{ value, count }` in the repo, `{ name, count }` on the wire. */
const toTerm = (term: PublicTerm) => ({ name: term.value, count: term.count });

// -------------------------------------------------------------- feed & sitemap

/**
 * CHARACTERS XML 1.0 FORBIDS OUTRIGHT, REMOVED — not escaped, because they
 * CANNOT be escaped.
 *
 * `&#11;` is as illegal as a raw U+000B: the production `Char` admits U+0009,
 * U+000A, U+000D and then nothing below U+0020, and a numeric reference to a
 * character outside `Char` is a well-formedness error in its own right. So the
 * only correct handling is removal.
 *
 * THE CONSEQUENCE IS TOTAL, NOT COSMETIC. `str()` rejects only U+0000, so a
 * writer pasting a title out of a PDF or a terminal can publish a vertical tab —
 * and one of those anywhere in the document makes EVERY published post vanish
 * from EVERY feed reader, because an XML parser must abort rather than recover.
 *
 * UNPAIRED SURROGATES AND U+FFFE/U+FFFF ARE THE SAME CLASS. A lone U+D800 is not
 * a character at all and cannot be encoded as UTF-8; the two noncharacters at
 * the end of the BMP are excluded from `Char` explicitly. `for…of` iterates by
 * code point, so a valid pair arrives as one value above U+FFFF and only a LONE
 * surrogate is ever seen in the D800–DFFF range.
 */
export function xmlSafe(value: string): string {
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0) as number;
    // The three legal whitespace controls, kept.
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) {
      out += ch;
      continue;
    }
    if (cp < 0x20) continue;
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (cp === 0xfffe || cp === 0xffff) continue;
    out += ch;
  }
  return out;
}

/**
 * The five predefined XML entities, and all five are needed — over text that has
 * first been stripped of everything XML cannot carry.
 *
 * STRIP BEFORE ESCAPE, and in this one function rather than at each call site:
 * every value that reaches `feed.xml` or `sitemap.xml` goes through here (title,
 * excerpt, category, every tag, the byline, the slug and every URL), so doing it
 * here is what makes the guarantee exhaustive rather than a checklist.
 *
 * `&` FIRST, or every escape this function just wrote gets escaped again. `'`
 * and `"` are included because these strings reach attribute positions
 * (`isPermaLink`, and any attribute a later edit adds) as well as text ones, and
 * a function that is only correct in text position is a function that will be
 * used in the other one.
 */
export function xmlEscape(value: string): string {
  return xmlSafe(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * The absolute origin the feed and sitemap build every link from.
 *
 * FAILS AS A 4xx RATHER THAN EMITTING RELATIVE URLs OR A 500 (plan, "known
 * risks"). A feed with relative `<link>`s is silently useless in every reader
 * and a sitemap with them is rejected by the protocol, so an unset allow-list
 * cannot be answered. It also cannot be a `500`: spec §8's client retries a 5xx
 * five times over ~30 seconds and nothing about a missing configuration changes
 * in that window — the same reasoning the image route states for
 * `R2NotConfiguredError`.
 *
 * The origins are the app's, handed to `createPublicRoutes` — NOT
 * `configuredOrigins()` read afresh, which ignored `deps.origins` entirely.
 */
export function baseUrl(origins: readonly string[]): string {
  const origin = origins[0];
  if (!origin) throw new BadRequestError('origins');
  return origin.replace(/\/+$/, '');
}

/** ONE definition of a post's public address, shared by the feed and the sitemap. */
export function publicPostUrl(base: string, slug: string): string {
  return `${base}/posts/${encodeURIComponent(slug)}`;
}

function feedXml(base: string, posts: readonly PublicPost[]): string {
  const items = posts
    .map((post) => {
      const url = publicPostUrl(base, post.slug);
      return [
        '    <item>',
        `      <title>${xmlEscape(post.title)}</title>`,
        `      <link>${xmlEscape(url)}</link>`,
        `      <guid isPermaLink="true">${xmlEscape(url)}</guid>`,
        `      <pubDate>${new Date(post.publishedAt).toUTCString()}</pubDate>`,
        `      <description>${xmlEscape(post.excerpt)}</description>`,
        // A byline and nothing else — never an id, never an email (T3).
        `      <dc:creator>${xmlEscape(post.author.name)}</dc:creator>`,
        ...post.tags.map((tag) => `      <category>${xmlEscape(tag)}</category>`),
        '    </item>',
      ].join('\n');
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    '  <channel>',
    `    <title>${xmlEscape(base)}</title>`,
    `    <link>${xmlEscape(base)}</link>`,
    '    <description>Published posts</description>',
    items,
    '  </channel>',
    '</rss>',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function sitemapXml(base: string, entries: readonly PublicSitemapEntry[]): string {
  const urls = entries
    .map((entry) =>
      [
        '  <url>',
        `    <loc>${xmlEscape(publicPostUrl(base, entry.slug))}</loc>`,
        `    <lastmod>${new Date(entry.updatedAt).toISOString()}</lastmod>`,
        '  </url>',
      ].join('\n'),
    )
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    /*
     * THE CAP IS SAID OUT LOUD WHEN IT IS REACHED. 50 000 is the sitemap
     * protocol's own ceiling; beyond it a sitemap index is required, and a route
     * that silently truncated would drop published posts out of every search
     * index with nothing anywhere to notice.
     */
    entries.length >= MAX_SITEMAP_URLS
      ? `  <!-- ${MAX_SITEMAP_URLS} URL cap reached: a sitemap index is required beyond this point -->`
      : '',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    '</urlset>',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

// ---------------------------------------------------------------- the router

export function createPublicRoutes(deps: PublicRouterDeps = {}): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  /*
   * RESOLVED PER REQUEST, NOT AT CONSTRUCTION. `configuredOrigins()` reads
   * `getEnv()`, and calling it here would demand a full environment merely to
   * build the app — the same defect `getEnv()` itself exists to avoid.
   */
  const origins = (): readonly string[] => deps.origins ?? configuredOrigins();

  routes.use('/public/*', async (c, next) => {
    await next();
    c.res.headers.set(CORS_HEADER, CORS_VALUE);
    c.res.headers.set('access-control-expose-headers', EXPOSED_HEADERS);
  });

  /*
   * THE PREFLIGHT, so a cross-origin `fetch` carrying `If-None-Match` can
   * actually reach the GET behind it. Answered here rather than by a CORS
   * library because the allow-list is a constant and there is nothing to
   * negotiate: this router serves GET, and only GET.
   *
   * `Allow-Credentials` is absent here too — a preflight is exactly where a
   * browser would ask for it, and the answer is the same no.
   */
  routes.on('OPTIONS', '/public/*', (c) =>
    c.body(null, 204, {
      [CORS_HEADER]: CORS_VALUE,
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': PREFLIGHT_HEADERS,
      'access-control-expose-headers': EXPOSED_HEADERS,
      'access-control-max-age': '86400',
    }),
  );

  /**
   * The CORS header on ERROR responses too, which the middleware above cannot do.
   *
   * `toResponse` builds a FRESH `Response` (see `server/middleware/errors.ts`), so
   * it inherits nothing a handler or a post-`next()` middleware set — and a thrown
   * error skips the line above entirely. Without this, a browser client sees an
   * opaque CORS failure instead of a readable 404 or 429, which is a worse outcome
   * than the error itself.
   *
   * Modelled on `server/shop/app.ts`: the BODY is still `toResponse`'s, so this is
   * not a fork of the spec §8 error table — it is the same rows with one header
   * added.
   */
  routes.onError((err, c) => {
    const res = toResponse(err, c.get('requestId') ?? '');
    res.headers.set(CORS_HEADER, CORS_VALUE);
    return res;
  });

  routes.get('/public/posts', async (c) => {
    const q = readQuery(c, ListQuery);
    const searching = (q.search ?? '').trim() !== '';
    // Limited BEFORE the query runs: the limiter's job is to make the expensive
    // statement unreachable, not to count one it has already granted.
    if (searching) await publicLimit(c);

    const page = await listPublicPosts(currentDb(c), q);
    return send(c, JSON.stringify(page), JSON_TYPE, searching ? CACHE.search : CACHE.list, {
      lastModified: newestUpdatedAt(page.items),
    });
  });

  /**
   * The curated rail (storefront contract, `packages/blog/src/data/posts.ts`).
   *
   * ═══ REGISTERED BEFORE `/public/posts/:slug`, AND THAT IS NOT COSMETIC ═══
   * Hono matches in registration order. Below the wildcard, every request for
   * this path is a lookup for a post slugged `featured` — a 404 indistinguishable
   * from the endpoint not existing, which is exactly the state the storefront
   * has been coping with. `featured.test.ts` pins the order, because moving one
   * of these two `routes.get` calls is a silent regression otherwise.
   *
   * THE COST, ACCEPTED: a post whose slug really is `featured` is unreachable at
   * its own public address. The path is the contract the storefront already
   * calls, so there is nothing to trade here.
   *
   * ═══ NO `Last-Modified` ═══
   * The same reasoning the taxonomies state, for a different reason. Curation
   * deliberately does not move `updated_at` (see `server/repo/featured.ts`), so
   * the newest `updated_at` among the four does not describe when this body last
   * changed. Emitting it would hand a client that sends only `If-Modified-Since`
   * a 304 for a rail that had been reordered — `send()` consults the date only
   * when `If-None-Match` is absent. The ETag is a hash of the bytes about to be
   * sent, so it moves on a reorder and is the right validator here.
   *
   * NO LIMITER. Like the plain list, detail, feed and sitemap: this is one
   * bounded, edge-cacheable query, and the limiter writes a Postgres row per
   * call, which would make the cheap route the expensive one.
   */
  routes.get('/public/posts/featured', async (c) => {
    const items = await listPublicFeatured(currentDb(c));
    return send(c, JSON.stringify({ items }), JSON_TYPE, CACHE.featured);
  });

  routes.get('/public/posts/:slug', async (c) => {
    // `pathParam`, so a NUL is a 400 and not a 500 — `server/nul-bytes.test.ts`
    // walks every registered route and requires it. A NUL byte is a malformed
    // request rather than a failed lookup, so this does not weaken T7.
    const slug = pathParam(c, 'slug');
    const post = await getPublicPostBySlug(currentDb(c), slug);
    if (!post) return detailNotFound(c);

    return send(c, JSON.stringify({ post }), JSON_TYPE, CACHE.detail, {
      lastModified: post.updatedAt,
    });
  });

  routes.get('/public/images/:id', async (c) => {
    const id = pathParam(c, 'id');
    await publicLimit(c);

    /*
     * ONE STATEMENT DECIDES ALL OF IT (see `getPublicImage`): unknown, uncommitted
     * and not-referenced-by-a-published-post are the same `null` from the same
     * code path. Revisions, drafts, archived and trashed posts are not references
     * — threat T5.
     */
    const image = await getPublicImage(currentDb(c), id);
    if (!image) throw new NotFoundError(id);

    let url: string;
    try {
      url = await presignGet(image.storageKey);
    } catch (err) {
      /*
       * A DEPLOYMENT WITH NO R2 IS A 4xx, NOT A 500. Spec §8's client retries 5xx
       * five times over ~30 seconds, and nothing about a missing bucket changes in
       * that window — the same reasoning `server/routes/images.ts#presignSlot`
       * states for the authenticated half. `detail` names what failed and never
       * why; `R2NotConfiguredError` deliberately carries no values.
       */
      if (err instanceof R2NotConfiguredError) throw new BadRequestError('storage');
      throw err;
    }

    c.header('cache-control', CACHE.image);
    c.header(CORS_HEADER, CORS_VALUE);
    return c.redirect(url, 302);
  });

  /*
   * NO `Last-Modified` ON THE TAXONOMIES. Neither query selects a timestamp —
   * they are `GROUP BY` aggregates — so there is no newest row to name, and
   * inventing one would be a date a cache acts on. `ETag` still serves them.
   */
  routes.get('/public/categories', async (c) => {
    const items = (await publicCategories(currentDb(c))).map(toTerm);
    return send(c, JSON.stringify({ items }), JSON_TYPE, CACHE.list);
  });

  routes.get('/public/tags', async (c) => {
    const items = (await publicTags(currentDb(c))).map(toTerm);
    return send(c, JSON.stringify({ items }), JSON_TYPE, CACHE.list);
  });

  routes.get('/public/feed.xml', async (c) => {
    const base = baseUrl(origins());
    const posts = await publicFeedPosts(currentDb(c));
    return send(c, feedXml(base, posts), RSS_TYPE, CACHE.feed, {
      lastModified: newestUpdatedAt(posts),
    });
  });

  routes.get('/public/sitemap.xml', async (c) => {
    const base = baseUrl(origins());
    const entries = await publicSitemapEntries(currentDb(c));
    return send(c, sitemapXml(base, entries), XML_TYPE, CACHE.feed, {
      lastModified: newestUpdatedAt(entries),
    });
  });

  return routes;
}

/**
 * The environment-configured router, for any caller that does not build an app.
 *
 * `createApp` does NOT use this — it passes its own `deps.origins`.
 */
export const routes = createPublicRoutes();

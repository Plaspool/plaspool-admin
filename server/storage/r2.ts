import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getEnv } from '../env';

/**
 * Cloudflare R2, reached through the S3 API.
 *
 * R2 is S3-compatible for exactly the six operations this module needs, which
 * is why `@aws-sdk/client-s3` is the client and not a Cloudflare SDK. Two
 * R2-specific details are load-bearing and are set once, here: the endpoint is
 * the account-scoped `https://<account>.r2.cloudflarestorage.com`, and the
 * region is the literal string `auto` (R2 has no regions, but SigV4 requires a
 * region in the credential scope, and R2 only accepts `auto` there).
 */

/** Spec §5.4: five minutes, on both directions. */
export const PRESIGN_TTL_SECONDS = 300;

export interface PresignedPut {
  url: string;
  /** Exactly the headers the client must send, and the ones the URL binds. */
  headers: Record<string, string>;
  expiresIn: number;
}

export interface ObjectHead {
  contentLength: number | null;
  contentType: string | null;
  etag: string | null;
}

/**
 * Built on first use, not at import.
 *
 * This is the same rule `getDb()` follows and it is here for the same reason:
 * `createApp(deps)` is a factory and its database handle is resolved lazily so
 * that a request which never touches a dependency cannot be 500'd by that
 * dependency's configuration being absent. A `new S3Client(...)` at module
 * scope would undo that for the whole server — `server/index.ts` imports the
 * route tree eagerly, so an instance deployed without R2 credentials would fail
 * to import and return 500 on `GET /api/posts`, a route with no relationship to
 * storage whatsoever. Deployments without media configured are a supported
 * state; every R2 env var is `.default('')` in `server/env.ts` precisely so
 * they boot.
 */
let client: S3Client | null = null;

interface R2Config {
  client: S3Client;
  bucket: string;
}

let bucket = '';

/**
 * Thrown when an R2 operation is attempted on an instance that has no R2
 * configuration. Names the missing variables and nothing else — the values are
 * secrets, and `server/env.ts` takes the same care for the same reason.
 */
export class R2NotConfiguredError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`R2 is not configured: ${missing.join(', ')}`);
    this.name = 'R2NotConfiguredError';
    this.missing = missing;
  }
}

function r2(): R2Config {
  if (client) return { client, bucket };

  const env = getEnv();
  const required = {
    R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
    R2_BUCKET: env.R2_BUCKET,
    R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => value.length === 0)
    .map(([name]) => name);
  // A distinct, named error rather than a client that constructs happily and
  // then produces a signature R2 rejects with an opaque 403 at upload time,
  // in the browser, where nobody can read it.
  if (missing.length > 0) throw new R2NotConfiguredError(missing);

  bucket = env.R2_BUCKET;
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    /**
     * Path style, and this is not cosmetic.
     *
     * The SDK defaults to virtual-hosted style, which rewrites the endpoint to
     * `<bucket>.<account>.r2.cloudflarestorage.com` — a hostname that does not
     * exist. R2 serves buckets under the account host at `/<bucket>/<key>`;
     * the per-bucket subdomain form is only available on a custom domain.
     * Measured here by `r2.test.ts`: without this, every presigned URL points
     * at a host that fails DNS resolution in the browser, and the failure
     * surfaces as an opaque network error on the client's PUT with nothing in
     * any server log, because the request never reaches a server.
     */
    forcePathStyle: true,
    /**
     * Without this, every presigned PUT this module issues is dead on arrival.
     *
     * The SDK's default is `WHEN_SUPPORTED`, which computes a CRC32 of the
     * request body and sends it as `x-amz-checksum-crc32`. The presigner has no
     * body — so it checksums ZERO bytes, gets `AAAAAA==`, and bakes that plus
     * `x-amz-sdk-checksum-algorithm=CRC32` into the SIGNED query string. The
     * URL therefore demands that the uploaded object have the CRC32 of an empty
     * file. Any real image has a different one, so R2 rejects the PUT, and it
     * rejects it in the browser against a URL the server generated — the exact
     * unreadable failure the `forcePathStyle` note above is about.
     *
     * `WHEN_REQUIRED` drops both query parameters (S3 requires a checksum only
     * for a handful of operations, none of them this one) and leaves the signed
     * header set untouched. Pinned by `r2.test.ts`, which asserts the ABSENCE
     * of any `x-amz-checksum*` / `x-amz-sdk-checksum*` parameter, because a
     * default that changes under a minor SDK bump would otherwise reappear
     * silently.
     */
    requestChecksumCalculation: 'WHEN_REQUIRED',
    /**
     * The same default in the read direction: it adds a signed
     * `x-amz-checksum-mode=ENABLED` to every presigned GET. That URL is handed
     * to a browser `<img>` tag by the `GET /api/images/:id` redirect, which
     * cannot act on a checksum trailer and has no use for one — so it is a
     * signed parameter with no purpose, riding on a URL served to third
     * parties, that R2 is free to be stricter about than S3.
     */
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
  return { client, bucket };
}

/**
 * Drop the memoised client.
 *
 * Exists for tests, which need to sign under more than one set of credentials
 * in one process to prove that (a) nothing is constructed until first use and
 * (b) a missing variable is reported rather than silently signed around. It is
 * exported rather than reached into because the alternative — a test poking
 * module internals — breaks on any refactor.
 */
export function resetR2ClientForTests(): void {
  client = null;
  bucket = '';
}

// ---------------------------------------------------------------- presigning

/**
 * A presigned `PUT` that is bound to this content type and this exact byte
 * count.
 *
 * `signableHeaders` is passed explicitly and that is the entire point of this
 * function. Left to the default, the signature covers `host` and (because
 * `ContentLength` is set) `content-length` — but NOT `content-type`, so the
 * client can `PUT` `text/html` to a URL that was authorised for a PNG, and a
 * client that then never calls commit is never magic-byte checked at all. The
 * object sits in the bucket typed as whatever the uploader chose.
 *
 * What the explicit set buys, precisely: the two values below are inputs to the
 * signature, so changing either one invalidates the URL. That is a stronger
 * statement than "the header appears in `X-Amz-SignedHeaders`", and it is the
 * property `r2.test.ts` asserts, because the header list alone would still pass
 * if the SDK listed a header it did not actually bind.
 *
 * Do not "simplify" this by dropping the set because the signed-headers list
 * looks right without it — measured on the installed SDK, the default list
 * already contains `content-length`, and only `content-type` is missing.
 */
export async function presignPut(
  key: string,
  contentType: string,
  byteSize: number,
): Promise<PresignedPut> {
  const { client: s3, bucket: name } = r2();
  const command = new PutObjectCommand({
    Bucket: name,
    Key: key,
    ContentType: contentType,
    ContentLength: byteSize,
  });
  const url = await getSignedUrl(s3, command, {
    expiresIn: PRESIGN_TTL_SECONDS,
    signableHeaders: new Set(['content-type', 'content-length']),
  });
  return {
    url,
    // Returned rather than left to the client to reconstruct: these must match
    // the signed values byte for byte or R2 answers 403, and the failure is
    // indistinguishable from an expired URL from the browser's side.
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(byteSize),
    },
    expiresIn: PRESIGN_TTL_SECONDS,
  };
}

/**
 * A five-minute signed `GET`, which `GET /api/images/:id` redirects to.
 *
 * No `signableHeaders` here, deliberately: a download has no request headers
 * worth binding, and binding one would force every reader — including an
 * `<img>` tag, which sets its own headers and cannot be told otherwise — to
 * reproduce it exactly.
 */
export async function presignGet(key: string): Promise<string> {
  const { client: s3, bucket: name } = r2();
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: name, Key: key }), {
    expiresIn: PRESIGN_TTL_SECONDS,
  });
}

// ---------------------------------------------------------------- object ops

/**
 * Metadata for an object, or `null` if it is not there.
 *
 * The absent case is `null` and not a throw because the caller — commit —
 * treats "the client never uploaded" as an ordinary outcome with a 4xx answer,
 * not as an error. The SDK signals it as an exception with `name` of
 * `NotFound`/`NoSuchKey`, or an HTTP 404 on the metadata; all three spellings
 * are matched because which one arrives depends on the operation and R2 does
 * not always send a parseable error body for a `HEAD`.
 */
export async function headObject(key: string): Promise<ObjectHead | null> {
  const { client: s3, bucket: name } = r2();
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: name, Key: key }));
    return {
      contentLength: res.ContentLength ?? null,
      contentType: res.ContentType ?? null,
      etag: res.ETag ?? null,
    };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: number } };
  if (e?.$metadata?.httpStatusCode === 404) return true;
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey';
}

/**
 * The first `length` bytes of an object, or `null` if it is not there.
 *
 * A ranged GET and not a full one: the commit path only needs enough of the
 * head to sniff and to read dimensions, and downloading a 12 MB object into a
 * serverless function to look at 24 bytes of it is both the memory ceiling and
 * the request timeout. The `Range` header is inclusive at both ends, hence
 * `length - 1`.
 *
 * The returned array can be SHORTER than `length` — an object smaller than the
 * requested range is not an error, and every reader in `magic.ts` is written to
 * tolerate a short buffer for exactly this reason.
 */
export async function getRange(key: string, length: number): Promise<Uint8Array | null> {
  const { client: s3, bucket: name } = r2();
  try {
    const res = await s3.send(
      new GetObjectCommand({
        Bucket: name,
        Key: key,
        Range: `bytes=0-${Math.max(0, length - 1)}`,
      }),
    );
    if (!res.Body) return null;
    return await res.Body.transformToByteArray();
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Remove an object. Absent is success — the callers are the reject-and-delete
 * path and orphan collection, and both are re-runnable by design, so a second
 * delete of the same key must not become an error that aborts a sweep partway.
 */
export async function deleteObject(key: string): Promise<void> {
  const { client: s3, bucket: name } = r2();
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: name, Key: key }));
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
}

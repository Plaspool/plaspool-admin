import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * No network anywhere in this file.
 *
 * Presigning is pure: SigV4 over a canonical request, computed locally. That
 * makes the interesting property — WHAT the signature covers — testable without
 * a bucket, which is the only way this can be a gate that runs on every commit.
 * `headObject`/`getRange`/`deleteObject` do talk to R2 and are exercised for
 * their configuration behaviour only; their success paths belong to Task 16's
 * route tests, which stub the module.
 */

const R2_ENV = {
  R2_ACCOUNT_ID: 'acct1234567890abcdef',
  R2_BUCKET: 'studio-media',
  R2_ACCESS_KEY_ID: 'AKIAEXAMPLEKEYID0000',
  R2_SECRET_ACCESS_KEY: 'wJalrXUtnFEMIexampleKEY0000000000000000000',
};

/**
 * `getEnv()` memoises the parsed environment at module scope, so a test that
 * mutates `process.env` after another test has already read it changes nothing.
 * Resetting the module registry and importing fresh is what makes the "not
 * configured" case reachable in the same process as the configured one.
 */
async function loadR2(env: Partial<typeof R2_ENV> = R2_ENV) {
  vi.resetModules();
  for (const key of Object.keys(R2_ENV)) delete process.env[key];
  Object.assign(process.env, env);
  return import('./r2');
}

/**
 * The SDK module from the SAME registry generation as the `r2` module under
 * test, so a spy on `S3Client.prototype.send` intercepts the very calls it
 * makes. Imported after `loadR2` and never at the top of the file: a top-level
 * import belongs to the pre-reset generation and the spy would land on a class
 * nothing uses.
 */
async function loadSdk() {
  return import('@aws-sdk/client-s3');
}

/** Query parameters of a presigned URL, as a plain map. */
function query(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams);
}

beforeEach(() => {
  // A fixed clock. SigV4 mixes `X-Amz-Date` into the string-to-sign, so two
  // signings a second apart differ for a reason that has nothing to do with the
  // headers — which would make "the signature changed" prove nothing at all.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-11T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  for (const key of Object.keys(R2_ENV)) delete process.env[key];
});

describe('lazy construction', () => {
  it('imports cleanly with no R2 environment at all', async () => {
    // The requirement this pins: nothing is constructed at import time. The
    // route tree is imported eagerly by `server/index.ts`, so a client built at
    // module scope would turn a media-less deployment into a server that 500s
    // on `GET /api/posts` — a route with no relationship to storage.
    const r2 = await loadR2({});
    expect(typeof r2.presignPut).toBe('function');
  });

  it('names the missing variables when an operation is actually attempted', async () => {
    const r2 = await loadR2({ R2_ACCOUNT_ID: 'acct', R2_BUCKET: 'b' });
    await expect(r2.presignPut('k', 'image/png', 1)).rejects.toMatchObject({
      name: 'R2NotConfiguredError',
      missing: ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'],
    });
  });

  it('never puts a secret in the error message', async () => {
    const r2 = await loadR2({ ...R2_ENV, R2_SECRET_ACCESS_KEY: '' });
    const err = await r2.presignPut('k', 'image/png', 1).catch((e: Error) => e);
    expect(String(err)).toContain('R2_SECRET_ACCESS_KEY');
    expect(String(err)).not.toContain(R2_ENV.R2_ACCESS_KEY_ID);
  });

  it('does not rebuild the client on every call', async () => {
    const r2 = await loadR2();
    const first = await r2.presignPut('a', 'image/png', 1);
    // Same clock, same inputs, same key: a memoised client and a fresh one both
    // sign identically, so what this really pins is that the second call works
    // at all after the first has cached.
    const second = await r2.presignPut('a', 'image/png', 1);
    expect(query(second.url)['X-Amz-Signature']).toBe(query(first.url)['X-Amz-Signature']);
  });
});

describe('presignPut', () => {
  it('targets the account-scoped R2 endpoint with region auto', async () => {
    const r2 = await loadR2();
    const { url } = await r2.presignPut('images/abc.png', 'image/png', 100);
    const parsed = new URL(url);
    expect(parsed.host).toBe(`${R2_ENV.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    expect(parsed.pathname).toBe('/studio-media/images/abc.png');
    // The credential scope carries the region; R2 accepts only `auto` there.
    expect(query(url)['X-Amz-Credential']).toContain('/auto/s3/aws4_request');
  });

  it('signs content-type AND content-length, not just host', async () => {
    const r2 = await loadR2();
    const { url } = await r2.presignPut('images/abc.png', 'image/png', 100);
    expect(query(url)['X-Amz-SignedHeaders']).toBe('content-length;content-type;host');
  });

  it('expires in five minutes', async () => {
    const r2 = await loadR2();
    const put = await r2.presignPut('images/abc.png', 'image/png', 100);
    expect(query(put.url)['X-Amz-Expires']).toBe('300');
    expect(put.expiresIn).toBe(300);
  });

  it('returns the exact headers the client must send', async () => {
    const r2 = await loadR2();
    const put = await r2.presignPut('images/abc.png', 'image/webp', 4096);
    expect(put.headers).toEqual({ 'Content-Type': 'image/webp', 'Content-Length': '4096' });
  });

  describe('the signature is BOUND to both values, not merely listing them', () => {
    /**
     * The header list alone is not the property worth testing: an SDK could
     * name a header in `X-Amz-SignedHeaders` and not fold it into the
     * string-to-sign, and the test would still pass while the URL accepted
     * anything. What actually stops a client PUTting `text/html` at 5 GB to a
     * URL authorised for a 2 MB PNG is that changing either value produces a
     * different signature — so R2 rejects the mismatched request. That is what
     * these three assertions measure, at a frozen clock so the signature can
     * only differ for the reason under test.
     */
    const sign = async (contentType: string, byteSize: number) => {
      const r2 = await loadR2();
      const { url } = await r2.presignPut('images/abc.png', contentType, byteSize);
      return query(url)['X-Amz-Signature'];
    };

    it('changes when the content type changes', async () => {
      expect(await sign('image/png', 2048)).not.toBe(await sign('text/html', 2048));
    });

    it('changes when the byte size changes', async () => {
      expect(await sign('image/png', 2048)).not.toBe(await sign('image/png', 5_000_000_000));
    });

    it('is stable for identical inputs, so the two above cannot pass by accident', async () => {
      expect(await sign('image/png', 2048)).toBe(await sign('image/png', 2048));
    });
  });
});

describe('the signed query carries no body checksum', () => {
  it('omits x-amz-checksum-crc32 and x-amz-sdk-checksum-algorithm', async () => {
    /**
     * The finding this pins, and it made every presigned PUT unusable.
     *
     * The SDK's default `requestChecksumCalculation: WHEN_SUPPORTED` CRC32s the
     * request body. The presigner has no body, so it signed the CRC32 of ZERO
     * bytes — `AAAAAA==` — into the query string. The URL then demanded that
     * the uploaded object be empty, and R2 rejected every real image with a
     * 4xx in the browser that no server log ever saw.
     *
     * Asserted as an absence, and by prefix rather than by name, because the
     * parameter set is chosen by an SDK default that can come back under a
     * minor version bump, in a form spelled slightly differently.
     */
    const r2 = await loadR2();
    const { url } = await r2.presignPut('images/abc.png', 'image/png', 2048);
    const offending = Object.keys(query(url)).filter((k) =>
      /checksum/i.test(k),
    );
    expect(offending).toEqual([]);
    // …and the fix must not have cost the header binding.
    expect(query(url)['X-Amz-SignedHeaders']).toBe('content-length;content-type;host');
  });

  it('leaves the GET query free of them too', async () => {
    const r2 = await loadR2();
    const url = await r2.presignGet('images/abc.png');
    expect(Object.keys(query(url)).filter((k) => /checksum/i.test(k))).toEqual([]);
  });
});

describe('SigV4 recomputed locally', () => {
  /**
   * A real verifier, not a difference test.
   *
   * "The signature changed when the content type changed" is necessary but not
   * sufficient: it would pass just as well if the SDK folded the value into the
   * canonical QUERY string and left the header unbound, in which case a client
   * could still send whatever `Content-Type` it liked. Rebuilding the canonical
   * request by hand — with the two header values in the canonical headers
   * block — and arriving at the same signature the SDK produced is what proves
   * the values are bound THROUGH THE HEADERS, which is what R2 will check.
   */
  const rfc3986 = (s: string) =>
    encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

  async function recompute(url: string, headers: Record<string, string>): Promise<string> {
    const { createHash, createHmac } = await import('node:crypto');
    const parsed = new URL(url);
    const params = [...parsed.searchParams.entries()].filter(([k]) => k !== 'X-Amz-Signature');
    const canonicalQuery = params
      .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');

    const signed = parsed.searchParams.get('X-Amz-SignedHeaders')!;
    const all: Record<string, string> = { ...headers, host: parsed.host };
    const canonicalHeaders = signed
      .split(';')
      .map((name) => `${name}:${all[name].trim()}\n`)
      .join('');

    const canonicalRequest = [
      'PUT',
      parsed.pathname,
      canonicalQuery,
      canonicalHeaders,
      signed,
      // S3 presigning signs an unknown body.
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const amzDate = parsed.searchParams.get('X-Amz-Date')!;
    const scope = parsed.searchParams.get('X-Amz-Credential')!.split('/').slice(1).join('/');
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    const hmac = (key: Buffer | string, data: string) =>
      createHmac('sha256', key).update(data).digest();
    let key: Buffer | string = `AWS4${R2_ENV.R2_SECRET_ACCESS_KEY}`;
    for (const part of scope.split('/')) key = hmac(key, part);
    return createHmac('sha256', key).update(stringToSign).digest('hex');
  }

  it('reproduces the SDK signature with content-type and content-length in the canonical headers', async () => {
    const r2 = await loadR2();
    const put = await r2.presignPut('images/abc.png', 'image/png', 2048);
    const mine = await recompute(put.url, {
      'content-type': 'image/png',
      'content-length': '2048',
    });
    expect(mine).toBe(query(put.url)['X-Amz-Signature']);
  });

  it('does NOT reproduce it when the client substitutes another content type', async () => {
    // i.e. R2 will reject `text/html` against this URL. This is the property
    // the whole `signableHeaders` argument exists to create.
    const r2 = await loadR2();
    const put = await r2.presignPut('images/abc.png', 'image/png', 2048);
    const forged = await recompute(put.url, {
      'content-type': 'text/html',
      'content-length': '2048',
    });
    expect(forged).not.toBe(query(put.url)['X-Amz-Signature']);
  });

  it('does NOT reproduce it when the client substitutes another content length', async () => {
    const r2 = await loadR2();
    const put = await r2.presignPut('images/abc.png', 'image/png', 2048);
    const forged = await recompute(put.url, {
      'content-type': 'image/png',
      'content-length': '5000000000',
    });
    expect(forged).not.toBe(query(put.url)['X-Amz-Signature']);
  });
});

describe('presignGet', () => {
  it('signs a five-minute GET bound to host only', async () => {
    const r2 = await loadR2();
    const url = await r2.presignGet('images/abc.png');
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/studio-media/images/abc.png');
    // Deliberately host-only: an `<img>` tag sets its own request headers and
    // cannot be made to reproduce a bound one, so binding anything else here
    // would break the read path the redirect exists for.
    expect(query(url)['X-Amz-SignedHeaders']).toBe('host');
    expect(query(url)['X-Amz-Expires']).toBe('300');
  });

  it('encodes a key with characters that need escaping', async () => {
    const r2 = await loadR2();
    const url = await r2.presignGet('images/a b+c.png');
    expect(new URL(url).pathname).toBe('/studio-media/images/a%20b%2Bc.png');
  });
});

describe('object operations', () => {
  /**
   * `S3Client.prototype.send` is stubbed rather than the network. What is worth
   * testing here is what this module ASKS for and how it interprets the answer;
   * everything below that is the SDK's own contract and R2's.
   */
  async function withStub(reply: (command: unknown) => unknown) {
    const r2 = await loadR2();
    const { S3Client } = await loadSdk();
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockImplementation(async (command: unknown) => reply(command) as never);
    return { r2, send };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getRange asks for a bounded Range, not the whole object', async () => {
    // Without the header the SDK happily fetches all 12 MB into a serverless
    // function to look at the first 24 bytes of it — the memory ceiling and the
    // request timeout, on the commit path, for every upload.
    const { r2, send } = await withStub(() => ({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
    }));
    const bytes = await r2.getRange('images/abc.png', 65536);
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    const input = (send.mock.calls[0][0] as unknown as { input: Record<string, unknown> }).input;
    expect(input.Range).toBe('bytes=0-65535');
    expect(input.Key).toBe('images/abc.png');
    expect(input.Bucket).toBe('studio-media');
  });

  it.each([
    ['a NotFound name', { name: 'NotFound', $metadata: {} }],
    ['a NoSuchKey name', { name: 'NoSuchKey', $metadata: {} }],
    ['an HTTP 404', { name: 'Whatever', $metadata: { httpStatusCode: 404 } }],
  ])('headObject reports %s as absent', async (_label, err) => {
    const { r2 } = await withStub(() => {
      throw Object.assign(new Error('nope'), err);
    });
    await expect(r2.headObject('k')).resolves.toBeNull();
  });

  it.each([
    ['a 403', { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }],
    ['a 500', { name: 'InternalError', $metadata: { httpStatusCode: 500 } }],
    ['a socket failure', { name: 'TimeoutError', $metadata: {} }],
  ])('headObject PROPAGATES %s instead of calling it absent', async (_label, err) => {
    // The one that matters most on the commit path: swallowing every failure as
    // "the object is not there" turns an R2 outage or a credential problem into
    // a rejection, and the rejection path DELETES the row and the object. A
    // writer's valid upload is destroyed because the storage backend hiccuped.
    const { r2 } = await withStub(() => {
      throw Object.assign(new Error('boom'), err);
    });
    await expect(r2.headObject('k')).rejects.toThrow('boom');
    await expect(r2.getRange('k', 16)).rejects.toThrow('boom');
    await expect(r2.deleteObject('k')).rejects.toThrow('boom');
  });

  it('headObject maps the fields the commit path reads', async () => {
    const { r2 } = await withStub(() => ({
      ContentLength: 4096,
      ContentType: 'image/png',
      ETag: '"abc"',
    }));
    await expect(r2.headObject('k')).resolves.toEqual({
      contentLength: 4096,
      contentType: 'image/png',
      etag: '"abc"',
    });
  });

  it('deleteObject treats an already-absent object as success', async () => {
    // Both callers — reject-and-delete and orphan collection — are re-runnable
    // by design, so a second delete must not abort a sweep partway through.
    const { r2 } = await withStub(() => {
      throw Object.assign(new Error('gone'), { name: 'NoSuchKey', $metadata: {} });
    });
    await expect(r2.deleteObject('k')).resolves.toBeUndefined();
  });
});

describe('object operations require configuration too', () => {
  it.each(['headObject', 'getRange', 'deleteObject'] as const)(
    '%s reports the missing configuration instead of dialling out',
    async (name) => {
      const r2 = await loadR2({});
      const call =
        name === 'getRange' ? r2.getRange('k', 16) : (r2[name] as (k: string) => Promise<unknown>)('k');
      await expect(call).rejects.toMatchObject({ name: 'R2NotConfiguredError' });
    },
  );
});

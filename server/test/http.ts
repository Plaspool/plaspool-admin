import { createApp } from '../index';
import type { AppDeps } from '../index';
import type { Db } from '../db/client';

/**
 * A client that drives the REAL app through `app.request()`.
 *
 * Route suites must go through the whole stack — router, origin guard, session
 * middleware, error handler — because the seam between the repository and HTTP
 * is what these tasks add and therefore where their defects are. Calling a repo
 * function directly proves the repo, which `server/repo/*.test.ts` already
 * does.
 *
 * TWO THINGS THIS CARRIES SO EVERY SUITE DOES NOT.
 *
 * **A cookie jar.** `app.request()` is `fetch`, not a browser: it neither
 * stores `Set-Cookie` nor sends `Cookie` back. Without a jar every test would
 * hand-copy a session token, and the one property most worth testing — that the
 * cookie the server sets is the cookie the server accepts — would be asserted
 * nowhere.
 *
 * **The `Origin` header.** Every unsafe method is refused without one (spec
 * §6), so a helper that omitted it would make every mutation test a 403 and
 * every author of one reach for a workaround.
 */

/** The allow-listed origin every suite mutates from. */
export const TEST_ORIGIN = 'https://studio.test';

export interface HttpClient {
  /** The app under test, for anything the helpers below do not cover. */
  app: ReturnType<typeof createApp>;
  request(path: string, init?: RequestInit): Promise<Response>;
  get(path: string, init?: RequestInit): Promise<Response>;
  post(path: string, body?: unknown, init?: RequestInit): Promise<Response>;
  patch(path: string, body?: unknown, init?: RequestInit): Promise<Response>;
  put(path: string, body?: unknown, init?: RequestInit): Promise<Response>;
  del(path: string, init?: RequestInit): Promise<Response>;
  /** Everything currently in the jar, as it would be sent. */
  cookies(): Map<string, string>;
  /** Forget every cookie — a fresh browser, not a logout. */
  clearCookies(): void;
}

/**
 * Parse one `Set-Cookie` into name, value and whether it is an expiry.
 *
 * `Max-Age=0` is how `deleteCookie` clears one, and a jar that stored it as an
 * ordinary value would keep sending a dead token — which would make a logout
 * test pass while logout was broken.
 */
function parseSetCookie(header: string): { name: string; value: string; expired: boolean } {
  const [pair, ...attrs] = header.split(';');
  const eq = pair.indexOf('=');
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  const maxAge = attrs
    .map((a) => a.trim())
    .find((a) => a.toLowerCase().startsWith('max-age='));
  const expired = value === '' || (maxAge !== undefined && Number(maxAge.slice(8)) <= 0);
  return { name, value, expired };
}

export function httpClient(db: Db, deps: Partial<AppDeps> = {}): HttpClient {
  const app = createApp({ db, origins: [TEST_ORIGIN], ...deps });
  const jar = new Map<string, string>();

  const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (jar.size > 0 && !headers.has('cookie')) {
      headers.set(
        'cookie',
        [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
      );
    }
    const method = (init.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && !headers.has('origin')) {
      headers.set('origin', TEST_ORIGIN);
    }

    const res = await app.request(path, { ...init, headers });

    for (const header of res.headers.getSetCookie()) {
      const { name, value, expired } = parseSetCookie(header);
      if (expired) jar.delete(name);
      else jar.set(name, value);
    }
    return res;
  };

  const withBody = (method: string) => async (
    path: string,
    body?: unknown,
    init: RequestInit = {},
  ) => {
    const headers = new Headers(init.headers);
    const hasBody = body !== undefined;
    if (hasBody && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    return request(path, {
      ...init,
      method,
      headers,
      body: hasBody ? JSON.stringify(body) : undefined,
    });
  };

  return {
    app,
    request,
    get: (path, init = {}) => request(path, { ...init, method: 'GET' }),
    post: withBody('POST'),
    patch: withBody('PATCH'),
    put: withBody('PUT'),
    del: (path, init = {}) => request(path, { ...init, method: 'DELETE' }),
    cookies: () => new Map(jar),
    clearCookies: () => jar.clear(),
  };
}

/** The JSON body, typed at the call site. Fails loudly on a non-JSON body. */
export async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`expected JSON, got ${res.status}: ${text.slice(0, 200)}`);
  }
}

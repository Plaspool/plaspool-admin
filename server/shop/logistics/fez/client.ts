import type { FezEnv } from '../config';
import { LogisticsError } from '../port';

export interface FezClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Injectable clock for the token cache's expiry check. Defaults to the wall clock. */
  now?: () => number;
}

interface Token {
  value: string;
  expiresAt: number;
  /** `orgDetails['secret-key']`, learned only from a real sign-in. */
  secretKey: string | null;
}

/**
 * Every network call the Fez adapter makes goes through here. Every failure
 * leaves as a `LogisticsError` — never a raw `fetch` rejection, never a bare
 * provider JSON body — so `adapter.ts` never has to know what a Fez failure
 * looks like on the wire.
 *
 * NEITHER THE PASSWORD NOR THE TOKEN IS EVER PUT IN A THROWN MESSAGE. The
 * classified messages below are Fez's own `description`/`message` about OUR
 * request (`describe()`), which is safe to show an admin; our credentials
 * never appear in a URL, a log line, or an error.
 */
export class FezClient {
  readonly #env: FezEnv;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;
  readonly #now: () => number;
  #token: Token | null = null;

  constructor(env: FezEnv, opts: FezClientOptions = {}) {
    this.#env = env;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeout = opts.timeoutMs ?? 8_000;
    this.#now = opts.now ?? (() => Date.now());
  }

  /** The header value the next authenticated call would send — env first, then the org's own key from sign-in. */
  get secretKey(): string | null {
    return this.#env.secretKey ?? this.#token?.secretKey ?? null;
  }

  async #raw(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<{ status: number; json: Record<string, unknown> | null }> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#env.baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeout),
      });
    } catch (err) {
      // TimeoutError/AbortError from AbortSignal.timeout, or a network failure —
      // both are "we don't know what happened", never a plain rejection.
      const name = err instanceof Error ? err.name : '';
      throw new LogisticsError(
        'provider_unavailable',
        name === 'TimeoutError' || name === 'AbortError' ? 'Fez Delivery timed out' : 'Fez Delivery could not be reached',
      );
    }
    let json: Record<string, unknown> | null = null;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  async #authenticate(): Promise<Token> {
    const { status, json } = await this.#raw(
      'POST',
      '/user/authenticate',
      { user_id: this.#env.userId, password: this.#env.password },
      {},
    );
    const auth = json?.authDetails as Record<string, unknown> | undefined;
    const token = typeof auth?.authToken === 'string' ? auth.authToken : null;
    if (status >= 500) throw new LogisticsError('provider_unavailable', 'Fez Delivery sign-in is unavailable', { status });
    if (!token) {
      throw new LogisticsError(
        status === 401 || status === 400 ? 'provider_rejected' : 'bad_response',
        describe(json) ?? 'Fez Delivery refused the sign-in',
        { status },
      );
    }
    const org = json?.orgDetails as Record<string, unknown> | undefined;
    // `expireToken` is `YYYY-MM-DD HH:mm:ss` in Lagos time (UTC+1, no DST).
    const expires = typeof auth?.expireToken === 'string' ? Date.parse(auth.expireToken.replace(' ', 'T') + '+01:00') : NaN;
    // Capped at 12h regardless of what Fez claims, so a token cannot outlive a
    // deploy's expectation of "this gets renewed roughly daily" by accident.
    const cap = this.#now() + 12 * 3_600_000;
    const expiresAt = Number.isFinite(expires) ? Math.min(expires - 5 * 60_000, cap) : cap;
    this.#token = {
      value: token,
      expiresAt,
      secretKey: typeof org?.['secret-key'] === 'string' ? (org['secret-key'] as string) : null,
    };
    return this.#token;
  }

  async #bearer(): Promise<Token> {
    if (this.#token && this.#token.expiresAt > this.#now()) return this.#token;
    return this.#authenticate();
  }

  /** An authenticated call. Re-authenticates ONCE on a 401 and retries; a second 401 is a `provider_rejected`. */
  async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Record<string, unknown>> {
    let token = await this.#bearer();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const key = this.secretKey;
      if (!key) throw new LogisticsError('not_configured', 'Fez Delivery secret key is missing');
      const { status, json } = await this.#raw(method, path, body, {
        authorization: `Bearer ${token.value}`,
        'secret-key': key,
      });
      if (status === 401 && attempt === 0) {
        token = await this.#authenticate();
        continue;
      }
      if (status >= 500) throw new LogisticsError('provider_unavailable', describe(json) ?? 'Fez Delivery is unavailable', { status });
      if (status >= 400 || (json && json.status === 'Error')) {
        throw new LogisticsError('provider_rejected', describe(json) ?? `Fez Delivery refused the request (${status})`, { status, detail: json });
      }
      if (!json) throw new LogisticsError('bad_response', 'Fez Delivery answered with no JSON', { status });
      return json;
    }
    /* Unreachable in practice — the loop's second iteration always returns or
       throws above — kept as the honest fallback if that ever stops being true. */
    throw new LogisticsError('provider_rejected', 'Fez Delivery rejected the credentials twice', { status: 401 });
  }
}

/** Fez's own `description`/`message` about a request, or null if it said nothing usable. */
export function describe(json: Record<string, unknown> | null): string | null {
  const d = json?.description ?? json?.message;
  return typeof d === 'string' && d.trim() !== '' ? d : null;
}

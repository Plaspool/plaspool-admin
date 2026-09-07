import type { TerminalEnv } from '../config';
import { LogisticsError } from '../port';

export interface TerminalClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Injectable clock, kept for parity with `FezClientOptions` and with
   * `createTerminalProvider`'s documented `opts` shape. `TerminalClient` has
   * no token cache to expire — Terminal authenticates every call with the
   * same static secret key — so nothing here reads it today.
   */
  now?: () => number;
}

/**
 * Every network call the Terminal adapter makes goes through here. Every
 * failure leaves as a `LogisticsError` — never a raw `fetch` rejection, never
 * a bare provider JSON body — so `adapter.ts` never has to know what a
 * Terminal failure looks like on the wire.
 *
 * NO TOKEN DANCE: unlike `FezClient`, there is no sign-in call and nothing to
 * cache or refresh — every request carries the same bearer secret key from
 * `env.secretKey`, and that secret key IS NEVER PUT IN A THROWN MESSAGE. The
 * classified messages below are Terminal's own `message` about OUR request,
 * which is safe to show an admin; our credentials never appear in a URL, a
 * log line, or an error.
 */
export class TerminalClient {
  readonly #env: TerminalEnv;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;

  constructor(env: TerminalEnv, opts: TerminalClientOptions = {}) {
    this.#env = env;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeout = opts.timeoutMs ?? 8_000;
  }

  async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#env.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${this.#env.secretKey}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeout),
      });
    } catch (err) {
      // TimeoutError/AbortError from AbortSignal.timeout, or a network failure —
      // both are "we don't know what happened", never a plain rejection.
      const name = err instanceof Error ? err.name : '';
      throw new LogisticsError(
        'provider_unavailable',
        name === 'TimeoutError' || name === 'AbortError' ? 'Terminal Africa timed out' : 'Terminal Africa could not be reached',
      );
    }

    let envelope: Record<string, unknown> | null = null;
    try {
      envelope = (await res.json()) as Record<string, unknown>;
    } catch {
      envelope = null;
    }
    const message = typeof envelope?.message === 'string' && envelope.message.trim() !== '' ? envelope.message : null;

    if (res.status >= 500) throw new LogisticsError('provider_unavailable', message ?? 'Terminal Africa is unavailable', { status: res.status });
    if (!res.ok) throw new LogisticsError('provider_rejected', message ?? `Terminal Africa refused the request (${res.status})`, { status: res.status, detail: envelope });
    if (!envelope) throw new LogisticsError('bad_response', 'Terminal Africa answered with no JSON', { status: res.status });
    if (envelope.status !== true) {
      throw new LogisticsError('provider_rejected', message ?? `Terminal Africa refused the request (${res.status})`, { status: res.status, detail: envelope });
    }
    // The whole envelope — `{ status, message, data }` — is returned; callers read `data`.
    return envelope;
  }
}

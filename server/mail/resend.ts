import { getEnv } from '../env';
import { MailNotConfiguredError } from './port';
import type { Mailer } from './port';

/**
 * The Resend transport, over plain `fetch`.
 *
 * NO `resend` NPM PACKAGE, DELIBERATELY. The whole of the API used here is one
 * POST with a bearer token and a JSON body; a dependency to express that is a
 * dependency in the deploy bundle, in the audit surface and in the upgrade
 * treadmill, bought for nothing.
 *
 * LAZY, LIKE `server/storage/r2.ts`. Nothing is read from the environment at
 * construction, so `createApp()` — which defaults to this — still boots on a
 * deployment with no mail configured, and `GET /api/posts` still serves. Only
 * the reset path fails, and it fails with a named 501.
 */
const ENDPOINT = 'https://api.resend.com/emails';

/**
 * TRIMMED, AND THAT IS NOT TIDYING — it is a fix for a measured production
 * failure.
 *
 * Piping a value into `vercel env add` from PowerShell prefixes it with a BOM
 * (U+FEFF). The key then reaches `fetch` inside a header value and Undici
 * rejects the whole request:
 *
 *   TypeError: Cannot convert argument to a ByteString because the character
 *   at index 7 has a value of 65279 which is greater than 255
 *
 * Index 7 is the first character after `Bearer `. Nothing about the message
 * names the environment variable, the header, or the BOM, and the same value
 * looks perfect in the Vercel dashboard. `trim()` removes U+FEFF because
 * ECMAScript counts it as whitespace, so this is one call rather than a
 * special case — and it equally absorbs the trailing newline that a
 * `cat key.txt | vercel env add` would leave.
 */
function config(): { apiKey: string; from: string } {
  const env = getEnv();
  const apiKey = env.RESEND_API_KEY.trim();
  const from = env.MAIL_FROM.trim();
  const missing: string[] = [];
  if (!apiKey) missing.push('RESEND_API_KEY');
  if (!from) missing.push('MAIL_FROM');
  if (missing.length) throw new MailNotConfiguredError(missing);
  return { apiKey, from };
}

export function resendMailer(): Mailer {
  return {
    assertConfigured() {
      config();
    },

    async send(msg) {
      const { apiKey, from } = config();
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [msg.to],
          subject: msg.subject,
          text: msg.text,
          html: msg.html,
        }),
      });

      if (!res.ok) {
        /*
         * STATUS ONLY. Not the request (it carries the reset token), not the
         * headers (they carry the API key), and not the response body — Resend
         * echoes parts of the submitted message back in an error. The one thing
         * safe to say is how it failed.
         */
        throw new Error(`resend refused the message: HTTP ${res.status}`);
      }
    },
  };
}

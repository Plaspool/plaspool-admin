import { z } from 'zod';

/**
 * Validated environment, read lazily.
 *
 * `getEnv()` and not `export const env`: a module-scope const evaluates at
 * import time, which breaks any test that sets process.env in a setup file
 * and turns a missing variable into a confusing import-time crash.
 */
const Schema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  APP_ORIGINS: z.string().min(1), // comma-separated EXACT origins
  R2_ACCOUNT_ID: z.string().default(''),
  R2_BUCKET: z.string().default(''),
  R2_ACCESS_KEY_ID: z.string().default(''),
  R2_SECRET_ACCESS_KEY: z.string().default(''),
  /*
   * Mail, for the password-reset flow. `.default('')` exactly like the R2 vars
   * above: a deployment with no mailer still boots and still serves everything
   * else — `POST /api/auth/forgot` is the only route that fails, and it fails
   * with a named 501 rather than taking the process down at import time.
   */
  RESEND_API_KEY: z.string().default(''),
  MAIL_FROM: z.string().default(''),
  /*
   * The storefront identity bridge (customer auth). `.default('')` for the same
   * reason as the mail vars: a deployment without it still boots and still
   * serves everything else — only `POST /api/shop/customer/session/exchange`
   * fails, with a named 501 rather than an import-time crash.
   */
  SHOP_AUTH_BRIDGE_SECRET: z.string().default(''),
  /*
   * Clerk, for the Google-sign-in bridge (admin auth). `.default('')` for the
   * same reason as everything above it: a deployment without Clerk still boots
   * and the password login carries the team — only the Clerk exchange answers
   * 501, and the sign-in screen never offers the button (the client half keys
   * off VITE_CLERK_PUBLISHABLE_KEY at build time).
   */
  CLERK_SECRET_KEY: z.string().default(''),
  NODE_ENV: z.string().default('development'),
});

export type Env = z.infer<typeof Schema>;

let cached: Env | null = null;

/**
 * FOR SUITES ONLY. A test that must run with a variable the worker's earlier
 * imports already cached without (the Clerk suite sets CLERK_SECRET_KEY)
 * clears the memo and lets the next `getEnv()` re-read `process.env`.
 * Production never calls this; the cache exists to keep the parse off the
 * request path, not to freeze configuration.
 */
export function resetEnvCacheForTests(): void {
  cached = null;
}

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    // Names only. The values are secrets and must never reach a log.
    throw new Error(
      `Invalid environment: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }
  return (cached = parsed.data);
}

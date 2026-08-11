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
  NODE_ENV: z.string().default('development'),
});

export type Env = z.infer<typeof Schema>;

let cached: Env | null = null;

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

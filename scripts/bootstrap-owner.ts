/**
 * Create the first owner, or re-enable an account that was locked out.
 *
 * WHY THIS EXISTS. Accounts are invite-only and invites require an owner, so
 * the first owner cannot be created through the API — there is nobody to issue
 * the invite. This is the supported bootstrap, and since Clerk became the only
 * way in (2026-09-01) it is also the ONLY break-glass: nothing else in this
 * repository can create or re-enable an account without a live session.
 *
 * IT SETS NO PASSWORD, DESPITE WRITING `password_hash`. It used to — the file
 * was called `set-owner-password.ts` — and that stopped meaning anything the
 * day `POST /api/auth/login` was deleted. The column is NOT NULL, so the row
 * gets 32 bytes of noise nobody holds, exactly as `claimInviteForEmail` does
 * for an invited teammate. Sign-in is Clerk's; what this command decides is
 * whether Clerk is allowed to let that address through.
 *
 * SO THE ADDRESS IS THE WHOLE CREDENTIAL, and it must be the one attached to
 * the Google (or other Clerk) account that will sign in. A typo produces a row
 * that looks right and admits nobody.
 *
 * TWO MODES:
 *
 *   --print-sql   Print an INSERT ... ON CONFLICT for the Neon SQL editor and
 *                 connect to nothing. Use this when you would rather not hand a
 *                 production connection string to a script.
 *
 *   --apply       Connect with DATABASE_URL and run it directly.
 *
 * It deliberately does NOT import `server/env.ts`: that validates the whole
 * environment (SESSION_SECRET, APP_ORIGINS, R2_*) and this task needs one
 * variable.
 *
 * Usage:
 *   npx tsx scripts/bootstrap-owner.ts --email you@example.com --name "You" --print-sql
 *   DATABASE_URL='postgres://…' npx tsx scripts/bootstrap-owner.ts --email you@example.com --name "You" --apply
 */
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../server/repo/password';

interface Args {
  email: string;
  name: string;
  role: 'owner' | 'writer';
  mode: 'print-sql' | 'apply';
  keepSessions: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const email = (get('--email') ?? '').trim().toLowerCase();
  const name = (get('--name') ?? '').trim();
  const role = (get('--role') ?? 'owner') as 'owner' | 'writer';

  const apply = argv.includes('--apply');
  const printSql = argv.includes('--print-sql');

  if (!email) fail('--email is required');
  // The same shape check the API applies, so a typo fails here rather than
  // becoming a row nobody can log in as.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(`not an email address: ${email}`);
  if (!name) fail('--name is required (it is the byline, and cannot be blank)');
  if (role !== 'owner' && role !== 'writer') fail(`--role must be owner or writer, got ${role}`);
  if (apply === printSql) fail('choose exactly one of --apply or --print-sql');

  return {
    email,
    name,
    role,
    mode: apply ? 'apply' : 'print-sql',
    keepSessions: argv.includes('--keep-sessions'),
  };
}

function fail(message: string): never {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

/**
 * An unusable password hash: 32 random bytes nobody keeps, hashed at the
 * production parameters.
 *
 * `users.password_hash` is NOT NULL and no route reads it any more, so the
 * honest value is one that cannot be produced by anybody — including whoever
 * runs this command. Deliberately not a fixed sentinel like 'x': if a password
 * route is ever reintroduced, a shared sentinel across every bootstrapped row
 * would be one guess away from being every account's password.
 */
async function unusablePasswordHash(): Promise<string> {
  return hashPassword(randomBytes(32).toString('base64url'));
}

/** Postgres single-quote escaping. Values here are ours, but SQL is SQL. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildSql(a: Args, passwordHash: string, now: number): string {
  const lines = [
    `INSERT INTO users (email, password_hash, display_name, role, created_at)`,
    `VALUES (${quote(a.email)}, ${quote(passwordHash)}, ${quote(a.name)}, ${quote(a.role)}, ${now})`,
    `ON CONFLICT (email) DO UPDATE`,
    `  SET password_hash = EXCLUDED.password_hash,`,
    `      display_name  = EXCLUDED.display_name,`,
    `      role          = EXCLUDED.role,`,
    // Clearing `disabled_at` is the POINT of running this against an existing
    // row: re-enabling a locked-out owner is the break-glass, and it is done
    // deliberately rather than by omission.
    `      disabled_at   = NULL;`,
  ];
  if (!a.keepSessions) {
    lines.push(
      ``,
      `-- Every existing session for this account, revoked. A password reset that`,
      `-- leaves old sessions signed in has not actually locked anyone out.`,
      `DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ${quote(a.email)});`,
    );
  }
  return lines.join('\n');
}

async function apply(sqlText: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) fail('--apply needs DATABASE_URL in the environment');

  // Imported lazily so --print-sql never loads a driver or touches the network.
  const { neon } = await import('@neondatabase/serverless');
  const client = neon(url);
  // `sessions` may not exist on a database stopped before that migration; the
  // two statements are sent separately so the user row still lands.
  for (const statement of sqlText.split(';').map((s) => s.trim()).filter(Boolean)) {
    await client.query(statement);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sqlText = buildSql(args, await unusablePasswordHash(), Date.now());

  /*
   * STDOUT CARRIES ONLY SQL; every human word goes to stderr.
   *
   * Otherwise `> bootstrap.sql` captures the friendly trailer too and the file
   * is a syntax error — which is exactly how this was first written, and the
   * test caught it.
   */
  const say = (line = ''): void => void process.stderr.write(`${line}\n`);

  if (args.mode === 'print-sql') {
    say();
    say(`  Paste the SQL below into the Neon SQL editor.`);
    say(`  It creates ${args.email} as ${args.role}, or re-enables it if it exists.`);
    say();
    process.stdout.write(`${sqlText}\n`);
  } else {
    await apply(sqlText);
    say();
    say(`  ✓ ${args.email} is now an enabled ${args.role}.`);
    if (!args.keepSessions) say(`  ✓ existing sessions revoked`);
  }

  say();
  say(`  Now sign in at the admin with the Google account for ${args.email}.`);
  say(`  There is no password — this row only decides who Clerk may let in.`);
  say();
}

main().catch((err: unknown) => {
  // Never print the error object: a driver error carries the connection string.
  console.error(`\n  ✗ ${err instanceof Error ? err.message : 'failed'}\n`);
  process.exit(1);
});

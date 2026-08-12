/**
 * Create an owner, or reset an existing account's password.
 *
 * WHY THIS EXISTS. Accounts are invite-only and invites require an owner, so
 * the first owner cannot be created through the API — there is nobody to issue
 * the invite. This is the supported bootstrap, and the same command is the
 * password reset until a real reset flow exists.
 *
 * THE PASSWORD NEVER LEAVES THIS MACHINE. It is read from `OWNER_PASSWORD`, or
 * generated here, or prompted for with the echo turned off — never passed as an
 * argv, which would put it in shell history and in the process list.
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
 *   npx tsx scripts/set-owner-password.ts --email you@example.com --name "You" --print-sql
 *   DATABASE_URL='postgres://…' npx tsx scripts/set-owner-password.ts --email you@example.com --name "You" --apply
 */
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { hashPassword } from '../server/repo/password';

/** Mirrors `assertCredentials` in server/repo/users.ts. */
const MIN_PASSWORD_LENGTH = 10;

interface Args {
  email: string;
  name: string;
  role: 'owner' | 'writer';
  mode: 'print-sql' | 'apply';
  generate: boolean;
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
    generate: argv.includes('--generate'),
    keepSessions: argv.includes('--keep-sessions'),
  };
}

function fail(message: string): never {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

/** base64url of 18 random bytes — 24 chars, no ambiguous punctuation. */
function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

/**
 * Prompt without echoing. `readline` still writes the prompt, so `output` is
 * muted only for the keystrokes.
 */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const asMutable = rl as unknown as { _writeToOutput?: (s: string) => void };
    process.stdout.write(question);
    asMutable._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function resolvePassword(generate: boolean): Promise<{ password: string; shown: boolean }> {
  const fromEnv = process.env.OWNER_PASSWORD;
  if (fromEnv) return { password: fromEnv, shown: false };
  if (generate) return { password: generatePassword(), shown: true };

  const typed = await promptHidden('  New password (input hidden): ');
  const again = await promptHidden('  Repeat it: ');
  if (typed !== again) fail('the two entries did not match');
  return { password: typed, shown: false };
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
    // An account someone disabled should not come back to life as a side effect
    // of a password reset — but this command IS how you re-enable one, so it is
    // cleared deliberately rather than by omission.
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
  const { password, shown } = await resolvePassword(args.generate);

  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`password must be at least ${MIN_PASSWORD_LENGTH} characters (the API enforces this too)`);
  }

  const passwordHash = await hashPassword(password);
  const sqlText = buildSql(args, passwordHash, Date.now());

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
    say(`  It creates ${args.email} as ${args.role}, or resets it if it exists.`);
    say();
    process.stdout.write(`${sqlText}\n`);
  } else {
    await apply(sqlText);
    say();
    say(`  ✓ ${args.email} is now ${args.role}, with a new password.`);
    if (!args.keepSessions) say(`  ✓ existing sessions revoked`);
  }

  if (shown) {
    say();
    say(`  Password (generated — store it now, it is not recoverable):`);
    say();
    say(`      ${password}`);
  }
  say();
  say(`  Sign in with ${args.email}`);
  say();
}

main().catch((err: unknown) => {
  // Never print the error object: a driver error carries the connection string.
  console.error(`\n  ✗ ${err instanceof Error ? err.message : 'failed'}\n`);
  process.exit(1);
});

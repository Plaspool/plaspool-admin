/**
 * PUT A FLUTTERWAVE SECRET KEY INTO A VERCEL ENVIRONMENT, SAFELY.
 *
 * Unlike the webhook hash, this one is ISSUED BY FLUTTERWAVE — so this script
 * takes it rather than minting it, and its real job is refusing the five ways
 * that goes wrong.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY IT REFUSES A LIVE KEY ON A NON-PRODUCTION ENVIRONMENT BY DEFAULT.
 *
 * This has already happened here once, with the other gateway: a LIVE Paystack
 * key ended up in the preview environment. A live key outside production means
 * a test checkout takes real money from a real card, and nothing on the screen
 * says so. `-allow-live` exists for the deliberate case and has to be typed.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────
 * RUN IT
 *
 *   npx tsx scripts/flutterwave-key.ts -secret FLWSECK_TEST-… -environment development
 *   npx tsx scripts/flutterwave-key.ts -secret FLWSECK_TEST-… -environment preview
 *   npx tsx scripts/flutterwave-key.ts -secret FLWSECK-…      -environment production -allow-live
 *
 * `--secret=…` and `--environment=…` work identically. `-environment` defaults
 * to `development`. Other flags: `-force` (replace an existing value),
 * `-skip-verify` (do not call Flutterwave first).
 *
 * ⚠️  A SECRET PASSED AS AN ARGUMENT LANDS IN SHELL HISTORY and is visible in
 *     the process table. To avoid that, omit `-secret` and the script reads
 *     stdin instead — typed with the echo off, or piped:
 *
 *       echo "$KEY" | npx tsx scripts/flutterwave-key.ts -environment development
 * ─────────────────────────────────────────────────────────────────────────
 */
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const SCOPE = 'nattys-projects-05ebc986';
const NAME = 'FLUTTERWAVE_SECRET_KEY';
const VERIFY_URL = 'https://api.flutterwave.com/v3/banks/NG';
const ENVIRONMENTS = ['development', 'preview', 'production'] as const;

/**
 * Accepts `-name value`, `--name value`, `-name=value` and `--name=value`.
 *
 * Forgiving on purpose: this is typed by hand, under time pressure, with a
 * credential on the clipboard. Being strict about the dash count buys nothing
 * and costs a re-paste of the very thing you do not want to keep re-pasting.
 */
function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    for (const p of [`--${name}=`, `-${name}=`]) {
      if (a.startsWith(p)) return a.slice(p.length);
    }
    if (a === `--${name}` || a === `-${name}`) return argv[i + 1];
  }
  return undefined;
}

function flag(name: string): boolean {
  return process.argv.slice(2).some((a) => a === `--${name}` || a === `-${name}`);
}

/** Read a secret without echoing it back, when it was not passed as a flag. */
async function readSecret(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const iface = rl as unknown as { _writeToOutput: (s: string) => void };
  const original = iface._writeToOutput.bind(rl);
  let muted = false;
  iface._writeToOutput = (s: string) => {
    if (!muted) original(s);
  };
  const answer = await new Promise<string>((resolve) => {
    rl.question('  Paste the Flutterwave secret key (input hidden): ', resolve);
    muted = true;
  });
  rl.close();
  process.stdout.write('\n');
  return answer.trim();
}

function vercel(args: string[], stdin: string): { ok: boolean; out: string } {
  const res = spawnSync('npx', ['vercel', ...args, '--scope', SCOPE], {
    input: stdin,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return { ok: res.status === 0, out: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
}

/** Ask Flutterwave whether the key actually authenticates. A plain read. */
async function verify(key: string): Promise<'ok' | 'rejected' | 'unreachable'> {
  try {
    const res = await fetch(VERIFY_URL, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) return 'rejected';
    return res.ok ? 'ok' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

const die = (...lines: string[]): void => {
  for (const l of lines) console.error(l);
  process.exitCode = 1;
};

async function main(): Promise<void> {
  const env = (arg('environment') ?? arg('env') ?? 'development').trim();
  if (!(ENVIRONMENTS as readonly string[]).includes(env)) {
    die(`  Unknown environment "${env}". Use one of: ${ENVIRONMENTS.join(', ')}.`);
    return;
  }

  const fromFlag = arg('secret');
  const key = (fromFlag ?? (await readSecret())).trim();

  /* ── The five refusals ───────────────────────────────────────────────── */
  if (key === '') return die('  No key given. Pass -secret <key>, pipe it in, or paste at the prompt.');

  if (/^FLWPUBK/i.test(key)) {
    return die(
      '  Refusing: that is the PUBLIC key (FLWPUBK…), the one used in frontend snippets.',
      '  The server wants the SECRET key. Pasting the public one here produces a 401 on',
      '  the first charge, with the gateway blamed.',
    );
  }
  if (!/^FLWSECK[-_]/.test(key)) {
    return die(
      '  Refusing: a Flutterwave secret key starts FLWSECK- (live) or FLWSECK_TEST- (test).',
      '  The server schema enforces the same shape, so a value refused here would be',
      '  refused there too.',
    );
  }
  if (key.length < 20) {
    return die('  Refusing: shorter than 20 characters — the server schema requires that.');
  }

  const isTest = /^FLWSECK_TEST-/.test(key);
  if (!isTest && env !== 'production' && !flag('allow-live')) {
    return die(
      `  Refusing: that is a LIVE key and the target is "${env}".`,
      '',
      '  A live key outside production means a test checkout charges a real card, and',
      '  nothing on the screen says so. This exact mistake has been made in this project',
      '  before, with the other gateway.',
      '',
      '  If you truly mean it: add -allow-live',
    );
  }

  console.log('');
  console.log(`  key          ${isTest ? 'TEST' : 'LIVE'} (FLWSECK${isTest ? '_TEST' : ''}-…, ${key.length} chars)`);
  console.log(`  environment  ${env}`);
  if (fromFlag !== undefined) {
    console.log('  note         passed as an argument, so it is now in your shell history');
  }

  /* ── Does it actually work? ──────────────────────────────────────────── */
  if (!flag('skip-verify')) {
    const v = await verify(key);
    if (v === 'rejected') {
      console.log('');
      return die(
        '  Refusing: Flutterwave rejected this key (401/403). It is well-formed but not',
        '  valid — wrong account, revoked, or a character lost in the paste. Nothing was',
        '  uploaded. Use -skip-verify to store it anyway.',
      );
    }
    console.log(v === 'ok' ? '  verify       Flutterwave accepted it' : '  verify       could not reach Flutterwave — storing unverified');
  }

  /* ── Upload ──────────────────────────────────────────────────────────── */
  const args = ['env', 'add', NAME, env];
  /* Sensitive in production only, matching how PAYSTACK_SECRET_KEY and the Fez
     credentials are already stored. A sensitive value can never be read back:
     right for production, wrong for a dev key you want to pull locally to run
     a probe against the real gateway. */
  if (env === 'production') args.push('--sensitive');
  if (flag('force')) args.push('--force');

  const { ok, out } = vercel(args, `${key}\n`);
  console.log('');
  if (ok) {
    console.log(`  OK   stored in ${env}${env === 'production' ? '  (sensitive — cannot be read back)' : ''}`);
  } else if (/already exists/i.test(out) && !flag('force')) {
    console.log(`  --   ${NAME} already set in ${env}, left alone. Add -force to replace.`);
    return;
  } else {
    return die(`  FAIL ${out.split('\n').slice(-2).join(' ')}`);
  }

  console.log('');
  console.log('  Next:');
  console.log('   1. The webhook hash, if you have not already:');
  console.log('        npx tsx scripts/flutterwave-hash.ts');
  console.log('   2. REDEPLOY — Vercel bakes env vars at build time, so this does nothing yet:');
  console.log('        npm run deploy:dev');
  console.log('   3. Confirm. That endpoint answers 503 while unconfigured, 401 once both keys');
  console.log('      are in and the build has picked them up:');
  console.log("        curl -s -o /dev/null -w '%{http_code}\\n' -X POST \\");
  console.log('          https://admin.dev.plaspool.com/api/shop/payments/webhook/flutterwave');
  console.log('');
}

void main();

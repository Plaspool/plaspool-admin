/**
 * PUT A FLUTTERWAVE SECRET KEY INTO A VERCEL ENVIRONMENT, SAFELY.
 *
 * Unlike the webhook hash, this one is ISSUED BY FLUTTERWAVE — so this script
 * takes it rather than minting it, and its whole job is refusing the four ways
 * that goes wrong.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY IT REFUSES A LIVE KEY ON A NON-PRODUCTION ENVIRONMENT BY DEFAULT.
 *
 * This has already happened here once, with the other gateway: a LIVE Paystack
 * key ended up in the preview environment. A live key on dev means a test
 * checkout takes real money from a real card, and nothing about the screen
 * says so. `--allow-live` exists for the deliberate production case and has to
 * be typed.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE KEY IS NEVER TAKEN AS A COMMAND-LINE ARGUMENT. Arguments land in shell
 * history and are visible in the process table to anything else on the
 * machine. It is read from stdin — piped, or typed with the echo turned off.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *   npx tsx scripts/flutterwave-key.ts                    # prompt, -> development
 *   npx tsx scripts/flutterwave-key.ts --env=preview
 *   npx tsx scripts/flutterwave-key.ts --env=production --allow-live
 *   npx tsx scripts/flutterwave-key.ts --skip-verify      # don't call Flutterwave
 *   echo "$KEY" | npx tsx scripts/flutterwave-key.ts      # piped
 * ─────────────────────────────────────────────────────────────────────────
 */
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const SCOPE = 'nattys-projects-05ebc986';
const NAME = 'FLUTTERWAVE_SECRET_KEY';
const VERIFY_URL = 'https://api.flutterwave.com/v3/banks/NG';

const argv = process.argv.slice(2);
const has = (f: string): boolean => argv.includes(f);
const env = argv.find((a) => a.startsWith('--env='))?.slice('--env='.length) ?? 'development';

if (!['development', 'preview', 'production'].includes(env)) {
  console.error(`Unknown environment "${env}". Use development, preview or production.`);
  process.exit(1);
}

/** Read a secret without putting it in argv, and without echoing it back. */
async function readSecret(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  /* Swallow the echo so the key never reaches the scrollback. */
  const iface = rl as unknown as { _writeToOutput: (s: string) => void };
  const original = iface._writeToOutput.bind(rl);
  let muted = false;
  iface._writeToOutput = (s: string) => {
    if (!muted) original(s);
  };
  const answer = await new Promise<string>((resolve) => {
    rl.question('  Paste the Flutterwave secret key (input hidden): ', (a) => resolve(a));
    muted = true;
  });
  rl.close();
  process.stdout.write('\n');
  return answer.trim();
}

function run(args: string[], stdin: string): { ok: boolean; out: string } {
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

async function main(): Promise<void> {
  const key = await readSecret();

  /* ── The four refusals ───────────────────────────────────────────────── */
  if (key === '') {
    console.error('  Nothing read. Paste the key, or pipe it in.');
    process.exitCode = 1;
    return;
  }
  if (/^FLWPUBK/i.test(key)) {
    console.error('  Refusing: that is the PUBLIC key (FLWPUBK…), the one used in frontend');
    console.error('  snippets. The server wants the SECRET key. Pasting the public one here');
    console.error('  produces a 401 on the first charge with the gateway blamed.');
    process.exitCode = 1;
    return;
  }
  if (!/^FLWSECK[-_]/.test(key)) {
    console.error('  Refusing: a Flutterwave secret key starts FLWSECK- (live) or');
    console.error('  FLWSECK_TEST- (test). The server schema enforces the same shape, so a');
    console.error('  value that fails here would be refused there too.');
    process.exitCode = 1;
    return;
  }
  if (key.length < 20) {
    console.error('  Refusing: shorter than 20 characters — the server schema requires that.');
    process.exitCode = 1;
    return;
  }

  const isTest = /^FLWSECK_TEST-/.test(key);
  if (!isTest && env !== 'production' && !has('--allow-live')) {
    console.error(`  Refusing: that is a LIVE key and the target is "${env}".`);
    console.error('');
    console.error('  A live key outside production means a test checkout charges a real card,');
    console.error('  and nothing on the screen says so. This exact mistake has been made in');
    console.error('  this project before, with the other gateway.');
    console.error('');
    console.error('  If you truly mean it: re-run with --allow-live');
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log(`  key      ${isTest ? 'TEST' : 'LIVE'} (FLWSECK${isTest ? '_TEST' : ''}-…, ${key.length} chars)`);
  console.log(`  target   ${env}`);

  /* ── Does it actually work? ──────────────────────────────────────────── */
  if (!has('--skip-verify')) {
    const v = await verify(key);
    if (v === 'rejected') {
      console.error('');
      console.error('  Refusing: Flutterwave rejected this key (401/403). It is well-formed but');
      console.error('  not valid — wrong account, revoked, or a character lost in the paste.');
      console.error('  Nothing was uploaded. Use --skip-verify to store it anyway.');
      process.exitCode = 1;
      return;
    }
    console.log(v === 'ok' ? '  verify   Flutterwave accepted it' : '  verify   could not reach Flutterwave — storing unverified');
  }

  /* ── Upload ──────────────────────────────────────────────────────────── */
  const args = ['env', 'add', NAME, env];
  /* Sensitive in production only, matching how PAYSTACK_SECRET_KEY and the Fez
     credentials are already stored — a sensitive value can never be read back,
     which is right for production and wrong for a dev key you want to pull
     locally to run a probe against. */
  if (env === 'production') args.push('--sensitive');
  if (has('--force')) args.push('--force');

  const { ok, out } = run(args, `${key}\n`);
  console.log('');
  if (ok) {
    console.log(`  OK   stored in ${env}${env === 'production' ? ' (sensitive — cannot be read back)' : ''}`);
  } else if (/already exists/i.test(out) && !has('--force')) {
    console.log(`  --   ${NAME} already set in ${env}, left alone. Re-run with --force to replace.`);
    return;
  } else {
    console.error(`  FAIL ${out.split('\n').slice(-2).join(' ')}`);
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log('  Next:');
  console.log('   1. FLUTTERWAVE_WEBHOOK_HASH too, if you have not already:');
  console.log('        npx tsx scripts/flutterwave-hash.ts');
  console.log('   2. REDEPLOY — Vercel bakes env vars at build time, so this does nothing yet:');
  console.log('        npm run deploy:dev');
  console.log('   3. Confirm. That endpoint answers 503 while unconfigured, 401 once both');
  console.log('      keys are in and the build has picked them up:');
  console.log("        curl -s -o /dev/null -w '%{http_code}\\n' -X POST \\");
  console.log('          https://admin.dev.plaspool.com/api/shop/payments/webhook/flutterwave');
  console.log('');
}

void main();

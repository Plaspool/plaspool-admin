/**
 * MINT A FLUTTERWAVE WEBHOOK SECRET HASH AND PUT IT IN ALL THREE VERCEL
 * ENVIRONMENTS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS VALUE IS, BECAUSE IT IS NOT WHAT ITS NAME SUGGESTS.
 *
 * It is not a hash of anything, and Flutterwave does not issue it. YOU invent
 * it, paste it into their dashboard, and they send it back verbatim in a
 * `verif-hash` header on every webhook. The server compares the two.
 *
 * So it is a shared password, and it is the ONLY thing standing between a
 * stranger and a forged "this order was paid" notification — Flutterwave v3
 * does not sign the request body the way Paystack does. Treat it accordingly:
 * long, random, never reused, never pasted into a chat window.
 *
 * (The adapter does not trust the body even so — it takes only `tx_ref` from
 * it and re-reads the truth from Flutterwave's API. That is defence in depth,
 * not a reason to be casual with this.)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────
 *   npx tsx scripts/flutterwave-hash.ts              # generate + upload
 *   npx tsx scripts/flutterwave-hash.ts --print-only # generate, upload nothing
 *   npx tsx scripts/flutterwave-hash.ts --force      # replace existing values
 *   npx tsx scripts/flutterwave-hash.ts --value=...  # upload one you already have
 * ─────────────────────────────────────────────────────────────────────────
 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const SCOPE = 'nattys-projects-05ebc986';
const NAME = 'FLUTTERWAVE_WEBHOOK_HASH';

/**
 * SENSITIVE IN PRODUCTION, READABLE IN THE OTHER TWO — matching how this
 * project already stores `PAYSTACK_SECRET_KEY` and the Fez credentials.
 *
 * A Vercel "sensitive" variable cannot be read back, by anyone, ever. That is
 * right for production. It is wrong for development, where being able to
 * `vercel env pull` the value is what lets you run a local probe against the
 * real gateway — which is exactly how the Fez pricing question got answered.
 */
const TARGETS = [
  { env: 'production', sensitive: true },
  { env: 'preview', sensitive: false },
  { env: 'development', sensitive: false },
] as const;

const argv = process.argv.slice(2);
const has = (f: string): boolean => argv.includes(f);
const valueArg = argv.find((a) => a.startsWith('--value='))?.slice('--value='.length);

/**
 * 48 bytes of CSPRNG as base64url — 384 bits, no padding, and no character
 * that needs escaping in a shell, an HTTP header, or Flutterwave's own form.
 *
 * `randomBytes`, never `Math.random`: this is a credential, and its entire
 * value is that it cannot be guessed.
 */
function mint(): string {
  return randomBytes(48).toString('base64url');
}

function run(args: string[], stdin: string): { ok: boolean; out: string } {
  const res = spawnSync('npx', ['vercel', ...args, '--scope', SCOPE], {
    input: stdin,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return { ok: res.status === 0, out: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
}

function main(): void {
  if (valueArg !== undefined && valueArg.length < 8) {
    console.error('Refusing: the hash must be at least 8 characters — the server schema requires it.');
    process.exitCode = 1;
    return;
  }
  const value = valueArg ?? mint();

  console.log('');
  console.log('  ┌─ Flutterwave webhook secret hash ' + '─'.repeat(44));
  console.log('  │');
  console.log(`  │   ${value}`);
  console.log('  │');
  console.log('  └' + '─'.repeat(78));
  console.log('');
  console.log('  Paste this into Flutterwave -> Settings -> Webhooks -> "Secret hash".');
  console.log('  It must match CHARACTER FOR CHARACTER or every webhook is refused with a 401.');
  console.log('');

  if (has('--print-only')) {
    console.log('  --print-only: nothing was uploaded.');
    return;
  }

  let failed = 0;
  for (const { env, sensitive } of TARGETS) {
    /* `env add` refuses when the name already exists, so a re-run is a no-op
       rather than a silent second value. `--force` is the deliberate replace. */
    const args = ['env', 'add', NAME, env];
    if (sensitive) args.push('--sensitive');
    if (has('--force')) args.push('--force');

    const { ok, out } = run(args, `${value}\n`);
    const already = /already exists/i.test(out);
    if (ok) {
      console.log(`  OK   ${env.padEnd(12)} added${sensitive ? '  (sensitive - cannot be read back)' : ''}`);
    } else if (already && !has('--force')) {
      console.log(`  --   ${env.padEnd(12)} already set, left alone. Re-run with --force to replace.`);
    } else {
      failed += 1;
      console.log(`  FAIL ${env.padEnd(12)} ${out.split('\n').slice(-2).join(' ')}`);
    }
  }

  console.log('');
  if (failed > 0) {
    console.log('  Some uploads failed. The hash above is still valid — fix the error and re-run');
    console.log('  with --value=<the hash above> so the SAME value lands everywhere.');
    process.exitCode = 1;
    return;
  }

  console.log('  Next, and the order matters:');
  console.log('');
  console.log('   1. Register the webhook URL in Flutterwave, against this hash:');
  console.log('        dev   https://admin.dev.plaspool.com/api/shop/payments/webhook/flutterwave');
  console.log('        prod  https://admin.plaspool.com/api/shop/payments/webhook/flutterwave');
  console.log('');
  console.log('   2. Add the secret key too (starts FLWSECK- or FLWSECK_TEST-):');
  console.log(`        npx vercel env add FLUTTERWAVE_SECRET_KEY development --scope ${SCOPE}`);
  console.log('');
  console.log('   3. REDEPLOY. Vercel bakes environment variables at build time, so nothing');
  console.log('      above takes effect until the next build:');
  console.log('        npm run deploy:dev');
  console.log('');
  console.log('   4. Confirm it took. That endpoint answers 503 while unconfigured and 401');
  console.log('      once both keys are in:');
  console.log("        curl -s -o /dev/null -w '%{http_code}\\n' -X POST \\");
  console.log('          https://admin.dev.plaspool.com/api/shop/payments/webhook/flutterwave');
  console.log('');
  console.log('  Keep a copy of the hash. Production stores it sensitive, so Vercel will not');
  console.log('  give it back — lose it and you must mint a new one and update Flutterwave.');
  console.log('');
}

main();

/**
 * Ask Fez Delivery, from a terminal, whether a user id and password work.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS ALONGSIDE THE ADMIN'S OWN COURIER TEST.
 *
 * `diagnostics.ts` already answers these questions behind a button, and that
 * is the right place for an operator. But it can only ask them about the
 * credentials the DEPLOYMENT holds — so it cannot answer the question you have
 * before a deploy: "are these the right credentials at all?". Fez issues an
 * admin user id (shaped like `G-4568-3493`) and a password only after the
 * organisation clears KYC, and the first thing you want to know is whether the
 * pair Fez emailed you actually signs in — BEFORE putting it in Vercel, where
 * an env var bakes at build time and a wrong one costs a deploy to find out.
 *
 * It runs the REAL adapter (`createFezProvider`), not a hand-rolled fetch. A
 * probe that agrees with itself and disagrees with production is worse than no
 * probe; §2 of CLAUDE.md is a list of those.
 *
 * ═══ DEV AND PROD, AND IT BOOKS NOTHING IN EITHER ═══
 *
 *   npm run probe:fez -- --dev     https://apisandbox.fezdelivery.co/v1  (default)
 *   npm run probe:fez -- --prod    https://api.fezdelivery.co/v1
 *
 * `--sandbox` and `--live` are the same two, under the names the rest of this
 * codebase uses; `--env=prod` also works. The sandbox is the default and only
 * an explicit word reaches production, matching `config.ts`'s rule that a
 * forgotten variable can never spend real money. The two accounts are separate
 * — Fez issues you a user id per environment — so a dev credential will not
 * sign in to prod, and that refusal is the expected one rather than a fault.
 *
 * Both calls it makes are reads: `POST /order/cost` is a price (Fez holds no
 * draft between a price and an order, so this reserves nothing) and
 * `GET /states` is a list.
 *
 * ═══ PASSING A PASSWORD AND A SECRET KEY ═══
 *
 * Three ways, and each beats the one after it: a flag, then the environment,
 * then the PASTE block below.
 *
 * A file is the one to prefer, because a flag is visible in shell history and
 * to `ps`. The npm script loads `.fez.env` when one is there and shrugs when
 * it is not, so put FEZ_USER_ID / FEZ_PASSWORD (and optionally FEZ_SECRET_KEY,
 * FEZ_BASE_URL) in that file and run:
 *
 *   npm run probe:fez
 *
 * `*.env` is already gitignored. For a different file, name it yourself — the
 * flag has to reach tsx, so it goes BEFORE the script and npm cannot forward
 * it:
 *
 *   npx tsx --env-file=.prod.env scripts/probe-fez.ts --prod
 *
 * For a one-off:
 *
 *   npm run probe:fez -- --user-id=G-4568-3493 --password='…' --secret-key='…'
 *
 * THE SECRET KEY IS OPTIONAL. Fez hands the org's own key back at sign-in
 * (`orgDetails['secret-key']`) and the client uses that when it has nothing
 * else, so supplying one only pins it — which is worth doing when you want to
 * prove the exact key a deployment would carry.
 *
 * ═══ PUTTING THEM ON VERCEL: `--push` ═══
 *
 *   npm run probe:fez -- --prod --push
 *
 * Adds FEZ_USER_ID, FEZ_PASSWORD, FEZ_BASE_URL (and FEZ_SECRET_KEY if you
 * pinned one) to the Vercel project — but ONLY AFTER the probe above signed in
 * and priced a parcel, so a credential that does not work can never be stored.
 * That ordering is the whole reason this lives in the probe rather than in a
 * script of its own.
 *
 * WHERE THEY LAND FOLLOWS WHICH FEZ YOU PROVED:
 *
 *   --prod  →  Vercel `production`
 *   --dev   →  Vercel `preview` + `development`
 *
 * and never both sides, so a live courier credential cannot end up where a PR
 * preview would pick it up and book a real dispatch rider.
 *
 * `--push-check` prints what it would set and writes nothing. Values go to the
 * CLI on stdin, never in `argv`, so nothing reaches shell history or `ps`.
 * Vercel bakes env vars AT BUILD TIME, so a push changes nothing until the
 * next deploy.
 *
 * The international catalogue — every country Fez exports to from Nigeria and
 * the weight brackets it sells — is printed on every run; it is a read.
 *
 * Other flags: `--state=Abuja`, `--weight=2.5`, `--states` (print every state
 * Fez ships to rather than just the count).
 *
 * Exit code is 0 when Fez accepted the credentials, 1 when it did not — so it
 * is usable as a check and not only as something to read.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createFezProvider } from '../server/shop/logistics/fez/adapter';
import { FEZ_LIVE_URL, FEZ_SANDBOX_URL, type FezEnv } from '../server/shop/logistics/config';
import { LogisticsError, type LogisticsProvider, type QuoteOption } from '../server/shop/logistics/port';

/** `--name=value`, or null when absent. An empty value is absent — a blank
 *  flag is a mistake, never an instruction to sign in as nobody. */
function flag(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const value = hit?.slice(name.length + 3).trim();
  return value ? value : null;
}

const has = (name: string): boolean => process.argv.includes(`--${name}`);

/**
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │  PASTE CREDENTIALS HERE FOR A QUICK TEST — AND TAKE THEM OUT AGAIN.   │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * Left empty on purpose, and it must go back to empty before you commit.
 * THIS FILE IS TRACKED: unlike `.fez.env`, which is gitignored, anything left
 * in here is one `git add scripts/probe-fez.ts` away from the repo's history,
 * where a password does not come back out — the project has rewritten history
 * with `filter-branch` once already, and `.prod.env` was committed once by an
 * unrelated `git add -A`.
 *
 * Anything the environment or a flag supplies WINS over what is written here,
 * so filling `.fez.env` in does not mean emptying this block first.
 */
const PASTE = {
  /** Fez's own admin user id, shaped like `G-4568-3493`. Not your email. */
  userId: '',
  password: '',
  /** Developers → Manage Keys on the Fez portal. Optional — see `secretKey` below. */
  secretKey: '',
};

/** THE TWO FEZ ENVIRONMENTS, and there are only two. `dev` is Fez's own word
 *  for the sandbox in their docs ("Development Base URL"); `sandbox` is the
 *  word the rest of this codebase uses, and both are accepted so nobody has to
 *  remember which side of the fence they are standing on. */
const HOSTS = {
  dev: FEZ_SANDBOX_URL,
  sandbox: FEZ_SANDBOX_URL,
  prod: FEZ_LIVE_URL,
  live: FEZ_LIVE_URL,
} as const;

type HostName = keyof typeof HOSTS;

/**
 * Which Fez to talk to. THE DEFAULT IS THE SANDBOX AND ONLY AN EXPLICIT WORD
 * CHANGES IT, matching `config.ts`'s rule that a forgotten variable can never
 * reach the real courier.
 *
 * An explicit choice BEATS an inherited `FEZ_BASE_URL` rather than losing to
 * it: a shell — or a `.fez.env` — that already exports the sandbox URL must
 * not quietly turn `--prod` back into a sandbox run. `FEZ_BASE_URL` is still
 * honoured when you name no environment at all, which is what makes
 * `npx tsx --env-file=.prod.env …` behave like the deployment it came from.
 */
function baseUrlFrom(): string {
  const named = (flag('env') ?? (['prod', 'live', 'dev', 'sandbox'] as const).find((n) => has(n))) as
    | HostName
    | undefined;
  if (named) {
    const url = HOSTS[named];
    if (!url) throw new Error(`--env must be one of ${Object.keys(HOSTS).join(', ')}, got "${named}"`);
    return url;
  }
  return process.env.FEZ_BASE_URL?.trim() || FEZ_SANDBOX_URL;
}

const first = (...values: (string | null | undefined)[]): string | null => {
  for (const v of values) if (v && v.trim() !== '') return v.trim();
  return null;
};

function env(): FezEnv {
  /* Order everywhere: the flag you just typed, then the environment, then the
     block above — most deliberate first, so a paste left in by accident can
     never override the file you meant to use. */
  const userId = first(flag('user-id'), process.env.FEZ_USER_ID, PASTE.userId);
  const password = first(flag('password'), process.env.FEZ_PASSWORD, PASTE.password);
  if (!userId || !password) {
    throw new Error(
      'Need a user id and password. Pass --user-id=… --password=…, put FEZ_USER_ID and\n' +
        'FEZ_PASSWORD in .fez.env (which `npm run probe:fez` loads on its own), or fill in\n' +
        'the PASTE block near the top of scripts/probe-fez.ts.',
    );
  }
  return {
    userId,
    password,
    /* NULL IS A WORKING ANSWER, not a missing one: Fez returns the org's key as
       `orgDetails['secret-key']` at sign-in and the client uses that when it
       has nothing else. Supplying one only pins it. */
    secretKey: first(flag('secret-key'), process.env.FEZ_SECRET_KEY, PASTE.secretKey),
    baseUrl: baseUrlFrom(),
  };
}

const naira = (minor: number): string => `₦${(minor / 100).toLocaleString('en-NG')}`;

/**
 * WHERE FEZ WILL CARRY TO OUTSIDE NIGERIA, AND HOW HEAVY A PARCEL MAY BE.
 *
 * THIS EXISTS BECAUSE THE PUBLISHED DOCUMENTATION CONTRADICTS ITSELF. Its
 * sample response lists exactly one weight bracket (`0 - 2` kg) while its own
 * example request posts `weightId: 5`, an id that cannot exist in that list.
 * Since a destination row is a country AND a bracket ("Ghana(0-2kg)"), the
 * difference between those two readings is the difference between an
 * international channel that can carry one spool and one that can carry a
 * boxful — so it is not a detail to design around, and only a real account can
 * answer it.
 *
 * A READ, AND IT BOOKS NOTHING, like everything else this script does.
 */
async function reportExports(provider: LogisticsProvider): Promise<void> {
  console.log('');
  if (!provider.exports) {
    console.log('· This courier has no international arm.');
    return;
  }
  let cat;
  try {
    cat = await provider.exports.catalogue();
  } catch (err) {
    /* NOT FATAL. The credentials have already proven themselves above; an
       account without the international product switched on is a fact to
       report, not a failed probe. */
    console.log(`· GET /orders/export-locations — ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  console.log(`✓ GET /orders/export-locations — ${cat.destinations.length} destinations, ${cat.weights.length} weight bracket(s).`);
  console.log('');
  console.log('    WEIGHT BRACKETS (this is the number that decides what can ship)');
  for (const w of cat.weights) {
    console.log(`      id ${String(w.id).padEnd(4)} ${w.name.padEnd(12)} ${w.maxKg === null ? '(no ceiling published)' : `up to ${w.maxKg} kg`}`);
  }
  const ceiling = cat.weights.reduce<number | null>(
    (best, w) => (w.maxKg === null ? best : best === null || w.maxKg > best ? w.maxKg : best),
    null,
  );
  console.log(
    ceiling === null
      ? '      → no ceiling published on any bracket.'
      : `      → heaviest bracket tops out at ${ceiling} kg.`,
  );

  console.log('');
  console.log('    DESTINATIONS');
  for (const d of cat.destinations) {
    const bracket = d.maxKg === null ? '' : `  [${d.minKg ?? 0}-${d.maxKg}kg]`;
    const codes = d.countryCodes.length ? d.countryCodes.join(',') : 'UNMAPPED — add it to COUNTRY_CODES in fez/exports.ts';
    console.log(`      id ${String(d.id).padEnd(4)} ${d.place.padEnd(24)}${bracket.padEnd(12)} ${codes}`);
  }

  const unmapped = cat.destinations.filter((d) => d.countryCodes.length === 0);
  if (unmapped.length > 0) {
    console.log('');
    console.log(`    ⚠ ${unmapped.length} destination(s) have no country code and would be offered to nobody.`);
  }
}

async function main(): Promise<void> {
  const fez = env();
  const provider = createFezProvider(fez);
  const where = provider.diagnostics?.environment ?? 'sandbox';

  /* `environment` is read off the base URL by the adapter itself rather than
     from the flag, so what prints is where the calls are actually going. */
  console.log(`Fez Delivery — ${where === 'live' ? 'PROD' : 'dev'} (${fez.baseUrl})`);
  console.log(`user id      ${fez.userId}`);
  console.log(`secret key   ${fez.secretKey ? `pinned, ending …${fez.secretKey.slice(-4)}` : 'to be learned from the sign-in'}`);
  /* Loud, because a credential in a TRACKED file is the one that gets
     committed by accident. */
  if (PASTE.userId || PASTE.password || PASTE.secretKey) {
    console.log('⚠ Using the PASTE block in this script — empty it before you commit.');
  }
  console.log('');

  /* The sign-in is not probed on its own: `ping()` IS the sign-in plus one
     authenticated call, which is the only thing that proves the secret-key
     header too. A token that works and a key that does not is a real state,
     and it fails here rather than on a customer's order. */
  const state = flag('state') ?? 'Lagos';
  const weight = Number(flag('weight') ?? '1');
  if (!Number.isFinite(weight) || weight <= 0) throw new Error(`--weight must be a positive number, got "${flag('weight')}"`);

  const probe = await provider.diagnostics!.ping();
  const amount = probe.amountMinor;
  console.log('✓ Signed in, and an authenticated call was accepted.');
  console.log(
    `  POST /order/cost — ${probe.state}, ${probe.weightKg}kg → ` +
      (typeof amount === 'number' ? naira(amount) : 'no price in the response'),
  );

  /* A second call, because `ping()` fixes Lagos at 1kg on purpose — so that a
     refusal is about the credentials and not about the address. Having proved
     the credentials, this asks the question you actually came with. */
  if (state !== 'Lagos' || weight !== 1) {
    const quote = await quoteFor(provider, state, weight);
    console.log(`  ${state}, ${weight}kg → ${quote}`);
  }

  const places = await provider.places!.list('NG');
  const names = places.regions.map((r) => r.name);
  console.log(`✓ GET /states — ${names.length} states.`);
  if (has('states')) for (const name of names) console.log(`    ${name}`);
  else console.log(`    ${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …  (--states for all)' : ''}`);

  await reportExports(provider);

  console.log('');
  console.log(`These credentials work against ${where === 'live' ? 'PROD' : 'dev'}.`);

  if (has('push')) await push(fez, where);
  else if (has('push-check')) await push(fez, where, true);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * PUTTING THE CREDENTIALS ON VERCEL — ONLY ONES THAT JUST WORKED.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** deploy.ts's rule 3, for the same reason: the CLI does not resolve
 *  `.vercel/project.json`'s orgId to this slug on its own, and WRITES fail
 *  without it while READS succeed — so the `Not authorized` you get looks like
 *  a broken session and is not. */
const SCOPE = 'nattys-projects-05ebc986';

/**
 * WHICH VERCEL ENVIRONMENTS EACH FEZ HOST GOES TO.
 *
 * Live goes to `production` ALONE, and sandbox to `preview` and `development`
 * — never both sides. That mapping is the whole safety property here: it makes
 * it impossible to put a live courier credential where a preview build will
 * pick it up, which is the mistake that ends with a PR preview booking a real
 * dispatch rider. `admin.dev.plaspool.com` is a Preview deployment, so the dev
 * host reads the sandbox pair, which is what it should.
 */
const TARGETS: Record<'live' | 'sandbox', string[]> = {
  live: ['production'],
  sandbox: ['preview', 'development'],
};

/**
 * The linked root. `.vercel/` is gitignored, so THIS WORKTREE HAS NONE and a
 * `vercel env add` run from here would prompt to create a new project rather
 * than write to ours. deploy.ts copies the directory into its clone; there is
 * nothing to clone here, so we simply run the CLI from the main checkout,
 * which is where the link lives.
 */
function linkedRoot(): string {
  const gitDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  }).trim();
  const root = path.dirname(gitDir);
  if (!existsSync(path.join(root, '.vercel', 'project.json'))) {
    throw new Error(`No .vercel/project.json under ${root} — that tree is not linked to the Vercel project.`);
  }
  return root;
}

/**
 * One `vercel env add`. THE VALUE GOES IN ON STDIN AND NEVER INTO `argv`,
 * which is the point: an argument is visible in shell history and to anyone
 * who can run `ps`, and a Fez password reaching either of those is the thing
 * that made this run necessary in the first place.
 */
function vercelEnv(args: string[], cwd: string, value?: string): { ok: boolean; out: string } {
  /* `npx.cmd` RATHER THAN `shell: true`. Windows will not spawn a bare `npx`
     (it is a .cmd, not an .exe), and the obvious fix — `shell: true` — makes
     Node concatenate the arguments into a command line instead of passing them
     as a vector, which it warns about as DEP0190. Naming the real executable
     keeps the vector, so no argument is ever re-parsed by a shell. */
  const res = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vercel', 'env', ...args, '--scope', SCOPE], {
    cwd,
    input: value === undefined ? undefined : `${value}\n`,
    encoding: 'utf8',
  });
  return { ok: res.status === 0, out: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
}

async function push(fez: FezEnv, where: 'live' | 'sandbox', dryRun = false): Promise<void> {
  const targets = TARGETS[where];
  const root = linkedRoot();

  /* FEZ_BASE_URL IS PUSHED EXPLICITLY AND IS NOT OPTIONAL, because its default
     is the sandbox: a production deployment missing this variable talks to the
     sandbox and says nothing about it, which is the quietest possible way for
     a courier integration to be wrong. */
  const vars: { name: string; value: string; secret: boolean }[] = [
    { name: 'FEZ_USER_ID', value: fez.userId, secret: false },
    { name: 'FEZ_PASSWORD', value: fez.password, secret: true },
    { name: 'FEZ_BASE_URL', value: fez.baseUrl, secret: false },
  ];
  /* Only when one was PINNED. Fez hands the org's key back at sign-in, so
     pushing a learned one would store a copy of something the client already
     fetches for itself — a second place to rotate, for nothing. */
  if (fez.secretKey) vars.push({ name: 'FEZ_SECRET_KEY', value: fez.secretKey, secret: true });

  console.log('');
  console.log(`${dryRun ? 'Would set' : 'Setting'} on Vercel — ${targets.join(' + ')}:`);
  for (const v of vars) console.log(`  ${v.name.padEnd(16)} ${v.secret ? '••••••' : v.value}`);
  if (dryRun) {
    console.log('\n--push-check only. Re-run with --push to write.');
    return;
  }

  for (const target of targets) {
    for (const v of vars) {
      /* `vercel env add` REFUSES a name that already exists rather than
         replacing it, so a re-run after a rotation would do nothing and report
         nothing worth reading. Removing first makes this idempotent; the
         removal is allowed to fail, because "it was not there" is the ordinary
         first-run case and not an error. */
      vercelEnv(['rm', v.name, target, '--yes'], root);
      const add = vercelEnv(['add', v.name, target], root, v.value);
      if (!add.ok) {
        /* NEVER the value, and never `add.out` blindly — the CLI echoes what
           it was given on some failures. The name and the target are enough to
           act on. */
        throw new Error(`vercel env add ${v.name} ${target} failed. Run it by hand from ${root}.`);
      }
      console.log(`  ✓ ${v.name} → ${target}`);
    }
  }

  console.log('');
  console.log('Set. NOTHING CHANGES UNTIL THE NEXT DEPLOY — Vercel bakes env vars at build');
  console.log(`time, so ${where === 'live' ? 'npm run deploy:prod' : 'npm run deploy:dev'} is what makes these take effect.`);
}

/**
 * A price for a state and weight of your choosing, through the adapter's own
 * `quote()` — the same call a real order takes, so a state Fez refuses refuses
 * here for the same reason and in the same words.
 *
 * `from` IS NULL, and that is not a gap. Fez collects from the address held in
 * their portal, so it prices a drop-off state and a weight; `diagnostics.ts`
 * says the same where it declines to demand a ship-from for a Fez quote.
 */
async function quoteFor(
  provider: LogisticsProvider,
  state: string,
  weightKg: number,
): Promise<string> {
  const reference = 'probe_fez';
  const quote = await provider.quote({
    fulfillmentId: reference,
    orderNumber: reference,
    to: {
      name: 'Fez probe',
      phone: null,
      email: null,
      line1: 'Probe address',
      line2: null,
      city: state,
      region: state,
      postalCode: null,
      countryCode: 'NG',
      /* No routing city: this asks about the state you TYPED, which is the
         only reason to pass --state at all. */
      routingCity: null,
    },
    from: null,
    items: [
      {
        orderLineId: reference,
        variantId: reference,
        title: 'Fez probe parcel',
        sku: 'PROBE',
        qty: 1,
        unitMinor: 100_000,
        weightGrams: Math.round(weightKg * 1000),
      },
    ],
    valueMinor: 100_000,
    packaging: { name: 'Probe box', lengthCm: 20, widthCm: 20, heightCm: 10, weightKg },
    packagingRef: null,
  });
  const cheapest = quote.options.reduce<QuoteOption | null>(
    (best, o) => (best === null || o.amountMinor < best.amountMinor ? o : best),
    null,
  );
  if (!cheapest) return 'Fez returned no options';
  const rest = quote.options.length > 1 ? ` (${quote.options.length} options)` : '';
  return `${naira(cheapest.amountMinor)} — ${cheapest.label}${cheapest.eta ? `, ${cheapest.eta}` : ''}${rest}`;
}

main().catch((err: unknown) => {
  if (err instanceof LogisticsError) {
    console.error(`✗ ${err.code}: ${err.message}`);
    if (err.status) console.error(`  HTTP ${err.status}`);
    /* Fez's own words about OUR request. `client.ts` guarantees no credential
       reaches a thrown message, so this is safe to print. */
    if (err.detail) console.error(`  ${JSON.stringify(err.detail)}`);
    if (err.code === 'not_configured') {
      console.error('  Fez did not return a secret key at sign-in — set FEZ_SECRET_KEY (Developers → Manage Keys).');
    }
  } else {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exitCode = 1;
});

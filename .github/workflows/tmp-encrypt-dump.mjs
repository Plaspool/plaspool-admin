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

function loadUrl() {
  const found = CANDIDATES.filter((p) => existsSync(p));
  for (const p of found) {
    const text = readFileSync(p, 'utf8');
    const m = text.match(/^DATABASE_URL=(.*)$/m);
    if (!m) continue;
    let v = m[1].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (v.length > 0) return v;
  }
  throw new Error(
    `DATABASE_URL not found. Present files: ${found.join(', ') || '(none)'}`,
  );
}

const url = loadUrl();
try {
  const host = new URL(url.replace(/^postgres(ql)?:/, 'http:')).hostname;
  console.log(`dumping host=${host}`);
} catch {
  console.log('dumping host=(unparseable)');
}

const dump = spawnSync(
  'pg_dump',
  [url, '--no-owner', '--no-privileges', '--format=custom', '--file=neon.dump'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
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

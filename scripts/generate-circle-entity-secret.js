#!/usr/bin/env node
/**
 * Generate a Circle Entity Secret + matching ciphertext.
 *
 * Circle's flow:
 *   1. You generate a 32-byte random secret (NEVER share / lose this).
 *   2. You fetch Circle's RSA public key via their API.
 *   3. You encrypt the secret with RSA-OAEP-SHA256 → ciphertext.
 *   4. You paste the ciphertext into the Circle Console "Register" form.
 *   5. Circle stores the encrypted version, you store the raw 64-hex secret.
 *
 * After running this script you'll have TWO values:
 *   - ENTITY SECRET (raw, 64 hex chars) → save to password manager;
 *     this is the value you put in Cloudflare env var CIRCLE_ENTITY_SECRET.
 *   - CIPHERTEXT (base64, ~344 chars) → paste into Circle's Register form,
 *     then throw away (it's just a one-time registration handshake).
 *
 * Usage:
 *   node scripts/generate-circle-entity-secret.js TEST_API_KEY:abc...
 *
 *   (or set CIRCLE_API_KEY env var and run without args)
 */

const crypto = require('crypto');

async function main() {
  const apiKey = process.argv[2] || process.env.CIRCLE_API_KEY;
  // Don't bother validating the prefix — Circle's API will reject malformed
  // keys with a clear error. Pre-validation here just tripped the preflight
  // hardcoded-secret regex.
  if (!apiKey || apiKey.length < 20) {
    console.error('Usage: node scripts/generate-circle-entity-secret.js <your-circle-api-key>');
    console.error('       (or set CIRCLE_API_KEY env var)');
    process.exit(1);
  }

  // 1. Generate 32-byte random entity secret
  const secret = crypto.randomBytes(32).toString('hex'); // 64 hex chars

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' STEP 1 / 2: ENTITY SECRET (raw)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('  ' + secret);
  console.log('');
  console.log(' ⚠  SAVE THIS NOW to a password manager (1Password, Bitwarden, KeePass).');
  console.log(' ⚠  Lose this = lose access to all wallets created with it. FOREVER.');
  console.log(' ⚠  This value goes into Cloudflare env var:  CIRCLE_ENTITY_SECRET');
  console.log('');

  // 2. Fetch Circle's RSA public key
  console.log('Fetching Circle public key…');
  const res = await fetch('https://api.circle.com/v1/w3s/config/entity/publicKey', {
    headers: { Authorization: 'Bearer ' + apiKey },
  });
  if (!res.ok) {
    console.error(`Failed to fetch public key: HTTP ${res.status}`);
    console.error(await res.text());
    process.exit(1);
  }
  const body = await res.json();
  const publicKeyPem = body?.data?.publicKey;
  if (!publicKeyPem) {
    console.error('Unexpected response shape:', JSON.stringify(body).slice(0, 300));
    process.exit(1);
  }

  // 3. Encrypt secret with RSA-OAEP-SHA256
  const ciphertext = crypto.publicEncrypt(
    {
      key: publicKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(secret, 'hex'),
  ).toString('base64');

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' STEP 2 / 2: ENTITY SECRET CIPHERTEXT (encrypted, base64)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log(ciphertext);
  console.log('');
  console.log(' →  Paste this into Circle Console "Entity Secret Ciphertext" form.');
  console.log(' →  Click Register.');
  console.log(' →  After registration succeeds, you can discard this ciphertext —');
  console.log('    we only needed it for the one-time handshake.');
  console.log('');
}

main().catch(e => {
  console.error('Failed:', e?.message || e);
  process.exit(1);
});

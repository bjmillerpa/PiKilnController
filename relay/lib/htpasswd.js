'use strict';
//
// APR1-MD5 (Apache htpasswd) password verification.
//
// htpasswd files entry format:  <user>:<hash>
// APR1-MD5 hash format:         $apr1$<salt>$<encoded-digest>
//
// Implements the algorithm from Apache's md5_crypt() so we can verify an
// existing htpasswd file from the relay without adding an npm dep. Used
// by the cookie-auth flow on login.

const fs = require('fs');
const crypto = require('crypto');

const APR1_ALPHABET = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function md5(buf) {
  return crypto.createHash('md5').update(buf).digest();
}

// Base64-like encoder used by APR1: emits `length` chars LSB-first using the
// alphabet above. Used to pack the final 16-byte MD5 digest into a 22-char
// string in a specific byte-interleaved order.
function to64(value, length) {
  let out = '';
  while (--length >= 0) {
    out += APR1_ALPHABET[value & 0x3f];
    value >>>= 6;
  }
  return out;
}

// Returns the APR1-MD5 hash of (password, salt) in the standard
// "$apr1$<salt>$<encoded>" form.
function apr1Hash(password, salt) {
  const pw   = Buffer.from(password, 'utf8');
  const slt  = Buffer.from(salt,     'utf8');
  const magic = Buffer.from('$apr1$', 'utf8');

  // Step 1: ctx ← password + magic + salt
  let ctx = Buffer.concat([pw, magic, slt]);

  // Step 2: alt ← MD5(password + salt + password)
  const alt = md5(Buffer.concat([pw, slt, pw]));

  // Step 3: append `alt` (or first pl bytes of it) to ctx for each 16-byte
  // block of the password's length.
  for (let pl = pw.length; pl > 0; pl -= 16) {
    ctx = Buffer.concat([ctx, alt.subarray(0, Math.min(pl, 16))]);
  }

  // Step 4: for each bit of pw.length, append either 0x00 or password[0].
  for (let i = pw.length; i; i >>>= 1) {
    ctx = (i & 1)
      ? Buffer.concat([ctx, Buffer.from([0])])
      : Buffer.concat([ctx, pw.subarray(0, 1)]);
  }

  // Step 5: 1000 rounds of mixing.
  let digest = md5(ctx);
  for (let i = 0; i < 1000; i++) {
    let block = (i & 1) ? Buffer.from(pw) : Buffer.from(digest);
    if (i % 3)        block = Buffer.concat([block, slt]);
    if (i % 7)        block = Buffer.concat([block, pw]);
    block = (i & 1)
      ? Buffer.concat([block, digest])
      : Buffer.concat([block, pw]);
    digest = md5(block);
  }

  // Step 6: encode the 16-byte digest with the APR1-specific byte order.
  let out = '$apr1$' + salt + '$';
  out += to64((digest[0]  << 16) | (digest[6]  << 8) | digest[12], 4);
  out += to64((digest[1]  << 16) | (digest[7]  << 8) | digest[13], 4);
  out += to64((digest[2]  << 16) | (digest[8]  << 8) | digest[14], 4);
  out += to64((digest[3]  << 16) | (digest[9]  << 8) | digest[15], 4);
  out += to64((digest[4]  << 16) | (digest[10] << 8) | digest[5],  4);
  out += to64( digest[11], 2);
  return out;
}

// Constant-time hash compare so attackers can't measure response timing to
// recover the hash byte-by-byte.
function timingSafeEqualStrings(a, b) {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Verify password against an APR1-MD5 hash. Returns false for any malformed
// or non-apr1 hash (we don't currently support bcrypt or SHA variants).
function verifyApr1(password, hash) {
  const m = /^\$apr1\$([^$]+)\$/.exec(hash);
  if (!m) return false;
  const salt = m[1];
  return timingSafeEqualStrings(apr1Hash(password, salt), hash);
}

// Parse an htpasswd file. Returns a Map<user, hash>. Comments and blank
// lines are skipped. Non-apr1 hashes are kept (so a future support add
// works) but verify() will currently reject them.
function loadHtpasswd(filepath) {
  const out = new Map();
  let raw;
  try { raw = fs.readFileSync(filepath, 'utf8'); }
  catch (e) { return out; }
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const idx = s.indexOf(':');
    if (idx < 0) continue;
    out.set(s.slice(0, idx), s.slice(idx + 1));
  }
  return out;
}

// Verify (user, password) against an htpasswd Map. Returns true iff the user
// exists AND the password verifies against the stored hash.
function verifyCredentials(htpasswd, user, password) {
  if (!user || !password) return false;
  const hash = htpasswd.get(user);
  if (!hash) {
    // Still do an apr1 with a dummy hash to avoid leaking "user doesn't
    // exist" via response timing.
    apr1Hash(password, 'XXXXXXXX');
    return false;
  }
  return verifyApr1(password, hash);
}

module.exports = { apr1Hash, verifyApr1, loadHtpasswd, verifyCredentials };

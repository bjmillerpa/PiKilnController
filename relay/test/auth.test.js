'use strict';
//
// Tests for the relay's browser auth: APR1-MD5 (Apache htpasswd) verification
// + signed session cookies. Run with `node --test test/*.test.js`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { apr1Hash, verifyApr1, loadHtpasswd, verifyCredentials } = require('../lib/htpasswd');
const session = require('../lib/session');

// ── APR1-MD5 ──────────────────────────────────────────────────────────

test('apr1Hash matches openssl passwd -apr1 output (fixed salt)', () => {
  // Output verified against `openssl passwd -apr1 -salt ab12cd34 TestPass1234`
  assert.equal(apr1Hash('TestPass1234', 'ab12cd34'),
    '$apr1$ab12cd34$5NDF33eobl4VIoyiG6J/O1');
});

test('apr1Hash deterministic for short passwords', () => {
  assert.equal(apr1Hash('a',  'salt'), apr1Hash('a',  'salt'));
  assert.equal(apr1Hash('ab', 'salt'), apr1Hash('ab', 'salt'));
});

test('apr1Hash differs on different salts', () => {
  assert.notEqual(apr1Hash('hello', 'aaaa'), apr1Hash('hello', 'bbbb'));
});

test('verifyApr1 round-trip', () => {
  const hash = apr1Hash('correcthorsebatterystaple', 'XyZ7qrSt');
  assert.equal(verifyApr1('correcthorsebatterystaple', hash), true);
  assert.equal(verifyApr1('wrong-password',            hash), false);
  assert.equal(verifyApr1('',                          hash), false);
});

test('verifyApr1 rejects non-apr1 hash formats', () => {
  // bcrypt, sha-crypt, plain — we only support apr1 currently
  assert.equal(verifyApr1('p', '$2y$10$abc'), false);
  assert.equal(verifyApr1('p', '$5$rounds$abc'), false);
  assert.equal(verifyApr1('p', 'plaintext'), false);
  assert.equal(verifyApr1('p', ''), false);
});

test('loadHtpasswd parses single-user file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'htpw-'));
  const fp = path.join(dir, 'pw');
  fs.writeFileSync(fp, 'alice:$apr1$saltyboy$abcdef\n');
  try {
    const m = loadHtpasswd(fp);
    assert.equal(m.size, 1);
    assert.equal(m.get('alice'), '$apr1$saltyboy$abcdef');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('loadHtpasswd ignores blanks + comments', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'htpw-'));
  const fp = path.join(dir, 'pw');
  fs.writeFileSync(fp, '# a comment\n\ntestuser:$apr1$x$y\n# another\n');
  try {
    const m = loadHtpasswd(fp);
    assert.equal(m.size, 1);
    assert.equal(m.get('testuser'), '$apr1$x$y');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('loadHtpasswd returns empty map on missing file', () => {
  const m = loadHtpasswd('/no/such/file');
  assert.equal(m.size, 0);
});

test('verifyCredentials full flow', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'htpw-'));
  const fp = path.join(dir, 'pw');
  const hash = apr1Hash('s3cret', 'aabbccdd');
  fs.writeFileSync(fp, `testuser:${hash}\n`);
  try {
    const m = loadHtpasswd(fp);
    assert.equal(verifyCredentials(m, 'testuser', 's3cret'), true);
    assert.equal(verifyCredentials(m, 'testuser', 'wrong'),  false);
    assert.equal(verifyCredentials(m, 'unknown', 's3cret'),  false);
    assert.equal(verifyCredentials(m, '', 's3cret'),         false);
    assert.equal(verifyCredentials(m, 'testuser', ''),       false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── Session cookies ──────────────────────────────────────────────────

test('session sign/verify round-trip', () => {
  const key = session.deriveKey('test-token-' + 'x'.repeat(40));
  const payload = session.makeSession('testuser');
  const tok = session.sign(payload, key);
  const got = session.verify(tok, key);
  assert.ok(got);
  assert.equal(got.u, 'testuser');
  assert.ok(got.exp > Date.now());
});

test('session verify rejects tampered signature', () => {
  const key = session.deriveKey('test-token');
  const tok = session.sign(session.makeSession('testuser'), key);
  // flip a byte in the signature half
  const [pl, sig] = tok.split('.');
  const flipped = pl + '.' + (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
  assert.equal(session.verify(flipped, key), null);
});

test('session verify rejects tampered payload', () => {
  const key = session.deriveKey('test-token');
  const tok = session.sign(session.makeSession('testuser'), key);
  const [pl, sig] = tok.split('.');
  // Change the payload (replace first char); signature won't match
  const fakePayload = (pl[0] === 'A' ? 'B' : 'A') + pl.slice(1);
  assert.equal(session.verify(fakePayload + '.' + sig, key), null);
});

test('session verify rejects expired token', () => {
  const key = session.deriveKey('test-token');
  const expired = { u: 'testuser', iat: Date.now() - 1000, exp: Date.now() - 1 };
  const tok = session.sign(expired, key);
  assert.equal(session.verify(tok, key), null);
});

test('session verify rejects token signed with different key', () => {
  const tok = session.sign(session.makeSession('testuser'),
    session.deriveKey('token-A'));
  assert.equal(session.verify(tok, session.deriveKey('token-B')), null);
});

test('session readCookie picks our cookie out of a multi-cookie header', () => {
  const req = { headers: { cookie: 'a=1; kiln_session=foo.bar; b=2' } };
  assert.equal(session.readCookie(req), 'foo.bar');
});

test('session readCookie returns null when our cookie absent', () => {
  assert.equal(session.readCookie({ headers: { cookie: 'a=1; b=2' } }), null);
  assert.equal(session.readCookie({ headers: {} }), null);
  assert.equal(session.readCookie({ headers: { cookie: '' } }), null);
});

test('setCookieHeader includes the security attributes we expect', () => {
  const h = session.setCookieHeader('TOK', { secure: true, ttlMs: 1000 });
  assert.match(h, /^kiln_session=TOK; /);
  assert.match(h, /\bPath=\//);
  assert.match(h, /\bHttpOnly\b/);
  assert.match(h, /\bSameSite=Lax\b/);
  assert.match(h, /\bMax-Age=1\b/);
  assert.match(h, /\bSecure\b/);
});

test('clearCookieHeader expires immediately', () => {
  const h = session.clearCookieHeader();
  assert.match(h, /^kiln_session=;/);
  assert.match(h, /\bMax-Age=0\b/);
});

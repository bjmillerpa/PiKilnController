'use strict';
//
// Signed session cookies for the relay's browser auth.
//
// Format: `<base64url(payload-json)>.<base64url(hmac-sha256)>`
// Payload: { u: <user>, iat: <epoch-ms>, exp: <epoch-ms> }
//
// We sign with a key derived from KILN_RELAY_TOKEN so the secret is stable
// across restarts without needing extra config — and stays out of git/.env.
// Compromise of the relay token implies compromise of the secret, which is
// fine because they protect the same surface.

const crypto = require('crypto');

const COOKIE_NAME = 'kiln_session';
const DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function deriveKey(relayToken) {
  // Domain-separate from the controller token so a leak of the cookie HMAC
  // doesn't trivially give an attacker a usable controller token (and vice
  // versa).
  return crypto.createHash('sha256')
    .update('kiln-relay-session-v1:' + relayToken)
    .digest();
}

function sign(payload, key) {
  const json = JSON.stringify(payload);
  const payloadEnc = b64urlEncode(Buffer.from(json, 'utf8'));
  const mac = crypto.createHmac('sha256', key).update(payloadEnc).digest();
  return payloadEnc + '.' + b64urlEncode(mac);
}

// Returns the verified payload or null if anything's wrong.
function verify(token, key) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadEnc, sigEnc] = token.split('.', 2);
  let expected;
  try {
    expected = crypto.createHmac('sha256', key).update(payloadEnc).digest();
  } catch { return null; }
  let got;
  try { got = b64urlDecode(sigEnc); } catch { return null; }
  if (expected.length !== got.length) return null;
  if (!crypto.timingSafeEqual(expected, got)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(payloadEnc).toString('utf8')); }
  catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

function makeSession(user, ttlMs = DEFAULT_TTL_MS) {
  const now = Date.now();
  return { u: user, iat: now, exp: now + ttlMs };
}

// Build a Set-Cookie header value. Always HttpOnly + SameSite=Lax. Adds
// Secure when `secure: true` (we always pass true in production — the relay
// only serves over HTTPS via Traefik).
function setCookieHeader(token, { secure = true, ttlMs = DEFAULT_TTL_MS } = {}) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearCookieHeader({ secure = true } = {}) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// Pull our cookie value out of a request's Cookie header. Returns null if
// absent. Handles multiple cookies per header (`a=1; b=2`).
function readCookie(req) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  for (const piece of raw.split(';')) {
    const [k, ...rest] = piece.trim().split('=');
    if (k === COOKIE_NAME) return rest.join('=');
  }
  return null;
}

module.exports = {
  COOKIE_NAME, DEFAULT_TTL_MS,
  deriveKey, makeSession, sign, verify,
  setCookieHeader, clearCookieHeader, readCookie,
};

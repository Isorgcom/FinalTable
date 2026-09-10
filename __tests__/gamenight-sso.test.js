// __tests__/gamenight-sso.test.js - the GameNight token verifier, in isolation.
// A keypair is minted here and tokens are signed the way GameNight signs
// them (ES256, raw R||S), so every rejection path can be walked without an
// issuer running.
const crypto = require('crypto');
const { createGameNightVerifier } = require('../server/gamenight-sso');

const ISSUER = 'https://gamenight.example';
const AUDIENCE = 'finaltable';

function b64url(input) {
  return Buffer.from(typeof input === 'string' ? input : JSON.stringify(input)).toString(
    'base64url'
  );
}

function makeKeys() {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

let seq = 0;
function claimsAt(nowSec, overrides = {}) {
  seq += 1;
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: '42',
    iat: nowSec,
    exp: nowSec + 120,
    jti: `jti-${String(seq).padStart(12, '0')}-abcdef`,
    name: 'bryce',
    tier: 'Free',
    ...overrides,
  };
}

function sign(privateKey, claims, header = { typ: 'JWT', alg: 'ES256' }) {
  const input = `${b64url(header)}.${b64url(claims)}`;
  const sig = crypto.sign('sha256', Buffer.from(input), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${input}.${sig.toString('base64url')}`;
}

describe('GameNight token verifier', () => {
  const { publicKey, privateKey } = makeKeys();
  const nowSec = 1_800_000_000;
  let clock;
  let verifier;

  beforeEach(() => {
    clock = nowSec * 1000;
    verifier = createGameNightVerifier({
      publicKey,
      issuer: ISSUER,
      audience: AUDIENCE,
      now: () => clock,
    });
  });

  test('a good token yields its claims', () => {
    const result = verifier.verify(sign(privateKey, claimsAt(nowSec)));
    expect(result.ok).toBe(true);
    expect(result.claims).toMatchObject({ sub: '42', name: 'bryce', tier: 'Free', aud: AUDIENCE });
  });

  test('accepts a PEM string as the key', () => {
    const pem = publicKey.export({ type: 'spki', format: 'pem' });
    const v = createGameNightVerifier({
      publicKey: pem,
      issuer: ISSUER,
      audience: AUDIENCE,
      now: () => clock,
    });
    expect(v.verify(sign(privateKey, claimsAt(nowSec))).ok).toBe(true);
  });

  test('the same token is good once', () => {
    const token = sign(privateKey, claimsAt(nowSec));
    expect(verifier.verify(token).ok).toBe(true);
    expect(verifier.verify(token)).toEqual({ ok: false, reason: 'replayed' });
  });

  test('a token signed by somebody else is refused', () => {
    const other = makeKeys();
    expect(verifier.verify(sign(other.privateKey, claimsAt(nowSec)))).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  test('a tampered payload is refused', () => {
    const token = sign(privateKey, claimsAt(nowSec));
    const [h, , s] = token.split('.');
    const forged = `${h}.${b64url(claimsAt(nowSec, { sub: '1' }))}.${s}`;
    expect(verifier.verify(forged)).toEqual({ ok: false, reason: 'signature' });
  });

  test('alg none and HS256 are refused before the signature is looked at', () => {
    const claims = claimsAt(nowSec);
    const none = `${b64url({ alg: 'none' })}.${b64url(claims)}.`;
    expect(verifier.verify(none)).toEqual({ ok: false, reason: 'malformed' });
    const hmac = crypto
      .createHmac('sha256', publicKey.export({ type: 'spki', format: 'pem' }))
      .update(`${b64url({ alg: 'HS256' })}.${b64url(claims)}`)
      .digest('base64url');
    expect(verifier.verify(`${b64url({ alg: 'HS256' })}.${b64url(claims)}.${hmac}`)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  test('an expired token, and one from the future, are refused; skew is tolerated', () => {
    clock = (nowSec + 200) * 1000;
    expect(verifier.verify(sign(privateKey, claimsAt(nowSec)))).toEqual({
      ok: false,
      reason: 'expired',
    });
    clock = (nowSec + 150) * 1000; // 30s past exp, inside the 60s skew
    expect(verifier.verify(sign(privateKey, claimsAt(nowSec))).ok).toBe(true);
    clock = (nowSec - 120) * 1000;
    expect(verifier.verify(sign(privateKey, claimsAt(nowSec)))).toEqual({
      ok: false,
      reason: 'clock',
    });
  });

  test('a lifetime longer than the issuer ever grants is refused', () => {
    expect(verifier.verify(sign(privateKey, claimsAt(nowSec, { exp: nowSec + 86400 })))).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  test('wrong audience or issuer', () => {
    expect(verifier.verify(sign(privateKey, claimsAt(nowSec, { aud: 'other' })))).toEqual({
      ok: false,
      reason: 'audience',
    });
    expect(
      verifier.verify(sign(privateKey, claimsAt(nowSec, { iss: 'https://evil.example' })))
    ).toEqual({
      ok: false,
      reason: 'issuer',
    });
    expect(verifier.verify(sign(privateKey, claimsAt(nowSec, { aud: ['x', AUDIENCE] }))).ok).toBe(
      true
    );
  });

  test('a subject that is not a GameNight user id, a short jti, or no name', () => {
    for (const bad of [
      { sub: 'gn_1' },
      { sub: '' },
      { sub: 42 },
      { jti: 'short' },
      { name: '' },
      { name: 7 },
    ]) {
      expect(verifier.verify(sign(privateKey, claimsAt(nowSec, bad)))).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  test('garbage is malformed, not an exception', () => {
    for (const junk of [
      undefined,
      null,
      5,
      '',
      'a.b',
      'a.b.c',
      'a.b.c.d',
      `${b64url('[]')}.${b64url('{}')}.AAAA`,
    ]) {
      expect(verifier.verify(junk)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  test('the replay set forgets tokens once they have expired and stays bounded', () => {
    const small = createGameNightVerifier({
      publicKey,
      issuer: ISSUER,
      audience: AUDIENCE,
      now: () => clock,
      replayLimit: 3,
    });
    for (let i = 0; i < 5; i++)
      expect(small.verify(sign(privateKey, claimsAt(nowSec))).ok).toBe(true);
    expect(small.replaySize).toBeLessThanOrEqual(3);
    clock = (nowSec + 300) * 1000;
    small.verify(sign(privateKey, claimsAt(nowSec + 300)));
    expect(small.replaySize).toBe(1);
  });
});

// gamenight-sso.js - verifying the identity token GameNight hands a player.
//
// GameNight signs a short-lived JWT (ES256 over its own P-256 key) when a
// player who is logged in there asks to be seated here. All this server holds
// is the public key, so a token can be checked without a round trip and
// without either side sharing a secret: a leak here lets nobody mint one.
//
// Every check is local. A token is good for one use inside its two-minute
// window, so the replay set only ever holds the jtis of tokens that are
// still alive; anything older is pruned as it goes.

const crypto = require('crypto');

const SUB_RE = /^\d{1,12}$/;
const DEFAULT_SKEW_MS = 60 * 1000;
// GameNight issues two-minute tokens. Ten minutes is the ceiling on what will
// be believed, so a misconfigured issuer cannot hand out day-long ones.
const MAX_LIFETIME_SEC = 600;
const DEFAULT_REPLAY_LIMIT = 10000;

function decodeSegment(segment) {
  return Buffer.from(segment, 'base64url');
}

function parseJson(segment) {
  const parsed = JSON.parse(decodeSegment(segment).toString('utf8'));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

function createGameNightVerifier(options = {}) {
  const {
    publicKey,
    issuer,
    audience,
    now = Date.now,
    skewMs = DEFAULT_SKEW_MS,
    replayLimit = DEFAULT_REPLAY_LIMIT,
  } = options;
  if (!publicKey) throw new Error('createGameNightVerifier needs a publicKey');
  if (typeof issuer !== 'string' || !issuer)
    throw new Error('createGameNightVerifier needs an issuer');
  if (typeof audience !== 'string' || !audience) {
    throw new Error('createGameNightVerifier needs an audience');
  }
  const key = typeof publicKey === 'string' ? crypto.createPublicKey(publicKey) : publicKey;

  const seen = new Map(); // jti -> ms after which it can be forgotten

  function prune(nowMs) {
    for (const [jti, until] of seen) if (until <= nowMs) seen.delete(jti);
  }

  // A flood of valid tokens inside one window is not a thing that happens,
  // but the map must not be the one unbounded structure on the server.
  function bound() {
    while (seen.size > replayLimit) seen.delete(seen.keys().next().value);
  }

  const fail = (reason) => ({ ok: false, reason });

  function verify(token) {
    if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
      return fail('malformed');
    }
    const parts = token.split('.');
    if (parts.length !== 3) return fail('malformed');
    let header;
    let claims;
    try {
      header = parseJson(parts[0]);
      claims = parseJson(parts[1]);
    } catch (_err) {
      return fail('malformed');
    }
    if (!header || !claims) return fail('malformed');
    // The algorithm is ours to decide, not the token's. Anything else - and
    // "none" above all - is refused before the signature is even looked at.
    if (header.alg !== 'ES256') return fail('malformed');

    const signature = decodeSegment(parts[2]);
    if (signature.length !== 64) return fail('malformed');
    let valid = false;
    try {
      valid = crypto.verify(
        'sha256',
        Buffer.from(`${parts[0]}.${parts[1]}`),
        { key, dsaEncoding: 'ieee-p1363' },
        signature
      );
    } catch (_err) {
      valid = false;
    }
    if (!valid) return fail('signature');

    const nowMs = now();
    if (!Number.isInteger(claims.exp) || !Number.isInteger(claims.iat)) return fail('malformed');
    if (claims.exp - claims.iat > MAX_LIFETIME_SEC || claims.exp < claims.iat) {
      return fail('malformed');
    }
    if (claims.exp * 1000 + skewMs <= nowMs) return fail('expired');
    if (claims.iat * 1000 - skewMs > nowMs) return fail('clock');

    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(audience)) return fail('audience');
    if (claims.iss !== issuer) return fail('issuer');

    if (typeof claims.sub !== 'string' || !SUB_RE.test(claims.sub)) return fail('malformed');
    if (typeof claims.jti !== 'string' || claims.jti.length < 16 || claims.jti.length > 64) {
      return fail('malformed');
    }
    if (typeof claims.name !== 'string' || !claims.name.trim()) return fail('malformed');

    prune(nowMs);
    if (seen.has(claims.jti)) return fail('replayed');
    seen.set(claims.jti, claims.exp * 1000 + skewMs);
    bound();

    return {
      ok: true,
      claims: {
        sub: claims.sub,
        name: claims.name,
        tier: typeof claims.tier === 'string' ? claims.tier : null,
        iss: claims.iss,
        aud: audience,
        iat: claims.iat,
        exp: claims.exp,
        jti: claims.jti,
      },
    };
  }

  return {
    verify,
    get replaySize() {
      return seen.size;
    },
  };
}

module.exports = { createGameNightVerifier };

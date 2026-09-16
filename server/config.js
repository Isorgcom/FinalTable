const crypto = require('crypto');

function intFromEnv(name, fallback, min, max) {
  const value = parseInt(process.env[name], 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function boolFromEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

// The admin's password for the admin controls, straight from the
// environment and never written anywhere else. Empty or unset disables the
// admin surface completely rather than falling back to a default, because a
// default password on a self-hosted box is worse than no password at all.
function adminPasswordFromEnv() {
  const raw = process.env.ADMIN_PASSWORD;
  return typeof raw === 'string' ? raw.trim() : '';
}

// The GameNight sign-in bridge, as the environment describes it. A player
// logged in to GameNight can be seated here on a token GameNight signs; this
// server needs only the public key to check it. The admin normally pairs
// from the lobby's Admin page (server/gamenight-pairing.js), and these
// variables seed that the first time a box boots without a saved pairing.
// Both unset means no seed. One set without the other, or a key that does
// not parse, is a mistake worth stopping the boot for: the alternative is a
// sign-in button that silently does nothing.
function pemFromEnv(name) {
  const raw = process.env[name];
  if (typeof raw !== 'string') return '';
  // A .env line holds no line breaks, so the key is written with the two
  // characters "\n" where each break goes. A real newline is fine too.
  let pem = raw
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\n/g, '\n')
    .trim();
  if (!pem) return '';
  if (!pem.includes('-----BEGIN')) {
    const body = (pem.replace(/\s+/g, '').match(/.{1,64}/g) || []).join('\n');
    pem = `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
  }
  return pem;
}

function gamenightFromEnv() {
  const url = (process.env.GAMENIGHT_URL || '').trim().replace(/\/+$/, '');
  const pem = pemFromEnv('GAMENIGHT_PUBLIC_KEY');
  const audience = (process.env.GAMENIGHT_AUDIENCE || '').trim() || 'finaltable';
  if (!url && !pem) return null;
  if (!url || !pem) {
    throw new Error('GAMENIGHT_URL and GAMENIGHT_PUBLIC_KEY must be set together, or neither');
  }
  if (!/^https?:\/\/[^/\s]+/.test(url)) {
    throw new Error(`GAMENIGHT_URL must be an http(s) origin, got "${url}"`);
  }
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(pem);
  } catch (err) {
    throw new Error(`GAMENIGHT_PUBLIC_KEY is not a readable public key: ${err.message}`);
  }
  const details = publicKey.asymmetricKeyDetails || {};
  if (publicKey.asymmetricKeyType !== 'ec' || details.namedCurve !== 'prime256v1') {
    throw new Error('GAMENIGHT_PUBLIC_KEY must be a P-256 (prime256v1) EC public key');
  }
  return {
    issuer: url,
    connectUrl: `${url}/connect.php`,
    audience,
    publicKey,
    publicKeyPem: pem,
  };
}

function loadConfig() {
  const rawCorsOrigin = process.env.CORS_ORIGIN && process.env.CORS_ORIGIN.trim();
  const corsOrigin = rawCorsOrigin || '*';
  const socketCorsOrigin =
    corsOrigin === '*'
      ? '*'
      : corsOrigin
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean);

  return {
    adminPassword: adminPasswordFromEnv(),
    gamenight: gamenightFromEnv(),
    port: process.env.PORT || 2026,
    host: process.env.HOST || '0.0.0.0',
    logLevel: process.env.LOG_LEVEL || 'info',
    corsOrigin,
    socketCorsOrigin,
    trustProxy: boolFromEnv('TRUST_PROXY', false),
    maxWsConnections: intFromEnv('MAX_WS_CONNECTIONS', 200, 1, 5000),
    httpRateLimit: intFromEnv('HTTP_RATE_LIMIT', 240, 1, 10000),
    httpRateWindow: intFromEnv('HTTP_RATE_WINDOW_MS', 60000, 1000, 3600000),
    maxTournaments: intFromEnv('MAX_TOURNAMENTS', 8, 1, 100),
    // How long a finished tournament stays listed with its standings.
    tournamentFinishedTtlMs: intFromEnv('TOURNAMENT_FINISHED_TTL_MS', 600000, 100, 86400000),
    // How long a field held because its room emptied is kept before it is
    // written off. A held game deals nothing and nobody loses chips while it
    // waits, so this is hours: it exists to stop games nobody returns to from
    // sitting in the server's slots for ever, not to police stepping away.
    tournamentZombieHoldMs: intFromEnv('TOURNAMENT_ZOMBIE_HOLD_MS', 21600000, 100, 604800000),
    // The admin Log: how much of what the server has done is kept. Two bounds
    // rather than one - the age is what an admin thinks in, the count is what
    // stops a busy fortnight from mattering - and this is the only collection
    // here that is bounded and also written to disk.
    adminLogMaxRows: intFromEnv('ADMIN_LOG_MAX_ROWS', 2000, 10, 100000),
    adminLogMaxAgeMs: intFromEnv('ADMIN_LOG_MAX_AGE_MS', 7776000000, 60000, 31536000000),
    // How long after a sign-in row another one for the same person is worth
    // keeping. A row used to go in on every identify - every reload, every
    // reconnect - which buried the games. Zero writes one every time.
    adminLogSignInGapMs: intFromEnv('ADMIN_LOG_SIGNIN_GAP_MS', 3600000, 0, 86400000),
    // The registry's lifecycle sweep interval.
    tournamentSweepMs: intFromEnv('TOURNAMENT_SWEEP_MS', 1000, 20, 60000),
    hostTransferGraceMs: intFromEnv('HOST_TRANSFER_GRACE_MS', 120000, 100, 600000),
    // Chat. Off turns the surface off entirely rather than hiding the box, the
    // same way an empty ADMIN_PASSWORD removes the admin controls. The history
    // is per room - a table, or the waiting room before there are tables - and
    // is what a reload, a rejoin or a restart replays. The rate limit is a
    // fixed window per socket: enough to hold a conversation, not enough to
    // flood a table.
    chatEnabled: boolFromEnv('CHAT_ENABLED', true),
    chatHistory: intFromEnv('CHAT_HISTORY', 100, 0, 2000),
    chatMaxLength: intFromEnv('CHAT_MAX_LEN', 200, 20, 2000),
    chatRatePerWindow: intFromEnv('CHAT_RATE', 4, 1, 100),
    chatRateWindowMs: intFromEnv('CHAT_RATE_WINDOW_MS', 10000, 1000, 600000),
    // Reactions: a few emoji thrown at the table without typing. Off removes
    // the strip and the event, the same way as chat. The rate is tighter than
    // chat's because a reaction costs one tap.
    reactionsEnabled: boolFromEnv('REACTIONS_ENABLED', true),
    reactionRatePerWindow: intFromEnv('REACTION_RATE', 3, 1, 100),
    reactionRateWindowMs: intFromEnv('REACTION_RATE_WINDOW_MS', 10000, 1000, 600000),
    // Pacing. A betting round closing and the next street arriving in the same
    // frame is too fast to follow, so the table holds a beat between them, and
    // another between one hand and the next.
    streetPauseMs: intFromEnv('STREET_PAUSE_MS', 1600, 0, 15000),
    // The wait between one hand ending and the next being dealt. The director
    // only deals on its tick, so the felt sits idle for this plus up to one
    // tick - 3500 read as five seconds of nothing at the table.
    handPauseMs: intFromEnv('HAND_PAUSE_MS', 2000, 0, 60000),
    // How long the winner of a pot nobody contested has to turn a card over
    // before the table deals on. It is spent only when somebody is actually
    // deciding: showing or waving it off ends the wait at once. Zero switches
    // the whole offer off and the felt behaves as it did before it existed.
    showWindowMs: intFromEnv('SHOW_WINDOW_MS', 5000, 0, 60000),
  };
}

module.exports = { loadConfig };

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

// An account to make an administrator at boot, by name. There is no admin
// password any more - the admin surface belongs to an account - and this is
// how a server gets its first one when the first-account rule is not the
// answer: a stranger signed up before the owner did, or the only
// administrator has lost their password and their address.
//
// Applied on every boot and never taken away, so leaving it set is harmless
// and forgetting to unset it does nothing surprising.
function adminPromoteFromEnv() {
  const raw = process.env.ADMIN_PROMOTE;
  return typeof raw === 'string' ? raw.trim() : '';
}

// The word that claims a fresh server. Whoever opens the lobby and enters it
// makes the first account, which is the administrator - no mail needed, and
// nothing read out of a log. Read on every boot and honoured only while the
// server has no administrator, so leaving it set afterwards does nothing.
// Shorter than this is refused at boot rather than offered: the lobby is
// public, and a short word behind a rate limit is still a short word.
const CLAIM_TOKEN_MIN = 16;

function claimTokenFromEnv() {
  const raw = process.env.CLAIM_TOKEN;
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

// The mail settings as the environment describes them, in the shape the
// Admin page and the database use. This seeds a server's first boot and is
// not consulted again: the page's setting wins from then on, exactly as the
// GameNight pairing works.
//
// Deliberately different from gamenightFromEnv below in one way: it does not
// throw. A half-configured GameNight can stop a boot safely, because mail is
// the other way in. Mail has no other way in - a typo in SMTP_URL would turn
// a restart into a lockout on a server that was working five minutes ago - so
// a URL that will not parse is a warning and the rest of the seed still
// applies.
function mailFromEnv(reportProblem = () => {}) {
  const publicUrl = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const smtpUrl = (process.env.SMTP_URL || '').trim();
  const from = (process.env.MAIL_FROM || '').trim();
  const transport = (process.env.MAIL_TRANSPORT || '').trim().toLowerCase();
  if (!publicUrl && !smtpUrl && !transport) return null;

  const seed = {
    mode: transport === 'log' ? 'log' : smtpUrl ? 'smtp' : 'off',
    publicUrl,
    from,
    host: '',
    port: 0,
    secure: true,
    user: '',
    pass: '',
    source: 'env',
  };

  if (smtpUrl) {
    try {
      const parsed = new URL(smtpUrl);
      seed.secure = parsed.protocol === 'smtps:';
      seed.host = parsed.hostname;
      seed.port = Number(parsed.port) || (seed.secure ? 465 : 587);
      // Decoded, because a URL is where a password with @ : / or # in it has
      // to be escaped and the form is where it does not.
      seed.user = parsed.username ? decodeURIComponent(parsed.username) : '';
      seed.pass = parsed.password ? decodeURIComponent(parsed.password) : '';
    } catch (err) {
      seed.mode = transport === 'log' ? 'log' : 'off';
      reportProblem(err && err.message ? err.message : 'SMTP_URL could not be read');
    }
  }
  return seed;
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
    adminPromote: adminPromoteFromEnv(),
    claimToken: claimTokenFromEnv(),
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
    // How many hands a running game keeps for the export, over the whole field.
    // A long game runs a couple of hundred, so this covers one and then stops a
    // server that is left up for a week from growing without end. Zero turns
    // the export off.
    handHistoryMax: intFromEnv('HAND_HISTORY_MAX', 500, 0, 5000),
    // And how long a game's hands are kept after it, which is the whole point
    // of writing them down: a tournament is reaped ten minutes after its
    // winner, and somebody wants their hands the next morning. Thirty days,
    // which is also what a guest identity gets before it is expired - an
    // archive nobody can prove they own is no use to anybody.
    handHistoryTtlMs: intFromEnv('HAND_HISTORY_TTL_MS', 2592000000, 60000, 31536000000),
    // And a count, so a busy month cannot fill a disk with poker.
    handHistoryMaxGames: intFromEnv('HAND_HISTORY_MAX_GAMES', 200, 1, 10000),
    // An account of this server's own. Both of the first two have to be set
    // for accounts to exist at all: a link in an email has to point somewhere,
    // and a server that cannot send mail cannot verify an address. Without
    // them the lobby offers guests exactly as it did before there were
    // accounts, and says why. MAIL_TRANSPORT=log writes the mail to the server
    // log instead of sending it, which is for development.
    publicUrl: (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, ''),
    smtpUrl: (process.env.SMTP_URL || '').trim(),
    mailFrom: (process.env.MAIL_FROM || '').trim(),
    mailTransport: (process.env.MAIL_TRANSPORT || '').trim(),
    // Where everything is kept. With none of these set the server runs on an
    // in-memory database, which is what the tests use and what a bare
    // `node server.js` gives somebody trying it out - nothing survives a
    // restart there, and the log says so at boot.
    dbUrl: (process.env.DB_URL || '').trim(),
    dbHost: (process.env.DB_HOST || '').trim(),
    dbPort: intFromEnv('DB_PORT', 3306, 1, 65535),
    dbUser: (process.env.DB_USER || 'finaltable').trim(),
    dbPassword: process.env.DB_PASSWORD || '',
    dbName: (process.env.DB_NAME || 'finaltable').trim(),
    // The registry's lifecycle sweep interval.
    tournamentSweepMs: intFromEnv('TOURNAMENT_SWEEP_MS', 1000, 20, 60000),
    // How long one webhook to GameNight waits for an answer before it counts
    // as a failure and is tried again later.
    webhookTimeoutMs: intFromEnv('WEBHOOK_TIMEOUT_MS', 8000, 1000, 60000),
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

module.exports = { loadConfig, mailFromEnv, CLAIM_TOKEN_MIN };

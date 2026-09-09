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

// The operator's password for the admin controls, straight from the
// environment and never written anywhere else. Empty or unset disables the
// admin surface completely rather than falling back to a default, because a
// default password on a self-hosted box is worse than no password at all.
function adminPasswordFromEnv() {
  const raw = process.env.ADMIN_PASSWORD;
  return typeof raw === 'string' ? raw.trim() : '';
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
    // How long a tournament with no connected human survives before teardown.
    tournamentAbandonGraceMs: intFromEnv('TOURNAMENT_ABANDON_GRACE_MS', 120000, 100, 3600000),
    // The registry's lifecycle sweep interval.
    tournamentSweepMs: intFromEnv('TOURNAMENT_SWEEP_MS', 1000, 20, 60000),
    hostTransferGraceMs: intFromEnv('HOST_TRANSFER_GRACE_MS', 120000, 100, 600000),
    // Pacing. A betting round closing and the next street arriving in the same
    // frame is too fast to follow, so the table holds a beat between them, and
    // another between one hand and the next.
    streetPauseMs: intFromEnv('STREET_PAUSE_MS', 1600, 0, 15000),
    // The wait between one hand ending and the next being dealt. The director
    // only deals on its tick, so the felt sits idle for this plus up to one
    // tick - 3500 read as five seconds of nothing at the table.
    handPauseMs: intFromEnv('HAND_PAUSE_MS', 2000, 0, 60000),
  };
}

module.exports = { loadConfig };

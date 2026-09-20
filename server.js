// server.js - Main poker server
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { createIdentityStore } = require('./server/identity');
const { createTournamentStore } = require('./server/tournament-store');
const { createChatStore } = require('./server/chat-store');
const { createHandHistoryStore } = require('./server/hand-history-store');
const { loadLocalEnv } = require('./server/load-env');
const { loadConfig, mailFromEnv, CLAIM_TOKEN_MIN } = require('./server/config');
const { applySecurityHeaders, createRateLimiter } = require('./server/http-middleware');
const { registerTournamentHandlers } = require('./server/tournament-handlers');
const { createSettingsStore } = require('./server/settings-store');
const { createApiKeys } = require('./server/api-keys');
const { readCreateBody, USER_ID } = require('./server/api-games');
const { createWebhooks } = require('./server/webhooks');
const { createAccounts } = require('./server/accounts');
const { createDatabase } = require('./server/db');
const { migrateFromFiles } = require('./server/db/migrate');
const { runMigrations } = require('./server/db/migrations');
const { createMailer } = require('./server/mailer');
const { createMailRuntime } = require('./server/mail-settings');
const { createServerSettings } = require('./server/server-settings');
const { createSsoRuntime } = require('./server/gamenight-pairing');
const { computeAssetVersion, renderIndexTemplate } = require('./server/asset-version');
const { createStructuredLogger, onEntry } = require('./server/logger');
const { createAdminLog } = require('./server/admin-log');
const { PRESETS: BLIND_PRESETS } = require('./blind-structures');

const envSkipped = loadLocalEnv(__dirname);
const config = loadConfig();
const structuredLog = createStructuredLogger('server', config.logLevel);
const SERVER_TEXT_LOGS = process.env.SERVER_TEXT_LOGS === '1';

const app = express();
if (config.trustProxy) app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: config.socketCorsOrigin },
  pingTimeout: 120000, // 2 min: allow mobile background
  pingInterval: 25000,
  connectionStateRecovery: {
    maxDisconnectionDuration: 120000, // 2 min state recovery window
  },
});

// ── Session token store: socketId → { token, roomId, playerName } ──

function sanitizeName(value, maxLength = 16) {
  const cleaned = String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/[^\p{L}\p{N} ._'-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const truncated = [...cleaned].slice(0, maxLength).join('').trim();
  if (!/[\p{L}\p{N}]/u.test(truncated)) return '';
  return truncated;
}

function normalizeNameKey(value) {
  return sanitizeName(value).toLocaleLowerCase();
}

function sanitizeAvatar(value) {
  if (typeof value !== 'string') return '🧑';
  const cleaned = value.trim().replace(/[<>&"'`]/g, '');
  return [...cleaned].slice(0, 4).join('') || '🧑';
}

// Do not set HSTS or upgrade-insecure-requests here: NAS/LAN deployments commonly use plain HTTP.
app.use(applySecurityHeaders);

// Global error handlers — prevent server crash on unhandled errors
process.on('uncaughtException', (err) => {
  console.error('🔥 Uncaught Exception:', err.message);
  console.error(err.stack);
  structuredLog({
    level: 'error',
    event: 'uncaught_exception',
    message: 'Unhandled server exception',
    data: { error: err.message, stack: err.stack },
  });
});
process.on('unhandledRejection', (reason) => {
  console.error('🔥 Unhandled Rejection:', reason);
  structuredLog({
    level: 'error',
    event: 'unhandled_rejection',
    message: 'Unhandled promise rejection',
    data: { reason: String(reason) },
  });
});

// Serve static files
const publicDir = path.join(__dirname, 'public');
const assetVersion = computeAssetVersion(__dirname);
const renderedIndexHtml = renderIndexTemplate(__dirname, assetVersion);

app.get(['/', '/index.html'], (req, res) => {
  // Revalidate every time. Every script and stylesheet is cache-busted by a
  // ?v= stamp that lives in this page, so a stale copy of it pins the browser
  // to the previous build's URLs and no amount of deploying changes what the
  // player sees. Express sets an ETag, so revalidating is a 304 and costs
  // nothing; without this header the browser is free to guess a freshness
  // lifetime, and it guesses wrong at exactly the wrong moment.
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(renderedIndexHtml);
});

app.use(express.static(publicDir));
app.use(
  '/api',
  createRateLimiter({ limit: config.httpRateLimit, windowMs: config.httpRateWindow })
);

// The games running here, for somebody signed in to one of the accounts this
// server keeps. The device token is the credential, the same one the socket
// uses; without it this is a list of who is playing what tonight, handed to
// anybody who asks.
//
// Closed at the same time as the socket's own list, and for the same reason:
// gating one while the other served the same rows would have been gating
// nothing at all.
app.get('/api/tournaments', (req, res) => {
  const header = String(req.get('authorization') || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const who = bearer ? identity.verify(bearer) : null;
  if (!who) return res.status(401).json({ error: 'Sign in first.' });
  res.json(tournamentLayer.listFor(who.uid));
});

// The blind structures a host can pick from, for the create form's editor.
app.get('/api/blind-structures', (req, res) => {
  res.json({ presets: BLIND_PRESETS });
});

app.get('/api/status', (req, res) => {
  res.json({
    activeTournaments: tournamentLayer.tournaments.size,
  });
});

// Where everything is kept. Made here and connected in startServer, because
// nothing may be read out of it before the server is listening and everything
// is read out of it after.
const db = createDatabase({
  url: config.dbUrl,
  host: config.dbHost,
  port: config.dbPort,
  user: config.dbUser,
  password: config.dbPassword,
  database: config.dbName,
  log: structuredLog,
});

// What the server has done, for the Admin page's Log. Made early, so a warning
// raised between here and listening still has somewhere to land; what is
// already written is read in openStores, once there is a database to read it
// from.
const adminLog = createAdminLog({
  db,
  maxRows: config.adminLogMaxRows,
  maxAgeMs: config.adminLogMaxAgeMs,
  signInGapMs: config.adminLogSignInGapMs,
  log: structuredLog,
});

// What GameNight is told about a game it made here, and the outbox that
// makes sure it is. Read back in openStores; the sender starts then too.
const webhooks = createWebhooks({
  db,
  log: structuredLog,
  timeoutMs: config.webhookTimeoutMs,
  version: require('./package.json').version,
});

// Every warning and error, wherever it is raised and whoever raises it. A sink
// rather than a call at each site: there are five today and there will be more,
// and none of them should have to know this page exists. Info is deliberately
// not kept - it is most of the volume, and the engine's lines carry cards.
onEntry((entry) => {
  if (entry.level !== 'warn' && entry.level !== 'error') return;
  adminLog.recordServer({
    level: entry.level,
    event: entry.event,
    message: entry.message,
    // One named field, never the payload: `data` is spread flat into the entry
    // and holds whatever its caller passed.
    detail: entry.error || entry.reason || entry.detail || null,
  });
});

// The one line that would have named the crash loop, which could not use the
// logger because it happens before there is one. A file this user may not
// read is not a problem, only a fact: on a host that bind-mounts its working
// tree the .env beside the compose file is the operator's, mode 600, and
// compose has already read it and passed every value in. That is info. Any
// other reason is somebody's to look at.
for (const skip of envSkipped || []) {
  structuredLog({
    level: skip.reason === 'EACCES' ? 'info' : 'warn',
    event: 'env_file_skipped',
    message: 'Could not read an environment file; carrying on without it',
    data: { detail: `${skip.file}: ${skip.reason}` },
  });
}

// The word that claims this server from the lobby while it has no
// administrator. Too short to be safe is not offered at all, and said so:
// a token the lobby quietly ignored would leave whoever set it staring at a
// sign-in card wondering why.
const claimToken = config.claimToken.length >= CLAIM_TOKEN_MIN ? config.claimToken : '';
if (config.claimToken && !claimToken) {
  structuredLog({
    level: 'error',
    event: 'claim_token_short',
    message: 'CLAIM_TOKEN is too short to use, so it was ignored',
    data: {
      detail: `Use at least ${CLAIM_TOKEN_MIN} characters - openssl rand -hex 16 makes one - and start the server again`,
    },
  });
}

// The two know one thing about each other and are made in this order because
// of it: identity asks accounts whether a name is spoken for, and accounts
// asks identity whether anybody else is playing under it. Late-bound through
// the closures below rather than passed, because either way round one of them
// would not exist yet.
let accounts = null;

// Who a player is: name + avatar behind a device token, persisted beside the
// saves. See server/identity.js for the interface a login backend would fill.
const identity = createIdentityStore({
  db,
  log: structuredLog,
  sanitizeName,
  sanitizeAvatar,
  // Owned, or held by a sign-up waiting on its link: either way somebody else
  // may not answer to it.
  nameOwner: (name) => (accounts ? accounts.holderOf(name) : null),
  // Owned outright, which is a claim a GameNight name yields to. A sign-up
  // merely holding one is not, and gives way instead.
  nameOwnedBy: (name) => (accounts ? accounts.ownerOf(name) : null),
  releaseName: (name) => (accounts ? accounts.releasePending(name) : null),
  nameKeyOf: normalizeNameKey,
});

// The two messages this server sends, both of them links. Without a public URL
// to build them against and a way to send them, nobody can make an account
// here - and since an account is the only way in, a server with no mail and no
// GameNight pairing has no way in at all. It says so at boot, and the sign-in
// screen says so to whoever loads it.
const mailer = createMailer({
  smtpUrl: config.smtpUrl,
  from: config.mailFrom,
  baseUrl: config.publicUrl,
  transport: config.mailTransport,
  log: structuredLog,
});

accounts = createAccounts({
  db,
  log: structuredLog,
  nameKey: normalizeNameKey,
  sanitizeName,
  // Rule 2: your own guest identity does not count against you, anybody
  // else's does.
  nameInUse: (key, uid) => identity.nameHolder(key, uid),
});

// ── The two pages a link in an email lands on ───────────────────────────────
//
// Everything else here is the socket. These are not, because a link opened
// from somebody's mail arrives in a browser that has not loaded the lobby yet
// and may not be the browser that asked. Both are plain pages with nothing to
// load; Referrer-Policy is already no-referrer, so the token in the address
// bar does not travel anywhere.

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  );
}

function accountPage({ title, heading, lines = [], form = '' }) {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(title)} - FinalTable</title>`,
    '<style>',
    'body{margin:0;min-height:100vh;display:flex;align-items:center;',
    'justify-content:center;background:#0d1f12;color:#f2e8d5;',
    'font-family:system-ui,-apple-system,Segoe UI,sans-serif;padding:24px}',
    'main{max-width:34rem;width:100%}h1{font-size:1.3rem;margin:0 0 12px}',
    'p{line-height:1.5;color:#c9bda6}a{color:#c9a84c}',
    'label{display:block;margin:16px 0 6px;font-size:.85rem}',
    'input{width:100%;box-sizing:border-box;padding:10px;border-radius:6px;',
    'border:1px solid rgba(201,168,76,.4);background:rgba(0,0,0,.25);color:#f2e8d5}',
    'button{margin-top:16px;padding:10px 18px;border-radius:6px;cursor:pointer;',
    'border:1px solid rgba(201,168,76,.5);background:rgba(201,168,76,.15);color:#c9a84c}',
    '</style></head><body><main>',
    `<h1>${escapeHtml(heading)}</h1>`,
    lines.map((line) => `<p>${escapeHtml(line)}</p>`).join(''),
    form,
    '<p><a href="/">Back to FinalTable</a></p>',
    '</main></body></html>',
  ].join('');
}

const accountLimiter = createRateLimiter({
  limit: config.httpRateLimit,
  windowMs: config.httpRateWindow,
});

// Proving an address. The name is owned from here, and the link is spent.
app.get('/verify', accountLimiter, (req, res) => {
  const done = accounts.completeSignUp(req.query && req.query.token);
  const ok = !done.error;
  res.status(ok ? 200 : 400).send(
    accountPage({
      title: ok ? 'Name confirmed' : 'That did not work',
      heading: ok ? `${done.name} is yours` : 'That did not work',
      lines: ok
        ? ['Sign in with that name and the password you chose. Any browser will do.']
        : [done.error],
    })
  );
});

app.get('/reset', accountLimiter, (req, res) => {
  const token = (req.query && req.query.token) || '';
  const who = accounts.resetSubject(token);
  if (!who) {
    return res.status(400).send(
      accountPage({
        title: 'That did not work',
        heading: 'That link is no good',
        lines: ['It has been used already, or it has expired. Ask for another from the lobby.'],
      })
    );
  }
  res.send(
    accountPage({
      title: 'A new password',
      heading: `A new password for ${who.name}`,
      lines: ['Type it twice. The link stops working as soon as this is sent.'],
      form: [
        '<form method="post" action="/reset">',
        `<input type="hidden" name="token" value="${escapeHtml(token)}">`,
        '<label for="p1">New password</label>',
        '<input id="p1" name="password" type="password" autocomplete="new-password" required>',
        '<label for="p2">Again</label>',
        '<input id="p2" name="confirm" type="password" autocomplete="new-password" required>',
        '<button type="submit">Set it</button>',
        '</form>',
      ].join(''),
    })
  );
});

app.post('/reset', accountLimiter, express.urlencoded({ extended: false }), async (req, res) => {
  const body = req.body || {};
  if (!body.password || body.password !== body.confirm) {
    return res.status(400).send(
      accountPage({
        title: 'That did not work',
        heading: 'Those did not match',
        lines: ['Go back and try again - the link is still good until one goes through.'],
      })
    );
  }
  const done = await accounts.completeReset(body.token, body.password);
  const ok = !done.error;
  res.status(ok ? 200 : 400).send(
    accountPage({
      title: ok ? 'Password changed' : 'That did not work',
      heading: ok ? 'That is your new password' : 'That did not work',
      lines: ok ? [`Sign in as ${done.name} with it.`] : [done.error],
    })
  );
});

const tournamentStore = createTournamentStore({ db, log: structuredLog });

// Chat, in its own file per tournament so it never rides along with the
// registration writes. Absent when chat is switched off, which is what stops
// an admin who disabled it from finding files still appearing.
const chatStore = config.chatEnabled ? createChatStore({ db, log: structuredLog }) : null;

// The hands a game was played with, which outlive the game. Absent when the
// history is switched off entirely, which is what stops a server that keeps
// nothing from writing files anyway.
const handHistoryStore =
  config.handHistoryMax > 0
    ? createHandHistoryStore({
        db,
        ttlMs: config.handHistoryTtlMs,
        maxGames: config.handHistoryMaxGames,
        log: structuredLog,
      })
    : null;

// Admin settings, set from the lobby and kept beside the saves.
const settingsStore = createSettingsStore({ db, log: structuredLog });
// The key GameNight presents to make a game here. Made on the Admin page,
// kept as a digest in the same table; read on every request, so no init.
const apiKeys = createApiKeys({ settingsStore, log: structuredLog });
// startServer can be called more than once in a test run; the stores open once.
let storesOpen = false;

// The GameNight sign-in bridge. Paired from the Admin page, or seeded from
// the environment on a first boot; unpaired, the lobby never offers the button.
const sso = createSsoRuntime({ settingsStore, envConfig: config.gamenight, log: structuredLog });
// init() is not called here: it reads the stored pairing, and the settings are
// not loaded until openStores() below. Reading now would find an empty store
// and seed the environment over a pairing somebody set from the page.

// Where this server sends from, on the same terms and for the same reason.
const mail = createMailRuntime({
  settingsStore,
  mailer,
  envSeed: mailFromEnv((detail) =>
    structuredLog({
      level: 'warn',
      event: 'mail_env_invalid',
      message: 'SMTP_URL could not be read, so it was ignored',
      data: { detail },
    })
  ),
  log: structuredLog,
});

// The handful of knobs an admin can turn from the Server tab. What it tells -
// the registry - is built by the call below, so it is bound afterwards.
const serverSettings = createServerSettings({
  settingsStore,
  historyStore: handHistoryStore,
  defaults: {
    maxTournaments: config.maxTournaments,
    reactionsEnabled: config.reactionsEnabled,
    handHistoryTtlMs: config.handHistoryTtlMs,
    handHistoryMaxGames: config.handHistoryMaxGames,
    handPauseMs: config.handPauseMs,
    streetPauseMs: config.streetPauseMs,
  },
  log: structuredLog,
});

const tournamentLayer = registerTournamentHandlers({
  io,
  identity,
  // What the lobby's menu shows. package.json stays the one place it is written.
  version: require('./package.json').version,
  // Which page this server serves, so a page that predates it can tell.
  assetVersion,
  sso,
  log: structuredLog,
  adminLog,
  webhooks,
  heartbeatMs: config.webhookHeartbeatMs,
  store: tournamentStore,
  accounts,
  mailer,
  mail,
  claimToken,
  apiKeys,
  settingsStore,
  sanitizeName,
  normalizeNameKey,
  sanitizeAvatar,
  maxTournaments: config.maxTournaments,
  finishedTtlMs: config.tournamentFinishedTtlMs,
  zombieHoldMs: config.tournamentZombieHoldMs,
  hostTransferGraceMs: config.hostTransferGraceMs,
  sweepMs: config.tournamentSweepMs,
  handPauseMs: config.handPauseMs,
  historyMax: config.handHistoryMax,
  historyStore: handHistoryStore,
  tableOptions: { streetPauseMs: config.streetPauseMs, showWindowMs: config.showWindowMs },
  chatStore,
  chatEnabled: config.chatEnabled,
  chatHistory: config.chatHistory,
  chatMaxLength: config.chatMaxLength,
  chatRatePerWindow: config.chatRatePerWindow,
  chatRateWindowMs: config.chatRateWindowMs,
  reactionsEnabled: config.reactionsEnabled,
  reactionRatePerWindow: config.reactionRatePerWindow,
  reactionRateWindowMs: config.reactionRateWindowMs,
  // Late-bound, because what it tells is built by this very call.
  serverSettings,
});
serverSettings.bind({ registry: tournamentLayer.registry });

// ── The API GameNight calls ────────────────────────────────────────────────
//
// Two routes, one caller. GameNight makes a game here with its blinds, seats
// and roster and reads it back while it runs; the key it presents is the one
// an administrator made on the GameNight tab. Declared here rather than beside
// /api/tournaments above because the guard is a value, and the key store has
// to exist before the route does. Same /api rate limiter; different
// credential from /api/tournaments, which takes a player's device token.
//
// The envelope is GameNight's own: { ok, data } or { ok, error }.

// No JSON parser is mounted app-wide - nothing else takes JSON - so this one
// is scoped to the route, and a body that is not JSON is answered in the
// envelope rather than with body-parser's HTML.
const apiJson = express.json({ limit: '64kb' });
function jsonBody(req, res, next) {
  apiJson(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: 'The body is not JSON.' });
    next();
  });
}

// Where a player goes to sit down or to watch. Built against the public
// address the Mail tab holds; without one there are no links, and the game
// exists all the same - GameNight knows this server's address from its own
// record and can build them itself.
function apiLinks(entry) {
  const record = mail.get() || {};
  const base = String(record.publicUrl || '').replace(/\/+$/, '');
  if (!base) return null;
  return { join: `${base}/?t=${entry.code}`, rail: `${base}/?w=${entry.rail}` };
}

function apiAnswer(entry) {
  return { ...tournamentLayer.registry.apiView(entry), links: apiLinks(entry) };
}

app.post('/api/games', apiKeys.guard, jsonBody, (req, res) => {
  const registry = tournamentLayer.registry;
  const read = readCreateBody(req.body, { sanitizeName });
  if (read.error) return res.status(400).json({ ok: false, error: read.error });
  // The two refusals that are about this server rather than the body, said
  // before anybody is made known: a host who is already in a game, and a
  // server holding as many games as it may.
  const hostUid = `gn_${read.hostId}`;
  if (registry.findByUid(hostUid, { includeLeft: true })) {
    return res
      .status(409)
      .json({ ok: false, error: 'The host is already in a game on this server.' });
  }
  if (registry.tournaments.size >= registry.maxTournaments) {
    return res
      .status(409)
      .json({ ok: false, error: 'This server is holding as many games as it can.' });
  }
  // The roster, made known. The registry refuses a player it has never heard
  // of, and these are the records their sign-in would make anyway; one left
  // behind by a refusal below is no different from one made by a sign-in that
  // never joined a game.
  for (const row of read.roster) {
    const made = identity.reserveFromGameNight({ sub: row.sub, name: row.name });
    if (!made) {
      return res.status(400).json({ ok: false, error: `No usable name for user_id ${row.sub}.` });
    }
  }
  const { entry, error } = registry.create(hostUid, read.payload, null, {
    webhook: read.webhook,
  });
  if (error) return res.status(400).json({ ok: false, error });
  structuredLog({
    level: 'info',
    event: 'api_game_created',
    message: 'GameNight made a game',
    data: {
      id: entry.id,
      name: entry.name,
      host: hostUid,
      roster: entry.guests.size,
      webhook: !!entry.webhook,
    },
  });
  const host = identity.get(hostUid);
  adminLog.recordServer({
    level: 'info',
    event: 'api_game_created',
    message: `${entry.name} was made by GameNight for ${host ? host.name : hostUid}`,
    detail: `${entry.guests.size} on the guest list`,
  });
  res.status(201).json({ ok: true, data: apiAnswer(entry) });
});

// A finished game answers for as long as the registry keeps it - ten minutes
// by default - and then this is a 404. The record of what happened is the
// webhook's job, when there is one.
app.get('/api/games/:id', apiKeys.guard, (req, res) => {
  const entry = tournamentLayer.tournaments.get(String(req.params.id || ''));
  if (!entry) return res.status(404).json({ ok: false, error: 'No game by that id.' });
  res.json({ ok: true, data: apiAnswer(entry) });
});

// ── Driving a game from GameNight's side ────────────────────────────────
//
// The host's buttons, reachable with the key that made the game. Each calls
// the registry's force* body - the one the admin's socket already uses for
// cancelling - so nothing here pretends to be the host, whose title may have
// moved. A refusal is the registry's own sentence, as a 409. Every one
// leaves a line in the log and a row in the admin Log.

function gameOr404(req, res) {
  const entry = tournamentLayer.tournaments.get(String(req.params.id || ''));
  if (!entry) res.status(404).json({ ok: false, error: 'No game by that id.' });
  return entry || null;
}

function refused(res, error) {
  return res.status(409).json({ ok: false, error });
}

function controlLog(entry, verb, event, data = {}, detail = null) {
  structuredLog({
    level: 'info',
    event,
    message: `GameNight ${verb} a game`,
    data: { id: entry.id, name: entry.name, ...data },
  });
  adminLog.recordServer({
    level: 'info',
    event,
    message: `${entry.name} was ${verb} by GameNight`,
    ...(detail ? { detail } : {}),
  });
}

// The game as it stood a moment before, since cancelling takes it away.
app.post('/api/games/:id/cancel', apiKeys.guard, (req, res) => {
  const entry = gameOr404(req, res);
  if (!entry) return;
  const before = apiAnswer(entry);
  const reason = 'cancelled by GameNight';
  const { error } = tournamentLayer.registry.forceCancel(entry, reason);
  if (error) return refused(res, error);
  controlLog(entry, 'cancelled', 'api_game_cancelled');
  res.json({ ok: true, data: { ...before, status: 'cancelled', reason } });
});

app.post('/api/games/:id/start', apiKeys.guard, (req, res) => {
  const entry = gameOr404(req, res);
  if (!entry) return;
  const { error } = tournamentLayer.registry.forceStart(entry);
  if (error) return refused(res, error);
  controlLog(entry, 'started', 'api_game_started');
  res.json({ ok: true, data: apiAnswer(entry) });
});

app.post('/api/games/:id/pause', apiKeys.guard, (req, res) => {
  const entry = gameOr404(req, res);
  if (!entry) return;
  const { error } = tournamentLayer.registry.forcePause(entry);
  if (error) return refused(res, error);
  controlLog(entry, 'paused', 'api_game_paused');
  res.json({ ok: true, data: apiAnswer(entry) });
});

app.post('/api/games/:id/resume', apiKeys.guard, (req, res) => {
  const entry = gameOr404(req, res);
  if (!entry) return;
  const { error } = tournamentLayer.registry.forceResume(entry);
  if (error) return refused(res, error);
  controlLog(entry, 'resumed', 'api_game_resumed');
  res.json({ ok: true, data: apiAnswer(entry) });
});

// A GameNight user id from a body, as the roster takes them.
function userIdFrom(body, res) {
  const raw = body && body.user_id !== undefined && body.user_id !== null ? body.user_id : '';
  const id = String(raw).trim();
  if (!USER_ID.test(id)) {
    res.status(400).json({ ok: false, error: "user_id must be GameNight's numeric user id." });
    return null;
  }
  return id;
}

app.post('/api/games/:id/remove', apiKeys.guard, jsonBody, (req, res) => {
  const entry = gameOr404(req, res);
  if (!entry) return;
  const id = userIdFrom(req.body, res);
  if (!id) return;
  const uid = `gn_${id}`;
  const who = identity.get(uid);
  const result = tournamentLayer.registry.forceRemove(entry, uid);
  if (result.error) return refused(res, result.error);
  controlLog(
    entry,
    'changed',
    'api_player_removed',
    { uid, queued: !!result.queued },
    `${who ? who.name : uid} was removed from the game`
  );
  res.json({
    ok: true,
    data: {
      ...apiAnswer(entry),
      remove: {
        removed: !!result.removed,
        queued: !!result.queued,
        place: Number.isFinite(result.place) ? result.place : null,
      },
    },
  });
});

app.post('/api/games/:id/move', apiKeys.guard, jsonBody, (req, res) => {
  const entry = gameOr404(req, res);
  if (!entry) return;
  const id = userIdFrom(req.body, res);
  if (!id) return;
  const table = Number(req.body && req.body.table);
  if (!Number.isInteger(table) || table < 1) {
    return res.status(400).json({ ok: false, error: 'table must be a table number.' });
  }
  const uid = `gn_${id}`;
  const who = identity.get(uid);
  const result = tournamentLayer.registry.forceMove(entry, uid, table);
  if (result.error) return refused(res, result.error);
  controlLog(
    entry,
    'changed',
    'api_player_moved',
    { uid, table, queued: !!result.queued },
    `${who ? who.name : uid} ${result.queued ? 'will move' : 'moved'} to table ${table}`
  );
  res.json({
    ok: true,
    data: { ...apiAnswer(entry), move: { moved: !!result.moved, queued: !!result.queued } },
  });
});

// Every device a GameNight player is signed in on here, ended. Not a ban:
// their next sign-in through GameNight works as before, and refusing them is
// GameNight's job at its own door.
app.post('/api/players/:user_id/sign-out', apiKeys.guard, (req, res) => {
  const id = String(req.params.user_id || '').trim();
  if (!USER_ID.test(id)) {
    return res
      .status(400)
      .json({ ok: false, error: "user_id must be GameNight's numeric user id." });
  }
  const uid = `gn_${id}`;
  const who = identity.get(uid);
  if (!who)
    return res.status(404).json({ ok: false, error: 'No GameNight player by that id here.' });
  const dropped = tournamentLayer.endEveryDevice(uid);
  structuredLog({
    level: 'info',
    event: 'api_player_signed_out',
    message: 'GameNight signed a player out everywhere',
    data: { uid, devices: dropped.length },
  });
  adminLog.recordServer({
    level: 'info',
    event: 'api_player_signed_out',
    message: `GameNight signed ${who.name} out everywhere`,
  });
  res.json({ ok: true, data: { uid, user_id: id, name: who.name, devices: dropped.length } });
});

// Filled by openStores(), which is where the games are read back: restoring a
// field is synchronous and cannot happen until everything it needs is in hand.
let restoredTournaments = 0;

// Flush both stores on the way out. Installed only when run directly, so the
// test harness (which requires this module many times) never stacks handlers.
// Returns a promise now: what used to be a synchronous write of a file is a
// query, and a query cannot be made to happen before the process goes away. So
// whoever is shutting down waits for it rather than hoping.
async function flushStores() {
  try {
    await adminLog.flush();
  } catch (_err) {
    /* nothing better to do on the way out */
  }
  try {
    await webhooks.flush();
  } catch (_err) {
    /* as above */
  }
  try {
    await identity.flush();
  } catch (_err) {
    /* nothing better to do on the way out */
  }
  try {
    await tournamentLayer.registry.flush();
  } catch (_err) {
    /* as above */
  }
  try {
    if (chatStore) await chatStore.flush();
  } catch (_err) {
    /* as above */
  }
  try {
    if (handHistoryStore) await handHistoryStore.flush();
  } catch (_err) {
    /* as above */
  }
  try {
    await accounts.flush();
  } catch (_err) {
    /* as above */
  }
}
if (require.main === module) {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      // Waited on, with a bound: a database that has stopped answering must
      // not hold a shutdown open for ever, and ten seconds is far more than
      // the writes need.
      const done = flushStores().catch(() => {});
      const bail = new Promise((r) => setTimeout(r, 10000));
      Promise.race([done, bail]).then(() => process.exit(0));
    });
  }
}
function startServer(options = {}) {
  const port = options.port !== undefined ? options.port : config.port;
  const host = options.host || config.host;
  const unrefServer = options.unrefServer === true;

  return openStores().then(
    () =>
      new Promise((resolve, reject) => {
        // once, not on: startServer can be called again in a test, and a
        // listener per call would answer for a failure that is not its own.
        server.once('error', (err) => {
          // Nothing listens for this today, so EADDRINUSE on a box that is already
          // running is exactly the kind of crash loop this page exists to show.
          structuredLog({
            level: 'error',
            event: 'server_start_failed',
            message: 'The server could not start',
            data: { error: err.message },
          });
          adminLog.flush().catch(() => {
            /* the row is already in memory; writing it is best effort here */
          });
          reject(err);
        });
        server.listen(port, host, () => {
          if (restoredTournaments) {
            console.log(`Restored ${restoredTournaments} tournament(s) from the database`);
          }
          if (unrefServer && typeof server.unref === 'function') server.unref();
          const address = server.address();
          const actualPort = typeof address === 'object' && address ? address.port : port;
          if (SERVER_TEXT_LOGS) {
            console.log(`
╔══════════════════════════════════════════════╗
║    ♠ FinalTable ♠                           ║
║    Running on ${host}:${actualPort}                    ║
║    Open http://localhost:${actualPort} to play         ║
║    For entertainment & education only        ║
╚══════════════════════════════════════════════╝
  `);
          }
          structuredLog({
            level: 'info',
            event: 'server_started',
            message: 'FinalTable server started',
            data: {
              host,
              port: actualPort,
              assetVersion,
              gamenightSso: sso.get() ? sso.get().config.issuer : null,
            },
          });
          // A restart is the one info-level line the Log keeps, because "when did
          // this box last come up" is half of "why did it come up nine times".
          adminLog.recordServer({
            level: 'info',
            event: 'server_started',
            message: 'Server started',
            detail: `version ${require('./package.json').version} on ${host}:${actualPort}`,
          });

          resolve({ app, server, io, config });
        });
      })
  );
}

// Everything that has to be ready before a browser can be answered: the
// database reached, the tables made, and every store that reads at boot having
// read. A page served by a server whose settings have not loaded is a page
// that says there is no admin surface on a box that has one.
async function openStores() {
  if (storesOpen) return;
  storesOpen = true;
  await db.connect();
  await db.apply();
  // The tables exist; now any shape change that has not been applied to this
  // one yet. Before anything reads, because what reads expects the new shape.
  await runMigrations({ db, log: structuredLog });
  // Before anything loads: whatever the files held is read in once, on the
  // first boot that finds the tables empty.
  await migrateFromFiles({
    db,
    saveDir: process.env.SAVE_DIR || path.join(__dirname, 'data'),
    nameKey: normalizeNameKey,
    log: structuredLog,
  });
  await settingsStore.load();
  await identity.load();
  await accounts.load();
  await tournamentStore.load();
  if (chatStore) await chatStore.loadAll();
  await adminLog.load();
  // What is still owed to GameNight, and the sender that owes it.
  await webhooks.load();
  // The hands of the games about to be seated again, and only those: the
  // restore reads them synchronously, so they have to be in hand before it
  // runs. Every other game is read when somebody asks for it.
  if (handHistoryStore) {
    await handHistoryStore.primeFor(tournamentStore.saved().map((t) => t && t.id));
  }
  // Everything the restore needs is now in hand, so it can stay the
  // synchronous thing it is: a field is seated again in one go.
  restoredTournaments = tournamentLayer.registry.restore();
  // Everything that reads a setting at boot, now that there are settings to
  // read: the GameNight pairing set from the Admin page beats the environment,
  // and it can only know that once the store has loaded.
  sso.init();
  // And the knobs, which the page may have turned since the environment last
  // had an opinion about them.
  serverSettings.init();
  // And where this server sends from, which the page may have changed since
  // the environment last had an opinion about it.
  mail.init();

  // Said once at boot, to the log rather than to every browser: why this server
  // cannot hold an account is whoever runs it's business, and a player only
  // needs to know that it cannot. After mail.init(), because before it the
  // mailer knows only what the environment said, and a server whose mail was
  // set from the Admin page would be called unable on every boot.
  if (!mailer.available()) {
    structuredLog({
      level: 'info',
      event: 'accounts_unavailable',
      message: 'Nobody can sign up here',
      data: { reason: mailer.why() },
    });
  }

  // An account named in the environment, made an administrator. This is how a
  // server gets its first one when the first-account rule is not the answer -
  // a stranger signed up before the owner did, or the only administrator has
  // lost both their password and their address. Applied every boot and never
  // taken away, so leaving it set does nothing surprising.
  if (config.adminPromote) {
    const promoted = identity.promoteByName(config.adminPromote);
    structuredLog({
      level: promoted ? 'info' : 'error',
      event: promoted ? 'admin_promoted' : 'admin_promote_missed',
      message: promoted
        ? 'An account was made an administrator from the environment'
        : 'ADMIN_PROMOTE names nobody here',
      data: { name: config.adminPromote, uid: promoted || undefined },
    });
  }

  // A database that already held people when this arrived promotes nobody -
  // the first-account rule is about a fresh server, and applying it to an
  // existing one would hand the keys to whoever signed in next.
  if (identity.size && !identity.adminCount()) {
    structuredLog({
      level: 'warn',
      event: 'admin_unclaimed',
      message: 'Nobody administers this server',
      data: {
        detail:
          'Set ADMIN_PROMOTE to the name of an account here, or CLAIM_TOKEN to claim it from the lobby, and start the server again.',
      },
    });
  }

  // The password this replaced. Said once, because a line left in a compose
  // file that quietly does nothing is worse than one that says so.
  if (process.env.ADMIN_PASSWORD) {
    structuredLog({
      level: 'warn',
      event: 'admin_password_ignored',
      message: 'ADMIN_PASSWORD does nothing now',
      data: {
        detail: 'The admin surface belongs to an account. Use ADMIN_PROMOTE to name one.',
      },
    });
    // And the one somebody set from the old Admin page, which would otherwise
    // sit in the settings table for ever meaning nothing.
    if (settingsStore.get('adminPassword')) settingsStore.set('adminPassword', null);
  }

  // The claim. A server with no administrator and a token in the environment
  // offers itself to whoever opens the lobby with that token; one that has an
  // administrator ignores the token, and says so once so the line can come
  // out of .env rather than sit there meaning nothing.
  const claimOpen = !!claimToken && identity.adminCount() === 0;
  if (claimToken && !claimOpen) {
    structuredLog({
      level: 'info',
      event: 'claim_token_stale',
      message: 'CLAIM_TOKEN does nothing now that this server has an administrator',
      data: { detail: 'Take it out of .env whenever convenient.' },
    });
  }
  if (claimOpen) {
    structuredLog({
      level: 'info',
      event: 'claim_open',
      message: 'This server has no administrator yet; the lobby offers to claim it',
      data: {
        detail: 'Open the lobby, press Claim this server and enter the CLAIM_TOKEN from .env.',
      },
    });
  }

  // Now that the pairing is known, the one thing worth stopping to say. An
  // account is the only way in; a server that can send no mail, is paired
  // with no GameNight and offers no claim has no way for anybody to become
  // anybody, including whoever is trying to set it up.
  if (!mailer.available() && !sso.get() && !claimOpen) {
    structuredLog({
      level: 'error',
      event: 'no_way_in',
      message: 'Nobody can sign in to this server',
      data: {
        detail:
          'Set CLAIM_TOKEN in .env and claim the server from the lobby, pair it with a GameNight, or set PUBLIC_URL and SMTP_URL so accounts can be made.',
      },
    });
  }
  if (db.driver === 'memory') {
    structuredLog({
      level: 'warn',
      event: 'db_memory',
      message: 'No database configured: nothing will survive a restart',
    });
  }
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  server,
  io,
  tournaments: tournamentLayer.tournaments,
  registry: tournamentLayer.registry,
  identity,
  sso,
  mail,
  settingsStore,
  db,
  handHistoryStore,
  accounts,
  mailer,
  serverSettings,
  webhooks,
  flushStores,
  startServer,
  config,
  sanitizeName,
  normalizeNameKey,
};

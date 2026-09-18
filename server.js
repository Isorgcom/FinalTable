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
const { loadConfig } = require('./server/config');
const { applySecurityHeaders, createRateLimiter } = require('./server/http-middleware');
const { registerTournamentHandlers } = require('./server/tournament-handlers');
const { createSettingsStore } = require('./server/settings-store');
const { createAdminCredential } = require('./server/admin-credential');
const { createAccounts } = require('./server/accounts');
const { createDatabase } = require('./server/db');
const { createMailer } = require('./server/mailer');
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

app.get('/api/tournaments', (req, res) => {
  res.json(tournamentLayer.publicList());
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

// What the server has done, for the Admin page's Log. Made early and loaded at
// once, so a crash between here and listening still has somewhere to land.
const adminLog = createAdminLog({
  saveDir: process.env.SAVE_DIR || path.join(__dirname, 'data'),
  maxRows: config.adminLogMaxRows,
  maxAgeMs: config.adminLogMaxAgeMs,
  signInGapMs: config.adminLogSignInGapMs,
});
adminLog.load();

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
// logger because it happens before there is one.
for (const skip of envSkipped || []) {
  structuredLog({
    level: 'warn',
    event: 'env_file_skipped',
    message: 'Could not read an environment file; carrying on without it',
    data: { detail: `${skip.file}: ${skip.reason}` },
  });
}

// Who a player is: name + avatar behind a device token, persisted beside the
// saves. See server/identity.js for the interface a login backend would fill.
// The two know one thing about each other and are made in this order because
// of it: identity asks accounts whether a name is spoken for, and accounts
// asks identity whether anybody else is playing under it. Late-bound through
// the closures below rather than passed, because either way round one of them
// would not exist yet.
let accounts = null;

const identity = createIdentityStore({
  saveDir: process.env.SAVE_DIR || path.join(__dirname, 'data'),
  sanitizeName,
  sanitizeAvatar,
  // Owned, or held by a sign-up waiting on its link: either way somebody else
  // may not answer to it.
  nameOwner: (name) => (accounts ? accounts.holderOf(name) : null),
  nameKeyOf: normalizeNameKey,
});

// The two messages this server sends, both of them links. Without a public URL
// to build them against and a way to send them, there are no accounts: the
// lobby says so and guests carry on exactly as they did.
const mailer = createMailer({
  smtpUrl: config.smtpUrl,
  from: config.mailFrom,
  baseUrl: config.publicUrl,
  transport: config.mailTransport,
  log: structuredLog,
});

// Said once at boot, to the log rather than to every browser: why this server
// cannot hold an account is whoever runs it's business, and a player only
// needs to know that it cannot.
if (!mailer.available()) {
  structuredLog({
    level: 'info',
    event: 'accounts_unavailable',
    message: 'Player accounts are off',
    data: { reason: mailer.why() },
  });
}

accounts = createAccounts({
  saveDir: process.env.SAVE_DIR || path.join(__dirname, 'data'),
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

app.post('/reset', accountLimiter, express.urlencoded({ extended: false }), (req, res) => {
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
  const done = accounts.completeReset(body.token, body.password);
  const ok = !done.error;
  res.status(ok ? 200 : 400).send(
    accountPage({
      title: ok ? 'Password changed' : 'That did not work',
      heading: ok ? 'That is your new password' : 'That did not work',
      lines: ok ? [`Sign in as ${done.name} with it.`] : [done.error],
    })
  );
});

const tournamentStore = createTournamentStore({
  saveDir: process.env.SAVE_DIR || path.join(__dirname, 'data'),
});

// Chat, in its own file per tournament so it never rides along with the
// registration writes. Absent when chat is switched off, which is what stops
// an admin who disabled it from finding files still appearing.
const chatStore = config.chatEnabled
  ? createChatStore({ saveDir: process.env.SAVE_DIR || path.join(__dirname, 'data') })
  : null;

// The hands a game was played with, which outlive the game. Absent when the
// history is switched off entirely, which is what stops a server that keeps
// nothing from writing files anyway.
const handHistoryStore =
  config.handHistoryMax > 0
    ? createHandHistoryStore({
        saveDir: process.env.SAVE_DIR || path.join(__dirname, 'data'),
        ttlMs: config.handHistoryTtlMs,
        maxGames: config.handHistoryMaxGames,
      })
    : null;

// Admin settings, set from the lobby and kept beside the saves.
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

const settingsStore = createSettingsStore({ db, log: structuredLog });
// startServer can be called more than once in a test run; the stores open once.
let storesOpen = false;

// The admin password: the environment's until somebody changes it from the
// Admin page, after which the stored one wins.
const adminCredential = createAdminCredential({
  settingsStore,
  envPassword: config.adminPassword,
  log: structuredLog,
});

// The GameNight sign-in bridge. Paired from the Admin page, or seeded from
// the environment on a first boot; unpaired, the lobby never offers the button.
const sso = createSsoRuntime({ settingsStore, envConfig: config.gamenight, log: structuredLog });
// init() is not called here: it reads the stored pairing, and the settings are
// not loaded until openStores() below. Reading now would find an empty store
// and seed the environment over a pairing somebody set from the page.

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
  store: tournamentStore,
  accounts,
  mailer,
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
  adminCredential,
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
});
// Registrations survive a restart; a running tournament does not.
const restoredTournaments = tournamentLayer.registry.restore();

// Flush both stores on the way out. Installed only when run directly, so the
// test harness (which requires this module many times) never stacks handlers.
function flushStores() {
  try {
    adminLog.flush();
  } catch (_err) {
    /* nothing better to do on the way out */
  }
  try {
    identity.flush();
  } catch (_err) {
    /* nothing better to do on the way out */
  }
  try {
    tournamentLayer.registry.flush();
  } catch (_err) {
    /* as above */
  }
  try {
    if (chatStore) chatStore.flush();
  } catch (_err) {
    /* as above */
  }
  try {
    if (handHistoryStore) handHistoryStore.flush();
  } catch (_err) {
    /* as above */
  }
  try {
    accounts.flush();
  } catch (_err) {
    /* as above */
  }
}
if (require.main === module) {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      flushStores();
      process.exit(0);
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
          try {
            adminLog.flush();
          } catch (_err) {
            /* the row is already in memory; the disk is best effort here */
          }
          reject(err);
        });
        server.listen(port, host, () => {
          if (restoredTournaments) {
            console.log(
              `Restored ${restoredTournaments} scheduled tournament(s) from ${tournamentStore.file}`
            );
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
  await settingsStore.load();
  // Everything that reads a setting at boot, now that there are settings to
  // read: the GameNight pairing set from the Admin page beats the environment,
  // and it can only know that once the store has loaded.
  sso.init();
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
  settingsStore,
  db,
  handHistoryStore,
  accounts,
  mailer,
  adminCredential,
  flushStores,
  startServer,
  config,
  sanitizeName,
  normalizeNameKey,
};

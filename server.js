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
const { loadConfig, mailFromEnv } = require('./server/config');
const { applySecurityHeaders, createRateLimiter } = require('./server/http-middleware');
const { registerTournamentHandlers } = require('./server/tournament-handlers');
const { createSettingsStore } = require('./server/settings-store');
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

// Said once at boot, to the log rather than to every browser: why this server
// cannot hold an account is whoever runs it's business, and a player only
// needs to know that it cannot.
if (!mailer.available()) {
  structuredLog({
    level: 'info',
    event: 'accounts_unavailable',
    message: 'Nobody can sign up here',
    data: { reason: mailer.why() },
  });
}

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
  store: tournamentStore,
  accounts,
  mailer,
  mail,
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
        detail: 'Set ADMIN_PROMOTE to the name of an account here and start the server again.',
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

  // Now that the pairing is known, the one thing worth stopping to say. An
  // account is the only way in; a server that can send no mail and is paired
  // with no GameNight has no way for anybody to become anybody, including
  // whoever is trying to set it up.
  if (!mailer.available() && !sso.get()) {
    structuredLog({
      level: 'error',
      event: 'no_way_in',
      message: 'Nobody can sign in to this server',
      data: {
        detail:
          'Set PUBLIC_URL and SMTP_URL so accounts can be made, or pair the server with a GameNight.',
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
  flushStores,
  startServer,
  config,
  sanitizeName,
  normalizeNameKey,
};

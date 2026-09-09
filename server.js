// server.js - Main poker server
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { createIdentityStore } = require('./server/identity');
const { createTournamentStore } = require('./server/tournament-store');
const { createChatStore } = require('./server/chat-store');
const { loadLocalEnv } = require('./server/load-env');
const { loadConfig } = require('./server/config');
const { applySecurityHeaders, createRateLimiter } = require('./server/http-middleware');
const { registerTournamentHandlers } = require('./server/tournament-handlers');
const { computeAssetVersion, renderIndexTemplate } = require('./server/asset-version');
const { createStructuredLogger } = require('./server/logger');

loadLocalEnv(__dirname);
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

app.get('/api/status', (req, res) => {
  res.json({
    activeTournaments: tournamentLayer.tournaments.size,
  });
});

// Who a player is: name + avatar behind a device token, persisted beside the
// saves. See server/identity.js for the interface a login backend would fill.
const identity = createIdentityStore({
  saveDir: process.env.SAVE_DIR || path.join(__dirname, 'data'),
  sanitizeName,
  sanitizeAvatar,
});

const tournamentStore = createTournamentStore({
  saveDir: process.env.SAVE_DIR || path.join(__dirname, 'data'),
});

// Chat, in its own file per tournament so it never rides along with the
// registration writes. Absent when chat is switched off, which is what stops
// an operator who disabled it from finding files still appearing.
const chatStore = config.chatEnabled
  ? createChatStore({ saveDir: process.env.SAVE_DIR || path.join(__dirname, 'data') })
  : null;

const tournamentLayer = registerTournamentHandlers({
  io,
  identity,
  store: tournamentStore,
  sanitizeName,
  normalizeNameKey,
  sanitizeAvatar,
  maxTournaments: config.maxTournaments,
  finishedTtlMs: config.tournamentFinishedTtlMs,
  abandonGraceMs: config.tournamentAbandonGraceMs,
  hostTransferGraceMs: config.hostTransferGraceMs,
  sweepMs: config.tournamentSweepMs,
  handPauseMs: config.handPauseMs,
  adminPassword: config.adminPassword,
  tableOptions: { streetPauseMs: config.streetPauseMs },
  chatStore,
  chatEnabled: config.chatEnabled,
  chatHistory: config.chatHistory,
  chatMaxLength: config.chatMaxLength,
  chatRatePerWindow: config.chatRatePerWindow,
  chatRateWindowMs: config.chatRateWindowMs,
});
// Registrations survive a restart; a running tournament does not.
const restoredTournaments = tournamentLayer.registry.restore();

// Flush both stores on the way out. Installed only when run directly, so the
// test harness (which requires this module many times) never stacks handlers.
function flushStores() {
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

  return new Promise((resolve) => {
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
        },
      });

      resolve({ app, server, io, config });
    });
  });
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
  flushStores,
  startServer,
  config,
  sanitizeName,
  normalizeNameKey,
};

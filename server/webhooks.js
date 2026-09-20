// webhooks.js - what this server tells GameNight, and how hard it tries.
//
// A game GameNight made over the API can name an address and a secret. From
// then on this server sends it every bust-out, every re-entry, and the
// ending, each as a signed JSON POST. Nothing here is fire-and-forget: a
// delivery is written down before the first attempt, tried again on a
// backoff for about a day if GameNight is not answering, and given up on
// loudly. A restart in the middle loses nothing - the outbox is a table.
//
// In order, per game. A bust-out reported after the ending it belongs to
// would be a puzzle on the other side, so a game's second row waits for its
// first; a row that has been given up on releases the ones behind it, or one
// dead delivery would hold the standings hostage for ever.
//
// The secret is in the row. It has to be: the game is gone ten minutes after
// it ends and a retry hours later still has to sign. It never reaches a log
// line, a browser, or the admin Log.

const crypto = require('crypto');

// When to try again, by how many times it has failed. Roughly a day in all,
// which is long enough for a deploy or an outage on the other side and short
// enough that a wrong address is found out the same day.
const BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000];
const BACKOFF_WORDS = ['1 minute', '5 minutes', '30 minutes', '2 hours', '6 hours', '12 hours'];
// How many games are sent to at once. Small: GameNight is one server.
const MAX_IN_FLIGHT = 4;
// How long a delivered or abandoned row is kept, so a delivery can be
// answered for, and a second bound by count for a very busy week.
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ROWS = 5000;
const MAX_ERROR = 200;

function sign(secret, ts, body) {
  return crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

// What a failure is called in a log line. Never the URL, which may carry a
// password in it, and never the body.
function describe(err, timeoutMs) {
  if (err && err.name === 'AbortError') return `no answer in ${Math.round(timeoutMs / 1000)} s`;
  const code = err && ((err.cause && err.cause.code) || err.code);
  const text = String(code || (err && err.message) || err || 'failed');
  return text.replace(/\/\/[^/@\s]+@/g, '//').slice(0, MAX_ERROR);
}

function createWebhooks(options = {}) {
  const {
    db = null,
    log = () => {},
    now = () => Date.now(),
    fetchImpl = globalThis.fetch,
    timeoutMs = 8000,
    sweepMs = 5000,
    version = '0.0.0',
  } = options;
  const timers = options.timers || {
    setInterval: (...a) => setInterval(...a),
    clearInterval: (...a) => clearInterval(...a),
    setTimeout: (...a) => setTimeout(...a),
    clearTimeout: (...a) => clearTimeout(...a),
  };

  let rows = [];
  let nextId = 1;
  const dirty = new Set();
  const inFlight = new Set(); // gameIds with an attempt under way
  // The write under way, if one is: a flush waits for it and then for its own.
  let writing = null;
  let sweepTimer = null;
  let nudgeTimer = null;
  let sweeps = 0;

  const open = (row) => !row.deliveredAt && !row.abandonedAt;
  const byId = (id) => rows.find((r) => r.id === id);

  // ── The rows ────────────────────────────────────────────────────────────

  // Written down and, on the next tick, tried. Nothing for a game that gave
  // no address.
  function enqueue({ entry, event, payload } = {}) {
    if (!entry || !entry.webhook || !event) return null;
    const at = now();
    const row = {
      id: nextId++,
      gameId: entry.id,
      externalId: entry.webhook.externalId || null,
      event,
      url: entry.webhook.url,
      secret: entry.webhook.secret,
      game: { id: entry.id, name: entry.name, external_id: entry.webhook.externalId || null },
      payload: payload || {},
      attempts: 0,
      nextAt: at,
      deliveredAt: null,
      abandonedAt: null,
      lastError: null,
      createdAt: at,
      // Not sent until the write has landed: a delivery the receiver has and
      // this server has no record of is the one thing the table is for.
      written: !db,
    };
    rows.push(row);
    dirty.add(row.id);
    flushAsync();
    nudge();
    return row.id;
  }

  function nudge() {
    if (nudgeTimer) return;
    nudgeTimer = timers.setTimeout(() => {
      nudgeTimer = null;
      sweep();
    }, 0);
    if (nudgeTimer && nudgeTimer.unref) nudgeTimer.unref();
  }

  // ── Sending ─────────────────────────────────────────────────────────────

  function fail(row, error) {
    row.attempts += 1;
    row.lastError = error;
    const label = `${row.event} for ${row.game.name}`;
    if (row.attempts > BACKOFF_MS.length) {
      row.abandonedAt = now();
      log({
        level: 'error',
        event: 'webhook_abandoned',
        message: 'Gave up delivering a webhook',
        data: { detail: `${label} after ${row.attempts} tries: ${error}`, gameId: row.gameId },
      });
      return;
    }
    row.nextAt = now() + BACKOFF_MS[row.attempts - 1];
    log({
      // Once in the admin Log, when it first goes wrong; the retries are
      // the server's business until it gives up.
      level: row.attempts === 1 ? 'warn' : 'info',
      event: 'webhook_failed',
      message: 'Could not deliver a webhook',
      data: {
        detail: `${label}: ${error}; trying again in ${BACKOFF_WORDS[row.attempts - 1]}`,
        gameId: row.gameId,
        attempt: row.attempts,
      },
    });
  }

  async function deliver(row) {
    const ts = now();
    const body = JSON.stringify({
      event: row.event,
      delivery_id: row.id,
      sent_at: ts,
      game: row.game,
      ...row.payload,
    });
    const controller = new AbortController();
    const timer = timers.setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (typeof fetchImpl !== 'function') throw new Error('No HTTP client available');
      const res = await fetchImpl(row.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': `FinalTable/${version}`,
          'X-FinalTable-Event': row.event,
          'X-FinalTable-Delivery': String(row.id),
          'X-FinalTable-Timestamp': String(ts),
          'X-FinalTable-Signature': `sha256=${sign(row.secret, ts, body)}`,
        },
        body,
        signal: controller.signal,
        // A signed POST is not walked to another address: a redirect is an
        // answer, and not the one that counts.
        redirect: 'manual',
      });
      if (res && res.ok) {
        row.deliveredAt = now();
        row.lastError = null;
        row.attempts += 1;
        log({
          level: 'info',
          event: 'webhook_delivered',
          message: 'Delivered a webhook',
          data: {
            event: row.event,
            gameId: row.gameId,
            deliveryId: row.id,
            attempts: row.attempts,
          },
        });
      } else {
        fail(row, `answered ${res ? res.status : 'nothing'}`);
      }
    } catch (err) {
      fail(row, describe(err, timeoutMs));
    } finally {
      timers.clearTimeout(timer);
    }
    dirty.add(row.id);
    flushAsync();
  }

  // One pass: for every game, its oldest open row, tried if it is due and
  // written. Answers when this pass's attempts have settled.
  function sweep() {
    sweeps += 1;
    const at = now();
    const heads = new Map();
    for (const row of rows) {
      if (!open(row)) continue;
      const head = heads.get(row.gameId);
      if (!head || row.id < head.id) heads.set(row.gameId, row);
    }
    const attempts = [];
    for (const row of heads.values()) {
      if (inFlight.size >= MAX_IN_FLIGHT) break;
      if (inFlight.has(row.gameId) || !row.written || row.nextAt > at) continue;
      inFlight.add(row.gameId);
      attempts.push(deliver(row).finally(() => inFlight.delete(row.gameId)));
    }
    if (sweepMs > 0 && sweeps % Math.max(1, Math.round(3600000 / sweepMs)) === 0) prune(at);
    return Promise.all(attempts);
  }

  // ── What is written down ────────────────────────────────────────────────

  function flushAsync() {
    if (!db) return Promise.resolve();
    // Behind the write under way, and then whatever has changed since.
    if (writing) return writing.then(() => (dirty.size ? flushAsync() : undefined));
    if (!dirty.size) return Promise.resolve();
    const batch = [...dirty].map(byId).filter(Boolean);
    dirty.clear();
    writing = Promise.resolve()
      .then(async () => {
        for (const row of batch) {
          const { written, ...stored } = row;
          void written;
          await db.webhooks.put(stored);
          row.written = true;
        }
      })
      .catch((err) => {
        for (const row of batch) dirty.add(row.id);
        log({
          level: 'warn',
          event: 'webhook_write_failed',
          message: 'Could not write the webhook outbox',
          data: { detail: err && err.message },
        });
      })
      .then(() => {
        writing = null;
        return dirty.size ? flushAsync() : undefined;
      });
    return writing;
  }

  function flush() {
    if (nudgeTimer) {
      timers.clearTimeout(nudgeTimer);
      nudgeTimer = null;
    }
    return flushAsync();
  }

  function prune(at = now()) {
    const cutoff = at - KEEP_MS;
    rows = rows.filter((r) => open(r) || (r.deliveredAt || r.abandonedAt) >= cutoff);
    const done = rows.filter((r) => !open(r));
    if (done.length > MAX_ROWS) {
      const drop = new Set(done.slice(0, done.length - MAX_ROWS).map((r) => r.id));
      rows = rows.filter((r) => !drop.has(r.id));
    }
    if (db) db.webhooks.prune({ olderThan: cutoff }).catch(() => {});
  }

  // Everything, before the server listens, and the sender started.
  async function load() {
    rows = [];
    nextId = 1;
    dirty.clear();
    if (db) {
      try {
        rows = (await db.webhooks.all()).map((r) => ({ ...r, written: true }));
        nextId = rows.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0) + 1;
      } catch (err) {
        rows = [];
        log({
          level: 'error',
          event: 'webhook_load_failed',
          message: 'Could not read the webhook outbox back',
          data: { detail: err && err.message },
        });
      }
    }
    prune();
    if (!sweepTimer && sweepMs > 0) {
      sweepTimer = timers.setInterval(sweep, sweepMs);
      if (sweepTimer && sweepTimer.unref) sweepTimer.unref();
    }
    return rows.length;
  }

  // For the API's answer: how a game's deliveries stand. Never a secret.
  function status(gameId) {
    const mine = rows.filter((r) => r.gameId === gameId);
    const errored = mine.filter((r) => r.lastError).sort((a, b) => b.id - a.id)[0];
    return {
      pending: mine.filter(open).length,
      delivered: mine.filter((r) => r.deliveredAt).length,
      abandoned: mine.filter((r) => r.abandonedAt).length,
      lastError: errored ? errored.lastError : null,
    };
  }

  function stop() {
    if (sweepTimer) {
      timers.clearInterval(sweepTimer);
      sweepTimer = null;
    }
    return flush();
  }

  return { enqueue, load, sweep, flush, prune, status, stop };
}

module.exports = { createWebhooks, sign, BACKOFF_MS };

// hand-history-store.js - the hands a game was played with, kept.
//
// One row per game, with the hands as a document beside the handful of things
// anybody ever asks a question about, and a second table saying who played in
// which. That table is the point of being here rather than in a file: "the
// games I was in" is a join, the two bounds are DELETEs, and being handed a
// game somebody did not play in is impossible rather than merely checked.
//
// It outlives its tournament. A game is reaped ten minutes after its winner
// and its chat goes with it; its hands do not, because the point of them is
// that you still have them tomorrow.
//
// What is held in memory is only what a restart needs: the games being
// restored, primed before the server listens, because seating a field again is
// synchronous and cannot wait for a query. Everything else is read when asked.
//
// The rows hold every seat's cards, as the server has always recorded them.
// Nothing reads one raw: every path out goes through visibleCardsFor in
// hand-history.js, which is the one place that rule is written.

const FLUSH_DEBOUNCE_MS = 1000;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_GAMES = 200;

function createHandHistoryStore(options = {}) {
  const {
    db = null,
    ttlMs: ttlAtBoot = TTL_MS,
    maxGames: maxGamesAtBoot = MAX_GAMES,
    flushDebounceMs = FLUSH_DEBOUNCE_MS,
    log = () => {},
    now = () => Date.now(),
  } = options;

  // Both bounds can be changed from the Admin page while the server runs.
  // Safe to move, because nothing holds them: prune() reads them on each
  // sweep, so a change lands at the next one.
  let ttlMs = ttlAtBoot;
  let maxGames = maxGamesAtBoot;

  function setLimits(next = {}) {
    if (Number.isFinite(next.ttlMs) && next.ttlMs >= 0) ttlMs = next.ttlMs;
    if (Number.isFinite(next.maxGames) && next.maxGames > 0) maxGames = next.maxGames;
    return { ttlMs, maxGames };
  }

  // id -> { meta, hands, uids }, waiting to be written
  const pending = new Map();
  // id -> { meta, hands }, read before the server listened
  const primed = new Map();
  let flushTimer = null;
  let writing = false;
  let writeQueued = false;

  const str = (v, limit = 64) => (v === undefined || v === null ? null : String(v).slice(0, limit));
  const num = (v) => (Number.isFinite(v) ? v : null);

  // ── Writing ─────────────────────────────────────────────────────────────

  function record(id, meta = {}, hands = []) {
    if (!db || !id) return;
    const rows = Array.isArray(hands) ? hands : [];
    pending.set(id, {
      meta: {
        id,
        name: str(meta.name),
        startedAt: num(meta.startedAt),
        endedAt: num(meta.endedAt),
        // What the age bound falls back to: a game abandoned mid-play has no
        // ending and must still age out.
        touchedAt: now(),
        hands: rows.length,
      },
      hands: rows,
      uids: [...new Set((meta.uids || []).filter(Boolean))],
    });
    schedule();
  }

  function schedule() {
    if (!db || flushTimer) return;
    flushTimer = setTimeout(flushAsync, flushDebounceMs);
    if (flushTimer.unref) flushTimer.unref();
  }

  function flushAsync() {
    flushTimer = null;
    if (!db) return Promise.resolve();
    if (writing) {
      writeQueued = true;
      return Promise.resolve();
    }
    if (!pending.size) return Promise.resolve();
    writing = true;
    // Taken up front, so a hand landing mid-write is in the next batch rather
    // than lost between the copy and the query.
    const batch = [...pending.values()];
    pending.clear();
    return Promise.all(batch.map((row) => db.games.put(row.meta, row.hands, row.uids)))
      .catch((err) => {
        log({
          level: 'warn',
          event: 'history_write_failed',
          message: 'Could not write a game’s hands',
          data: { detail: err && err.message },
        });
      })
      .then(() => {
        writing = false;
        if (writeQueued || pending.size) {
          writeQueued = false;
          schedule();
        }
      });
  }

  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    writeQueued = false;
    return flushAsync();
  }

  // ── Reading ─────────────────────────────────────────────────────────────

  // The games a restart is about to seat again, read before it starts. Only
  // those: two hundred games of hands is not something to hold in memory for
  // the sake of the two that are still being played.
  async function primeFor(ids) {
    primed.clear();
    if (!db) return 0;
    for (const id of ids || []) {
      if (!id) continue;
      const kept = await db.games.get(id);
      if (kept) primed.set(id, kept);
    }
    return primed.size;
  }

  // Synchronous, and only answers for a game that was primed or is waiting to
  // be written. This is the restore path; everything else asks the database.
  function load(id) {
    const waiting = pending.get(id);
    if (waiting) return { meta: waiting.meta, hands: waiting.hands };
    return primed.get(id) || null;
  }

  // The whole of one game, asked for by somebody who wants to take it away.
  async function get(id) {
    const waiting = pending.get(id);
    if (waiting) return { meta: waiting.meta, hands: waiting.hands };
    if (!db) return null;
    return db.games.get(id);
  }

  // The games one player was in, newest first. Never carries the uids: it is a
  // list of games, not a list of who else was there.
  async function listFor(uid) {
    if (!db || !uid) return [];
    const shape = (row) => ({
      id: row.id,
      name: row.name,
      startedAt: row.startedAt,
      endedAt: row.endedAt || row.touchedAt || null,
      hands: row.hands || 0,
    });
    const found = new Map();
    for (const row of await db.games.listFor(uid)) found.set(row.id, shape(row));
    // And what has been recorded but not yet written. The write is debounced
    // by a second, and a game that has just ended and is asked for in the same
    // breath must not read as though it never happened.
    for (const row of pending.values()) {
      if (row.uids.includes(uid)) found.set(row.meta.id, shape(row.meta));
    }
    return [...found.values()].sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
  }

  // Did this player play in that game? The uid is the whole authorisation:
  // nobody is handed a game they were not in.
  async function played(uid, id) {
    if (!db || !uid || !id) return false;
    // A game whose first write has not landed yet is still theirs.
    const waiting = pending.get(id);
    if (waiting) return waiting.uids.includes(uid);
    return db.games.played(uid, id);
  }

  // ── Forgetting ──────────────────────────────────────────────────────────

  function remove(id) {
    pending.delete(id);
    primed.delete(id);
    if (!db) return Promise.resolve();
    return db.games.remove(id).catch(() => {});
  }

  // Two bounds, as the admin log has: an age, which is what a player thinks
  // in, and a count, which is what stops a busy month filling a disk. Both are
  // one query each here rather than a pass over everything.
  async function prune(at = now()) {
    if (!db) return 0;
    return db.games.prune({
      olderThan: ttlMs > 0 ? at - ttlMs : null,
      keepNewest: maxGames,
    });
  }

  async function size() {
    return db ? db.games.count() : 0;
  }

  return {
    record,
    load,
    get,
    primeFor,
    listFor,
    played,
    remove,
    prune,
    flush,
    flushAsync,
    size,
    setLimits,
    get limits() {
      return { ttlMs, maxGames };
    },
  };
}

module.exports = { createHandHistoryStore };

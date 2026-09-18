// admin-log.js - what the server has done, for the Admin page's Log.
//
// The server writes structured JSON to its own output and keeps none of it,
// which is fine until somebody asks what games this box has run, or why it
// restarted nine times last Tuesday. Answering either meant a shell on the
// host and a container that had not been recreated since. This is the same
// information, kept, and readable behind the password that is already there.
//
// Rewritten whole rather than appended to, for chat-store.js's reason: the
// rows are a ring in memory, so the file cannot exceed a known size, and a
// whole-file write means no compaction pass and no parsing backwards from the
// end of a file to find the last N lines. What we hold is what we write.
//
// Two bounds, not one. The age is what an admin thinks in - "the last three
// months" - and the count is what stops a busy fortnight from mattering.
// Either alone leaves the other case open, and this is the first collection
// here that is bounded and also persisted, so it is worth being exact.
//
// What must never be in it: a hole card, a device token, a password, or a
// join code. Every row is built from an allowlist for that reason - the
// logger's `data` is open-ended and a log a browser can read is a log that
// leaks if anything else does.

const FLUSH_DEBOUNCE_MS = 1000;
const MAX_ROWS = 2000;
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
// One page of rows. An admin reads a screenful; a log of thousands is paged
// rather than sent whole, the way nothing else on the admin surface is.
const PAGE_LIMIT = 100;
// How long after somebody's last sign-in row another one is worth keeping.
//
// A row was written on every identify, which is every page load, every reload
// and every reconnect. One evening of testing put eight rows in for one person
// and one row in for the game they played, and the ring is bounded, so the
// noise would eventually push the history off the end of the file. What an
// admin wants is who has been on this server, not how many times their browser
// said hello. An hour collapses a reload, a restart and a dropped connection
// into the visit they belong to, and still separates the morning from the
// evening.
const SIGNIN_GAP_MS = 60 * 60 * 1000;
// Long enough to say what happened, short enough that a stack trace cannot
// turn one bad night into the whole file.
const MAX_TEXT = 500;

function createAdminLog(options = {}) {
  const {
    db = null,
    log = () => {},
    maxRows = MAX_ROWS,
    maxAgeMs = MAX_AGE_MS,
    signInGapMs = SIGNIN_GAP_MS,
    flushDebounceMs = FLUSH_DEBOUNCE_MS,
    now = () => Date.now(),
  } = options;
  let rows = [];
  let nextId = 1;
  // When each uid was last written down, so a reload does not earn a row of
  // its own. Rebuilt on load, so a restart does not reset everybody's visit.
  const lastSignIn = new Map();
  let flushTimer = null;
  let writing = false;
  let writeQueued = false;
  // Rows are only ever added, never changed, so what is waiting to be written
  // is a list of new ones rather than the whole log.
  let unwritten = [];
  let prunedTo = 0;

  function text(value, limit = MAX_TEXT) {
    if (value === undefined || value === null) return undefined;
    const s = String(value);
    return s.length > limit ? s.slice(0, limit) + '…' : s;
  }

  function num(value) {
    return Number.isFinite(value) ? value : undefined;
  }

  // Drop what is too old and what is past the count, oldest first. Called on
  // every write and on load, because a file can come back holding rows that
  // aged out while the process was not running.
  function prune(at = now()) {
    const before = rows.length;
    if (maxAgeMs > 0) {
      const cutoff = at - maxAgeMs;
      rows = rows.filter((r) => r.at >= cutoff);
      // Remembered rather than done here: the database is told once, on the
      // next write, instead of being asked to delete on every row that lands.
      prunedTo = cutoff;
    }
    if (rows.length > maxRows) rows = rows.slice(rows.length - maxRows);
    if (rows.length !== before && !prunedTo) prunedTo = 1;
  }

  function push(row) {
    const at = now();
    const stored = { id: nextId++, at, ...row };
    rows.push(stored);
    unwritten.push(stored);
    prune(at);
    schedule();
    return stored;
  }

  // ── What can be written ─────────────────────────────────────────────────
  // Three kinds, three allowlists. Nothing here spreads an object it was
  // handed; every field is named.

  function recordGame(game = {}) {
    return push({
      kind: 'game',
      gameId: text(game.id, 64),
      name: text(game.name, 64),
      // How it ended, in the words the server already uses: 'finished',
      // 'cancelled by the host', 'nobody came back', and the rest.
      ended: text(game.ended, 64) || 'ended',
      startedAt: num(game.startedAt),
      finishedAt: num(game.finishedAt),
      entrants: num(game.entrants),
      humans: num(game.humans),
      level: num(game.level),
      hands: num(game.hands),
      winner: text(game.winner, 32),
      // The name as it was, because that is the only name there is: the
      // standings carry no uid, and a guest identity is gone thirty days
      // later anyway.
      places: Array.isArray(game.places)
        ? game.places.slice(0, 8).map((p) => ({
            place: num(p && p.place),
            name: text(p && p.name, 32),
            prize: num(p && p.prize),
          }))
        : undefined,
    });
  }

  // One row a visit, not one a hello. A player who reloads, reconnects or comes
  // back after a restart is the same visit and writes nothing; see
  // SIGNIN_GAP_MS. Somebody the server has never seen is always written down,
  // whatever else is going on.
  function recordSignIn(who = {}) {
    const uid = text(who.uid, 64);
    const at = now();
    if (uid && who.isNew !== true && signInGapMs > 0) {
      const last = lastSignIn.get(uid);
      if (last !== undefined && at - last < signInGapMs) return null;
    }
    if (uid) lastSignIn.set(uid, at);
    return push({
      kind: 'signin',
      uid,
      name: text(who.name, 32),
      provider: text(who.provider, 32) || 'guest',
      isNew: who.isNew === true ? true : undefined,
    });
  }

  function recordServer(entry = {}) {
    return push({
      kind: 'server',
      level: text(entry.level, 16) || 'info',
      event: text(entry.event, 64),
      message: text(entry.message),
      // One free-text field, capped. Whatever the caller thought was worth
      // saying - an error string, a stack's first lines, a file that could
      // not be read - and never the whole of a logger payload.
      detail: text(entry.detail),
    });
  }

  // ── Reading ─────────────────────────────────────────────────────────────

  // Newest first, a page at a time. `before` is a row id, so paging is stable
  // while rows are still arriving at the other end.
  function list({ limit = PAGE_LIMIT, before = null } = {}) {
    const cap = Math.max(1, Math.min(PAGE_LIMIT, Number(limit) || PAGE_LIMIT));
    let all = rows;
    if (Number.isFinite(before)) all = all.filter((r) => r.id < before);
    const page = all.slice(-cap).reverse();
    return { rows: page, more: all.length > page.length };
  }

  function size() {
    return rows.length;
  }

  // ── What is written down ────────────────────────────────────────────────

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
    if (!unwritten.length && !prunedTo) return Promise.resolve();
    writing = true;
    const batch = unwritten;
    unwritten = [];
    // The bounds, as queries. This is the half of moving here that was worth
    // having on its own: the age bound used to mean walking every row held in
    // memory and then writing the whole file out again.
    const bounds = prunedTo ? { olderThan: prunedTo, keepNewest: maxRows } : null;
    prunedTo = 0;
    return Promise.resolve()
      .then(() => (batch.length ? db.adminLog.add(batch) : null))
      .then(() => (bounds ? db.adminLog.prune(bounds) : null))
      .catch((err) => {
        log({
          level: 'warn',
          event: 'admin_log_write_failed',
          message: 'Could not write the admin log',
          data: { detail: err && err.message },
        });
      })
      .then(() => {
        writing = false;
        if (writeQueued || unwritten.length || prunedTo) {
          writeQueued = false;
          schedule();
        }
      });
  }

  // The shutdown path: what is waiting, written now.
  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    writeQueued = false;
    return flushAsync();
  }

  // The newest page of it, before the server listens. Only as many as the
  // count bound keeps: an older row is one nothing would ever show.
  async function load() {
    rows = [];
    nextId = 1;
    unwritten = [];
    lastSignIn.clear();
    if (!db) return 0;
    // recent() answers newest first; the ring is oldest first.
    rows = (await db.adminLog.recent(maxRows)).slice().reverse();
    nextId = rows.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0) + 1;
    prune();
    // The visit a restart landed in the middle of is still that visit.
    for (const r of rows) {
      if (r.kind === 'signin' && r.uid) lastSignIn.set(r.uid, r.at);
    }
    return rows.length;
  }

  return {
    recordGame,
    recordSignIn,
    recordServer,
    list,
    size,
    load,
    flush,
    limits: { maxRows, maxAgeMs, signInGapMs, pageLimit: PAGE_LIMIT },
  };
}

module.exports = { createAdminLog, PAGE_LIMIT };

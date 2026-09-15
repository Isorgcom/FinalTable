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

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const FILE_VERSION = 1;
const FLUSH_DEBOUNCE_MS = 1000;
const MAX_ROWS = 2000;
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
// One page of rows. An admin reads a screenful; a log of thousands is paged
// rather than sent whole, the way nothing else on the admin surface is.
const PAGE_LIMIT = 100;
// Long enough to say what happened, short enough that a stack trace cannot
// turn one bad night into the whole file.
const MAX_TEXT = 500;

function createAdminLog(options = {}) {
  const {
    saveDir = null,
    maxRows = MAX_ROWS,
    maxAgeMs = MAX_AGE_MS,
    flushDebounceMs = FLUSH_DEBOUNCE_MS,
    now = () => Date.now(),
  } = options;
  const file = saveDir ? path.join(saveDir, 'admin-log.json') : null;

  let rows = [];
  let nextId = 1;
  let flushTimer = null;
  let writing = false;
  let writeQueued = false;
  let tmpSeq = 0;

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
    if (maxAgeMs > 0) {
      const cutoff = at - maxAgeMs;
      rows = rows.filter((r) => r.at >= cutoff);
    }
    if (rows.length > maxRows) rows = rows.slice(rows.length - maxRows);
  }

  function push(row) {
    const at = now();
    const stored = { id: nextId++, at, ...row };
    rows.push(stored);
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

  function recordSignIn(who = {}) {
    return push({
      kind: 'signin',
      uid: text(who.uid, 64),
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

  // ── The disk ────────────────────────────────────────────────────────────

  function schedule() {
    if (!file || flushTimer) return;
    flushTimer = setTimeout(flushAsync, flushDebounceMs);
    if (flushTimer.unref) flushTimer.unref();
  }

  function body() {
    return JSON.stringify({ version: FILE_VERSION, rows });
  }

  function flushAsync() {
    flushTimer = null;
    if (!file) return;
    if (writing) {
      writeQueued = true;
      return;
    }
    writing = true;
    // Serialised up front, so what lands is the snapshot that existed when the
    // flush fired and only the write and the rename happen late.
    const snapshot = body();
    // A tmp path of its own per write, as identity.js does: flush() uses
    // `${file}.tmp`, and a shutdown landing on an in-flight write must not
    // share a file with it.
    tmpSeq = (tmpSeq + 1) % 1e6;
    const tmp = `${file}.${process.pid}.${tmpSeq}.tmp`;
    fsp
      .mkdir(path.dirname(file), { recursive: true })
      .then(() => fsp.writeFile(tmp, snapshot))
      .then(() => fsp.rename(tmp, file))
      .catch(() => fsp.rm(tmp, { force: true }).catch(() => {}))
      .then(() => {
        writing = false;
        if (writeQueued) {
          writeQueued = false;
          schedule();
        }
      });
  }

  // Synchronous on purpose: the shutdown path, where an async write would
  // never land. Mirrors identity.js's flush().
  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    writeQueued = false;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, body());
      fs.renameSync(tmp, file);
    } catch (_err) {
      // A log is not worth failing a shutdown over.
    }
  }

  function load() {
    if (!file || !fs.existsSync(file)) return 0;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const saved = Array.isArray(data.rows) ? data.rows : [];
      rows = saved.filter((r) => r && Number.isFinite(r.at) && typeof r.kind === 'string');
      // Ids come back with the rows so that paging survives a restart; the
      // next one carries on from the highest there was.
      nextId = rows.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0) + 1;
      prune();
    } catch (_err) {
      rows = []; // a corrupt file starts empty, as every other store here does
      nextId = 1;
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
    file,
    limits: { maxRows, maxAgeMs, pageLimit: PAGE_LIMIT },
  };
}

module.exports = { createAdminLog, PAGE_LIMIT };

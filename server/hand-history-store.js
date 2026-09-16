// hand-history-store.js - the hands a game was played with, kept.
//
// One file per tournament under a directory of its own, which is chat-store's
// shape and for chat-store's reason: tournaments.json is rewritten whole on
// every registration change, and a game's hands would multiply the cost of
// writes that have nothing to do with them.
//
// Written whole rather than appended to, which is the opposite of what a log
// usually wants and is right here for the reason chat-store gives: the
// director's history is already ring-bounded, so the file cannot exceed a
// known size, and rewriting it means no compaction pass and no parsing
// backwards from the end of a file to find the last N hands.
//
// Two things this does that chat-store does not.
//
// It outlives its tournament. A game is reaped ten minutes after the winner
// and its chat goes with it; its hands do not, because the point of them is
// that you still have them tomorrow. They age out on a clock of their own.
//
// And it keeps an index - one small file naming, for each game, who played in
// it. That is what answers "which games was I in" without reading every file
// on the disk, and it is the only reason a player can be handed a game that
// the registry has long since forgotten.
//
// The files hold every seat's cards, as the server has always recorded them.
// Nothing reads one raw: every path out goes through visibleCardsFor in
// hand-history.js, which is the one place that rule is written.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const FLUSH_DEBOUNCE_MS = 1000;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_GAMES = 200;
const INDEX_NAME = '_index.json';

function createHandHistoryStore(options = {}) {
  const {
    saveDir = null,
    ttlMs = TTL_MS,
    maxGames = MAX_GAMES,
    flushDebounceMs = FLUSH_DEBOUNCE_MS,
    now = () => Date.now(),
  } = options;
  const dir = saveDir ? path.join(saveDir, 'history') : null;
  const indexFile = dir ? path.join(dir, INDEX_NAME) : null;

  // id -> { id, name, startedAt, endedAt, touchedAt, hands, uids }
  const index = new Map();
  // id -> the rows to write, taken whole rather than as a delta so the write
  // coalesces: three hands in a second cost one write of the result.
  const dirty = new Map();
  let indexDirty = false;
  let flushTimer = null;
  let writing = false;
  let writeQueued = false;
  let tmpSeq = 0;

  function fileFor(id) {
    return dir && id ? path.join(dir, `${encodeURIComponent(id)}.json`) : null;
  }

  const str = (v, limit = 64) => (v === undefined || v === null ? null : String(v).slice(0, limit));
  const num = (v) => (Number.isFinite(v) ? v : null);

  // ── Writing ─────────────────────────────────────────────────────────────

  function record(id, meta = {}, hands = []) {
    if (!dir || !id) return;
    const rows = Array.isArray(hands) ? hands : [];
    const before = index.get(id);
    const uids = [...new Set((meta.uids || []).filter(Boolean))];
    const row = {
      id,
      name: str(meta.name),
      startedAt: num(meta.startedAt),
      endedAt: num(meta.endedAt),
      // When it was last written to, which is what the age bound falls back
      // to: a game abandoned mid-play has no ending and must still age out.
      touchedAt: now(),
      hands: rows.length,
      uids,
    };
    index.set(id, row);
    dirty.set(id, rows);
    // The index is small but it is rewritten whole, so it is not rewritten
    // for a hand count that moved. What earns a write is a game appearing, a
    // game ending, or somebody new being in it - the count rides along with
    // the next one of those and with the flush at shutdown.
    if (
      !before ||
      before.name !== row.name ||
      before.endedAt !== row.endedAt ||
      before.uids.length !== uids.length
    ) {
      indexDirty = true;
    }
    schedule();
  }

  function schedule() {
    if (!dir || flushTimer) return;
    flushTimer = setTimeout(flushAsync, flushDebounceMs);
    if (flushTimer.unref) flushTimer.unref();
  }

  function indexBody() {
    return JSON.stringify({ version: 1, games: [...index.values()] });
  }

  function flushAsync() {
    flushTimer = null;
    if (!dir) return;
    if (writing) {
      writeQueued = true;
      return;
    }
    if (!dirty.size && !indexDirty) return;
    writing = true;
    const batch = [...dirty.entries()];
    dirty.clear();
    const wantIndex = indexDirty;
    const body = wantIndex ? indexBody() : null;
    indexDirty = false;
    fsp
      .mkdir(dir, { recursive: true })
      .then(() =>
        Promise.all([
          ...batch.map(([id, hands]) => writeOne(fileFor(id), gameBody(id, hands))),
          wantIndex ? writeOne(indexFile, body) : Promise.resolve(),
        ])
      )
      .catch(() => {})
      .then(() => {
        writing = false;
        if (writeQueued || dirty.size || indexDirty) {
          writeQueued = false;
          schedule();
        }
      });
  }

  function gameBody(id, hands) {
    const meta = index.get(id) || { id };
    return JSON.stringify({ version: 1, id, meta, hands });
  }

  function writeOne(file, body) {
    if (!file) return Promise.resolve();
    tmpSeq = (tmpSeq + 1) % 1e6;
    const tmp = `${file}.${process.pid}.${tmpSeq}.tmp`;
    return fsp
      .writeFile(tmp, body)
      .then(() => fsp.rename(tmp, file))
      .catch(() => fsp.rm(tmp, { force: true }).catch(() => {}));
  }

  // Synchronous on purpose: the shutdown path, where an async write would
  // never land. Mirrors identity.js's flush().
  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    writeQueued = false;
    if (!dir) return;
    const batch = [...dirty.entries()];
    dirty.clear();
    const wantIndex = indexDirty || batch.length > 0;
    indexDirty = false;
    if (!batch.length && !wantIndex) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (const [id, hands] of batch) writeSync(fileFor(id), gameBody(id, hands));
      if (wantIndex) writeSync(indexFile, indexBody());
    } catch {
      // A game's hands are not worth failing a shutdown over.
    }
  }

  function writeSync(file, body) {
    if (!file) return;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  }

  // ── Reading ─────────────────────────────────────────────────────────────

  function loadIndex() {
    index.clear();
    if (!indexFile || !fs.existsSync(indexFile)) return 0;
    try {
      const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      for (const row of Array.isArray(parsed.games) ? parsed.games : []) {
        if (!row || !row.id) continue;
        index.set(row.id, { ...row, uids: Array.isArray(row.uids) ? row.uids : [] });
      }
    } catch {
      index.clear(); // a corrupt index starts empty, as every other loader does
    }
    return index.size;
  }

  // The hands of one game, in full. Never sent anywhere as it is: the caller
  // redacts per player.
  function load(id) {
    // What has been recorded but not yet written is still the truth: the write
    // is debounced by a second, and a game cancelled and asked for in the same
    // breath must not read as empty because the disk has not caught up.
    const pending = dirty.get(id);
    if (pending) return { meta: index.get(id) || { id }, hands: pending };
    const file = fileFor(id);
    if (!file) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || !Array.isArray(parsed.hands)) return null;
      return { meta: parsed.meta || index.get(id) || { id }, hands: parsed.hands };
    } catch {
      return null;
    }
  }

  // Did this player play in that game? The uid is the whole authorisation:
  // nobody is handed a game they were not in.
  function played(uid, id) {
    const row = uid && id ? index.get(id) : null;
    return !!row && row.uids.includes(uid);
  }

  // The games one player was in, newest first. Never carries the uids: it is
  // a list of games, not a list of who else was there.
  function listFor(uid) {
    if (!uid) return [];
    return [...index.values()]
      .filter((row) => row.uids.includes(uid))
      .map((row) => ({
        id: row.id,
        name: row.name,
        startedAt: row.startedAt,
        endedAt: row.endedAt || row.touchedAt || null,
        hands: row.hands || 0,
      }))
      .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
  }

  // ── Forgetting ──────────────────────────────────────────────────────────

  function remove(id) {
    dirty.delete(id);
    if (index.delete(id)) indexDirty = true;
    const file = fileFor(id);
    if (!file) return;
    try {
      fs.unlinkSync(file);
    } catch {
      // Already gone, which is the state we wanted.
    }
    schedule();
  }

  function listIds() {
    if (!dir) return [];
    try {
      return fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.json') && name !== INDEX_NAME)
        .map((name) => decodeURIComponent(name.slice(0, -'.json'.length)));
    } catch {
      return [];
    }
  }

  // Two bounds, as the admin log has: an age, which is what a player thinks
  // in, and a count, which is what stops a busy month from filling a disk.
  // Plus any file the index has never heard of - a crash between writing a
  // game and writing the index would otherwise leave one for ever.
  function prune(at = now()) {
    if (!dir) return 0;
    let dropped = 0;
    const ageOf = (row) => at - (row.endedAt || row.touchedAt || 0);
    for (const row of [...index.values()]) {
      if (ttlMs > 0 && ageOf(row) > ttlMs) {
        remove(row.id);
        dropped++;
      }
    }
    const byNewest = [...index.values()].sort(
      (a, b) => (b.endedAt || b.touchedAt || 0) - (a.endedAt || a.touchedAt || 0)
    );
    for (const row of byNewest.slice(Math.max(0, maxGames))) {
      remove(row.id);
      dropped++;
    }
    for (const id of listIds()) {
      if (index.has(id)) continue;
      try {
        fs.unlinkSync(fileFor(id));
      } catch {
        /* already gone */
      }
      dropped++;
    }
    return dropped;
  }

  loadIndex();

  return {
    record,
    load,
    loadIndex,
    listFor,
    played,
    remove,
    listIds,
    prune,
    flush,
    flushAsync,
    size: () => index.size,
    dir,
    limits: { ttlMs, maxGames },
  };
}

module.exports = { createHandHistoryStore };

// chat-store.js - chat that survives the process it was typed into.
//
// One file per tournament, holding every room that tournament has. Not a line
// in tournaments.json: that file is rewritten whole on every registration
// change, and chat would multiply the cost of writes that have nothing to do
// with it.
//
// The file is rewritten whole rather than appended to, which is the opposite
// of what a log usually wants and is right here: the room buffers are already
// ring-bounded, so the file can never exceed a known size, and rewriting it
// means no compaction pass and no parsing backwards from the end of a file to
// find the last N lines. What we hold is what we write.
//
// The write itself is identity.js's flushAsync, for the same reason: it is a
// whole-file write on the loop every table shares, so it goes off that loop
// and coalesces rather than queueing behind itself.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const FLUSH_DEBOUNCE_MS = 1000;

function createChatStore(options = {}) {
  const { saveDir = null, flushDebounceMs = FLUSH_DEBOUNCE_MS } = options;
  const dir = saveDir ? path.join(saveDir, 'chat') : null;

  // entryId -> rooms object, as it should appear on disk
  const dirty = new Map();
  let flushTimer = null;
  let writing = false;
  let writeQueued = false;
  let tmpSeq = 0;

  function fileFor(entryId) {
    return dir ? path.join(dir, `${encodeURIComponent(entryId)}.json`) : null;
  }

  // `rooms` is { roomKey: Message[] } for this tournament, taken from the live
  // ring buffers. Recording the snapshot rather than the delta is what lets the
  // write coalesce: three messages in a second cost one write of the result.
  function record(entryId, rooms) {
    if (!dir) return;
    dirty.set(entryId, rooms);
    schedule();
  }

  function schedule() {
    if (!dir || flushTimer) return;
    flushTimer = setTimeout(flushAsync, flushDebounceMs);
    if (flushTimer.unref) flushTimer.unref();
  }

  function flushAsync() {
    flushTimer = null;
    if (!dir) return;
    if (writing) {
      writeQueued = true;
      return;
    }
    if (!dirty.size) return;
    writing = true;
    // Taken up front, so a message arriving mid-write lands in the next batch
    // rather than in a file that is already being renamed.
    const batch = [...dirty.entries()];
    dirty.clear();
    fsp
      .mkdir(dir, { recursive: true })
      .then(() => Promise.all(batch.map(([entryId, rooms]) => writeOne(entryId, rooms))))
      .catch(() => {})
      .then(() => {
        writing = false;
        if (writeQueued || dirty.size) {
          writeQueued = false;
          schedule();
        }
      });
  }

  function writeOne(entryId, rooms) {
    const file = fileFor(entryId);
    if (!file) return Promise.resolve();
    tmpSeq = (tmpSeq + 1) % 1e6;
    const tmp = `${file}.${process.pid}.${tmpSeq}.tmp`;
    const body = JSON.stringify({ version: 1, id: entryId, rooms });
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
    if (!dir || !dirty.size) return;
    const batch = [...dirty.entries()];
    dirty.clear();
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (const [entryId, rooms] of batch) {
        const file = fileFor(entryId);
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, id: entryId, rooms }));
        fs.renameSync(tmp, file);
      }
    } catch {
      // A tournament's chat is not worth failing a shutdown over.
    }
  }

  // { roomKey: Message[] } or null. A file we cannot read is treated as absent
  // rather than fatal, the same way tournament-store.js treats a corrupt one.
  function load(entryId) {
    const file = fileFor(entryId);
    if (!file) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed.rooms !== 'object' || !parsed.rooms) return null;
      return parsed.rooms;
    } catch {
      return null;
    }
  }

  function remove(entryId) {
    dirty.delete(entryId);
    const file = fileFor(entryId);
    if (!file) return;
    try {
      fs.unlinkSync(file);
    } catch {
      // Already gone, which is the state we wanted.
    }
  }

  // Tournament ids with a chat file on disk. Used at boot to sweep files whose
  // tournament did not come back, so a crashed field cannot leak a file for
  // ever.
  function listIds() {
    if (!dir) return [];
    try {
      return fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => decodeURIComponent(name.slice(0, -'.json'.length)));
    } catch {
      return [];
    }
  }

  return { record, load, remove, listIds, flush, flushAsync };
}

module.exports = { createChatStore };

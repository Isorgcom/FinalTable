// chat-store.js - chat that survives the process it was typed into.
//
// One document per tournament, holding every room that tournament has. Not a
// column each: the room buffers are already ring-bounded, nothing ever asks a
// question of the messages except the code that sends them to a client, and
// what is stored is exactly what that code holds.
//
// Kept in memory as well as written, so load() can stay synchronous: it is
// called while a field is being seated again, which is not a place to wait for
// a query. Everything is read once before the server listens.
//
// The write is debounced and coalesced, because three messages in a second
// should cost one write of the result rather than three of the same document.

const FLUSH_DEBOUNCE_MS = 1000;

function createChatStore(options = {}) {
  const { db = null, flushDebounceMs = FLUSH_DEBOUNCE_MS, log = () => {} } = options;

  // entryId -> rooms, as they should be stored
  const held = new Map();
  const dirty = new Set();
  const gone = new Set();
  let flushTimer = null;
  let writing = false;
  let writeQueued = false;

  // Everything, before the server listens.
  async function loadAll() {
    held.clear();
    dirty.clear();
    gone.clear();
    if (!db) return 0;
    for (const row of await db.chat.all()) {
      if (!row || !row.id || !row.data) continue;
      held.set(row.id, row.data);
    }
    return held.size;
  }

  // `rooms` is { roomKey: Message[] } for this tournament, taken from the live
  // ring buffers. Recording the snapshot rather than the delta is what lets the
  // write coalesce.
  function record(entryId, rooms) {
    if (!entryId) return;
    held.set(entryId, rooms);
    dirty.add(entryId);
    gone.delete(entryId);
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
    if (!dirty.size && !gone.size) return Promise.resolve();
    writing = true;
    // Taken up front, so a message arriving mid-write lands in the next batch
    // rather than in a document that is already being sent.
    const batch = [...dirty];
    const removed = [...gone];
    dirty.clear();
    gone.clear();
    return Promise.all([
      ...batch.map((id) => db.chat.put(id, held.get(id) || {})),
      ...removed.map((id) => db.chat.remove(id)),
    ])
      .catch((err) => {
        log({
          level: 'warn',
          event: 'chat_write_failed',
          message: 'Could not write a tournament’s chat',
          data: { detail: err && err.message },
        });
      })
      .then(() => {
        writing = false;
        if (writeQueued || dirty.size || gone.size) {
          writeQueued = false;
          schedule();
        }
      });
  }

  // The shutdown path: everything still waiting, written now.
  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    writeQueued = false;
    return flushAsync();
  }

  // { roomKey: Message[] } or null. Synchronous, because a field is seated
  // again in one go and its chat comes back with it.
  function load(entryId) {
    return held.get(entryId) || null;
  }

  function remove(entryId) {
    held.delete(entryId);
    dirty.delete(entryId);
    gone.add(entryId);
    schedule();
  }

  // Tournament ids with chat kept for them. Used at boot to sweep what belongs
  // to a tournament that did not come back.
  function listIds() {
    return [...held.keys()];
  }

  return { record, load, loadAll, remove, listIds, flush, flushAsync };
}

module.exports = { createChatStore };

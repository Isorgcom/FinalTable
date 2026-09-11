// chat-rooms.js - who may say what, to whom, and what is kept.
//
// A chat room is not something a client names. It is resolved from who the
// sender is: before a tournament starts everyone registered shares one room,
// and once it is running your room is the table you are sitting at. That makes
// room spoofing impossible rather than something to validate against, and it
// makes the handover from the waiting room to the table fall out for free -
// the same function simply returns a different room once the cards are out.
//
// Everything here is bounded. A room keeps its last N messages in a ring, the
// same shape hand-history.js uses for hands, so a table that talks all night
// costs the same as one that talks for a minute.

const random = require('../random');

// Control characters become a space rather than vanishing, so a pasted
// newline separates words instead of welding them together. Zero-width and
// bidirectional-override characters go entirely: they are invisible, so their
// only use in a chat line is to disguise one.
//
// Two invisibles are deliberately kept. U+200D joins a family emoji into one
// character and U+200C is load-bearing in several Indic scripts, so stripping
// the whole U+200B-U+200F run - which is the obvious thing to write - quietly
// breaks both.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const INVISIBLE_CHARS =
  /[\u200b\u200e-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

// Unlike sanitizeName, this keeps punctuation and emoji: a name is a label and
// a message is a sentence. It also keeps < and >, because "<3" is a thing
// people type and every consumer renders through textContent. Anything that
// ever renders a message as HTML must escape it there - this does not.
function sanitizeChat(value, maxLength = 200) {
  const cleaned = String(value || '')
    .normalize('NFKC')
    .replace(CONTROL_CHARS, ' ')
    .replace(INVISIBLE_CHARS, '')
    // Lone surrogates and private use. Unassigned code points are left alone:
    // an emoji this Node has never heard of is assigned in the next one.
    .replace(/[\p{Cs}\p{Co}]/gu, '')
    // Three hundred combining marks stacked on one letter is a line that
    // paints over everything under it. Two is expressive, more is an attack.
    .replace(/(\p{M})\p{M}{2,}/gu, '$1$1')
    .replace(/\s+/g, ' ')
    .trim();
  // Sliced by code point, not by UTF-16 unit, or the cut lands in the middle
  // of an emoji and leaves half a character behind.
  const truncated = [...cleaned].slice(0, maxLength).join('').trim();
  // Symbols count, so a message that is nothing but emoji is still a message.
  return /[\p{L}\p{N}\p{S}]/u.test(truncated) ? truncated : '';
}

function createChatRooms(options = {}) {
  const {
    historyLimit = 100,
    maxLength = 200,
    ratePerWindow = 4,
    rateWindowMs = 10 * 1000,
    now = () => Date.now(),
  } = options;

  // roomKey -> Message[]
  const rooms = new Map();
  // Monotonic, per tournament server rather than per room. The client dedupes
  // by keeping the highest seq it has seen for a room and dropping anything at
  // or below it, which it needs because socket.io's connectionStateRecovery
  // replays missed packets from its own buffer - so a client coming back gets
  // the live messages it missed AND the backlog we send it.
  let seq = 0;

  function lobbyRoom(entryId) {
    return `${entryId}:lobby`;
  }

  function tableRoom(entryId, tableNumber) {
    return `${entryId}:t${tableNumber}`;
  }

  // The room this uid belongs to right now, or null if they belong to none.
  // Keyed by table number rather than the engine's room id: the number is what
  // a restored field comes back with, and because a broken table is only
  // flagged and never spliced out of the director's list, numbers are never
  // reused and a new table cannot inherit a dead one's conversation.
  function roomFor(entry, uid) {
    if (!entry || !uid) return null;
    const rail = entry.watchers ? entry.watchers.get(uid) : null;
    if (entry.status === 'registering') {
      return entry.registrations.has(uid) || rail ? lobbyRoom(entry.id) : null;
    }
    const seat = entry.director.playerByUid(uid);
    if (seat) return tableRoom(entry.id, seat.table.tableNumber);
    // On the rail: the table they chose, or none yet.
    if (rail) return rail.table ? tableRoom(entry.id, rail.table) : null;
    // Busted and watching: the table they are railing.
    const watchingId = entry.watching.get(uid);
    if (!watchingId) return null;
    const table = entry.director.tables.find((t) => t.id === watchingId);
    return table ? tableRoom(entry.id, table.tableNumber) : null;
  }

  // A reason rather than a bare false, so the client can say why the box is
  // closed instead of swallowing the message.
  function canPost(entry, uid) {
    if (!entry) return { ok: false, reason: 'You are not in a tournament' };
    const reg = entry.registrations.get(uid);
    const rail = entry.watchers ? entry.watchers.get(uid) : null;
    if (!reg && !rail) return { ok: false, reason: 'You are not in this tournament' };
    // A player who walked out is gagged; their seat may still be at the table
    // but they are not.
    if (reg && reg.left) return { ok: false, reason: 'You are not in this tournament' };
    if (entry.mutedUids && entry.mutedUids.has(uid)) {
      return { ok: false, reason: 'The host has muted you' };
    }
    if (entry.status === 'registering') {
      // The waiting room is the players': the rail reads it and waits.
      return rail
        ? { ok: false, reason: 'The rail can talk once the cards are out' }
        : { ok: true };
    }
    if (entry.status !== 'running') return { ok: false, reason: 'The tournament is over' };
    // Once the cards are out, everyone at a table has the floor there: the
    // seats, the host wherever they are, a player who busted and stayed to
    // watch, and the rail. A line from anyone without a seat is marked as
    // from the rail, so the table can tell who is playing from who is talking.
    return { ok: true };
  }

  // A fixed window, the same shape as the HTTP limiter in http-middleware.js.
  // The bucket lives on the socket, so it goes when the socket does.
  function takeToken(bucket, at = now()) {
    if (!bucket.reset || at >= bucket.reset) {
      bucket.count = 0;
      bucket.reset = at + rateWindowMs;
    }
    if (bucket.count >= ratePerWindow) return false;
    bucket.count += 1;
    return true;
  }

  // The four optional fields say where and from whom: `table` is the room's
  // table number (null in the waiting room), `host` marks the host's lines,
  // `scope` is 'all' on an announcement to every table, and `group` is shared
  // by every copy of one announcement so a reader holding several rooms can
  // draw it once. Absent when they do not apply, so an ordinary line is the
  // shape it always was.
  function post(
    room,
    { uid, name, text, table = null, host = false, scope = null, group = null, rail = false }
  ) {
    const clean = sanitizeChat(text, maxLength);
    if (!clean || !room) return null;
    seq += 1;
    const message = {
      id: random.randomId('c_'),
      seq,
      room,
      uid,
      name,
      text: clean,
      at: now(),
      ...(table !== null ? { table } : {}),
      ...(host ? { host: true } : {}),
      ...(scope ? { scope } : {}),
      ...(group ? { group } : {}),
      ...(rail ? { rail: true } : {}),
    };
    append(message);
    return message;
  }

  // The ring. Push, then drop the oldest past the limit - hand-history.js:108.
  function append(message) {
    let log = rooms.get(message.room);
    if (!log) {
      log = [];
      rooms.set(message.room, log);
    }
    log.push(message);
    if (log.length > historyLimit) log.splice(0, log.length - historyLimit);
    return message;
  }

  function history(room, limit = historyLimit) {
    const log = rooms.get(room);
    if (!log || !log.length) return [];
    return log.slice(-limit);
  }

  function dropRoom(room) {
    rooms.delete(room);
  }

  // Everything belonging to one tournament, for when it is reaped.
  function dropTournament(entryId) {
    const prefix = `${entryId}:`;
    for (const key of [...rooms.keys()]) {
      if (key.startsWith(prefix)) rooms.delete(key);
    }
  }

  function roomCount() {
    return rooms.size;
  }

  // Everything this tournament holds, shaped for the store. Taken from the
  // live rings, so what is written is exactly what would be replayed.
  function snapshot(entryId) {
    const prefix = `${entryId}:`;
    const out = {};
    for (const [key, log] of rooms) {
      if (key.startsWith(prefix) && log.length) out[key] = log;
    }
    return out;
  }

  // Back from disk. The counter is picked up past the highest seq ever issued,
  // so a client that reconnects across a restart still has a watermark that
  // means something and cannot swallow new messages as duplicates.
  function hydrate(saved) {
    if (!saved) return;
    for (const [key, log] of Object.entries(saved)) {
      if (!Array.isArray(log) || !log.length) continue;
      const kept = log.slice(-historyLimit);
      rooms.set(key, kept);
      for (const m of kept) if (typeof m.seq === 'number' && m.seq > seq) seq = m.seq;
    }
  }

  return {
    roomFor,
    canPost,
    post,
    append,
    history,
    dropRoom,
    dropTournament,
    snapshot,
    hydrate,
    takeToken,
    lobbyRoom,
    tableRoom,
    roomCount,
    sanitize: (text) => sanitizeChat(text, maxLength),
    limits: { historyLimit, maxLength, ratePerWindow, rateWindowMs },
  };
}

module.exports = { createChatRooms, sanitizeChat };

// identity.js - who a player is, behind one interface.
//
// Today: a name and avatar bound to an opaque device token the browser keeps.
// The token is the only credential; the uid is an identifier that appears in
// rosters and game state and never proves anything. A later backend (a
// GameNight login, say) implements the same five functions and returns its
// own uids; the lobby and tournament code never see the difference.

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const random = require('../random');

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Two tiers, because the two kinds of change are worth very different money.
// A material change - a mint, a rename - is rare and worth writing promptly.
// A lastSeenAt touch is neither: `identify` runs on every connect and every
// reconnect, so a busy server touches constantly, and the only thing that
// reads lastSeenAt is expireIdle below, which measures in days. Letting
// touches ride a minute behind keeps a reconnect storm off the disk entirely
// and leaves the timestamp accurate to far inside its one consumer. The cost
// of a hard kill is that a record's lastSeenAt can be up to a minute stale
// against a thirty-day TTL.
const FLUSH_DEBOUNCE_MS = 250;
const TOUCH_FLUSH_MS = 60 * 1000;

function createIdentityStore(options = {}) {
  const {
    saveDir = null,
    ttlMs = DEFAULT_TTL_MS,
    now = Date.now,
    flushDebounceMs = FLUSH_DEBOUNCE_MS,
    touchFlushMs = TOUCH_FLUSH_MS,
    sanitizeName = (v) =>
      String(v || '')
        .trim()
        .slice(0, 16),
    sanitizeAvatar = (v) => String(v || '🧑').slice(0, 4),
  } = options;

  const byToken = new Map(); // token -> { uid, name, avatar, createdAt, lastSeenAt }
  const byUid = new Map(); // uid -> token
  const file = saveDir ? path.join(saveDir, 'identities.json') : null;

  let flushTimer = null;
  let flushTier = null; // 'material' | 'touch' - what the pending timer is for
  let writing = false; // a write is in flight
  let writeQueued = false; // something changed while one was
  let tmpSeq = 0;

  function load() {
    if (!file || !fs.existsSync(file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const rec of data.identities || []) {
        if (!rec.token || !rec.uid) continue;
        byToken.set(rec.token, {
          uid: rec.uid,
          name: rec.name || '',
          avatar: rec.avatar || '🧑',
          createdAt: rec.createdAt || now(),
          lastSeenAt: rec.lastSeenAt || now(),
        });
        byUid.set(rec.uid, rec.token);
      }
    } catch (_err) {
      // A corrupt file starts the store empty; identities are cheap to remint.
      byToken.clear();
      byUid.clear();
    }
  }

  function serialize() {
    const identities = [...byToken.entries()].map(([token, rec]) => ({ token, ...rec }));
    return JSON.stringify({ version: 1, identities });
  }

  function cancelPending() {
    if (!flushTimer) return;
    clearTimeout(flushTimer);
    flushTimer = null;
    flushTier = null;
  }

  // The disk write, off the event loop. Every write is the whole map, which is
  // exactly why it cannot stay synchronous: the cost is O(every identity ever
  // seen) and it would be paid on the one loop that every table on the server
  // shares. The map is serialised up front, so the snapshot is the one that
  // existed when the flush fired and only the write and rename land late.
  function flushAsync() {
    flushTimer = null;
    flushTier = null;
    if (!file) return;
    if (writing) {
      writeQueued = true;
      return;
    }
    writing = true;
    const body = serialize();
    // A tmp path of its own per write: flush() uses `${file}.tmp`, and a
    // shutdown landing on top of an in-flight write must not share a file.
    tmpSeq = (tmpSeq + 1) % 1e6;
    const tmp = `${file}.${process.pid}.${tmpSeq}.tmp`;
    fsp
      .mkdir(path.dirname(file), { recursive: true })
      .then(() => fsp.writeFile(tmp, body))
      .then(() => fsp.rename(tmp, file))
      .catch(() => fsp.rm(tmp, { force: true }).catch(() => {}))
      .then(() => {
        writing = false;
        if (writeQueued) {
          writeQueued = false;
          flushAsync();
        }
      });
  }

  function scheduleFlush(tier) {
    if (!file) return;
    // A pending material flush already covers whatever just arrived, and a
    // pending touch flush already covers another touch.
    if (flushTimer && (flushTier === 'material' || tier === 'touch')) return;
    cancelPending(); // a touch timer, pulled forward by a material change
    flushTier = tier;
    flushTimer = setTimeout(flushAsync, tier === 'material' ? flushDebounceMs : touchFlushMs);
    if (flushTimer.unref) flushTimer.unref();
  }

  // Synchronous on purpose: this is the shutdown path (flushStores in
  // server.js), where the process is about to go away and an async write would
  // never land. A write already in flight is left to finish - it renames a tmp
  // file of its own, and its content differs from this one only in lastSeenAt.
  function flush() {
    cancelPending();
    writeQueued = false;
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, serialize());
    fs.renameSync(tmp, file);
  }

  function publicView(token, rec) {
    return { uid: rec.uid, token, name: rec.name, avatar: rec.avatar };
  }

  // Returns the identity, or null when a new identity would have no name.
  function identify({ token, name, avatar } = {}) {
    const safeName = sanitizeName(name);
    const safeAvatar = avatar ? sanitizeAvatar(avatar) : '';
    let rec = typeof token === 'string' ? byToken.get(token) : null;
    let isNew = false;
    let changed = false;
    if (!rec) {
      if (!safeName) return null;
      token = crypto.randomBytes(24).toString('base64url');
      rec = {
        uid: random.randomId('u_'),
        name: safeName,
        avatar: safeAvatar || '🧑',
        createdAt: now(),
        lastSeenAt: now(),
      };
      byToken.set(token, rec);
      byUid.set(rec.uid, token);
      isNew = true;
    } else {
      // Only a value that actually moves earns a prompt write. The ordinary
      // reconnect resends the name and avatar the record already holds, and
      // that must cost nothing.
      if (safeName && safeName !== rec.name) {
        rec.name = safeName;
        changed = true;
      }
      if (safeAvatar && safeAvatar !== rec.avatar) {
        rec.avatar = safeAvatar;
        changed = true;
      }
      rec.lastSeenAt = now();
    }
    scheduleFlush(isNew || changed ? 'material' : 'touch');
    return { ...publicView(token, rec), isNew };
  }

  function verify(token) {
    const rec = typeof token === 'string' ? byToken.get(token) : null;
    if (!rec) return null;
    rec.lastSeenAt = now();
    scheduleFlush('touch');
    return publicView(token, rec);
  }

  function get(uid) {
    const token = byUid.get(uid);
    const rec = token ? byToken.get(token) : null;
    return rec ? { uid: rec.uid, name: rec.name, avatar: rec.avatar } : null;
  }

  function rename(uid, { name, avatar } = {}) {
    const token = byUid.get(uid);
    const rec = token ? byToken.get(token) : null;
    if (!rec) return null;
    const safeName = sanitizeName(name);
    const safeAvatar = avatar ? sanitizeAvatar(avatar) : '';
    if (safeName) rec.name = safeName;
    if (safeAvatar) rec.avatar = safeAvatar;
    rec.lastSeenAt = now();
    scheduleFlush('material');
    return { uid: rec.uid, name: rec.name, avatar: rec.avatar };
  }

  function expireIdle() {
    let dropped = 0;
    for (const [token, rec] of byToken) {
      if (now() - rec.lastSeenAt > ttlMs) {
        byToken.delete(token);
        byUid.delete(rec.uid);
        dropped++;
      }
    }
    if (dropped) scheduleFlush('material');
    return dropped;
  }

  load();

  return {
    identify,
    verify,
    get,
    rename,
    expireIdle,
    flush,
    get size() {
      return byToken.size;
    },
  };
}

module.exports = { createIdentityStore };

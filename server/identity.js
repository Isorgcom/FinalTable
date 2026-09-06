// identity.js - who a player is, behind one interface.
//
// Today: a name and avatar bound to an opaque device token the browser keeps.
// The token is the only credential; the uid is an identifier that appears in
// rosters and game state and never proves anything. A later backend (a
// GameNight login, say) implements the same five functions and returns its
// own uids; the lobby and tournament code never see the difference.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const random = require('../random');

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FLUSH_DEBOUNCE_MS = 250;

function createIdentityStore(options = {}) {
  const {
    saveDir = null,
    ttlMs = DEFAULT_TTL_MS,
    now = Date.now,
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

  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!file) return;
    const identities = [...byToken.entries()].map(([token, rec]) => ({ token, ...rec }));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, identities }));
    fs.renameSync(tmp, file);
  }

  function scheduleFlush() {
    if (!file || flushTimer) return;
    flushTimer = setTimeout(flush, FLUSH_DEBOUNCE_MS);
    if (flushTimer.unref) flushTimer.unref();
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
      if (safeName) rec.name = safeName;
      if (safeAvatar) rec.avatar = safeAvatar;
      rec.lastSeenAt = now();
    }
    scheduleFlush();
    return { ...publicView(token, rec), isNew };
  }

  function verify(token) {
    const rec = typeof token === 'string' ? byToken.get(token) : null;
    if (!rec) return null;
    rec.lastSeenAt = now();
    scheduleFlush();
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
    scheduleFlush();
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
    if (dropped) scheduleFlush();
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

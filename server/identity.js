// identity.js - who a player is, behind one interface.
//
// An identity is a uid the rosters and game state carry, a name and an
// avatar, and the device tokens that prove it. A token is the only
// credential; the uid never proves anything.
//
// Two kinds of identity live here. A guest is a name typed into the lobby,
// bound to a token this server minted for that browser. A GameNight identity
// is a person who signed in there and arrived with a signed token (see
// gamenight-sso.js): the uid is derived from their GameNight account, the
// name is GameNight's to set, and every browser they sign in from gets a
// device token of its own on the same identity, so the phone and the iPad
// are the same player. The lobby and tournament code never see the
// difference beyond a `provider` field.

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const random = require('../random');

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FILE_VERSION = 2;

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

  // uid -> { uid, name, avatar, provider, gnUserId, createdAt, lastSeenAt,
  //          tokens: Map<token, { createdAt, lastSeenAt }> }
  const identities = new Map();
  const tokens = new Map(); // token -> uid
  const file = saveDir ? path.join(saveDir, 'identities.json') : null;

  let flushTimer = null;
  let flushTier = null; // 'material' | 'touch' - what the pending timer is for
  let writing = false; // a write is in flight
  let writeQueued = false; // something changed while one was
  let tmpSeq = 0;

  function attachToken(rec, token, at) {
    rec.tokens.set(token, { createdAt: at, lastSeenAt: at });
    tokens.set(token, rec.uid);
  }

  function mintToken() {
    return crypto.randomBytes(24).toString('base64url');
  }

  function newRecord(fields, at) {
    return {
      uid: fields.uid,
      name: fields.name || '',
      avatar: fields.avatar || '🧑',
      provider: fields.provider === 'gamenight' ? 'gamenight' : 'guest',
      gnUserId: fields.gnUserId ? String(fields.gnUserId) : null,
      createdAt: fields.createdAt || at,
      lastSeenAt: fields.lastSeenAt || at,
      tokens: new Map(),
    };
  }

  function load() {
    if (!file || !fs.existsSync(file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const at = now();
      for (const rec of data.identities || []) {
        if (!rec.uid) continue;
        // Version 1 wrote one token per record, on the record itself.
        const list = Array.isArray(rec.tokens)
          ? rec.tokens
          : rec.token
            ? [{ token: rec.token, createdAt: rec.createdAt, lastSeenAt: rec.lastSeenAt }]
            : [];
        let ident = identities.get(rec.uid);
        if (!ident) {
          ident = newRecord(rec, at);
          identities.set(ident.uid, ident);
        }
        for (const t of list) {
          if (!t || !t.token) continue;
          ident.tokens.set(t.token, {
            createdAt: t.createdAt || ident.createdAt,
            lastSeenAt: t.lastSeenAt || ident.lastSeenAt,
          });
          tokens.set(t.token, ident.uid);
        }
        if (ident.tokens.size === 0) identities.delete(ident.uid);
      }
    } catch (_err) {
      // A corrupt file starts the store empty; identities are cheap to remint.
      identities.clear();
      tokens.clear();
    }
  }

  function serialize() {
    const list = [...identities.values()].map((rec) => ({
      uid: rec.uid,
      name: rec.name,
      avatar: rec.avatar,
      provider: rec.provider,
      gnUserId: rec.gnUserId,
      createdAt: rec.createdAt,
      lastSeenAt: rec.lastSeenAt,
      tokens: [...rec.tokens.entries()].map(([token, t]) => ({ token, ...t })),
    }));
    return JSON.stringify({ version: FILE_VERSION, identities: list });
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
    return { uid: rec.uid, token, name: rec.name, avatar: rec.avatar, provider: rec.provider };
  }

  function recordFor(token) {
    const uid = typeof token === 'string' ? tokens.get(token) : undefined;
    return uid ? identities.get(uid) || null : null;
  }

  function touch(rec, token, at) {
    rec.lastSeenAt = at;
    const t = rec.tokens.get(token);
    if (t) t.lastSeenAt = at;
  }

  // Returns the identity, or null when a new identity would have no name.
  // A token on a GameNight identity carries its name from GameNight, so the
  // one the browser sends is ignored; the avatar is still the player's own.
  function identify({ token, name, avatar } = {}) {
    const safeName = sanitizeName(name);
    const safeAvatar = avatar ? sanitizeAvatar(avatar) : '';
    const at = now();
    let rec = recordFor(token);
    let isNew = false;
    let changed = false;
    if (!rec) {
      if (!safeName) return null;
      token = mintToken();
      rec = newRecord({ uid: random.randomId('u_'), name: safeName, avatar: safeAvatar }, at);
      identities.set(rec.uid, rec);
      attachToken(rec, token, at);
      isNew = true;
    } else {
      // Only a value that actually moves earns a prompt write. The ordinary
      // reconnect resends the name and avatar the record already holds, and
      // that must cost nothing.
      if (rec.provider !== 'gamenight' && safeName && safeName !== rec.name) {
        rec.name = safeName;
        changed = true;
      }
      if (safeAvatar && safeAvatar !== rec.avatar) {
        rec.avatar = safeAvatar;
        changed = true;
      }
      touch(rec, token, at);
    }
    scheduleFlush(isNew || changed ? 'material' : 'touch');
    return { ...publicView(token, rec), isNew };
  }

  // A player arriving from GameNight with a verified token. The uid is the
  // GameNight account, so the same person is the same player from any
  // browser; this browser gets a device token of its own, and the ones
  // already out stay good. The name is refreshed every time, because it is
  // GameNight's and can change there.
  function identifyFromGameNight({ sub, name, avatar } = {}) {
    if (sub === undefined || sub === null || String(sub) === '') return null;
    const safeName = sanitizeName(name);
    if (!safeName) return null;
    const safeAvatar = avatar ? sanitizeAvatar(avatar) : '';
    const at = now();
    const uid = `gn_${sub}`;
    let rec = identities.get(uid);
    let isNew = false;
    if (!rec) {
      rec = newRecord(
        { uid, name: safeName, avatar: safeAvatar, provider: 'gamenight', gnUserId: sub },
        at
      );
      identities.set(uid, rec);
      isNew = true;
    } else {
      rec.name = safeName;
      if (safeAvatar) rec.avatar = safeAvatar;
      rec.lastSeenAt = at;
    }
    const token = mintToken();
    attachToken(rec, token, at);
    scheduleFlush('material');
    return { ...publicView(token, rec), isNew };
  }

  function verify(token) {
    const rec = recordFor(token);
    if (!rec) return null;
    touch(rec, token, now());
    scheduleFlush('touch');
    return publicView(token, rec);
  }

  function get(uid) {
    const rec = identities.get(uid);
    return rec
      ? { uid: rec.uid, name: rec.name, avatar: rec.avatar, provider: rec.provider }
      : null;
  }

  function rename(uid, { name, avatar } = {}) {
    const rec = identities.get(uid);
    if (!rec) return null;
    const safeName = sanitizeName(name);
    const safeAvatar = avatar ? sanitizeAvatar(avatar) : '';
    if (safeName && rec.provider !== 'gamenight') rec.name = safeName;
    if (safeAvatar) rec.avatar = safeAvatar;
    rec.lastSeenAt = now();
    scheduleFlush('material');
    return { uid: rec.uid, name: rec.name, avatar: rec.avatar, provider: rec.provider };
  }

  // Tokens expire one at a time; an identity goes when its last one does.
  // Returns how many identities were dropped.
  function expireIdle() {
    let dropped = 0;
    const at = now();
    for (const [uid, rec] of identities) {
      for (const [token, t] of rec.tokens) {
        if (at - t.lastSeenAt > ttlMs) {
          rec.tokens.delete(token);
          tokens.delete(token);
        }
      }
      if (rec.tokens.size === 0) {
        identities.delete(uid);
        dropped++;
      }
    }
    if (dropped) scheduleFlush('material');
    return dropped;
  }

  load();

  return {
    identify,
    identifyFromGameNight,
    verify,
    get,
    rename,
    expireIdle,
    flush,
    get size() {
      return identities.size;
    },
  };
}

module.exports = { createIdentityStore };

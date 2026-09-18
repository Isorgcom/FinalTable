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

// The side panel's tabs, as the client names them. Kept here because a stored
// preference is only useful if it is one the panel will actually open, and a
// name that has gone away must not come back off the disk years later.
const PANEL_TABS = ['chat', 'log', 'info', 'stats', 'history'];

// How the cards look to the person who chose it, and to nobody else: the back
// they are dealt with, whether the deck is the classic two colours or four,
// and whether the face carries a large index. Here for the same reason as the
// tabs above - a value off the disk has to be one the client can still draw,
// and these lists are mirrored in public/js/card-look.js.
const CARD_BACKS = ['green', 'red', 'blue', 'ivory'];
const DECKS = ['two', 'four'];
const CARD_FACES = ['standard', 'large'];

// What a device is called on the sessions list. Coarse on purpose: enough for
// somebody to recognise which of their own devices a row is, and no more. The
// user agent itself is never stored - it is a fingerprint, it would sit in a
// file for thirty days, and "Safari on iPhone" is the whole of what the screen
// needs to say.
const BROWSERS = [
  [/\bEdgA?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bCriOS\//, 'Chrome'],
  [/\bChrome\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];
const PLATFORMS = [
  [/\biPhone\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\bAndroid\b/, 'Android'],
  [/\bMac OS X\b|\bMacintosh\b/, 'Mac'],
  [/\bWindows\b/, 'Windows'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bLinux\b/, 'Linux'],
];

function deviceLabel(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return 'A browser';
  const browser = (BROWSERS.find(([re]) => re.test(ua)) || [])[1] || null;
  const platform = (PLATFORMS.find(([re]) => re.test(ua)) || [])[1] || null;
  if (browser && platform) return `${browser} on ${platform}`;
  return browser || platform || 'A browser';
}

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
    // Asked of the accounts store: does an account own this name? A guest may
    // not identify as a name somebody has taken, and the store here cannot
    // know that on its own. Always null on a server with no accounts, which
    // is exactly how this behaved before there were any.
    nameOwner = () => null,
    // How two names are compared for sameness. The server's own
    // normalizeNameKey, so the accounts store and this one agree.
    nameKeyOf = (v) =>
      String(v || '')
        .trim()
        .toLocaleLowerCase(),
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

  function attachToken(rec, token, at, label = '') {
    // An id of its own, because the sessions list has to name a device without
    // the page ever holding the credential for it. A token is a bearer thing:
    // one that leaked would sign somebody in, and a list of every device's
    // token sitting in a browser is a much better prize than the one that
    // browser already had.
    rec.tokens.set(token, {
      id: crypto.randomBytes(8).toString('hex'),
      label: deviceLabel(label),
      createdAt: at,
      lastSeenAt: at,
    });
    tokens.set(token, rec.uid);
  }

  function mintToken() {
    return crypto.randomBytes(24).toString('base64url');
  }

  // The preferences that belong to the person rather than to the browser they
  // happen to be using. A closed set with a validator each, because this is a
  // client writing into a file the server keeps for ever: anything not named
  // here is dropped, and so is any value of the wrong shape. Adding one means
  // adding it here, which is the point.
  //
  // A guest is one browser, so for them this is only a slower localStorage.
  // The gain is a GameNight identity, where the phone and the iPad are the
  // same uid and therefore now the same table.
  const PREF_KEYS = {
    // Which chair the viewer is shown in, as a display slot. Eight chairs.
    seat: (v) => (v === null ? null : Number.isInteger(v) && v >= 0 && v <= 7 ? v : undefined),
    // Whether the table is silent.
    muted: (v) => (typeof v === 'boolean' ? v : undefined),
    // Which side panel tab opens. The names the client's panel knows.
    panelTab: (v) => (PANEL_TABS.includes(v) ? v : undefined),
    // The back of the cards.
    cardBack: (v) => (CARD_BACKS.includes(v) ? v : undefined),
    // Two colours or four.
    deck: (v) => (DECKS.includes(v) ? v : undefined),
    // Whether the rank on the face is the large one.
    cardFace: (v) => (CARD_FACES.includes(v) ? v : undefined),
  };

  function sanitizePrefs(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [key, check] of Object.entries(PREF_KEYS)) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
      const value = check(raw[key]);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  function newRecord(fields, at) {
    return {
      uid: fields.uid,
      name: fields.name || '',
      avatar: fields.avatar || '🧑',
      provider: ['gamenight', 'local'].includes(fields.provider) ? fields.provider : 'guest',
      gnUserId: fields.gnUserId ? String(fields.gnUserId) : null,
      createdAt: fields.createdAt || at,
      lastSeenAt: fields.lastSeenAt || at,
      prefs: sanitizePrefs(fields.prefs),
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
            // A file written before the sessions list gets an id on the way
            // in, so an old device can still be named and signed out.
            id: t.id || crypto.randomBytes(8).toString('hex'),
            label: typeof t.label === 'string' && t.label ? t.label : 'A browser',
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
      prefs: rec.prefs,
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
    return {
      uid: rec.uid,
      token,
      name: rec.name,
      avatar: rec.avatar,
      provider: rec.provider,
      prefs: { ...rec.prefs },
    };
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
  function identify({ token, name, avatar, userAgent } = {}) {
    const safeName = sanitizeName(name);
    const safeAvatar = avatar ? sanitizeAvatar(avatar) : '';
    const at = now();
    let rec = recordFor(token);
    let isNew = false;
    let changed = false;
    // A name an account owns is that account's, whoever is asking. The owner
    // comes through here every time they reconnect, so it is only somebody
    // else who is turned away.
    if (safeName) {
      const owner = nameOwner(safeName);
      if (owner && (!rec || rec.uid !== owner)) return { error: 'name-taken' };
    }
    if (!rec) {
      if (!safeName) return null;
      token = mintToken();
      rec = newRecord({ uid: random.randomId('u_'), name: safeName, avatar: safeAvatar }, at);
      identities.set(rec.uid, rec);
      attachToken(rec, token, at, userAgent);
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

  // Is anybody other than `uid` playing under this name? Asked by the accounts
  // store before it lets somebody claim one: a name is only free if nobody
  // else is already answering to it.
  function nameHolder(key, uid) {
    for (const rec of identities.values()) {
      if (rec.uid === uid) continue;
      if (nameKeyOf(rec.name) === key) return true;
    }
    return false;
  }

  // An account signing in, which is not the same as a browser coming back: the
  // password has already been checked by the accounts store and this is the
  // identity that goes with it. The record is remade if the idle sweep took it
  // while nobody was playing - an account outlives the browser that made it.
  function signInAs({ uid, name, avatar, userAgent } = {}) {
    if (!uid) return null;
    const at = now();
    let rec = identities.get(uid);
    if (!rec) {
      rec = newRecord(
        {
          uid,
          name: sanitizeName(name) || 'Player',
          avatar: sanitizeAvatar(avatar),
          provider: 'local',
        },
        at
      );
      identities.set(uid, rec);
    } else {
      rec.provider = 'local';
      const safeName = sanitizeName(name);
      if (safeName) rec.name = safeName;
      rec.lastSeenAt = at;
    }
    const token = mintToken();
    attachToken(rec, token, at, userAgent);
    scheduleFlush('material');
    return { ...publicView(token, rec), isNew: false };
  }

  // A player arriving from GameNight with a verified token. The uid is the
  // GameNight account, so the same person is the same player from any
  // browser; this browser gets a device token of its own, and the ones
  // already out stay good. The name is refreshed every time, because it is
  // GameNight's and can change there.
  function identifyFromGameNight({ sub, name, avatar, userAgent } = {}) {
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
    attachToken(rec, token, at, userAgent);
    scheduleFlush('material');
    return { ...publicView(token, rec), isNew };
  }

  // A patch, not a replacement: the client sends the one preference that just
  // changed and the rest stay as they are. Returns what the record now holds,
  // so the caller can send it back rather than guess; null if the identity is
  // gone or the patch said nothing this server understands, which is the same
  // answer as far as the caller is concerned.
  function setPrefs(uid, patch) {
    const rec = uid ? identities.get(uid) : null;
    if (!rec) return null;
    const clean = sanitizePrefs(patch);
    const keys = Object.keys(clean);
    if (keys.length === 0) return null;
    let changed = false;
    for (const key of keys) {
      if (rec.prefs[key] === clean[key]) continue;
      rec.prefs[key] = clean[key];
      changed = true;
    }
    // Material rather than a touch: somebody pressed something, and losing it
    // to a hard kill would be the bug this exists to fix.
    if (changed) scheduleFlush('material');
    return { ...rec.prefs };
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

  // ── Sessions ─────────────────────────────────────────────────────────────
  //
  // The devices this identity is signed in on. A guest is one browser and will
  // see one row; a Game Night account is the reason this exists. The token
  // itself never leaves the server: a row is named by the id minted with it.
  function sessions(uid, currentToken = null) {
    const rec = uid ? identities.get(uid) : null;
    if (!rec) return [];
    return [...rec.tokens.entries()]
      .map(([token, t]) => ({
        id: t.id,
        label: t.label || 'A browser',
        createdAt: t.createdAt,
        lastSeenAt: t.lastSeenAt,
        // So the screen can say which row is the one reading it, and warn
        // before somebody signs out the device in their hand.
        current: !!currentToken && token === currentToken,
      }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  // Signing a device out, named by its public id and only ever from its own
  // identity: an id is not a secret, so the uid is what authorises this.
  // Returns the token that was dropped, so the caller can find the socket
  // holding it and tell it; null if there was no such row.
  function endSession(uid, id) {
    const rec = uid ? identities.get(uid) : null;
    if (!rec || !id) return null;
    for (const [token, t] of rec.tokens) {
      if (t.id !== id) continue;
      rec.tokens.delete(token);
      tokens.delete(token);
      // An identity with no devices left is nobody. Dropping it here rather
      // than waiting for the idle sweep keeps the file honest, and matches
      // what load() would do with it on the next boot anyway.
      if (rec.tokens.size === 0) identities.delete(rec.uid);
      scheduleFlush('material');
      return token;
    }
    return null;
  }

  // Signing this browser out, which until now only cleared the browser and
  // left the token good on the server for another thirty days.
  function revokeToken(token) {
    const rec = recordFor(token);
    if (!rec) return false;
    const row = rec.tokens.get(token);
    return !!row && !!endSession(rec.uid, row.id);
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
    signInAs,
    nameHolder,
    verify,
    get,
    rename,
    setPrefs,
    sessions,
    endSession,
    revokeToken,
    expireIdle,
    flush,
    get size() {
      return identities.size;
    },
  };
}

module.exports = { createIdentityStore };

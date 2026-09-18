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
const random = require('../random');
const { digestToken } = require('./password');

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
    db = null,
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
    log = () => {},
  } = options;

  // uid -> { uid, name, avatar, provider, gnUserId, createdAt, lastSeenAt,
  //          tokens: Map<tokenHash, { id, label, createdAt, lastSeenAt }> }
  const identities = new Map();
  const tokens = new Map(); // tokenHash -> uid

  // Who has changed since the last write. The whole map used to go to disk on
  // every flush, which was O(every identity ever seen) for one rename; a
  // database is written a record at a time, so only the records that moved.
  const dirty = new Set();
  const gone = new Set();

  let flushTimer = null;
  let flushTier = null; // 'material' | 'touch' - what the pending timer is for
  let writing = false; // a write is in flight
  let writeQueued = false; // something changed while one was

  function mark(uid) {
    if (!uid) return;
    dirty.add(uid);
    gone.delete(uid);
  }

  function markGone(uid) {
    if (!uid) return;
    dirty.delete(uid);
    gone.add(uid);
  }

  // Keyed by a digest of the token, never by the token. What is written down
  // is therefore not a set of live sessions: somebody holding a copy of the
  // database cannot sign in as anybody with it. The browser keeps the only
  // copy of the token itself, which is what it was always for.
  function hash(token) {
    return typeof token === 'string' && token ? digestToken(token) : null;
  }

  function attachToken(rec, token, at, label = '') {
    const key = hash(token);
    if (!key) return;
    // An id of its own, because the sessions list has to name a device without
    // the page ever holding the credential for it. A token is a bearer thing:
    // one that leaked would sign somebody in, and a list of every device's
    // token sitting in a browser is a much better prize than the one that
    // browser already had.
    rec.tokens.set(key, {
      id: crypto.randomBytes(8).toString('hex'),
      label: deviceLabel(label),
      createdAt: at,
      lastSeenAt: at,
    });
    tokens.set(key, rec.uid);
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

  // Everything, once, before the server listens. The working set is the map;
  // the database is what it is read out of and written back to.
  async function load() {
    identities.clear();
    tokens.clear();
    dirty.clear();
    gone.clear();
    if (!db) return 0;
    for (const row of await db.identities.all()) {
      if (!row || !row.uid) continue;
      const rec = newRecord(
        {
          uid: row.uid,
          name: row.name,
          avatar: row.avatar,
          provider: row.provider,
          gnUserId: row.gnUserId,
          createdAt: row.createdAt,
          lastSeenAt: row.lastSeenAt,
          prefs: row.prefs,
        },
        row.createdAt || now()
      );
      for (const device of row.devices || []) {
        if (!device || !device.tokenHash) continue;
        rec.tokens.set(device.tokenHash, {
          id: device.id || crypto.randomBytes(8).toString('hex'),
          label: device.label || 'A browser',
          createdAt: device.createdAt || rec.createdAt,
          lastSeenAt: device.lastSeenAt || rec.lastSeenAt,
        });
        tokens.set(device.tokenHash, rec.uid);
      }
      // An identity with no device on it is nobody, and was already dropped on
      // the way in when this was a file.
      if (rec.tokens.size === 0) continue;
      identities.set(rec.uid, rec);
    }
    return identities.size;
  }

  function toRow(rec) {
    return {
      uid: rec.uid,
      name: rec.name,
      nameKey: nameKeyOf(rec.name),
      avatar: rec.avatar,
      provider: rec.provider,
      gnUserId: rec.gnUserId,
      createdAt: rec.createdAt,
      lastSeenAt: rec.lastSeenAt,
      prefs: rec.prefs,
      devices: [...rec.tokens.entries()].map(([tokenHash, t]) => ({ tokenHash, ...t })),
    };
  }

  function cancelPending() {
    if (!flushTimer) return;
    clearTimeout(flushTimer);
    flushTimer = null;
    flushTier = null;
  }

  // The write, off the loop every table shares. Only what moved: the set is
  // taken up front so a change arriving mid-write lands in the next one rather
  // than being dropped between the copy and the query.
  function flushAsync() {
    flushTimer = null;
    flushTier = null;
    if (!db) return Promise.resolve();
    if (writing) {
      writeQueued = true;
      return Promise.resolve();
    }
    if (!dirty.size && !gone.size) return Promise.resolve();
    writing = true;
    const changed = [...dirty].map((uid) => identities.get(uid)).filter(Boolean);
    const removed = [...gone];
    dirty.clear();
    gone.clear();
    return Promise.all([
      ...changed.map((rec) => db.identities.put(toRow(rec))),
      ...removed.map((uid) => db.identities.remove(uid)),
    ])
      .catch((err) => {
        log({
          level: 'warn',
          event: 'identity_write_failed',
          message: 'Could not write an identity',
          data: { detail: err && err.message },
        });
      })
      .then(() => {
        writing = false;
        if (writeQueued || dirty.size || gone.size) {
          writeQueued = false;
          scheduleFlush('material');
        }
      });
  }

  function scheduleFlush(tier) {
    if (!db) return;
    // A pending material flush already covers whatever just arrived, and a
    // pending touch flush already covers another touch.
    if (flushTimer && (flushTier === 'material' || tier === 'touch')) return;
    cancelPending(); // a touch timer, pulled forward by a material change
    flushTier = tier;
    flushTimer = setTimeout(flushAsync, tier === 'material' ? flushDebounceMs : touchFlushMs);
    if (flushTimer.unref) flushTimer.unref();
  }

  // The shutdown path. It returns a promise now rather than writing
  // synchronously, because a query cannot be made to happen before the process
  // goes away - so whoever is shutting down waits for it.
  function flush() {
    cancelPending();
    writeQueued = false;
    return flushAsync();
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
    const key = hash(token);
    const uid = key ? tokens.get(key) : undefined;
    return uid ? identities.get(uid) || null : null;
  }

  function touch(rec, token, at) {
    rec.lastSeenAt = at;
    const key = hash(token);
    const t = key ? rec.tokens.get(key) : null;
    if (t) t.lastSeenAt = at;
    mark(rec.uid);
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
    mark(rec.uid);
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
    mark(rec.uid);
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
    mark(rec.uid);
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
    if (changed) {
      mark(rec.uid);
      scheduleFlush('material');
    }
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
    mark(rec.uid);
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
    const here = hash(currentToken);
    return [...rec.tokens.entries()]
      .map(([tokenHash, t]) => ({
        id: t.id,
        label: t.label || 'A browser',
        createdAt: t.createdAt,
        lastSeenAt: t.lastSeenAt,
        // So the screen can say which row is the one reading it, and warn
        // before somebody signs out the device in their hand.
        current: !!here && tokenHash === here,
      }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  // Signing a device out, named by its public id and only ever from its own
  // identity: an id is not a secret, so the uid is what authorises this.
  // Returns the digest of the token that was dropped, so the caller can find
  // the socket holding it and tell it; null if there was no such row. A digest
  // rather than the token, because the token is not here to return - see
  // hash() above - and hashToken() lets a caller compare its own.
  function endSession(uid, id) {
    const rec = uid ? identities.get(uid) : null;
    if (!rec || !id) return null;
    for (const [tokenHash, t] of rec.tokens) {
      if (t.id !== id) continue;
      rec.tokens.delete(tokenHash);
      tokens.delete(tokenHash);
      // An identity with no devices left is nobody. Dropping it here rather
      // than waiting for the idle sweep keeps the store honest, and matches
      // what load() would do with it on the next boot anyway.
      if (rec.tokens.size === 0) {
        identities.delete(rec.uid);
        markGone(rec.uid);
      } else {
        mark(rec.uid);
      }
      scheduleFlush('material');
      return tokenHash;
    }
    return null;
  }

  // Signing this browser out, which until now only cleared the browser and
  // left the token good on the server for another thirty days.
  function revokeToken(token) {
    const rec = recordFor(token);
    if (!rec) return false;
    const row = rec.tokens.get(hash(token));
    return !!row && !!endSession(rec.uid, row.id);
  }

  // Tokens expire one at a time; an identity goes when its last one does.
  // Returns how many identities were dropped.
  function expireIdle() {
    let dropped = 0;
    const at = now();
    for (const [uid, rec] of identities) {
      let lost = false;
      for (const [tokenHash, t] of rec.tokens) {
        if (at - t.lastSeenAt > ttlMs) {
          rec.tokens.delete(tokenHash);
          tokens.delete(tokenHash);
          lost = true;
        }
      }
      if (rec.tokens.size === 0) {
        identities.delete(uid);
        markGone(uid);
        dropped++;
      } else if (lost) {
        mark(uid);
      }
    }
    if (dropped) scheduleFlush('material');
    return dropped;
  }

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
    load,
    flush,
    // So a caller holding a raw token can compare it with what endSession
    // returns, without the store ever handing a token back.
    hashToken: hash,
    get size() {
      return identities.size;
    },
  };
}

module.exports = { createIdentityStore };

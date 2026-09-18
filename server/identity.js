// identity.js - who a player is, behind one interface.
//
// An identity is a uid the rosters and game state carry, a name and an
// avatar, and the device tokens that prove it. A token is the only
// credential; the uid never proves anything.
//
// Two kinds of identity live here, and both of them are accounts. A local one
// belongs to this server: a name somebody claimed, a password, and an address
// they confirmed (see accounts.js). A GameNight one is a person who signed in
// there and arrived with a signed token (see gamenight-sso.js): the uid is
// derived from their GameNight account and the name is GameNight's to set.
// Either way every browser they sign in from gets a device token of its own on
// the same identity, so the phone and the iPad are the same player, and the
// lobby and tournament code never see the difference beyond a `provider`
// field.
//
// There used to be a third kind - a guest, which was a name typed into a box
// and a token, and nothing else. Nothing mints one here any more: an identity
// is made by signing in to an account, and by nothing else.
//
// Which means an identity is permanent. Devices still expire after a month of
// not being used, but the person behind them does not: their name is theirs,
// their preferences are theirs, and the games they played are still listed for
// them whenever they come back.

const crypto = require('crypto');
const { digestToken } = require('./password');

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Two tiers, because the two kinds of change are worth very different money.
// A material change - a mint, a rename - is rare and worth writing promptly.
// A lastSeenAt touch is neither: `identify` runs on every connect and every
// reconnect, so a busy server touches constantly, and the only thing that
// reads lastSeenAt is expireDevices below, which measures in days. Letting
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

  // uid -> { uid, name, avatar, provider, role, disabledAt, gnUserId,
  //          createdAt, lastSeenAt,
  //          tokens: Map<tokenHash, { id, label, createdAt, lastSeenAt }> }
  const identities = new Map();
  const tokens = new Map(); // tokenHash -> uid

  // Two indexes over the same records, kept because identities are permanent
  // now and both questions are asked often enough to matter.
  //
  // Names: every sign-up asks whether one is free, and that used to be a walk
  // over every identity the server had ever seen - which was tolerable while
  // guests aged out after a month and is not now that nobody does.
  //
  // Administrators: every guard that refuses to leave the server without one
  // asks how many there are, and the answer must not depend on how many
  // players there are.
  const byNameKey = new Map(); // nameKey -> uid
  const admins = new Set(); // uid

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

  // The one place a record's name is set, so the index cannot drift from it.
  function setName(rec, name) {
    const previous = nameKeyOf(rec.name);
    if (previous && byNameKey.get(previous) === rec.uid) byNameKey.delete(previous);
    rec.name = name;
    const key = nameKeyOf(name);
    if (key) byNameKey.set(key, rec.uid);
  }

  // And the one place a record joins or leaves the map, for the same reason.
  function hold(rec) {
    identities.set(rec.uid, rec);
    const key = nameKeyOf(rec.name);
    if (key) byNameKey.set(key, rec.uid);
    if (rec.role === 'admin') admins.add(rec.uid);
  }

  function drop(uid) {
    const rec = identities.get(uid);
    if (!rec) return false;
    for (const tokenHash of rec.tokens.keys()) tokens.delete(tokenHash);
    const key = nameKeyOf(rec.name);
    if (byNameKey.get(key) === uid) byNameKey.delete(key);
    admins.delete(uid);
    identities.delete(uid);
    return true;
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
      // Two providers, and no third. A guest used to be the default and the
      // commonest kind; now an identity is an account, and an account came
      // either from here or from GameNight.
      provider: fields.provider === 'gamenight' ? 'gamenight' : 'local',
      // What they may do, and whether they may do anything at all. Both live
      // here rather than on the account, because a GameNight player has no
      // account row and is just as much a person.
      role: fields.role === 'admin' ? 'admin' : 'player',
      disabledAt: Number.isFinite(fields.disabledAt) ? fields.disabledAt : null,
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
    byNameKey.clear();
    admins.clear();
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
          role: row.role,
          disabledAt: row.disabledAt,
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
      // An identity with no device on it used to be nobody, and was dropped
      // here. It is somebody now: signing out everywhere leaves one, and so
      // does an account whose owner has not been back since their last device
      // aged out. Their password and their name are still theirs.
      hold(rec);
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
      role: rec.role,
      disabledAt: rec.disabledAt,
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

  // ── Who owns a name ─────────────────────────────────────────────────────
  //
  // One rule, one place, for both kinds of identity. A name belongs to one
  // person on this server: an account owns it, or somebody is already playing
  // under it, and either way nobody else may have it. Every path that sets a
  // name comes through here, which is what stops the two stores disagreeing
  // about who is called what.
  //
  // Answers null when the name is free for this uid, or the uid that holds it.
  function nameHeldBy(name, uid) {
    const key = nameKeyOf(name);
    if (!key) return null;
    const owner = nameOwner(name);
    if (owner && owner !== uid) return owner;
    const playing = byNameKey.get(key);
    if (playing && playing !== uid) return playing;
    return null;
  }

  // Returns the identity, or an error the caller can answer with. There is no
  // minting here any more: a token this server does not know is a browser with
  // nothing to sign in as, and the answer is to go and make an account.
  //
  // The name the browser sends is not consulted at all. It used to be how you
  // became somebody, and while it was, an existing account could be renamed by
  // typing over the box - which left identities.name and the account's own
  // name_key disagreeing until the next sign-in. A name changes through
  // rename() now, and nowhere else.
  function identify({ token, avatar } = {}) {
    const safeAvatar = avatar ? sanitizeAvatar(avatar) : '';
    const at = now();
    const rec = recordFor(token);
    if (!rec) return { error: 'no-account' };
    if (rec.disabledAt) return { error: 'disabled' };
    let changed = false;
    // Only a value that actually moves earns a prompt write. The ordinary
    // reconnect resends the avatar the record already holds, and that must
    // cost nothing.
    if (safeAvatar && safeAvatar !== rec.avatar) {
      rec.avatar = safeAvatar;
      changed = true;
    }
    touch(rec, token, at);
    mark(rec.uid);
    scheduleFlush(changed ? 'material' : 'touch');
    return { ...publicView(token, rec), isNew: false };
  }

  // Is anybody other than `uid` playing under this name? Asked by the accounts
  // store before it lets somebody claim one. One lookup now rather than a walk
  // over every identity the server has ever seen, which matters because
  // nothing prunes them any more.
  function nameHolder(key, uid) {
    const held = byNameKey.get(key);
    return !!held && held !== uid;
  }

  // Change the name somebody plays under. Refused if anybody else holds it,
  // and the caller is expected to have refused it already if they are sitting
  // at a table - the standings and the log carry names rather than uids, so a
  // rename mid-tournament would rewrite who won.
  //
  // Returns null on success, or a sentence to show them.
  function rename(uid, name) {
    const rec = uid ? identities.get(uid) : null;
    if (!rec) return 'There is nobody here by that name.';
    // A GameNight name belongs to GameNight. Changing it here would last until
    // their next sign-in and no longer, which is worse than refusing.
    if (rec.provider === 'gamenight') {
      return 'That name comes from GameNight. Change it there.';
    }
    const safeName = sanitizeName(name);
    if (!safeName) return 'Pick a name first.';
    if (nameKeyOf(safeName) === nameKeyOf(rec.name)) {
      // The same name in different letters is still a rename worth making,
      // because it is what they will be shown as.
      if (safeName === rec.name) return null;
    } else if (nameHeldBy(safeName, uid)) {
      return 'That name is taken on this server.';
    }
    setName(rec, safeName);
    mark(rec.uid);
    scheduleFlush('material');
    return null;
  }

  // An account signing in, which is not the same as a browser coming back: the
  // password has already been checked by the accounts store and this is the
  // identity that goes with it. The record is remade if the idle sweep took it
  // while nobody was playing - an account outlives the browser that made it.
  function signInAs({ uid, name, avatar, userAgent } = {}) {
    if (!uid) return null;
    const at = now();
    let rec = identities.get(uid);
    if (rec && rec.disabledAt) return { error: 'disabled' };
    let isNew = false;
    if (!rec) {
      // The first sign-in after the link in the mail was opened. The account
      // has existed since then; this is the moment it becomes somebody who can
      // sit down, which is why nothing was written here before now.
      rec = newRecord(
        {
          uid,
          name: sanitizeName(name) || 'Player',
          avatar: sanitizeAvatar(avatar),
          provider: 'local',
        },
        at
      );
      hold(rec);
      isNew = true;
    } else {
      rec.provider = 'local';
      const safeName = sanitizeName(name);
      // The account's name is the name. It cannot collide - the accounts
      // table holds it unique - but it is set through setName so the index
      // follows a name that was changed while they were away.
      if (safeName && safeName !== rec.name) setName(rec, safeName);
      rec.lastSeenAt = at;
    }
    const token = mintToken();
    attachToken(rec, token, at, userAgent);
    mark(rec.uid);
    scheduleFlush('material');
    return { ...publicView(token, rec), isNew };
  }

  // A player arriving from GameNight with a verified token. The uid is the
  // GameNight account, so the same person is the same player from any
  // browser; this browser gets a device token of its own, and the ones
  // already out stay good. The name is refreshed every time, because it is
  // GameNight's and can change there.
  // A name from GameNight is not one this server can refuse. It was chosen
  // somewhere else, by somebody who cannot see this server's list and has no
  // screen here to change it on, and turning them away at the door for it
  // would mean a GameNight account that simply cannot play through no fault of
  // anybody's. So a taken name is worn with a number after it, the player is
  // told, and every later sign-in tries the real one again first - which makes
  // an administrator freeing the name fix itself the next time they visit.
  const NAME_SUFFIX_TRIES = 9;

  function claimGameNightName(wanted, uid, current) {
    if (!nameHeldBy(wanted, uid)) return { name: wanted, adjusted: false };
    for (let n = 2; n <= NAME_SUFFIX_TRIES; n++) {
      const tail = ` ${n}`;
      const candidate = sanitizeName(wanted.slice(0, 16 - tail.length) + tail);
      if (candidate && !nameHeldBy(candidate, uid)) return { name: candidate, adjusted: true };
    }
    // Nine of them are taken. Keep whatever they are already called rather
    // than refuse the sign-in.
    return { name: current || null, adjusted: true };
  }

  function identifyFromGameNight({ sub, name, avatar, userAgent } = {}) {
    if (sub === undefined || sub === null || String(sub) === '') return null;
    const safeName = sanitizeName(name);
    if (!safeName) return null;
    const safeAvatar = avatar ? sanitizeAvatar(avatar) : '';
    const at = now();
    const uid = `gn_${sub}`;
    let rec = identities.get(uid);
    if (rec && rec.disabledAt) return { error: 'disabled' };
    let isNew = false;
    const claim = claimGameNightName(safeName, uid, rec ? rec.name : null);
    if (!rec) {
      if (!claim.name) return null;
      rec = newRecord(
        { uid, name: claim.name, avatar: safeAvatar, provider: 'gamenight', gnUserId: sub },
        at
      );
      hold(rec);
      isNew = true;
    } else {
      if (claim.name && claim.name !== rec.name) setName(rec, claim.name);
      if (safeAvatar) rec.avatar = safeAvatar;
      rec.lastSeenAt = at;
    }
    const token = mintToken();
    attachToken(rec, token, at, userAgent);
    mark(rec.uid);
    scheduleFlush('material');
    if (claim.adjusted) {
      log({
        level: 'info',
        event: 'gamenight_name_taken',
        message: 'A GameNight name was already somebody else’s here',
        data: { wanted: safeName, seatedAs: rec.name },
      });
    }
    return { ...publicView(token, rec), isNew, nameAdjusted: claim.adjusted ? safeName : null };
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

  // The picture, which is nobody else's business and cannot collide with
  // anything. Its own function now that rename() has a name rule to keep.
  function setAvatar(uid, avatar) {
    const rec = uid ? identities.get(uid) : null;
    if (!rec) return null;
    const safeAvatar = avatar ? sanitizeAvatar(avatar) : '';
    if (!safeAvatar || safeAvatar === rec.avatar) return rec.avatar;
    rec.avatar = safeAvatar;
    rec.lastSeenAt = now();
    mark(rec.uid);
    scheduleFlush('material');
    return rec.avatar;
  }

  // ── Sessions ─────────────────────────────────────────────────────────────
  //
  // The devices this identity is signed in on - a phone, a laptop, the machine
  // at work. The token itself never leaves the server: a row is named by the
  // id minted with it.
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
      // The identity stays, whether or not that was the last device. Signing
      // out of everywhere is a thing somebody does on purpose, and it must not
      // be the same as deleting the account they did it from.
      mark(rec.uid);
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

  // A device that has not been seen for a month stops being signed in. The
  // person does not: they have an account, and an account that went quiet over
  // the summer is still theirs when they come back to it. Only the browser
  // forgets.
  //
  // Returns how many devices were signed out.
  function expireDevices() {
    let dropped = 0;
    const at = now();
    for (const [uid, rec] of identities) {
      let lost = false;
      for (const [tokenHash, t] of rec.tokens) {
        if (at - t.lastSeenAt > ttlMs) {
          rec.tokens.delete(tokenHash);
          tokens.delete(tokenHash);
          lost = true;
          dropped++;
        }
      }
      if (lost) mark(uid);
    }
    if (dropped) scheduleFlush('material');
    return dropped;
  }

  // ── Who runs the server, and who may not play ───────────────────────────
  //
  // Both are facts about a person rather than about their account, so both
  // live here: a GameNight player has no account row and is just as much
  // somebody who might administer this server or be kept off it.

  function isAdmin(uid) {
    return !!uid && admins.has(uid);
  }

  function adminCount() {
    return admins.size;
  }

  // Would taking this uid's administrator away leave nobody? Every guard that
  // refuses - demote, disable, delete - asks this one question, so there is
  // one answer to keep right rather than three.
  function wouldOrphan(uid) {
    return isAdmin(uid) && admins.size <= 1;
  }

  function setRole(uid, role) {
    const rec = uid ? identities.get(uid) : null;
    if (!rec) return false;
    const next = role === 'admin' ? 'admin' : 'player';
    if (rec.role === next) return true;
    rec.role = next;
    if (next === 'admin') admins.add(uid);
    else admins.delete(uid);
    mark(uid);
    scheduleFlush('material');
    return true;
  }

  function isDisabled(uid) {
    const rec = uid ? identities.get(uid) : null;
    return !!rec && !!rec.disabledAt;
  }

  function setDisabled(uid, at) {
    const rec = uid ? identities.get(uid) : null;
    if (!rec) return false;
    rec.disabledAt = Number.isFinite(at) ? at : at ? now() : null;
    mark(uid);
    scheduleFlush('material');
    return true;
  }

  // Every device, at once. What "sign out everywhere" does, and what disabling
  // or deleting somebody has to do before it means anything - a token already
  // in a browser would otherwise keep working until it aged out.
  //
  // Returns the digests, so the caller can find the sockets holding them.
  function revokeAll(uid) {
    const rec = uid ? identities.get(uid) : null;
    if (!rec) return [];
    const dropped = [...rec.tokens.keys()];
    for (const tokenHash of dropped) tokens.delete(tokenHash);
    rec.tokens.clear();
    mark(uid);
    scheduleFlush('material');
    return dropped;
  }

  function remove(uid) {
    if (!drop(uid)) return false;
    markGone(uid);
    scheduleFlush('material');
    return true;
  }

  // The Users page. Searched, filtered and paged here rather than in the
  // browser: the page polls, and a server with a thousand players should not
  // send a thousand rows three times a minute to show twenty-five of them.
  function list({ q = '', filter = 'all', limit = 25, offset = 0 } = {}) {
    const needle = String(q || '')
      .trim()
      .toLocaleLowerCase();
    let rows = [...identities.values()];
    if (needle) rows = rows.filter((rec) => nameKeyOf(rec.name).includes(needle));
    if (filter === 'admin') rows = rows.filter((rec) => rec.role === 'admin');
    else if (filter === 'disabled') rows = rows.filter((rec) => !!rec.disabledAt);
    // Newest visit first, and uid to break a tie, so paging is stable while
    // people come and go underneath it.
    rows.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0) || (a.uid < b.uid ? -1 : 1));
    const total = rows.length;
    const from = Math.max(0, Number(offset) || 0);
    const size = Math.max(1, Math.min(50, Number(limit) || 25));
    return {
      total,
      offset: from,
      limit: size,
      rows: rows.slice(from, from + size).map((rec) => ({
        uid: rec.uid,
        name: rec.name,
        avatar: rec.avatar,
        provider: rec.provider,
        role: rec.role,
        disabled: !!rec.disabledAt,
        disabledAt: rec.disabledAt,
        createdAt: rec.createdAt,
        lastSeenAt: rec.lastSeenAt,
        devices: rec.tokens.size,
      })),
    };
  }

  return {
    identify,
    identifyFromGameNight,
    signInAs,
    nameHolder,
    nameHeldBy,
    verify,
    get,
    rename,
    setAvatar,
    setPrefs,
    sessions,
    endSession,
    revokeToken,
    revokeAll,
    expireDevices,
    isAdmin,
    isDisabled,
    setRole,
    setDisabled,
    adminCount,
    wouldOrphan,
    list,
    remove,
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

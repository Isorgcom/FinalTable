// migrate.js - the files this server used to keep, read in once.
//
// Everything used to live in JSON beside the application. This reads what is
// there into the database on the first boot that finds the tables empty, and
// then leaves the files alone - renamed `.imported`, never deleted, because
// the first run of this against somebody's real data is exactly the run where
// having the old copy still matters.
//
// Per kind, not all or nothing: a server that has already imported its
// identities and is now meeting accounts for the first time imports only
// those. An empty table plus a file that exists is the whole test.
//
// The one thing that changes on the way through is device tokens. The file
// kept them as themselves; the database keeps a digest. Nobody is signed out
// by that - a browser still sends the token it has, and the store hashes it to
// look it up - but it does mean the import is the last moment those tokens
// exist anywhere on the server.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { digestToken } = require('../password');

const IMPORTED_SUFFIX = '.imported';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_err) {
    return null;
  }
}

function setAside(file, log) {
  try {
    fs.renameSync(file, `${file}${IMPORTED_SUFFIX}`);
  } catch (err) {
    log({
      level: 'warn',
      event: 'migrate_rename_failed',
      message: 'Imported a file but could not set it aside',
      data: { file: path.basename(file), detail: err && err.message },
    });
  }
}

async function migrateFromFiles(options = {}) {
  const {
    db = null,
    saveDir = null,
    log = () => {},
    nameKey = (v) =>
      String(v || '')
        .trim()
        .toLocaleLowerCase(),
  } = options;
  if (!db || !saveDir) return {};

  const done = {};

  // ── Settings ──────────────────────────────────────────────────────────────
  const settingsFile = path.join(saveDir, 'settings.json');
  if (fs.existsSync(settingsFile) && (await db.settings.all()).length === 0) {
    const data = readJson(settingsFile);
    const settings =
      data && data.settings && typeof data.settings === 'object' ? data.settings : null;
    if (settings) {
      let n = 0;
      for (const [k, v] of Object.entries(settings)) {
        if (v === null || v === undefined) continue;
        await db.settings.put(k, v);
        n++;
      }
      done.settings = n;
      setAside(settingsFile, log);
    }
  }

  // ── Identities and their devices ──────────────────────────────────────────
  const identFile = path.join(saveDir, 'identities.json');
  if (fs.existsSync(identFile) && (await db.identities.count()) === 0) {
    const data = readJson(identFile);
    const rows = data && Array.isArray(data.identities) ? data.identities : null;
    if (rows) {
      let people = 0;
      let devices = 0;
      for (const rec of rows) {
        if (!rec || !rec.uid) continue;
        // Version 1 kept one token per record, on the record itself.
        const tokens = Array.isArray(rec.tokens)
          ? rec.tokens
          : rec.token
            ? [{ token: rec.token, createdAt: rec.createdAt, lastSeenAt: rec.lastSeenAt }]
            : [];
        const list = [];
        for (const t of tokens) {
          if (!t || !t.token) continue;
          list.push({
            // The digest, and from here the token exists only in the browser
            // that holds it.
            tokenHash: digestToken(t.token),
            id: t.id || crypto.randomBytes(8).toString('hex'),
            label: typeof t.label === 'string' && t.label ? t.label : 'A browser',
            createdAt: t.createdAt || rec.createdAt || Date.now(),
            lastSeenAt: t.lastSeenAt || rec.lastSeenAt || Date.now(),
          });
        }
        // An identity with no device on it is nobody, which is what the file
        // loader did with one too.
        if (!list.length) continue;
        await db.identities.put({
          uid: rec.uid,
          name: rec.name || '',
          nameKey: nameKey(rec.name),
          avatar: rec.avatar || '🧑',
          provider: ['gamenight', 'local'].includes(rec.provider) ? rec.provider : 'guest',
          gnUserId: rec.gnUserId ? String(rec.gnUserId) : null,
          createdAt: rec.createdAt || Date.now(),
          lastSeenAt: rec.lastSeenAt || rec.createdAt || Date.now(),
          prefs: rec.prefs && typeof rec.prefs === 'object' ? rec.prefs : {},
          devices: list,
        });
        people++;
        devices += list.length;
      }
      done.identities = people;
      done.devices = devices;
      setAside(identFile, log);
    }
  }

  // ── Accounts ──────────────────────────────────────────────────────────────
  const accountsFile = path.join(saveDir, 'accounts.json');
  if (fs.existsSync(accountsFile) && (await db.accounts.count()) === 0) {
    const data = readJson(accountsFile);
    if (data && Array.isArray(data.accounts)) {
      let n = 0;
      for (const row of data.accounts) {
        if (!row || !row.uid || !row.key || !row.password) continue;
        await db.accounts.put(row);
        n++;
      }
      for (const row of Array.isArray(data.pending) ? data.pending : []) {
        if (!row || !row.key || !row.uid) continue;
        await db.accounts.putPending(row);
      }
      for (const row of Array.isArray(data.resets) ? data.resets : []) {
        if (!row || !row.tokenHash || !row.uid) continue;
        await db.accounts.putReset(row);
      }
      done.accounts = n;
      setAside(accountsFile, log);
    }
  }

  // ── Games in progress, and what was said at them ──────────────────────────
  const tournamentsFile = path.join(saveDir, 'tournaments.json');
  if (fs.existsSync(tournamentsFile) && (await db.tournaments.all()).length === 0) {
    const data = readJson(tournamentsFile);
    const rows = data && Array.isArray(data.tournaments) ? data.tournaments : null;
    if (rows) {
      const keep = rows.filter((row) => row && row.id);
      await db.tournaments.replaceAll(
        keep.map((row) => ({ id: row.id, status: row.status || 'registering', data: row }))
      );
      done.tournaments = keep.length;
      setAside(tournamentsFile, log);
    }
  }

  // One file per tournament under chat/, which is where it lived.
  const chatDir = path.join(saveDir, 'chat');
  if (fs.existsSync(chatDir) && (await db.chat.all()).length === 0) {
    let n = 0;
    let names = [];
    try {
      names = fs.readdirSync(chatDir).filter((name) => name.endsWith('.json'));
    } catch (_err) {
      names = [];
    }
    for (const name of names) {
      const parsed = readJson(path.join(chatDir, name));
      if (!parsed || !parsed.rooms || typeof parsed.rooms !== 'object') continue;
      const id = parsed.id || decodeURIComponent(name.slice(0, -'.json'.length));
      await db.chat.put(id, parsed.rooms);
      n++;
    }
    if (n) {
      done.chat = n;
      // A directory rather than a file: set the whole thing aside at once.
      setAside(chatDir, log);
    }
  }

  if (Object.keys(done).length) {
    log({
      level: 'info',
      event: 'migrated_from_files',
      message: 'Imported what the files held',
      data: { ...done, from: saveDir },
    });
  }
  return done;
}

module.exports = { migrateFromFiles, IMPORTED_SUFFIX };

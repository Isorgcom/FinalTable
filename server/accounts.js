// accounts.js - a name on this server that is yours, and the password for it.
//
// The third kind of identity here. A guest is a name and a token in one
// browser; a GameNight account is somebody else's account borrowed through the
// SSO bridge; this one belongs to this server, and the name is the account -
// setting a password against the name you already play under is what makes it
// yours.
//
// Three rules about names settle every case:
//
//   1. An account owns its name, compared case-insensitively. No guest may
//      identify as a name an account owns.
//   2. A name can be claimed when nobody else holds it. Claiming the one your
//      own guest identity is already using is the ordinary case, and is what
//      makes the upgrade keep your uid - and with it your preferences, your
//      devices and your kept games.
//   3. A sign-up holds the name while it is pending and owns it only when the
//      link in the mail is clicked. The hold expires, which is what stops a
//      mistyped address locking a name away for ever.
//
// What is written here is a scrypt record from password.js and an address.
// The password is never stored and never logged, and the address never leaves
// this file: it is in no player state, no roster, no admin log, no hand
// history and no answer to anybody else.
//
// Verification and reset links are 32 random bytes, kept only as a digest.
// What goes in the mail is the only copy: a file full of live links would be
// a better prize than the accounts they open.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const {
  hashPassword,
  matchesRecord,
  passwordProblem,
  mintToken,
  digestToken,
  sameDigest,
} = require('./password');

const FILE_VERSION = 1;
const FLUSH_DEBOUNCE_MS = 1000;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const MAX_EMAIL = 254;

// Deliberately loose. The only test that matters is whether the mail arrives,
// and a pattern strict enough to be interesting rejects addresses that work.
function normalizeEmail(value) {
  const trimmed = String(value || '')
    .trim()
    .slice(0, MAX_EMAIL);
  if (!trimmed || /\s/.test(trimmed)) return null;
  const at = trimmed.indexOf('@');
  if (at < 1 || at === trimmed.length - 1) return null;
  if (!trimmed.slice(at + 1).includes('.')) return null;
  return trimmed.toLowerCase();
}

function createAccounts(options = {}) {
  const {
    saveDir = null,
    nameKey = (v) =>
      String(v || '')
        .trim()
        .toLocaleLowerCase(),
    sanitizeName = (v) =>
      String(v || '')
        .trim()
        .slice(0, 16),
    // Asked of the identity store: is some *other* identity already playing
    // under this name? The accounts file cannot know that on its own.
    nameInUse = () => false,
    verifyTtlMs = VERIFY_TTL_MS,
    resetTtlMs = RESET_TTL_MS,
    flushDebounceMs = FLUSH_DEBOUNCE_MS,
    now = () => Date.now(),
  } = options;
  const file = saveDir ? path.join(saveDir, 'accounts.json') : null;

  const byKey = new Map(); // nameKey -> account
  const byId = new Map(); // uid -> account
  const pending = new Map(); // nameKey -> pending sign-up
  const resets = new Map(); // tokenHash -> { uid, expiresAt }

  let flushTimer = null;
  let writing = false;
  let writeQueued = false;
  let tmpSeq = 0;

  // ── Reading the rules ───────────────────────────────────────────────────

  function ownerOf(name) {
    const account = byKey.get(nameKey(name));
    return account ? account.uid : null;
  }

  // Who has this name: the account that owns it, or the sign-up holding it
  // while it waits for its link to be clicked. This is what the identity store
  // asks, because a guest must not take a name out from under somebody who is
  // halfway through claiming it - they would both be answering to it by the
  // time the link was opened.
  function holderOf(name, at = now()) {
    const key = nameKey(name);
    const account = byKey.get(key);
    if (account) return account.uid;
    const held = pending.get(key);
    return held && held.expiresAt > at ? held.uid : null;
  }

  function byUid(uid) {
    return uid ? byId.get(uid) || null : null;
  }

  // Owned, or held by a sign-up that has not expired. Either way somebody
  // else cannot have it.
  function isHeld(name, at = now()) {
    const key = nameKey(name);
    if (byKey.has(key)) return true;
    const held = pending.get(key);
    return !!held && held.expiresAt > at;
  }

  function isAccountName(name, at = now()) {
    return byKey.has(nameKey(name)) || isHeld(name, at);
  }

  // ── Signing up ──────────────────────────────────────────────────────────

  function startSignUp({ uid, name, email, password } = {}) {
    const at = now();
    if (!uid) return { error: 'Tell the table who you are first.' };
    const safeName = sanitizeName(name);
    const key = nameKey(safeName);
    if (!key) return { error: 'Pick a name first.' };

    const owner = byKey.get(key);
    if (owner && owner.uid !== uid) return { error: 'That name is taken on this server.' };
    const held = pending.get(key);
    if (held && held.uid !== uid && held.expiresAt > at) {
      return { error: 'Somebody is already signing up with that name.' };
    }
    // Rule 2: your own guest identity does not count against you, anybody
    // else's does.
    if (nameInUse(key, uid)) {
      return { error: 'Somebody else is playing under that name. Pick another.' };
    }

    const problem = passwordProblem(password);
    if (problem) return { error: problem };
    const address = normalizeEmail(email);
    if (!address) return { error: 'That does not look like an email address.' };

    const token = mintToken();
    pending.set(key, {
      key,
      uid,
      name: safeName,
      email: address,
      password: hashPassword(password),
      tokenHash: digestToken(token),
      createdAt: at,
      expiresAt: at + verifyTtlMs,
    });
    schedule();
    // The token goes to the mailer and nowhere else.
    return { token, name: safeName, email: address, expiresAt: at + verifyTtlMs };
  }

  // The link in the mail, clicked. The name is owned from here.
  function completeSignUp(token) {
    const at = now();
    const hash = digestToken(token);
    if (!hash) return { error: 'That link is not one of ours.' };
    for (const held of [...pending.values()]) {
      if (!sameDigest(held.tokenHash, hash)) continue;
      pending.delete(held.key);
      if (held.expiresAt <= at) {
        schedule();
        return { error: 'That link has expired. Sign up again.' };
      }
      // Claimed while they were reading their mail.
      const owner = byKey.get(held.key);
      if (owner && owner.uid !== held.uid) {
        schedule();
        return { error: 'That name was taken while you were away.' };
      }
      const account = {
        uid: held.uid,
        key: held.key,
        name: held.name,
        email: held.email,
        password: held.password,
        createdAt: held.createdAt,
        verifiedAt: at,
      };
      byKey.set(account.key, account);
      byId.set(account.uid, account);
      schedule();
      return { uid: account.uid, name: account.name };
    }
    return { error: 'That link is not one of ours.' };
  }

  // ── Signing in ──────────────────────────────────────────────────────────

  // Null for a name with no account and for a wrong password alike: the answer
  // must not say which, or it says which names exist.
  function signIn(name, password) {
    const account = byKey.get(nameKey(name));
    if (!account || typeof password !== 'string') return null;
    if (!matchesRecord(password, account.password)) return null;
    return { uid: account.uid, name: account.name };
  }

  function changePassword(uid, current, next) {
    const account = byUid(uid);
    if (!account) return 'There is no account on this name.';
    if (!matchesRecord(current, account.password)) return 'That is not your current password.';
    const problem = passwordProblem(next);
    if (problem) return problem;
    account.password = hashPassword(next);
    schedule();
    return null;
  }

  // ── Forgetting it ───────────────────────────────────────────────────────

  // Returns what the mailer needs, or null. The caller answers the player the
  // same way either way.
  function startReset(name) {
    const at = now();
    const account = byKey.get(nameKey(name));
    if (!account) return null;
    const token = mintToken();
    resets.set(digestToken(token), { uid: account.uid, createdAt: at, expiresAt: at + resetTtlMs });
    schedule();
    return { token, name: account.name, email: account.email, expiresAt: at + resetTtlMs };
  }

  // What a reset link opens, without spending it: the page has to be drawn
  // before the new password is typed.
  function resetSubject(token) {
    const hash = digestToken(token);
    if (!hash) return null;
    for (const [stored, row] of resets) {
      if (!sameDigest(stored, hash)) continue;
      if (row.expiresAt <= now()) return null;
      const account = byUid(row.uid);
      return account ? { uid: account.uid, name: account.name } : null;
    }
    return null;
  }

  function completeReset(token, password) {
    const hash = digestToken(token);
    if (!hash) return { error: 'That link is not one of ours.' };
    for (const [stored, row] of [...resets]) {
      if (!sameDigest(stored, hash)) continue;
      // Spent whatever happens next: a link that survives a failed attempt is
      // a link somebody can keep trying.
      resets.delete(stored);
      schedule();
      if (row.expiresAt <= now()) return { error: 'That link has expired. Ask for another.' };
      const account = byUid(row.uid);
      if (!account) return { error: 'That account is gone.' };
      const problem = passwordProblem(password);
      if (problem) return { error: problem };
      account.password = hashPassword(password);
      schedule();
      return { uid: account.uid, name: account.name };
    }
    return { error: 'That link is not one of ours.' };
  }

  // ── Keeping it tidy ─────────────────────────────────────────────────────

  function prune(at = now()) {
    let dropped = 0;
    for (const [key, held] of [...pending]) {
      if (held.expiresAt <= at) {
        pending.delete(key);
        dropped++;
      }
    }
    for (const [hash, row] of [...resets]) {
      if (row.expiresAt <= at) {
        resets.delete(hash);
        dropped++;
      }
    }
    if (dropped) schedule();
    return dropped;
  }

  // ── The disk ────────────────────────────────────────────────────────────

  function body() {
    return JSON.stringify({
      version: FILE_VERSION,
      accounts: [...byKey.values()],
      pending: [...pending.values()],
      resets: [...resets.entries()].map(([tokenHash, row]) => ({ tokenHash, ...row })),
    });
  }

  function schedule() {
    if (!file || flushTimer) return;
    flushTimer = setTimeout(flushAsync, flushDebounceMs);
    if (flushTimer.unref) flushTimer.unref();
  }

  function flushAsync() {
    flushTimer = null;
    if (!file) return;
    if (writing) {
      writeQueued = true;
      return;
    }
    writing = true;
    const snapshot = body();
    tmpSeq = (tmpSeq + 1) % 1e6;
    const tmp = `${file}.${process.pid}.${tmpSeq}.tmp`;
    fsp
      .mkdir(path.dirname(file), { recursive: true })
      .then(() => fsp.writeFile(tmp, snapshot, { mode: 0o600 }))
      .then(() => fsp.rename(tmp, file))
      .catch(() => fsp.rm(tmp, { force: true }).catch(() => {}))
      .then(() => {
        writing = false;
        if (writeQueued) {
          writeQueued = false;
          schedule();
        }
      });
  }

  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    writeQueued = false;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, body(), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (_err) {
      // Not worth failing a shutdown over; the next change writes again.
    }
  }

  function load() {
    byKey.clear();
    byId.clear();
    pending.clear();
    resets.clear();
    if (!file || !fs.existsSync(file)) return 0;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const row of Array.isArray(data.accounts) ? data.accounts : []) {
        if (!row || !row.uid || !row.key || !row.password) continue;
        byKey.set(row.key, row);
        byId.set(row.uid, row);
      }
      for (const row of Array.isArray(data.pending) ? data.pending : []) {
        if (!row || !row.key || !row.uid) continue;
        pending.set(row.key, row);
      }
      for (const row of Array.isArray(data.resets) ? data.resets : []) {
        if (!row || !row.tokenHash || !row.uid) continue;
        const { tokenHash, ...rest } = row;
        resets.set(tokenHash, rest);
      }
      prune();
    } catch (_err) {
      byKey.clear();
      byId.clear();
      pending.clear();
      resets.clear();
    }
    return byKey.size;
  }

  load();

  return {
    ownerOf,
    holderOf,
    byUid,
    isHeld,
    isAccountName,
    startSignUp,
    completeSignUp,
    signIn,
    changePassword,
    startReset,
    resetSubject,
    completeReset,
    prune,
    load,
    flush,
    flushAsync,
    file,
    get size() {
      return byKey.size;
    },
    get pendingSize() {
      return pending.size;
    },
  };
}

module.exports = { createAccounts, normalizeEmail };

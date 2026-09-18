// accounts.js - a name on this server that is yours, and the password for it.
//
// One of the two ways in. A GameNight account is somebody else's account
// borrowed through the SSO bridge; this one belongs to this server, and the
// name is the account - claiming a name with a password and an address you
// confirm is what makes it yours.
//
// Three rules about names settle every case:
//
//   1. An account owns its name, compared case-insensitively. Nobody else may
//      answer to a name an account owns.
//   2. A name can be claimed when nobody else holds it - not owned by an
//      account, and not already being played under by a GameNight identity,
//      which is what the identity store is asked.
//   3. A sign-up holds the name while it is pending and owns it only when the
//      link in the mail is clicked. The hold expires, which is what stops a
//      mistyped address locking a name away for ever.
//
// What is written here is a scrypt record from password.js and an address.
// The password is never stored and never logged. The address is in no player
// state, no roster, no hand history and no answer to another player; an
// administrator can see one, on one account at a time, and the admin log says
// every time they did.
//
// Verification and reset links are 32 random bytes, kept only as a digest.
// What goes in the mail is the only copy: a file full of live links would be
// a better prize than the accounts they open.

const {
  hashPassword,
  matchesRecord,
  passwordProblem,
  mintToken,
  digestToken,
  sameDigest,
} = require('./password');
const random = require('../random');

// What is stored against an account nobody has chosen a password for yet: one
// an administrator made, which is waiting for its owner to open the link. It
// has to be an object rather than null on two counts - matchesRecord refuses
// anything whose algo is not scrypt, so no password signs in against it, and
// load() below drops a row with no password at all, which would quietly delete
// the account on the next restart.
const NO_PASSWORD = { algo: 'unset' };

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
    db = null,
    log = () => {},
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
    now = () => Date.now(),
  } = options;

  const byKey = new Map(); // nameKey -> account
  const byId = new Map(); // uid -> account
  const pending = new Map(); // nameKey -> pending sign-up
  const resets = new Map(); // tokenHash -> { uid, expiresAt }

  // Written the moment they change rather than on a debounce. There are a
  // handful of these a day on a busy server - a sign-up, a verification, a
  // password changed - and every one of them is the sort of thing that must
  // not be lost because the process went away a second later.
  const inFlight = new Set();

  function write(work) {
    if (!db) return;
    const task = Promise.resolve()
      .then(work)
      .catch((err) => {
        log({
          level: 'error',
          event: 'account_write_failed',
          message: 'Could not write an account',
          data: { detail: err && err.message },
        });
      })
      .finally(() => inFlight.delete(task));
    inFlight.add(task);
  }

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

  // The uid is minted here when there is not one already. There used to be:
  // signing up was something a guest did to keep the name they were already
  // playing under, so the socket had an identity and the account inherited it.
  // Now a sign-up is how somebody becomes anybody at all, and the identity is
  // not written until they first sign in - so an address that is never
  // confirmed, or confirmed and never used, leaves nothing behind.
  async function startSignUp({ uid, name, email, password } = {}) {
    const at = now();
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
      uid: uid || random.randomId('u_'),
      name: safeName,
      email: address,
      password: await hashPassword(password),
      tokenHash: digestToken(token),
      createdAt: at,
      expiresAt: at + verifyTtlMs,
    });
    write(() => db.accounts.putPending(pending.get(key)));
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
      write(() => db.accounts.removePending(held.key));
      if (held.expiresAt <= at) {
        return { error: 'That link has expired. Sign up again.' };
      }
      // Claimed while they were reading their mail.
      const owner = byKey.get(held.key);
      if (owner && owner.uid !== held.uid) {
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
      write(() => db.accounts.put(account));
      return { uid: account.uid, name: account.name };
    }
    return { error: 'That link is not one of ours.' };
  }

  // An account made by an administrator rather than by its owner. No password
  // is set: what goes out is a reset link, and choosing one from that link is
  // what makes the account usable. So the administrator never knows it, which
  // is the only sensible way to hand one over.
  //
  // Returns the account, or an error to show them.
  function createVerified({ uid, name, email, role = 'player' } = {}) {
    const at = now();
    const safeName = sanitizeName(name);
    const key = nameKey(safeName);
    if (!key) return { error: 'Pick a name first.' };
    if (byKey.has(key)) return { error: 'That name is taken on this server.' };
    const held = pending.get(key);
    if (held && held.expiresAt > at) {
      return { error: 'Somebody is already signing up with that name.' };
    }
    if (nameInUse(key, uid)) {
      return { error: 'Somebody else is playing under that name. Pick another.' };
    }
    const address = normalizeEmail(email);
    if (!address) return { error: 'That does not look like an email address.' };

    const account = {
      uid: uid || random.randomId('u_'),
      key,
      name: safeName,
      email: address,
      password: NO_PASSWORD,
      createdAt: at,
      verifiedAt: at,
    };
    byKey.set(account.key, account);
    byId.set(account.uid, account);
    write(() => db.accounts.put(account));
    return { uid: account.uid, name: account.name, email: address, role };
  }

  // Gone. The identity is the caller's to remove - this is only the half that
  // holds the password and the address.
  function remove(uid) {
    const account = byUid(uid);
    if (!account) return false;
    byKey.delete(account.key);
    byId.delete(account.uid);
    // Any link out to this account is dead with it.
    for (const [hash, row] of [...resets]) {
      if (row.uid === uid) {
        resets.delete(hash);
        write(() => db.accounts.removeReset(hash));
      }
    }
    write(() => db.accounts.remove(uid));
    return true;
  }

  // ── Signing in ──────────────────────────────────────────────────────────

  // Null for a name with no account and for a wrong password alike: the answer
  // must not say which, or it says which names exist.
  async function signIn(name, password) {
    const account = byKey.get(nameKey(name));
    if (!account || typeof password !== 'string') return null;
    if (!(await matchesRecord(password, account.password))) return null;
    return { uid: account.uid, name: account.name };
  }

  async function changePassword(uid, current, next) {
    const account = byUid(uid);
    if (!account) return 'There is no account on this name.';
    if (!(await matchesRecord(current, account.password))) {
      return 'That is not your current password.';
    }
    const problem = passwordProblem(next);
    if (problem) return problem;
    account.password = await hashPassword(next);
    write(() => db.accounts.put(account));
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
    const tokenHash = digestToken(token);
    const row = { tokenHash, uid: account.uid, createdAt: at, expiresAt: at + resetTtlMs };
    resets.set(tokenHash, row);
    write(() => db.accounts.putReset(row));
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

  async function completeReset(token, password) {
    const hash = digestToken(token);
    if (!hash) return { error: 'That link is not one of ours.' };
    for (const [stored, row] of [...resets]) {
      if (!sameDigest(stored, hash)) continue;
      // Spent whatever happens next: a link that survives a failed attempt is
      // a link somebody can keep trying.
      resets.delete(stored);
      write(() => db.accounts.removeReset(stored));
      if (row.expiresAt <= now()) return { error: 'That link has expired. Ask for another.' };
      const account = byUid(row.uid);
      if (!account) return { error: 'That account is gone.' };
      const problem = passwordProblem(password);
      if (problem) return { error: problem };
      account.password = await hashPassword(password);
      write(() => db.accounts.put(account));
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
        write(() => db.accounts.removePending(key));
        dropped++;
      }
    }
    for (const [hash, row] of [...resets]) {
      if (row.expiresAt <= at) {
        resets.delete(hash);
        write(() => db.accounts.removeReset(hash));
        dropped++;
      }
    }
    return dropped;
  }

  // ── What is written down ────────────────────────────────────────────────

  async function load() {
    byKey.clear();
    byId.clear();
    pending.clear();
    resets.clear();
    if (!db) return 0;
    const stored = await db.accounts.all();
    for (const row of stored.accounts || []) {
      if (!row || !row.uid || !row.key || !row.password) continue;
      byKey.set(row.key, row);
      byId.set(row.uid, row);
    }
    for (const row of stored.pending || []) {
      if (!row || !row.key || !row.uid) continue;
      pending.set(row.key, row);
    }
    for (const row of stored.resets || []) {
      if (!row || !row.tokenHash || !row.uid) continue;
      resets.set(row.tokenHash, row);
    }
    prune();
    return byKey.size;
  }

  // Everything still in the air. Nothing here is debounced, so this is only
  // ever the handful of writes started in the last moment before a shutdown.
  function flush() {
    return Promise.all([...inFlight]).then(() => {});
  }

  return {
    ownerOf,
    holderOf,
    createVerified,
    remove,
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
    get size() {
      return byKey.size;
    },
    get pendingSize() {
      return pending.size;
    },
  };
}

module.exports = { createAccounts, normalizeEmail };

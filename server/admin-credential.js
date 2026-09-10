// admin-credential.js - the operator password, and changing it.
//
// Two places it can come from. `ADMIN_PASSWORD` in the environment is how a
// server gets its first one, because a box with no password has no operator
// surface at all and therefore no way in to set one. Once an operator changes
// it from the Operator page the new one is kept here, hashed, and wins from
// then on: a password somebody typed into a browser should not be undone by a
// stale line in a compose file.
//
// What is stored is a scrypt hash and its salt, never the password. The
// environment's copy is compared as it stands, because the environment is
// where it already lives in the clear.
//
// Forgotten it? Remove `adminPassword` from data/settings.json and the
// environment's password works again. That takes a shell on the host, which
// is the right bar for a recovery.

const crypto = require('crypto');

const MIN_LENGTH = 8;
const MAX_LENGTH = 128;
const KEY_LENGTH = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(password, salt, KEY_LENGTH, { ...SCRYPT_PARAMS });
  return {
    algo: 'scrypt',
    salt,
    hash: derived.toString('hex'),
    params: { ...SCRYPT_PARAMS },
    updatedAt: Date.now(),
  };
}

// Both sides through a digest of the same length, so the comparison cannot
// leak the answer one character at a time to somebody measuring it.
function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
  const x = crypto.createHash('sha256').update(a, 'utf8').digest();
  const y = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(x, y);
}

function matchesRecord(password, record) {
  if (!record || record.algo !== 'scrypt' || !record.salt || !record.hash) return false;
  const params = { ...SCRYPT_PARAMS, ...(record.params || {}) };
  let derived;
  try {
    derived = crypto.scryptSync(password, record.salt, record.hash.length / 2, params);
  } catch (_err) {
    return false;
  }
  const stored = Buffer.from(record.hash, 'hex');
  if (stored.length !== derived.length) return false;
  return crypto.timingSafeEqual(stored, derived);
}

function passwordProblem(password) {
  if (typeof password !== 'string' || password.trim().length === 0) {
    return 'Enter a new password.';
  }
  if (password.length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters.`;
  if (password.length > MAX_LENGTH) return `Use at most ${MAX_LENGTH} characters.`;
  return null;
}

function createAdminCredential({ settingsStore = null, envPassword = '', log = () => {} } = {}) {
  const fromEnv = typeof envPassword === 'string' ? envPassword.trim() : '';
  let saved = settingsStore ? settingsStore.get('adminPassword') : null;
  if (saved && (saved.algo !== 'scrypt' || !saved.salt || !saved.hash)) saved = null;

  function isEnabled() {
    return !!saved || fromEnv.length > 0;
  }

  function verify(password) {
    if (typeof password !== 'string' || !isEnabled()) return false;
    return saved ? matchesRecord(password, saved) : sameString(password, fromEnv);
  }

  // Returns null on success, or a sentence to show the operator.
  function change(current, next) {
    if (!isEnabled()) return 'There is no operator password on this server.';
    if (!verify(current)) return 'That is not the current password.';
    const problem = passwordProblem(next);
    if (problem) return problem;
    if (verify(next)) return 'That is already the password.';
    saved = hashPassword(next);
    if (settingsStore) settingsStore.set('adminPassword', saved);
    log({
      level: 'info',
      event: 'admin_password_changed',
      message: 'Operator password changed',
      data: { storedTo: settingsStore ? settingsStore.file : null },
    });
    return null;
  }

  function status() {
    return {
      enabled: isEnabled(),
      source: saved ? 'saved' : fromEnv ? 'env' : null,
      updatedAt: saved ? saved.updatedAt || null : null,
      minLength: MIN_LENGTH,
    };
  }

  return { isEnabled, verify, change, status };
}

module.exports = { createAdminCredential, MIN_LENGTH, MAX_LENGTH };

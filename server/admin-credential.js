// admin-credential.js - the admin password, and changing it.
//
// Two places it can come from. `ADMIN_PASSWORD` in the environment is how a
// server gets its first one, because a box with no password has no admin
// surface at all and therefore no way in to set one. Once an admin changes
// it from the Admin page the new one is kept here, hashed, and wins from
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

// The hashing itself lives in password.js, shared with the player accounts
// that arrived later. Same scrypt, same salt-per-record, same timing-safe
// compare - and an admin password hashed before the move still verifies,
// because nothing about the stored shape changed.
const {
  hashPassword,
  matchesRecord,
  sameString,
  passwordProblem,
  MIN_LENGTH,
  MAX_LENGTH,
} = require('./password');

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

  // Returns null on success, or a sentence to show the admin.
  function change(current, next) {
    if (!isEnabled()) return 'There is no admin password on this server.';
    if (!verify(current)) return 'That is not the current password.';
    const problem = passwordProblem(next);
    if (problem) return problem;
    if (verify(next)) return 'That is already the password.';
    saved = hashPassword(next);
    if (settingsStore) settingsStore.set('adminPassword', saved);
    log({
      level: 'info',
      event: 'admin_password_changed',
      message: 'Admin password changed',
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

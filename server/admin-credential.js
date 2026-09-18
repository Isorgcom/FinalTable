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

  // Read when asked rather than when this was made. The settings are loaded
  // before the server listens and this is built before that, so a copy taken
  // here would be the copy from before there was one.
  // Somewhere to keep it when there is no settings store at all, which is a
  // server that cannot remember anything across a restart. It can still be
  // changed for as long as the process lives.
  let unstored = null;

  function stored() {
    const saved = settingsStore ? settingsStore.get('adminPassword') : unstored;
    if (!saved || saved.algo !== 'scrypt' || !saved.salt || !saved.hash) return null;
    return saved;
  }

  function isEnabled() {
    return !!stored() || fromEnv.length > 0;
  }

  async function verify(password) {
    if (typeof password !== 'string' || !isEnabled()) return false;
    const saved = stored();
    return saved ? matchesRecord(password, saved) : sameString(password, fromEnv);
  }

  // Returns null on success, or a sentence to show the admin.
  async function change(current, next) {
    if (!isEnabled()) return 'There is no admin password on this server.';
    if (!(await verify(current))) return 'That is not the current password.';
    const problem = passwordProblem(next);
    if (problem) return problem;
    if (await verify(next)) return 'That is already the password.';
    const record = await hashPassword(next);
    if (settingsStore) settingsStore.set('adminPassword', record);
    else unstored = record;
    log({
      level: 'info',
      event: 'admin_password_changed',
      message: 'Admin password changed',
    });
    return null;
  }

  function status() {
    const saved = stored();
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

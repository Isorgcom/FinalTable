// api-keys.js - the key GameNight presents to make a game here.
//
// One key, for one caller. GameNight is paired with this server for sign-in
// already, but that trust runs the other way - GameNight signs, this server
// checks - and there is nothing GameNight could present to prove it is
// itself. So an administrator makes a key on the Admin page, pastes it into
// GameNight, and GameNight sends it as a bearer token. What is kept here is
// its digest: a key is a bearer thing, and a settings row holding a live one
// would be a better prize than the games it can make. Shown once, at the
// moment it is made, and never again.
//
// Unlike the mail settings and the pairing beside it, nothing is cached and
// there is no init(): the settings store is a map already loaded before the
// server listens, so the record is read on every call and cannot go stale
// between a revoke on the page and the next request.

const { mintToken, digestToken, sameDigest } = require('./password');

// How often "last used" is written down. GameNight polls; a settings write
// per poll is what the store was built to avoid.
const TOUCH_MS = 60 * 1000;

function createApiKeys({ settingsStore = null, log = () => {}, now = () => Date.now() } = {}) {
  // Where the record lives when there is no store: a test, or a bare
  // `node server.js` with nothing behind it.
  let memory = null;
  let touchedAt = 0;

  function read() {
    const saved = settingsStore ? settingsStore.get('api') : memory;
    return saved && typeof saved.digest === 'string' && saved.digest ? saved : null;
  }

  function write(record) {
    if (settingsStore) settingsStore.set('api', record);
    else memory = record;
  }

  // What the Admin page sees. Never the digest, which is a thing to attack
  // offline at leisure.
  function status() {
    const r = read();
    return {
      set: !!r,
      createdAt: r ? r.createdAt || null : null,
      lastUsedAt: r ? r.lastUsedAt || null : null,
    };
  }

  // A new key, replacing whatever was there. The raw key is returned to the
  // caller and to nobody else, ever.
  function make() {
    const replaced = !!read();
    const key = mintToken();
    write({ digest: digestToken(key), createdAt: now(), lastUsedAt: null });
    return { key, replaced };
  }

  function revoke() {
    const had = !!read();
    if (settingsStore) settingsStore.set('api', null);
    else memory = null;
    return had;
  }

  function touch(record) {
    const at = now();
    record.lastUsedAt = at;
    if (at - touchedAt < TOUCH_MS) return;
    touchedAt = at;
    write({ ...record, lastUsedAt: at });
  }

  // Both a missing header and a wrong key are "mismatch": the answer does not
  // say which. digestToken('') is null, and sameDigest refuses a null.
  function verify(raw) {
    const r = read();
    if (!r) return { ok: false, reason: 'unset' };
    if (!sameDigest(digestToken(raw), r.digest)) return { ok: false, reason: 'mismatch' };
    touch(r);
    return { ok: true };
  }

  // The Express middleware. A refusal is written down with the address it
  // came from and never with what it sent.
  function guard(req, res, next) {
    const header = String(req.get('authorization') || '');
    const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const result = verify(raw);
    if (result.ok) return next();
    log({
      level: 'warn',
      event: 'api_refused',
      message: 'An API request was refused',
      data: { ip: req.ip, reason: result.reason },
    });
    const error =
      result.reason === 'unset'
        ? 'This server has no API key. An administrator makes one on the Admin page, under GameNight.'
        : 'The API key is missing or wrong.';
    return res.status(401).json({ ok: false, error });
  }

  return { status, make, revoke, verify, guard };
}

module.exports = { createApiKeys, TOUCH_MS };

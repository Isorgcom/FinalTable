// password.js - hashing one, and checking it.
//
// Lifted out of admin-credential.js when accounts arrived, because a second
// copy of this is a second thing to get wrong and the first copy had already
// been got right: scrypt, a salt of its own per record, a comparison that
// takes the same time whatever the answer, and a stored record that carries
// the parameters it was made with so they can be raised later without
// invalidating everybody.
//
// What is stored is the hash and its salt. The password itself is never
// written anywhere, and never logged.
//
// Hashing is asynchronous, and has to be. scrypt at N=16384 is about a tenth
// of a second of solid CPU, and since an account became the only way in, every
// player pays it on the way through the door: a table's worth of people
// arriving together would be two seconds during which this server dealt no
// cards to anybody. crypto.scrypt does the same work on the thread pool.

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const MIN_LENGTH = 8;
const MAX_LENGTH = 128;
const KEY_LENGTH = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = await scrypt(password, salt, KEY_LENGTH, { ...SCRYPT_PARAMS });
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

async function matchesRecord(password, record) {
  if (!record || record.algo !== 'scrypt' || !record.salt || !record.hash) return false;
  const params = { ...SCRYPT_PARAMS, ...(record.params || {}) };
  let derived;
  try {
    derived = await scrypt(password, record.salt, record.hash.length / 2, params);
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

// A one-time secret, and the only copy of it. What is kept is the digest: a
// link in somebody's mail is a bearer thing, and a file full of live ones
// would be a better prize than the accounts it opens.
function mintToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function digestToken(token) {
  if (typeof token !== 'string' || !token) return null;
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function sameDigest(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

module.exports = {
  hashPassword,
  matchesRecord,
  sameString,
  passwordProblem,
  mintToken,
  digestToken,
  sameDigest,
  MIN_LENGTH,
  MAX_LENGTH,
};

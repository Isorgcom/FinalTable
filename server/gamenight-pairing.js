// gamenight-pairing.js - pairing this server with a GameNight, at runtime.
//
// A pairing is what the verifier needs (issuer, audience, public key) plus
// where it came from. The operator sets it from the lobby by giving the
// GameNight URL: this module fetches GameNight's public signing key from its
// /api/v1/sso endpoint, checks it is the kind of key expected, and keeps the
// result in settings.json. The environment variables still work and seed the
// file on first boot; after that the file wins.
//
// This is the one outbound HTTP call the server makes, and only an operator
// who has unlocked the admin controls can cause it.

const crypto = require('crypto');
const { createGameNightVerifier } = require('./gamenight-sso');

const AUDIENCE_RE = /^[a-z0-9-]{2,32}$/;
const URL_RE = /^https?:\/\/[^/\s?#]+/i;
const FETCH_TIMEOUT_MS = 8000;

function normalizeUrl(value) {
  const url = String(value || '')
    .trim()
    .replace(/\/+$/, '');
  return URL_RE.test(url) ? url : '';
}

function normalizeAudience(value) {
  const audience = String(value || 'finaltable')
    .trim()
    .toLowerCase();
  return AUDIENCE_RE.test(audience) ? audience : '';
}

function keyIdFor(pem) {
  return crypto.createHash('sha256').update(pem).digest('hex').slice(0, 16);
}

// A PEM must be a P-256 public key, or the verifier would accept nothing and
// the button would be a lie. Returns the KeyObject.
function readPublicKey(pem) {
  let key;
  try {
    key = crypto.createPublicKey(pem);
  } catch (err) {
    throw new Error(`not a readable public key: ${err.message}`);
  }
  const details = key.asymmetricKeyDetails || {};
  if (key.asymmetricKeyType !== 'ec' || details.namedCurve !== 'prime256v1') {
    throw new Error('the key is not a P-256 EC public key');
  }
  return key;
}

// Ask a GameNight for its signing key. Resolves to a pairing record.
async function fetchPairing(rawUrl, rawAudience, { fetchImpl = globalThis.fetch } = {}) {
  const url = normalizeUrl(rawUrl);
  if (!url) throw new Error('Enter the GameNight address as http(s)://host');
  const audience = normalizeAudience(rawAudience);
  if (!audience) throw new Error('The app slug is 2-32 lowercase letters, digits or hyphens');
  if (typeof fetchImpl !== 'function') throw new Error('No HTTP client available');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(`${url}/api/v1/sso`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      redirect: 'follow',
    });
  } catch (err) {
    throw new Error(
      err && err.name === 'AbortError'
        ? 'GameNight did not answer in time'
        : `Could not reach GameNight: ${err && err.message ? err.message : err}`
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`GameNight answered ${res.status} for /api/v1/sso`);
  let body;
  try {
    body = await res.json();
  } catch (_err) {
    throw new Error('GameNight did not answer with JSON; is that the right address?');
  }
  const data = body && body.ok && body.data ? body.data : null;
  const key = data && Array.isArray(data.keys) ? data.keys[0] : null;
  if (!data || !key || typeof key.pem !== 'string' || typeof data.issuer !== 'string') {
    throw new Error('That address is not a GameNight sign-in endpoint');
  }
  if (key.alg && key.alg !== 'ES256') throw new Error(`GameNight offered ${key.alg}, not ES256`);
  const publicKeyPem = key.pem.trim();
  readPublicKey(publicKeyPem);
  const issuer = data.issuer.replace(/\/+$/, '');
  return {
    url,
    audience,
    issuer,
    connectUrl: typeof data.connect_url === 'string' ? data.connect_url : `${issuer}/connect.php`,
    publicKeyPem,
    kid: typeof key.kid === 'string' ? key.kid : keyIdFor(publicKeyPem),
    fetchedAt: Date.now(),
    source: 'gui',
  };
}

// The environment's version of the same record.
function pairingFromEnv(envConfig) {
  if (!envConfig) return null;
  return {
    url: envConfig.issuer,
    audience: envConfig.audience,
    issuer: envConfig.issuer,
    connectUrl: envConfig.connectUrl,
    publicKeyPem: envConfig.publicKeyPem,
    kid: keyIdFor(envConfig.publicKeyPem),
    fetchedAt: null,
    source: 'env',
  };
}

// Everything the socket layer reads, rebuilt whenever the pairing changes.
// `get()` is null when unpaired; otherwise { config, verifier, pairing }.
function createSsoRuntime({ settingsStore, envConfig = null, log = () => {} } = {}) {
  let current = null;

  function build(pairing) {
    const publicKey = readPublicKey(pairing.publicKeyPem);
    const config = {
      issuer: pairing.issuer,
      connectUrl: pairing.connectUrl,
      audience: pairing.audience,
      publicKey,
    };
    return { config, verifier: createGameNightVerifier(config), pairing };
  }

  function apply(pairing, { persist = true } = {}) {
    current = pairing ? build(pairing) : null;
    if (persist && settingsStore) settingsStore.set('gamenight', pairing || null);
    log({
      level: 'info',
      event: pairing ? 'gamenight_paired' : 'gamenight_unpaired',
      message: pairing ? 'Paired with GameNight' : 'GameNight pairing removed',
      data: pairing ? { issuer: pairing.issuer, audience: pairing.audience, kid: pairing.kid } : {},
    });
    return current;
  }

  // Boot: the file wins; the environment seeds the file the first time.
  function init() {
    const saved = settingsStore ? settingsStore.get('gamenight') : null;
    if (saved && saved.publicKeyPem) {
      try {
        current = build(saved);
        return current;
      } catch (err) {
        log({
          level: 'warn',
          event: 'gamenight_pairing_invalid',
          message: 'Saved GameNight pairing could not be loaded',
          data: { error: err.message },
        });
      }
    }
    const seed = pairingFromEnv(envConfig);
    if (seed) return apply(seed, { persist: !!settingsStore });
    current = null;
    return null;
  }

  // What an operator sees. Never the key itself; the id is enough to compare
  // against the GameNight page.
  function status() {
    const p = current ? current.pairing : null;
    return {
      paired: !!p,
      url: p ? p.url : '',
      audience: p ? p.audience : 'finaltable',
      issuer: p ? p.issuer : '',
      connectUrl: p ? p.connectUrl : '',
      kid: p ? p.kid : '',
      fetchedAt: p ? p.fetchedAt : null,
      source: p ? p.source : null,
      envPresent: !!envConfig,
    };
  }

  return {
    get: () => current,
    init,
    async pair(url, audience, opts) {
      return apply(await fetchPairing(url, audience, opts));
    },
    async refresh(opts) {
      if (!current) throw new Error('Not paired with a GameNight');
      const { url, audience } = current.pairing;
      return apply(await fetchPairing(url, audience, opts));
    },
    unpair() {
      return apply(null);
    },
    status,
  };
}

module.exports = {
  createSsoRuntime,
  fetchPairing,
  pairingFromEnv,
  normalizeUrl,
  normalizeAudience,
  keyIdFor,
};

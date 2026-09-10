// __tests__/gamenight-pairing.test.js - pairing with a GameNight at runtime:
// the fetch of its signing key, the settings file, and the precedence between
// what the operator saved and what the environment says.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  createSsoRuntime,
  fetchPairing,
  pairingFromEnv,
  normalizeUrl,
  normalizeAudience,
  keyIdFor,
} = require('../server/gamenight-pairing');
const { createSettingsStore } = require('../server/settings-store');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = publicKey.export({ type: 'spki', format: 'pem' }).trim();

// A stand-in GameNight: only /api/v1/sso, answering whatever the test says.
function issuer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => handler(req, res));
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resolve({ url, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function ssoBody(url, pem = PEM, extra = {}) {
  return JSON.stringify({
    ok: true,
    data: {
      issuer: url,
      connect_url: `${url}/connect.php`,
      keys: [{ kid: keyIdFor(pem), alg: 'ES256', pem, ...extra }],
    },
  });
}

function jsonHandler(body, status = 200) {
  return (req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(typeof body === 'function' ? body(req) : body);
  };
}

describe('normalising what the operator typed', () => {
  test('urls', () => {
    expect(normalizeUrl(' https://gamenight.example/ ')).toBe('https://gamenight.example');
    expect(normalizeUrl('http://192.168.51.35:8080//')).toBe('http://192.168.51.35:8080');
    expect(normalizeUrl('gamenight.example')).toBe('');
    expect(normalizeUrl('ftp://x')).toBe('');
    expect(normalizeUrl('')).toBe('');
  });
  test('audiences', () => {
    expect(normalizeAudience(' FinalTable ')).toBe('finaltable');
    expect(normalizeAudience('')).toBe('finaltable');
    expect(normalizeAudience('a')).toBe('');
    expect(normalizeAudience('has space')).toBe('');
  });
});

describe('fetching the key from GameNight', () => {
  test('a real answer becomes a pairing', async () => {
    const gn = await issuer((req, res) => jsonHandler(ssoBody(gn.url))(req, res));
    try {
      const p = await fetchPairing(`${gn.url}/`, 'finaltable');
      expect(p).toMatchObject({
        url: gn.url,
        issuer: gn.url,
        connectUrl: `${gn.url}/connect.php`,
        audience: 'finaltable',
        publicKeyPem: PEM,
        kid: keyIdFor(PEM),
        source: 'gui',
      });
      expect(typeof p.fetchedAt).toBe('number');
    } finally {
      await gn.close();
    }
  });

  test('the issuer is what GameNight says, not what was typed', async () => {
    const gn = await issuer(jsonHandler(ssoBody('https://gamenight.poker')));
    try {
      const p = await fetchPairing(gn.url, 'finaltable');
      expect(p.issuer).toBe('https://gamenight.poker');
      expect(p.url).toBe(gn.url);
    } finally {
      await gn.close();
    }
  });

  test('a wrong address, a non-JSON page, a wrong shape, a wrong key', async () => {
    const cases = [
      [jsonHandler('<html>not json</html>'), /not answer with JSON/],
      [jsonHandler(JSON.stringify({ ok: true, data: { hello: 1 } })), /not a GameNight/],
      [jsonHandler('{}', 404), /answered 404/],
      [jsonHandler(ssoBody('http://x', 'garbage')), /not a readable public key/],
      [
        jsonHandler(
          ssoBody(
            'http://x',
            crypto
              .generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
              .publicKey.export({ type: 'spki', format: 'pem' })
          )
        ),
        /not a P-256/,
      ],
      [jsonHandler(ssoBody('http://x', PEM, { alg: 'HS256' })), /offered HS256/],
    ];
    for (const [handler, expected] of cases) {
      const gn = await issuer(handler);
      try {
        await expect(fetchPairing(gn.url, 'finaltable')).rejects.toThrow(expected);
      } finally {
        await gn.close();
      }
    }
    await expect(fetchPairing('not a url', 'finaltable')).rejects.toThrow(/http\(s\):\/\/host/);
    await expect(fetchPairing('http://127.0.0.1:1', 'x')).rejects.toThrow(/slug/);
  });

  test('an unreachable host is an error, not a hang', async () => {
    const gn = await issuer(() => {});
    await gn.close();
    await expect(fetchPairing(gn.url, 'finaltable')).rejects.toThrow(/Could not reach/);
  });
});

describe('the runtime: saved pairing, environment seed, live changes', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-pairing-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const envConfig = () => ({
    issuer: 'https://env.example',
    connectUrl: 'https://env.example/connect.php',
    audience: 'finaltable',
    publicKey,
    publicKeyPem: PEM,
  });

  test('nothing saved, nothing in the environment: unpaired', () => {
    const rt = createSsoRuntime({ settingsStore: createSettingsStore({ saveDir: dir }) });
    expect(rt.init()).toBeNull();
    expect(rt.status()).toMatchObject({ paired: false, envPresent: false });
  });

  test('the environment seeds the file once; after that the file wins', () => {
    const store = createSettingsStore({ saveDir: dir });
    const first = createSsoRuntime({ settingsStore: store, envConfig: envConfig() });
    expect(first.init().config.issuer).toBe('https://env.example');
    expect(store.get('gamenight')).toMatchObject({ source: 'env', issuer: 'https://env.example' });

    // The operator changes it in the GUI...
    store.set('gamenight', {
      ...pairingFromEnv(envConfig()),
      issuer: 'https://gui.example',
      source: 'gui',
    });
    // ...and the environment, still set, does not undo that on the next boot.
    const second = createSsoRuntime({ settingsStore: store, envConfig: envConfig() });
    expect(second.init().config.issuer).toBe('https://gui.example');
    expect(second.status().envPresent).toBe(true);
  });

  test('a saved pairing that no longer parses falls back to the environment', () => {
    const store = createSettingsStore({ saveDir: dir });
    store.set('gamenight', { publicKeyPem: 'junk', issuer: 'x', audience: 'a', connectUrl: 'x' });
    const rt = createSsoRuntime({ settingsStore: store, envConfig: envConfig() });
    expect(rt.init().config.issuer).toBe('https://env.example');
  });

  test('pair, refresh and unpair rebuild the verifier and persist', async () => {
    const store = createSettingsStore({ saveDir: dir });
    const rt = createSsoRuntime({ settingsStore: store });
    rt.init();
    let served = PEM;
    const gn = await issuer((req, res) => jsonHandler(ssoBody(gn.url, served))(req, res));
    try {
      await rt.pair(gn.url, 'finaltable');
      expect(rt.status()).toMatchObject({ paired: true, issuer: gn.url, kid: keyIdFor(PEM) });
      expect(store.get('gamenight')).toMatchObject({ issuer: gn.url, source: 'gui' });

      // A token signed by that key verifies through the live verifier.
      const now = Math.floor(Date.now() / 1000);
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const input = `${b64({ alg: 'ES256' })}.${b64({
        iss: gn.url,
        aud: 'finaltable',
        sub: '5',
        iat: now,
        exp: now + 120,
        jti: 'pairing-test-jti-0001',
        name: 'five',
      })}`;
      const sig = crypto.sign('sha256', Buffer.from(input), {
        key: privateKey,
        dsaEncoding: 'ieee-p1363',
      });
      expect(rt.get().verifier.verify(`${input}.${sig.toString('base64url')}`).ok).toBe(true);

      // GameNight rotated: refresh picks the new key up.
      const rotated = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      served = rotated.publicKey.export({ type: 'spki', format: 'pem' }).trim();
      await rt.refresh();
      expect(rt.status().kid).toBe(keyIdFor(served));

      rt.unpair();
      expect(rt.get()).toBeNull();
      expect(store.get('gamenight')).toBeNull();
      await expect(rt.refresh()).rejects.toThrow(/Not paired/);
    } finally {
      await gn.close();
    }
  });
});

describe('settings store', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-settings-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('set, get, and survive a new instance', () => {
    const store = createSettingsStore({ saveDir: dir });
    expect(store.get('gamenight')).toBeNull();
    store.set('gamenight', { issuer: 'x' });
    store.set('other', 1);
    const again = createSettingsStore({ saveDir: dir });
    expect(again.get('gamenight')).toEqual({ issuer: 'x' });
    expect(again.load()).toEqual({ gamenight: { issuer: 'x' }, other: 1 });
    again.set('gamenight', null);
    expect(again.get('gamenight')).toBeNull();
    expect(again.get('other')).toBe(1);
  });

  test('a corrupt file starts empty; no directory is a no-op', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '{nope');
    expect(createSettingsStore({ saveDir: dir }).load()).toEqual({});
    const none = createSettingsStore();
    none.set('x', 1);
    expect(none.get('x')).toBeNull();
  });
});

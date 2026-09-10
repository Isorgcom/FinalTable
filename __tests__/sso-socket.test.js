// __tests__/sso-socket.test.js - the GameNight sign-in over a real socket.
// The server is booted paired with a keypair minted here, and tokens are
// signed the way GameNight signs them.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: Client } = require('socket.io-client');

jest.setTimeout(15000);

const ISSUER = 'http://gamenight.test:8080';
const AUDIENCE = 'finaltable';

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

describe('GameNight sign-in over the socket', () => {
  const originalEnv = { ...process.env };
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sockets = [];
  let baseUrl, serverModule, tempDir;
  let seq = 0;

  function token(overrides = {}, key = privateKey) {
    const now = Math.floor(Date.now() / 1000);
    seq += 1;
    const claims = {
      iss: ISSUER,
      aud: AUDIENCE,
      sub: '42',
      iat: now,
      exp: now + 120,
      jti: `sock-${String(seq).padStart(12, '0')}-abcdef`,
      name: 'bryce',
      tier: 'Free',
      ...overrides,
    };
    const input = `${b64url({ typ: 'JWT', alg: 'ES256' })}.${b64url(claims)}`;
    const sig = crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
    return `${input}.${sig.toString('base64url')}`;
  }

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-sso-'));
    process.env.SAVE_DIR = tempDir;
    process.env.HOST = '127.0.0.1';
    process.env.HTTP_RATE_LIMIT = '1000';
    process.env.GAMENIGHT_URL = `${ISSUER}/`; // trailing slash is trimmed
    // The .env form: one line, "\n" for each break.
    process.env.GAMENIGHT_PUBLIC_KEY = publicKey
      .export({ type: 'spki', format: 'pem' })
      .replace(/\n/g, '\\n');
    process.env.GAMENIGHT_AUDIENCE = AUDIENCE;
    delete process.env.ADMIN_PASSWORD;
    jest.resetModules();
    serverModule = require('../server');
    await serverModule.startServer({ port: 0, host: '127.0.0.1', unrefServer: true });
    baseUrl = `http://127.0.0.1:${serverModule.server.address().port}`;
  });

  afterAll(async () => {
    while (sockets.length) sockets.pop().close();
    serverModule.registry.stop();
    await new Promise((r) => serverModule.io.close(r));
    if (serverModule.server.listening) await new Promise((r) => serverModule.server.close(r));
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  function connect() {
    return new Promise((res) => {
      const s = Client(baseUrl, { forceNew: true, reconnection: false, transports: ['websocket'] });
      sockets.push(s);
      const info = new Promise((r) => s.once('serverInfo', r));
      s.once('connect', () => res({ s, info }));
    });
  }

  function identify(s, payload) {
    return new Promise((res) => {
      const done = (kind) => (data) => {
        s.off('identified');
        s.off('identifyFailed');
        s.off('error');
        res({ kind, data });
      };
      s.once('identified', done('identified'));
      s.once('identifyFailed', done('failed'));
      s.once('error', done('error'));
      s.emit('identify', payload);
    });
  }

  test('serverInfo says where GameNight is, and a signed token becomes an identity', async () => {
    const { s, info } = await connect();
    expect(await info).toEqual({
      version: require('../package.json').version,
      adminAvailable: false,
      gamenight: { connectUrl: `${ISSUER}/connect.php`, audience: AUDIENCE },
    });
    const r = await identify(s, { gnToken: token(), avatar: '🦊' });
    expect(r.kind).toBe('identified');
    expect(r.data).toMatchObject({
      uid: 'gn_42',
      name: 'bryce',
      avatar: '🦊',
      provider: 'gamenight',
    });
    expect(typeof r.data.token).toBe('string');

    // The device token now identifies on its own, with no name and no GameNight.
    const { s: s2 } = await connect();
    const again = await identify(s2, { token: r.data.token, provider: 'gamenight' });
    expect(again.kind).toBe('identified');
    expect(again.data).toMatchObject({ uid: 'gn_42', name: 'bryce', provider: 'gamenight' });
  });

  test('the same GameNight token is good once', async () => {
    const t = token();
    const { s } = await connect();
    expect((await identify(s, { gnToken: t })).kind).toBe('identified');
    const { s: s2 } = await connect();
    expect(await identify(s2, { gnToken: t })).toMatchObject({
      kind: 'failed',
      data: { provider: 'gamenight', reason: 'replayed' },
    });
  });

  test('a token from another key, or for another audience, is refused', async () => {
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const { s } = await connect();
    expect(await identify(s, { gnToken: token({}, other.privateKey) })).toMatchObject({
      kind: 'failed',
      data: { reason: 'signature' },
    });
    expect(await identify(s, { gnToken: token({ aud: 'someone-else' }) })).toMatchObject({
      kind: 'failed',
      data: { reason: 'audience' },
    });
    expect(s.data).toBeUndefined();
  });

  test('a stale linked device token is told so, and no guest is minted', async () => {
    const before = serverModule.identity.size;
    const { s } = await connect();
    const r = await identify(s, { token: 'no-such-token', provider: 'gamenight', name: 'bryce' });
    expect(r).toMatchObject({ kind: 'failed', data: { reason: 'signed_out' } });
    expect(serverModule.identity.size).toBe(before);
  });

  test('a GameNight player is badged on the roster; a guest is not', async () => {
    const { s: host } = await connect();
    await identify(host, { gnToken: token({ sub: '77', name: 'hostess' }) });
    const joined = new Promise((r) => host.once('tournamentJoined', r));
    host.emit('createTournament', { name: 'Badge test', startsAt: Date.now() + 60_000 });
    await joined;
    const state = await new Promise((r) => {
      host.once('tournamentState', r);
      host.emit('requestTournamentState');
    });
    const code = state.code;

    const { s: guest } = await connect();
    await identify(guest, { token: null, name: 'Walkin', avatar: '🙂' });
    const guestJoined = new Promise((r) => guest.once('tournamentJoined', r));
    guest.emit('joinTournament', { code });
    await guestJoined;

    const roster = await new Promise((r) => {
      host.on('tournamentRoster', (p) => {
        if (p.roster.length === 2) r(p.roster);
      });
      host.emit('requestTournamentState');
    });
    const byName = Object.fromEntries(roster.map((row) => [row.name, row.provider]));
    expect(byName).toEqual({ hostess: 'gamenight', Walkin: 'guest' });
  });
});

// __tests__/sso-admin.test.js - pairing with GameNight from the Operator page,
// over the socket: gated on the admin unlock, announced to every socket, and
// kept across a restart.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { io: Client } = require('socket.io-client');

jest.setTimeout(20000);

const PASSWORD = 'operator-secret';
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = publicKey.export({ type: 'spki', format: 'pem' }).trim();

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

let seq = 0;
function tokenFor(iss, sub = '42') {
  const now = Math.floor(Date.now() / 1000);
  seq += 1;
  const claims = {
    iss,
    aud: 'finaltable',
    sub,
    iat: now,
    exp: now + 120,
    jti: `admin-${String(seq).padStart(12, '0')}-abcdef`,
    name: 'bryce',
  };
  const input = `${b64url({ alg: 'ES256' })}.${b64url(claims)}`;
  const sig = crypto.sign('sha256', Buffer.from(input), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${input}.${sig.toString('base64url')}`;
}

describe('pairing with GameNight from the Operator page', () => {
  const originalEnv = { ...process.env };
  const sockets = [];
  let baseUrl, serverModule, tempDir, gn;

  async function boot() {
    jest.resetModules();
    serverModule = require('../server');
    await serverModule.startServer({ port: 0, host: '127.0.0.1', unrefServer: true });
    baseUrl = `http://127.0.0.1:${serverModule.server.address().port}`;
  }

  async function shutdown() {
    while (sockets.length) sockets.pop().close();
    serverModule.registry.stop();
    await new Promise((r) => serverModule.io.close(r));
    if (serverModule.server.listening) await new Promise((r) => serverModule.server.close(r));
  }

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-ssoadmin-'));
    process.env.SAVE_DIR = tempDir;
    process.env.HOST = '127.0.0.1';
    process.env.HTTP_RATE_LIMIT = '1000';
    process.env.ADMIN_PASSWORD = PASSWORD;
    delete process.env.GAMENIGHT_URL;
    delete process.env.GAMENIGHT_PUBLIC_KEY;
    gn = await new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            data: {
              issuer: gn.url,
              connect_url: `${gn.url}/connect.php`,
              keys: [{ kid: 'kid-in-test', alg: 'ES256', pem: PEM }],
            },
          })
        );
      });
      s.listen(0, '127.0.0.1', () =>
        resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => s.close() })
      );
    });
    await boot();
  });

  afterAll(async () => {
    await shutdown();
    gn.close();
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

  function ask(s, event, payload, answer = 'adminGameNight') {
    return new Promise((res) => {
      s.once(answer, res);
      s.emit(event, payload);
    });
  }

  function unlock(s) {
    return ask(s, 'adminLogin', { password: PASSWORD }, 'adminStatus');
  }

  test('without the unlock, the pairing events answer nothing', async () => {
    const { s } = await connect();
    let answered = false;
    s.on('adminGameNight', () => (answered = true));
    s.emit('adminGetGameNight');
    s.emit('adminPairGameNight', { url: gn.url, audience: 'finaltable' });
    s.emit('adminUnpairGameNight');
    await new Promise((r) => setTimeout(r, 300));
    expect(answered).toBe(false);
    expect(serverModule.sso.get()).toBeNull();
  });

  test('an operator pairs, every socket hears it, a token then works, and it persists', async () => {
    const { s: bystander, info: bystanderInfo } = await connect();
    expect((await bystanderInfo).gamenight).toBeNull();
    const heard = new Promise((r) => bystander.once('serverInfo', r));

    const { s } = await connect();
    expect((await unlock(s)).ok).toBe(true);
    expect(await ask(s, 'adminGetGameNight')).toMatchObject({ paired: false, envPresent: false });

    const bad = await ask(s, 'adminPairGameNight', {
      url: 'http://127.0.0.1:1',
      audience: 'finaltable',
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/Could not reach/);
    expect(bad.paired).toBe(false);

    const good = await ask(s, 'adminPairGameNight', { url: gn.url, audience: 'finaltable' });
    expect(good).toMatchObject({ ok: true, paired: true, issuer: gn.url, kid: 'kid-in-test' });
    expect((await heard).gamenight).toEqual({
      connectUrl: `${gn.url}/connect.php`,
      audience: 'finaltable',
    });

    const { s: player } = await connect();
    const ident = await ask(player, 'identify', { gnToken: tokenFor(gn.url) }, 'identified');
    expect(ident).toMatchObject({ uid: 'gn_42', provider: 'gamenight' });

    const saved = JSON.parse(fs.readFileSync(path.join(tempDir, 'settings.json'), 'utf8'));
    expect(saved.settings.gamenight).toMatchObject({ issuer: gn.url, source: 'gui' });
  });

  test('a restart keeps the pairing with no environment at all', async () => {
    await shutdown();
    await boot();
    const { info } = await connect();
    expect((await info).gamenight).toEqual({
      connectUrl: `${gn.url}/connect.php`,
      audience: 'finaltable',
    });
  });

  test('the operator password can be changed, and the change outlives a restart', async () => {
    const { s } = await connect();
    await unlock(s);

    // The current password is asked for again, and a new one has to be worth
    // having. None of these should change anything.
    for (const [payload, expected] of [
      [{ current: 'wrong', next: 'a-good-password' }, /not the current password/i],
      [{ current: PASSWORD, next: 'short' }, /at least 8/i],
      [{ current: PASSWORD, next: PASSWORD }, /already the password/i],
    ]) {
      const r = await ask(s, 'adminSetPassword', payload, 'adminPasswordResult');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(expected);
    }
    expect(serverModule.adminCredential.verify(PASSWORD)).toBe(true);

    // A second operator session, which the change should sign out.
    const { s: other } = await connect();
    expect((await unlock(other)).ok).toBe(true);
    const signedOut = new Promise((r) => other.once('adminStatus', r));

    const done = await ask(
      s,
      'adminSetPassword',
      { current: PASSWORD, next: 'a-longer-password' },
      'adminPasswordResult'
    );
    expect(done).toEqual({ ok: true });
    expect(await signedOut).toMatchObject({ ok: false, available: true, signedOut: true });

    // The old one is dead, the new one works, and nothing was stored in clear.
    const { s: third } = await connect();
    expect((await ask(third, 'adminLogin', { password: PASSWORD }, 'adminStatus')).ok).toBe(false);
    expect(
      (await ask(third, 'adminLogin', { password: 'a-longer-password' }, 'adminStatus')).ok
    ).toBe(true);
    const raw = fs.readFileSync(path.join(tempDir, 'settings.json'), 'utf8');
    expect(raw).not.toContain('a-longer-password');
    expect(JSON.parse(raw).settings.adminPassword).toMatchObject({ algo: 'scrypt' });

    // And it survives the process, with the environment still holding the old one.
    await shutdown();
    await boot();
    const { s: afterRestart } = await connect();
    expect((await ask(afterRestart, 'adminLogin', { password: PASSWORD }, 'adminStatus')).ok).toBe(
      false
    );
    const back = await ask(
      afterRestart,
      'adminLogin',
      { password: 'a-longer-password' },
      'adminStatus'
    );
    expect(back.ok).toBe(true);
    // Put it back, so the rest of the suite has the password it expects.
    expect(
      await ask(
        afterRestart,
        'adminSetPassword',
        { current: 'a-longer-password', next: PASSWORD },
        'adminPasswordResult'
      )
    ).toEqual({ ok: true });
  });

  test('a socket that has not unlocked cannot change the password', async () => {
    const { s } = await connect();
    let answered = false;
    s.on('adminPasswordResult', () => (answered = true));
    s.emit('adminSetPassword', { current: PASSWORD, next: 'sneaky-password' });
    await new Promise((r) => setTimeout(r, 300));
    expect(answered).toBe(false);
    expect(serverModule.adminCredential.verify(PASSWORD)).toBe(true);
  });

  test('refresh answers, and unpair takes the button away for everyone', async () => {
    const { s } = await connect();
    await unlock(s);
    expect(await ask(s, 'adminRefreshGameNight')).toMatchObject({ ok: true, paired: true });

    const { s: other, info } = await connect();
    await info;
    const gone = new Promise((r) => other.once('serverInfo', r));
    expect(await ask(s, 'adminUnpairGameNight')).toMatchObject({ ok: true, paired: false });
    expect((await gone).gamenight).toBeNull();
    expect(serverModule.settingsStore.get('gamenight')).toBeNull();

    const { s: player } = await connect();
    const failed = await ask(player, 'identify', { gnToken: tokenFor(gn.url) }, 'identifyFailed');
    expect(failed.reason).toBe('not_configured');
  });
});

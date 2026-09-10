// Booted with no GameNight pairing: the sign-in surface must not exist, a
// GameNight token must not be a way in, and a half-configured or unreadable
// pairing must stop the boot rather than quietly become "no button".
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: Client } = require('socket.io-client');

jest.setTimeout(15000);

describe('GameNight sign-in when the server is not paired', () => {
  const originalEnv = { ...process.env };
  let baseUrl, serverModule, tempDir;
  const sockets = [];

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-nosso-'));
    process.env.SAVE_DIR = tempDir;
    process.env.HOST = '127.0.0.1';
    delete process.env.GAMENIGHT_URL;
    delete process.env.GAMENIGHT_PUBLIC_KEY;
    delete process.env.GAMENIGHT_AUDIENCE;
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

  test('serverInfo carries no GameNight, and a token is refused without minting anyone', async () => {
    const { s, info } = await connect();
    expect((await info).gamenight).toBeNull();
    const before = serverModule.identity.size;
    const result = await new Promise((res) => {
      s.once('identifyFailed', res);
      s.emit('identify', { gnToken: 'a.b.c', name: 'Somebody' });
    });
    expect(result).toEqual({ provider: 'gamenight', reason: 'not_configured' });
    expect(serverModule.identity.size).toBe(before);
  });

  test('a guest identifies exactly as before', async () => {
    const { s } = await connect();
    const ident = await new Promise((res) => {
      s.once('identified', res);
      s.emit('identify', { token: null, name: 'Nobody', avatar: '🙂' });
    });
    expect(ident).toMatchObject({ name: 'Nobody', provider: 'guest' });
  });
});

describe('a broken GameNight pairing stops the boot', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  function bootWith(env) {
    process.env.SAVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-badsso-'));
    delete process.env.GAMENIGHT_URL;
    delete process.env.GAMENIGHT_PUBLIC_KEY;
    Object.assign(process.env, env);
    jest.resetModules();
    return () => require('../server');
  }

  test('a key that is not a key', () => {
    expect(bootWith({ GAMENIGHT_URL: 'http://x.test', GAMENIGHT_PUBLIC_KEY: 'garbage' })).toThrow(
      /GAMENIGHT_PUBLIC_KEY/
    );
  });

  test('a key on the wrong curve', () => {
    const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    expect(
      bootWith({
        GAMENIGHT_URL: 'http://x.test',
        GAMENIGHT_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
      })
    ).toThrow(/P-256/);
  });

  test('one variable without the other', () => {
    expect(bootWith({ GAMENIGHT_URL: 'http://x.test' })).toThrow(/set together/);
  });
});

// Booted with no ADMIN_PASSWORD: the operator surface must not exist at all,
// rather than existing with a default or an empty password that matches ''.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: Client } = require('socket.io-client');

jest.setTimeout(15000);

describe('admin surface with no password configured', () => {
  const originalEnv = { ...process.env };
  let baseUrl, serverModule, tempDir;
  const sockets = [];

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-noadmin-'));
    process.env.SAVE_DIR = tempDir;
    process.env.HOST = '127.0.0.1';
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
      s.once('connect', () => res(s));
    });
  }

  test('identify says the surface is unavailable, and no password unlocks it', async () => {
    const s = await connect();
    const ident = await new Promise((res) => {
      s.once('identified', res);
      s.emit('identify', { token: null, name: 'Nobody', avatar: '🙂' });
    });
    expect(ident.adminAvailable).toBe(false);

    // The empty string must not be treated as "the password".
    for (const attempt of ['', ' ', 'anything']) {
      const st = await new Promise((res) => {
        s.once('adminStatus', res);
        s.emit('adminLogin', { password: attempt });
      });
      expect(st.ok).toBe(false);
      expect(st.available).toBe(false);
    }
  });
});

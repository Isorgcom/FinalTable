// A server with no way in: no mail to confirm an address with, and no
// GameNight to borrow an account from. It has to say so rather than quietly
// letting anybody play, because letting anybody play is what it used to do.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: Client } = require('socket.io-client');

jest.setTimeout(15000);

describe('a server with no way in', () => {
  const originalEnv = { ...process.env };
  let baseUrl, serverModule, tempDir;
  const sockets = [];

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-noadmin-'));
    process.env.SAVE_DIR = tempDir;
    process.env.HOST = '127.0.0.1';
    delete process.env.ADMIN_PASSWORD;
    delete process.env.PUBLIC_URL;
    delete process.env.SMTP_URL;
    delete process.env.MAIL_TRANSPORT;
    delete process.env.GAMENIGHT_URL;
    delete process.env.GAMENIGHT_PUBLIC_KEY;
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

  // serverInfo is pushed the moment the socket is up, so the listener has to
  // be on before that: a test that attaches one afterwards has already missed
  // it.
  let lastInfo = null;

  function connect() {
    return new Promise((res) => {
      const s = Client(baseUrl, { forceNew: true, reconnection: false, transports: ['websocket'] });
      sockets.push(s);
      s.once('serverInfo', (info) => (lastInfo = info));
      s.once('connect', () => res(s));
    });
  }

  const infoSeen = async () => {
    for (let i = 0; i < 50 && !lastInfo; i++) await new Promise((r) => setTimeout(r, 10));
    return lastInfo;
  };

  test('it offers no way to make an account, and says nothing is paired', async () => {
    await connect();
    const info = await infoSeen();
    // No mail, so no sign-up; no pairing, so no GameNight button. Between
    // them, nobody new can get in at all, and the sign-in screen says so.
    expect(info.accounts).toBe(false);
    expect(info.gamenight).toBeNull();
    // Nobody administers it either, and the first account made would.
    expect(info.unclaimed).toBe(true);
  });

  // The admin surface is an account now, so there is no password to guess and
  // no event to guess it with. A socket that is nobody is answered with
  // silence, which is what it was always answered with.
  test('the admin events answer nobody', async () => {
    const s = await connect();
    let answered = false;
    for (const event of ['adminTournaments', 'adminLogRows', 'adminGameNight', 'adminStatus']) {
      s.on(event, () => (answered = true));
    }
    s.emit('adminListTournaments');
    s.emit('adminLog', {});
    s.emit('adminGetGameNight');
    s.emit('adminLogin', { password: 'anything at all' });
    await new Promise((r) => setTimeout(r, 300));
    expect(answered).toBe(false);
  });

  // An account made here would be the administrator - but none can be made,
  // which is the whole of the problem this server has.
  test('an account cannot be made, so nobody can claim it', async () => {
    const s = await connect();
    let answered = false;
    s.on('accountResult', () => (answered = true));
    s.emit('signUp', { name: 'Hopeful', email: 'a@b.com', password: 'a good password' });
    await new Promise((r) => setTimeout(r, 300));
    expect(answered).toBe(false);
    expect(serverModule.identity.adminCount()).toBe(0);
  });
});

// __tests__/admin-log-socket.test.js - the Log as an admin actually reaches it:
// behind the unlock, over the socket, holding what the server has done.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: Client } = require('socket.io-client');

jest.setTimeout(20000);

const PASSWORD = 'admin-secret';

const { tokenFor } = require('./helpers/account');

describe('the admin log over the socket', () => {
  const originalEnv = { ...process.env };
  const sockets = [];
  let baseUrl, serverModule, tempDir;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-adminlog-'));
    process.env.SAVE_DIR = tempDir;
    process.env.HOST = '127.0.0.1';
    process.env.HTTP_RATE_LIMIT = '1000';
    process.env.ADMIN_PASSWORD = PASSWORD;
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

  function ask(s, event, payload, answer) {
    return new Promise((res) => {
      s.once(answer, res);
      s.emit(event, payload);
    });
  }

  const unlock = (s) => ask(s, 'adminLogin', { password: PASSWORD }, 'adminStatus');
  // An account, then the token it hands back: the only way anybody arrives.
  const identify = (s, name) =>
    ask(s, 'identify', { token: tokenFor(serverModule, name) }, 'identified');
  const readLog = (s, payload = {}) => ask(s, 'adminLog', payload, 'adminLogRows');

  test('a socket that has not unlocked is answered with silence', async () => {
    const s = await connect();
    let answered = false;
    s.on('adminLogRows', () => (answered = true));
    s.emit('adminLog');
    await new Promise((r) => setTimeout(r, 300));
    expect(answered).toBe(false);
  });

  test('the restart this server made is in it', async () => {
    const s = await connect();
    await unlock(s);
    const { rows } = await readLog(s);
    const started = rows.find((r) => r.kind === 'server' && r.event === 'server_started');
    expect(started).toBeTruthy();
    expect(started.message).toBe('Server started');
  });

  test('signing in leaves a row, and never the device token', async () => {
    const player = await connect();
    const ident = await identify(player, 'Logged');
    expect(ident.token).toBeTruthy();

    const s = await connect();
    await unlock(s);
    const { rows } = await readLog(s);
    const row = rows.find((r) => r.kind === 'signin' && r.name === 'Logged');
    expect(row).toBeTruthy();
    expect(row.provider).toBe('local');
    // The token is what the row must never carry: it is the credential itself.
    expect(JSON.stringify(rows)).not.toContain(ident.token);
  });

  // Every ending leaves a row, not only the ones that reached a winner - "where
  // did that game go" is the question an admin is actually asked.
  test('a cancelled game leaves a row saying so', async () => {
    const host = await connect();
    await identify(host, 'Canceller');
    const made = await ask(
      host,
      'createTournament',
      { name: 'Called Off', startsInMinutes: 15 },
      'tournamentJoined'
    );
    expect(made.id).toBeTruthy();
    await new Promise((r) => setTimeout(r, 100));
    host.emit('cancelTournament', { id: made.id });
    await new Promise((r) => setTimeout(r, 300));

    const s = await connect();
    await unlock(s);
    const { rows } = await readLog(s);
    const row = rows.find((r) => r.kind === 'game' && r.name === 'Called Off');
    expect(row).toBeTruthy();
    expect(row.ended).toContain('cancelled');
    // And the way into it is not in a file the browser reads.
    expect(JSON.stringify(rows)).not.toContain(made.code);
  });

  // The reader pages back through older rows while the page follows the newest
  // on a timer. Both arrive on the same event, so the answer has to say which
  // one it is rather than leaving the client to guess by what it asked last.
  test('an answer says which page it is', async () => {
    const s = await connect();
    await unlock(s);
    const first = await readLog(s, { limit: 2 });
    expect(first.before).toBeNull();
    expect(first.rows.length).toBeGreaterThan(0);

    const oldest = first.rows[first.rows.length - 1].id;
    const next = await readLog(s, { limit: 2, before: oldest });
    expect(next.before).toBe(oldest);
    // And it really is the older page, not the same one again.
    expect(next.rows.every((r) => r.id < oldest)).toBe(true);
  });

  test('a page is capped, and a socket asking in a loop is cut off', async () => {
    const s = await connect();
    await unlock(s);
    const page = await readLog(s, { limit: 1000 });
    expect(page.rows.length).toBeLessThanOrEqual(100);

    let answers = 0;
    s.on('adminLogRows', () => answers++);
    for (let i = 0; i < 60; i++) s.emit('adminLog');
    await new Promise((r) => setTimeout(r, 400));
    expect(answers).toBeGreaterThan(0);
    expect(answers).toBeLessThanOrEqual(30);
  });
});

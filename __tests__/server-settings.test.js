// __tests__/server-settings.test.js - the knobs that can be turned without a
// restart, over the socket.
//
// The point of each test is the same: a setting saved on a page has to reach
// the running server, not only the row. A page that says "Saved" over a server
// that carries on exactly as it did is worse than no page.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: Client } = require('socket.io-client');
const { accountFor } = require('./helpers/account');

jest.setTimeout(20000);

describe('the server settings', () => {
  const originalEnv = { ...process.env };
  const sockets = [];
  let baseUrl, serverModule, tempDir;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-srv-'));
    process.env.SAVE_DIR = tempDir;
    process.env.DB_NAME = 'server-settings';
    process.env.HOST = '127.0.0.1';
    process.env.MAX_TOURNAMENTS = '8';
    delete process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_PROMOTE;
    jest.resetModules();
    serverModule = require('../server');
    await serverModule.startServer({ port: 0, host: '127.0.0.1', unrefServer: true });
    baseUrl = `http://127.0.0.1:${serverModule.server.address().port}`;
    accountFor(serverModule, 'TheFirst', { role: 'admin' });
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

  function ask(s, event, payload, answer = 'adminServer') {
    return new Promise((res) => {
      s.once(answer, res);
      s.emit(event, payload);
    });
  }

  let bosses = 0;
  async function admin() {
    const { s } = await connect();
    const who = accountFor(serverModule, `SrvBoss${bosses++}`, { role: 'admin' });
    await ask(s, 'identify', { token: who.token }, 'identified');
    return s;
  }

  test('it says nothing to somebody who is not an administrator', async () => {
    const { s } = await connect();
    await ask(s, 'identify', { token: accountFor(serverModule, 'Bystander').token }, 'identified');
    let answered = false;
    s.on('adminServer', () => (answered = true));
    s.emit('adminGetServer');
    s.emit('adminSetServer', { maxTournaments: 99 });
    await new Promise((r) => setTimeout(r, 250));
    expect(answered).toBe(false);
    expect(serverModule.registry.maxTournaments).toBe(8);
  });

  test('every row says when it takes effect', async () => {
    const s = await admin();
    const answer = await ask(s, 'adminGetServer', {});
    expect(answer.when).toMatchObject({
      maxTournaments: 'now',
      reactionsEnabled: 'now',
      handHistoryTtlMs: 'now',
      handHistoryMaxGames: 'now',
      handPauseMs: 'next game',
      streetPauseMs: 'next game',
    });
  });

  // The one that matters: the running server, not the record.
  test('how many games the server holds is enforced from the next one on', async () => {
    const s = await admin();
    expect(await ask(s, 'adminSetServer', { maxTournaments: 1 })).toMatchObject({ ok: true });
    expect(serverModule.registry.maxTournaments).toBe(1);

    const player = await connect();
    const who = accountFor(serverModule, 'Hopeful');
    await ask(player.s, 'identify', { token: who.token }, 'identified');
    const made = await ask(player.s, 'createTournament', { name: 'One' }, 'tournamentJoined');
    expect(made).toBeTruthy();

    const second = await connect();
    await ask(
      second.s,
      'identify',
      { token: accountFor(serverModule, 'AlsoHopeful').token },
      'identified'
    );
    const refused = await ask(second.s, 'createTournament', { name: 'Two' }, 'error');
    expect(refused.message).toMatch(/Too many/i);

    // Put it back for whatever runs next.
    await ask(s, 'adminSetServer', { maxTournaments: 8 });
  });

  test('turning the reactions off takes the strip away in every browser', async () => {
    const s = await admin();
    const { s: bystander, info } = await connect();
    expect((await info).reactions).not.toBeNull();
    const heard = new Promise((r) => bystander.once('serverInfo', r));

    await ask(s, 'adminSetServer', { reactionsEnabled: false });
    expect((await heard).reactions).toBeNull();
    expect(serverModule.registry.reactionsEnabled).toBe(false);

    await ask(s, 'adminSetServer', { reactionsEnabled: true });
    expect(serverModule.registry.reactions).not.toBeNull();
  });

  test('the bounds on the kept games reach the store that prunes them', async () => {
    const s = await admin();
    await ask(s, 'adminSetServer', { handHistoryMaxGames: 25, handHistoryTtlMs: 60000 });
    expect(serverModule.handHistoryStore.limits).toMatchObject({ maxGames: 25, ttlMs: 60000 });
  });

  test('a value outside what the server will take is brought back inside it', async () => {
    const s = await admin();
    const answer = await ask(s, 'adminSetServer', { maxTournaments: 100000, handPauseMs: -5 });
    expect(answer.maxTournaments).toBe(100);
    expect(answer.handPauseMs).toBe(0);
    await ask(s, 'adminSetServer', { maxTournaments: 8, handPauseMs: 0 });
  });

  test('what was set is what the next boot reads', async () => {
    const s = await admin();
    await ask(s, 'adminSetServer', { maxTournaments: 5 });
    await serverModule.settingsStore.saved();
    expect(serverModule.settingsStore.get('server')).toMatchObject({ maxTournaments: 5 });
    await ask(s, 'adminSetServer', { maxTournaments: 8 });
  });
});

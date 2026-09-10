// __tests__/reactions-socket.test.js - a reaction over a real socket: the set
// arrives with serverInfo, a tap reaches the other seats, a bad one is refused
// on chat's own channel, and a server with the surface off offers nothing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: Client } = require('socket.io-client');
const { REACTIONS } = require('../server/reactions');

jest.setTimeout(20000);

function boot(env) {
  const originalEnv = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-reactions-'));
  process.env.SAVE_DIR = tempDir;
  process.env.HOST = '127.0.0.1';
  process.env.HTTP_RATE_LIMIT = '1000';
  delete process.env.REACTIONS_ENABLED;
  delete process.env.REACTION_RATE;
  Object.assign(process.env, env);
  jest.resetModules();
  const serverModule = require('../server');
  const sockets = [];
  return {
    serverModule,
    sockets,
    async start() {
      await serverModule.startServer({ port: 0, host: '127.0.0.1', unrefServer: true });
      this.baseUrl = `http://127.0.0.1:${serverModule.server.address().port}`;
    },
    connect() {
      return new Promise((res) => {
        const s = Client(this.baseUrl, {
          forceNew: true,
          reconnection: false,
          transports: ['websocket'],
        });
        sockets.push(s);
        const info = new Promise((r) => s.once('serverInfo', r));
        s.once('connect', () => res({ s, info }));
      });
    },
    ask(s, event, payload, answer) {
      return new Promise((res) => {
        s.once(answer, res);
        s.emit(event, payload);
      });
    },
    async stop() {
      while (sockets.length) sockets.pop().close();
      serverModule.registry.stop();
      await new Promise((r) => serverModule.io.close(r));
      if (serverModule.server.listening) await new Promise((r) => serverModule.server.close(r));
      fs.rmSync(tempDir, { recursive: true, force: true });
      process.env = originalEnv;
    },
  };
}

// Two people registered for a tournament that has not started: the waiting
// room is one chat room, so a reaction from either reaches both.
async function twoInAWaitingRoom(h) {
  const { s: host } = await h.connect();
  await h.ask(host, 'identify', { token: null, name: 'Host', avatar: '🙂' }, 'identified');
  const joined = new Promise((r) => host.once('tournamentJoined', r));
  host.emit('createTournament', { name: 'Reacts', startsAt: Date.now() + 60000 });
  await joined;
  const state = await h.ask(host, 'requestTournamentState', {}, 'tournamentState');
  const { s: guest } = await h.connect();
  await h.ask(guest, 'identify', { token: null, name: 'Guest', avatar: '🙂' }, 'identified');
  const guestJoined = new Promise((r) => guest.once('tournamentJoined', r));
  guest.emit('joinTournament', { code: state.code });
  await guestJoined;
  return { host, guest };
}

describe('reactions over the socket', () => {
  let h;
  beforeAll(async () => {
    h = boot({ REACTION_RATE: '2' });
    await h.start();
  });
  afterAll(() => h.stop());

  test('serverInfo carries the set', async () => {
    const { info } = await h.connect();
    expect((await info).reactions).toEqual(REACTIONS);
  });

  test('a tap reaches the other seat, and the sender, with the real name', async () => {
    const { host, guest } = await twoInAWaitingRoom(h);
    const seenByGuest = new Promise((r) => guest.once('reaction', r));
    const seenByHost = new Promise((r) => host.once('reaction', r));
    host.emit('reaction', { emoji: REACTIONS[0] });
    const got = await seenByGuest;
    expect(got).toMatchObject({ name: 'Host', emoji: REACTIONS[0] });
    expect(typeof got.uid).toBe('string');
    expect((await seenByHost).emoji).toBe(REACTIONS[0]);
  });

  test('a bad one, and one too many, come back on chatDenied', async () => {
    const { host } = await twoInAWaitingRoom(h);
    const bad = await h.ask(host, 'reaction', { emoji: '👍' }, 'chatDenied');
    expect(bad.reason).toMatch(/not one of/i);
    // REACTION_RATE=2 for this server.
    host.emit('reaction', { emoji: REACTIONS[1] });
    host.emit('reaction', { emoji: REACTIONS[1] });
    const limited = await h.ask(host, 'reaction', { emoji: REACTIONS[1] }, 'chatDenied');
    expect(limited.reason).toMatch(/slow down/i);
  });

  test('a socket in no tournament is ignored, not answered', async () => {
    const { s } = await h.connect();
    await h.ask(s, 'identify', { token: null, name: 'Nobody', avatar: '🙂' }, 'identified');
    let answered = false;
    s.on('chatDenied', () => (answered = true));
    s.on('reaction', () => (answered = true));
    s.emit('reaction', { emoji: REACTIONS[0] });
    await new Promise((r) => setTimeout(r, 300));
    expect(answered).toBe(false);
  });
});

describe('reactions switched off', () => {
  let h;
  beforeAll(async () => {
    h = boot({ REACTIONS_ENABLED: 'false' });
    await h.start();
  });
  afterAll(() => h.stop());

  test('serverInfo offers nothing, and the event does nothing', async () => {
    const { host, guest } = await twoInAWaitingRoom(h);
    const { info } = await h.connect();
    expect((await info).reactions).toBeNull();
    let heard = false;
    guest.on('reaction', () => (heard = true));
    host.on('chatDenied', () => (heard = true));
    host.emit('reaction', { emoji: REACTIONS[0] });
    await new Promise((r) => setTimeout(r, 300));
    expect(heard).toBe(false);
  });
});

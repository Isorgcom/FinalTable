// __tests__/tournament-socket.test.js - the multi-table tournament socket layer
// end to end, through real sockets. Same boot recipe as socket-integration.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: Client } = require('socket.io-client');

jest.setTimeout(15000);

describe('Tournament socket layer', () => {
  const originalEnv = { ...process.env };
  const clients = [];
  let baseUrl;
  let serverModule;
  let tempDir;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finaltable-tsock-'));
    process.env.SAVE_DIR = tempDir;
    process.env.HTTP_RATE_LIMIT = '1000';
    process.env.HOST = '127.0.0.1';
    process.env.TOURNAMENT_FINISHED_TTL_MS = '200';
    process.env.TOURNAMENT_ABANDON_GRACE_MS = '400';
    process.env.TOURNAMENT_SWEEP_MS = '40';
    process.env.HOST_TRANSFER_GRACE_MS = '300';
    process.env.NPC_DELAY_MIN = '5';
    process.env.NPC_DELAY_MAX = '10';
    jest.resetModules();
    serverModule = require('../server');
    await serverModule.startServer({
      port: 0,
      host: '127.0.0.1',
      unrefServer: true,
    });
    baseUrl = `http://127.0.0.1:${serverModule.server.address().port}`;
  });

  afterEach(async () => {
    while (clients.length) {
      const socket = clients.pop();
      if (!socket) continue;
      socket.removeAllListeners();
      socket.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  });

  afterAll(async () => {
    serverModule.registry.stop();
    await new Promise((resolve) => serverModule.io.close(resolve));
    if (typeof serverModule.server.closeAllConnections === 'function') {
      serverModule.server.closeAllConnections();
    }
    if (serverModule.server.listening) {
      await new Promise((resolve) => serverModule.server.close(resolve));
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  function connectClient() {
    return new Promise((resolve, reject) => {
      const socket = Client(baseUrl, {
        forceNew: true,
        reconnection: false,
        transports: ['websocket'],
      });
      clients.push(socket);
      const timer = setTimeout(() => reject(new Error('Socket connect timeout')), 2000);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  // Generous: this suite runs beside the engine suites under load.
  function waitFor(socket, eventName, predicate = () => true, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${eventName}`));
      }, timeoutMs);
      const handler = (payload) => {
        if (!predicate(payload)) return;
        cleanup();
        resolve(payload);
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.off(eventName, handler);
      };
      socket.on(eventName, handler);
    });
  }

  function identify(socket, { token = null, name = 'Host', avatar = '🦊' } = {}) {
    const reply = waitFor(socket, 'identified');
    socket.emit('identify', { token, name, avatar });
    return reply;
  }

  async function joinByCode(socket, code, { name, avatar = '🐸' }) {
    if (!socket.__identity) socket.__identity = await identify(socket, { name, avatar });
    const joined = waitFor(socket, 'tournamentJoined');
    socket.emit('joinTournament', { code });
    return joined;
  }

  async function createTournament(socket, payload = {}) {
    const { playerName = 'Host', playerAvatar = '🦊', ...rest } = payload;
    if (!socket.__identity) {
      socket.__identity = await identify(socket, { name: playerName, avatar: playerAvatar });
    }
    const joined = waitFor(socket, 'tournamentJoined');
    // A start an hour away: without one the registry starts as soon as two
    // entrants exist, and the bots count. Tests that want a start say so.
    socket.emit('createTournament', {
      name: 'Test Night',
      tableSize: 6,
      botCount: 2,
      startChips: 1000,
      levelDuration: 600,
      startsAt: Date.now() + 60 * 60 * 1000,
      ...rest,
    });
    return joined;
  }

  async function until(check, timeoutMs = 4000, everyMs = 25) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) return true;
      await new Promise((resolve) => setTimeout(resolve, everyMs));
    }
    return check();
  }

  test('seated players carry their avatar, the host, and the tournament clock', async () => {
    const host = await connectClient();
    const joined = await createTournament(host, { playerAvatar: '🐸', botCount: 1 });
    const state = waitFor(host, 'gameState', (s) => s.isRunning);
    host.emit('startTournament');
    const seen = await state;
    const me = seen.players.find((p) => !p.isNPC);
    expect(me.avatar).toBe('🐸');
    expect(me.uid).toBe(joined.uid);
    expect(seen.gameMode).toBe('tournament');
    expect(seen.hostId).toBe(joined.uid);
    expect(seen.hostName).toBe('Host');
    expect(seen.turnDurationMs === null || seen.turnDurationMs <= 25000).toBe(true);
  });

  test('a finished tournament leaves the list after its TTL', async () => {
    const host = await connectClient();
    const joined = await createTournament(host);
    const entry = serverModule.tournaments.get(joined.id);
    expect(entry).toBeTruthy();
    const gone = waitFor(host, 'tournamentList', (list) => !list.some((t) => t.id === joined.id));
    entry.director._finish(null);
    expect(serverModule.tournaments.has(joined.id)).toBe(true); // standings linger
    await gone;
    expect(serverModule.tournaments.has(joined.id)).toBe(false);
  });

  test('a running tournament survives a dropped connection for the grace period, then goes', async () => {
    const host = await connectClient();
    const joined = await createTournament(host, { botCount: 1 });
    const running = waitFor(host, 'gameState', (st) => st.isRunning);
    host.emit('startTournament');
    await running;
    expect(serverModule.tournaments.has(joined.id)).toBe(true);
    const entry = serverModule.tournaments.get(joined.id);
    // No new hands: a heads-up between two automated seats could finish and
    // expire inside the grace window, which is not what this test is about.
    entry.director.holdField();
    host.close();
    // The server notices the drop...
    expect(await until(() => entry.registrations.get(joined.uid).socketId === null)).toBe(true);
    // ...keeps the tournament through the grace...
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(serverModule.tournaments.has(joined.id)).toBe(true);
    // ...and tears it down once the grace has passed.
    expect(await until(() => !serverModule.tournaments.has(joined.id))).toBe(true);
  });

  test('creating needs an identity, and the token is not the uid', async () => {
    const anon = await connectClient();
    const refused = waitFor(anon, 'error', (e) => /Identify first/.test(e.message));
    anon.emit('createTournament', { name: 'Nope' });
    await refused;

    const me = await identify(anon, { name: 'Ann', avatar: '🐸' });
    expect(me.uid).toMatch(/^u_/);
    expect(me.token).not.toBe(me.uid);
    expect(me.resume).toBeNull();
    const again = await identify(anon, { token: me.token, name: 'Ann' });
    expect(again.uid).toBe(me.uid);
    expect(again.isNew).toBe(false);
  });

  test('a fresh socket with the same token rejoins the seat and the table follows', async () => {
    const first = await connectClient();
    const joined = await createTournament(first, { botCount: 1 });
    const token = first.__identity.token;
    const running = waitFor(first, 'gameState', (s) => s.isRunning);
    first.emit('startTournament');
    await running;
    const entry = serverModule.tournaments.get(joined.id);
    const seatBefore = entry.director.playerByUid(joined.uid);
    expect(seatBefore.player.id).toBe(first.id);

    first.close();
    await new Promise((resolve) => setTimeout(resolve, 60));

    const second = await connectClient();
    const rejoined = waitFor(second, 'tournamentJoined');
    const state = waitFor(second, 'gameState');
    const ident = await identify(second, { token, name: 'Host' });
    expect(ident.uid).toBe(joined.uid);
    expect(ident.resume).toMatchObject({ id: joined.id, status: 'running' });
    const info = await rejoined;
    expect(info.resumed).toBe(true);
    expect(info.you.playerId).toBe(second.id);
    const seatAfter = entry.director.playerByUid(joined.uid);
    expect(seatAfter.player.id).toBe(second.id);
    expect(seatAfter.player.isConnected).toBe(true);
    const seen = await state;
    expect(seen.players.some((p) => p.id === second.id && !p.isNPC)).toBe(true);
    expect(serverModule.tournaments.has(joined.id)).toBe(true);
  });

  test('one live registration per identity', async () => {
    const host = await connectClient();
    await createTournament(host);
    const refused = waitFor(host, 'error', (e) => /already in a tournament/.test(e.message));
    host.emit('createTournament', { name: 'Second' });
    await refused;
  });

  test('two humans register by code and both see the roster with avatars', async () => {
    const host = await connectClient();
    const created = await createTournament(host, { botCount: 2 });
    expect(created.code).toMatch(/^[A-Z2-9]{5}$/);
    const guest = await connectClient();
    const hostSees = waitFor(host, 'tournamentState', (st) =>
      st.roster.some((r) => r.name === 'Guest')
    );
    const joined = await joinByCode(guest, created.code.toLowerCase(), {
      name: 'Guest',
      avatar: '🐸',
    });
    expect(joined.host).toBe(false);
    expect(joined.status).toBe('registering');
    const state = await hostSees;
    const humans = state.roster.filter((r) => !r.isNPC);
    expect(humans).toHaveLength(2);
    expect(humans.find((r) => r.name === 'Host')).toMatchObject({
      avatar: '🦊',
      isHost: true,
      connected: true,
    });
    expect(humans.find((r) => r.name === 'Guest')).toMatchObject({
      avatar: '🐸',
      isHost: false,
      connected: true,
    });
    expect(state.roster.filter((r) => r.isNPC)).toHaveLength(2);
    expect(state.entrants).toBe(4);
    expect(state.isHost).toBe(true);
    const list = await (await fetch(`${baseUrl}/api/tournaments`)).json();
    expect(list.find((t) => t.id === created.id)).toMatchObject({
      code: created.code,
      status: 'registering',
      hostName: 'Host',
      entrants: { humans: 2, bots: 2, total: 4 },
    });
  });

  test('a duplicate name is refused', async () => {
    const host = await connectClient();
    const created = await createTournament(host);
    const twin = await connectClient();
    twin.__identity = await identify(twin, { name: 'host', avatar: '🐸' });
    const refused = waitFor(twin, 'error', (e) => /Name already taken/.test(e.message));
    twin.emit('joinTournament', { code: created.code });
    await refused;
  });

  test('a scheduled start deals to everyone when the time arrives', async () => {
    const host = await connectClient();
    const created = await createTournament(host, { botCount: 1, startsAt: Date.now() + 250 });
    const guest = await connectClient();
    await joinByCode(guest, created.code, { name: 'Guest2' });
    const hostDealt = waitFor(host, 'gameState', (st) => st.isRunning, 5000);
    const guestDealt = waitFor(guest, 'gameState', (st) => st.isRunning, 5000);
    const [a, b] = await Promise.all([hostDealt, guestDealt]);
    expect(a.gameMode).toBe('tournament');
    expect(b.players.some((p) => p.name === 'Guest2')).toBe(true);
    const state = await waitFor(host, 'tournamentState', (st) => st.status === 'running');
    expect(state.startedAt).toBeGreaterThan(0);
  });

  test('a late entrant is seated with the starting stack after the start', async () => {
    const host = await connectClient();
    const created = await createTournament(host, { botCount: 2, lateRegLevels: 3 });
    const running = waitFor(host, 'gameState', (st) => st.isRunning);
    host.emit('startTournament');
    await running;
    const late = await connectClient();
    const joined = await joinByCode(late, created.code, { name: 'Late' });
    expect(joined.status).toBe('running');
    const state = await waitFor(late, 'tournamentState', (st) => st.you && st.you.seated);
    expect(state.you.seated).toBe(true);
    expect(state.lateRegOpen).toBe(true);
    const entry = serverModule.tournaments.get(created.id);
    const seat = entry.director.playerByUid(late.__identity.uid);
    expect(seat.player.chips).toBe(1000);
    expect(seat.player.id).toBe(late.id);
    expect(entry.director.entrants).toHaveLength(4);
    expect(() => entry.director.assertChipConservation()).not.toThrow();
  });

  test('unregistering before the start leaves the roster', async () => {
    const host = await connectClient();
    const created = await createTournament(host);
    const guest = await connectClient();
    await joinByCode(guest, created.code, { name: 'Leaver' });
    const gone = waitFor(
      host,
      'tournamentState',
      (st) => !st.roster.some((r) => r.name === 'Leaver')
    );
    const left = waitFor(guest, 'leftTournament');
    guest.emit('unregisterTournament');
    expect(await left).toMatchObject({ id: created.id, reason: 'unregistered' });
    await gone;
    expect(
      serverModule.tournaments.get(created.id).director.entrants.some((e) => e.name === 'Leaver')
    ).toBe(false);
  });

  test('leaving a running tournament keeps the seat under auto-play', async () => {
    const host = await connectClient();
    const created = await createTournament(host, { botCount: 2 });
    const running = waitFor(host, 'gameState', (st) => st.isRunning);
    host.emit('startTournament');
    await running;
    const left = waitFor(host, 'leftTournament');
    host.emit('exitGame');
    expect(await left).toMatchObject({ id: created.id, reason: 'left' });
    const entry = serverModule.tournaments.get(created.id);
    const seat = entry.director.playerByUid(host.__identity.uid);
    expect(seat).toBeTruthy();
    expect(seat.player.autoPlay).toBe(true);
    expect(entry.registrations.get(host.__identity.uid).left).toBe(true);
  });
});

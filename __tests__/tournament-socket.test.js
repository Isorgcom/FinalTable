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
    process.env.PREFLOP_TABLE = 'off';
    process.env.SAVE_DIR = tempDir;
    process.env.HTTP_RATE_LIMIT = '1000';
    process.env.HOST = '127.0.0.1';
    process.env.TOURNAMENT_FINISHED_TTL_MS = '200';
    process.env.TOURNAMENT_ABANDON_GRACE_MS = '400';
    process.env.NPC_DELAY_MIN = '5';
    process.env.NPC_DELAY_MAX = '10';
    jest.resetModules();
    serverModule = require('../server');
    await serverModule.startServer({
      port: 0,
      host: '127.0.0.1',
      buildPreflop: false,
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
    for (const entry of serverModule.tournaments.values()) {
      if (entry.timer) clearInterval(entry.timer);
      if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
      if (entry.abandonTimer) clearTimeout(entry.abandonTimer);
      entry.director.stop();
    }
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

  function waitFor(socket, eventName, predicate = () => true, timeoutMs = 3000) {
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

  async function createTournament(socket, payload = {}) {
    const { playerName = 'Host', playerAvatar = '🦊', ...rest } = payload;
    if (!socket.__identity) {
      socket.__identity = await identify(socket, { name: playerName, avatar: playerAvatar });
    }
    const joined = waitFor(socket, 'tournamentJoined');
    socket.emit('createTournament', {
      name: 'Test Night',
      tableSize: 6,
      botCount: 2,
      startChips: 1000,
      levelDuration: 600,
      ...rest,
    });
    return joined;
  }

  test('a tournament socket cannot fall into a room, even one named mtt', async () => {
    const host = await connectClient();
    await createTournament(host);
    const refused = waitFor(host, 'error', (e) => /Leave the tournament/.test(e.message));
    host.emit('joinRoom', {
      roomId: 'mtt',
      playerName: 'Host',
      npcCount: 0,
      smallBlind: 10,
      startChips: 1000,
      playerAvatar: '🦊',
      gameMode: 'cash',
    });
    await refused;
    expect(serverModule.games.has('mtt')).toBe(false);
  });

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

  test('a tournament survives a dropped connection for the grace period, then goes', async () => {
    const host = await connectClient();
    const joined = await createTournament(host);
    expect(serverModule.tournaments.has(joined.id)).toBe(true);
    host.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(serverModule.tournaments.has(joined.id)).toBe(true); // within the grace
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(serverModule.tournaments.has(joined.id)).toBe(false); // grace expired
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
});

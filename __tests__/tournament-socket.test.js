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
    process.env.AUTO_TURN_DELAY_MS = '5';
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
    // A start an hour away: without one the registry deals as soon as a second
    // entrant registers. Tests that want a start say so.
    socket.emit('createTournament', {
      name: 'Test Night',
      tableSize: 6,
      startChips: 1000,
      levelDuration: 600,
      startsAt: Date.now() + 60 * 60 * 1000,
      ...rest,
    });
    return joined;
  }

  // A field of one never starts, so every test that needs a dealt table needs
  // a second person. Bots used to be that second entrant; a second socket is
  // now. The caller owns both sockets.
  async function createTournamentWithGuest(host, payload = {}) {
    const { guestName = 'Guest', guestAvatar = '🐸', ...rest } = payload;
    const created = await createTournament(host, rest);
    const guest = await connectClient();
    await joinByCode(guest, created.code, { name: guestName, avatar: guestAvatar });
    return { created, guest };
  }

  async function startAndDeal(host, guest) {
    const hostDealt = waitFor(host, 'gameState', (st) => st.isRunning, 5000);
    const guestDealt = waitFor(guest, 'gameState', (st) => st.isRunning, 5000);
    host.emit('startTournament');
    return Promise.all([hostDealt, guestDealt]);
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
    const { created, guest } = await createTournamentWithGuest(host, { playerAvatar: '🐸' });
    const [seen] = await startAndDeal(host, guest);
    const me = seen.players.find((p) => p.uid === created.uid);
    expect(me.avatar).toBe('🐸');
    expect(me.uid).toBe(created.uid);
    expect(seen.gameMode).toBe('tournament');
    expect(seen.hostId).toBe(created.uid);
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
    const { created: joined, guest } = await createTournamentWithGuest(host);
    await startAndDeal(host, guest);
    expect(serverModule.tournaments.has(joined.id)).toBe(true);
    const entry = serverModule.tournaments.get(joined.id);
    // No new hands: a heads-up between two sit-out seats could finish and
    // expire inside the grace window, which is not what this test is about.
    entry.director.holdField();
    host.close();
    guest.close();
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
    const { created: joined, guest } = await createTournamentWithGuest(first);
    const token = first.__identity.token;
    await startAndDeal(first, guest);
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
    // The drop sat the seat out; being back at the keyboard undoes it.
    expect(seatAfter.player.autoPlay).toBe(false);
    expect(seatAfter.player.sitOutReason).toBeNull();
    const seen = await state;
    expect(seen.players.some((p) => p.id === second.id)).toBe(true);
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
    const created = await createTournament(host);
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
    const humans = state.roster;
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
    expect(state.entrants).toBe(2);
    expect(state.isHost).toBe(true);
    const list = await (await fetch(`${baseUrl}/api/tournaments`)).json();
    expect(list.find((t) => t.id === created.id)).toMatchObject({
      code: created.code,
      status: 'registering',
      hostName: 'Host',
      entrants: { humans: 2, total: 2 },
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
    const created = await createTournament(host, { startsAt: Date.now() + 250 });
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
    const { created, guest } = await createTournamentWithGuest(host, { lateRegLevels: 3 });
    await startAndDeal(host, guest);
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
    expect(entry.director.entrants).toHaveLength(3);
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
    const { created, guest } = await createTournamentWithGuest(host);
    await startAndDeal(host, guest);
    const left = waitFor(host, 'leftTournament');
    host.emit('exitGame');
    expect(await left).toMatchObject({ id: created.id, reason: 'left' });
    const entry = serverModule.tournaments.get(created.id);
    const seat = entry.director.playerByUid(host.__identity.uid);
    expect(seat).toBeTruthy();
    expect(seat.player.autoPlay).toBe(true);
    expect(entry.registrations.get(host.__identity.uid).left).toBe(true);
  });

  test('a player who left is offered a way back and returns in control', async () => {
    const host = await connectClient();
    const { created, guest } = await createTournamentWithGuest(host);
    await startAndDeal(host, guest);
    const uid = host.__identity.uid;

    const left = waitFor(host, 'leftTournament');
    host.emit('exitGame');
    await left;

    // The lobby has to know this tournament is still theirs, or it offers a
    // late-registration button that closes at level 3 and then nothing at all.
    const listed = await waitFor(
      host,
      'tournamentList',
      (rows) => !!rows.find((t) => t.id === created.id)
    );
    const mine = listed.find((t) => t.id === created.id);
    expect(mine.you.left).toBe(true);

    const rejoined = waitFor(host, 'tournamentJoined');
    host.emit('joinTournament', { code: created.code });
    const info = await rejoined;
    expect(info.resumed).toBe(true);
    expect(info.you.playerId).toBe(host.id);

    const entry = serverModule.tournaments.get(created.id);
    const seat = entry.director.playerByUid(uid);
    expect(seat.player.id).toBe(host.id);
    expect(seat.player.isConnected).toBe(true);
    // Coming back deliberately means taking the seat back, not watching it
    // fold your stack away.
    expect(seat.player.autoPlay).toBe(false);
    expect(entry.registrations.get(uid).left).toBe(false);
  });

  // ── Pre-actions over the wire ──────────────────────────────────────────────

  // Finds the seat whose turn it is not, which is the only seat allowed to arm.
  function offTurnSeat(entry, uidA, uidB) {
    const a = entry.director.playerByUid(uidA);
    const table = a.table;
    const current = table.players[table.currentPlayerIndex];
    const waitingUid = current.uid === uidA ? uidB : uidA;
    return { table, seat: entry.director.playerByUid(waitingUid), waitingUid };
  }

  test('an armed line is played the moment the turn opens', async () => {
    const host = await connectClient();
    const { created, guest } = await createTournamentWithGuest(host);
    await startAndDeal(host, guest);
    const entry = serverModule.tournaments.get(created.id);
    const guestUid = guest.__identity.uid;

    const { table, seat, waitingUid } = offTurnSeat(entry, created.uid, guestUid);
    const waitingSocket = waitingUid === created.uid ? host : guest;

    waitingSocket.emit('armPreAction', { kind: 'checkfold' });
    expect(await until(() => !!seat.player.preAction)).toBe(true);

    // A raise, not a call: heads-up preflop a call closes the street, and a new
    // street clears every arm before the waiting seat ever has a turn. A raise
    // reopens the action and hands them one.
    const actor = table.players[table.currentPlayerIndex];
    table.handleAction(actor.id, 'raise', table.currentBet + table.minRaise);

    // Nobody clicked for the waiting seat, and it acted anyway.
    expect(await until(() => !!seat.player.lastAction)).toBe(true);
    expect(['check', 'fold']).toContain(seat.player.lastAction.action);
    expect(seat.player.preAction).toBeNull();
  });

  test('an armed line survives a reconnect and still fires', async () => {
    const first = await connectClient();
    const { created, guest } = await createTournamentWithGuest(first);
    const token = first.__identity.token;
    await startAndDeal(first, guest);
    const entry = serverModule.tournaments.get(created.id);

    // The host must be the seat that is waiting, so it can arm and then drop.
    const table = entry.director.playerByUid(created.uid).table;
    if (table.players[table.currentPlayerIndex].uid === created.uid) {
      table.handleAction(table.players[table.currentPlayerIndex].id, 'call');
    }
    expect(await until(() => table.players[table.currentPlayerIndex].uid !== created.uid)).toBe(
      true
    );

    first.emit('armPreAction', { kind: 'callany' });
    const seat = entry.director.playerByUid(created.uid);
    expect(await until(() => !!seat.player.preAction)).toBe(true);

    // Drop and come back on a new socket with the same token. The seat is
    // rebuilt around a new socket id, which is why the fire path matches on uid.
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = await connectClient();
    const rejoined = waitFor(second, 'tournamentJoined');
    await identify(second, { token, name: 'Host' });
    await rejoined;

    const seatAfter = entry.director.playerByUid(created.uid);
    expect(seatAfter.player.preAction).toMatchObject({ kind: 'callany' });
  });

  test('an armed line is never in another player’s state', async () => {
    const host = await connectClient();
    const { created, guest } = await createTournamentWithGuest(host);
    await startAndDeal(host, guest);
    const entry = serverModule.tournaments.get(created.id);
    const guestUid = guest.__identity.uid;
    const { seat, waitingUid } = offTurnSeat(entry, created.uid, guestUid);
    const waitingSocket = waitingUid === created.uid ? host : guest;
    const otherSocket = waitingSocket === host ? guest : host;

    waitingSocket.emit('armPreAction', { kind: 'callany' });
    expect(await until(() => !!seat.player.preAction)).toBe(true);

    // An idle table pushes nothing, so make it push: the other seat acts, which
    // emits to everyone, and that is the payload under inspection.
    const theirState = waitFor(otherSocket, 'gameState', (st) => st.isRunning);
    const actor = entry.director.playerByUid(created.uid).table;
    actor.handleAction(actor.players[actor.currentPlayerIndex].id, 'call');
    const theirs = await theirState;
    expect(theirs.myPreAction).toBeNull();
    expect(JSON.stringify(theirs.players)).not.toContain('preAction');
    expect(JSON.stringify(theirs.players)).not.toContain('sitOutNextHand');
  });

  test('a malformed arm is ignored', async () => {
    const host = await connectClient();
    const { created, guest } = await createTournamentWithGuest(host);
    await startAndDeal(host, guest);
    const entry = serverModule.tournaments.get(created.id);
    const guestUid = guest.__identity.uid;
    const { seat, waitingUid } = offTurnSeat(entry, created.uid, guestUid);
    const waitingSocket = waitingUid === created.uid ? host : guest;

    for (const bad of [
      { kind: 'raise' },
      { kind: 'allin' },
      { kind: 'call' },
      { kind: 'call', atBet: '20', atToCall: 20 },
      { kind: 'call', atBet: -1, atToCall: 0 },
      { kind: 'call', atBet: 20.5, atToCall: 10 },
    ]) {
      waitingSocket.emit('armPreAction', bad);
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(seat.player.preAction).toBeNull();

    // And a well-formed one still lands, so the guard is not simply refusing.
    waitingSocket.emit('armPreAction', { kind: 'checkfold' });
    expect(await until(() => !!seat.player.preAction)).toBe(true);
  });

  test('sitting out now clears a line armed for later', async () => {
    const host = await connectClient();
    const { created, guest } = await createTournamentWithGuest(host);
    await startAndDeal(host, guest);
    const entry = serverModule.tournaments.get(created.id);
    const guestUid = guest.__identity.uid;
    const { seat, waitingUid } = offTurnSeat(entry, created.uid, guestUid);
    const waitingSocket = waitingUid === created.uid ? host : guest;

    waitingSocket.emit('armPreAction', { kind: 'callany' });
    expect(await until(() => !!seat.player.preAction)).toBe(true);

    waitingSocket.emit('setSitOutNextHand', { enabled: true });
    expect(await until(() => seat.player.sitOutNextHand === true)).toBe(true);

    waitingSocket.emit('setAutoPlay', { enabled: true });
    expect(await until(() => seat.player.autoPlay === true)).toBe(true);
    expect(seat.player.preAction).toBeNull();
    expect(seat.player.sitOutNextHand).toBe(false);
  });

  // ── Hand history on the wire ───────────────────────────────────────────────

  test('the hand history rides one push per hand, not every push', async () => {
    const host = await connectClient();
    const { created, guest } = await createTournamentWithGuest(host);

    const pushes = [];
    host.on('gameState', (st) => {
      if (st && st.isRunning) pushes.push('recentHands' in st);
    });

    await startAndDeal(host, guest);
    // Both seats sit out so the table plays itself and produces a real stream
    // of pushes across several hands, which is the shape this is about.
    host.emit('setAutoPlay', { enabled: true });
    guest.emit('setAutoPlay', { enabled: true });

    const entry = serverModule.tournaments.get(created.id);
    // Four pushes is enough to show the difference and is reachable well
    // inside the budget: this suite runs the real street and hand pauses, so
    // a hand takes seconds, and asking for a lot of them is how a timing test
    // turns into a flaky one.
    await until(() => pushes.length >= 4 && pushes.filter(Boolean).length > 0, 20000);
    entry.director.holdField();

    const withHistory = pushes.filter(Boolean).length;
    // A client has to receive it somehow, so some pushes carry it. The point
    // is that it is no longer every push.
    expect(pushes.length).toBeGreaterThanOrEqual(4);
    expect(withHistory).toBeGreaterThan(0);
    expect(withHistory).toBeLessThan(pushes.length);
  });

  test('a client that arrives mid-tournament is sent the history', async () => {
    const first = await connectClient();
    const { created, guest } = await createTournamentWithGuest(first);
    const token = first.__identity.token;
    await startAndDeal(first, guest);

    first.close();
    await new Promise((r) => setTimeout(r, 60));

    // A fresh socket has nothing cached, so its first state must carry the
    // history whether or not a hand has ended since the last push.
    const second = await connectClient();
    const rejoined = waitFor(second, 'tournamentJoined');
    // The very first state this socket is sent, whatever the table happens to
    // be doing. Waiting for a running one instead lets an earlier
    // between-hands push go by, and that push is the one carrying the history.
    const state = waitFor(second, 'gameState');
    await identify(second, { token, name: 'Host' });
    await rejoined;
    const seen = await state;
    expect('recentHands' in seen).toBe(true);
    expect(Array.isArray(seen.recentHands)).toBe(true);
  });
});

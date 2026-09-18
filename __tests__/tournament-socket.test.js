// __tests__/tournament-socket.test.js - the multi-table tournament socket layer
// end to end, through real sockets. Same boot recipe as socket-integration.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: Client } = require('socket.io-client');

jest.setTimeout(15000);

const { accountFor } = require('./helpers/account');

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
    process.env.TOURNAMENT_ZOMBIE_HOLD_MS = '400';
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
    // And the games they left standing. A name is one person now, so the Host
    // of one test is the Host of the next - and a person can only be in one
    // game at a time. Tests used to be isolated by accident, because every
    // guest called Host was a different guest.
    for (const entry of [...serverModule.tournaments.values()]) {
      serverModule.registry.forceCancel(entry, 'the test finished');
    }
    // And every device they signed in on, for the same reason: the accounts
    // outlive the test now, so without this the second test to ask for Ann
    // would find her signed in on the first test's browser as well.
    for (const row of serverModule.identity.list({ limit: 50 }).rows) {
      serverModule.identity.revokeAll(row.uid);
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

  // The games list over HTTP, which wants the same credential the socket does.
  // A reader of its own, so it never collides with whoever the test is playing
  // as.
  async function publicList() {
    const answer = await fetch(`${baseUrl}/api/tournaments`, {
      headers: { authorization: `Bearer ${accountFor(serverModule, 'ApiReader').token}` },
    });
    return answer.json();
  }

  // A name is not an identity any more: somebody with an account signs in, and
  // the browser identifies with the device token that came back. accountFor
  // does the first half against the server's own stores - the same calls the
  // Users page and the signIn handler make - so a test that wants a player
  // still asks for one by name.
  function identify(socket, { token = null, name = 'Host', avatar = '🦊', role = null } = {}) {
    const reply = waitFor(socket, 'identified');
    socket.emit('identify', {
      token: token || accountFor(serverModule, name, { avatar, role }).token,
      avatar,
    });
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

  // A game still registering when its people disconnect is kept for them,
  // not swept, and the server caps how many exist at once. A test that leaves
  // one behind before the start takes it down on the way out.
  async function cancelGame(host) {
    const gone = waitFor(host, 'tournamentCancelled');
    host.emit('cancelTournament');
    await gone;
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

  test('a dropped connection holds the table, and only a long hold ends it', async () => {
    const host = await connectClient();
    const { created: joined, guest } = await createTournamentWithGuest(host);
    await startAndDeal(host, guest);
    expect(serverModule.tournaments.has(joined.id)).toBe(true);
    const entry = serverModule.tournaments.get(joined.id);
    // No new hands: a heads-up between two sit-out seats could finish and
    // expire inside the window, which is not what this test is about.
    entry.director.holdField();
    host.close();
    guest.close();
    // The server notices the drop...
    expect(await until(() => entry.registrations.get(joined.uid).socketId === null)).toBe(true);
    // ...holds the field rather than counting down to a teardown...
    expect(await until(() => entry.director.isHeldForAbsence())).toBe(true);
    expect(serverModule.tournaments.has(joined.id)).toBe(true);
    // ...and writes it off only once the hold has stood with nobody back.
    expect(await until(() => !serverModule.tournaments.has(joined.id))).toBe(true);
  });

  test('serverInfo names the asset version the page was served with', async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    const meta = /name="finaltable-asset-version" content="([0-9a-f]{10})"/.exec(html);
    expect(meta).not.toBeNull();
    // Listening from before the connect: serverInfo is the first thing sent.
    const socket = Client(baseUrl, {
      forceNew: true,
      reconnection: false,
      transports: ['websocket'],
    });
    clients.push(socket);
    const info = await waitFor(socket, 'serverInfo');
    expect(info.assetVersion).toBe(meta[1]);
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

  // The point of keeping these on the server: the same person on a second
  // device gets the settings they chose, not the ones that browser last saw.
  test('a preference saved on one device is there on the next', async () => {
    const phone = await connectClient();
    const me = await identify(phone, { name: 'Ann', avatar: '🐸' });
    expect(me.prefs).toEqual({});

    const chosen = { muted: true, seat: 4, panelTab: 'stats', cardBack: 'blue' };
    const kept = waitFor(phone, 'preferences');
    phone.emit('savePreferences', chosen);
    expect(await kept).toEqual(chosen);

    // A different socket, the same token: the iPad. It is dealt the blue deck
    // without anybody choosing it twice.
    const ipad = await connectClient();
    const there = await identify(ipad, { token: me.token, name: 'Ann' });
    expect(there.uid).toBe(me.uid);
    expect(there.prefs).toEqual(chosen);

    // One setting at a time, and the rest stay where they were.
    const moved = waitFor(ipad, 'preferences');
    ipad.emit('savePreferences', { seat: 0 });
    expect(await moved).toEqual({ ...chosen, seat: 0 });
  });

  test('a preference is refused without an identity, and anything unknown is dropped', async () => {
    const anon = await connectClient();
    // Nothing comes back, because nothing was stored against anybody.
    anon.emit('savePreferences', { muted: true });
    const me = await identify(anon, { name: 'Bee' });

    const kept = waitFor(anon, 'preferences');
    anon.emit('savePreferences', { muted: true, colour: 'green', seat: 99 });
    expect(await kept).toEqual({ muted: true });
    expect(me.prefs).toEqual({});
  });

  // A client asking the server to write a file that holds every identity it
  // has ever seen, in a loop.
  test('a socket hammering preferences is cut off, and recovers', async () => {
    const spammer = await connectClient();
    await identify(spammer, { name: 'Cee' });
    let answers = 0;
    spammer.on('preferences', () => {
      answers++;
    });
    for (let i = 0; i < 40; i++) spammer.emit('savePreferences', { seat: i % 8 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(answers).toBeGreaterThan(0);
    expect(answers).toBeLessThanOrEqual(12);
  });

  // The devices an account is signed in on, and signing one out from another.
  test('the sessions list names each device, and one signs another out', async () => {
    const phone = await connectClient();
    const me = await identify(phone, { name: 'Ann' });
    const ipad = await connectClient();
    await identify(ipad, { token: me.token, name: 'Ann' });

    // Two sockets, one device: the token is what a device is, not the socket.
    const listed = waitFor(phone, 'sessions');
    phone.emit('listSessions');
    const rows = await listed;
    expect(rows).toHaveLength(1);
    expect(rows[0].current).toBe(true);
    expect(rows[0].id).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(rows)).not.toContain(me.token);

    // A second device, which is a second token - and the same person, because
    // signing in as Ann is signing in as Ann wherever you do it.
    const laptop = await connectClient();
    const other = await identify(laptop, { name: 'Ann' });
    expect(other.uid).toBe(me.uid);
    expect(other.token).not.toBe(me.token);
    const both = waitFor(laptop, 'sessions');
    laptop.emit('listSessions');
    const two = await both;
    expect(two).toHaveLength(2);
    expect(two.filter((r) => r.current)).toHaveLength(1);
  });

  test('signing a device out reaches every tab it had open', async () => {
    const first = await connectClient();
    const me = await identify(first, { name: 'Bee' });
    // The same device in two tabs: one token, two sockets.
    const second = await connectClient();
    await identify(second, { token: me.token, name: 'Bee' });

    const other = await connectClient();
    const theirs = await identify(other, { name: 'Cee' });

    const listed = waitFor(other, 'sessions');
    other.emit('listSessions');
    const theirRows = await listed;

    // Somebody else's id is not a way into this account: the list comes back
    // unchanged, and their device is still signed in.
    const refused = waitFor(first, 'sessions');
    first.emit('endSession', { id: theirRows[0].id });
    const mine = await refused;
    expect(mine[0].current).toBe(true);
    const theirsAgain = waitFor(other, 'sessions');
    other.emit('listSessions');
    expect(await theirsAgain).toHaveLength(1);

    // Their own device, and both of its tabs are told.
    const endedFirst = waitFor(first, 'sessionEnded');
    const endedSecond = waitFor(second, 'sessionEnded');
    first.emit('endSession', { id: mine[0].id });
    expect(await endedFirst).toMatchObject({ mine: true });
    expect(await endedSecond).toMatchObject({ mine: false });
    // And the token is no good to anybody afterwards. It used to make them
    // somebody new, because a name was an identity; now it makes them nobody,
    // and the browser is shown the way back in.
    const stale = await connectClient();
    const refusedToken = waitFor(stale, 'identifyFailed');
    stale.emit('identify', { token: me.token });
    expect(await refusedToken).toMatchObject({ reason: 'no-account' });
    expect(theirs.uid).toBeTruthy();
  });

  test('signing out ends the session here rather than only in the browser', async () => {
    const socket = await connectClient();
    const me = await identify(socket, { name: 'Dee' });
    socket.emit('signOut');
    // The next socket presenting that token is nobody, and is told so.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = await connectClient();
    const failed = waitFor(after, 'identifyFailed');
    after.emit('identify', { token: me.token });
    expect(await failed).toMatchObject({ provider: 'local', reason: 'no-account' });
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
    // Public, because the end of this test reads the game off /api/tournaments.
    const created = await createTournament(host, { visibility: 'public' });
    expect(created.code).toMatch(/^[A-Z2-9]{5}$/);
    const guest = await connectClient();
    // The roster is broadcast on its own now, not carried in every personal
    // state push, so that is where it is waited for.
    const hostSees = waitFor(host, 'tournamentRoster', (p) =>
      p.roster.some((r) => r.name === 'Guest')
    );
    // Both halves of the push are waited for before the join that triggers
    // them; registering afterwards races the emit and loses.
    const hostState = waitFor(host, 'tournamentState', (st) => st.entrants === 2);
    const joined = await joinByCode(guest, created.code.toLowerCase(), {
      name: 'Guest',
      avatar: '🐸',
    });
    expect(joined.host).toBe(false);
    expect(joined.status).toBe('registering');
    const humans = (await hostSees).roster;
    // The personal half of the push still carries everything that is per viewer.
    const state = await hostState;
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
    const list = await publicList();
    const card = list.find((t) => t.id === created.id);
    expect(card).toMatchObject({
      status: 'registering',
      hostName: 'Host',
      entrants: { humans: 2, total: 2 },
    });
    // The list is public and the code is the way in, so it stays off the card.
    expect(card).not.toHaveProperty('code');
  });

  // Two people at one table with one name used to be possible and had to be
  // refused at the door. It is not possible any more: a name is one person on
  // this server, so the refusal moved to the only place a second claim can be
  // made, which is making an account.
  test('a name somebody already has cannot be claimed by anybody else', async () => {
    const host = await connectClient();
    const me = await identify(host, { name: 'Twinned' });

    // The same name in any letters is the same name.
    expect(serverModule.accounts.ownerOf('TWINNED')).toBe(me.uid);
    expect(
      serverModule.accounts.createVerified({ name: 'twinned', email: 'twin@example.com' }).error
    ).toMatch(/taken/);
    expect(serverModule.identity.nameHolder('twinned', 'u_somebody-else')).toBe(true);
    // And it is still their own name, not something they are locked out of.
    expect(serverModule.identity.nameHolder('twinned', me.uid)).toBe(false);
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

  test('a private game is off the public list and refuses an id, but a code gets in', async () => {
    const host = await connectClient();
    const created = await createTournament(host, { name: 'Quiet night' });
    const list = await publicList();
    expect(list.find((t) => t.id === created.id)).toBeUndefined();
    const guest = await connectClient();
    await identify(guest, { name: 'Guest', avatar: '🐸' });
    const refused = waitFor(guest, 'error');
    guest.emit('joinTournament', { tournamentId: created.id });
    expect((await refused).message).toBe('Tournament not found');
    const joined = waitFor(guest, 'tournamentJoined');
    guest.emit('joinTournament', { code: created.code });
    expect((await joined).id).toBe(created.id);
    await cancelGame(host);
  });

  test('an invite-only game: knock, the host lets you in, and you are seated like anyone', async () => {
    const host = await connectClient();
    const created = await createTournament(host, { visibility: 'invite' });
    const guest = await connectClient();
    await identify(guest, { name: 'Guest', avatar: '🐸' });

    const knocked = waitFor(guest, 'tournamentPending');
    const hostSees = waitFor(
      host,
      'tournamentState',
      (st) => st.pending && st.pending.length === 1
    );
    guest.emit('joinTournament', { code: created.code });
    const pending = await knocked;
    expect(pending).toMatchObject({ id: created.id, hostName: 'Host' });
    expect(pending).not.toHaveProperty('code');
    const hostState = await hostSees;
    expect(hostState.pending[0]).toMatchObject({ name: 'Guest', avatar: '🐸', connected: true });

    const admitted = waitFor(guest, 'tournamentJoined');
    // The host's state push (door now empty) lands before the roster does,
    // so both listeners go on before the admit.
    const cleared = waitFor(host, 'tournamentState', (st) => st.pending && st.pending.length === 0);
    const roster = waitFor(host, 'tournamentRoster', (p) => p.roster.length === 2);
    host.emit('admitPlayer', { uid: hostState.pending[0].uid });
    expect((await admitted).id).toBe(created.id);
    expect((await roster).roster.map((r) => r.name).sort()).toEqual(['Guest', 'Host']);
    expect((await cleared).pending).toEqual([]);
    await cancelGame(host);
  });

  test('an invite-only game: turned away, and giving up', async () => {
    const host = await connectClient();
    const created = await createTournament(host, { visibility: 'invite' });
    const a = await connectClient();
    await identify(a, { name: 'Ann', avatar: '🐸' });
    const b = await connectClient();
    await identify(b, { name: 'Bob', avatar: '🐸' });
    const both = waitFor(host, 'tournamentState', (st) => st.pending && st.pending.length === 2);
    a.emit('joinTournament', { code: created.code });
    b.emit('joinTournament', { code: created.code });
    const state = await both;
    const annUid = state.pending.find((r) => r.name === 'Ann').uid;

    const declined = waitFor(a, 'tournamentDeclined');
    host.emit('declinePlayer', { uid: annUid });
    expect(await declined).toMatchObject({ id: created.id, reason: 'declined' });

    const left = waitFor(b, 'leftTournament');
    b.emit('cancelRequest');
    expect(await left).toMatchObject({ id: created.id, reason: 'withdrawn' });
    const empty = await waitFor(
      host,
      'tournamentState',
      (st) => st.pending && st.pending.length === 0
    );
    expect(empty.pending).toEqual([]);
    await cancelGame(host);
  });

  test('a late knock on a running invite-only game is seated with the starting stack', async () => {
    const host = await connectClient();
    const created = await createTournament(host, { visibility: 'invite', lateRegLevels: 3 });
    const guest = await connectClient();
    await identify(guest, { name: 'Guest', avatar: '🐸' });
    const hostSees = waitFor(
      host,
      'tournamentState',
      (st) => st.pending && st.pending.length === 1
    );
    guest.emit('joinTournament', { code: created.code });
    const { pending } = await hostSees;
    const guestIn = waitFor(guest, 'tournamentJoined');
    host.emit('admitPlayer', { uid: pending[0].uid });
    await guestIn;
    await startAndDeal(host, guest);

    const late = await connectClient();
    await identify(late, { name: 'Late', avatar: '🐸' });
    const knock = waitFor(host, 'tournamentState', (st) => st.pending && st.pending.length === 1);
    late.emit('joinTournament', { code: created.code });
    const withLate = await knock;
    const seated = waitFor(late, 'tournamentState', (st) => st.you && st.you.seated);
    host.emit('admitPlayer', { uid: withLate.pending[0].uid });
    const state = await seated;
    expect(state.lateRegOpen).toBe(true);
    expect(state.you.seated).toBe(true);
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
      'tournamentRoster',
      (p) => !p.roster.some((r) => r.name === 'Leaver')
    );
    const left = waitFor(guest, 'leftTournament');
    guest.emit('unregisterTournament');
    expect(await left).toMatchObject({ id: created.id, reason: 'unregistered' });
    await gone;
    expect(
      serverModule.tournaments.get(created.id).director.entrants.some((e) => e.name === 'Leaver')
    ).toBe(false);
  });

  // The leaderboard the table draws is the field's, and it rides the roster
  // rather than a broadcast of its own: the roster already goes out once for
  // everybody instead of once per recipient.
  test('the roster carries what each player has played', async () => {
    const host = await connectClient();
    const created = await createTournament(host);
    const guest = await connectClient();
    const seen = waitFor(host, 'tournamentRoster', (p) => p.roster.length === 2);
    await joinByCode(guest, created.code, { name: 'Second' });
    const { roster } = await seen;
    for (const row of roster) {
      expect(row).toMatchObject({ hands: 0, won: 0, biggestPot: 0 });
    }
    await cancelGame(host);
  });

  // The hands a player can take away. Everything in it is what they could
  // already see; the redaction itself is tested against the bytes elsewhere.
  test('a player takes their own hands away, and a stranger takes nothing', async () => {
    const host = await connectClient();
    const { created, guest } = await createTournamentWithGuest(host);
    await startAndDeal(host, guest);

    // Heads-up, so one fold finishes the hand. Both send it and the server
    // listens to whichever of them is to act.
    const entry = serverModule.tournaments.get(created.id);
    host.emit('action', { action: 'fold' });
    guest.emit('action', { action: 'fold' });
    await until(() => entry.director.history.length > 0);

    const got = waitFor(host, 'handHistoryExport');
    host.emit('exportHandHistory');
    const mine = await got;
    expect(mine.id).toBe(created.id);
    expect(mine.hands.length).toBeGreaterThan(0);
    const hand = mine.hands[0];
    // Their seat is named, their own two cards are there, and the blinds the
    // hand was dealt with came with it.
    expect(hand.you).toHaveLength(1);
    expect(hand.holeCards[hand.you[0]]).toHaveLength(2);
    expect(hand.smallBlind).toBeGreaterThan(0);
    expect(hand.tableNumber).toBe(1);
    // Never anybody's identifier.
    const raw = JSON.stringify(mine);
    expect(raw).not.toContain(guest.__identity.uid);
    expect(raw).not.toContain(host.__identity.uid);

    // Somebody not in it gets an answer with nothing in it, not somebody
    // else's game.
    const stranger = await connectClient();
    await identify(stranger, { name: 'Stranger', avatar: '🐸' });
    const nothing = waitFor(stranger, 'handHistoryExport');
    stranger.emit('exportHandHistory');
    expect((await nothing).hands).toEqual([]);

    // And a socket that never said who it was is answered with silence, like
    // everything else keyed to an identity.
    const anon = await connectClient();
    let answered = false;
    anon.on('handHistoryExport', () => (answered = true));
    anon.emit('exportHandHistory');
    await new Promise((r) => setTimeout(r, 300));
    expect(answered).toBe(false);

    host.emit('cancelTournament');
    await waitFor(host, 'tournamentCancelled');
  });

  // A game is reaped ten minutes after its winner. Its hands are not: the
  // whole point of writing them down is that somebody still has them the next
  // morning.
  test('a game that is over is still yours to take away', async () => {
    const host = await connectClient();
    const { created, guest } = await createTournamentWithGuest(host);
    await startAndDeal(host, guest);
    const entry = serverModule.tournaments.get(created.id);
    host.emit('action', { action: 'fold' });
    guest.emit('action', { action: 'fold' });
    await until(() => entry.director.history.length > 0);

    // The game goes.
    host.emit('cancelTournament');
    await waitFor(host, 'tournamentCancelled');
    expect(serverModule.tournaments.get(created.id)).toBeUndefined();

    // The hands do not.
    const listed = waitFor(host, 'myGames');
    host.emit('listMyGames');
    const { games } = await listed;
    const row = games.find((g) => g.id === created.id);
    expect(row).toBeTruthy();
    expect(row.hands).toBeGreaterThan(0);
    // A list of games, not of who else was in them.
    expect(JSON.stringify(games)).not.toContain(guest.__identity.uid);

    const got = waitFor(host, 'handHistoryExport');
    host.emit('exportHandHistory', { id: created.id });
    const kept = await got;
    expect(kept.id).toBe(created.id);
    expect(kept.hands.length).toBeGreaterThan(0);
    expect(kept.hands[0].you).toHaveLength(1);
    expect(JSON.stringify(kept)).not.toContain(host.__identity.uid);

    // And somebody who was not in it is refused rather than redacted down to
    // nothing: the two are different answers and only one of them is honest.
    const stranger = await connectClient();
    await identify(stranger, { name: 'Outsider', avatar: '🐸' });
    const refused = waitFor(stranger, 'handHistoryExport');
    stranger.emit('exportHandHistory', { id: created.id });
    expect((await refused).hands).toEqual([]);
    const theirs = waitFor(stranger, 'myGames');
    stranger.emit('listMyGames');
    expect((await theirs).games).toEqual([]);
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

  // ── Admin controls ──────────────────────────────────────────────────────

  test('a tournament can be cancelled by an admin once it is running', async () => {
    const host = await connectClient();
    const { created, guest } = await createTournamentWithGuest(host);
    await startAndDeal(host, guest);
    expect(serverModule.tournaments.get(created.id).status).toBe('running');

    // The host of this game is also the administrator of the server, which is
    // one account rather than a password anybody could type.
    serverModule.identity.setRole(host.__identity.uid, 'admin');
    const again = await identify(host, { token: host.__identity.token });
    expect(again.isAdmin).toBe(true);

    const cancelled = waitFor(guest, 'tournamentCancelled');
    host.emit('adminCancelTournament');
    const notice = await cancelled;
    expect(notice.id).toBe(created.id);
    expect(await until(() => !serverModule.tournaments.has(created.id))).toBe(true);
  });

  test('the admin list holds every game with its code, and nobody else gets it', async () => {
    const hostA = await connectClient();
    const quiet = await createTournament(hostA, { name: 'Quiet' });
    const hostB = await connectClient();
    const door = await createTournament(hostB, {
      name: 'Door',
      playerName: 'HostB',
      visibility: 'invite',
    });
    const knocker = await connectClient();
    await identify(knocker, { name: 'Knocker', avatar: '🐸' });
    const knocked = waitFor(knocker, 'tournamentPending');
    knocker.emit('joinTournament', { code: door.code });
    await knocked;

    // Not unlocked: silence, not an error.
    const op = await connectClient();
    let answered = false;
    op.on('adminTournaments', () => (answered = true));
    op.on('error', () => (answered = true));
    op.emit('adminListTournaments');
    await new Promise((r) => setTimeout(r, 300));
    expect(answered).toBe(false);

    const unlocked = identify(op, { name: 'Operator', role: 'admin' });
    await unlocked;
    const listed = waitFor(op, 'adminTournaments');
    op.emit('adminListTournaments');
    const { list } = await listed;
    expect(list.find((t) => t.id === quiet.id)).toMatchObject({
      code: quiet.code,
      visibility: 'private',
      connected: 1,
      pending: 0,
    });
    expect(list.find((t) => t.id === door.id)).toMatchObject({
      code: door.code,
      visibility: 'invite',
      connected: 1,
      pending: 1,
    });
    // Still nowhere public.
    const pub = await publicList();
    expect(pub.find((t) => t.id === quiet.id || t.id === door.id)).toBeUndefined();

    // Ending one from the list, by id.
    const gone = waitFor(hostA, 'tournamentCancelled');
    op.emit('adminCancelTournament', { id: quiet.id });
    expect((await gone).id).toBe(quiet.id);
    const again = waitFor(op, 'adminTournaments');
    op.emit('adminListTournaments');
    expect((await again).list.find((t) => t.id === quiet.id)).toBeUndefined();
    await cancelGame(hostB);
  });

  // "running" is not an answer to "is this game alive". The row says what the
  // field is actually doing, so an admin does not have to open a table to find
  // out - which is what it used to take.
  test('a running game says on the admin list what it is doing', async () => {
    const host = await connectClient();
    const { created, guest } = await createTournamentWithGuest(host);

    const op = await connectClient();
    const unlocked = identify(op, { name: 'Operator', role: 'admin' });
    await unlocked;

    // Before the start there is nothing to say, and the row does not invent it.
    const before = waitFor(op, 'adminTournaments');
    op.emit('adminListTournaments');
    expect((await before).list.find((t) => t.id === created.id)).toMatchObject({
      status: 'registering',
      activity: null,
      lastHandAt: null,
      hands: 0,
      tableRows: [],
    });

    await startAndDeal(host, guest);
    const after = waitFor(op, 'adminTournaments');
    op.emit('adminListTournaments');
    const running = (await after).list.find((t) => t.id === created.id);
    expect(running.status).toBe('running');
    expect(['dealing', 'idle']).toContain(running.activity);
    expect(running.hands).toBeGreaterThanOrEqual(1);
    // The field's shape, which is the other half of the question.
    expect(running.tableRows).toEqual([{ n: 1, players: 2, running: true, broken: false }]);

    const gone = waitFor(host, 'tournamentCancelled');
    op.emit('adminCancelTournament', { id: created.id });
    await gone;
  });

  test('cancelling is refused to a socket that never logged in', async () => {
    const host = await connectClient();
    const { created, guest } = await createTournamentWithGuest(host);
    await startAndDeal(host, guest);

    // The guest simply asks, having offered no password at all.
    guest.emit('adminCancelTournament');
    guest.emit('adminCancelTournament', { id: created.id });
    await new Promise((r) => setTimeout(r, 250));
    expect(serverModule.tournaments.has(created.id)).toBe(true);
    expect(serverModule.tournaments.get(created.id).status).toBe('running');
  });

  // Somebody who does not run the server is told so, and is told nothing else
  // about who does.
  test('the identify reply says whether you are an administrator, and nothing more', async () => {
    const socket = await connectClient();
    const ident = await identify(socket, { name: 'Nosy' });
    expect(ident.isAdmin).toBe(false);

    const boss = await connectClient();
    expect((await identify(boss, { name: 'Boss', role: 'admin' })).isAdmin).toBe(true);
    // And an ordinary player asking again is still told no.
    expect((await identify(socket, { token: ident.token })).isAdmin).toBe(false);
  });

  // The whole of the guard, and the reason it is worth one line in every
  // handler: the surface is a fact about the account, so nothing a socket can
  // send changes it.
  test('a socket that is not an administrator is answered with silence', async () => {
    const socket = await connectClient();
    await identify(socket, { name: 'Ordinary' });
    let answered = false;
    for (const event of ['adminTournaments', 'adminLogRows', 'adminGameNight']) {
      socket.on(event, () => (answered = true));
    }
    socket.emit('adminListTournaments');
    socket.emit('adminLog', {});
    socket.emit('adminGetGameNight');
    await new Promise((r) => setTimeout(r, 250));
    expect(answered).toBe(false);
  });

  test('a custom structure goes up with the create and comes back in the full state', async () => {
    const host = await connectClient();
    const created = await createTournament(host, {
      structure: {
        name: 'Mine',
        levels: [
          { sb: 25, bb: 50, ante: 0, duration: 60 },
          { break: true, duration: 90 },
          { sb: 50, bb: 100, ante: 100, duration: 60 },
        ],
      },
    });
    expect(created.code).toMatch(/^[A-Z2-9]{5}$/);
    // The full state follows the join at once, before a listener could be
    // set; asking for it again is the same payload without the race.
    const state = waitFor(host, 'tournamentState', (st) => !!st.structure);
    host.emit('requestTournamentState');
    const full = await state;
    expect(full.structure.name).toBe('Mine');
    expect(full.structure.levels).toHaveLength(3);
    expect(full.structure.levels[1]).toEqual({ sb: 0, bb: 0, ante: 0, duration: 90, break: true });
    expect(full.settings.structure).toEqual({
      name: 'Mine',
      levelCount: 2,
      anteFrom: 2,
      breaks: [1],
    });
  });

  test('the host pauses and resumes, and only the host', async () => {
    const host = await connectClient();
    const { guest } = await createTournamentWithGuest(host, { startsAt: Date.now() + 60000 });
    await startAndDeal(host, guest);

    const refused = waitFor(guest, 'error', (e) => /Only the host/.test(e.message));
    guest.emit('pauseTournament');
    expect((await refused).message).toBe('Only the host can do that');

    const paused = waitFor(host, 'tournamentState', (st) => st.paused === true);
    host.emit('pauseTournament');
    expect((await paused).paused).toBe(true);
    const line = waitFor(guest, 'gameMessage', (m) => m === 'Paused by the host');
    await line;

    const resumed = waitFor(host, 'tournamentState', (st) => st.paused === false);
    host.emit('resumeTournament');
    expect((await resumed).paused).toBe(false);
    await cancelGame(host);
  });

  test('the host removes the guest, who is sent to the lobby and cannot come back', async () => {
    const host = await connectClient();
    const { created, guest } = await createTournamentWithGuest(host, {
      startsAt: Date.now() + 60000,
    });
    await startAndDeal(host, guest);
    // A hand is in play, so the seat goes at its end; the guest is told at
    // once and is out of the game from that moment.
    const gone = waitFor(guest, 'leftTournament', (p) => p.reason === 'removed');
    host.emit('removePlayer', { uid: guest.__identity.uid });
    expect(await gone).toMatchObject({ id: created.id, reason: 'removed' });
    const entry = serverModule.registry.tournaments.get(created.id);
    expect(entry.registrations.has(guest.__identity.uid)).toBe(false);
    expect(entry.removedUids.has(guest.__identity.uid)).toBe(true);

    const refused = waitFor(guest, 'error', (e) => /removed/.test(e.message));
    guest.emit('joinTournament', { code: created.code });
    expect((await refused).message).toBe('You were removed from this game');
  });

  test('the guest forfeits from the lobby: the seat goes, the rail stays, and the card is out', async () => {
    const host = await connectClient();
    const { created, guest } = await createTournamentWithGuest(host, {
      startsAt: Date.now() + 60000,
    });
    await startAndDeal(host, guest);
    const uid = guest.__identity.uid;
    const entry = serverModule.registry.tournaments.get(created.id);

    // Out to the lobby first, the way somebody does who is not coming back.
    // The stack stays at the table, and that is the thing being given up.
    const left = waitFor(guest, 'leftTournament', (p) => p.reason === 'left');
    guest.emit('leaveTournament');
    await left;
    expect(entry.director.playerByUid(uid)).not.toBeNull();

    // No socket is bound to the game any more, so the card names it. A hand
    // is in play, so the answer is "at the end of this one".
    const acked = waitFor(guest, 'tournamentForfeited');
    const over = waitFor(host, 'tournamentFinished', () => true, 8000);
    guest.emit('forfeitTournament', { tournamentId: created.id });
    // A hand is in play, so the seat goes at its end rather than under it.
    expect(await acked).toEqual({ queued: true, place: null });
    expect(entry.forfeitedUids.has(uid)).toBe(true);
    // Not thrown out: the registration is still theirs, so the rail is open.
    expect(entry.registrations.has(uid)).toBe(true);

    // Play the hand out from the server so the wait does not depend on whose
    // turn it happened to be, then the queued seat goes at its end.
    const table = entry.director.tables[0];
    entry.director.holdField();
    expect(
      await until(() => {
        if (!table.isRunning) return true;
        const cur = table.players[table.currentPlayerIndex];
        if (cur && !table.handleAction(cur.id, 'fold')) table.handleAction(cur.id, 'call');
        return !table.isRunning;
      })
    ).toBe(true);
    expect(entry.director.playerByUid(uid)).toBeNull();
    // Heads-up, so conceding hands the other player the tournament.
    expect((await over).winner).toBe('Host');
  });

  test('a third socket opens the rail: the table with no cards, a badged line, and a way out', async () => {
    const host = await connectClient();
    const { created, guest } = await createTournamentWithGuest(host, {
      startsAt: Date.now() + 60000,
    });
    await startAndDeal(host, guest);
    const entry = serverModule.registry.tournaments.get(created.id);

    const rail = await connectClient();
    await identify(rail, { name: 'Rail', avatar: '🦉' });
    const joined = waitFor(rail, 'tournamentJoined');
    const seen = waitFor(rail, 'gameState');
    rail.emit('watchTournament', { rail: entry.rail });
    expect(await joined).toMatchObject({ id: created.id, watching: true });
    const game = await seen;
    expect(game.players).toHaveLength(2);
    expect(game.players.every((p) => p.holeCards === null)).toBe(true);
    expect(game.isMyTurn).toBeFalsy();

    const heard = waitFor(host, 'chatMessage', (m) => m.text === 'go on');
    rail.emit('chat', { text: 'go on' });
    expect(await heard).toMatchObject({ name: 'Rail', rail: true });

    const gone = waitFor(rail, 'leftTournament');
    rail.emit('stopWatching');
    expect(await gone).toMatchObject({ id: created.id, reason: 'unwatched' });
    expect(entry.watchers.size).toBe(0);
  });

  test('a busted player re-enters from their socket and lands a fresh seat and stack', async () => {
    const host = await connectClient();
    const { created, guest } = await createTournamentWithGuest(host, {
      reentryLevels: 3,
      buyIn: 100,
    });
    const third = await connectClient();
    await joinByCode(third, created.code, { name: 'Third', avatar: '🦉' });
    await startAndDeal(host, guest);

    // A seated player asking is answered with a notice, not a log line.
    const seatedNotice = waitFor(host, 'tournamentNotice', (n) => /still seated/.test(n.message));
    host.emit('reenterTournament');
    await seatedNotice;

    // Bust the guest on the server between hands: hold the field, fold the
    // hand out, hand the stack to a neighbour and let the round end take them.
    const entry = serverModule.tournaments.get(created.id);
    const director = entry.director;
    director.holdField();
    const table = director.tables[0];
    expect(
      await until(() => {
        if (!table.isRunning) return true;
        const cur = table.players[table.currentPlayerIndex];
        if (cur && !table.handleAction(cur.id, 'fold')) table.handleAction(cur.id, 'call');
        return !table.isRunning;
      })
    ).toBe(true);
    const guestUid = guest.__identity.uid;
    const { player } = director.playerByUid(guestUid);
    const keeper = table.players.find((p) => p.uid !== guestUid && p.chips > 0);
    const out = waitFor(guest, 'tournamentEliminated');
    keeper.chips += player.chips;
    player.chips = 0;
    director.tournament.recordElimination(player.name, 1, guestUid);
    director._handleRoundEnd(table, null);
    expect(await out).toMatchObject({ place: 3, canReenter: true, buyIn: 100, reentryLevels: 3 });
    expect(director.playerByUid(guestUid)).toBeNull();

    const back = waitFor(guest, 'tournamentReentered');
    const seated = waitFor(guest, 'gameState', (st) =>
      st.players.some((p) => p.id === guest.id && p.chips === 1000)
    );
    guest.emit('reenterTournament');
    expect(await back).toEqual({ chips: 1000, table: 1 });
    await seated;
    expect(director.playerByUid(guestUid).player.id).toBe(guest.id);
    expect(serverModule.registry.stateFor(entry, guestUid)).toMatchObject({
      entrants: 3,
      entries: 4,
      prizePool: 400,
      you: { seated: true, eliminated: false, canReenter: false },
    });
    expect(() => director.assertChipConservation()).not.toThrow();
    director.releaseField();
  });

  test('a busted player who left the table re-enters by naming the game from the lobby', async () => {
    const host = await connectClient();
    const { created, guest } = await createTournamentWithGuest(host, {
      reentryLevels: 3,
      buyIn: 100,
    });
    const third = await connectClient();
    await joinByCode(third, created.code, { name: 'Third', avatar: '🦉' });
    await startAndDeal(host, guest);

    const entry = serverModule.tournaments.get(created.id);
    const director = entry.director;
    director.holdField();
    const table = director.tables[0];
    expect(
      await until(() => {
        if (!table.isRunning) return true;
        const cur = table.players[table.currentPlayerIndex];
        if (cur && !table.handleAction(cur.id, 'fold')) table.handleAction(cur.id, 'call');
        return !table.isRunning;
      })
    ).toBe(true);
    const guestUid = guest.__identity.uid;
    const { player } = director.playerByUid(guestUid);
    const keeper = table.players.find((p) => p.uid !== guestUid && p.chips > 0);
    const out = waitFor(guest, 'tournamentEliminated');
    keeper.chips += player.chips;
    player.chips = 0;
    director.tournament.recordElimination(player.name, 1, guestUid);
    director._handleRoundEnd(table, null);
    await out;

    // Decline the offer and walk out, which is the whole of the bug: the
    // socket stops pointing at the game, and used to take the offer with it.
    const left = waitFor(guest, 'leftTournament');
    guest.emit('leaveTournament');
    await left;
    expect(entry.registrations.get(guestUid).left).toBe(true);
    // The card in front of them still offers it.
    const card = serverModule.registry.listFor(guestUid).find((c) => c.id === created.id);
    expect(card.you.canReenter).toBe(true);

    // Pressing it names the game, and the answer puts them back at the table.
    const joined = waitFor(guest, 'tournamentJoined');
    const back = waitFor(guest, 'tournamentReentered');
    guest.emit('reenterTournament', { tournamentId: created.id });
    expect(await joined).toMatchObject({ id: created.id });
    expect(await back).toMatchObject({ chips: 1000 });
    expect(director.playerByUid(guestUid)).not.toBeNull();
    expect(entry.registrations.get(guestUid).left).toBe(false);
    expect(() => director.assertChipConservation()).not.toThrow();
    director.releaseField();
  });
});

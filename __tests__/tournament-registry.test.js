// __tests__/tournament-registry.test.js - lifecycle under fake timers
const { createTournamentRegistry } = require('../server/tournament-registry');

function makeIo() {
  const sent = [];
  return {
    sent,
    emit: (event, payload) => sent.push({ to: '*', event, payload }),
    to: (sid) => ({ emit: (event, payload) => sent.push({ to: sid, event, payload }) }),
  };
}

function makeIdentity(names) {
  return {
    get: (uid) => (names[uid] ? { uid, name: names[uid], avatar: '🙂' } : null),
    expireIdle: () => 0,
  };
}

function makeStore() {
  let saved = [];
  return {
    saves: 0,
    load: () => saved,
    save(list) {
      saved = JSON.parse(JSON.stringify(list));
      this.saves++;
    },
  };
}

// Sockets register themselves so the personalised tournament list has
// somewhere to go, the way a real socket.io server tracks them.
const live = new Map();

function makeSocket(id, uid) {
  const emitted = [];
  const socket = {
    id,
    data: uid ? { uid } : {},
    emitted,
    emit: (event, payload) => emitted.push({ event, payload }),
  };
  live.set(id, socket);
  return socket;
}

describe('tournament registry', () => {
  let registry;
  let io;
  const names = { h: 'Host', g: 'Guest', t: 'Third' };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-06T20:00:00Z'));
    io = makeIo();
    live.clear();
    registry = createTournamentRegistry({
      io,
      identity: makeIdentity(names),
      finishedTtlMs: 5000,
      abandonGraceMs: 3000,
      hostTransferGraceMs: 2000,
      overdueAbandonMs: 20000,
      sweepMs: 1000,
      tableOptions: { actionTimeoutMs: 0 },
      connectedSockets: () => live.values(),
    });
  });

  afterEach(() => {
    registry.stop();
    jest.useRealTimers();
  });

  function create(overrides = {}, socket = makeSocket('sh')) {
    const { entry, error } = registry.create('h', { name: 'Night', ...overrides }, socket);
    expect(error).toBeUndefined();
    return { entry, socket };
  }

  test('a scheduled tournament starts when its time arrives with two entrants', () => {
    const { entry } = create({ startsAt: Date.now() + 5000 });
    const guest = makeSocket('sg');
    expect(registry.join('g', { code: entry.code }, guest).error).toBeUndefined();
    jest.advanceTimersByTime(4000);
    expect(entry.status).toBe('registering');
    jest.advanceTimersByTime(1500);
    expect(entry.status).toBe('running');
    expect(entry.director.isRunning).toBe(true);
    expect(entry.startedAt).toBeGreaterThanOrEqual(entry.startsAt);
    expect(entry.startedAt).toBeLessThanOrEqual(Date.now());
    expect(
      io.sent.some(
        (m) => m.to === 'sg' && m.event === 'tournamentState' && m.payload.status === 'running'
      )
    ).toBe(true);
  });

  test('with one entrant it waits, says so once, and starts when a second registers', () => {
    const { entry, socket } = create({ startsAt: Date.now() + 1000 });
    jest.advanceTimersByTime(2500);
    expect(entry.status).toBe('registering');
    expect(entry.waitingReason).toMatch(/one more/);
    const waits = io.sent.filter(
      (m) => m.to === socket.id && m.event === 'tournamentState' && m.payload.waitingReason
    );
    expect(waits.length).toBeGreaterThanOrEqual(1);
    registry.join('g', { code: entry.code }, makeSocket('sg'));
    jest.advanceTimersByTime(1000);
    expect(entry.status).toBe('running');
    expect(entry.waitingReason).toBeNull();
  });

  test('an overdue tournament nobody else joins is cancelled', () => {
    const { entry, socket } = create({ startsAt: Date.now() });
    jest.advanceTimersByTime(21000);
    expect(registry.tournaments.has(entry.id)).toBe(false);
    expect(socket.emitted.some((m) => m.event === 'tournamentCancelled')).toBe(false); // io.to, not socket
    expect(io.sent.some((m) => m.to === 'sh' && m.event === 'tournamentCancelled')).toBe(true);
  });

  test('start now is host-only and needs two entrants; cancel is host-only', () => {
    const { entry } = create({ startsAt: Date.now() + 60000 });
    const guest = makeSocket('sg');
    expect(registry.startNow(entry, 'h').error).toMatch(/2 entrants/);
    registry.join('g', { code: entry.code }, guest);
    expect(registry.startNow(entry, 'g').error).toMatch(/host/);
    expect(registry.cancel(entry, 'g').error).toMatch(/host/);
    expect(registry.startNow(entry, 'h').error).toBeUndefined();
    expect(entry.status).toBe('running');
    expect(registry.cancel(entry, 'h').error).toBeUndefined();
    expect(registry.tournaments.has(entry.id)).toBe(false);
    expect(
      io.sent
        .filter((m) => m.event === 'tournamentCancelled')
        .map((m) => m.to)
        .sort()
    ).toEqual(['sg', 'sh']);
  });

  test('the host passes to the next connected human after the grace, or at once on unregister', () => {
    const { entry, socket } = create({ startsAt: Date.now() + 60000 });
    const guest = makeSocket('sg');
    registry.join('g', { code: entry.code }, guest);
    jest.advanceTimersByTime(500);
    const third = makeSocket('st');
    registry.join('t', { code: entry.code }, third);
    registry.unbind(entry, 'h', socket);
    jest.advanceTimersByTime(1000);
    expect(entry.hostUid).toBe('h'); // within the grace
    jest.advanceTimersByTime(2000);
    expect(entry.hostUid).toBe('g'); // earliest-joined connected human
    registry.unregister(entry, 'g', guest);
    expect(entry.hostUid).toBe('t');
    expect(guest.emitted.some((m) => m.event === 'leftTournament')).toBe(true);
  });

  test('the last human unregistering removes the tournament', () => {
    const { entry, socket } = create({ startsAt: Date.now() + 60000 });
    registry.unregister(entry, 'h', socket);
    expect(registry.tournaments.has(entry.id)).toBe(false);
  });

  test('a running tournament with nobody connected is removed after the grace', () => {
    const { entry, socket } = create({ startsAt: Date.now() + 60000 });
    const guest = makeSocket('sg');
    registry.join('g', { code: entry.code }, guest);
    registry.startNow(entry, 'h');
    registry.unbind(entry, 'h', socket);
    registry.unbind(entry, 'g', guest);
    jest.advanceTimersByTime(2000);
    expect(registry.tournaments.has(entry.id)).toBe(true);
    registry.bind(entry, 'g', makeSocket('sg2'));
    jest.advanceTimersByTime(3000);
    expect(registry.tournaments.has(entry.id)).toBe(true); // someone came back
    registry.unbind(entry, 'g', { id: 'sg2' });
    jest.advanceTimersByTime(4000);
    expect(registry.tournaments.has(entry.id)).toBe(false);
  });

  test('a finished tournament lingers for its TTL, then goes', () => {
    const { entry } = create({ startsAt: Date.now() + 60000 });
    registry.join('g', { code: entry.code }, makeSocket('sg'));
    registry.startNow(entry, 'h');
    entry.director._finish(null);
    expect(entry.status).toBe('finished');
    jest.advanceTimersByTime(3000);
    expect(registry.tournaments.has(entry.id)).toBe(true);
    jest.advanceTimersByTime(3000);
    expect(registry.tournaments.has(entry.id)).toBe(false);
  });

  test('a card knows the tournament is yours, including after you leave', () => {
    const hostSocket = makeSocket('sh', 'h');
    const { entry } = create({ startsAt: Date.now() + 60000 }, hostSocket);
    const guest = makeSocket('sg', 'g');
    registry.join('g', { code: entry.code }, guest);
    registry.startNow(entry, 'h');

    const rowFor = (socket) => {
      const last = [...socket.emitted].reverse().find((m) => m.event === 'tournamentList');
      return last ? last.payload.find((t) => t.id === entry.id) : null;
    };
    expect(rowFor(hostSocket).you).toMatchObject({ registered: true, left: false });
    expect(rowFor(guest).you).toMatchObject({ registered: true, left: false });

    // Leaving hands the stack to a sit-out, but the card must still say the
    // tournament is yours or the lobby offers late registration instead.
    registry.leave(entry, 'h', hostSocket);
    registry.sweep();
    expect(rowFor(hostSocket).you).toMatchObject({ registered: false, left: true });
    expect(entry.director.playerByUid('h').player.autoPlay).toBe(true);

    // Coming back takes the seat off sit-out.
    registry.join('h', { code: entry.code }, hostSocket);
    expect(rowFor(hostSocket).you).toMatchObject({ registered: true, left: false });
    expect(entry.director.playerByUid('h').player.autoPlay).toBe(false);
  });

  test('a dropped connection sits the seat out, and coming back resumes it', () => {
    const hostSocket = makeSocket('sh', 'h');
    const { entry } = create({ startsAt: Date.now() + 60000 }, hostSocket);
    const guest = makeSocket('sg', 'g');
    registry.join('g', { code: entry.code }, guest);
    registry.startNow(entry, 'h');
    // start() seats the field; the first hand arrives on the director's tick.
    jest.advanceTimersByTime(1300);
    entry.director.holdField();
    const seat = entry.director.playerByUid('h');
    expect(seat.table.isRunning).toBe(true);

    registry.unbind(entry, 'h', hostSocket);
    expect(seat.player.autoPlay).toBe(true);
    expect(seat.player.sitOutReason).toBe('disconnect');
    expect(seat.player.isConnected).toBe(false);

    registry.bind(entry, 'h', makeSocket('sh2', 'h'), { resumed: true });
    expect(seat.player.autoPlay).toBe(false);
    expect(seat.player.sitOutReason).toBeNull();
    expect(seat.player.isConnected).toBe(true);
  });

  test('a sit-out the player asked for survives a reconnect', () => {
    const hostSocket = makeSocket('sh', 'h');
    const { entry } = create({ startsAt: Date.now() + 60000 }, hostSocket);
    registry.join('g', { code: entry.code }, makeSocket('sg', 'g'));
    registry.startNow(entry, 'h');
    jest.advanceTimersByTime(1300);
    entry.director.holdField();
    const seat = entry.director.playerByUid('h');

    // What the sit-out button does, through the handler's own bookkeeping.
    seat.player.autoPlay = true;
    seat.player.sitOutReason = 'requested';

    registry.unbind(entry, 'h', hostSocket);
    registry.bind(entry, 'h', makeSocket('sh2', 'h'), { resumed: true });
    expect(seat.player.autoPlay).toBe(true);
    expect(seat.player.sitOutReason).toBe('requested');
  });

  test('one live registration per identity, resumable by uid', () => {
    const { entry } = create({ startsAt: Date.now() + 60000 });
    expect(registry.create('h', { name: 'Again' }, makeSocket('sh2')).error).toMatch(/already/);
    expect(registry.findByUid('h')).toBe(entry);
    expect(registry.findByUid('g')).toBeNull();
    const again = makeSocket('sh3');
    registry.bind(entry, 'h', again, { resumed: true });
    expect(entry.registrations.get('h').socketId).toBe('sh3');
    expect(again.emitted[0]).toMatchObject({
      event: 'tournamentJoined',
      payload: { resumed: true, host: true },
    });
  });

  test('registering tournaments persist and are restored; running ones are not written', () => {
    const store = makeStore();
    const first = createTournamentRegistry({
      io,
      identity: makeIdentity(names),
      sweepMs: 1000,
      store,
      tableOptions: { actionTimeoutMs: 0 },
    });
    const { entry } = first.create(
      'h',
      { name: 'Persisted', startsAt: Date.now() + 8000 },
      makeSocket('sh')
    );
    first.join('g', { code: entry.code }, makeSocket('sg'));
    first.flush();
    expect(store.load()).toHaveLength(1);
    expect(store.load()[0]).toMatchObject({ id: entry.id, code: entry.code, hostUid: 'h' });
    expect(
      store
        .load()[0]
        .registrations.map((r) => r.uid)
        .sort()
    ).toEqual(['g', 'h']);
    first.stop();

    const second = createTournamentRegistry({
      io,
      identity: makeIdentity(names),
      sweepMs: 1000,
      store,
      tableOptions: { actionTimeoutMs: 0 },
    });
    expect(second.restore()).toBe(1);
    const back = second.tournaments.get(entry.id);
    expect(back).toBeTruthy();
    expect(back.code).toBe(entry.code);
    expect(back.name).toBe('Persisted');
    expect(back.hostUid).toBe('h');
    expect(back.settings.lateRegLevels).toBe(3);
    expect(back.director.entrants).toHaveLength(2);
    expect(back.registrations.size).toBe(2);
    expect(back.registrations.get('g').socketId).toBeNull();
    // A returning human is rebound to their registration...
    expect(second.findByUid('g')).toBe(back);
    second.bind(back, 'g', makeSocket('sg2'), { resumed: true });
    expect(back.registrations.get('g').socketId).toBe('sg2');
    // ...and the sweep starts it at its time, after which it leaves the file.
    jest.advanceTimersByTime(9000);
    expect(back.status).toBe('running');
    second.flush();
    expect(store.load()).toHaveLength(0);
    second.stop();
  });
});

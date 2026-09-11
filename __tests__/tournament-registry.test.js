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
      socketById: (id) => live.get(id) || null,
      pendingGraceMs: 4000,
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

  // Demo seats fill a table for a person who wants to see the game move. They
  // are entrants, so the field can start; they are not registrations, so they
  // neither hold the tournament open nor stand between it and the reaper.
  test('the bot option seats five demo entrants that do not count as people', () => {
    const hostSocket = makeSocket('sh', 'h');
    const { entry } = create({ startsAt: Date.now() + 60000, bots: true }, hostSocket);
    expect(entry.director.entrants.length).toBe(6);
    expect(entry.registrations.size).toBe(1);
    const bots = entry.director.entrants.filter((e) => e.isBot);
    expect(bots.length).toBe(5);
    expect(new Set(bots.map((b) => b.uid)).size).toBe(5);
    // A demo seat is played here, so it carries an id from the start rather
    // than waiting for a socket the way a person's seat does.
    expect(bots.every((b) => b.id === b.uid)).toBe(true);

    // One person is enough to start a field of six.
    expect(registry.startNow(entry, 'h').error).toBeUndefined();
    expect(entry.status).toBe('running');

    // And when that person goes, the bots do not keep it alive.
    registry.unbind(entry, 'h', hostSocket);
    jest.advanceTimersByTime(4000);
    expect(registry.tournaments.has(entry.id)).toBe(false);
  });

  test('without the bot option a tournament is people only', () => {
    const { entry } = create({ startsAt: Date.now() + 60000 });
    expect(entry.director.entrants.length).toBe(1);
    expect(entry.director.entrants.some((e) => e.isBot)).toBe(false);
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

  test('the list carries no join code, and a card joins by id instead', () => {
    const hostSocket = makeSocket('sh', 'h');
    // Public on purpose: a stranger only ever sees a card for a listed game.
    const { entry } = create({ startsAt: Date.now() + 60000, visibility: 'public' }, hostSocket);
    expect(entry.code).toMatch(/^[A-Z2-9]{5}$/);

    // The HTTP list and the socket push are the same card, and the code is the
    // way into the game, so neither can carry it.
    const stranger = makeSocket('sx');
    jest.advanceTimersByTime(300);
    const pushed = [...stranger.emitted].reverse().find((m) => m.event === 'tournamentList');
    for (const card of [...registry.publicList(), ...pushed.payload]) {
      expect(card.id).toBe(entry.id);
      expect(card).not.toHaveProperty('code');
      expect(JSON.stringify(card)).not.toContain(entry.code);
    }

    // Which is fine, because a card has the id and that is enough to join.
    const guest = makeSocket('sg', 'g');
    expect(registry.join('g', { tournamentId: entry.id }, guest).error).toBeUndefined();
    expect(entry.registrations.has('g')).toBe(true);
    const joined = guest.emitted.find((m) => m.event === 'tournamentJoined');
    expect(joined.payload).toMatchObject({ id: entry.id, code: entry.code });
  });

  test('a card knows the tournament is yours, including after you leave', () => {
    const hostSocket = makeSocket('sh', 'h');
    const { entry } = create({ startsAt: Date.now() + 60000 }, hostSocket);
    const guest = makeSocket('sg', 'g');
    registry.join('g', { code: entry.code }, guest);
    registry.startNow(entry, 'h');

    // Lobby-list pushes are coalesced, so a burst of joins is one redraw rather
    // than one per join. Let the window close before reading the last card.
    const rowFor = (socket) => {
      jest.advanceTimersByTime(300);
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

  test('table size is clamped to the eight the felt is laid out for', () => {
    // One tournament per identity, so each bound is asked by a different host.
    const big = registry.create('h', { name: 'Big', tableSize: 10 }, makeSocket('sa', 'h'));
    const small = registry.create('g', { name: 'Small', tableSize: 1 }, makeSocket('sb', 'g'));
    const plain = registry.create('t', { name: 'Plain' }, makeSocket('sc', 't'));
    expect(big.entry.settings.tableSize).toBe(8);
    expect(small.entry.settings.tableSize).toBe(2);
    expect(plain.entry.settings.tableSize).toBe(8);
  });

  test('a running tournament keeps the table size it was dealt with', () => {
    // A field seated at nine that comes back after the ceiling dropped to eight
    // must not be re-clamped: seats past the new limit could be shed but never
    // refilled, and _breakIfPossible would count capacity that is not there.
    const store = makeStore();
    store.save([
      {
        id: 't_old',
        code: 'OLD99',
        name: 'Nine handed',
        createdAt: Date.now() - 60000,
        startsAt: Date.now() - 30000,
        hostUid: 'h',
        settings: { tableSize: 9, startChips: 5000, levelDuration: 300, lateRegLevels: 3 },
        entrants: [
          { uid: 'h', name: 'Host', avatar: null },
          { uid: 'g', name: 'Guest', avatar: null },
        ],
        registrations: [{ uid: 'h', joinedAt: Date.now() }],
        status: 'running',
        field: null,
      },
    ]);
    const reg = createTournamentRegistry({
      io,
      identity: makeIdentity(names),
      sweepMs: 1000,
      store,
      tableOptions: { actionTimeoutMs: 0 },
    });
    reg.restore();
    expect(reg.tournaments.get('t_old').settings.tableSize).toBe(9);
    reg.stop();
  });

  test('registering tournaments persist and are restored, and so do running ones', () => {
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
    // ...and the sweep starts it at its time.
    jest.advanceTimersByTime(9000);
    expect(back.status).toBe('running');

    // A running tournament stays in the file now, carrying the field. It used
    // to be dropped, on the grounds that a hand in progress cannot be rebuilt
    // — which is true, and is why the field is recorded between hands instead.
    second.flush();
    const saved = store.load();
    expect(saved).toHaveLength(1);
    expect(saved[0].status).toBe('running');
    expect(saved[0].field.tables[0].players.map((p) => p.uid).sort()).toEqual(['g', 'h']);
    second.stop();
  });

  // The abandonment clock was only started by a disconnect, so a running field
  // restored on boot - every seat socketless, nobody having disconnected -
  // never started it, and dealt to nobody until the next restart, which seated
  // it again. Seen on a dev box: four fields from a chat test, a day later,
  // at the top of the ladder with everybody still in, because seats that fold
  // every hand only ever trade blinds.
  test('a restored field nobody comes back to is abandoned after the grace', () => {
    const store = makeStore();
    const boot = () =>
      createTournamentRegistry({
        io,
        identity: makeIdentity(names),
        sweepMs: 1000,
        abandonGraceMs: 3000,
        store,
        tableOptions: { actionTimeoutMs: 0 },
        connectedSockets: () => live.values(),
      });
    const first = boot();
    const { entry } = first.create(
      'h',
      { name: 'Left running', startsAt: Date.now() + 1000 },
      makeSocket('sh')
    );
    first.join('g', { code: entry.code }, makeSocket('sg'));
    jest.advanceTimersByTime(2000);
    expect(entry.status).toBe('running');
    first.flush();
    first.stop();
    live.clear();

    const second = boot();
    expect(second.restore()).toBe(1);
    const back = second.tournaments.get(entry.id);
    expect(back.status).toBe('running');
    // Still there inside the grace...
    jest.advanceTimersByTime(2500);
    expect(second.tournaments.has(entry.id)).toBe(true);
    // ...and gone once it has passed with nobody back.
    jest.advanceTimersByTime(1500);
    expect(second.tournaments.has(entry.id)).toBe(false);
    second.flush();
    expect(store.load()).toHaveLength(0);
    second.stop();

    // Whereas a player who does come back keeps the field, as they always did.
    const third = boot();
    const again = third.create(
      'h',
      { name: 'Came back', startsAt: Date.now() + 1000 },
      makeSocket('sh')
    ).entry;
    third.join('g', { code: again.code }, makeSocket('sg'));
    jest.advanceTimersByTime(2000);
    third.flush();
    third.stop();
    live.clear();
    const fourth = boot();
    expect(fourth.restore()).toBe(1);
    const kept = fourth.tournaments.get(again.id);
    jest.advanceTimersByTime(2000);
    fourth.bind(kept, 'g', makeSocket('sg2', 'g'), { resumed: true });
    jest.advanceTimersByTime(5000);
    expect(fourth.tournaments.has(again.id)).toBe(true);
    expect(kept.status).toBe('running');
    fourth.stop();
  });

  // A broadcast builds the roster and the field summary once and hands them to
  // every recipient. The risk in that is showing one player another player's
  // corner of the state, so it is pinned: what is shared must be identical for
  // everyone, and what is personal must not be.
  // Persistence turned a crash into a loop: a field heavy enough to bring the
  // process down is faithfully seated again on boot and brings it down again,
  // and the restart policy runs that forever. Observed on a two hundred player
  // field, which left the box pegged and the server unreachable.
  // The first version of this guard cleared the counter on any completed hand,
  // which a field big enough to crash the process manages hundreds of times
  // before it does. Playing is not the signal; staying up is.
  test('a field that keeps crashing is held even though it deals hands', () => {
    const store = makeStore();
    const boot = () =>
      createTournamentRegistry({
        io,
        identity: makeIdentity(names),
        sweepMs: 1000,
        store,
        tableOptions: { actionTimeoutMs: 0 },
      });
    const first = boot();
    const { entry } = first.create(
      'h',
      { name: 'Crashy', startsAt: Date.now() + 1000 },
      makeSocket('sh')
    );
    first.join('g', { code: entry.code }, makeSocket('sg'));
    jest.advanceTimersByTime(2000);
    first.flush();
    first.stop();

    // Three boots that each deal a hand and then die well inside the window.
    for (let i = 0; i < 3; i += 1) {
      const reg = boot();
      expect(reg.restore()).toBe(1);
      const back = reg.tournaments.get(entry.id);
      expect(back.director.isRunning).toBe(true);
      // A hand finishes, as it would on any real boot.
      back.director.onSnapshot(back.director);
      // ...but the process dies long before it has proved itself.
      jest.advanceTimersByTime(20 * 1000);
      reg.flush();
      reg.stop();
    }

    const held = boot();
    held.restore();
    const back = held.tournaments.get(entry.id);
    expect(back.director.isRunning).toBe(false);
    expect(back.waitingReason).toMatch(/could not be restarted/i);
    held.stop();
  });

  // Holding the field was undone a tick later. A held tournament sits in
  // `registering` with its start time long past, which is exactly what the
  // sweep deals - so it dealt a fresh table at level one over the top of the
  // chips being kept, and wrote that down as the field. Seen on a dev box,
  // where a held game came back as a brand new one on every restart, which is
  // the opposite of what holding it is for.
  test('a held field is not dealt over by the sweep, and keeps its chips', () => {
    const store = makeStore();
    const boot = () =>
      createTournamentRegistry({
        io,
        identity: makeIdentity(names),
        sweepMs: 1000,
        overdueAbandonMs: 3000,
        store,
        tableOptions: { actionTimeoutMs: 0 },
      });
    const first = boot();
    const { entry } = first.create(
      'h',
      { name: 'Held', startsAt: Date.now() + 1000 },
      makeSocket('sh')
    );
    first.join('g', { code: entry.code }, makeSocket('sg'));
    jest.advanceTimersByTime(2000);
    expect(entry.status).toBe('running');
    first.flush();
    first.stop();

    // Three boots that could not get a hand out, already counted.
    store.load()[0].restoreCount = 3;
    const chips = store.load()[0].field.tables[0].players.map((p) => p.chips);

    const second = boot();
    expect(second.restore()).toBe(1);
    const back = second.tournaments.get(entry.id);
    expect(back.director.isRunning).toBe(false);
    expect(back.waitingReason).toMatch(/could not be restarted/i);

    // Past the start time, past the overdue window, and still held: neither
    // dealt nor cancelled.
    jest.advanceTimersByTime(6000);
    expect(second.tournaments.has(entry.id)).toBe(true);
    expect(back.status).toBe('registering');
    expect(back.director.isRunning).toBe(false);
    expect(back.waitingReason).toMatch(/could not be restarted/i);

    // The file still carries the field, so the next restart holds it as well
    // rather than reading it back as one waiting for its start time.
    second.flush();
    expect(store.load()[0].held).toBe(true);
    expect(store.load()[0].field.tables[0].players.map((p) => p.chips)).toEqual(chips);
    second.stop();

    const third = boot();
    expect(third.restore()).toBe(1);
    const still = third.tournaments.get(entry.id);
    expect(still.director.isRunning).toBe(false);
    jest.advanceTimersByTime(6000);
    expect(third.tournaments.has(entry.id)).toBe(true);
    expect(still.director.isRunning).toBe(false);

    // The host is the way out: starting it deals the field again from the
    // beginning, which is a decision somebody made rather than something that
    // happened to it.
    expect(third.startNow(still, 'h').error).toBeUndefined();
    expect(still.status).toBe('running');
    expect(still.director.isRunning).toBe(true);
    third.flush();
    expect(store.load()[0].held).toBe(false);
    third.stop();
  });

  test('a field that stays up is not held against its earlier crashes', () => {
    const store = makeStore();
    const boot = () =>
      createTournamentRegistry({
        io,
        identity: makeIdentity(names),
        sweepMs: 1000,
        store,
        tableOptions: { actionTimeoutMs: 0 },
      });
    const first = boot();
    const { entry } = first.create(
      'h',
      { name: 'Fine', startsAt: Date.now() + 1000 },
      makeSocket('sh')
    );
    first.join('g', { code: entry.code }, makeSocket('sg'));
    jest.advanceTimersByTime(2000);
    first.flush();
    first.stop();

    const reg = boot();
    reg.restore();
    const back = reg.tournaments.get(entry.id);
    expect(back.restoreCount).toBe(1);
    // It keeps going for longer than the window, then finishes a hand.
    jest.advanceTimersByTime(3 * 60 * 1000);
    back.director.onSnapshot(back.director);
    expect(back.restoreCount).toBe(0);
    reg.stop();
  });

  test('a field that never finishes a hand stops being restored', () => {
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
      { name: 'Heavy', startsAt: Date.now() + 1000 },
      makeSocket('sh')
    );
    first.join('g', { code: entry.code }, makeSocket('sg'));
    jest.advanceTimersByTime(2000);
    expect(entry.status).toBe('running');
    first.flush();
    first.stop();

    // Boot after boot, never getting a hand out.
    let last = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const reg = createTournamentRegistry({
        io,
        identity: makeIdentity(names),
        sweepMs: 1000,
        store,
        tableOptions: { actionTimeoutMs: 0 },
      });
      expect(reg.restore()).toBe(1);
      last = reg.tournaments.get(entry.id);
      expect(last.director.isRunning).toBe(true);
      expect(last.restoreCount).toBe(attempt);
      reg.flush();
      reg.stop();
    }

    // The fourth time it is held instead of dealt.
    const held = createTournamentRegistry({
      io,
      identity: makeIdentity(names),
      sweepMs: 1000,
      store,
      tableOptions: { actionTimeoutMs: 0 },
    });
    expect(held.restore()).toBe(1);
    const back = held.tournaments.get(entry.id);
    expect(back.director.isRunning).toBe(false);
    expect(back.director.tables).toHaveLength(0);
    expect(back.waitingReason).toMatch(/could not be restarted/i);
    // The people are still there; only the field is not dealt.
    expect(back.registrations.size).toBe(2);
    held.stop();
  });

  test('a shared broadcast still gives every viewer their own corner', () => {
    const store = makeStore();
    const reg = createTournamentRegistry({
      io,
      identity: makeIdentity(names),
      sweepMs: 1000,
      store,
      tableOptions: { actionTimeoutMs: 0 },
    });
    const { entry } = reg.create(
      'h',
      { name: 'Shared', startsAt: Date.now() + 1000 },
      makeSocket('sh')
    );
    reg.join('g', { code: entry.code }, makeSocket('sg'));
    reg.join('t', { code: entry.code }, makeSocket('st'));
    jest.advanceTimersByTime(2000);
    expect(entry.status).toBe('running');

    const forHost = reg.stateFor(entry, 'h');
    const forGuest = reg.stateFor(entry, 'g');
    const forThird = reg.stateFor(entry, 't');

    // Shared: the same field, the same roster, for everyone.
    expect(forGuest.roster).toEqual(forHost.roster);
    expect(forThird.roster).toEqual(forHost.roster);
    expect(forHost.roster.map((r) => r.uid).sort()).toEqual(['g', 'h', 't']);
    expect(forGuest.entrants).toBe(forHost.entrants);
    expect(forGuest.blinds).toEqual(forHost.blinds);

    // Personal: never mixed up between them.
    expect(forHost.you.uid).toBe('h');
    expect(forGuest.you.uid).toBe('g');
    expect(forThird.you.uid).toBe('t');
    expect(forHost.isHost).toBe(true);
    expect(forGuest.isHost).toBe(false);
    expect(forHost.myChips).toBe(forGuest.myChips); // equal stacks, but each read for itself
    expect(typeof forGuest.myRank).toBe('number');

    reg.stop();
  });

  test('a tournament that was mid-play is seated again after a restart', () => {
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
      { name: 'Crashed', startsAt: Date.now() + 1000 },
      makeSocket('sh')
    );
    first.join('g', { code: entry.code }, makeSocket('sg'));
    jest.advanceTimersByTime(2000);
    expect(entry.status).toBe('running');

    // Give the field a shape a restore could get wrong.
    const table = entry.director.tables[0];
    table.players[0].chips += 1200;
    table.players[1].chips -= 1200;
    const stacks = table.players.map((p) => `${p.uid}:${p.chips}`);
    const total = entry.director.totalChips();
    first.flush();
    first.stop();

    // The process comes back.
    const second = createTournamentRegistry({
      io,
      identity: makeIdentity(names),
      sweepMs: 1000,
      store,
      tableOptions: { actionTimeoutMs: 0 },
    });
    expect(second.restore()).toBe(1);
    const back = second.tournaments.get(entry.id);
    expect(back.status).toBe('running');
    expect(back.director.isRunning).toBe(true);
    expect(back.director.tables).toHaveLength(1);
    expect(back.director.totalChips()).toBe(total);
    expect(back.director.tables[0].players.map((p) => `${p.uid}:${p.chips}`)).toEqual(stacks);
    // Nobody is back at the keyboard yet, so every seat is sitting out.
    for (const p of back.director.tables[0].players) expect(p.autoPlay).toBe(true);
    second.stop();
  });

  // ── Chat ───────────────────────────────────────────────────────────────
  describe('chat', () => {
    // Three people and two seats to a table: two at table 1, one at table 2,
    // which is the arrangement that shows a message staying where it belongs.
    function twoTables() {
      const hostSocket = makeSocket('sh', 'h');
      const { entry } = create({ startsAt: Date.now() + 60000, tableSize: 2 }, hostSocket);
      const guest = makeSocket('sg', 'g');
      const third = makeSocket('st', 't');
      registry.join('g', { code: entry.code }, guest);
      registry.join('t', { code: entry.code }, third);
      registry.startNow(entry, 'h');
      jest.advanceTimersByTime(1300);
      entry.director.holdField();
      return { entry, sockets: { h: hostSocket, g: guest, t: third } };
    }

    const chatSent = () => io.sent.filter((m) => m.event === 'chatMessage');

    test('a message reaches its own table and no other', () => {
      const { entry, sockets } = twoTables();
      const mine = entry.director.playerByUid('h').table;
      const atMyTable = entry.director.entrants
        .map((e) => e.uid)
        .filter((uid) => {
          const seat = entry.director.playerByUid(uid);
          return seat && seat.table.tableNumber === mine.tableNumber;
        });
      const elsewhere = ['h', 'g', 't'].filter((uid) => !atMyTable.includes(uid));

      io.sent.length = 0;
      const result = registry.postChat(entry, 'h', 'anyone there?', sockets.h);
      expect(result.error).toBeUndefined();

      // One emit, not one per recipient. socket.io encodes per emit and a chat
      // line is identical for everyone getting it, so a per-socket loop here
      // is the shape that cost this server 5 MB a tick before it was found.
      const sent = chatSent();
      expect(sent).toHaveLength(1);
      expect(Array.isArray(sent[0].to)).toBe(true);

      const reached = new Set(sent[0].to);
      for (const uid of atMyTable) {
        expect(reached.has(entry.registrations.get(uid).socketId)).toBe(true);
      }
      for (const uid of elsewhere) {
        expect(reached.has(entry.registrations.get(uid).socketId)).toBe(false);
      }
    });

    // Which table each of the three sits at. The draw is random: the host may
    // share a table with one guest, or sit alone with both guests at the
    // other, so `near` can be null and `atFar` holds one socket or two.
    function layout(entry) {
      const tableOf = (uid) => entry.director.playerByUid(uid).table.tableNumber;
      const hostTable = tableOf('h');
      const far = ['g', 't'].find((uid) => tableOf(uid) !== hostTable);
      const near = ['g', 't'].find((uid) => tableOf(uid) === hostTable) || null;
      const farTable = tableOf(far);
      const atFar = ['g', 't'].filter((uid) => tableOf(uid) === farTable).map((uid) => 's' + uid);
      return { hostTable, far, near, farTable, atFar };
    }

    test('the host reaches every table at once, and each table hears it once', () => {
      const { entry, sockets } = twoTables();
      io.sent.length = 0;
      const result = registry.postChat(entry, 'h', 'break in five', sockets.h, { to: 'all' });
      expect(result.error).toBeUndefined();
      expect(result.messages).toHaveLength(2);
      // One emit per room, each copy marked, all sharing a group.
      const sent = chatSent();
      expect(sent).toHaveLength(2);
      expect(sent.map((m) => m.payload.room).sort()).toEqual([`${entry.id}:t1`, `${entry.id}:t2`]);
      expect(sent.every((m) => m.payload.host === true && m.payload.scope === 'all')).toBe(true);
      expect(new Set(sent.map((m) => m.payload.group)).size).toBe(1);
      expect(sent.map((m) => m.payload.table).sort()).toEqual([1, 2]);
      // Each seat hears exactly one copy; the host, who holds every room, both.
      const heard = {};
      for (const m of sent) for (const id of m.to) heard[id] = (heard[id] || 0) + 1;
      expect(heard).toEqual({ sg: 1, st: 1, sh: 2 });
      // Each table's history holds it, so a late arrival there reads it.
      for (const n of [1, 2]) {
        expect(registry.chat.history(`${entry.id}:t${n}`).map((m) => m.text)).toEqual([
          'break in five',
        ]);
      }
      // And what the store will write carries the marks.
      const snap = registry.chat.snapshot(entry.id);
      expect(snap[`${entry.id}:t1`][0]).toMatchObject({ host: true, scope: 'all' });
      // One rate token per announcement, not one per copy: four go, the fifth
      // does not.
      const outcomes = [result.error];
      for (let i = 0; i < 4; i++) {
        outcomes.push(registry.postChat(entry, 'h', 'again ' + i, sockets.h, { to: 'all' }).error);
      }
      expect(outcomes.slice(0, 4).every((e) => !e)).toBe(true);
      expect(outcomes[4]).toMatch(/slow down/i);
    });

    test('the host can speak to one table, hears every table, and nobody else can aim', () => {
      const { entry, sockets } = twoTables();
      const { far, near, farTable, atFar } = layout(entry);
      io.sent.length = 0;
      const aimed = registry.postChat(entry, 'h', 'you are up', sockets.h, { to: farTable });
      expect(aimed.error).toBeUndefined();
      let sent = chatSent();
      expect(sent).toHaveLength(1);
      expect(sent[0].payload).toMatchObject({ room: `${entry.id}:t${farTable}`, host: true });
      expect(sent[0].payload.scope).toBeUndefined();
      expect([...sent[0].to].sort()).toEqual([...atFar, 'sh'].sort());
      if (near) expect(sent[0].to).not.toContain(sockets[near].id);
      expect(registry.postChat(entry, 'h', 'nobody', sockets.h, { to: 9 }).error).toMatch(
        /no such table/i
      );
      // A line said at the far table reaches that table and the host, who is
      // not sitting there.
      io.sent.length = 0;
      registry.postChat(entry, far, 'anyone?', sockets[far]);
      sent = chatSent();
      expect(sent).toHaveLength(1);
      expect([...sent[0].to].sort()).toEqual([...atFar, 'sh'].sort());
      // A guest's `to` is ignored: their line stays at their own table.
      io.sent.length = 0;
      registry.postChat(entry, far, 'hello everyone', sockets[far], { to: 'all' });
      sent = chatSent();
      expect(sent).toHaveLength(1);
      expect(sent[0].payload.room).toBe(`${entry.id}:t${farTable}`);
      expect(sent[0].payload.host).toBeUndefined();
      expect(sent[0].payload.scope).toBeUndefined();
      if (near) expect(sent[0].to).not.toContain(sockets[near].id);
    });

    test('binding the host sends the whole field; a guest gets only their room', () => {
      const { entry, sockets } = twoTables();
      const { far, farTable, hostTable } = layout(entry);
      registry.postChat(entry, far, 'said far away', sockets[far]);
      io.sent.length = 0;
      registry.bind(entry, 'h', makeSocket('sh2', 'h'), { resumed: true });
      const fields = io.sent.filter((m) => m.event === 'chatField');
      expect(fields).toHaveLength(1);
      expect(fields[0].to).toBe('sh2');
      const { mine, rooms } = fields[0].payload;
      expect(mine).toBe(hostTable);
      expect(rooms.map((r) => r.table)).toEqual([1, 2]);
      expect(rooms.find((r) => r.table === farTable).messages.map((m) => m.text)).toEqual([
        'said far away',
      ]);
      io.sent.length = 0;
      registry.bind(entry, far, makeSocket('sx', far), { resumed: true });
      expect(io.sent.filter((m) => m.event === 'chatField')).toHaveLength(0);
    });

    test('the floor moves with the title', () => {
      const { entry, sockets } = twoTables();
      io.sent.length = 0;
      registry.leave(entry, 'h', sockets.h);
      // The title passes on the sweep after the host walks out.
      jest.advanceTimersByTime(1100);
      const next = entry.hostUid;
      expect(next).not.toBe('h');
      const fields = io.sent.filter((m) => m.event === 'chatField');
      const theirs = fields.find((m) => m.to === entry.registrations.get(next).socketId);
      expect(theirs).toBeTruthy();
      expect(theirs.payload.rooms.map((r) => r.table)).toEqual([1, 2]);
      // The new host may aim.
      io.sent.length = 0;
      registry.postChat(entry, next, 'new host here', sockets[next], { to: 'all' });
      expect(chatSent().length).toBeGreaterThan(0);
      expect(chatSent().every((m) => m.payload.host === true)).toBe(true);
    });

    test('before the start it is one room for everyone registered', () => {
      const hostSocket = makeSocket('sh', 'h');
      const { entry } = create({ startsAt: Date.now() + 60000 }, hostSocket);
      registry.join('g', { code: entry.code }, makeSocket('sg', 'g'));
      io.sent.length = 0;
      registry.postChat(entry, 'h', 'starting in five', hostSocket);
      const sent = chatSent();
      expect(sent).toHaveLength(1);
      expect(sent[0].payload.room).toMatch(/:lobby$/);
      expect([...sent[0].to].sort()).toEqual(['sg', 'sh']);
    });

    test('the name is looked up, never taken from the sender', () => {
      const hostSocket = makeSocket('sh', 'h');
      const { entry } = create({ startsAt: Date.now() + 60000 }, hostSocket);
      const { message } = registry.postChat(entry, 'h', 'hello', hostSocket);
      expect(message.name).toBe('Host');
    });

    test('a seat that has busted reads its table but cannot type into it', () => {
      const { entry, sockets } = twoTables();
      const seat = entry.director.playerByUid('g');
      const table = seat.table;
      // Bust them: no seat, watching the table they were at.
      entry.director.tables.forEach((t) => t.removePlayer(seat.player.id));
      entry.watching.set('g', table.id);
      const denied = registry.postChat(entry, 'g', 'nice fold', sockets.g);
      expect(denied.error).toMatch(/still in the tournament/);
      // But they are still in the room, so they see what is said there.
      expect(registry.chat.roomFor(entry, 'g')).toBe(`${entry.id}:t${table.tableNumber}`);
    });

    test('the host can mute and unmute, and nobody else can', () => {
      const { entry, sockets } = twoTables();
      expect(registry.setChatMute(entry, 'g', 'h', true).error).toMatch(/host/);
      expect(registry.setChatMute(entry, 'h', 'g', true).ok).toBe(true);
      expect(registry.postChat(entry, 'g', 'hello', sockets.g).error).toMatch(/muted/);
      expect(registry.setChatMute(entry, 'h', 'g', false).ok).toBe(true);
      expect(registry.postChat(entry, 'g', 'hello', sockets.g).error).toBeUndefined();
      // The host cannot silence themselves into a corner.
      expect(registry.setChatMute(entry, 'h', 'h', true).error).toMatch(/host/);
    });

    test('a mute survives the tournament being written down and read back', () => {
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
        { name: 'Muted', startsAt: Date.now() + 60000 },
        makeSocket('sh')
      );
      first.join('g', { code: entry.code }, makeSocket('sg'));
      first.setChatMute(entry, 'h', 'g', true);
      first.flush();
      first.stop();

      const second = createTournamentRegistry({
        io,
        identity: makeIdentity(names),
        sweepMs: 1000,
        store,
        tableOptions: { actionTimeoutMs: 0 },
      });
      second.restore();
      const back = second.tournaments.get(entry.id);
      expect(back.mutedUids.has('g')).toBe(true);
      second.stop();
    });

    test('arriving at a table sends the recent chat, once', () => {
      const { entry, sockets } = twoTables();
      registry.postChat(entry, 'h', 'said before you got here', sockets.h);
      io.sent.length = 0;
      registry.bind(entry, 'h', makeSocket('sh2', 'h'), { resumed: true });
      const history = io.sent.filter((m) => m.event === 'chatHistory');
      expect(history).toHaveLength(1);
      expect(history[0].payload.messages.map((m) => m.text)).toContain('said before you got here');
      expect(history[0].payload.canSend).toBe(true);
    });

    test('an empty message and a flood are both refused', () => {
      const hostSocket = makeSocket('sh', 'h');
      const { entry } = create({ startsAt: Date.now() + 60000 }, hostSocket);
      expect(registry.postChat(entry, 'h', '   ', hostSocket).error).toBeTruthy();
      const outcomes = [];
      for (let i = 0; i < 8; i++) {
        outcomes.push(registry.postChat(entry, 'h', 'spam ' + i, hostSocket).error);
      }
      expect(outcomes.filter((e) => !e).length).toBeLessThanOrEqual(4);
      expect(outcomes.some((e) => /slow down/i.test(e || ''))).toBe(true);
    });

    test('reaping a tournament takes its chat with it', () => {
      const hostSocket = makeSocket('sh', 'h');
      const { entry } = create({ startsAt: Date.now() + 60000 }, hostSocket);
      registry.postChat(entry, 'h', 'gone soon', hostSocket);
      expect(registry.chat.history(`${entry.id}:lobby`)).toHaveLength(1);
      registry.cancel(entry, 'h');
      expect(registry.chat.history(`${entry.id}:lobby`)).toEqual([]);
    });
  });

  test('demo seats come back from a restart still playing', () => {
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
      { name: 'Donkey Show', startsAt: Date.now() + 1000, bots: true },
      makeSocket('sh')
    );
    jest.advanceTimersByTime(2000);
    expect(entry.status).toBe('running');
    first.flush();
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
    const seats = back.director.tables[0].players;
    const bots = seats.filter((p) => p.isBot);
    expect(bots).toHaveLength(5);
    // A demo seat has nobody to wait for, so unlike the human seats around it
    // it is not sat out on the way back up.
    for (const p of bots) expect(p.autoPlay).toBe(false);
    expect(seats.find((p) => !p.isBot).autoPlay).toBe(true);
    second.stop();
  });

  // ── Visibility ──────────────────────────────────────────────────────────

  const lastList = (socket) => {
    jest.advanceTimersByTime(300);
    const last = [...socket.emitted].reverse().find((m) => m.event === 'tournamentList');
    return last ? last.payload : [];
  };
  const sent = (socket, event) => socket.emitted.filter((m) => m.event === event);
  const ioSent = (to, event) => io.sent.filter((m) => m.to === to && m.event === event);

  test('a new game is private unless the host says otherwise, and junk reads as private', () => {
    expect(create({ startsAt: Date.now() + 60000 }).entry.settings.visibility).toBe('private');
    registry.stop();
    for (const [given, expected] of [
      ['public', 'public'],
      ['invite', 'invite'],
      ['open', 'private'],
      [42, 'private'],
    ]) {
      io = makeIo();
      live.clear();
      registry = createTournamentRegistry({
        io,
        identity: makeIdentity(names),
        tableOptions: { actionTimeoutMs: 0 },
        connectedSockets: () => live.values(),
      });
      const { entry } = create({ startsAt: Date.now() + 60000, visibility: given });
      expect(entry.settings.visibility).toBe(expected);
      registry.stop();
    }
  });

  test('a stranger sees a public card and nothing else; a member sees their own', () => {
    const host = makeSocket('sh', 'h');
    const pub = create(
      { name: 'Open', startsAt: Date.now() + 60000, visibility: 'public' },
      host
    ).entry;
    registry.leave(pub, 'h', host);
    registry.unregister(pub, 'h', host);
    const priv = create({ name: 'Quiet', startsAt: Date.now() + 60000 }, host).entry;
    const stranger = makeSocket('sx', 'x');
    const seenByStranger = lastList(stranger).map((c) => c.name);
    expect(seenByStranger).toEqual([]);
    expect(registry.publicList().map((c) => c.name)).toEqual([]);
    // The public one went when its only member unregistered; make another.
    const host2 = makeSocket('sh2', 'g');
    const pub2 = registry.create(
      'g',
      { name: 'Open again', startsAt: Date.now() + 60000, visibility: 'public' },
      host2
    ).entry;
    expect(lastList(stranger).map((c) => c.name)).toEqual(['Open again']);
    expect(registry.publicList().map((c) => c.name)).toEqual(['Open again']);
    expect(registry.publicList()[0]).toMatchObject({ visibility: 'public' });
    // The host of the private game sees it, marked, under their own.
    const mine = lastList(host).find((c) => c.id === priv.id);
    expect(mine).toMatchObject({ visibility: 'private', you: { registered: true } });
    void pub2;
  });

  test('an unlisted game cannot be joined by id, only by code; its own host can rejoin by id', () => {
    const host = makeSocket('sh', 'h');
    const { entry } = create({ startsAt: Date.now() + 60000 });
    const guest = makeSocket('sg', 'g');
    expect(registry.join('g', { tournamentId: entry.id }, guest).error).toBe(
      'Tournament not found'
    );
    expect(entry.registrations.has('g')).toBe(false);
    expect(registry.join('g', { code: entry.code }, guest).error).toBeUndefined();
    expect(entry.registrations.has('g')).toBe(true);
    // The host's own card joins by id: the rejoin path comes before the gate.
    registry.startNow(entry, 'h');
    registry.leave(entry, 'h', host);
    expect(registry.join('h', { tournamentId: entry.id }, host).error).toBeUndefined();
    expect(entry.registrations.get('h').left).toBe(false);
  });

  test('knocking on an invite-only game waits at the door, and is none of the things a member is', () => {
    const host = makeSocket('sh', 'h');
    const { entry } = create({ startsAt: Date.now() + 60000, visibility: 'invite' }, host);
    const guest = makeSocket('sg', 'g');
    const result = registry.join('g', { code: entry.code }, guest);
    expect(result.error).toBeUndefined();
    expect(result.pending).toBe(true);
    expect(entry.pending.has('g')).toBe(true);
    expect(entry.registrations.has('g')).toBe(false);
    expect(entry.director.entrants.map((e) => e.uid)).toEqual(['h']);
    expect(guest.data.pendingTournamentId).toBe(entry.id);
    expect(guest.data.tournamentId).toBeUndefined();
    const told = sent(guest, 'tournamentPending');
    expect(told).toHaveLength(1);
    expect(told[0].payload).toMatchObject({ id: entry.id, name: 'Night', hostName: 'Host' });
    expect(told[0].payload).not.toHaveProperty('code');
    // The host sees who is at the door; the asker sees no state at all.
    const hostView = registry.stateFor(entry, 'h');
    expect(hostView.pending).toEqual([
      expect.objectContaining({ uid: 'g', name: 'Guest', connected: true }),
    ]);
    expect(registry.stateFor(entry, 'g')).not.toHaveProperty('pending');
    expect(sent(guest, 'tournamentState')).toHaveLength(0);
    // A card summary counts entrants, not the queue.
    expect(registry.listFor('h').find((c) => c.id === entry.id).entrants).toEqual({
      humans: 1,
      total: 1,
    });
    // And a stranger with the id gets nothing.
    expect(registry.join('t', { tournamentId: entry.id }, makeSocket('st', 't')).error).toBe(
      'Tournament not found'
    );
  });

  test('the host lets somebody in, and they arrive as if they had joined by code', () => {
    const host = makeSocket('sh', 'h');
    const { entry } = create({ startsAt: Date.now() + 60000, visibility: 'invite' }, host);
    const guest = makeSocket('sg', 'g');
    registry.join('g', { code: entry.code }, guest);
    expect(registry.admit(entry, 'g', 'g').error).toMatch(/only the host/i);
    expect(registry.admit(entry, 'h', 'nobody').error).toMatch(/not waiting/i);
    expect(registry.admit(entry, 'h', 'g').error).toBeUndefined();
    expect(entry.pending.size).toBe(0);
    expect(entry.registrations.get('g')).toMatchObject({ socketId: 'sg', left: false });
    expect(entry.director.entrants.map((e) => e.uid)).toEqual(['h', 'g']);
    expect(guest.data).toMatchObject({ tournamentId: entry.id, tournamentUid: 'g' });
    expect(guest.data.pendingTournamentId).toBeNull();
    expect(sent(guest, 'tournamentJoined')[0].payload).toMatchObject({
      id: entry.id,
      code: entry.code,
    });
    expect(lastList(guest).find((c) => c.id === entry.id).you.registered).toBe(true);
  });

  test('turned away, or giving up', () => {
    const host = makeSocket('sh', 'h');
    const { entry } = create({ startsAt: Date.now() + 60000, visibility: 'invite' }, host);
    const g = makeSocket('sg', 'g');
    registry.join('g', { code: entry.code }, g);
    expect(registry.decline(entry, 'g', 'g').error).toMatch(/only the host/i);
    expect(registry.decline(entry, 'h', 'g').ok).toBe(true);
    expect(entry.pending.size).toBe(0);
    expect(ioSent('sg', 'tournamentDeclined')[0].payload).toMatchObject({
      id: entry.id,
      reason: 'declined',
    });
    expect(g.data.pendingTournamentId).toBeNull();

    const t = makeSocket('st', 't');
    registry.join('t', { code: entry.code }, t);
    expect(registry.withdraw(entry, 't', t).error).toBeUndefined();
    expect(entry.pending.size).toBe(0);
    expect(sent(t, 'leftTournament')[0].payload).toMatchObject({
      id: entry.id,
      reason: 'withdrawn',
    });
    expect(registry.withdraw(entry, 't', t).error).toMatch(/not waiting/i);
  });

  test('a name is checked at the door and again at the moment of letting in', () => {
    const host = makeSocket('sh', 'h');
    const { entry } = create({ startsAt: Date.now() + 60000, visibility: 'invite' }, host);
    // 'h' is Host; a knock from somebody also called Host is refused outright.
    const twin = makeSocket('sw', 'w');
    names.w = 'Host';
    expect(registry.join('w', { code: entry.code }, twin).error).toMatch(/name already taken/i);
    delete names.w;
    // Two people with the same free name knock; the first let in takes it.
    names.a = 'Sam';
    names.b = 'Sam';
    const a = makeSocket('sa', 'a');
    const b = makeSocket('sb', 'b');
    registry.join('a', { code: entry.code }, a);
    registry.join('b', { code: entry.code }, b);
    expect(entry.pending.size).toBe(2);
    expect(registry.admit(entry, 'h', 'a').error).toBeUndefined();
    expect(registry.admit(entry, 'h', 'b').error).toMatch(/name already taken/i);
    expect(entry.pending.size).toBe(0);
    expect(ioSent('sb', 'tournamentDeclined')[0].payload.reason).toBe('taken');
    delete names.a;
    delete names.b;
  });

  test('a request survives a short drop and lapses after the grace', () => {
    const host = makeSocket('sh', 'h');
    const { entry } = create({ startsAt: Date.now() + 600000, visibility: 'invite' }, host);
    const g = makeSocket('sg', 'g');
    registry.join('g', { code: entry.code }, g);
    registry.unbindPending(entry, 'g', g);
    expect(entry.pending.get('g').socketId).toBeNull();
    expect(registry.stateFor(entry, 'h').pending[0].connected).toBe(false);
    // Back inside the grace, on a new socket: same request, new socket.
    jest.advanceTimersByTime(2000);
    const g2 = makeSocket('sg2', 'g');
    expect(registry.findPendingByUid('g')).toBe(entry);
    registry.bindPending(entry, 'g', g2, { resumed: true });
    expect(entry.pending.get('g').socketId).toBe('sg2');
    expect(sent(g2, 'tournamentPending')[0].payload.resumed).toBe(true);
    // Gone past the grace: the sweep lets the request go.
    registry.unbindPending(entry, 'g', g2);
    jest.advanceTimersByTime(5000);
    expect(entry.pending.has('g')).toBe(false);
    expect(registry.findPendingByUid('g')).toBeNull();
  });

  test('the door does not hold a game open, start it, or make anyone host', () => {
    const host = makeSocket('sh', 'h');
    const { entry } = create({ startsAt: Date.now() + 5000, visibility: 'invite' }, host);
    const g = makeSocket('sg', 'g');
    registry.join('g', { code: entry.code }, g);
    // One entrant plus one asker is not two entrants.
    expect(registry.startNow(entry, 'h').error).toMatch(/2|two/i);
    jest.advanceTimersByTime(6000);
    expect(entry.status).toBe('registering');
    // The host leaves: the game is empty and goes, and the asker is told.
    registry.unregister(entry, 'h', host);
    expect(registry.tournaments.has(entry.id)).toBe(false);
    expect(ioSent('sg', 'tournamentDeclined')[0].payload.reason).toBe('cancelled');
    expect(g.data.pendingTournamentId).toBeNull();
  });

  test('an overdue invite-only game nobody was let into is cancelled, and the door told', () => {
    const host = makeSocket('sh', 'h');
    const { entry } = create({ startsAt: Date.now() + 1000, visibility: 'invite' }, host);
    const g = makeSocket('sg', 'g');
    registry.join('g', { code: entry.code }, g);
    jest.advanceTimersByTime(1000 + 20000 + 1500);
    expect(registry.tournaments.has(entry.id)).toBe(false);
    expect(ioSent('sg', 'tournamentDeclined')[0].payload.reason).toBe('cancelled');
  });

  test('knocking on a running game goes through late registration, until it closes', () => {
    const host = makeSocket('sh', 'h');
    const { entry } = create(
      { startsAt: Date.now() + 60000, visibility: 'invite', lateRegLevels: 3 },
      host
    );
    const g = makeSocket('sg', 'g');
    registry.join('g', { code: entry.code }, g);
    registry.admit(entry, 'h', 'g');
    registry.startNow(entry, 'h');
    expect(entry.status).toBe('running');
    const late = makeSocket('sl', 't');
    expect(registry.join('t', { code: entry.code }, late).pending).toBe(true);
    expect(registry.admit(entry, 'h', 't').error).toBeUndefined();
    expect(entry.director.playerByUid('t')).toBeTruthy();
    // Late registration closes: whoever is still at the door is told.
    const again = makeSocket('sa', 'a');
    names.a = 'Late Sam';
    registry.join('a', { code: entry.code }, again);
    entry.director.lateRegLevels = 0;
    jest.advanceTimersByTime(1500);
    expect(entry.pending.size).toBe(0);
    expect(ioSent('sa', 'tournamentDeclined')[0].payload.reason).toBe('closed');
    expect(registry.join('a', { code: entry.code }, again).error).toMatch(
      /late registration is closed/i
    );
    delete names.a;
  });

  test('the door is capped', () => {
    const host = makeSocket('sh', 'h');
    const { entry } = create({ startsAt: Date.now() + 60000, visibility: 'invite' }, host);
    for (let i = 0; i < 50; i++) {
      names[`k${i}`] = `Knocker ${i}`;
      expect(
        registry.join(`k${i}`, { code: entry.code }, makeSocket(`sk${i}`, `k${i}`)).pending
      ).toBe(true);
    }
    names.k50 = 'Knocker 50';
    expect(registry.join('k50', { code: entry.code }, makeSocket('sk50', 'k50')).error).toMatch(
      /too many/i
    );
    for (let i = 0; i <= 50; i++) delete names[`k${i}`];
  });

  test('visibility survives a restart; the door does not; an old file reads private', () => {
    const store = makeStore();
    registry.stop();
    io = makeIo();
    live.clear();
    const make = () =>
      createTournamentRegistry({
        io,
        identity: makeIdentity(names),
        store,
        sweepMs: 100000,
        tableOptions: { actionTimeoutMs: 0 },
        connectedSockets: () => live.values(),
      });
    registry = make();
    const host = makeSocket('sh', 'h');
    const inv = registry.create(
      'h',
      { name: 'Door', startsAt: Date.now() + 60000, visibility: 'invite' },
      host
    ).entry;
    registry.join('g', { code: inv.code }, makeSocket('sg', 'g'));
    expect(inv.pending.size).toBe(1);
    registry.flush();
    registry.stop();
    // A file from before the setting existed: no visibility field at all.
    const saved = store.load();
    const legacy = JSON.parse(JSON.stringify(saved[0]));
    legacy.id = 'legacy';
    legacy.code = 'LEGCY';
    delete legacy.settings.visibility;
    store.save([...saved, legacy]);

    registry = make();
    registry.restore();
    const back = registry.tournaments.get(inv.id);
    expect(back.settings.visibility).toBe('invite');
    expect(back.pending.size).toBe(0);
    expect(registry.tournaments.get('legacy').settings.visibility).toBe('private');
  });
});

describe('blind structures in the registry', () => {
  let registry;
  let io;
  const names = { h: 'Host', g: 'Guest' };
  const CUSTOM = {
    name: 'Sunday',
    levels: [
      { sb: 25, bb: 50, ante: 0, duration: 60 },
      { break: true, duration: 90 },
      { sb: 50, bb: 100, ante: 100, duration: 60 },
    ],
  };

  function makeRegistry(store) {
    return createTournamentRegistry({
      io,
      identity: makeIdentity(names),
      sweepMs: 1000,
      store,
      tableOptions: { actionTimeoutMs: 0 },
      connectedSockets: () => live.values(),
      socketById: (id) => live.get(id) || null,
    });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-11T20:00:00Z'));
    io = makeIo();
    live.clear();
    registry = makeRegistry(undefined);
  });

  afterEach(() => {
    registry.stop();
    jest.useRealTimers();
  });

  test('a game runs the structure its host chose, and the ladder rides only in the full state', () => {
    const { entry } = registry.create(
      'h',
      {
        name: 'Fast',
        startsAt: Date.now() + 60000,
        structure: 'turbo',
        levelDuration: 120,
        visibility: 'public',
      },
      makeSocket('sh')
    );
    expect(entry.settings.structure.name).toBe('Turbo');
    expect(entry.settings.structure.levels).toHaveLength(15);
    expect(entry.settings.structure.levels[0].duration).toBe(120);
    expect(entry.director.tournament.blindSchedule).toHaveLength(15);
    expect(entry.director.tournament.blindSchedule[3].ante).toBe(100);

    const full = registry.stateFor(entry, 'h');
    expect(full.structure.name).toBe('Turbo');
    expect(full.structure.levels).toHaveLength(15);
    expect(full.settings.structure).toEqual({
      name: 'Turbo',
      levelCount: 15,
      anteFrom: 4,
      breaks: [],
    });
    const slim = registry.stateFor(entry, 'h', undefined, { includeRoster: false });
    expect(slim.structure).toBeUndefined();
    expect(slim.settings.structure).toEqual(full.settings.structure);

    const card = registry.publicList().find((t) => t.id === entry.id);
    expect(card.structure).toBe('Turbo');
    expect(card.level).toBe(1);
  });

  test('a hand-edited structure is persisted and comes back exactly as it was', () => {
    const store = makeStore();
    const first = makeRegistry(store);
    const { entry } = first.create(
      'h',
      { name: 'Edited', startsAt: Date.now() + 60000, structure: CUSTOM },
      makeSocket('sh')
    );
    expect(entry.settings.structure.name).toBe('Sunday');
    expect(entry.settings.structure.levels).toHaveLength(3);
    first.flush();
    const saved = store.load()[0].settings.structure;
    expect(saved).toEqual(entry.settings.structure);
    first.stop();

    const second = makeRegistry(store);
    expect(second.restore()).toBe(1);
    const back = second.tournaments.get(entry.id);
    expect(back.settings.structure).toEqual(entry.settings.structure);
    expect(back.director.tournament.blindSchedule[1]).toEqual({
      sb: 0,
      bb: 0,
      ante: 0,
      duration: 90,
      break: true,
    });
    expect(back.director.tournament.blindSchedule[2].ante).toBe(100);
    second.stop();
  });

  test('a structure that cannot be played runs Standard', () => {
    const { entry } = registry.create(
      'h',
      { name: 'Junk', startsAt: Date.now() + 60000, structure: { levels: 'nope' } },
      makeSocket('sh')
    );
    expect(entry.settings.structure.name).toBe('Standard');
    expect(entry.settings.structure.levels.filter((r) => !r.break)).toHaveLength(18);
  });

  test('a level change reaches every registered socket as tournamentLevelUp', () => {
    const { entry } = registry.create(
      'h',
      { name: 'Chime', startsAt: Date.now() + 1000, structure: CUSTOM },
      makeSocket('sh')
    );
    registry.join('g', { code: entry.code }, makeSocket('sg'));
    jest.advanceTimersByTime(2000);
    expect(entry.status).toBe('running');
    io.sent.length = 0;
    entry.director.tournament.currentLevel = 1;
    entry.director.tournament.onLevelUp(1, entry.director.tournament.getCurrentBlinds());
    const ups = io.sent.filter((m) => m.event === 'tournamentLevelUp');
    expect(ups.map((m) => m.to).sort()).toEqual(['sg', 'sh']);
    expect(ups[0].payload).toEqual({
      level: 1,
      blinds: { sb: 50, bb: 100, ante: 100 },
      onBreak: true,
      nextLevelIn: expect.any(Number),
    });
    const lines = io.sent.filter((m) => m.event === 'gameMessage').map((m) => m.payload);
    expect(lines).toContain('Break: 90s · play resumes at 50/100 ante 100');
  });
});

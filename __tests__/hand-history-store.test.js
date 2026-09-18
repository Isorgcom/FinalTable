// hand-history-store.test.js - the hands a game was played with, kept.
//
// This is the first store here that deliberately outlives the thing it
// belongs to: a tournament is reaped ten minutes after its winner and its
// chat goes with it, and its hands do not.
//
// It is also the one store that does not hold everything it has: two hundred
// games of hands is not something to keep in memory for the sake of the two
// still being played. So `load` answers only for what is waiting to be
// written or was primed for a restart, and everything else is asked for.
const { createHandHistoryStore } = require('../server/hand-history-store');
const { createMemoryDatabase } = require('../server/db');

const hand = (n, uid) => ({
  hand: {
    handNum: n,
    timestamp: 1_000 + n,
    players: [{ id: `s${n}`, uid, name: 'Ann' }],
    holeCards: { [`s${n}`]: [{ rank: 'A', suit: 'spades' }] },
    actions: [],
    winners: [],
    communityCards: [],
  },
  tableNumber: 1,
  level: 1,
});

describe('the hand history store', () => {
  let db;
  const meta = (extra = {}) => ({
    name: 'Game Night',
    startedAt: 1000,
    endedAt: null,
    uids: ['u_ann', 'u_bob'],
    ...extra,
  });

  // Named, and emptied: a memory database is shared by name so a store made
  // twice finds the same one, which is what a restart looks like here.
  beforeEach(() => {
    db = createMemoryDatabase({ database: 'history-test' });
    db.reset();
  });

  test('without a database every call is a no-op', async () => {
    const store = createHandHistoryStore({});
    expect(() => store.record('t1', meta(), [hand(1, 'u_ann')])).not.toThrow();
    await expect(store.flush()).resolves.toBeUndefined();
    expect(store.load('t1')).toBeNull();
    expect(await store.get('t1')).toBeNull();
    expect(await store.listFor('u_ann')).toEqual([]);
    expect(await store.played('u_ann', 't1')).toBe(false);
  });

  test('a game comes back after a restart, and is listed without being held', async () => {
    const store = createHandHistoryStore({ db });
    store.record('t1', meta(), [hand(1, 'u_ann'), hand(2, 'u_ann')]);
    await store.flush();

    const back = createHandHistoryStore({ db });
    expect(await back.size()).toBe(1);
    // Nothing is in memory until the restore says which games it needs.
    expect(back.load('t1')).toBeNull();
    expect(await back.primeFor(['t1'])).toBe(1);
    expect(back.load('t1').hands).toHaveLength(2);
    expect(back.load('t1').meta.name).toBe('Game Night');
    // And the list is a query, so it answers for a game nobody primed.
    expect(await back.listFor('u_ann')).toEqual([
      { id: 't1', name: 'Game Night', startedAt: 1000, endedAt: expect.any(Number), hands: 2 },
    ]);
    expect((await back.get('t1')).hands).toHaveLength(2);
  });

  // The list is a list of games, not of who else was in them.
  test('the list is only your games, newest first, and never says who else', async () => {
    let clock = 1_000_000;
    const store = createHandHistoryStore({ db, now: () => clock });
    store.record('old', meta({ endedAt: 10 }), [hand(1, 'u_ann')]);
    clock += 1000;
    store.record('new', meta({ endedAt: 20 }), [hand(1, 'u_ann')]);
    clock += 1000;
    store.record('theirs', meta({ endedAt: 30, uids: ['u_bob'] }), [hand(1, 'u_bob')]);
    await store.flush();

    expect((await store.listFor('u_ann')).map((g) => g.id)).toEqual(['new', 'old']);
    expect(JSON.stringify(await store.listFor('u_ann'))).not.toContain('u_bob');
    expect(await store.listFor('u_nobody')).toEqual([]);
  });

  // The uid is the whole authorisation: nobody is handed a game they were not
  // in, and a game that is gone is not pretended into existence.
  test('played() is what stands between a player and somebody else’s game', async () => {
    const store = createHandHistoryStore({ db });
    store.record('t1', meta({ uids: ['u_ann'] }), [hand(1, 'u_ann')]);
    await store.flush();
    expect(await store.played('u_ann', 't1')).toBe(true);
    expect(await store.played('u_bob', 't1')).toBe(false);
    expect(await store.played('u_ann', 'no-such-game')).toBe(false);
    expect(await store.played(null, 't1')).toBe(false);
  });

  test('the age bound takes a game away, whatever the count', async () => {
    let clock = 1_000_000;
    const store = createHandHistoryStore({ db, ttlMs: 1000, now: () => clock });
    store.record('t1', meta({ endedAt: clock }), [hand(1, 'u_ann')]);
    await store.flush();
    expect(await store.listFor('u_ann')).toHaveLength(1);

    clock += 5000;
    expect(await store.prune()).toBe(1);
    expect(await store.listFor('u_ann')).toEqual([]);
    expect(await store.get('t1')).toBeNull();
  });

  test('the count bound takes the oldest, whatever the age', async () => {
    let clock = 1_000_000;
    const store = createHandHistoryStore({ db, maxGames: 2, now: () => clock });
    for (const n of [1, 2, 3]) {
      clock += 1000;
      store.record(`t${n}`, meta({ endedAt: clock }), [hand(n, 'u_ann')]);
    }
    await store.flush();
    expect(await store.prune()).toBe(1);
    expect((await store.listFor('u_ann')).map((g) => g.id)).toEqual(['t3', 't2']);
  });

  // A game taken away takes the row saying who played in it with it, which is
  // what the foreign key is for: nobody is left owning a game that is gone.
  test('a game removed is gone, and nobody played in it any more', async () => {
    const store = createHandHistoryStore({ db });
    store.record('t1', meta(), [hand(1, 'u_ann')]);
    await store.flush();
    await store.remove('t1');
    expect(await store.get('t1')).toBeNull();
    expect(await store.played('u_ann', 't1')).toBe(false);
    expect(await store.listFor('u_ann')).toEqual([]);
  });

  test('a burst collapses into one write, and none of it is lost', async () => {
    const store = createHandHistoryStore({ db, flushDebounceMs: 5 });
    for (let n = 1; n <= 20; n++) store.record('t1', meta(), [hand(n, 'u_ann')]);
    await store.flush();
    expect((await store.get('t1')).hands).toHaveLength(1);
    expect(await store.size()).toBe(1);
  });

  // The write is debounced by a second. A game cancelled and asked for in the
  // same breath must not read as empty because the database has not caught up.
  test('what is recorded is readable before it is written', async () => {
    const store = createHandHistoryStore({ db, flushDebounceMs: 10_000 });
    store.record('t1', meta(), [hand(1, 'u_ann')]);
    expect(await db.games.get('t1')).toBeNull();
    expect(store.load('t1').hands).toHaveLength(1);
    expect((await store.get('t1')).hands).toHaveLength(1);
    expect(await store.listFor('u_ann')).toHaveLength(1);
    expect(await store.played('u_ann', 't1')).toBe(true);
  });

  test('flush settles what is waiting, so shutdown can rely on it', async () => {
    const store = createHandHistoryStore({ db, flushDebounceMs: 10_000 });
    store.record('t1', meta(), [hand(1, 'u_ann')]);
    await store.flush();
    expect((await db.games.get('t1')).hands).toHaveLength(1);
  });
});

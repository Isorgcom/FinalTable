// hand-history-store.test.js - the hands a game was played with, kept.
//
// This is the first store here that deliberately outlives the thing it
// belongs to: a tournament is reaped ten minutes after its winner and its
// chat goes with it, and its hands do not.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHandHistoryStore } = require('../server/hand-history-store');

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
  let dir;
  const meta = (extra = {}) => ({
    name: 'Game Night',
    startedAt: 1000,
    endedAt: null,
    uids: ['u_ann', 'u_bob'],
    ...extra,
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-history-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('without a directory every call is a no-op', () => {
    const store = createHandHistoryStore({});
    expect(() => store.record('t1', meta(), [hand(1, 'u_ann')])).not.toThrow();
    expect(() => store.flush()).not.toThrow();
    expect(store.load('t1')).toBeNull();
    expect(store.listFor('u_ann')).toEqual([]);
  });

  test('a game comes back after a restart, index and all', () => {
    const store = createHandHistoryStore({ saveDir: dir });
    store.record('t1', meta(), [hand(1, 'u_ann'), hand(2, 'u_ann')]);
    store.flush();

    const back = createHandHistoryStore({ saveDir: dir });
    expect(back.size()).toBe(1);
    const kept = back.load('t1');
    expect(kept.hands).toHaveLength(2);
    expect(kept.meta.name).toBe('Game Night');
    expect(back.listFor('u_ann')).toEqual([
      { id: 't1', name: 'Game Night', startedAt: 1000, endedAt: expect.any(Number), hands: 2 },
    ]);
  });

  // The list is a list of games, not of who else was in them.
  test('the list is only your games, newest first, and never says who else', () => {
    let clock = 1_000_000;
    const store = createHandHistoryStore({ saveDir: dir, now: () => clock });
    store.record('old', meta({ endedAt: 10 }), [hand(1, 'u_ann')]);
    clock += 1000;
    store.record('new', meta({ endedAt: 20 }), [hand(1, 'u_ann')]);
    clock += 1000;
    store.record('theirs', meta({ endedAt: 30, uids: ['u_bob'] }), [hand(1, 'u_bob')]);

    expect(store.listFor('u_ann').map((g) => g.id)).toEqual(['new', 'old']);
    expect(JSON.stringify(store.listFor('u_ann'))).not.toContain('u_bob');
    expect(store.listFor('u_nobody')).toEqual([]);
  });

  // The uid is the whole authorisation: nobody is handed a game they were not
  // in, and a game that is gone is not pretended into existence.
  test('played() is what stands between a player and somebody else’s game', () => {
    const store = createHandHistoryStore({ saveDir: dir });
    store.record('t1', meta({ uids: ['u_ann'] }), [hand(1, 'u_ann')]);
    expect(store.played('u_ann', 't1')).toBe(true);
    expect(store.played('u_bob', 't1')).toBe(false);
    expect(store.played('u_ann', 'no-such-game')).toBe(false);
    expect(store.played(null, 't1')).toBe(false);
  });

  test('the age bound takes a game away, whatever the count', () => {
    let clock = 1_000_000;
    const store = createHandHistoryStore({ saveDir: dir, ttlMs: 1000, now: () => clock });
    store.record('t1', meta({ endedAt: clock }), [hand(1, 'u_ann')]);
    store.flush();
    expect(store.listFor('u_ann')).toHaveLength(1);

    clock += 5000;
    expect(store.prune()).toBe(1);
    expect(store.listFor('u_ann')).toEqual([]);
    expect(store.load('t1')).toBeNull();
  });

  test('the count bound takes the oldest, whatever the age', () => {
    let clock = 1_000_000;
    const store = createHandHistoryStore({ saveDir: dir, maxGames: 2, now: () => clock });
    for (const n of [1, 2, 3]) {
      clock += 1000;
      store.record(`t${n}`, meta({ endedAt: clock }), [hand(n, 'u_ann')]);
    }
    store.flush();
    expect(store.prune()).toBe(1);
    expect(store.listFor('u_ann').map((g) => g.id)).toEqual(['t3', 't2']);
  });

  // A crash between writing a game and writing the index would otherwise
  // leave a file nothing can ever reach or remove.
  test('a file the index has never heard of is swept', () => {
    const store = createHandHistoryStore({ saveDir: dir });
    store.record('t1', meta(), [hand(1, 'u_ann')]);
    store.flush();
    fs.writeFileSync(path.join(dir, 'history', 'stray.json'), '{"version":1,"hands":[]}');
    expect(store.prune()).toBe(1);
    expect(fs.existsSync(path.join(dir, 'history', 'stray.json'))).toBe(false);
    expect(store.load('t1')).not.toBeNull();
  });

  test('a corrupt game reads as absent and a corrupt index starts empty', () => {
    const store = createHandHistoryStore({ saveDir: dir });
    store.record('t1', meta(), [hand(1, 'u_ann')]);
    store.flush();
    fs.writeFileSync(path.join(dir, 'history', 't1.json'), '{not json');
    expect(store.load('t1')).toBeNull();

    fs.writeFileSync(path.join(dir, 'history', '_index.json'), 'also not json');
    const back = createHandHistoryStore({ saveDir: dir });
    expect(back.size()).toBe(0);
    expect(back.listFor('u_ann')).toEqual([]);
  });

  test('a burst collapses into one write, and none of it is lost', async () => {
    const store = createHandHistoryStore({ saveDir: dir, flushDebounceMs: 5 });
    for (let n = 1; n <= 20; n++) store.record('t1', meta(), [hand(n, 'u_ann')]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(store.load('t1').hands).toHaveLength(1);
    expect(fs.readdirSync(path.join(dir, 'history')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  // The write is debounced by a second. A game cancelled and asked for in the
  // same breath must not read as empty because the disk has not caught up.
  test('what is recorded is readable before it is written', () => {
    const store = createHandHistoryStore({ saveDir: dir, flushDebounceMs: 10_000 });
    store.record('t1', meta(), [hand(1, 'u_ann')]);
    expect(fs.existsSync(path.join(dir, 'history', 't1.json'))).toBe(false);
    expect(store.load('t1').hands).toHaveLength(1);
    expect(store.listFor('u_ann')).toHaveLength(1);
  });

  test('flush is synchronous, so shutdown can rely on it', () => {
    const store = createHandHistoryStore({ saveDir: dir });
    store.record('t1', meta(), [hand(1, 'u_ann')]);
    store.flush();
    // No await: both the game and the index are on disk by the time it returns.
    const file = path.join(dir, 'history', 't1.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).hands).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'history', '_index.json'))).toBe(true);
  });
});

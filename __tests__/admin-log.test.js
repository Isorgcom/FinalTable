// __tests__/admin-log.test.js - what the server has done, kept.
const { createAdminLog } = require('../server/admin-log');
const { createStructuredLogger, onEntry } = require('../server/logger');
const { createMemoryDatabase } = require('../server/db');

describe('admin log', () => {
  let db;

  // Named, and emptied: a memory database is shared by name so a log made
  // twice finds the same one, which is what a restart looks like here.
  beforeEach(() => {
    db = createMemoryDatabase({ database: 'admin-log-test' });
    db.reset();
  });

  // What is actually written down, newest first, the way load() reads it.
  const written = (limit = 1000) => db.adminLog.recent(limit);

  test('without a database every call is a no-op', async () => {
    const log = createAdminLog({});
    expect(() => log.recordServer({ level: 'warn', event: 'x', message: 'y' })).not.toThrow();
    await expect(log.flush()).resolves.toBeUndefined();
    expect(await log.load()).toBe(0);
    // It still holds rows in memory; it is the database that is absent.
    log.recordServer({ level: 'warn', event: 'x', message: 'y' });
    expect(log.size()).toBe(1);
  });

  test('a row comes back after a restart', async () => {
    const log = createAdminLog({ db });
    log.recordGame({ id: 't_1', name: 'Tuesday', ended: 'finished', winner: 'Ann', entrants: 6 });
    await log.flush();

    const back = createAdminLog({ db });
    expect(await back.load()).toBe(1);
    const { rows } = back.list();
    expect(rows[0]).toMatchObject({
      kind: 'game',
      name: 'Tuesday',
      ended: 'finished',
      winner: 'Ann',
      entrants: 6,
    });
  });

  // Two bounds rather than one: the age is what an admin thinks in, the count
  // is what stops a busy fortnight from mattering, and neither covers the
  // other's case.
  test('the count bound drops the oldest', async () => {
    const log = createAdminLog({ db, maxRows: 3 });
    for (let i = 1; i <= 6; i++) log.recordServer({ event: 'e' + i, message: 'm' + i });
    expect(log.size()).toBe(3);
    const { rows } = log.list();
    expect(rows.map((r) => r.event)).toEqual(['e6', 'e5', 'e4']);
    // And the database is held to the same bound rather than growing behind it.
    await log.flush();
    expect((await written()).map((r) => r.event)).toEqual(['e6', 'e5', 'e4']);
  });

  test('the age bound drops what is old, whatever the count', async () => {
    let clock = 1_000_000;
    const log = createAdminLog({ db, maxAgeMs: 1000, now: () => clock });
    log.recordServer({ event: 'old', message: 'a while back' });
    clock += 5000;
    log.recordServer({ event: 'fresh', message: 'just now' });
    expect(log.size()).toBe(1);
    expect(log.list().rows[0].event).toBe('fresh');
    await log.flush();
    expect((await written()).map((r) => r.event)).toEqual(['fresh']);
  });

  test('a row that aged out while the process was down is pruned on load', async () => {
    let clock = 1_000_000;
    const first = createAdminLog({ db, maxAgeMs: 10_000, now: () => clock });
    first.recordServer({ event: 'before', message: 'the lights went out' });
    await first.flush();

    clock += 60_000;
    const back = createAdminLog({ db, maxAgeMs: 10_000, now: () => clock });
    expect(await back.load()).toBe(0);
    expect(back.list().rows).toEqual([]);
  });

  test('a burst collapses into one write, and none of it is lost', async () => {
    const log = createAdminLog({ db, flushDebounceMs: 5 });
    for (let i = 0; i < 20; i++) log.recordServer({ event: 'e' + i, message: 'm' + i });
    await log.flush();
    expect(await written()).toHaveLength(20);
  });

  test('flush settles what is waiting, so shutdown can rely on it', async () => {
    const log = createAdminLog({ db, flushDebounceMs: 10_000 });
    log.recordServer({ event: 'bye', message: 'on the way out' });
    expect(await written()).toHaveLength(0);
    await log.flush();
    expect(await written()).toHaveLength(1);
  });

  test('rows are paged newest first, and the cursor is stable', () => {
    const log = createAdminLog({ db });
    for (let i = 1; i <= 10; i++) log.recordServer({ event: 'e' + i, message: 'm' + i });
    const first = log.list({ limit: 4 });
    expect(first.rows.map((r) => r.event)).toEqual(['e10', 'e9', 'e8', 'e7']);
    expect(first.more).toBe(true);
    const next = log.list({ limit: 4, before: first.rows[first.rows.length - 1].id });
    expect(next.rows.map((r) => r.event)).toEqual(['e6', 'e5', 'e4', 'e3']);
    const last = log.list({ limit: 4, before: next.rows[next.rows.length - 1].id });
    expect(last.rows.map((r) => r.event)).toEqual(['e2', 'e1']);
    expect(last.more).toBe(false);
  });

  // The rule the roadmap sets, asserted against what is stored rather than the
  // object: this is a log a browser can read, so a leak here is a leak
  // everywhere. Every row is built from an allowlist, and this is what proves
  // the allowlist is doing its job when a caller hands over more than it should.
  test('nothing a browser must not see is written down', async () => {
    const log = createAdminLog({ db });
    log.recordGame({
      id: 't_1',
      name: 'Tuesday',
      ended: 'finished',
      winner: 'Ann',
      code: 'SECRETCODE',
      holeCards: [{ rank: 'A', suit: 'spades' }],
      places: [{ place: 1, name: 'Ann', prize: 500, uid: 'u_ann', token: 'device-token-here' }],
    });
    log.recordSignIn({
      uid: 'u_ann',
      name: 'Ann',
      provider: 'gamenight',
      token: 'device-token-here',
      password: 'hunter2',
    });
    log.recordServer({
      level: 'error',
      event: 'uncaught_exception',
      message: 'Unhandled server exception',
      detail: 'Error: something broke',
      password: 'hunter2',
      stack: 'at secret',
    });
    await log.flush();

    const raw = JSON.stringify(await written());
    for (const forbidden of ['SECRETCODE', 'device-token-here', 'hunter2', 'holeCards', 'spades']) {
      expect(`${forbidden}: ${raw.includes(forbidden) ? 'leaked' : 'absent'}`).toBe(
        `${forbidden}: absent`
      );
    }
    // And what should be there, is.
    expect(raw).toContain('Tuesday');
    expect(raw).toContain('Unhandled server exception');
  });

  // A row used to go in on every identify - every page load, every reload,
  // every reconnect. One evening of testing put eight rows in for one person
  // and one for the game they played, against a ring that eventually pushes
  // the older thing off the end.
  describe('one row a visit, not one a hello', () => {
    test('a reload inside the window is the same visit', () => {
      let clock = 1_000_000;
      const log = createAdminLog({ db, signInGapMs: 60_000, now: () => clock });
      expect(log.recordSignIn({ uid: 'u1', name: 'Ann' })).toBeTruthy();
      clock += 5_000;
      expect(log.recordSignIn({ uid: 'u1', name: 'Ann' })).toBeNull();
      clock += 5_000;
      expect(log.recordSignIn({ uid: 'u1', name: 'Ann' })).toBeNull();
      expect(log.list().rows).toHaveLength(1);

      // Long enough away and it is a visit of its own.
      clock += 60_001;
      expect(log.recordSignIn({ uid: 'u1', name: 'Ann' })).toBeTruthy();
      expect(log.list().rows).toHaveLength(2);
    });

    test('somebody else is always their own row', () => {
      const log = createAdminLog({ db });
      log.recordSignIn({ uid: 'u1', name: 'Ann' });
      log.recordSignIn({ uid: 'u2', name: 'Bob' });
      expect(log.list().rows.map((r) => r.name)).toEqual(['Bob', 'Ann']);
    });

    // Somebody the server has never seen is worth knowing about whatever else
    // is going on, and a new identity has a uid of its own anyway.
    test('a brand new identity is written down whatever the window says', () => {
      let clock = 1_000_000;
      const log = createAdminLog({ db, signInGapMs: 60_000, now: () => clock });
      log.recordSignIn({ uid: 'u1', name: 'Ann' });
      clock += 1_000;
      expect(log.recordSignIn({ uid: 'u1', name: 'Ann', isNew: true })).toBeTruthy();
      expect(log.list().rows).toHaveLength(2);
    });

    test('a restart does not restart everybody\u2019s visit', async () => {
      let clock = 1_000_000;
      const first = createAdminLog({ db, signInGapMs: 60_000, now: () => clock });
      first.recordSignIn({ uid: 'u1', name: 'Ann' });
      await first.flush();

      clock += 5_000;
      const back = createAdminLog({ db, signInGapMs: 60_000, now: () => clock });
      expect(await back.load()).toBe(1);
      expect(back.recordSignIn({ uid: 'u1', name: 'Ann' })).toBeNull();
      expect(back.list().rows).toHaveLength(1);
    });

    test('zero keeps every one of them, for anybody who wants that', () => {
      const log = createAdminLog({ db, signInGapMs: 0 });
      log.recordSignIn({ uid: 'u1', name: 'Ann' });
      log.recordSignIn({ uid: 'u1', name: 'Ann' });
      expect(log.list().rows).toHaveLength(2);
    });
  });

  test('a long detail is cut rather than kept whole', () => {
    const log = createAdminLog({ db });
    log.recordServer({ level: 'error', event: 'e', message: 'm', detail: 'x'.repeat(5000) });
    const row = log.list().rows[0];
    expect(row.detail.length).toBeLessThan(600);
  });
});

// The capture point. A logger is built once per scope at require time, so a
// subscriber that arrives later still has to hear from every one of them -
// which is what lets the admin log keep warnings raised by code that knows
// nothing about it.
describe('the logger sink', () => {
  test('a subscriber hears every logger, including ones made before it', () => {
    const early = createStructuredLogger('early');
    const seen = [];
    const off = onEntry((entry) => seen.push(entry));
    const late = createStructuredLogger('late');
    try {
      early({ level: 'warn', event: 'first', message: 'from before' });
      late({ level: 'error', event: 'second', message: 'from after' });
    } finally {
      off();
    }
    expect(seen.map((e) => [e.scope, e.event])).toEqual([
      ['early', 'first'],
      ['late', 'second'],
    ]);
  });

  test('unsubscribing stops it, and a throwing subscriber does not stop the log', () => {
    const log = createStructuredLogger('scope');
    const seen = [];
    const offBad = onEntry(() => {
      throw new Error('a listener misbehaving');
    });
    const off = onEntry((entry) => seen.push(entry.event));
    expect(() => log({ level: 'warn', event: 'one', message: 'm' })).not.toThrow();
    off();
    offBad();
    log({ level: 'warn', event: 'two', message: 'm' });
    expect(seen).toEqual(['one']);
  });
});

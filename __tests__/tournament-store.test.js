// __tests__/tournament-store.test.js - the games this server is running, kept.
const { createTournamentStore } = require('../server/tournament-store');
const { createMemoryDatabase } = require('../server/db');

describe('tournament store', () => {
  let db;
  let n = 0;
  beforeEach(() => {
    db = createMemoryDatabase({ database: `tstore-${n++}` });
    db.reset();
  });

  test('round-trips a list and survives a new store instance', async () => {
    const store = createTournamentStore({ db });
    expect(await store.load()).toEqual([]);
    await store.save([{ id: 't_1', status: 'registering', code: 'ABCDE', name: 'Night' }]);

    const back = createTournamentStore({ db });
    expect(await back.load()).toEqual([
      { id: 't_1', status: 'registering', code: 'ABCDE', name: 'Night' },
    ]);
    // And what it read is what a restore will see, without asking again.
    expect(back.saved()).toHaveLength(1);
  });

  // The registry hands over the whole list every time: anything not in it has
  // been cancelled, finished or swept.
  test('saving a shorter list forgets what is not in it', async () => {
    const store = createTournamentStore({ db });
    await store.save([
      { id: 't_1', status: 'registering' },
      { id: 't_2', status: 'running' },
    ]);
    await store.save([{ id: 't_2', status: 'running' }]);

    const back = createTournamentStore({ db });
    expect((await back.load()).map((t) => t.id)).toEqual(['t_2']);
  });

  test('a database that will not answer reads as empty rather than throwing', async () => {
    const broken = {
      ...db,
      tournaments: {
        all: () => Promise.reject(new Error('nope')),
        replaceAll: () => Promise.reject(new Error('nope')),
      },
    };
    const said = [];
    const store = createTournamentStore({ db: broken, log: (e) => said.push(e.event) });
    expect(await store.load()).toEqual([]);
    // And a write that fails says so rather than taking the server down.
    await expect(store.save([{ id: 'x' }])).resolves.toBeUndefined();
    expect(said).toEqual(['tournaments_load_failed', 'tournaments_write_failed']);
  });

  test('without a database it is a no-op', async () => {
    const store = createTournamentStore();
    await store.save([{ id: 'x' }]);
    expect(await store.load()).toEqual([]);
    expect(store.saved()).toEqual([]);
  });
});

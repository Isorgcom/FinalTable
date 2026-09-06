// __tests__/tournament-store.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTournamentStore } = require('../server/tournament-store');

describe('tournament store', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finaltable-tstore-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('round-trips a list and survives a new store instance', () => {
    const store = createTournamentStore({ saveDir: dir });
    expect(store.load()).toEqual([]);
    store.save([{ id: 't_1', code: 'ABCDE', name: 'Night' }]);
    expect(createTournamentStore({ saveDir: dir }).load()).toEqual([
      { id: 't_1', code: 'ABCDE', name: 'Night' },
    ]);
  });

  test('a corrupt file starts empty', () => {
    fs.writeFileSync(path.join(dir, 'tournaments.json'), '{oops');
    expect(createTournamentStore({ saveDir: dir }).load()).toEqual([]);
  });

  test('without a directory it is a no-op', () => {
    const store = createTournamentStore();
    store.save([{ id: 'x' }]);
    expect(store.load()).toEqual([]);
  });
});

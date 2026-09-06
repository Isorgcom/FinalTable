const { PokerGame } = require('../engine');

describe('room host state', () => {
  test('marks the matching human player as host in player-specific state', () => {
    const game = new PokerGame('host-room');
    const alice = game.addPlayer({ id: 'p1', name: 'Alice' });
    game.addPlayer({ id: 'p2', name: 'Bob' });
    game.hostPlayerId = alice.uid;

    expect(game.getStateForPlayer('p1')).toMatchObject({
      hostName: 'Alice',
      isHost: true,
    });
    expect(game.getStateForPlayer('p2')).toMatchObject({
      hostName: 'Alice',
      isHost: false,
    });
  });

  test('host survives a rename, because identity is the uid not the name', () => {
    const game = new PokerGame('host-rename');
    const alice = game.addPlayer({ id: 'p1', name: 'Alice' });
    game.addPlayer({ id: 'p2', name: 'Bob' });
    game.hostPlayerId = alice.uid;

    alice.name = 'Alicia';

    const state = game.getStateForPlayer('p1');
    expect(state.isHost).toBe(true);
    expect(state.hostName).toBe('Alicia');
  });

  test('a player cannot inherit host authority by taking the host name', () => {
    const game = new PokerGame('host-impersonate');
    const alice = game.addPlayer({ id: 'p1', name: 'Alice' });
    const mallory = game.addPlayer({ id: 'p2', name: 'Mallory' });
    game.hostPlayerId = alice.uid;

    // The server blocks duplicate names, but host authority must not depend on
    // that invariant holding: even an exact name collision confers nothing.
    mallory.name = 'Alice';

    expect(game.getStateForPlayer('p2').isHost).toBe(false);
    expect(game.getStateForPlayer('p1').isHost).toBe(true);
  });

  test('uid survives a reconnect, which reassigns the socket id', () => {
    const game = new PokerGame('host-reconnect');
    const alice = game.addPlayer({ id: 'sock-1', name: 'Alice' });
    game.hostPlayerId = alice.uid;
    const originalUid = alice.uid;

    // What the reconnect path does: same player object, new socket id.
    alice.id = 'sock-2';

    expect(alice.uid).toBe(originalUid);
    expect(game.getStateForPlayer('sock-2').isHost).toBe(true);
  });

  test('uids are unique per seat', () => {
    const game = new PokerGame('host-uids');
    const a = game.addPlayer({ id: 'p1', name: 'Alice' });
    const b = game.addPlayer({ id: 'p2', name: 'Bob' });
    expect(a.uid).toBeTruthy();
    expect(b.uid).toBeTruthy();
    expect(a.uid).not.toBe(b.uid);
  });
});

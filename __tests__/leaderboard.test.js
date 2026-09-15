// leaderboard.test.js - the record of who has played what.
//
// A table keeps one keyed by name, which is all a single room needs. A
// tournament keeps one for the whole field keyed by uid, because a player is
// carried between tables and their record has to go with them.
const { Leaderboard } = require('../hand-history');

// A finished hand, in the shape handHistory.finishHand returns: players hold
// the identity, actions and winners point back at the seat id the hand was
// dealt with.
function hand({ players, winners = [], actions = [] }) {
  return { players, winners, actions, pot: 0 };
}

const seat = (id, uid, name, chips = 1000) => ({ id, uid, name, chips, seatIndex: 0 });

describe('Leaderboard', () => {
  test('by default it keys by name, as a single table always has', () => {
    const lb = new Leaderboard();
    lb.update(hand({ players: [seat('s1', 'u1', 'Ann'), seat('s2', 'u2', 'Bob')] }));
    // Ann reconnects and is dealt again under a new socket id.
    lb.update(hand({ players: [seat('s9', 'u1', 'Ann')] }));
    const rows = lb.getRankings();
    expect(rows).toHaveLength(2);
    expect(lb.getPlayerStats('Ann').handsPlayed).toBe(2);
    expect(lb.getPlayerStats('Bob').handsPlayed).toBe(1);
  });

  // The whole point of the field-wide board: the seat id changes on a
  // reconnect and again on a move to another table, and neither is a new
  // player.
  test('keyed by uid, one player is one row however their seat changed', () => {
    const lb = new Leaderboard({ keyBy: (p) => p.uid });
    lb.update(hand({ players: [seat('table1-seat', 'u1', 'Ann')] }));
    lb.update(hand({ players: [seat('table2-seat', 'u1', 'Ann')] }));
    expect(lb.getRankings()).toHaveLength(1);
    expect(lb.getPlayerStats('u1').handsPlayed).toBe(2);
  });

  test('a rename follows the uid rather than splitting the record', () => {
    const lb = new Leaderboard({ keyBy: (p) => p.uid });
    lb.update(hand({ players: [seat('s1', 'u1', 'Ann')] }));
    lb.update(hand({ players: [seat('s1', 'u1', 'Annie')] }));
    const rows = lb.getRankings();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Annie');
    expect(rows[0].handsPlayed).toBe(2);
  });

  test('a player with no key at all is skipped rather than collected under one', () => {
    const lb = new Leaderboard({ keyBy: (p) => p.uid });
    lb.update(
      hand({ players: [{ id: 's1', name: 'Nobody', chips: 10 }, seat('s2', 'u2', 'Bob')] })
    );
    expect(lb.getRankings().map((r) => r.name)).toEqual(['Bob']);
  });

  test('winnings, wins and the biggest pot are counted off the winners', () => {
    const lb = new Leaderboard({ keyBy: (p) => p.uid });
    lb.update(
      hand({
        players: [seat('s1', 'u1', 'Ann'), seat('s2', 'u2', 'Bob')],
        winners: [{ playerId: 's1', playerName: 'Ann', amount: 400, handName: 'Two pair' }],
        actions: [{ phase: 'preflop', playerId: 's2', action: 'fold' }],
      })
    );
    lb.update(
      hand({
        players: [seat('s1', 'u1', 'Ann'), seat('s2', 'u2', 'Bob')],
        winners: [{ playerId: 's1', playerName: 'Ann', amount: 120, handName: 'A pair' }],
      })
    );
    const ann = lb.getPlayerStats('u1');
    expect(ann).toMatchObject({ handsPlayed: 2, handsWon: 2, totalWinnings: 520, biggestPot: 400 });
    const bob = lb.getPlayerStats('u2');
    expect(bob).toMatchObject({ handsPlayed: 2, handsWon: 0, biggestPot: 0, foldCount: 1 });
  });

  // A tournament is written down between hands and read back after a restart.
  // A board that starts again from zero halfway through is worse than none.
  test('the whole board survives a round trip through JSON', () => {
    const lb = new Leaderboard({ keyBy: (p) => p.uid });
    lb.update(
      hand({
        players: [seat('s1', 'u1', 'Ann'), seat('s2', 'u2', 'Bob')],
        winners: [{ playerId: 's2', playerName: 'Bob', amount: 90 }],
      })
    );
    const saved = JSON.parse(JSON.stringify(lb.toJSON()));

    const back = new Leaderboard({ keyBy: (p) => p.uid });
    expect(back.load(saved)).toBe(2);
    expect(back.getRankings()).toEqual(lb.getRankings());
    // And it carries on from there rather than starting again.
    back.update(hand({ players: [seat('s1', 'u1', 'Ann')] }));
    expect(back.getPlayerStats('u1').handsPlayed).toBe(2);
  });

  test('a missing or broken saved board loads as empty rather than throwing', () => {
    const lb = new Leaderboard({ keyBy: (p) => p.uid });
    expect(lb.load(undefined)).toBe(0);
    expect(lb.load([null, {}, { key: 'u1', name: 'Ann', handsPlayed: 3 }])).toBe(1);
    expect(lb.getPlayerStats('u1').handsPlayed).toBe(3);
  });
});

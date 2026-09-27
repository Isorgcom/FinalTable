// __tests__/engine-games.test.js - the engine playing games other than
// Hold'em, and betting under a limit. Hold'em's own behaviour is engine.test.js;
// this is what a definition changes.
const { PokerGame: BasePokerGame } = require('../engine');
const { suitRank } = require('../games');

const activeGames = new Set();
class PokerGame extends BasePokerGame {
  constructor(...args) {
    super(...args);
    activeGames.add(this);
  }
}
afterEach(() => {
  for (const game of activeGames) game.stop();
  activeGames.clear();
});

const VALUES = {
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  9: 9,
  10: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};
const SUITS = { h: 'hearts', d: 'diamonds', c: 'clubs', s: 'spades' };
// 'Kh' is a card down; 'Kh!' is the same card face up.
function card(spec) {
  const up = spec.endsWith('!');
  const s = up ? spec.slice(0, -1) : spec;
  const rank = s.slice(0, -1);
  return { rank, suit: SUITS[s.slice(-1)], value: VALUES[rank], ...(up ? { up: true } : {}) };
}
const cards = (...specs) => specs.map(card);

// A table with seats in the order given, so a test can say which seat is
// which. The engine seats a first-hand arrival at random otherwise.
function table(options = {}, names = ['A', 'B', 'C']) {
  const game = new PokerGame('t', { smallBlind: 10, bigBlind: 20, ...options });
  game.onMessage = () => {};
  game.onUpdate = () => {};
  game.onRoundEnd = () => {};
  const players = names.map((name, i) => game.addPlayer({ id: name, name, seatIndex: i }));
  return { game, players };
}

// The seat to act does the thing.
function act(game, action, amount) {
  const cur = game.players[game.currentPlayerIndex];
  return game.handleAction(cur.id, action, amount);
}

describe('Omaha', () => {
  test('deals four cards down to every seat, and plays pot-limit by default', () => {
    const { game, players } = table({ game: 'omaha' });
    expect(game.game.key).toBe('omaha');
    expect(game.limit).toBe('pot');
    expect(game.startRound()).toBe(true);
    expect(game.phase).toBe('preflop');
    expect(game.streetIndex).toBe(0);
    for (const p of players) {
      expect(p.holeCards).toHaveLength(4);
      expect(p.holeCards.every((c) => !c.up)).toBe(true);
    }
    expect(game.communityCards).toHaveLength(0);
    // The blinds are the blinds, as in Hold'em.
    expect(game.players[game.sbIndex].bet).toBe(10);
    expect(game.players[game.bbIndex].bet).toBe(20);
    const state = game.getStateForPlayer('A');
    expect(state.game).toMatchObject({
      key: 'omaha',
      family: 'community',
      holeCards: 4,
      firstDeal: 4,
      hasBoard: true,
      limit: 'pot',
      limitName: 'Pot-limit',
    });
    expect(state.game.streets.map((s) => s.key)).toEqual(['preflop', 'flop', 'turn', 'river']);
    expect(state.myHand.rank).toBe(0);
    expect(state.players.find((p) => p.id === 'B').holeCards).toBeNull();
  });

  test('a showdown scores exactly two from the hand: a four-flush board is no flush', () => {
    const { game, players } = table({ game: 'omaha' }, ['A', 'B']);
    game.startRound();
    const [a, b] = players;
    a.holeCards = cards('Ah', '2c', '9d', 'Ks');
    b.holeCards = cards('Qc', 'Qd', '7s', '4s');
    game.communityCards = cards('Kh', 'Qh', 'Jh', '3h', '2d');
    game.phase = 'river';
    a.bet = 0;
    b.bet = 0;
    a.totalBet = 100;
    b.totalBet = 100;
    game.pot = 200;
    game.showdown();
    // A's one heart makes no flush; two pair, kings and twos. B has three queens.
    expect(game.lastRoundWinnerIds).toEqual(['B']);
    expect(game.handHistory.hands[0].winners[0].handName).toBe('Three of a Kind');
    // Every card was turned over, not two.
    expect(game.handHistory.hands[0].shownCards.A).toEqual([0, 1, 2, 3]);
  });

  test('pot-limit: a raise is clamped to the pot, and a shove past it is a pot raise', () => {
    const { game, players } = table({ game: 'omaha' });
    game.startRound();
    // Seat 0 is the dealer and opens: 30 in the middle, 20 to call, so the
    // most is 20 + 50 = 70 however much was asked for.
    expect(game.currentPlayerIndex).toBe(0);
    expect(game.getStateForPlayer('A').betting).toEqual({ minTo: 40, maxTo: 70, fixed: false });
    act(game, 'raise', 500);
    expect(players[0].bet).toBe(70);
    expect(game.currentBet).toBe(70);
    // The small blind, 10 in, has 60 to call: the pot after that is 160, so
    // the most is 230. All in for 1000 is that raise, and they are not all in.
    expect(game.currentPlayerIndex).toBe(1);
    act(game, 'allin');
    expect(players[1].bet).toBe(230);
    expect(players[1].allIn).toBe(false);
    expect(players[1].chips).toBe(770);
    expect(game.currentBet).toBe(230);
  });
});

describe('Seven-Card Stud', () => {
  test('antes from everyone, three cards each with the third face up, and no blinds', () => {
    const { game, players } = table({ game: 'stud' });
    expect(game.limit).toBe('fixed');
    expect(game.bets).toEqual({ ante: 5, bringIn: 10, smallBet: 20, bigBet: 40 });
    expect(game.smallBlind).toBe(20);
    expect(game.bigBlind).toBe(40);
    expect(game.startRound()).toBe(true);
    expect(game.phase).toBe('third');
    for (const p of players) {
      expect(p.holeCards).toHaveLength(3);
      expect(p.holeCards.map((c) => !!c.up)).toEqual([false, false, true]);
      expect(p.ante).toBe(5);
    }
    expect(game.sbIndex).toBeNull();
    expect(game.bbIndex).toBeNull();
    expect(game.anteTotal).toBe(15);
    expect(game.communityCards).toHaveLength(0);
    // The low card showing brought in, and the seat after them opens.
    const key = (c) => c.value * 4 + suitRank(c.suit);
    const lowest = Math.min(...players.map((p) => key(p.holeCards[2])));
    const bringIn = game.players[game.bringInIndex];
    expect(key(bringIn.holeCards[2])).toBe(lowest);
    expect(bringIn.bet).toBe(10);
    expect(game.currentBet).toBe(10);
    expect(game.pot).toBe(25);
    expect(game.currentPlayerIndex).toBe(game.getNextActiveIndex(game.bringInIndex));
    expect(game.lastRaiserIndex).toBe(game.bringInIndex);
    // Completing the bring-in is the first raise, to the small bet.
    expect(game.raiseCount).toBe(0);
    expect(game.minRaise).toBe(10);
  });

  test('the bring-in goes to the lowest card showing, clubs lowest on a tie', () => {
    const { game, players } = table({ game: 'stud' });
    game.startRound();
    players[0].holeCards = cards('Kh', '9c', '4h!');
    players[1].holeCards = cards('As', 'Jd', '4c!');
    players[2].holeCards = cards('2h', '3h', '9s!');
    expect(game._bringInSeat()).toBe(1);
    players[1].holeCards = cards('As', 'Jd', '4s!');
    expect(game._bringInSeat()).toBe(0);
  });

  test('later streets open with the strongest cards showing, ties to the seat nearest the dealer', () => {
    const { game, players } = table({ game: 'stud' }, ['A', 'B', 'C', 'D']);
    game.startRound();
    game.dealerIndex = 0;
    players[0].holeCards = cards('2c', '3c', 'Kh!', 'Ks!');
    players[1].holeCards = cards('2d', '3d', 'Ah!', 'Qs!');
    players[2].holeCards = cards('2h', '3h', 'Kc!', 'Kd!');
    players[3].holeCards = cards('2s', '3s', '5h!', '6s!');
    // Two seats show a pair of kings; the one nearer the dealer's left opens.
    expect(game._bestShowingIndex()).toBe(2);
    // A best hand that is all in hands the open to the next seat that can act.
    players[2].allIn = true;
    players[2].chips = 0;
    expect(game._bestShowingIndex()).toBe(3);
    // A folded hand is not showing anything.
    players[2].allIn = false;
    players[2].chips = 500;
    players[2].folded = true;
    expect(game._bestShowingIndex()).toBe(0);
  });

  test('the bring-in is not a live option: calls all round close third street', () => {
    const { game } = table({ game: 'stud' });
    game.startRound();
    game.nextPhase = jest.fn();
    act(game, 'call');
    expect(game.nextPhase).not.toHaveBeenCalled();
    act(game, 'call');
    expect(game.nextPhase).toHaveBeenCalled();
  });

  test('five streets, a card a street, the last one down, and a showdown of seven', () => {
    const { game, players } = table({ game: 'stud' }, ['A', 'B']);
    game.startRound();
    const expectStreet = (key, count, ups) => {
      expect(game.phase).toBe(key);
      for (const p of players) {
        expect(p.holeCards).toHaveLength(count);
        expect(p.holeCards.filter((c) => c.up)).toHaveLength(ups);
      }
      expect(game.communityCards).toHaveLength(0);
    };
    expectStreet('third', 3, 1);
    act(game, 'call'); // the other seat calls the bring-in; back to it, closed
    expectStreet('fourth', 4, 2);
    act(game, 'check');
    act(game, 'check');
    expectStreet('fifth', 5, 3);
    act(game, 'check');
    act(game, 'check');
    expectStreet('sixth', 6, 4);
    act(game, 'check');
    act(game, 'check');
    expectStreet('seventh', 7, 4);
    act(game, 'check');
    act(game, 'check');
    expect(game.phase).toBe('showdown');
    expect(game.isRunning).toBe(false);
    expect(game.lastRoundWinnerIds.length).toBeGreaterThan(0);
    // No burn: fourteen cards left the deck and nothing else.
    expect(game.deck).toHaveLength(52 - 14);
    const hand = game.handHistory.hands[0];
    expect(hand).toMatchObject({
      game: 'stud',
      limit: 'fixed',
      bets: { ante: 5, bringIn: 10, smallBet: 20, bigBet: 40 },
    });
    expect(hand.holeCards.A).toHaveLength(7);
    expect(hand.holeCards.A.map((c) => !!c.up)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(hand.shownCards.A).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test('a run-out deals the remaining streets a card at a time to showdown', () => {
    const { game, players } = table({ game: 'stud', limit: 'no' }, ['A', 'B']);
    game.startRound();
    act(game, 'allin');
    act(game, 'call');
    expect(game.phase).toBe('showdown');
    expect(game.cardsExposed).toBe(true);
    for (const p of players) expect(p.holeCards).toHaveLength(7);
    expect(game.communityCards).toHaveLength(0);
  });

  test('what the other seats see: the up cards while live, all at showdown, nothing after a fold', () => {
    const { game, players } = table({ game: 'stud' });
    game.startRound();
    const state = game.getStateForPlayer('A');
    const b = state.players.find((p) => p.id === 'B');
    expect(b.holeCards).toEqual([null, null, players[1].holeCards[2]]);
    expect(b.holeCards[2].up).toBe(true);
    expect(state.players.find((p) => p.id === 'A').holeCards).toHaveLength(3);
    expect(state.game).toMatchObject({
      key: 'stud',
      family: 'stud',
      holeCards: 7,
      firstDeal: 3,
      hasBoard: false,
      limit: 'fixed',
      bets: { ante: 5, bringIn: 10, smallBet: 20, bigBet: 40 },
    });
    expect(state.game.streets.map((s) => s.label)).toEqual([
      'Third street',
      'Fourth street',
      'Fifth street',
      'Sixth street',
      'Seventh street',
    ]);
    expect(state.bringInIndex).toBe(game.bringInIndex);
    expect(state.sbIndex).toBeNull();
    expect(state.betting).toEqual({ minTo: 20, maxTo: 20, fixed: true });
    expect(state.myHand.detail).toMatch(/^(Pair of|High Card|Three) /);

    players[1].folded = true;
    expect(game.getStateForPlayer('A').players.find((p) => p.id === 'B').holeCards).toBeNull();
  });

  test('showing a card afterwards: any of theirs that was not already up', () => {
    const { game, players } = table({ game: 'stud' });
    game.startRound();
    players[0].holeCards = cards('Kh', '9c', '4h!', 'Qd!', '7s!', '2c!', 'Ac');
    game.showWindow = { until: Date.now() + 5000, hold: false, offers: { A: [] } };
    game.showLookMs = 0;
    expect(game.showHoleCards('A', [2, 6, 9, 'x'])).toBe(true);
    expect(game.showWindow.offers.A).toEqual([6]);
    expect(game.showHoleCards('A', [1])).toBe(true);
    expect(game.showWindow.offers.A).toEqual([1, 6]);
    expect(game.showHoleCards('A', [3])).toBe(false);
  });

  test('a stud table seats seven, whatever it was asked for', () => {
    const { game } = table({ game: 'stud', maxPlayers: 9 }, []);
    expect(game.maxPlayers).toBe(7);
  });
});

describe('betting limits at the table', () => {
  test("fixed-limit: a raise is the street's bet, and a street closes after four", () => {
    const { game } = table({ limit: 'fixed' });
    game.startRound();
    expect(game.limit).toBe('fixed');
    // Preflop the blind was the bet; three raises follow, each the small bet.
    act(game, 'raise', 999);
    expect(game.currentBet).toBe(40);
    act(game, 'raise', 5);
    expect(game.currentBet).toBe(60);
    act(game, 'raise');
    expect(game.currentBet).toBe(80);
    // The fourth is the cap: it goes in as a call.
    expect(act(game, 'raise')).toBe(true);
    expect(game.currentBet).toBe(80);
    expect(game.raiseCount).toBe(4);
  });

  test("fixed-limit: the small bet until the game's big-bet street, the big bet from there", () => {
    const holdem = table({ limit: 'fixed' }).game;
    holdem.startRound();
    for (const [phase, unit] of [
      ['preflop', 20],
      ['flop', 20],
      ['turn', 40],
      ['river', 40],
    ]) {
      holdem.phase = phase;
      expect(holdem._betUnit()).toBe(unit);
    }
    const stud = table({ game: 'stud' }).game;
    stud.startRound();
    for (const [phase, unit] of [
      ['third', 20],
      ['fourth', 20],
      ['fifth', 40],
      ['sixth', 40],
      ['seventh', 40],
    ]) {
      stud.phase = phase;
      expect(stud._betUnit()).toBe(unit);
    }
  });

  test('fixed-limit heads-up: no cap', () => {
    const { game } = table({ limit: 'fixed' }, ['A', 'B']);
    game.startRound();
    for (let i = 1; i <= 6; i++) {
      act(game, 'raise');
      expect(game.currentBet).toBe(20 + 20 * i);
    }
  });

  test('no-limit: a street is not capped at four raises', () => {
    const { game } = table();
    game.startRound();
    for (let i = 1; i <= 6; i++) {
      act(game, 'raise', 20 + 20 * i);
      expect(game.currentBet).toBe(20 + 20 * i);
    }
  });

  test('a level applied to the table is read as the game posts it', () => {
    const holdem = table().game;
    holdem.applyLevel({ sb: 50, bb: 100, ante: 100 });
    expect([holdem.smallBlind, holdem.bigBlind, holdem.ante]).toEqual([50, 100, 100]);
    expect(holdem.bets).toEqual({ sb: 50, bb: 100, ante: 100, smallBet: 100, bigBet: 200 });
    const stud = table({ game: 'stud' }).game;
    stud.applyLevel({ sb: 50, bb: 100, ante: 100 });
    expect(stud.bets).toEqual({ ante: 25, bringIn: 50, smallBet: 100, bigBet: 200 });
    expect([stud.smallBlind, stud.bigBlind, stud.ante]).toEqual([100, 200, 25]);
  });
});

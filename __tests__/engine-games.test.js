// __tests__/engine-games.test.js - the engine playing games other than
// Hold'em, and betting under a limit. Hold'em's own behaviour is engine.test.js;
// this is what a definition changes.
const { PokerGame: BasePokerGame, AUTO_TURN_DELAY_MS } = require('../engine');
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

// The seat to draw throws these away.
function draw(game, indices) {
  const cur = game.players[game.currentPlayerIndex];
  return game.handleDraw(cur.id, indices);
}
const keyOf = (c) => `${c.rank}${c.suit}`;
// Everybody calls or checks until the street closes.
function callRound(game) {
  const from = game.phase;
  let guard = 0;
  while (game.phase === from && game.isRunning && guard++ < 30) {
    const cur = game.players[game.currentPlayerIndex];
    act(game, game.currentBet > cur.bet ? 'call' : 'check');
  }
}

describe('Five-Card Draw', () => {
  test('five cards down, blinds, no board; the draw opens left of the dealer after the betting', () => {
    const { game, players } = table({ game: 'draw' });
    expect(game.limit).toBe('no');
    game.startRound();
    expect(game.phase).toBe('predraw');
    for (const p of players) expect(p.holeCards).toHaveLength(5);
    expect(game.communityCards).toHaveLength(0);
    expect(game.drawing).toBeNull();
    expect(game.getStateForPlayer('A').drawing).toBeNull();
    callRound(game);
    expect(game.phase).toBe('drawing');
    expect(game.drawing).toMatchObject({ min: 0, max: 5, replace: true, first: 1 });
    expect(game.currentPlayerIndex).toBe(1);
    const state = game.getStateForPlayer('A');
    expect(state.drawing).toEqual({ min: 0, max: 5, replace: true });
    expect(state.game).toMatchObject({
      key: 'draw',
      family: 'draw',
      hasBoard: false,
      firstDeal: 5,
    });
    expect(state.players.find((p) => p.id === 'B').cards).toBe(5);
    expect(state.players.find((p) => p.id === 'B').holeCards).toBeNull();
    expect(game.getStateForPlayer('B').isMyTurn).toBe(true);
  });

  test('throw some away and get as many back, or stand pat; then the betting resumes', () => {
    const { game, players } = table({ game: 'draw' });
    game.startRound();
    callRound(game);
    const b = players[1];
    const before = b.holeCards.map(keyOf);
    expect(game.handleDraw('C', [0])).toBe(false); // not their draw
    expect(game.handleAction('B', 'check')).toBe(false); // nobody bets during a draw
    expect(draw(game, [4, 1, 9, 'x'])).toBe(true); // 9 and x are nobody's cards
    expect(b.holeCards).toHaveLength(5);
    const after = b.holeCards.map(keyOf);
    expect(after.filter((k) => before.includes(k))).toHaveLength(3);
    expect(game.muck.map(keyOf).sort()).toEqual([before[1], before[4]].sort());
    expect(b.lastAction).toMatchObject({ action: 'draw', amount: 2, replace: true });
    expect(game.currentPlayerIndex).toBe(2);
    expect(draw(game, [])).toBe(true);
    expect(players[2].lastAction).toMatchObject({ action: 'draw', amount: 0 });
    expect(game.currentPlayerIndex).toBe(0);
    expect(draw(game, [0, 1, 2, 3, 4])).toBe(true);
    // The round is over; the betting after the draw opens left of the dealer.
    expect(game.drawing).toBeNull();
    expect(game.phase).toBe('postdraw');
    expect(game.currentPlayerIndex).toBe(1);
    expect(game.currentBet).toBe(0);
    const all = players.flatMap((p) => p.holeCards.map(keyOf));
    expect(new Set(all).size).toBe(all.length);
    const hand = game.handHistory.current;
    expect(hand.actions.filter((a) => a.action === 'draw').map((a) => a.amount)).toEqual([2, 0, 5]);
    expect(hand.actions.filter((a) => a.action === 'draw').map((a) => a.phase)).toEqual([
      'drawing',
      'drawing',
      'drawing',
    ]);
    expect(hand.holeCards.B.map(keyOf)).toEqual(after);
    // And the betting is a betting round: a check goes through.
    expect(act(game, 'check')).toBe(true);
  });

  test('under fixed-limit the bet after the draw is the big bet', () => {
    const { game } = table({ game: 'draw', limit: 'fixed' });
    game.startRound();
    expect(game._betUnit()).toBe(20);
    callRound(game);
    draw(game, []);
    draw(game, []);
    draw(game, []);
    expect(game.phase).toBe('postdraw');
    expect(game._betUnit()).toBe(40);
    act(game, 'raise');
    expect(game.currentBet).toBe(40);
  });

  test('an all-in seat still draws, and the hands stay down until the draw is done', () => {
    const { game, players } = table({ game: 'draw' }, ['A', 'B']);
    game.startRound();
    // Heads-up the dealer is the small blind and acts first: A shoves, B calls.
    act(game, 'allin');
    act(game, 'call');
    expect(players.every((p) => p.allIn)).toBe(true);
    expect(game.phase).toBe('drawing');
    expect(game.cardsExposed).toBe(false);
    const asB = game.getStateForPlayer('B');
    expect(asB.players.find((p) => p.id === 'A').holeCards).toBeNull();
    expect(game.currentPlayerIndex).toBe(1);
    expect(asB.isMyTurn).toBe(true);
    expect(draw(game, [0])).toBe(true);
    expect(game.currentPlayerIndex).toBe(0);
    expect(game.getStateForPlayer('A').isMyTurn).toBe(true);
    expect(draw(game, [])).toBe(true);
    // The draw over, the run-out turns the hands up and goes to showdown.
    expect(game.cardsExposed).toBe(true);
    expect(game.phase).toBe('showdown');
    expect(game.isRunning).toBe(false);
    expect(game.lastRoundWinnerIds.length).toBeGreaterThan(0);
  });

  test('eight seats each drawing five: the discards are shuffled back in, and no card is twice in play', () => {
    const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const { game, players } = table({ game: 'draw' }, names);
    const said = [];
    game.onMessage = (m) => said.push(m);
    game.startRound();
    callRound(game);
    expect(game.phase).toBe('drawing');
    expect(game.deck).toHaveLength(52 - 40);
    for (let i = 0; i < 8; i++) expect(draw(game, [0, 1, 2, 3, 4])).toBe(true);
    expect(game.drawing).toBeNull();
    expect(said.some((m) => /shuffled back in/.test(m))).toBe(true);
    const all = players.flatMap((p) => p.holeCards.map(keyOf));
    expect(all).toHaveLength(40);
    expect(new Set(all).size).toBe(40);
    for (const p of players) expect(p.holeCards.every((c) => c && c.rank && c.suit)).toBe(true);
  });

  test('a clock that runs out stands pat; a bot draws within bounds; a sat-out seat stands pat', () => {
    jest.useFakeTimers();
    try {
      const { game, players } = table({ game: 'draw', gameMode: 'tournament' });
      game.startRound();
      callRound(game);
      expect(game.phase).toBe('drawing');
      const first = players[game.currentPlayerIndex];
      const before = first.holeCards.map(keyOf);
      jest.advanceTimersByTime(30000);
      expect(first.holeCards.map(keyOf)).toEqual(before);
      expect(first.timeoutStrikes).toBe(1);
      expect(game.drawing).not.toBeNull();
      const bot = players[game.currentPlayerIndex];
      bot.isBot = true;
      game.processAutoTurn();
      jest.advanceTimersByTime(AUTO_TURN_DELAY_MS + 5);
      const last = players[game.currentPlayerIndex];
      expect(last).not.toBe(bot);
      last.autoPlay = true;
      game.processAutoTurn();
      jest.advanceTimersByTime(AUTO_TURN_DELAY_MS + 5);
      expect(game.drawing).toBeNull();
      const draws = game.handHistory.current.actions.filter((a) => a.action === 'draw');
      expect(draws.map((a) => a.playerId)).toEqual([first.id, bot.id, last.id]);
      expect(draws[0].amount).toBe(0);
      expect(draws[1].amount).toBeGreaterThanOrEqual(0);
      expect(draws[1].amount).toBeLessThanOrEqual(5);
      expect(draws[2].amount).toBe(0);
      expect(bot.holeCards).toHaveLength(5);
    } finally {
      jest.useRealTimers();
    }
  });

  test('the donkey keeps a pair and throws the rest; with nothing it keeps its highest', () => {
    const { game, players } = table({ game: 'draw' });
    game.startRound();
    callRound(game);
    const p = players[1];
    p.holeCards = cards('Ks', 'Kh', '9d', '4c', '2h');
    expect(game._donkeyDraw(p).sort()).toEqual([2, 3, 4]);
    p.holeCards = cards('As', 'Jh', '9d', '4c', '2h');
    expect(game._donkeyDraw(p).sort()).toEqual([1, 2, 3, 4]);
    // A street that insists on one from a hand of trips takes the lowest of them.
    game.drawing.min = 1;
    game.drawing.max = 1;
    p.holeCards = cards('Qs', 'Qh', 'Qd');
    expect(game._donkeyDraw(p)).toHaveLength(1);
  });
});

describe('Crazy Pineapple', () => {
  test('three cards; after the flop each seat throws exactly one away and gets none back; then the turn', () => {
    const { game, players } = table({ game: 'pineapple' });
    game.startRound();
    for (const p of players) expect(p.holeCards).toHaveLength(3);
    expect(game.getStateForPlayer('A').game).toMatchObject({ key: 'pineapple', firstDeal: 3 });
    callRound(game);
    expect(game.phase).toBe('flop');
    expect(game.communityCards).toHaveLength(3);
    const deckAfterFlop = game.deck.length;
    callRound(game);
    expect(game.phase).toBe('discard');
    expect(game.drawing).toMatchObject({ min: 1, max: 1, replace: false, first: 1 });
    // No burn before a street that deals nothing.
    expect(game.deck).toHaveLength(deckAfterFlop);
    expect(draw(game, [])).toBe(false);
    expect(draw(game, [0, 1])).toBe(false);
    const b = players[1];
    const kept = b.holeCards.map(keyOf);
    expect(draw(game, [2])).toBe(true);
    expect(b.holeCards.map(keyOf)).toEqual(kept.slice(0, 2));
    expect(b.lastAction).toMatchObject({ action: 'draw', amount: 1, replace: false });
    expect(draw(game, [0])).toBe(true);
    expect(draw(game, [1])).toBe(true);
    expect(game.phase).toBe('turn');
    expect(game.communityCards).toHaveLength(4);
    for (const p of players) expect(p.holeCards).toHaveLength(2);
    expect(game.getStateForPlayer('A').players.find((p) => p.id === 'B').cards).toBe(2);
    expect(game.muck).toHaveLength(3);
  });

  test('a showdown scores any five of the two in hand and the board', () => {
    const { game, players } = table({ game: 'pineapple' }, ['A', 'B']);
    game.startRound();
    players[0].holeCards = cards('Ah', 'Kh');
    players[1].holeCards = cards('2c', '3d');
    game.communityCards = cards('Qh', 'Jh', '10h', '4s', '9c');
    game.phase = 'river';
    for (const p of players) {
      p.bet = 0;
      p.totalBet = 100;
    }
    game.pot = 200;
    game.showdown();
    expect(game.lastRoundWinnerIds).toEqual(['A']);
    expect(game.handHistory.hands[0].winners[0].handName).toBe('Royal Flush');
  });
});

// __tests__/games.test.js - the game definitions the engine reads
const {
  GAMES,
  DEFAULT_GAME,
  SUIT_ORDER,
  suitRank,
  gameFor,
  isGame,
  limitFor,
} = require('../games');
const { HAND_RANKS } = require('../hand-eval');

const c = (rank, suit, value) => ({ rank, suit, value });

describe('the registry', () => {
  test("eight games, and Hold'em when asked for one that is not there", () => {
    expect(Object.keys(GAMES)).toEqual([
      'holdem',
      'omaha',
      'stud',
      'draw',
      'pineapple',
      'razz',
      'omahahl',
      'studhl',
    ]);
    expect(DEFAULT_GAME).toBe('holdem');
    expect(gameFor('omaha').key).toBe('omaha');
    expect(gameFor('badugi').key).toBe('holdem');
    expect(gameFor(undefined).key).toBe('holdem');
    expect(isGame('stud')).toBe(true);
    expect(isGame('toString')).toBe(false);
  });

  test('every definition has the shape the engine reads', () => {
    for (const game of Object.values(GAMES)) {
      expect(game.key).toBeTruthy();
      expect(game.name).toBeTruthy();
      expect(['community', 'stud', 'draw']).toContain(game.family);
      expect(game.holeCards).toBeGreaterThanOrEqual(2);
      expect(game.maxSeats).toBeGreaterThanOrEqual(2);
      expect(['blinds', 'ante-bringin']).toContain(game.forced);
      expect(['no', 'pot', 'fixed']).toContain(game.defaultLimit);
      expect(game.streets.length).toBeGreaterThanOrEqual(2);
      for (const street of game.streets) {
        expect(street.key).toMatch(/^[a-z]+$/);
        expect(street.label).toBeTruthy();
        expect(['afterBlinds', 'afterButton', 'bringIn', 'bestShowing']).toContain(street.first);
        expect(street.deal === null || typeof street.deal === 'object').toBe(true);
        // A draw round says how many may go, whether they come back, and
        // that nobody bets on it.
        if (street.deal && street.deal.draw) {
          const d = street.deal.draw;
          expect(Number.isInteger(d.min) && Number.isInteger(d.max) && d.min <= d.max).toBe(true);
          expect(typeof d.replace).toBe('boolean');
          expect(street.bet).toBe(false);
        }
      }
      // A street's cards add up to the hand the game says it deals.
      const dealt = game.streets.reduce((n, s) => n + ((s.deal && s.deal.hole) || 0), 0);
      expect(dealt).toBe(game.holeCards);
      expect(game.bigBetFrom).toBeLessThan(game.streets.length);
      for (const fn of ['evaluate', 'showing', 'forcedBets', 'forcedText']) {
        expect(typeof game[fn]).toBe('function');
      }
      // Nothing reads a showing order any more: what is showing is compared
      // as the game reads it.
      expect(game.showingOrder).toBeUndefined();
      expect(['low', 'high']).toContain(game.bringInBy);
    }
    // Only the Hi-Lo games score a low beside the high.
    for (const key of Object.keys(GAMES)) {
      expect(typeof GAMES[key].low === 'function').toBe(key === 'omahahl' || key === 'studhl');
    }
  });

  test("Hold'em is exactly what the engine always dealt", () => {
    const g = GAMES.holdem;
    expect(g.streets.map((s) => s.key)).toEqual(['preflop', 'flop', 'turn', 'river']);
    expect(g.streets[0].deal).toEqual({ hole: 2, up: 0 });
    expect(g.streets.slice(1).map((s) => s.deal.board)).toEqual([3, 1, 1]);
    expect(g).toMatchObject({
      family: 'community',
      holeCards: 2,
      maxSeats: 10,
      burn: true,
      forced: 'blinds',
      liveOption: true,
      defaultLimit: 'no',
    });
  });

  test('Omaha deals four and scores exactly two of them', () => {
    const g = GAMES.omaha;
    expect(g.streets[0].deal).toEqual({ hole: 4, up: 0 });
    expect(g.defaultLimit).toBe('pot');
    const hole = [
      c('A', 'hearts', 14),
      c('2', 'clubs', 2),
      c('9', 'diamonds', 9),
      c('K', 'spades', 13),
    ];
    const board = [
      c('K', 'hearts', 13),
      c('Q', 'hearts', 12),
      c('J', 'hearts', 11),
      c('3', 'hearts', 3),
      c('2', 'diamonds', 2),
    ];
    expect(g.evaluate(hole, board).rank).toBe(HAND_RANKS.TWO_PAIR);
    expect(GAMES.holdem.evaluate(hole, board).rank).toBe(HAND_RANKS.FLUSH);
  });

  test('stud: seven cards over five streets, four up, no board, no burn, seven seats', () => {
    const g = GAMES.stud;
    expect(g.streets.map((s) => s.key)).toEqual(['third', 'fourth', 'fifth', 'sixth', 'seventh']);
    expect(g.streets.map((s) => s.deal.hole)).toEqual([3, 1, 1, 1, 1]);
    expect(g.streets.map((s) => s.deal.up)).toEqual([1, 1, 1, 1, 0]);
    expect(g.streets.every((s) => s.deal.board === undefined)).toBe(true);
    expect(g.streets[0].first).toBe('bringIn');
    expect(g.streets.slice(1).every((s) => s.first === 'bestShowing')).toBe(true);
    expect(g).toMatchObject({
      family: 'stud',
      holeCards: 7,
      maxSeats: 7,
      burn: false,
      forced: 'ante-bringin',
      liveOption: false,
      defaultLimit: 'fixed',
      bigBetFrom: 2,
    });
    // The whole hand is the player's own, so it scores like seven in hand.
    const seven = [
      c('A', 'hearts', 14),
      c('3', 'hearts', 3),
      c('9', 'hearts', 9),
      c('J', 'hearts', 11),
      c('4', 'hearts', 4),
      c('2', 'clubs', 2),
      c('7', 'spades', 7),
    ];
    expect(g.evaluate(seven, []).rank).toBe(HAND_RANKS.FLUSH);
    // What is showing is ranked on its own, however few cards that is.
    const up = [c('K', 'spades', 13), c('K', 'hearts', 13)];
    expect(g.showing(up).rank).toBe(HAND_RANKS.ONE_PAIR);
    expect(g.showing([c('A', 'spades', 14)]).rank).toBe(HAND_RANKS.HIGH_CARD);
  });
});

describe('the draw games', () => {
  test('Five-Card Draw: five down, a draw of up to five with replacement, a bet after, no board', () => {
    const g = GAMES.draw;
    expect(g.streets.map((s) => s.key)).toEqual(['predraw', 'drawing', 'postdraw']);
    expect(g.streets[0].deal).toEqual({ hole: 5, up: 0 });
    expect(g.streets[1]).toMatchObject({
      deal: { draw: { min: 0, max: 5, replace: true } },
      first: 'afterButton',
      bet: false,
    });
    expect(g.streets[2].deal).toBeNull();
    expect(g.streets[2].bet).toBeUndefined();
    expect(g).toMatchObject({
      family: 'draw',
      holeCards: 5,
      maxSeats: 8,
      burn: false,
      forced: 'blinds',
      liveOption: true,
      defaultLimit: 'no',
      bigBetFrom: 2,
    });
    const five = [
      c('K', 'spades', 13),
      c('K', 'hearts', 13),
      c('K', 'diamonds', 13),
      c('9', 'clubs', 9),
      c('9', 'diamonds', 9),
    ];
    expect(g.evaluate(five, []).rank).toBe(HAND_RANKS.FULL_HOUSE);
  });

  test("Crazy Pineapple: Hold'em with three cards and one thrown away after the flop", () => {
    const g = GAMES.pineapple;
    expect(g.streets.map((s) => s.key)).toEqual(['preflop', 'flop', 'discard', 'turn', 'river']);
    expect(g.streets[0].deal).toEqual({ hole: 3, up: 0 });
    expect(g.streets[2]).toMatchObject({
      deal: { draw: { min: 1, max: 1, replace: false } },
      first: 'afterButton',
      bet: false,
    });
    expect(g).toMatchObject({
      family: 'community',
      holeCards: 3,
      burn: true,
      forced: 'blinds',
      defaultLimit: 'no',
      bigBetFrom: 3,
    });
    // Two in hand and five on the board score as any five, unlike Omaha.
    const hole = [c('A', 'hearts', 14), c('2', 'clubs', 2)];
    const board = [
      c('K', 'hearts', 13),
      c('Q', 'hearts', 12),
      c('J', 'hearts', 11),
      c('10', 'hearts', 10),
      c('2', 'diamonds', 2),
    ];
    expect(g.evaluate(hole, board).rank).toBe(HAND_RANKS.ROYAL_FLUSH);
  });
});

describe('the low games', () => {
  const c5 = (...specs) =>
    specs.map((s) => {
      const suit = { h: 'hearts', d: 'diamonds', c: 'clubs', s: 'spades' }[s.slice(-1)];
      const rank = s.slice(0, -1);
      const vals = {
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
      return c(rank, suit, vals[rank]);
    });

  test('Razz is stud for low: the high card brings in with aces low, and the low is the hand', () => {
    const g = GAMES.razz;
    expect(g).toMatchObject({
      family: 'stud',
      holeCards: 7,
      maxSeats: 7,
      forced: 'ante-bringin',
      defaultLimit: 'fixed',
      bringInBy: 'high',
      acesLow: true,
    });
    expect(g.streets).toBe(GAMES.stud.streets);
    expect(g.low).toBeUndefined();
    const wheel = g.evaluate(c5('Ah', '2c', '3d', '4s', '5h', 'Kd', 'Qc'), []);
    expect(wheel.low).toBe(true);
    expect(wheel.name).toBe('Wheel');
    expect(g.showing(c5('Ah', '2c')).name).toBe('Two-ace low');
  });

  test('Omaha Hi-Lo and Stud Hi-Lo score an eight-or-better low beside the high', () => {
    const o = GAMES.omahahl;
    expect(o).toMatchObject({ family: 'community', holeCards: 4, defaultLimit: 'pot' });
    expect(o.streets).toEqual(GAMES.omaha.streets);
    const board = c5('2c', '3d', '7h', '8s', 'Kc');
    // A-4 in hand with 2-3-7 on the board: seven-four low. Nine-nine: none.
    expect(o.low(c5('Ah', '4d', 'Qc', 'Js'), board).name).toBe('Seven-four low');
    expect(o.low(c5('9h', '9d', 'Qc', 'Js'), board)).toBeNull();
    // The high is scored as Omaha's is.
    expect(o.evaluate(c5('Kh', 'Kd', '9c', '9s'), board).name).toBe('Three of a Kind');
    const s = GAMES.studhl;
    expect(s).toMatchObject({
      family: 'stud',
      maxSeats: 7,
      defaultLimit: 'fixed',
      bringInBy: 'low',
    });
    expect(s.acesLow).toBeUndefined();
    expect(s.low(c5('2c', '3d', '4h', '5s', '8c', 'Kd', 'Qh'), []).name).toBe('Eight-five low');
    expect(s.low(c5('2c', '3d', '4h', '9s', '10c', 'Kd', 'Qh'), [])).toBeNull();
  });
});

describe('forced bets from a level row', () => {
  const level = { sb: 10, bb: 20, ante: 20, duration: 300, break: false };

  test('a blinds game posts the row as written, and bets the big blind and twice it', () => {
    expect(GAMES.holdem.forcedBets(level)).toEqual({
      sb: 10,
      bb: 20,
      ante: 20,
      smallBet: 20,
      bigBet: 40,
    });
    expect(GAMES.omaha.forcedBets({ sb: 25, bb: 50 })).toEqual({
      sb: 25,
      bb: 50,
      ante: 0,
      smallBet: 50,
      bigBet: 100,
    });
  });

  test('stud reads the row as an ante, a bring-in and the bets, ignoring the big-blind ante', () => {
    expect(GAMES.stud.forcedBets(level)).toEqual({
      ante: 5,
      bringIn: 10,
      smallBet: 20,
      bigBet: 40,
    });
    expect(GAMES.stud.forcedBets({ sb: 15, bb: 30 })).toEqual({
      ante: 8,
      bringIn: 15,
      smallBet: 30,
      bigBet: 60,
    });
    // The ante is never nothing: a level too small to halve still antes a chip.
    expect(GAMES.stud.forcedBets({ sb: 1, bb: 2 }).ante).toBe(1);
  });

  test('the level in words reads like a card room board', () => {
    expect(GAMES.holdem.forcedText(GAMES.holdem.forcedBets({ sb: 10, bb: 20 }), 'no')).toBe(
      'Blinds 10/20'
    );
    expect(GAMES.holdem.forcedText(GAMES.holdem.forcedBets(level), 'no')).toBe(
      'Blinds 10/20 · ante 20'
    );
    expect(GAMES.holdem.forcedText(GAMES.holdem.forcedBets(level), 'fixed')).toBe(
      'Blinds 10/20 · ante 20 · bets 20/40'
    );
    expect(GAMES.stud.forcedText(GAMES.stud.forcedBets(level), 'fixed')).toBe(
      'Ante 5 · bring-in 10 · bets 20/40'
    );
  });
});

describe('limits and suits', () => {
  test("a game's own limit, unless the host picked another that exists", () => {
    expect(limitFor(GAMES.holdem, undefined)).toBe('no');
    expect(limitFor(GAMES.omaha, undefined)).toBe('pot');
    expect(limitFor(GAMES.stud, 'no')).toBe('no');
    expect(limitFor(GAMES.stud, 'spread')).toBe('fixed');
  });

  test('suits rank alphabetically for the bring-in, clubs lowest', () => {
    expect(SUIT_ORDER).toEqual(['clubs', 'diamonds', 'hearts', 'spades']);
    expect(suitRank('clubs')).toBeLessThan(suitRank('spades'));
    expect(suitRank('hearts')).toBe(2);
  });
});

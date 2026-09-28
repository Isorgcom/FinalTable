// __tests__/hand-eval.test.js — Hand evaluation unit tests
const {
  evaluateHand,
  bestOf,
  evaluatePartial,
  evaluateLow5,
  evaluateLowPartial,
  bestLow,
  compareHands,
  HAND_RANKS,
  LOW_RANKS,
} = require('../hand-eval');

function card(rank, suit) {
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
  return { rank, suit, value: vals[rank] };
}

function hand7(...specs) {
  return specs.map((s) => {
    const suit = { h: 'hearts', d: 'diamonds', c: 'clubs', s: 'spades' }[s.slice(-1)];
    const rank = s.slice(0, -1);
    return card(rank, suit);
  });
}

describe('Hand Evaluation — Rank Detection', () => {
  test('Royal Flush', () => {
    const h = evaluateHand(hand7('Ah', 'Kh', 'Qh', 'Jh', '10h', '3c', '2d'));
    expect(h.rank).toBe(HAND_RANKS.ROYAL_FLUSH);
  });

  test('Straight Flush', () => {
    const h = evaluateHand(hand7('9s', '8s', '7s', '6s', '5s', 'Kh', '2d'));
    expect(h.rank).toBe(HAND_RANKS.STRAIGHT_FLUSH);
  });

  test('Four of a Kind', () => {
    const h = evaluateHand(hand7('Ks', 'Kh', 'Kd', 'Kc', '7s', '3h', '2d'));
    expect(h.rank).toBe(HAND_RANKS.FOUR_OF_A_KIND);
  });

  test('Full House', () => {
    const h = evaluateHand(hand7('Qs', 'Qh', 'Qd', '9c', '9s', '3h', '2d'));
    expect(h.rank).toBe(HAND_RANKS.FULL_HOUSE);
  });

  test('Flush', () => {
    const h = evaluateHand(hand7('As', 'Js', '8s', '5s', '3s', 'Kh', '2d'));
    expect(h.rank).toBe(HAND_RANKS.FLUSH);
  });

  test('Straight', () => {
    const h = evaluateHand(hand7('10h', '9s', '8d', '7c', '6h', '2s', '3d'));
    expect(h.rank).toBe(HAND_RANKS.STRAIGHT);
  });

  test('Ace-low Straight (A-2-3-4-5)', () => {
    const h = evaluateHand(hand7('Ah', '2s', '3d', '4c', '5h', 'Ks', '9d'));
    expect(h.rank).toBe(HAND_RANKS.STRAIGHT);
  });

  test('Three of a Kind', () => {
    const h = evaluateHand(hand7('Js', 'Jh', 'Jd', '9c', '5s', '3h', '2d'));
    expect(h.rank).toBe(HAND_RANKS.THREE_OF_A_KIND);
  });

  test('Two Pair', () => {
    const h = evaluateHand(hand7('As', 'Ah', '8d', '8c', '5s', '3h', '2d'));
    expect(h.rank).toBe(HAND_RANKS.TWO_PAIR);
  });

  test('One Pair', () => {
    const h = evaluateHand(hand7('Ks', 'Kh', '9d', '7c', '4s', '3h', '2d'));
    expect(h.rank).toBe(HAND_RANKS.ONE_PAIR);
  });

  test('High Card', () => {
    const h = evaluateHand(hand7('As', 'Jh', '9d', '7c', '4s', '3h', '2d'));
    expect(h.rank).toBe(HAND_RANKS.HIGH_CARD);
  });
});

describe('Hand Comparison — Same Rank', () => {
  test('Higher flush beats lower flush (A-high vs K-high)', () => {
    const a = evaluateHand(hand7('As', 'Js', '8s', '5s', '3s', 'Kh', '2d'));
    const b = evaluateHand(hand7('Ks', 'Js', '8s', '5s', '3s', 'Ah', '2d'));
    // Both flush, but a has A♠ in flush vs b has K♠
    // Actually b also has A but in hearts — flush cards differ
    const fa = evaluateHand(hand7('As', 'Qs', '8s', '5s', '3s', 'Kh', '2d'));
    const fb = evaluateHand(hand7('Ks', 'Qs', '8s', '5s', '3s', '7h', '2d'));
    expect(compareHands(fa, fb)).toBeGreaterThan(0);
  });

  test('Higher pair beats lower pair (KK > QQ)', () => {
    const a = evaluateHand(hand7('Ks', 'Kh', '9d', '7c', '4s', '3h', '2d'));
    const b = evaluateHand(hand7('Qs', 'Qh', '9d', '7c', '4s', '3h', '2d'));
    expect(compareHands(a, b)).toBeGreaterThan(0);
  });

  test('Same pair, better kicker wins (AA-K > AA-Q)', () => {
    const a = evaluateHand(hand7('As', 'Ah', 'Kd', '7c', '4s', '3h', '2d'));
    const b = evaluateHand(hand7('As', 'Ah', 'Qd', '7c', '4s', '3h', '2d'));
    expect(compareHands(a, b)).toBeGreaterThan(0);
  });

  test('Higher full house wins (KKK-22 > QQQ-AA)', () => {
    const a = evaluateHand(hand7('Ks', 'Kh', 'Kd', '2c', '2s', '9h', '4d'));
    const b = evaluateHand(hand7('Qs', 'Qh', 'Qd', 'Ac', 'As', '9h', '4d'));
    expect(compareHands(a, b)).toBeGreaterThan(0);
  });

  test('Higher straight wins (T-high > 9-high)', () => {
    const a = evaluateHand(hand7('10h', '9s', '8d', '7c', '6h', '2s', '3d'));
    const b = evaluateHand(hand7('9h', '8s', '7d', '6c', '5h', '2s', '3d'));
    expect(compareHands(a, b)).toBeGreaterThan(0);
  });

  test('Identical hands = tie (returns 0)', () => {
    const a = evaluateHand(hand7('As', 'Kh', 'Qd', 'Jc', '9s', '3h', '2d'));
    const b = evaluateHand(hand7('Ac', 'Kd', 'Qs', 'Jh', '9c', '3d', '2h'));
    expect(compareHands(a, b)).toBe(0);
  });
});

describe('Hand Comparison — Different Ranks', () => {
  test('Flush beats Straight', () => {
    const flush = evaluateHand(hand7('As', 'Js', '8s', '5s', '3s', 'Kh', '2d'));
    const straight = evaluateHand(hand7('10h', '9s', '8d', '7c', '6h', '2s', '3d'));
    expect(compareHands(flush, straight)).toBeGreaterThan(0);
  });

  test('Full House beats Flush', () => {
    const fh = evaluateHand(hand7('Qs', 'Qh', 'Qd', '9c', '9s', '3h', '2d'));
    const flush = evaluateHand(hand7('As', 'Js', '8s', '5s', '3s', 'Kh', '2d'));
    expect(compareHands(fh, flush)).toBeGreaterThan(0);
  });

  test('Two Pair beats One Pair', () => {
    const tp = evaluateHand(hand7('As', 'Ah', '8d', '8c', '5s', '3h', '2d'));
    const op = evaluateHand(hand7('As', 'Ah', 'Kd', '9c', '5s', '3h', '2d'));
    expect(compareHands(tp, op)).toBeGreaterThan(0);
  });

  test('One Pair beats High Card', () => {
    const pair = evaluateHand(hand7('2s', '2h', 'Ad', 'Kc', 'Qs', 'Jh', '9d'));
    const high = evaluateHand(hand7('As', 'Kh', 'Qd', 'Jc', '9s', '7h', '3d'));
    expect(compareHands(pair, high)).toBeGreaterThan(0);
  });
});

describe('Edge Cases', () => {
  test('Best 5 from 7 cards — ignores worst 2', () => {
    // Has flush in spades AND a pair, flush should win
    const h = evaluateHand(hand7('As', 'Ks', 'Qs', 'Js', '9s', '9h', '2d'));
    expect(h.rank).toBe(HAND_RANKS.FLUSH);
  });

  test('Board makes the best hand — both players tie', () => {
    const board = hand7('As', 'Ks', 'Qs', 'Js', '10s', '2h', '3h').slice(0, 5);
    const a = evaluateHand([card('2', 'clubs'), card('3', 'clubs'), ...board]);
    const b = evaluateHand([card('4', 'clubs'), card('5', 'clubs'), ...board]);
    // Board is a royal flush, both players have same hand
    expect(compareHands(a, b)).toBe(0);
  });

  test('5-card hand evaluation works', () => {
    const h = evaluateHand(hand7('As', 'Ks', 'Qs', 'Js', '10s').slice(0, 5));
    expect(h.rank).toBe(HAND_RANKS.ROYAL_FLUSH);
  });
});

// Omaha's rule, and the one that catches most people: the board is not
// yours, only three of it is.
describe('bestOf — which cards may play', () => {
  const omaha = { useHole: { min: 2, max: 2 } };

  test('with no rule it is the best five of everything, as evaluateHand has it', () => {
    const hole = hand7('Ah', '3h');
    const board = hand7('9h', 'Jh', '4h', '2c', '7s');
    const a = bestOf(hole, board);
    const b = evaluateHand([...hole, ...board]);
    expect(a.rank).toBe(HAND_RANKS.FLUSH);
    expect(compareHands(a, b)).toBe(0);
  });

  test('Omaha: a board flush with one suited hole card is not a flush', () => {
    const hole = hand7('Ah', '2c', '9d', 'Ks');
    const board = hand7('Kh', 'Qh', 'Jh', '3h', '2d');
    expect(evaluateHand([...hole, ...board]).rank).toBe(HAND_RANKS.FLUSH);
    const h = bestOf(hole, board, omaha);
    expect(h.rank).toBe(HAND_RANKS.TWO_PAIR);
    expect(h.kickers.slice(0, 2)).toEqual([13, 2]);
  });

  test('Omaha: four of a kind on the board does not play', () => {
    const hole = hand7('Ah', 'Qc', 'Jd', '9s');
    const board = hand7('Kh', 'Kd', 'Kc', 'Ks', '2d');
    expect(evaluateHand([...hole, ...board]).rank).toBe(HAND_RANKS.FOUR_OF_A_KIND);
    expect(bestOf(hole, board, omaha).rank).toBe(HAND_RANKS.THREE_OF_A_KIND);
  });

  test('Omaha: a wheel from exactly two', () => {
    const h = bestOf(hand7('Ah', '2c', 'Kd', 'Ks'), hand7('3d', '4s', '5h', '9c', 'Jh'), omaha);
    expect(h.rank).toBe(HAND_RANKS.STRAIGHT);
    expect(h.kickers).toEqual([5]);
  });

  test('Omaha: a straight that needs three hole cards does not play', () => {
    const hole = hand7('6h', '7c', '8d', 'Ks');
    const board = hand7('9h', '10s', 'Ad', 'Ac', '2h');
    expect(evaluateHand([...hole, ...board]).rank).toBe(HAND_RANKS.STRAIGHT);
    const h = bestOf(hole, board, omaha);
    expect(h.rank).toBe(HAND_RANKS.ONE_PAIR);
    expect(h.kickers[0]).toBe(14);
  });

  test('Omaha: two from the hand and three from a short board still makes five', () => {
    const h = bestOf(hand7('Ah', 'Kh', 'Qh', 'Jh'), hand7('10h', '9h', '8h'), omaha);
    expect(h.rank).toBe(HAND_RANKS.STRAIGHT_FLUSH);
    expect(h.kickers).toEqual([12]);
  });

  test('Omaha: nothing before there are three on the board', () => {
    expect(bestOf(hand7('Ah', 'Kh', 'Qh', 'Jh'), hand7('10h', '9h'), omaha)).toBeNull();
  });
});

// A stud hand is ranked on its early streets by what is face up, and read
// out to its owner by what it has made so far. Neither is five cards yet.
describe('evaluatePartial — fewer than five cards', () => {
  test('pair, high card, and the higher of two pairs', () => {
    const pair = evaluatePartial(hand7('Ks', 'Kh', '9d'));
    expect(pair.rank).toBe(HAND_RANKS.ONE_PAIR);
    expect(pair.kickers).toEqual([13, 9]);
    expect(pair.cards.map((c) => c.rank)).toEqual(['K', 'K']);
    const high = evaluatePartial(hand7('As', 'Jh', '9d'));
    expect(high.rank).toBe(HAND_RANKS.HIGH_CARD);
    expect(high.kickers).toEqual([14, 11, 9]);
    expect(high.cards.map((c) => c.rank)).toEqual(['A']);
    expect(compareHands(pair, high)).toBeGreaterThan(0);
    expect(compareHands(pair, evaluatePartial(hand7('Qs', 'Qh', '9d')))).toBeGreaterThan(0);
  });

  test('three of a kind, two pair and four of a kind', () => {
    expect(evaluatePartial(hand7('Js', 'Jh', 'Jd', '9c')).rank).toBe(HAND_RANKS.THREE_OF_A_KIND);
    const two = evaluatePartial(hand7('As', 'Ah', '8d', '8c'));
    expect(two.rank).toBe(HAND_RANKS.TWO_PAIR);
    expect(two.kickers).toEqual([14, 8]);
    expect(two.cards).toHaveLength(4);
    expect(evaluatePartial(hand7('Ks', 'Kh', 'Kd', 'Kc')).rank).toBe(HAND_RANKS.FOUR_OF_A_KIND);
  });

  test('on the same scale as a full hand, so the two compare', () => {
    const deuces = evaluatePartial(hand7('2s', '2h', '9d'));
    const aceHigh = evaluateHand(hand7('As', 'Jh', '9d', '7c', '4s', '3h', '2d'));
    expect(compareHands(deuces, aceHigh)).toBeGreaterThan(0);
  });

  test('five or more cards go the ordinary way, and none is nothing', () => {
    expect(evaluatePartial(hand7('As', 'Ks', 'Qs', 'Js', '10s')).rank).toBe(HAND_RANKS.ROYAL_FLUSH);
    expect(evaluatePartial([])).toBeNull();
    expect(evaluatePartial(null)).toBeNull();
  });
});

// Ace-to-five: the ace is the lowest card, straights and flushes count for
// nothing, and the lowest cards win. compareHands orders these too, higher
// being better, so the same code that finds the best high finds the best low.
describe('low hands', () => {
  const low = (...specs) => evaluateLow5(hand7(...specs));

  test('the wheel is the best low, and the ace counts as one', () => {
    const wheel = low('Ah', '2c', '3d', '4s', '5h');
    expect(wheel.low).toBe(true);
    expect(wheel.rank).toBe(LOW_RANKS.NO_PAIR);
    expect(wheel.name).toBe('Wheel');
    expect(wheel.kickers).toEqual([-5, -4, -3, -2, -1]);
    expect(compareHands(wheel, low('2c', '3d', '4s', '5h', '6d'))).toBeGreaterThan(0);
    // A flush or a straight is neither here nor there.
    expect(compareHands(low('Ah', '2h', '3h', '4h', '5h'), wheel)).toBe(0);
  });

  test('the highest card decides first, then the next: 8-6-4-3-A beats 8-6-5-2-A', () => {
    const a = low('8h', '6c', '4d', '3s', 'Ah');
    const b = low('8d', '6s', '5c', '2h', 'Ad');
    expect(compareHands(a, b)).toBeGreaterThan(0);
    expect(a.name).toBe('Eight-six low');
    expect(compareHands(low('7h', '6c', '5d', '4s', '3h'), a)).toBeGreaterThan(0);
  });

  test('any unpaired hand beats any pair; a lower pair beats a higher; two pair is worse still', () => {
    const nineHigh = low('9h', '8c', '7d', '6s', '5h');
    const deuces = low('2h', '2c', '9d', '8s', '7h');
    const kings = low('Kh', 'Kc', '2d', '3s', '4h');
    const twoPair = low('2h', '2c', '3d', '3s', '4h');
    expect(compareHands(nineHigh, deuces)).toBeGreaterThan(0);
    expect(compareHands(deuces, kings)).toBeGreaterThan(0);
    expect(compareHands(deuces, twoPair)).toBeGreaterThan(0);
    expect(deuces.name).toBe('Pair of Twos');
    expect(twoPair.name).toBe('Threes and Twos');
  });

  test('bestLow: the best five of seven, and the eight-or-better qualifier', () => {
    const seven = hand7('Ah', '2c', '3d', '9s', '8h', 'Kd', 'Qc');
    expect(bestLow(seven, []).name).toBe('Nine-eight low');
    expect(bestLow(seven, [], { qualify: 8 })).toBeNull();
    expect(bestLow(hand7('Ah', '2c', '3d', '4s', '8h', 'Kd', 'Qc'), [], { qualify: 8 }).name).toBe(
      'Eight-four low'
    );
    // A paired hand never qualifies, however low its cards.
    expect(bestLow(hand7('Ah', 'Ac', '2d', '3s', '4h'), [], { qualify: 8 })).toBeNull();
  });

  test("bestLow: Omaha's exactly two from the hand", () => {
    const omaha = { useHole: { min: 2, max: 2 }, qualify: 8 };
    // 4-5 in hand with A-2-3 on the board is the wheel.
    expect(
      bestLow(hand7('4h', '5c', 'Kd', 'Qs'), hand7('Ah', '2c', '3d', 'Jh', '10s'), omaha).name
    ).toBe('Wheel');
    // A perfect low on the board is no low for a hand with nothing to add.
    expect(
      bestLow(hand7('Kh', 'Kc', 'Qd', 'Js'), hand7('Ah', '2c', '3d', '4s', '5h'), omaha)
    ).toBeNull();
  });

  test('a short low reads on the same scale', () => {
    expect(evaluateLowPartial(hand7('Ah', '2c')).name).toBe('Two-ace low');
    expect(evaluateLowPartial(hand7('8h')).name).toBe('Eight low');
    expect(
      compareHands(evaluateLowPartial(hand7('Ah', '2c')), evaluateLowPartial(hand7('3h', '2c')))
    ).toBeGreaterThan(0);
    expect(
      compareHands(evaluateLowPartial(hand7('9h', '2c')), evaluateLowPartial(hand7('Ah', 'Ac')))
    ).toBeGreaterThan(0);
    expect(evaluateLowPartial(hand7('Ah', '2c', '3d', '4s', '5h', '6c')).name).toBe('Wheel');
    expect(evaluateLowPartial([])).toBeNull();
  });
});

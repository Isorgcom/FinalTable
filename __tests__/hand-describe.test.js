// __tests__/hand-describe.test.js - the "You have ..." readout
const { describeHand } = require('../hand-describe');
const { gameFor } = require('../games');

const holdem = gameFor('holdem');
const omaha = gameFor('omaha');
const stud = gameFor('stud');

function card(spec) {
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
  const suit = { h: 'hearts', d: 'diamonds', c: 'clubs', s: 'spades' }[spec.slice(-1)];
  const rank = spec.slice(0, -1);
  return { rank, suit, value: vals[rank] };
}
const cards = (...specs) => specs.map(card);

describe('describeHand', () => {
  test('needs at least two hole cards', () => {
    expect(describeHand(holdem, cards('Ah'), cards())).toBeNull();
    expect(describeHand(holdem, null, cards())).toBeNull();
  });

  test('preflop: pocket pair, suited and offsuit', () => {
    expect(describeHand(holdem, cards('Kh', 'Kd'), [])).toMatchObject({
      detail: 'Pocket Kings',
      text: 'You have Pocket Kings',
      rank: 0,
    });
    expect(describeHand(holdem, cards('Kh', 'Ah'), []).detail).toBe('Ace-King suited');
    expect(describeHand(holdem, cards('Ah', 'Kd'), []).detail).toBe('Ace-King offsuit');
    expect(describeHand(holdem, cards('6h', '6d'), []).detail).toBe('Pocket Sixes');
  });

  test('flopped two pair names both pairs, high first', () => {
    expect(describeHand(holdem, cards('Kh', '5d'), cards('Kc', '5s', '9h'))).toMatchObject({
      name: 'Two Pair',
      detail: 'Kings and Fives',
      rank: 3,
    });
  });

  test('the wheel is a five-high straight', () => {
    expect(describeHand(holdem, cards('Ah', '2d'), cards('3c', '4s', '5h')).detail).toBe(
      'Straight, Five high'
    );
  });

  test('a board that plays reads as high card', () => {
    expect(
      describeHand(holdem, cards('7h', '2d'), cards('Kc', '9s', '4h', 'Jd', '5c')).detail
    ).toBe('High Card King');
  });

  test('pair, trips, flush, full house, quads', () => {
    expect(describeHand(holdem, cards('10h', '3d'), cards('10c', '9s', '4h')).detail).toBe(
      'Pair of Tens'
    );
    expect(describeHand(holdem, cards('Qh', 'Qd'), cards('Qc', '9s', '4h')).detail).toBe(
      'Three Queens'
    );
    expect(describeHand(holdem, cards('Ah', '3h'), cards('9h', 'Jh', '4h')).detail).toBe(
      'Flush, Ace high'
    );
    expect(describeHand(holdem, cards('Kh', 'Kd'), cards('Kc', '5s', '5h')).detail).toBe(
      'Kings full of Fives'
    );
    expect(describeHand(holdem, cards('9h', '9d'), cards('9c', '9s', '5h')).detail).toBe(
      'Four Nines'
    );
  });

  test('improves street by street', () => {
    const hole = cards('Ah', 'Kh');
    expect(describeHand(holdem, hole, cards('Qh', 'Jh', '2c')).detail).toBe('High Card Ace');
    expect(describeHand(holdem, hole, cards('Qh', 'Jh', '2c', '10h')).detail).toBe('Royal Flush');
  });

  // The readout draws the hand, not just its name, so the five that play have to
  // survive the trip. evaluateHand already picks them out of the seven; these
  // guard the line that used to drop them on the floor.
  test('a made hand carries the five cards that make it', () => {
    const hand = describeHand(holdem, cards('Kh', '5d'), cards('Kc', '5s', '9h'));
    expect(hand.cards).toHaveLength(5);
    expect(hand.cards.map((c) => `${c.rank}${c.suit[0]}`).sort()).toEqual(
      ['5d', '5s', '9h', 'Kc', 'Kh'].sort()
    );
  });

  test('the two cards that do not play are left out', () => {
    // A five-card flush out of seven: the 2c and 7s have no part in it.
    const flush = describeHand(holdem, cards('Ah', '3h'), cards('9h', 'Jh', '4h', '2c', '7s'));
    expect(flush.detail).toBe('Flush, Ace high');
    expect(flush.cards).toHaveLength(5);
    expect(flush.cards.every((c) => c.suit === 'hearts')).toBe(true);

    // High card is the same test without a made hand to lean on: the best five
    // by rank, so the deuce and the four fall away.
    const high = describeHand(holdem, cards('7h', '2d'), cards('Kc', '9s', '4h', 'Jd', '5c'));
    expect(high.detail).toBe('High Card King');
    expect(high.cards.map((c) => c.rank)).toEqual(
      expect.arrayContaining(['K', 'J', '9', '7', '5'])
    );
    expect(high.cards).toHaveLength(5);
  });

  test('the cards carry only what the client draws', () => {
    const hand = describeHand(holdem, cards('9h', '9d'), cards('9c', '9s', '5h'));
    for (const c of hand.cards) {
      expect(Object.keys(c).sort()).toEqual(['rank', 'suit']);
    }
  });

  test('preflop there is no five-card hand to show', () => {
    expect(describeHand(holdem, cards('Kh', 'Kd'), []).cards).toBeUndefined();
    expect(describeHand(holdem, cards('Ah', 'Kd'), cards('Qs', '2c')).cards).toBeUndefined();
  });

  test("without a game it reads as Hold'em", () => {
    expect(describeHand(null, cards('Kh', 'Kd'), []).detail).toBe('Pocket Kings');
  });
});

describe('describeHand for Omaha', () => {
  test('before the flop: what is paired, and the suits', () => {
    expect(describeHand(omaha, cards('Ah', 'Ad', 'Kh', 'Kd'), [])).toMatchObject({
      name: 'Two pairs',
      detail: 'Aces and Kings, double-suited',
      text: 'You have Aces and Kings, double-suited',
      rank: 0,
    });
    expect(describeHand(omaha, cards('Qh', 'Qd', '9c', '4s'), []).detail).toBe(
      'Pair of Queens, rainbow'
    );
    expect(describeHand(omaha, cards('Ah', 'Kh', '9c', '4s'), [])).toMatchObject({
      name: 'Single-suited',
      detail: 'Ace-King-Nine-Four, single-suited',
    });
    expect(describeHand(omaha, cards('Ah', 'Kd', '9c', '4s'), []).detail).toBe(
      'Ace-King-Nine-Four, rainbow'
    );
  });

  test('on the board, exactly two of the four play', () => {
    // Four hearts on the board and one in the hand is no flush in Omaha.
    const hand = describeHand(
      omaha,
      cards('Ah', '2c', '9d', 'Ks'),
      cards('Kh', 'Qh', 'Jh', '3h', '2d')
    );
    expect(hand.detail).toBe('Kings and Twos');
    expect(hand.cards).toHaveLength(5);
  });
});

describe('describeHand for stud', () => {
  test('fewer than five cards are read for what they have made', () => {
    const pair = describeHand(stud, cards('Ks', 'Kh', '9d'), []);
    expect(pair).toMatchObject({ name: 'One Pair', detail: 'Pair of Kings', rank: 2 });
    expect(pair.cards.map((c) => c.rank)).toEqual(['K', 'K']);
    const high = describeHand(stud, cards('As', 'Jh', '9d'), []);
    expect(high.detail).toBe('High Card Ace');
    expect(high.cards).toEqual([]);
    expect(describeHand(stud, cards('As', 'Ah', '8d', '8c'), []).detail).toBe('Aces and Eights');
  });

  test('from five cards it is the best five of what there is', () => {
    expect(describeHand(stud, cards('Ks', 'Kh', 'Kd', '9c', '9d'), []).detail).toBe(
      'Kings full of Nines'
    );
    const seven = describeHand(stud, cards('Ah', '3h', '9h', 'Jh', '4h', '2c', '7s'), []);
    expect(seven.detail).toBe('Flush, Ace high');
    expect(seven.cards).toHaveLength(5);
  });
});

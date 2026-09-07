// __tests__/hand-describe.test.js - the "You have ..." readout
const { describeHand } = require('../hand-describe');

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
  test('needs exactly two hole cards', () => {
    expect(describeHand(cards('Ah'), cards())).toBeNull();
    expect(describeHand(null, cards())).toBeNull();
  });

  test('preflop: pocket pair, suited and offsuit', () => {
    expect(describeHand(cards('Kh', 'Kd'), [])).toMatchObject({
      detail: 'Pocket Kings',
      text: 'You have Pocket Kings',
      rank: 0,
    });
    expect(describeHand(cards('Kh', 'Ah'), []).detail).toBe('Ace-King suited');
    expect(describeHand(cards('Ah', 'Kd'), []).detail).toBe('Ace-King offsuit');
    expect(describeHand(cards('6h', '6d'), []).detail).toBe('Pocket Sixes');
  });

  test('flopped two pair names both pairs, high first', () => {
    expect(describeHand(cards('Kh', '5d'), cards('Kc', '5s', '9h'))).toMatchObject({
      name: 'Two Pair',
      detail: 'Kings and Fives',
      rank: 3,
    });
  });

  test('the wheel is a five-high straight', () => {
    expect(describeHand(cards('Ah', '2d'), cards('3c', '4s', '5h')).detail).toBe(
      'Straight, Five high'
    );
  });

  test('a board that plays reads as high card', () => {
    expect(describeHand(cards('7h', '2d'), cards('Kc', '9s', '4h', 'Jd', '5c')).detail).toBe(
      'High Card King'
    );
  });

  test('pair, trips, flush, full house, quads', () => {
    expect(describeHand(cards('10h', '3d'), cards('10c', '9s', '4h')).detail).toBe('Pair of Tens');
    expect(describeHand(cards('Qh', 'Qd'), cards('Qc', '9s', '4h')).detail).toBe('Three Queens');
    expect(describeHand(cards('Ah', '3h'), cards('9h', 'Jh', '4h')).detail).toBe('Flush, Ace high');
    expect(describeHand(cards('Kh', 'Kd'), cards('Kc', '5s', '5h')).detail).toBe(
      'Kings full of Fives'
    );
    expect(describeHand(cards('9h', '9d'), cards('9c', '9s', '5h')).detail).toBe('Four Nines');
  });

  test('improves street by street', () => {
    const hole = cards('Ah', 'Kh');
    expect(describeHand(hole, cards('Qh', 'Jh', '2c')).detail).toBe('High Card Ace');
    expect(describeHand(hole, cards('Qh', 'Jh', '2c', '10h')).detail).toBe('Royal Flush');
  });

  // The readout draws the hand, not just its name, so the five that play have to
  // survive the trip. evaluateHand already picks them out of the seven; these
  // guard the line that used to drop them on the floor.
  test('a made hand carries the five cards that make it', () => {
    const hand = describeHand(cards('Kh', '5d'), cards('Kc', '5s', '9h'));
    expect(hand.cards).toHaveLength(5);
    expect(hand.cards.map((c) => `${c.rank}${c.suit[0]}`).sort()).toEqual(
      ['5d', '5s', '9h', 'Kc', 'Kh'].sort()
    );
  });

  test('the two cards that do not play are left out', () => {
    // A five-card flush out of seven: the 2c and 7s have no part in it.
    const flush = describeHand(cards('Ah', '3h'), cards('9h', 'Jh', '4h', '2c', '7s'));
    expect(flush.detail).toBe('Flush, Ace high');
    expect(flush.cards).toHaveLength(5);
    expect(flush.cards.every((c) => c.suit === 'hearts')).toBe(true);

    // High card is the same test without a made hand to lean on: the best five
    // by rank, so the deuce and the four fall away.
    const high = describeHand(cards('7h', '2d'), cards('Kc', '9s', '4h', 'Jd', '5c'));
    expect(high.detail).toBe('High Card King');
    expect(high.cards.map((c) => c.rank)).toEqual(
      expect.arrayContaining(['K', 'J', '9', '7', '5'])
    );
    expect(high.cards).toHaveLength(5);
  });

  test('the cards carry only what the client draws', () => {
    const hand = describeHand(cards('9h', '9d'), cards('9c', '9s', '5h'));
    for (const c of hand.cards) {
      expect(Object.keys(c).sort()).toEqual(['rank', 'suit']);
    }
  });

  test('preflop there is no five-card hand to show', () => {
    expect(describeHand(cards('Kh', 'Kd'), []).cards).toBeUndefined();
    expect(describeHand(cards('Ah', 'Kd'), cards('Qs', '2c')).cards).toBeUndefined();
  });
});

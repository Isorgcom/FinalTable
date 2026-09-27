// __tests__/betting-limits.test.js - how much a bet may be
const { LIMITS, limitName, raiseBounds, openingRaises } = require('../betting-limits');

// A seat facing a 20 bet with 1000 behind and 30 in the middle, unless said otherwise.
const ctx = (over = {}) => ({
  currentBet: 20,
  minRaise: 20,
  pot: 30,
  playerBet: 0,
  playerChips: 1000,
  betSize: 20,
  headsUp: false,
  ...over,
});

describe('raiseBounds', () => {
  test('the three limits, and their names', () => {
    expect(LIMITS).toEqual(['no', 'pot', 'fixed']);
    expect(limitName('pot')).toBe('Pot-limit');
    expect(limitName('nope')).toBe('No-limit');
  });

  test('no-limit: at least the last raise again, at most the stack, and no cap', () => {
    expect(raiseBounds('no', ctx())).toEqual({
      minTo: 40,
      maxTo: 1000,
      fixed: false,
      cap: Infinity,
    });
    expect(raiseBounds('no', ctx({ playerBet: 10, playerChips: 90 })).maxTo).toBe(100);
    expect(raiseBounds('no', ctx({ minRaise: 60 })).minTo).toBe(80);
  });

  test('pot-limit: the most is a call and then the pot', () => {
    // Call 20 into 30 makes 50; a pot-sized raise is 50 on top of the 20.
    expect(raiseBounds('pot', ctx())).toEqual({
      minTo: 40,
      maxTo: 70,
      fixed: false,
      cap: Infinity,
    });
    // With 10 already in (the small blind), the call is 10 and the pot after it 40.
    expect(raiseBounds('pot', ctx({ playerBet: 10 })).maxTo).toBe(60);
  });

  test('pot-limit: opening a street, the most is the pot itself', () => {
    expect(raiseBounds('pot', ctx({ currentBet: 0, pot: 100 }))).toMatchObject({
      minTo: 20,
      maxTo: 100,
    });
  });

  test('pot-limit never reaches past the stack, and never below the least', () => {
    expect(raiseBounds('pot', ctx({ playerChips: 50 })).maxTo).toBe(50);
    // A pot smaller than a minimum raise still allows the minimum.
    expect(raiseBounds('pot', ctx({ currentBet: 0, pot: 5, minRaise: 20 })).maxTo).toBe(20);
  });

  test('fixed-limit: the bet is the bet, and four to a street', () => {
    expect(raiseBounds('fixed', ctx())).toEqual({ minTo: 40, maxTo: 40, fixed: true, cap: 4 });
    expect(raiseBounds('fixed', ctx({ betSize: 40, currentBet: 80 }))).toMatchObject({
      minTo: 120,
      maxTo: 120,
    });
    // Heads-up there is no cap: nobody is being squeezed between two.
    expect(raiseBounds('fixed', ctx({ headsUp: true })).cap).toBe(Infinity);
    // The rule is stated whatever the stack; the engine makes a short stack an all-in.
    expect(raiseBounds('fixed', ctx({ playerChips: 15 })).minTo).toBe(40);
    // The next full bet, not the bet on top of what is there: a stud bring-in
    // of 10 is completed to 20, and a short all-in that left the price at 25
    // is raised to 40.
    expect(raiseBounds('fixed', ctx({ currentBet: 10 })).minTo).toBe(20);
    expect(raiseBounds('fixed', ctx({ currentBet: 25 })).minTo).toBe(40);
    expect(raiseBounds('fixed', ctx({ currentBet: 0 })).minTo).toBe(20);
  });

  test('a blind or a bring-in is the opening bet', () => {
    expect(openingRaises(true)).toBe(1);
    expect(openingRaises(false)).toBe(0);
  });
});

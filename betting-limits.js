// betting-limits.js - how much a bet may be.
//
// The engine grew up no-limit: a raise is at least the last raise again and
// at most the stack. That is one of three ways a table can run. Pot-limit
// caps a raise at the size of the pot; fixed-limit makes every bet the
// street's bet and every raise the same again, and closes the street after
// four. The engine asks here on every raise and does what it is told, so the
// three rules are these few lines and nothing else knows the difference.

const LIMITS = ['no', 'pot', 'fixed'];
const LIMIT_NAMES = { no: 'No-limit', pot: 'Pot-limit', fixed: 'Fixed-limit' };

function limitName(limit) {
  return LIMIT_NAMES[limit] || LIMIT_NAMES.no;
}

// The bounds of a raise for the seat to act, as totals for the street: the
// least it may make the bet and the most. `fixed` says the two are one
// number and there is nothing to size. `cap` is how many raises the street
// allows before it can only be called, Infinity when it allows any. A stack
// short of the least is not this function's problem - the engine already
// turns that into an all-in for what there is.
//
// Pot-limit's most is the pot after the call: the seat calls first, and may
// then raise by everything that is then in the middle.
function raiseBounds(
  limit,
  { currentBet, minRaise, pot, playerBet, playerChips, betSize, headsUp = false }
) {
  if (limit === 'fixed') {
    // The next full bet, not the bet on top of whatever is there: a stud
    // bring-in of 10 is completed to the 20 bet, and a short all-in that left
    // the price at 25 is raised to 40.
    const to = (Math.floor(currentBet / betSize) + 1) * betSize;
    return { minTo: to, maxTo: to, fixed: true, cap: headsUp ? Infinity : 4 };
  }
  const minTo = currentBet + minRaise;
  const stack = playerBet + playerChips;
  if (limit === 'pot') {
    const toCall = Math.max(0, currentBet - playerBet);
    const potMax = currentBet + pot + toCall;
    return { minTo, maxTo: Math.min(stack, Math.max(minTo, potMax)), fixed: false, cap: Infinity };
  }
  return { minTo, maxTo: stack, fixed: false, cap: Infinity };
}

// How many raises a street has seen the moment it opens. A blind or a
// bring-in is the opening bet, so a street that begins with one begins one
// raise in: under a cap of four that leaves the bet and three raises, the way
// a card room counts it.
function openingRaises(hasForcedBet) {
  return hasForcedBet ? 1 : 0;
}

module.exports = { LIMITS, LIMIT_NAMES, limitName, raiseBounds, openingRaises };

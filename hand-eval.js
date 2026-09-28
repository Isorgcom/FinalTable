// hand-eval.js - poker hand evaluation: the best five cards out of whatever a
// game puts in front of a player, and the same scale for fewer than five.

const HAND_RANKS = {
  ROYAL_FLUSH: 10,
  STRAIGHT_FLUSH: 9,
  FOUR_OF_A_KIND: 8,
  FULL_HOUSE: 7,
  FLUSH: 6,
  STRAIGHT: 5,
  THREE_OF_A_KIND: 4,
  TWO_PAIR: 3,
  ONE_PAIR: 2,
  HIGH_CARD: 1,
};

const HAND_NAMES = {
  10: 'Royal Flush',
  9: 'Straight Flush',
  8: 'Four of a Kind',
  7: 'Full House',
  6: 'Flush',
  5: 'Straight',
  4: 'Three of a Kind',
  3: 'Two Pair',
  2: 'One Pair',
  1: 'High Card',
};

function evaluateHand(cards) {
  // Generate all 5-card combos from 7 cards (or fewer)
  const combos = getCombinations(cards, 5);
  let bestHand = null;

  for (const combo of combos) {
    const result = evaluate5Cards(combo);
    if (!bestHand || compareHands(result, bestHand) > 0) {
      bestHand = result;
    }
  }
  return bestHand;
}

// The best five when the game says how many must come from the player's own
// cards: Omaha's exactly two from the hand with three from the board. A game
// with no such rule is evaluateHand over everything together. Null when the
// cards cannot make five under the rule.
function bestOf(hole, board, { useHole } = {}) {
  const hand = Array.isArray(hole) ? hole : [];
  const table = Array.isArray(board) ? board : [];
  if (!useHole) return evaluateHand([...hand, ...table]);
  let bestHand = null;
  for (let k = useHole.min; k <= useHole.max; k++) {
    if (k < 0 || k > hand.length || 5 - k > table.length) continue;
    for (const fromHand of getCombinations(hand, k)) {
      for (const fromBoard of getCombinations(table, 5 - k)) {
        const result = evaluate5Cards([...fromHand, ...fromBoard]);
        if (!bestHand || compareHands(result, bestHand) > 0) bestHand = result;
      }
    }
  }
  return bestHand;
}

// Fewer than five cards on the same scale, so that a stud hand on third
// street can be ranked against another and read out in words. Nothing below
// five can be a straight or a flush, so it is the groups and the high card.
// `cards` is what makes the hand rather than everything in it, which is what
// a reader lights up.
function evaluatePartial(cards) {
  if (!Array.isArray(cards) || !cards.length) return null;
  if (cards.length >= 5) return evaluateHand(cards);
  const sorted = [...cards].sort((a, b) => b.value - a.value);
  const values = sorted.map((c) => c.value);
  const groups = getGroups(values);
  const made = (rank, kickers, playing) => ({
    rank,
    kickers,
    cards: playing,
    name: HAND_NAMES[rank],
  });
  const ofValue = (...vals) => sorted.filter((c) => vals.includes(c.value));
  const [first, second] = groups;
  if (first.count === 4) {
    return made(HAND_RANKS.FOUR_OF_A_KIND, [first.value], ofValue(first.value));
  }
  const byGroup = groups.map((g) => g.value);
  if (first.count === 3) return made(HAND_RANKS.THREE_OF_A_KIND, byGroup, ofValue(first.value));
  if (first.count === 2 && second && second.count === 2) {
    return made(HAND_RANKS.TWO_PAIR, byGroup, ofValue(first.value, second.value));
  }
  if (first.count === 2) return made(HAND_RANKS.ONE_PAIR, byGroup, ofValue(first.value));
  return made(HAND_RANKS.HIGH_CARD, values, sorted.slice(0, 1));
}

function getCombinations(arr, size) {
  if (size === 0) return [[]];
  if (arr.length < size) return [];
  const results = [];
  for (let i = 0; i <= arr.length - size; i++) {
    const rest = getCombinations(arr.slice(i + 1), size - 1);
    for (const combo of rest) {
      results.push([arr[i], ...combo]);
    }
  }
  return results;
}

function evaluate5Cards(cards) {
  const sorted = [...cards].sort((a, b) => b.value - a.value);
  const values = sorted.map((c) => c.value);
  const suits = sorted.map((c) => c.suit);

  const isFlush = suits.every((s) => s === suits[0]);
  const isStraight = checkStraight(values);
  const groups = getGroups(values);

  // Check for low ace straight (A-2-3-4-5)
  if (!isStraight) {
    const lowAceValues = values.map((v) => (v === 14 ? 1 : v)).sort((a, b) => b - a);
    if (checkStraight(lowAceValues)) {
      return {
        rank: isFlush ? HAND_RANKS.STRAIGHT_FLUSH : HAND_RANKS.STRAIGHT,
        kickers: [5],
        cards: sorted,
        name: isFlush ? HAND_NAMES[9] : HAND_NAMES[5],
      };
    }
  }

  if (isFlush && isStraight) {
    const rank =
      values[0] === 14 && values[1] === 13 ? HAND_RANKS.ROYAL_FLUSH : HAND_RANKS.STRAIGHT_FLUSH;
    return { rank, kickers: [values[0]], cards: sorted, name: HAND_NAMES[rank] };
  }

  if (groups[0].count === 4) {
    return {
      rank: HAND_RANKS.FOUR_OF_A_KIND,
      kickers: [groups[0].value, groups[1].value],
      cards: sorted,
      name: HAND_NAMES[8],
    };
  }

  if (groups[0].count === 3 && groups[1].count === 2) {
    return {
      rank: HAND_RANKS.FULL_HOUSE,
      kickers: [groups[0].value, groups[1].value],
      cards: sorted,
      name: HAND_NAMES[7],
    };
  }

  if (isFlush) {
    return { rank: HAND_RANKS.FLUSH, kickers: values, cards: sorted, name: HAND_NAMES[6] };
  }

  if (isStraight) {
    return { rank: HAND_RANKS.STRAIGHT, kickers: [values[0]], cards: sorted, name: HAND_NAMES[5] };
  }

  if (groups[0].count === 3) {
    return {
      rank: HAND_RANKS.THREE_OF_A_KIND,
      kickers: [groups[0].value, groups[1].value, groups[2].value],
      cards: sorted,
      name: HAND_NAMES[4],
    };
  }

  if (groups[0].count === 2 && groups[1].count === 2) {
    return {
      rank: HAND_RANKS.TWO_PAIR,
      kickers: [groups[0].value, groups[1].value, groups[2].value],
      cards: sorted,
      name: HAND_NAMES[3],
    };
  }

  if (groups[0].count === 2) {
    return {
      rank: HAND_RANKS.ONE_PAIR,
      kickers: [groups[0].value, groups[1].value, groups[2].value, groups[3].value],
      cards: sorted,
      name: HAND_NAMES[2],
    };
  }

  return { rank: HAND_RANKS.HIGH_CARD, kickers: values, cards: sorted, name: HAND_NAMES[1] };
}

function checkStraight(values) {
  for (let i = 0; i < values.length - 1; i++) {
    if (values[i] - values[i + 1] !== 1) return false;
  }
  return true;
}

function getGroups(values) {
  const map = {};
  for (const v of values) {
    map[v] = (map[v] || 0) + 1;
  }
  return Object.entries(map)
    .map(([value, count]) => ({ value: parseInt(value), count }))
    .sort((a, b) => b.count - a.count || b.value - a.value);
}

function compareHands(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < Math.min(a.kickers.length, b.kickers.length); i++) {
    if (a.kickers[i] !== b.kickers[i]) return a.kickers[i] - b.kickers[i];
  }
  return 0;
}

// ── Low hands ────────────────────────────────────────────────────────────
//
// Ace-to-five: the ace is the lowest card, straights and flushes count for
// nothing, and the best hand is the one with the lowest cards - 5-4-3-2-A,
// the wheel, is the best of all. A low is scored on the same shape as a
// high so that compareHands orders it too: the category is the rank, no
// pair best, and the kickers are the groups' values negated, so that a
// lower card is a bigger kicker. A low and a high are never compared with
// each other; each game says which of the two a hand is scored as.

const LOW_RANKS = {
  NO_PAIR: 6,
  ONE_PAIR: 5,
  TWO_PAIR: 4,
  THREE_OF_A_KIND: 3,
  FULL_HOUSE: 2,
  FOUR_OF_A_KIND: 1,
};
// Names for the low's own words. hand-describe has the high's, and it
// requires this file rather than the other way round.
const LOW_NAMES = [
  '',
  'Ace',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Jack',
  'Queen',
  'King',
];
const lowPlural = (v) => (v === 6 ? 'Sixes' : `${LOW_NAMES[v]}s`);

function lowValue(v) {
  return v === 14 ? 1 : v;
}

function lowCategory(groups) {
  const [a, b] = groups;
  if (a.count === 4) return LOW_RANKS.FOUR_OF_A_KIND;
  if (a.count === 3 && b && b.count === 2) return LOW_RANKS.FULL_HOUSE;
  if (a.count === 3) return LOW_RANKS.THREE_OF_A_KIND;
  if (a.count === 2 && b && b.count === 2) return LOW_RANKS.TWO_PAIR;
  if (a.count === 2) return LOW_RANKS.ONE_PAIR;
  return LOW_RANKS.NO_PAIR;
}

// A low in words: the wheel by its name, any other unpaired low by its two
// highest cards ("Eight-six low"), and a paired one by what it paired,
// which in a low game is the bad news.
function lowName(rank, groups) {
  const vals = groups.map((g) => g.value);
  switch (rank) {
    case LOW_RANKS.NO_PAIR:
      if (vals.join(',') === '5,4,3,2,1') return 'Wheel';
      if (vals.length < 2) return `${LOW_NAMES[vals[0]]} low`;
      return `${LOW_NAMES[vals[0]]}-${LOW_NAMES[vals[1]].toLowerCase()} low`;
    case LOW_RANKS.ONE_PAIR:
      return `Pair of ${lowPlural(vals[0])}`;
    case LOW_RANKS.TWO_PAIR:
      return `${lowPlural(vals[0])} and ${lowPlural(vals[1])}`;
    case LOW_RANKS.THREE_OF_A_KIND:
      return `Three ${lowPlural(vals[0])}`;
    case LOW_RANKS.FULL_HOUSE:
      return `${lowPlural(vals[0])} full of ${lowPlural(vals[1])}`;
    default:
      return `Four ${lowPlural(vals[0])}`;
  }
}

// One to five cards as a low.
function lowOf(cards) {
  const sorted = cards.map((card) => ({ card, v: lowValue(card.value) })).sort((a, b) => b.v - a.v);
  const groups = getGroups(sorted.map((x) => x.v));
  const rank = lowCategory(groups);
  return {
    low: true,
    rank,
    kickers: groups.map((g) => -g.value),
    cards: sorted.map((x) => x.card),
    name: lowName(rank, groups),
  };
}

function evaluateLow5(cards) {
  return lowOf(cards);
}

// Fewer than five cards as a low, for a stud hand's early streets: what is
// showing decides who opens, and what is held is read out to its owner.
function evaluateLowPartial(cards) {
  if (!Array.isArray(cards) || !cards.length) return null;
  if (cards.length >= 5) return bestLow(cards, []);
  return lowOf(cards);
}

// The best low from a hand and a board, under the same must-use rule as
// bestOf, and null when there is none - or, with `qualify`, when the best
// is not an unpaired hand with every card at or under it: eight-or-better
// is `qualify: 8`. The best low overall is also the best qualifying low,
// since any unpaired hand beats any paired one.
function bestLow(hole, board, { useHole, qualify } = {}) {
  const hand = Array.isArray(hole) ? hole : [];
  const table = Array.isArray(board) ? board : [];
  let best = null;
  const consider = (five) => {
    const result = lowOf(five);
    if (!best || compareHands(result, best) > 0) best = result;
  };
  if (!useHole) {
    for (const combo of getCombinations([...hand, ...table], 5)) consider(combo);
  } else {
    for (let k = useHole.min; k <= useHole.max; k++) {
      if (k < 0 || k > hand.length || 5 - k > table.length) continue;
      for (const fromHand of getCombinations(hand, k)) {
        for (const fromBoard of getCombinations(table, 5 - k))
          consider([...fromHand, ...fromBoard]);
      }
    }
  }
  if (!best) return null;
  if (qualify !== undefined && (best.rank !== LOW_RANKS.NO_PAIR || -best.kickers[0] > qualify)) {
    return null;
  }
  return best;
}

module.exports = {
  evaluateHand,
  evaluate5Cards,
  bestOf,
  evaluatePartial,
  lowValue,
  evaluateLow5,
  evaluateLowPartial,
  bestLow,
  compareHands,
  HAND_RANKS,
  HAND_NAMES,
  LOW_RANKS,
};

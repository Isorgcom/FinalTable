// hand-eval.js - Texas Hold'em hand evaluation

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

module.exports = { evaluateHand, compareHands, HAND_RANKS, HAND_NAMES };

// hand-describe.js - a plain-English description of a player's hand for the
// table's "You have ..." readout. Server-side, because hand-eval.js is not
// loaded in the browser and a second evaluator would only drift from it.
const { evaluateHand, HAND_RANKS } = require('./hand-eval');

const VALUE_NAMES = {
  14: 'Ace',
  13: 'King',
  12: 'Queen',
  11: 'Jack',
  10: 'Ten',
  9: 'Nine',
  8: 'Eight',
  7: 'Seven',
  6: 'Six',
  5: 'Five',
  4: 'Four',
  3: 'Three',
  2: 'Two',
};
const PLURALS = { Six: 'Sixes' };

function single(value) {
  return VALUE_NAMES[value] || String(value);
}
function plural(value) {
  const name = single(value);
  return PLURALS[name] || name + 's';
}

function describePreflop(hole) {
  const [a, b] = [...hole].sort((x, y) => y.value - x.value);
  if (a.value === b.value) {
    return { name: 'Pocket pair', detail: `Pocket ${plural(a.value)}` };
  }
  const suited = a.suit === b.suit;
  return {
    name: suited ? 'Suited' : 'Offsuit',
    detail: `${single(a.value)}-${single(b.value)} ${suited ? 'suited' : 'offsuit'}`,
  };
}

function describeMade(best) {
  const k = best.kickers;
  switch (best.rank) {
    case HAND_RANKS.ROYAL_FLUSH:
      return 'Royal Flush';
    case HAND_RANKS.STRAIGHT_FLUSH:
      return `Straight Flush, ${single(k[0])} high`;
    case HAND_RANKS.FOUR_OF_A_KIND:
      return `Four ${plural(k[0])}`;
    case HAND_RANKS.FULL_HOUSE:
      return `${plural(k[0])} full of ${plural(k[1])}`;
    case HAND_RANKS.FLUSH:
      return `Flush, ${single(k[0])} high`;
    case HAND_RANKS.STRAIGHT:
      return `Straight, ${single(k[0])} high`;
    case HAND_RANKS.THREE_OF_A_KIND:
      return `Three ${plural(k[0])}`;
    case HAND_RANKS.TWO_PAIR:
      return `${plural(k[0])} and ${plural(k[1])}`;
    case HAND_RANKS.ONE_PAIR:
      return `Pair of ${plural(k[0])}`;
    default:
      return `High Card ${single(k[0])}`;
  }
}

// Returns { name, detail, text, rank } or null without two hole cards.
// Before the flop there is no five-card hand, so the hole cards are described
// on their own (Pocket Kings, Ace-King suited).
function describeHand(holeCards, communityCards) {
  if (!Array.isArray(holeCards) || holeCards.length !== 2) return null;
  const board = Array.isArray(communityCards) ? communityCards : [];
  if (board.length < 3) {
    const pre = describePreflop(holeCards);
    return { ...pre, text: `You have ${pre.detail}`, rank: 0 };
  }
  const best = evaluateHand([...holeCards, ...board]);
  if (!best) return null;
  const detail = describeMade(best);
  return { name: best.name, detail, text: `You have ${detail}`, rank: best.rank };
}

module.exports = { describeHand };

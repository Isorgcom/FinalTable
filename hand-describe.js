// hand-describe.js - a plain-English description of a player's hand for the
// table's "You have ..." readout. Server-side, because hand-eval.js is not
// loaded in the browser and a second evaluator would only drift from it.
const { HAND_RANKS } = require('./hand-eval');
const { gameFor, DEFAULT_GAME } = require('./games');

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

// Four cards before the flop, in the words Omaha players use: what is paired,
// and how many suits two of the cards share. Double-suited is the holding
// that matters, so it is said even when nothing is paired.
function describeOmahaStart(hole) {
  const sorted = [...hole].sort((x, y) => y.value - x.value);
  const byValue = new Map();
  const bySuit = new Map();
  for (const c of sorted) {
    byValue.set(c.value, (byValue.get(c.value) || 0) + 1);
    bySuit.set(c.suit, (bySuit.get(c.suit) || 0) + 1);
  }
  const pairs = [...byValue.entries()].filter(([, n]) => n >= 2).map(([v]) => v);
  const suitedRuns = [...bySuit.values()].filter((n) => n >= 2).length;
  const suits = suitedRuns >= 2 ? 'double-suited' : suitedRuns === 1 ? 'single-suited' : 'rainbow';
  if (pairs.length >= 2) {
    return { name: 'Two pairs', detail: `${plural(pairs[0])} and ${plural(pairs[1])}, ${suits}` };
  }
  if (pairs.length === 1) {
    return { name: 'Pair', detail: `Pair of ${plural(pairs[0])}, ${suits}` };
  }
  const name = suits[0].toUpperCase() + suits.slice(1);
  return { name, detail: `${sorted.map((c) => single(c.value)).join('-')}, ${suits}` };
}

// The made hand in words, from an evaluateHand() result - or a low's own
// name, which hand-eval gives it.
function describeBest(best) {
  if (best.low) return best.name;
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

// Returns { name, detail, text, rank, cards, low? } or null without a hand to
// describe. A community game before the flop has no five-card hand, so the
// hole cards are described on their own (Pocket Kings, Ace-King suited,
// Aces and Kings double-suited). Fewer than five cards anywhere else - a
// stud hand on its early streets - is read for what it has made so far, the
// way the game reads what is showing, so a Razz hand reads as a low. The
// game says how the made hand is scored, which is what makes an Omaha readout
// an Omaha hand rather than the best five of nine; a game that also scores a
// low says that too, in `low`, null when nothing qualifies.
function describeHand(game, holeCards, communityCards) {
  if (!Array.isArray(holeCards) || holeCards.length < 2) return null;
  const def = game || gameFor(DEFAULT_GAME);
  const board = Array.isArray(communityCards) ? communityCards : [];
  if (def.family === 'community' && board.length < 3) {
    const pre = holeCards.length === 2 ? describePreflop(holeCards) : describeOmahaStart(holeCards);
    return { ...pre, text: `You have ${pre.detail}`, rank: 0 };
  }
  const partial = holeCards.length + board.length < 5;
  const best = partial ? def.showing([...holeCards, ...board]) : def.evaluate(holeCards, board);
  if (!best) return null;
  const detail = describeBest(best);
  // The cards that actually play, so the readout can show the hand rather
  // than only name it. Mapped down to what the client draws: the internal
  // sort value is no business of the wire. A high card short of five cards
  // has nothing to show; a low short of five is every card, since every card
  // plays in a low.
  const showing =
    partial && !best.low && best.rank === HAND_RANKS.HIGH_CARD ? [] : best.cards || [];
  const cards = showing.map((c) => ({ rank: c.rank, suit: c.suit }));
  const out = { name: best.name, detail, text: `You have ${detail}`, rank: best.rank, cards };
  if (typeof def.low === 'function') {
    const low = partial ? null : def.low(holeCards, board);
    out.low = low ? low.name : null;
    if (low) out.text += ` · ${low.name}`;
  }
  return out;
}

module.exports = { describeHand, describeBest };

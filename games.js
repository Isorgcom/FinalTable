// games.js - what a game of poker is, as a definition the engine reads.
//
// The engine used to be Hold'em: two cards down, five on the board, four
// streets, the best five of seven. Everything that made it so is a field
// here now - how many cards and which come face up, whether there is a
// board, what is posted before the deal, who acts first on each street, how
// a hand is scored - and the hand loop reads the definition and does what it
// says. Adding a game is adding an entry, plus whatever the games before it
// never needed: a step kind, an evaluator, a control on the felt.
//
// Three families. Community games (Hold'em, Omaha, Pineapple) deal down and
// share a board. Stud games deal each player their own cards, some face up,
// and have no board. Draw games deal each player their own cards and then a
// draw: a round of turns that throw cards away rather than bet.
//
// A hand is scored by `evaluate`; a game that also scores a low - Omaha
// Hi-Lo, Stud Hi-Lo - says so in `low`, and the engine halves every pot
// between the best high and the best low that qualifies. Razz scores the low
// alone: its `evaluate` is the low evaluator, its bring-in the highest card
// showing with aces low, and what is showing is read as a low, so the best
// low showing opens each street. `showing` is what fewer than five cards are
// read as - the up-cards that decide who opens, and a short hand's readout.
//
// A street is what is dealt, and then a round of betting unless it says not:
//   { key, label, deal, first, bet? }
//   deal: { hole, up } | { board } | { draw: { min, max, replace } } | null
// `key` is the phase name on the wire. `first` says who opens the street:
// afterBlinds (left of the big blind, the small blind heads-up), afterButton,
// bringIn (left of the seat that brought in) or bestShowing (the strongest
// cards face up, ties to the seat nearest the dealer's left). A `draw` deal is
// the draw round itself - every seat still in the hand, all in or not, from
// `first` round, throws away `min` to `max` of its cards and, when `replace`,
// is dealt as many back - and a street that deals one is `bet: false`: the
// hand moves on when the last seat has chosen.

const { bestOf, evaluatePartial, bestLow, evaluateLowPartial } = require('./hand-eval');
const { LIMITS } = require('./betting-limits');

// The one place poker ranks suits: which of two equal low cards brings in at
// stud. Alphabetical, lowest first - the bridge order.
const SUIT_ORDER = ['clubs', 'diamonds', 'hearts', 'spades'];

function suitRank(suit) {
  return SUIT_ORDER.indexOf(suit);
}

// What a level row means at the table. A blinds game posts the row as
// written - a small blind, a big blind and the big-blind ante - and, under
// fixed-limit, bets the big blind and twice it. A stud game has no blinds:
// everyone antes and the low card brings in, and the row's numbers are read
// as the bets, the way a card room writes its board. A 10/20 level is ante 5,
// bring-in 10, bets 20/40. The row's own ante is a big-blind ante and is
// ignored; a stud game always antes.
function blindsBets(level) {
  const sb = level.sb || 0;
  const bb = level.bb || 0;
  return { sb, bb, ante: level.ante || 0, smallBet: bb, bigBet: bb * 2 };
}

function studBets(level) {
  const sb = level.sb || 0;
  const bb = level.bb || 0;
  return { ante: Math.max(1, Math.round(sb / 2)), bringIn: sb, smallBet: bb, bigBet: bb * 2 };
}

// The level in words, for the line that says the blinds went up.
function blindsText(bets, limit) {
  let text = `Blinds ${bets.sb}/${bets.bb}`;
  if (bets.ante > 0) text += ` · ante ${bets.ante}`;
  if (limit === 'fixed') text += ` · bets ${bets.smallBet}/${bets.bigBet}`;
  return text;
}

function studText(bets) {
  return `Ante ${bets.ante} · bring-in ${bets.bringIn} · bets ${bets.smallBet}/${bets.bigBet}`;
}

function communityStreets(holeCards) {
  return [
    { key: 'preflop', label: 'Preflop', deal: { hole: holeCards, up: 0 }, first: 'afterBlinds' },
    { key: 'flop', label: 'Flop', deal: { board: 3 }, first: 'afterButton' },
    { key: 'turn', label: 'Turn', deal: { board: 1 }, first: 'afterButton' },
    { key: 'river', label: 'River', deal: { board: 1 }, first: 'afterButton' },
  ];
}

// Hold'em with three cards, one of them thrown away after the flop's betting.
function pineappleStreets() {
  const streets = communityStreets(3);
  streets.splice(2, 0, {
    key: 'discard',
    label: 'The discard',
    deal: { draw: { min: 1, max: 1, replace: false } },
    first: 'afterButton',
    bet: false,
  });
  return streets;
}

const DRAW_STREETS = [
  { key: 'predraw', label: 'Before the draw', deal: { hole: 5, up: 0 }, first: 'afterBlinds' },
  {
    key: 'drawing',
    label: 'The draw',
    deal: { draw: { min: 0, max: 5, replace: true } },
    first: 'afterButton',
    bet: false,
  },
  { key: 'postdraw', label: 'After the draw', deal: null, first: 'afterButton' },
];

const STUD_STREETS = [
  { key: 'third', label: 'Third street', deal: { hole: 3, up: 1 }, first: 'bringIn' },
  { key: 'fourth', label: 'Fourth street', deal: { hole: 1, up: 1 }, first: 'bestShowing' },
  { key: 'fifth', label: 'Fifth street', deal: { hole: 1, up: 1 }, first: 'bestShowing' },
  { key: 'sixth', label: 'Sixth street', deal: { hole: 1, up: 1 }, first: 'bestShowing' },
  { key: 'seventh', label: 'Seventh street', deal: { hole: 1, up: 0 }, first: 'bestShowing' },
];

const GAMES = {
  holdem: {
    key: 'holdem',
    name: "Texas Hold'em",
    family: 'community',
    holeCards: 2,
    // What a deck seats, not what the felt does: the felt is laid out for
    // eight and the registry holds a game to that. The engine's own tables
    // can be wider, and the director's balancing tests deal nine.
    maxSeats: 10,
    burn: true,
    forced: 'blinds',
    liveOption: true,
    defaultLimit: 'no',
    // The street from which a fixed-limit game bets the big bet.
    bigBetFrom: 2,
    bringInBy: 'low',
    streets: communityStreets(2),
    evaluate: (hole, board) => bestOf(hole, board),
    showing: (up) => evaluatePartial(up),
    forcedBets: blindsBets,
    forcedText: blindsText,
  },
  omaha: {
    key: 'omaha',
    name: 'Omaha',
    family: 'community',
    holeCards: 4,
    maxSeats: 10,
    burn: true,
    forced: 'blinds',
    liveOption: true,
    defaultLimit: 'pot',
    bigBetFrom: 2,
    bringInBy: 'low',
    streets: communityStreets(4),
    // Exactly two from the hand and three from the board, which is the whole
    // of what makes Omaha Omaha.
    evaluate: (hole, board) => bestOf(hole, board, { useHole: { min: 2, max: 2 } }),
    showing: (up) => evaluatePartial(up),
    forcedBets: blindsBets,
    forcedText: blindsText,
  },
  stud: {
    key: 'stud',
    name: 'Seven-Card Stud',
    family: 'stud',
    holeCards: 7,
    // Seven cards each with no burn is forty-nine: seven seats is what a deck
    // holds. An eighth would need the seventh street dealt as one shared card
    // when the deck ran out, which is a rule this table does not play.
    maxSeats: 7,
    burn: false,
    forced: 'ante-bringin',
    liveOption: false,
    defaultLimit: 'fixed',
    bigBetFrom: 2,
    bringInBy: 'low',
    streets: STUD_STREETS,
    evaluate: (hole) => bestOf(hole, []),
    showing: (up) => evaluatePartial(up),
    forcedBets: studBets,
    forcedText: studText,
  },
  draw: {
    key: 'draw',
    name: 'Five-Card Draw',
    family: 'draw',
    holeCards: 5,
    // Eight seats drawing five can outrun a deck. The engine shuffles the
    // discards back in when it does, as the rules provide, so the felt's
    // eight is the limit rather than the deck.
    maxSeats: 8,
    burn: false,
    forced: 'blinds',
    liveOption: true,
    defaultLimit: 'no',
    bigBetFrom: 2,
    bringInBy: 'low',
    streets: DRAW_STREETS,
    evaluate: (hole) => bestOf(hole, []),
    showing: (up) => evaluatePartial(up),
    forcedBets: blindsBets,
    forcedText: blindsText,
  },
  pineapple: {
    key: 'pineapple',
    name: 'Crazy Pineapple',
    family: 'community',
    holeCards: 3,
    maxSeats: 10,
    burn: true,
    forced: 'blinds',
    liveOption: true,
    defaultLimit: 'no',
    bigBetFrom: 3,
    bringInBy: 'low',
    streets: pineappleStreets(),
    // Any five of the two left in hand and the board, as Hold'em has it.
    evaluate: (hole, board) => bestOf(hole, board),
    showing: (up) => evaluatePartial(up),
    forcedBets: blindsBets,
    forcedText: blindsText,
  },
  razz: {
    key: 'razz',
    name: 'Razz',
    family: 'stud',
    holeCards: 7,
    maxSeats: 7,
    burn: false,
    forced: 'ante-bringin',
    liveOption: false,
    defaultLimit: 'fixed',
    bigBetFrom: 2,
    // Stud for low: the highest card showing brings in, and the ace is low
    // for that as for everything else here.
    bringInBy: 'high',
    acesLow: true,
    streets: STUD_STREETS,
    evaluate: (hole) => bestLow(hole, []),
    showing: (up) => evaluateLowPartial(up),
    forcedBets: studBets,
    forcedText: studText,
  },
  omahahl: {
    key: 'omahahl',
    name: 'Omaha Hi-Lo',
    family: 'community',
    holeCards: 4,
    maxSeats: 10,
    burn: true,
    forced: 'blinds',
    liveOption: true,
    defaultLimit: 'pot',
    bigBetFrom: 2,
    bringInBy: 'low',
    streets: communityStreets(4),
    evaluate: (hole, board) => bestOf(hole, board, { useHole: { min: 2, max: 2 } }),
    // Eight-or-better, exactly two from the hand for the low as for the high.
    low: (hole, board) => bestLow(hole, board, { useHole: { min: 2, max: 2 }, qualify: 8 }),
    showing: (up) => evaluatePartial(up),
    forcedBets: blindsBets,
    forcedText: blindsText,
  },
  studhl: {
    key: 'studhl',
    name: 'Stud Hi-Lo',
    family: 'stud',
    holeCards: 7,
    maxSeats: 7,
    burn: false,
    forced: 'ante-bringin',
    liveOption: false,
    defaultLimit: 'fixed',
    bigBetFrom: 2,
    bringInBy: 'low',
    streets: STUD_STREETS,
    evaluate: (hole) => bestOf(hole, []),
    low: (hole) => bestLow(hole, [], { qualify: 8 }),
    showing: (up) => evaluatePartial(up),
    forcedBets: studBets,
    forcedText: studText,
  },
};

const DEFAULT_GAME = 'holdem';

function gameFor(key) {
  return GAMES[key] || GAMES[DEFAULT_GAME];
}

function isGame(key) {
  return Object.prototype.hasOwnProperty.call(GAMES, key);
}

// The limit a game plays, unless the host picked another that exists.
function limitFor(game, value) {
  return LIMITS.includes(value) ? value : game.defaultLimit;
}

module.exports = { GAMES, DEFAULT_GAME, SUIT_ORDER, suitRank, gameFor, isGame, limitFor };

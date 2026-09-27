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
// Two families are here and a third is left room for. Community games
// (Hold'em, Omaha) deal down and share a board. Stud games deal each player
// their own cards, some face up, and have no board. Draw games would need a
// discard step, which no street here has yet; `deal` is an object rather
// than a number so that `{ draw: n }` can join `{ hole }` and `{ board }`
// when one does.
//
// A street is one round of betting and what is dealt before it:
//   { key, label, deal: { hole, up } | { board } | null, first }
// `key` is the phase name on the wire. `first` says who opens the betting:
// afterBlinds (left of the big blind, the small blind heads-up), afterButton,
// bringIn (left of the seat that brought in) or bestShowing (the strongest
// cards face up, ties to the seat nearest the dealer's left).

const { bestOf, evaluatePartial } = require('./hand-eval');
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
    showingOrder: 'high',
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
    showingOrder: 'high',
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
    showingOrder: 'high',
    streets: STUD_STREETS,
    evaluate: (hole) => bestOf(hole, []),
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

// __tests__/engine.test.js
const { PokerGame: BasePokerGame, AUTO_TURN_DELAY_MS } = require('../engine');
const { evaluateHand, compareHands } = require('../hand-eval');
const random = require('../random');

const activeGames = new Set();

class PokerGame extends BasePokerGame {
  constructor(...args) {
    super(...args);
    activeGames.add(this);
  }
}

const Card = (suit, value) => ({
  suit,
  value,
  rank: {
    2: '2',
    3: '3',
    4: '4',
    5: '5',
    6: '6',
    7: '7',
    8: '8',
    9: '9',
    10: '10',
    11: 'J',
    12: 'Q',
    13: 'K',
    14: 'A',
  }[value],
});

afterEach(() => {
  for (const game of activeGames) {
    game.stop();
  }
  activeGames.clear();
});

describe('Poker Engine Core Rules & Pot Distribution', () => {
  let game;

  beforeEach(() => {
    game = new PokerGame('test_room', { smallBlind: 10, bigBlind: 20 });
    game.onMessage = () => {};
    game.onUpdate = () => {};
    game.onChat = () => {};
    game.onRoundEnd = () => {};
  });

  test('Scenario 1: Complex multi-way side pots with uncontested refund', () => {
    const p1 = game.addPlayer({ id: 'p1', name: 'Shark34' });
    const p2 = game.addPlayer({ id: 'p2', name: 'Rook21' });
    const p3 = game.addPlayer({ id: 'p3', name: 'Nine' });
    const p4 = game.addPlayer({ id: 'p4', name: 'Delta' });
    game.startRound();

    p1.totalBet = 1000;
    p1.chips = 0;
    p1.allIn = true;
    p2.totalBet = 3514;
    p2.chips = 0;
    p2.allIn = true;
    p4.totalBet = 4937;
    p4.chips = 0;
    p4.allIn = true;
    p3.totalBet = 10244;
    p3.chips = 5000;
    p3.allIn = false;
    game.pot = 1000 + 3514 + 4937 + 10244;

    game.communityCards = [
      Card('hearts', 10),
      Card('spades', 9),
      Card('diamonds', 8),
      Card('clubs', 7),
      Card('hearts', 2),
    ];
    p1.holeCards = [Card('spades', 11), Card('clubs', 6)];
    p4.holeCards = [Card('diamonds', 6), Card('hearts', 3)];
    p3.holeCards = [Card('spades', 14), Card('clubs', 4)];
    p2.holeCards = [Card('diamonds', 12), Card('hearts', 5)];

    game.showdown();

    expect(p1.chips).toBe(4000);
    expect(p1.wins).toBe(1);
    expect(p4.chips).toBe(10388);
    expect(p4.wins).toBe(1);
    expect(p3.chips).toBe(10307);
    expect(p3.wins).toBe(0);
    expect(p2.chips).toBe(0);
    expect(p2.wins).toBe(0);
  });

  test('Scenario 2: Multi-player split pot (Split Pot)', () => {
    const p1 = game.addPlayer({ id: 'p1', name: 'A' });
    const p2 = game.addPlayer({ id: 'p2', name: 'B' });
    const p3 = game.addPlayer({ id: 'p3', name: 'C' });
    game.startRound();

    [p1, p2, p3].forEach((p) => {
      p.totalBet = 1000;
      p.chips = 0;
      p.allIn = true;
    });
    game.pot = 3000;

    game.communityCards = [
      Card('spades', 14),
      Card('spades', 13),
      Card('spades', 12),
      Card('spades', 11),
      Card('spades', 10),
    ];
    p1.holeCards = [Card('hearts', 2), Card('clubs', 3)];
    p2.holeCards = [Card('diamonds', 4), Card('clubs', 5)];
    p3.holeCards = [Card('hearts', 6), Card('diamonds', 7)];

    game.showdown();

    expect(p1.chips).toBe(1000);
    expect(p2.chips).toBe(1000);
    expect(p3.chips).toBe(1000);
    expect(p1.wins).toBe(1);
    expect(p2.wins).toBe(1);
    expect(p3.wins).toBe(1);
  });

  test('Scenario 3: Short-stack big blind all-in', () => {
    const randomSpy = jest.spyOn(random, 'randomInt').mockImplementation((max) =>
      Number.isInteger(max) && max > 0 ? max - 1 : 0
    );
    try {
      const p1 = game.addPlayer({ id: 'p1', name: 'SB' });
      const p2 = game.addPlayer({ id: 'p2', name: 'BB_Short' });
      const p3 = game.addPlayer({ id: 'p3', name: 'UTG' });
      p1.chips = 1000;
      p2.chips = 5;
      p3.chips = 1000;
      game.dealerIndex = 2;
      game.startRound();

      expect(p2.bet).toBe(5);
      expect(p2.allIn).toBe(true);
      game.handleAction('p3', 'call');
      game.handleAction('p1', 'check');

      game.phase = 'river';
      game.communityCards = [
        Card('hearts', 10),
        Card('spades', 9),
        Card('diamonds', 8),
        Card('clubs', 7),
        Card('hearts', 2),
      ];
      p2.holeCards = [Card('spades', 11), Card('clubs', 6)];
      p1.holeCards = [Card('diamonds', 14), Card('hearts', 14)];
      p3.holeCards = [Card('clubs', 13), Card('spades', 13)];

      game.showdown();

      expect(p2.chips).toBe(15);
      expect(p1.chips).toBe(1000);
      expect(p3.chips).toBe(990);
    } finally {
      randomSpy.mockRestore();
    }
  });

  test('Scenario 4: All fold leaving one player', () => {
    const p1 = game.addPlayer({ id: 'p1', name: 'A' });
    const p2 = game.addPlayer({ id: 'p2', name: 'B' });
    const p3 = game.addPlayer({ id: 'p3', name: 'C' });
    game.startRound();

    for (let i = 0; i < 3; i++) {
      if (game.isRunning) {
        const cp = game.players[game.currentPlayerIndex];
        if (cp && !cp.folded && !cp.allIn) {
          game.handleAction(cp.id, 'fold');
        }
      }
    }
    expect(game.isRunning).toBe(false);
    expect(game.players.reduce((s, p) => s + p.chips, 0)).toBe(3000);
  });

  test('Scenario 5: heads-up Winner ID correctly recorded', () => {
    const p1 = game.addPlayer({ id: 'p1', name: 'Hero' });
    const p2 = game.addPlayer({ id: 'p2', name: 'Villain' });
    game.startRound();

    p1.totalBet = 1000;
    p1.chips = 0;
    p1.allIn = true;
    p2.totalBet = 1000;
    p2.chips = 0;
    p2.allIn = true;
    game.pot = 2000;

    game.communityCards = [
      Card('hearts', 14),
      Card('spades', 13),
      Card('diamonds', 12),
      Card('clubs', 5),
      Card('hearts', 3),
    ];
    p1.holeCards = [Card('spades', 14), Card('diamonds', 13)];
    p2.holeCards = [Card('hearts', 2), Card('clubs', 7)];

    game.showdown();

    expect(p1.chips).toBe(2000);
    expect(p2.chips).toBe(0);
    expect(game.lastRoundWinnerIds).toContain('p1');
    expect(game.lastRoundWinnerIds).not.toContain('p2');
  });

  test('Scenario 5a: heads-up dealer posts the small blind, acts first preflop, and big blind acts first postflop', () => {
    const button = game.addPlayer({ id: 'p1', name: 'Button' });
    const bigBlind = game.addPlayer({ id: 'p2', name: 'BigBlind' });
    game.dealerIndex = 0;

    game.startRound();

    expect(game.players[game.sbIndex].id).toBe(game.players[game.dealerIndex].id);
    expect(game.players[game.sbIndex].id).not.toBe(game.players[game.bbIndex].id);
    expect(game.currentPlayerIndex).toBe(game.sbIndex);
    expect(game.players[game.currentPlayerIndex].id).toBe(game.players[game.sbIndex].id);

    game.nextPhase();

    expect(game.phase).toBe('flop');
    expect(game.currentPlayerIndex).toBe(game.bbIndex);
    expect(game.players[game.currentPlayerIndex].id).toBe(game.players[game.bbIndex].id);
  });

  test('Scenario 5b: first hand keeps original seating order', () => {
    const hero = game.addPlayer({ id: 'p1', name: 'Hero' });
    const npcA = game.addPlayer({ id: 'p2', name: 'NPC_A' });
    const npcB = game.addPlayer({ id: 'p3', name: 'NPC_B' });
    const preDealOrder = game.players.map((player) => player.name);
    const preDealSeats = game.players.map((player) => player.seatIndex);

    game.startRound();

    expect(game.players.map((player) => player.name)).toEqual(preDealOrder);
    expect(game.players.map((player) => player.seatIndex)).toEqual(preDealSeats);
  });

  test('Scenario 5c: pre-game joins randomize seating before the first deal', () => {
    const randomSpy = jest.spyOn(random, 'randomInt').mockImplementation(() => 0);

    try {
      const hero = game.addPlayer({ id: 'p1', name: 'Hero' });
      const guest = game.addPlayer({ id: 'p2', name: 'Guest' });
      const npc = game.addPlayer({ id: 'p3', name: 'NPC_A' });

      expect(game.players.map((player) => player.name)).toEqual(['NPC_A', 'Guest', 'Hero']);
      expect(hero.seatIndex).toBe(2);
      expect(guest.seatIndex).toBe(1);
      expect(npc.seatIndex).toBe(0);

      game.startRound();

      expect(game.players.map((player) => player.name)).toEqual(['NPC_A', 'Guest', 'Hero']);
    } finally {
      randomSpy.mockRestore();
    }
  });

  test('Scenario 6: Flush must beat high card', () => {
    const p1 = game.addPlayer({ id: 'p1', name: 'FlushGuy' });
    const p2 = game.addPlayer({ id: 'p2', name: 'HighCard' });
    game.startRound();

    p1.totalBet = 500;
    p1.chips = 500;
    p2.totalBet = 500;
    p2.chips = 500;
    game.pot = 1000;

    game.communityCards = [
      Card('spades', 14),
      Card('spades', 8),
      Card('spades', 5),
      Card('diamonds', 11),
      Card('hearts', 2),
    ];
    p1.holeCards = [Card('spades', 13), Card('spades', 3)];
    p2.holeCards = [Card('hearts', 12), Card('clubs', 11)];

    game.showdown();

    expect(p1.chips).toBe(1500);
    expect(p2.chips).toBe(500);
    expect(p1.wins).toBe(1);
    expect(p2.wins).toBe(0);
  });

  test('Scenario 7: Three-level side pot chip conservation', () => {
    const p1 = game.addPlayer({ id: 'p1', name: 'Small' });
    const p2 = game.addPlayer({ id: 'p2', name: 'Medium' });
    const p3 = game.addPlayer({ id: 'p3', name: 'Big' });
    game.startRound();

    p1.totalBet = 100;
    p1.chips = 0;
    p1.allIn = true;
    p2.totalBet = 300;
    p2.chips = 0;
    p2.allIn = true;
    p3.totalBet = 300;
    p3.chips = 700;
    game.pot = 700;

    game.communityCards = [
      Card('hearts', 10),
      Card('spades', 9),
      Card('diamonds', 8),
      Card('clubs', 4),
      Card('hearts', 2),
    ];
    p1.holeCards = [Card('spades', 11), Card('clubs', 7)];
    p2.holeCards = [Card('diamonds', 10), Card('hearts', 10)];
    p3.holeCards = [Card('clubs', 14), Card('spades', 3)];

    game.showdown();

    expect(p1.chips).toBe(300);
    expect(p1.wins).toBe(1);
    expect(p2.chips).toBe(400);
    expect(p2.wins).toBe(1);
    expect(p3.chips).toBe(700);
    expect(p3.wins).toBe(0);
    expect(p1.chips + p2.chips + p3.chips).toBe(100 + 300 + 300 + 700);
  });
});
describe('Hand Evaluation', () => {
  test('Flush > Straight', () => {
    const flush = evaluateHand([
      Card('hearts', 14),
      Card('hearts', 10),
      Card('hearts', 7),
      Card('hearts', 5),
      Card('hearts', 3),
      Card('clubs', 2),
      Card('diamonds', 4),
    ]);
    const straight = evaluateHand([
      Card('hearts', 10),
      Card('spades', 9),
      Card('diamonds', 8),
      Card('clubs', 7),
      Card('hearts', 6),
      Card('clubs', 2),
      Card('diamonds', 4),
    ]);
    expect(compareHands(flush, straight)).toBeGreaterThan(0);
  });

  test('Full House > Flush', () => {
    const fh = evaluateHand([
      Card('hearts', 10),
      Card('spades', 10),
      Card('diamonds', 10),
      Card('clubs', 5),
      Card('hearts', 5),
      Card('clubs', 2),
      Card('diamonds', 4),
    ]);
    const flush = evaluateHand([
      Card('hearts', 14),
      Card('hearts', 10),
      Card('hearts', 7),
      Card('hearts', 5),
      Card('hearts', 3),
      Card('clubs', 2),
      Card('diamonds', 4),
    ]);
    expect(compareHands(fh, flush)).toBeGreaterThan(0);
  });

  test('AK high > AQ high', () => {
    const ak = evaluateHand([
      Card('hearts', 14),
      Card('spades', 13),
      Card('diamonds', 9),
      Card('clubs', 8),
      Card('hearts', 6),
      Card('clubs', 2),
      Card('diamonds', 4),
    ]);
    const aq = evaluateHand([
      Card('hearts', 14),
      Card('spades', 12),
      Card('diamonds', 9),
      Card('clubs', 8),
      Card('hearts', 6),
      Card('clubs', 2),
      Card('diamonds', 4),
    ]);
    expect(compareHands(ak, aq)).toBeGreaterThan(0);
  });

  test('A-2-3-4-5 wheel', () => {
    const wheel = evaluateHand([
      Card('hearts', 14),
      Card('spades', 2),
      Card('diamonds', 3),
      Card('clubs', 4),
      Card('hearts', 5),
      Card('clubs', 9),
      Card('diamonds', 10),
    ]);
    expect(wheel.name).toBe('Straight');
  });

  test('Same straight = tie', () => {
    const h1 = evaluateHand([
      Card('hearts', 14),
      Card('spades', 13),
      Card('diamonds', 12),
      Card('clubs', 11),
      Card('hearts', 10),
      Card('clubs', 2),
      Card('diamonds', 4),
    ]);
    const h2 = evaluateHand([
      Card('diamonds', 14),
      Card('clubs', 13),
      Card('hearts', 12),
      Card('spades', 11),
      Card('diamonds', 10),
      Card('spades', 2),
      Card('hearts', 4),
    ]);
    expect(compareHands(h1, h2)).toBe(0);
  });
});

describe('Chip Conservation Stress Test (Chip conservation stresstest)', () => {
  test('200 random hands: total chips unchanged, no negatives', () => {
    const ROUNDS = 200;
    const PLAYERS = 6;
    const START_CHIPS = 1000;
    const TOTAL = PLAYERS * START_CHIPS;

    for (let round = 0; round < ROUNDS; round++) {
      const g = new PokerGame(`stress_${round}`, { smallBlind: 10, bigBlind: 20 });
      g.onMessage = () => {};
      g.onUpdate = () => {};
      g.onChat = () => {};
      g.onRoundEnd = () => {};

      for (let i = 0; i < PLAYERS; i++) {
        g.addPlayer({
          id: `npc_${i}`,
          name: `Bot${i}`,
        });
      }

      g.startRound();

      let moves = 0;
      while (g.isRunning && moves < 120) {
        const cp = g.players[g.currentPlayerIndex];
        if (!cp || cp.folded || cp.allIn) {
          // If current player already folded or all-in, engine should auto-skip
          // Exit if stuck
          break;
        }

        const roll = Math.random();
        if (roll < 0.25) {
          game = g;
          g.handleAction(cp.id, 'fold');
        } else if (roll < 0.7) {
          g.handleAction(cp.id, 'call');
        } else {
          const amt = g.currentBet + g.minRaise + Math.floor(Math.random() * 200);
          g.handleAction(cp.id, 'raise', amt);
        }
        moves++;
      }

      // Chip conservation
      const total = g.players.reduce((s, p) => s + p.chips, 0);
      // If game still running, add pot
      const pot = g.isRunning ? g.pot : 0;
      const grandTotal = total + pot;

      if (grandTotal !== TOTAL) {
        console.error(
          `Round ${round}: chips=${total} pot=${pot} total=${grandTotal} expected=${TOTAL}`
        );
      }
      expect(grandTotal).toBe(TOTAL);

      // No negative chips
      for (const p of g.players) {
        expect(p.chips).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ============================================================
//  Hand evaluation edge casestest
// ============================================================
describe('Hand Evaluation Edge Cases', () => {
  test('Four of a Kind > Full House', () => {
    const quads = evaluateHand([
      Card('hearts', 10),
      Card('spades', 10),
      Card('diamonds', 10),
      Card('clubs', 10),
      Card('hearts', 5),
      Card('clubs', 2),
      Card('diamonds', 4),
    ]);
    const fh = evaluateHand([
      Card('hearts', 14),
      Card('spades', 14),
      Card('diamonds', 14),
      Card('clubs', 13),
      Card('hearts', 13),
      Card('clubs', 2),
      Card('diamonds', 4),
    ]);
    expect(quads.name).toBe('Four of a Kind');
    expect(fh.name).toBe('Full House');
    expect(compareHands(quads, fh)).toBeGreaterThan(0);
  });

  test('Straight Flush > Four of a Kind', () => {
    const sf = evaluateHand([
      Card('hearts', 9),
      Card('hearts', 8),
      Card('hearts', 7),
      Card('hearts', 6),
      Card('hearts', 5),
      Card('clubs', 2),
      Card('diamonds', 4),
    ]);
    const quads = evaluateHand([
      Card('hearts', 14),
      Card('spades', 14),
      Card('diamonds', 14),
      Card('clubs', 14),
      Card('hearts', 3),
      Card('clubs', 2),
      Card('diamonds', 4),
    ]);
    expect(sf.name).toBe('Straight Flush');
    expect(compareHands(sf, quads)).toBeGreaterThan(0);
  });

  test('Two Pair kicker comparison：AA22K > AA22Q', () => {
    const h1 = evaluateHand([
      Card('hearts', 14),
      Card('spades', 14),
      Card('diamonds', 2),
      Card('clubs', 2),
      Card('hearts', 13),
      Card('clubs', 3),
      Card('diamonds', 4),
    ]);
    const h2 = evaluateHand([
      Card('diamonds', 14),
      Card('clubs', 14),
      Card('hearts', 2),
      Card('spades', 2),
      Card('diamonds', 12),
      Card('spades', 3),
      Card('hearts', 4),
    ]);
    expect(h1.name).toBe('Two Pair');
    expect(h2.name).toBe('Two Pair');
    expect(compareHands(h1, h2)).toBeGreaterThan(0);
  });

  test('Royal Flush detection', () => {
    const royal = evaluateHand([
      Card('spades', 14),
      Card('spades', 13),
      Card('spades', 12),
      Card('spades', 11),
      Card('spades', 10),
      Card('clubs', 2),
      Card('diamonds', 4),
    ]);
    expect(royal.name).toBe('Royal Flush');
  });

  test('Three of a Kind > Two Pair', () => {
    const trips = evaluateHand([
      Card('hearts', 7),
      Card('spades', 7),
      Card('diamonds', 7),
      Card('clubs', 14),
      Card('hearts', 10),
      Card('clubs', 2),
      Card('diamonds', 4),
    ]);
    const twoPair = evaluateHand([
      Card('hearts', 14),
      Card('spades', 14),
      Card('diamonds', 13),
      Card('clubs', 13),
      Card('hearts', 10),
      Card('clubs', 2),
      Card('diamonds', 4),
    ]);
    expect(compareHands(trips, twoPair)).toBeGreaterThan(0);
  });

  test('One Pair > High Card', () => {
    const pair = evaluateHand([
      Card('hearts', 5),
      Card('spades', 5),
      Card('diamonds', 14),
      Card('clubs', 13),
      Card('hearts', 10),
      Card('clubs', 2),
      Card('diamonds', 4),
    ]);
    const high = evaluateHand([
      Card('hearts', 14),
      Card('spades', 13),
      Card('diamonds', 12),
      Card('clubs', 10),
      Card('hearts', 8),
      Card('clubs', 2),
      Card('diamonds', 4),
    ]);
    expect(compareHands(pair, high)).toBeGreaterThan(0);
  });
});

// ============================================================
//  Pot distribution advancedtest
// ============================================================
describe('Advanced Pot Distribution', () => {
  let game;
  beforeEach(() => {
    game = new PokerGame('test_adv', { smallBlind: 10, bigBlind: 20 });
    game.onMessage = () => {};
    game.onUpdate = () => {};
    game.onChat = () => {};
    game.onRoundEnd = () => {};
  });

  test('Folded player chips correctly distributed to winner', () => {
    const p1 = game.addPlayer({ id: 'p1', name: 'Winner' });
    const p2 = game.addPlayer({ id: 'p2', name: 'Loser' });
    const p3 = game.addPlayer({ id: 'p3', name: 'Folder' });
    game.startRound();

    // p3 folded but already invested 500
    p1.totalBet = 1000;
    p1.chips = 0;
    p1.allIn = true;
    p2.totalBet = 1000;
    p2.chips = 0;
    p2.allIn = true;
    p3.totalBet = 500;
    p3.chips = 500;
    p3.folded = true;
    game.pot = 2500;

    game.communityCards = [
      Card('hearts', 14),
      Card('spades', 13),
      Card('diamonds', 12),
      Card('clubs', 5),
      Card('hearts', 3),
    ];
    p1.holeCards = [Card('spades', 14), Card('diamonds', 13)]; // Two Pair AK
    p2.holeCards = [Card('hearts', 2), Card('clubs', 7)]; // High card

    game.showdown();

    // p1 wins all 2500 (including p3's 500 before folding)
    expect(p1.chips).toBe(2500);
    expect(p2.chips).toBe(0);
    expect(p3.chips).toBe(500); // p3 before folding
  });

  test('4-player two side pots chip conservation', () => {
    const p1 = game.addPlayer({ id: 'p1', name: 'A' });
    const p2 = game.addPlayer({ id: 'p2', name: 'B' });
    const p3 = game.addPlayer({ id: 'p3', name: 'C' });
    const p4 = game.addPlayer({ id: 'p4', name: 'D' });
    game.startRound();

    p1.totalBet = 200;
    p1.chips = 0;
    p1.allIn = true;
    p2.totalBet = 500;
    p2.chips = 0;
    p2.allIn = true;
    p3.totalBet = 500;
    p3.chips = 0;
    p3.allIn = true;
    p4.totalBet = 1000;
    p4.chips = 0;
    p4.allIn = true;
    game.pot = 2200;

    game.communityCards = [
      Card('hearts', 10),
      Card('spades', 9),
      Card('diamonds', 8),
      Card('clubs', 4),
      Card('hearts', 2),
    ];
    // p1 strongest (straight)，p4 second (three of a kind10），p2/p3 weakest
    p1.holeCards = [Card('spades', 11), Card('clubs', 7)];
    p4.holeCards = [Card('diamonds', 10), Card('clubs', 10)];
    p2.holeCards = [Card('hearts', 3), Card('clubs', 5)];
    p3.holeCards = [Card('diamonds', 3), Card('hearts', 5)];

    game.showdown();

    // main pot 200*4=800 → p1wins
    // side pot1 (500-200)*3=900 → p4wins（p1not eligible）
    // side pot2 (1000-500)*1=500 → p4sole claim（only he invested that much, refund）
    expect(p1.chips).toBe(800);
    expect(p4.chips).toBe(900 + 500); // 900won + 500refund
    expect(p2.chips).toBe(0);
    expect(p3.chips).toBe(0);
    expect(p1.chips + p2.chips + p3.chips + p4.chips).toBe(2200);
  });

  test('lastRoundWinnerIds only includes actual winnerexcludes refund recipients', () => {
    const p1 = game.addPlayer({ id: 'p1', name: 'BigStack' });
    const p2 = game.addPlayer({ id: 'p2', name: 'SmallStack' });
    game.startRound();

    p1.totalBet = 1000;
    p1.chips = 500;
    p2.totalBet = 500;
    p2.chips = 0;
    p2.allIn = true;
    game.pot = 1500;

    game.communityCards = [
      Card('hearts', 14),
      Card('spades', 13),
      Card('diamonds', 12),
      Card('clubs', 5),
      Card('hearts', 3),
    ];
    // p2 wins
    p2.holeCards = [Card('spades', 14), Card('diamonds', 14)]; // trip aces
    p1.holeCards = [Card('hearts', 2), Card('clubs', 7)]; // High card

    game.showdown();

    expect(game.lastRoundWinnerIds).toContain('p2');
    // p1 gets back 500 refund but is not awinner
    expect(game.lastRoundWinnerIds).not.toContain('p1');
    expect(game.lastRoundRefunds).toEqual([
      {
        playerId: 'p1',
        playerName: 'BigStack',
        amount: 500,
        reason: 'unmatched all-in chips',
      },
    ]);
  });

  test('cash tables enter game-over state when only one player has chips left', () => {
    const hero = game.addPlayer({ id: 'p1', name: 'Hero' });
    const npc = game.addPlayer({ id: 'npc1', name: 'Villain' });
    game.startRound();

    hero.totalBet = 1000;
    hero.chips = 0;
    npc.totalBet = 1000;
    npc.chips = 0;
    game.pot = 2000;

    hero.holeCards = [Card('spades', 14), Card('hearts', 14)];
    npc.holeCards = [Card('clubs', 2), Card('diamonds', 7)];
    game.communityCards = [
      Card('hearts', 13),
      Card('spades', 10),
      Card('diamonds', 8),
      Card('clubs', 5),
      Card('hearts', 3),
    ];

    game.showdown();

    expect(game.gameOver).toEqual({
      reason: 'last-player-standing',
      winnerId: 'p1',
      winnerName: 'Hero',
      remainingPlayers: 1,
    });
  });
});

// ============================================================
//  Hand replayData integritytest
// ============================================================
describe('Hand History & Replay Data', () => {
  test('replay recordincludes all hands and winnerinfo', () => {
    const game = new PokerGame('replay_test', { smallBlind: 10, bigBlind: 20 });
    game.onMessage = () => {};
    game.onUpdate = () => {};
    game.onChat = () => {};
    game.onRoundEnd = () => {};

    const p1 = game.addPlayer({ id: 'p1', name: 'Hero' });
    const p2 = game.addPlayer({ id: 'p2', name: 'Villain' });
    game.startRound();

    // Force to showdown
    p1.totalBet = 500;
    p1.chips = 500;
    p2.totalBet = 500;
    p2.chips = 500;
    game.pot = 1000;

    game.communityCards = [
      Card('hearts', 14),
      Card('spades', 13),
      Card('diamonds', 12),
      Card('clubs', 5),
      Card('hearts', 3),
    ];
    p1.holeCards = [Card('spades', 14), Card('diamonds', 13)]; // Two pair AK
    p2.holeCards = [Card('hearts', 2), Card('clubs', 7)]; // High card

    game.showdown();

    // Check replay data
    const hands = game.handHistory.getRecentHands(10);
    expect(hands.length).toBe(1);

    const hand = hands[0];
    expect(hand.winners.length).toBeGreaterThan(0);
    expect(hand.winners[0].playerName).toBe('Hero');
    expect(hand.communityCards.length).toBe(5);
    expect(hand.finalPhase).toBe('showdown');

    // Hand record exists
    expect(hand.holeCards['p1']).toBeDefined();
    expect(hand.holeCards['p1'].length).toBe(2);
    expect(hand.holeCards['p2']).toBeDefined();
    expect(hand.holeCards['p2'].length).toBe(2);
  });

  test('foldwinner replay also has records', () => {
    const game = new PokerGame('fold_test', { smallBlind: 10, bigBlind: 20 });
    game.onMessage = () => {};
    game.onUpdate = () => {};
    game.onChat = () => {};
    game.onRoundEnd = () => {};

    const p1 = game.addPlayer({ id: 'p1', name: 'Survivor' });
    const p2 = game.addPlayer({ id: 'p2', name: 'Quitter' });
    game.startRound();

    // let p2 fold
    const cp = game.players[game.currentPlayerIndex];
    game.handleAction(cp.id, 'fold');

    const hands = game.handHistory.getRecentHands(10);
    expect(hands.length).toBe(1);
    expect(hands[0].winners.length).toBe(1);
    expect(hands[0].finalPhase).toBe('preflop');
  });

  test('replay snapshots stay stable after a new hand starts', () => {
    const game = new PokerGame('replay_stability', { smallBlind: 10, bigBlind: 20 });
    game.onMessage = () => {};
    game.onUpdate = () => {};
    game.onChat = () => {};
    game.onRoundEnd = () => {};

    const p1 = game.addPlayer({ id: 'p1', name: 'Hero' });
    const p2 = game.addPlayer({ id: 'p2', name: 'Villain' });
    game.startRound();

    p1.totalBet = 500;
    p1.chips = 500;
    p2.totalBet = 500;
    p2.chips = 500;
    game.pot = 1000;
    p1.holeCards = [Card('spades', 14), Card('diamonds', 13)];
    p2.holeCards = [Card('hearts', 2), Card('clubs', 7)];
    game.communityCards = [
      Card('hearts', 14),
      Card('spades', 13),
      Card('diamonds', 12),
      Card('clubs', 5),
      Card('hearts', 3),
    ];
    game.showdown();

    const replayBefore = game.handHistory.getHandForReplay(1);
    game.startRound();
    p1.holeCards = [Card('clubs', 2), Card('clubs', 3)];
    p2.holeCards = [Card('spades', 4), Card('spades', 5)];
    game.communityCards = [Card('clubs', 6), Card('clubs', 7), Card('clubs', 8)];

    const replayAfter = game.handHistory.getHandForReplay(1);
    expect(replayAfter).toEqual(replayBefore);
});

  test('auto-play human seats can execute an automated action on their turn', async () => {
    jest.useFakeTimers();
    try {
      const game = new PokerGame('autoplay_turn', { smallBlind: 10, bigBlind: 20 });
      game.onMessage = () => {};
      game.onUpdate = () => {};
      game.onChat = () => {};
      game.onRoundEnd = () => {};

      const autoHero = game.addPlayer({ id: 'p1', name: 'Hero' });
      const villain = game.addPlayer({ id: 'p2', name: 'Villain' });
      game.startRound();

      autoHero.autoPlay = true;
      autoHero.holeCards = [Card('spades', 14), Card('hearts', 14)];
      villain.holeCards = [Card('clubs', 2), Card('diamonds', 7)];
      game.currentPlayerIndex = autoHero.seatIndex;
      game.currentBet = 20;
      autoHero.bet = 10;
      autoHero.totalBet = 10;
      autoHero.folded = false;
      autoHero.allIn = false;
      autoHero.chips = 990;
      game.isRunning = true;

      game.processAutoTurn();
      jest.advanceTimersByTime(AUTO_TURN_DELAY_MS + 100);
      await Promise.resolve();
      await Promise.resolve();

      // Facing a bet of 20 with 10 in: a sit-out folds rather than call.
      expect(autoHero.lastAction).toBeTruthy();
      expect(autoHero.lastAction.action).toBe('fold');
    } finally {
      jest.useRealTimers();
    }
  });

  test('automated turns expose visible timer metadata while thinking', () => {
    jest.useFakeTimers();
    try {
      const game = new PokerGame('autoplay_timer', { smallBlind: 10, bigBlind: 20 });
      game.onMessage = () => {};
      game.onUpdate = () => {};
      game.onChat = () => {};
      game.onRoundEnd = () => {};

      const autoHero = game.addPlayer({ id: 'p1', name: 'Hero' });
      game.addPlayer({ id: 'p2', name: 'Villain' });
      game.startRound();

      autoHero.autoPlay = true;
      autoHero.folded = false;
      autoHero.allIn = false;
      game.currentPlayerIndex = autoHero.seatIndex;
      game.isRunning = true;

      game.processAutoTurn();

      expect(game.turnDurationMs).toBeGreaterThan(0);
      expect(game.turnExpiresAt).toBeGreaterThan(Date.now());
    } finally {
      jest.useRealTimers();
    }
  });

  test('human turn timeout switches the seat to auto-play and acts', async () => {
    jest.useFakeTimers();
    try {
      const game = new PokerGame('turn_timeout', {
        smallBlind: 10,
        bigBlind: 20,
        actionTimeoutMs: 30,
      });
      game.onMessage = () => {};
      game.onUpdate = () => {};
      game.onChat = () => {};
      game.onRoundEnd = () => {};

      const hero = game.addPlayer({ id: 'p1', name: 'Hero' });
      const villain = game.addPlayer({ id: 'p2', name: 'Villain' });
      game.startRound();

      hero.holeCards = [Card('spades', 14), Card('hearts', 12)];
      villain.holeCards = [Card('clubs', 7), Card('diamonds', 6)];
      hero.autoPlay = false;
      hero.folded = false;
      hero.allIn = false;
      hero.chips = 990;
      hero.bet = 10;
      hero.totalBet = 10;
      game.currentPlayerIndex = hero.seatIndex;
      game.currentBet = 20;

      game.beginCurrentTurn();
      jest.advanceTimersByTime(35);
      expect(hero.autoPlay).toBe(true);

      jest.advanceTimersByTime(AUTO_TURN_DELAY_MS + 100);
      expect(hero.lastAction).toBeTruthy();
      expect(hero.lastAction.action).toBe('fold');
    } finally {
      jest.useRealTimers();
    }
  });

  test('a table where every seat sits out plays hands out instead of spinning', async () => {
    jest.useFakeTimers();
    try {
      const game = new PokerGame('all_sitting_out', { smallBlind: 10, bigBlind: 20 });
      game.onMessage = () => {};
      game.onUpdate = () => {};
      game.onChat = () => {};
      game.onRoundEnd = () => {};

      const a = game.addPlayer({ id: 'p1', name: 'A', chips: 100 });
      const b = game.addPlayer({ id: 'p2', name: 'B', chips: 100 });
      game.startRound();
      a.autoPlay = true;
      b.autoPlay = true;

      const realHandleAction = game.handleAction.bind(game);
      let actions = 0;
      game.handleAction = (...args) => {
        actions += 1;
        return realHandleAction(...args);
      };

      // Both seats fold to the blind or check it down, so a hand is a handful
      // of actions. If the delay ever collapsed to zero this would be a hot
      // loop and the count would run away.
      game.beginCurrentTurn();
      jest.advanceTimersByTime(AUTO_TURN_DELAY_MS * 20);
      expect(actions).toBeGreaterThan(0);
      expect(actions).toBeLessThan(20);
      game.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test('requesting time defers the auto-play switch by the grant, once per hand', () => {
    jest.useFakeTimers();
    try {
      const game = new PokerGame('time_bank', {
        smallBlind: 10,
        bigBlind: 20,
        actionTimeoutMs: 100,
        timeBankGrantMs: 200,
      });
      game.onMessage = () => {};
      game.onUpdate = () => {};
      game.onChat = () => {};
      game.onRoundEnd = () => {};

      const hero = game.addPlayer({ id: 'p1', name: 'Hero' });
      const villain = game.addPlayer({ id: 'p2', name: 'Villain' });
      game.startRound();

      hero.holeCards = [Card('spades', 14), Card('hearts', 12)];
      villain.holeCards = [Card('clubs', 7), Card('diamonds', 6)];
      hero.autoPlay = false;
      hero.folded = false;
      hero.allIn = false;
      game.currentPlayerIndex = hero.seatIndex;
      game.currentBet = 20;

      game.beginCurrentTurn();
      expect(game.getStateForPlayer('p1').timeBank).toEqual({ extensionsLeft: 1, grantMs: 200 });

      jest.advanceTimersByTime(60);
      expect(game.requestTimeExtension('p2')).toBe(false); // not their turn
      expect(game.requestTimeExtension('p1')).toBe(true);
      expect(game.requestTimeExtension('p1')).toBe(false); // allowance spent
      expect(game.getStateForPlayer('p1').timeBank.extensionsLeft).toBe(0);
      expect(game.turnDurationMs).toBe(300);

      // The original deadline passes without a switch...
      jest.advanceTimersByTime(60);
      expect(hero.autoPlay).toBe(false);
      // ...and the extended one triggers it: 40ms remained plus the 200ms grant.
      jest.advanceTimersByTime(190);
      expect(hero.autoPlay).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('Dealer narration', () => {
  test('a hand narrates the blinds, the board and the showdown, each line tagged', () => {
    const game = new PokerGame('narration', { smallBlind: 10, bigBlind: 20 });
    const lines = [];
    game.onMessage = (msg, meta) => lines.push({ msg, meta });
    game.onUpdate = () => {};
    game.onChat = () => {};
    game.onRoundEnd = () => {};
    game.addPlayer({ id: 'p1', name: 'Hero' });
    game.addPlayer({ id: 'p2', name: 'Villain' });
    game.startRound();
    const ofKind = (kind) => lines.filter((l) => l.meta && l.meta.kind === kind);

    expect(ofKind('handStart')[0].msg).toMatch(/^🃏 Hand 1 starts!.*blinds 10\/20$/);
    expect(ofKind('handStart')[0].meta.handNum).toBe(1);
    expect(ofKind('blind').map((l) => l.msg)).toEqual([
      expect.stringMatching(/ posts small blind 10$/),
      expect.stringMatching(/ posts big blind 20$/),
    ]);

    game.nextPhase();
    const flop = ofKind('street')[0];
    expect(flop.msg).toMatch(/^── Flop ── \S+ \S+ \S+$/);
    expect(flop.meta.street).toBe('flop');
    game.nextPhase();
    game.nextPhase();
    expect(ofKind('street').map((l) => l.meta.street)).toEqual(['flop', 'turn', 'river']);
    expect(ofKind('street')[2].msg).toMatch(/^── River ── \S+$/);

    game.nextPhase();
    const shows = ofKind('show');
    expect(shows).toHaveLength(2);
    expect(shows[0].msg).toMatch(/ shows \S+ \S+ · /);
    expect(ofKind('win').length).toBeGreaterThan(0);
    expect(ofKind('win')[0].meta.handNum).toBe(1);
    // The untagged betting strings the client sniffs are still there verbatim.
    // A chopped pot says "splits pot" instead; both are the untouched strings.
    expect(lines.some((l) => /wins \d+!|splits pot \d+/.test(l.msg))).toBe(true);
  });
});

// ============================================================
//  Precise comparison within same hand ranktest
// ============================================================
describe('Same Rank Hand Comparisons', () => {
  test('higher flush > lower flush (A-high vs K-high)', () => {
    const aceFlush = evaluateHand([
      Card('hearts', 14),
      Card('hearts', 9),
      Card('hearts', 7),
      Card('hearts', 5),
      Card('hearts', 3),
      Card('clubs', 2),
      Card('diamonds', 4),
    ]);
    const kingFlush = evaluateHand([
      Card('hearts', 13),
      Card('hearts', 10),
      Card('hearts', 8),
      Card('hearts', 6),
      Card('hearts', 4),
      Card('clubs', 2),
      Card('diamonds', 3),
    ]);
    expect(aceFlush.name).toBe('Flush');
    expect(kingFlush.name).toBe('Flush');
    expect(compareHands(aceFlush, kingFlush)).toBeGreaterThan(0);
  });

  test('higher pair > lower pair (KK > QQ)', () => {
    const kk = evaluateHand([
      Card('hearts', 13),
      Card('spades', 13),
      Card('diamonds', 9),
      Card('clubs', 7),
      Card('hearts', 3),
      Card('clubs', 2),
      Card('diamonds', 4),
    ]);
    const qq = evaluateHand([
      Card('hearts', 12),
      Card('spades', 12),
      Card('diamonds', 9),
      Card('clubs', 7),
      Card('hearts', 3),
      Card('clubs', 2),
      Card('diamonds', 4),
    ]);
    expect(compareHands(kk, qq)).toBeGreaterThan(0);
  });

  test('same pair different kicker (AA with K > AA with Q)', () => {
    const aaK = evaluateHand([
      Card('hearts', 14),
      Card('spades', 14),
      Card('diamonds', 13),
      Card('clubs', 7),
      Card('hearts', 3),
      Card('clubs', 2),
      Card('diamonds', 4),
    ]);
    const aaQ = evaluateHand([
      Card('diamonds', 14),
      Card('clubs', 14),
      Card('hearts', 12),
      Card('spades', 7),
      Card('diamonds', 3),
      Card('spades', 2),
      Card('hearts', 4),
    ]);
    expect(compareHands(aaK, aaQ)).toBeGreaterThan(0);
  });

  test('higher full house > lower full house (KKK22 > QQQ22)', () => {
    const kkk = evaluateHand([
      Card('hearts', 13),
      Card('spades', 13),
      Card('diamonds', 13),
      Card('clubs', 2),
      Card('hearts', 2),
      Card('clubs', 5),
      Card('diamonds', 8),
    ]);
    const qqq = evaluateHand([
      Card('hearts', 12),
      Card('spades', 12),
      Card('diamonds', 12),
      Card('clubs', 2),
      Card('hearts', 2),
      Card('clubs', 5),
      Card('diamonds', 8),
    ]);
    expect(compareHands(kkk, qqq)).toBeGreaterThan(0);
  });

  test('higher straight > lower straight (T-high vs 9-high)', () => {
    const highStr = evaluateHand([
      Card('hearts', 10),
      Card('spades', 9),
      Card('diamonds', 8),
      Card('clubs', 7),
      Card('hearts', 6),
      Card('clubs', 2),
      Card('diamonds', 3),
    ]);
    const lowStr = evaluateHand([
      Card('hearts', 9),
      Card('spades', 8),
      Card('diamonds', 7),
      Card('clubs', 6),
      Card('hearts', 5),
      Card('clubs', 2),
      Card('diamonds', 3),
    ]);
    expect(compareHands(highStr, lowStr)).toBeGreaterThan(0);
  });
});

// ============================================================
//  extreme side potscenario
// ============================================================
describe('Extreme Side Pot Scenarios', () => {
  let game;
  beforeEach(() => {
    game = new PokerGame('extreme', { smallBlind: 10, bigBlind: 20 });
    game.onMessage = () => {};
    game.onUpdate = () => {};
    game.onChat = () => {};
    game.onRoundEnd = () => {};
  });

  test('5-player 5-level side pot chip conservation', () => {
    const players = [];
    for (let i = 0; i < 5; i++) {
      players.push(game.addPlayer({ id: `p${i}`, name: `P${i}` }));
    }
    game.startRound();

    // each player bets different amount
    const bets = [100, 300, 600, 1000, 2000];
    bets.forEach((b, i) => {
      players[i].totalBet = b;
      players[i].chips = i === 4 ? 3000 : 0;
      players[i].allIn = i !== 4;
    });
    game.pot = bets.reduce((a, b) => a + b, 0); // 4000

    game.communityCards = [
      Card('hearts', 14),
      Card('spades', 13),
      Card('diamonds', 12),
      Card('clubs', 11),
      Card('hearts', 10),
    ];

    // P0 strongest (royal impossible, give best kicker）
    players[0].holeCards = [Card('spades', 14), Card('spades', 13)]; // Two pair AK
    players[1].holeCards = [Card('diamonds', 9), Card('clubs', 8)];
    players[2].holeCards = [Card('hearts', 7), Card('clubs', 6)];
    players[3].holeCards = [Card('hearts', 5), Card('clubs', 4)];
    players[4].holeCards = [Card('hearts', 3), Card('clubs', 2)];

    game.showdown();

    const total = players.reduce((s, p) => s + p.chips, 0);
    expect(total).toBe(4000 + 3000); // original pot + P4remaining chips
    for (const p of players) {
      expect(p.chips).toBeGreaterThanOrEqual(0);
    }
    // P0 strongest，wins main pot
    expect(players[0].wins).toBe(1);
  });

  test('Two players same bet same hand = perfect split', () => {
    const p1 = game.addPlayer({ id: 'p1', name: 'Twin1' });
    const p2 = game.addPlayer({ id: 'p2', name: 'Twin2' });
    game.startRound();

    p1.totalBet = 500;
    p1.chips = 500;
    p2.totalBet = 500;
    p2.chips = 500;
    game.pot = 1000;

    // Community cardsformsstrongesthand， playerhandunaffected
    game.communityCards = [
      Card('spades', 14),
      Card('spades', 13),
      Card('spades', 12),
      Card('spades', 11),
      Card('spades', 10),
    ];
    p1.holeCards = [Card('hearts', 2), Card('clubs', 3)];
    p2.holeCards = [Card('diamonds', 4), Card('hearts', 5)];

    game.showdown();

    expect(p1.chips).toBe(1000); // 500 + wins back 500
    expect(p2.chips).toBe(1000);
    expect(p1.wins).toBe(1);
    expect(p2.wins).toBe(1);
  });

  test('All all-in, weakest invested most → refund correct', () => {
    const p1 = game.addPlayer({ id: 'p1', name: 'Rich' });
    const p2 = game.addPlayer({ id: 'p2', name: 'Poor' });
    game.startRound();

    // Rich invested 2000 but cardworst，Poor only invested 500 but cardbest
    p1.totalBet = 2000;
    p1.chips = 0;
    p1.allIn = true;
    p2.totalBet = 500;
    p2.chips = 0;
    p2.allIn = true;
    game.pot = 2500;

    game.communityCards = [
      Card('hearts', 10),
      Card('spades', 9),
      Card('diamonds', 8),
      Card('clubs', 4),
      Card('hearts', 2),
    ];
    p2.holeCards = [Card('spades', 14), Card('diamonds', 14)]; // one pairA（strongest）
    p1.holeCards = [Card('hearts', 3), Card('clubs', 5)]; // junk

    game.showdown();

    // Poor wins main pot 500*2=1000, Rich refund 2000-500=1500
    expect(p2.chips).toBe(1000);
    expect(p1.chips).toBe(1500);
    expect(p2.wins).toBe(1);
    expect(p1.wins).toBe(0); // refund does not count as win
  });

  test('200 randomized showdown settlements preserve chips and keep stacks non-negative', () => {
    const makeRng = (seed) => () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const deck = [];
    for (const suit of ['spades', 'hearts', 'diamonds', 'clubs']) {
      for (let value = 2; value <= 14; value++) {
        deck.push(Card(suit, value));
      }
    }

    for (let scenario = 0; scenario < 200; scenario++) {
      game = new PokerGame(`random_showdown_${scenario}`, { smallBlind: 10, bigBlind: 20 });
      game.onMessage = () => {};
      game.onUpdate = () => {};
      game.onChat = () => {};
      game.onRoundEnd = () => {};

      const rand = makeRng(0xabc000 + scenario);
      const playerCount = 2 + Math.floor(rand() * 5);
      const players = [];
      for (let i = 0; i < playerCount; i++) {
        players.push(game.addPlayer({ id: `p${i}`, name: `P${i}` }));
      }
      game.startRound();

      const shuffled = [...deck];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }

      game.communityCards = shuffled.slice(0, 5);
      let cardIndex = 5;
      let atLeastTwoContenders = 0;

      for (const player of players) {
        player.holeCards = [shuffled[cardIndex++], shuffled[cardIndex++]];
        player.chips = 1000 + Math.floor(rand() * 2000);
        const invested = Math.floor(rand() * (player.chips + 1));
        player.chips -= invested;
        player.totalBet = invested;
        player.bet = invested;
        player.allIn = player.chips === 0 && invested > 0;
        player.folded = invested > 0 && rand() < 0.35;
        if (!player.folded) atLeastTwoContenders++;
      }

      if (atLeastTwoContenders < 2) {
        const nonFolded = players.filter((player) => !player.folded);
        for (const player of players) {
          if (nonFolded.length >= 2) break;
          if (player.folded) {
            player.folded = false;
            nonFolded.push(player);
          }
        }
      }

      if (players.every((player) => player.totalBet === 0)) {
        players[0].totalBet = 40;
        players[0].bet = 40;
        players[0].chips -= 40;
        players[1].totalBet = 40;
        players[1].bet = 40;
        players[1].chips -= 40;
      }

      const maxContenderBet = Math.max(
        ...players.filter((player) => !player.folded).map((player) => player.totalBet)
      );
      for (const player of players) {
        if (!player.folded || player.totalBet <= maxContenderBet) continue;
        const unmatched = player.totalBet - maxContenderBet;
        player.totalBet = maxContenderBet;
        player.bet = Math.min(player.bet, maxContenderBet);
        player.chips += unmatched;
      }

      game.pot = players.reduce((sum, player) => sum + player.totalBet, 0);
      const chipsBefore = players.reduce((sum, player) => sum + player.chips + player.totalBet, 0);

      game.showdown();

      const chipsAfter = players.reduce((sum, player) => sum + player.chips, 0);
      expect(chipsAfter).toBe(chipsBefore);
      for (const player of players) {
        expect(player.chips).toBeGreaterThanOrEqual(0);
      }
      expect(
        new Set(game.lastRoundWinnerIds).size === game.lastRoundWinnerIds.length
      ).toBeTruthy();
      for (const refund of game.lastRoundRefunds) {
        expect(refund.amount).toBeGreaterThan(0);
      }
    }
  });
});

// ============================================================
// actioncompletetest
// ============================================================
describe('Action Flow & Game Mechanics', () => {
  test('later-street calls still pay the current street bet even if totalBet is already higher', () => {
    const game = new PokerGame('call_bug', { smallBlind: 10, bigBlind: 20 });
    game.onMessage = () => {};
    game.onUpdate = () => {};
    game.onChat = () => {};
    game.onRoundEnd = () => {};

    const p1 = game.addPlayer({ id: 'p1', name: 'Caller' });
    const p2 = game.addPlayer({ id: 'p2', name: 'Bettor' });
    game.startRound();

    game.phase = 'turn';
    const callerIndex = game.players.findIndex((player) => player.id === 'p1');
    const bettorIndex = game.players.findIndex((player) => player.id === 'p2');
    game.currentPlayerIndex = callerIndex;
    game.currentBet = 20;
    game.minRaise = 20;
    game.players[callerIndex].bet = 0;
    game.players[callerIndex].totalBet = 120;
    game.players[callerIndex].chips = 200;
    game.players[bettorIndex].bet = 20;
    game.players[bettorIndex].totalBet = 120;
    game.players[bettorIndex].chips = 200;
    game.lastRaiserIndex = bettorIndex;
    game.nextPhase = jest.fn();

    const ok = game.handleAction('p1', 'call');

    expect(ok).toBe(true);
    expect(game.players[callerIndex].bet).toBe(20);
    expect(game.players[callerIndex].totalBet).toBe(140);
    expect(game.players[callerIndex].chips).toBe(180);
    expect(game.nextPhase).toHaveBeenCalled();
  });

  test('short stacks that cannot clear the minimum raise become all-in instead of fake-raising', () => {
    const game = new PokerGame('raise_short_allin', { smallBlind: 10, bigBlind: 20 });
    game.onMessage = () => {};
    game.onUpdate = () => {};
    game.onChat = () => {};
    game.onRoundEnd = () => {};

    game.addPlayer({ id: 'p1', name: 'Shorty' });
    game.addPlayer({ id: 'p2', name: 'Villain' });
    game.startRound();

    const shortIndex = game.players.findIndex((player) => player.id === 'p1');
    const villainIndex = game.players.findIndex((player) => player.id === 'p2');
    game.currentPlayerIndex = shortIndex;
    game.currentBet = 40;
    game.minRaise = 40;
    game.players[shortIndex].bet = 0;
    game.players[shortIndex].totalBet = 40;
    game.players[shortIndex].chips = 60;
    game.players[villainIndex].bet = 40;
    game.players[villainIndex].totalBet = 80;
    game.players[villainIndex].chips = 200;

    const ok = game.handleAction('p1', 'raise', 80);

    expect(ok).toBe(true);
    expect(game.players[shortIndex].allIn).toBe(true);
    expect(game.players[shortIndex].bet).toBe(60);
    expect(game.currentBet).toBe(60);
    expect(game.players[shortIndex].lastAction.action).toBe('allin');
  });

  test('raise → re-raise → call not ', () => {
    const game = new PokerGame('flow', { smallBlind: 10, bigBlind: 20 });
    game.onMessage = () => {};
    game.onUpdate = () => {};
    game.onChat = () => {};
    game.onRoundEnd = () => {};

    const p1 = game.addPlayer({ id: 'p1', name: 'A' });
    const p2 = game.addPlayer({ id: 'p2', name: 'B' });
    const p3 = game.addPlayer({ id: 'p3', name: 'C' });
    game.startRound();

    // not action， do raise/call/fold not
    let moves = 0;
    while (game.isRunning && moves < 50) {
      const cp = game.players[game.currentPlayerIndex];
      if (!cp || cp.folded || cp.allIn) break;

      if (moves % 3 === 0) {
        game.handleAction(cp.id, 'raise', game.currentBet + game.minRaise + 50);
      } else if (moves % 3 === 1) {
        game.handleAction(cp.id, 'call');
      } else {
        game.handleAction(cp.id, 'fold');
      }
      moves++;
    }

    // only need no count
    const total = game.players.reduce((s, p) => s + p.chips, 0) + (game.isRunning ? game.pot : 0);
    expect(total).toBe(3000);
  });

  test('invalidaction not Game state', () => {
    const game = new PokerGame('invalid', { smallBlind: 10, bigBlind: 20 });
    game.onMessage = () => {};
    game.onUpdate = () => {};
    game.onChat = () => {};
    game.onRoundEnd = () => {};

    const p1 = game.addPlayer({ id: 'p1', name: 'A' });
    const p2 = game.addPlayer({ id: 'p2', name: 'B' });
    game.startRound();

    const chipsBefore = game.players.map((p) => p.chips);
    const potBefore = game.pot;

    // use player ID do action
    const result = game.handleAction('nonexistent_id', 'raise', 100);
    expect(result).toBeFalsy();
    expect(game.pot).toBe(potBefore);
  });

  test('500hand6 playerNPCstresstestno no chips', () => {
    const ROUNDS = 500;
    let crashes = 0;

    for (let r = 0; r < ROUNDS; r++) {
      try {
        const g = new PokerGame(`s${r}`, { smallBlind: 10, bigBlind: 20 });
        g.onMessage = () => {};
        g.onUpdate = () => {};
        g.onChat = () => {};
        g.onRoundEnd = () => {};

        for (let i = 0; i < 6; i++) {
          g.addPlayer({ id: `p${i}`, name: `P${i}` });
        }
        g.startRound();

        let moves = 0;
        while (g.isRunning && moves < 120) {
          const cp = g.players[g.currentPlayerIndex];
          if (!cp || cp.folded || cp.allIn) break;

          const roll = Math.random();
          if (roll < 0.2) g.handleAction(cp.id, 'fold');
          else if (roll < 0.6) g.handleAction(cp.id, 'call');
          else if (roll < 0.85)
            g.handleAction(
              cp.id,
              'raise',
              g.currentBet + g.minRaise + Math.floor(Math.random() * 200)
            );
          else g.handleAction(cp.id, 'raise', cp.chips); // all-in
          moves++;
        }

        const total = g.players.reduce((s, p) => s + p.chips, 0) + (g.isRunning ? g.pot : 0);
        expect(total).toBe(6000);
        for (const p of g.players) expect(p.chips).toBeGreaterThanOrEqual(0);
      } catch (e) {
        crashes++;
        console.error(`Round ${r} crashed:`, e.message);
      }
    }
    expect(crashes).toBe(0);
  });
});

describe('street pacing', () => {
  function twoHanded(opts) {
    const game = new PokerGame('paced', { smallBlind: 10, bigBlind: 20, ...opts });
    game.onMessage = () => {};
    game.onUpdate = () => {};
    game.onChat = () => {};
    game.onRoundEnd = () => {};
    const a = game.addPlayer({ id: 'p1', name: 'A' });
    const b = game.addPlayer({ id: 'p2', name: 'B' });
    game.startRound();
    return { game, a, b };
  }

  test('with no pause configured the street opens in the same call', () => {
    const { game } = twoHanded();
    expect(game.phase).toBe('preflop');
    game.nextPhase();
    expect(game.phase).toBe('flop');
    expect(game.communityCards).toHaveLength(3);
  });

  test('a pause holds the bets on the felt, then opens the street', () => {
    jest.useFakeTimers();
    try {
      const { game, a } = twoHanded({ streetPauseMs: 500 });
      const betBefore = a.bet;
      expect(betBefore).toBeGreaterThan(0);

      game.nextPhase();
      // Held: the bets are still in front of the players and no card has come
      // out. This is the frame the sweep animation plays against.
      expect(game.phase).toBe('preflop');
      expect(game.communityCards).toHaveLength(0);
      expect(a.bet).toBe(betBefore);

      jest.advanceTimersByTime(520);
      expect(game.phase).toBe('flop');
      expect(game.communityCards).toHaveLength(3);
      expect(a.bet).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('nobody can act into the held beat', () => {
    jest.useFakeTimers();
    try {
      const { game } = twoHanded({ streetPauseMs: 500 });
      const actor = game.players[game.currentPlayerIndex];
      game.nextPhase();
      // currentPlayerIndex still points at whoever closed the round, so
      // without the guard they could act a second time on a dead street.
      expect(game.handleAction(actor.id, 'check')).toBe(false);
      expect(game.getStateForPlayer(actor.id).isMyTurn).toBe(false);
      expect(game.getStateForPlayer(actor.id).turnExpiresAt).toBeNull();
      jest.advanceTimersByTime(520);
      expect(game.phase).toBe('flop');
    } finally {
      jest.useRealTimers();
    }
  });

  test('stopping the table drops a pending street', () => {
    jest.useFakeTimers();
    try {
      const { game } = twoHanded({ streetPauseMs: 500 });
      game.nextPhase();
      game.stop();
      jest.advanceTimersByTime(2000);
      // The street never opened: a stopped table must not deal itself a flop.
      expect(game.phase).toBe('preflop');
      expect(game.communityCards).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('an all-in run-out deals a card at a time on the same beat', () => {
    jest.useFakeTimers();
    try {
      const { game, a, b } = twoHanded({ streetPauseMs: 300 });
      a.holeCards = [Card('spades', 14), Card('hearts', 14)];
      b.holeCards = [Card('clubs', 2), Card('diamonds', 7)];
      a.allIn = true;
      b.allIn = true;

      game.dealRemainingCards();
      expect(game.communityCards).toHaveLength(1);
      jest.advanceTimersByTime(320);
      expect(game.communityCards).toHaveLength(2);
      jest.advanceTimersByTime(320 * 4);
      expect(game.communityCards).toHaveLength(5);
      expect(game.phase).toBe('showdown');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('showdown winning cards', () => {
  function table() {
    const game = new PokerGame('winners', { smallBlind: 10, bigBlind: 20 });
    game.onMessage = () => {};
    game.onUpdate = () => {};
    game.onChat = () => {};
    game.onRoundEnd = () => {};
    return game;
  }

  const key = (c) => `${c.rank}${c.suit}`;

  test('the five cards that made the hand are reported, and only those', () => {
    const game = table();
    const hero = game.addPlayer({ id: 'p1', name: 'Hero' });
    const villain = game.addPlayer({ id: 'p2', name: 'Villain' });
    game.startRound();
    game.communityCards = [
      Card('spades', 13),
      Card('diamonds', 13),
      Card('hearts', 7),
      Card('clubs', 9),
      Card('diamonds', 2),
    ];
    // Kings full of sevens: both board kings, the board seven, and both of
    // Hero's cards. Villain's nines lose.
    hero.holeCards = [Card('clubs', 13), Card('spades', 7)];
    villain.holeCards = [Card('diamonds', 9), Card('spades', 9)];
    hero.totalBet = 100;
    villain.totalBet = 100;
    game.pot = 200;

    game.showdown();

    expect(game.lastRoundWinnerIds).toEqual(['p1']);
    expect(game.showdownWinningCards).toHaveLength(5);
    const won = new Set(game.showdownWinningCards);
    for (const c of [
      Card('spades', 13),
      Card('diamonds', 13),
      Card('clubs', 13),
      Card('hearts', 7),
      Card('spades', 7),
    ]) {
      expect(won.has(key(c))).toBe(true);
    }
    // The board cards that did not play, and the loser's cards, are not in it.
    expect(won.has(key(Card('clubs', 9)))).toBe(false);
    expect(won.has(key(Card('diamonds', 2)))).toBe(false);
    expect(won.has(key(Card('spades', 9)))).toBe(false);
  });

  test("a winner's own unused card is not reported", () => {
    const game = table();
    const hero = game.addPlayer({ id: 'p1', name: 'Hero' });
    const villain = game.addPlayer({ id: 'p2', name: 'Villain' });
    game.startRound();
    game.communityCards = [
      Card('spades', 14),
      Card('diamonds', 14),
      Card('hearts', 14),
      Card('clubs', 5),
      Card('diamonds', 4),
    ];
    // Trip aces on the board plus Hero's king kicker. The deuce plays no part.
    hero.holeCards = [Card('clubs', 13), Card('spades', 2)];
    villain.holeCards = [Card('diamonds', 8), Card('spades', 3)];
    hero.totalBet = 100;
    villain.totalBet = 100;
    game.pot = 200;

    game.showdown();

    const won = new Set(game.showdownWinningCards);
    expect(won.has(key(Card('clubs', 13)))).toBe(true);
    expect(won.has(key(Card('spades', 2)))).toBe(false);
    expect(game.showdownWinningCards).toHaveLength(5);
  });

  test('a split pot reports the union of both winning hands', () => {
    const game = table();
    const a = game.addPlayer({ id: 'p1', name: 'A' });
    const b = game.addPlayer({ id: 'p2', name: 'B' });
    game.startRound();
    // The board plays for everyone: a broadway straight nobody can improve.
    game.communityCards = [
      Card('spades', 14),
      Card('diamonds', 13),
      Card('hearts', 12),
      Card('clubs', 11),
      Card('diamonds', 10),
    ];
    a.holeCards = [Card('clubs', 3), Card('spades', 2)];
    b.holeCards = [Card('hearts', 4), Card('spades', 5)];
    a.totalBet = 100;
    b.totalBet = 100;
    game.pot = 200;

    game.showdown();

    expect(game.lastRoundWinnerIds.sort()).toEqual(['p1', 'p2']);
    // Both hands are the same five board cards, so the union is still five.
    expect(game.showdownWinningCards).toHaveLength(5);
    expect(new Set(game.showdownWinningCards).size).toBe(5);
  });

  test('a hand won by everyone folding reports no winning cards', () => {
    const game = table();
    const hero = game.addPlayer({ id: 'p1', name: 'Hero' });
    const villain = game.addPlayer({ id: 'p2', name: 'Villain' });
    game.startRound();
    villain.folded = true;
    game.pot = 200;

    game.showdown();

    expect(game.lastRoundWinnerIds).toEqual(['p1']);
    // Nothing is face up to mark, and no hand was evaluated.
    expect(game.showdownWinningCards).toEqual([]);
  });

  test('a new hand clears the last showdown', () => {
    const game = table();
    game.addPlayer({ id: 'p1', name: 'A' });
    game.addPlayer({ id: 'p2', name: 'B' });
    game.startRound();
    game.showdownWinningCards = ['Kspades'];
    game.startRound();
    expect(game.showdownWinningCards).toEqual([]);
  });
});

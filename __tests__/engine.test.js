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
    const randomSpy = jest
      .spyOn(random, 'randomInt')
      .mockImplementation((max) => (Number.isInteger(max) && max > 0 ? max - 1 : 0));
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

  // Letting the clock go once is a moment of inattention and costs that hand.
  // Twice in a row is somebody who has walked away, and only then is the seat
  // sat out - a player who comes back to find themselves sitting out has to
  // notice that before they can undo it.
  function timeoutTable() {
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
    return { game, hero, villain };
  }

  // Put the hero back on the clock facing a bet, whatever the hand did next.
  function heroToAct(game, hero) {
    hero.folded = false;
    hero.allIn = false;
    hero.chips = 990;
    hero.bet = 10;
    hero.totalBet = 10;
    game.isRunning = true;
    game.currentPlayerIndex = hero.seatIndex;
    game.currentBet = 20;
    game.beginCurrentTurn();
  }

  test('a first timeout folds the hand but leaves the seat in', async () => {
    jest.useFakeTimers();
    try {
      const { game, hero } = timeoutTable();
      hero.autoPlay = false;
      heroToAct(game, hero);
      jest.advanceTimersByTime(35);

      expect(hero.timeoutStrikes).toBe(1);
      expect(hero.autoPlay).toBe(false);
      expect(hero.sitOutReason).toBeNull();
      expect(hero.folded).toBe(true);
      expect(hero.lastAction.action).toBe('fold');
    } finally {
      jest.useRealTimers();
    }
  });

  test('a second timeout in a row sits the seat out', async () => {
    jest.useFakeTimers();
    try {
      const { game, hero } = timeoutTable();
      hero.autoPlay = false;
      heroToAct(game, hero);
      jest.advanceTimersByTime(35);
      expect(hero.autoPlay).toBe(false);

      heroToAct(game, hero);
      jest.advanceTimersByTime(35);
      expect(hero.timeoutStrikes).toBe(2);
      expect(hero.autoPlay).toBe(true);
      expect(hero.sitOutReason).toBe('timeout');

      jest.advanceTimersByTime(AUTO_TURN_DELAY_MS + 100);
      expect(hero.lastAction).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  test('acting for yourself clears the strike, so two must be consecutive', async () => {
    jest.useFakeTimers();
    try {
      const { game, hero } = timeoutTable();
      hero.autoPlay = false;
      heroToAct(game, hero);
      jest.advanceTimersByTime(35);
      expect(hero.timeoutStrikes).toBe(1);

      // A hand they play themselves puts the slate back.
      heroToAct(game, hero);
      game.handleAction(hero.id, 'call');
      expect(hero.timeoutStrikes).toBe(0);

      // So the next one they let go is a first strike again, not a second.
      heroToAct(game, hero);
      jest.advanceTimersByTime(35);
      expect(hero.timeoutStrikes).toBe(1);
      expect(hero.autoPlay).toBe(false);
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

  // The preflop live-blind branch in advanceAction is not reachable in ordinary
  // play: with the big blind still unacted, either nobody raised — in which case
  // lastRaiserIndex is the big blind and the actor walk exits through nextPhase
  // before it — or somebody did, in which case the blind has not matched the
  // price and the branch's own guard fails. The state below is therefore built
  // by hand. It is pinned anyway because the pre-action fire path assumes every
  // turn opens through beginCurrentTurn, and a branch that opened one without a
  // clock would strand the table if it ever became reachable.
  test('a turn opened on the big blind option arms a clock like any other', () => {
    jest.useFakeTimers();
    try {
      const game = new PokerGame('bb_option_clock', {
        smallBlind: 10,
        bigBlind: 20,
        actionTimeoutMs: 30,
      });
      game.onMessage = () => {};
      game.onUpdate = () => {};
      game.onChat = () => {};
      game.onRoundEnd = () => {};

      const folder = game.addPlayer({ id: 'p1', name: 'Folder' });
      const bb = game.addPlayer({ id: 'p2', name: 'BigBlind' });
      const shover = game.addPlayer({ id: 'p3', name: 'Shover' });
      game.startRound();

      game.phase = 'preflop';
      game.bbIndex = bb.seatIndex;
      game.currentBet = 100;
      game.lastRaiserIndex = shover.seatIndex;
      game.currentPlayerIndex = shover.seatIndex;
      folder.folded = true;
      shover.folded = false;
      shover.allIn = true;
      shover.bet = 100;
      // The blind has matched the price and has not acted: the option is live.
      bb.folded = false;
      bb.allIn = false;
      bb.chips = 500;
      bb.bet = 100;
      bb.lastAction = null;
      game.isRunning = true;
      // handleAction clears the acting seat's clock before it advances, so the
      // branch under test is reached with no timer running. Without that the
      // assertion below would pass on the clock startRound already armed.
      game.clearActionTimeout();
      expect(game.actionTimeout).toBeFalsy();

      game.advanceAction();

      expect(game.currentPlayerIndex).toBe(bb.seatIndex);
      expect(game.actionTimeout).toBeTruthy();
      expect(game.turnExpiresAt).toBeGreaterThan(Date.now());
    } finally {
      jest.useRealTimers();
    }
  });

  // The big blind has already put the price in before anyone acts, so a walk
  // that only asks "has everybody matched?" closes the street on top of them.
  // Poker says the blind is live: a limped pot still owes them the option to
  // raise, and the engine has to hand them the turn to give it.
  test('the big blind gets its option when the pot is limped', () => {
    for (const seats of [2, 3, 4, 6]) {
      const game = armedTable(`bb_option_${seats}`, { actionTimeoutMs: 0 });
      for (let i = 0; i < seats; i++) {
        game.addPlayer({ id: `p${i}`, name: `P${i}`, chips: 5000 });
      }
      game.startRound();
      const bb = game.players[game.bbIndex];

      // Everybody limps in front of the blind.
      let guard = 0;
      while (game.phase === 'preflop' && guard++ < 12) {
        const cur = game.players[game.currentPlayerIndex];
        if (cur.id === bb.id) break;
        expect(game.handleAction(cur.id, 'call')).toBe(true);
      }

      expect(game.phase).toBe('preflop');
      expect(game.players[game.currentPlayerIndex].id).toBe(bb.id);
      // And the option is real: they can still put in a raise.
      expect(game.handleAction(bb.id, 'raise', 60)).toBe(true);
      expect(game.currentBet).toBe(60);
      game.stop();
    }
  });

  test('a big blind that checks its option closes the street', () => {
    const game = armedTable('bb_option_check', { actionTimeoutMs: 0 });
    for (let i = 0; i < 3; i++) game.addPlayer({ id: `p${i}`, name: `P${i}`, chips: 5000 });
    game.startRound();
    const bb = game.players[game.bbIndex];
    let guard = 0;
    while (game.phase === 'preflop' && guard++ < 12) {
      const cur = game.players[game.currentPlayerIndex];
      if (cur.id === bb.id) break;
      game.handleAction(cur.id, 'call');
    }
    expect(game.handleAction(bb.id, 'check')).toBe(true);
    // Taking the option ends it: the option is offered once, not every orbit.
    expect(game.phase).toBe('flop');
  });

  test('a raised pot gives the big blind no free option, only a call to make', () => {
    const game = armedTable('bb_option_raised', { actionTimeoutMs: 0 });
    for (let i = 0; i < 3; i++) game.addPlayer({ id: `p${i}`, name: `P${i}`, chips: 5000 });
    game.startRound();
    const bb = game.players[game.bbIndex];
    const first = game.players[game.currentPlayerIndex];
    game.handleAction(first.id, 'raise', 60);
    let guard = 0;
    while (game.phase === 'preflop' && guard++ < 12) {
      const cur = game.players[game.currentPlayerIndex];
      if (cur.id === bb.id) break;
      game.handleAction(cur.id, 'call');
    }
    // They act because they owe 40, not because the blind is live.
    expect(game.players[game.currentPlayerIndex].id).toBe(bb.id);
    expect(game.currentBet - bb.bet).toBe(40);
    game.handleAction(bb.id, 'call');
    expect(game.phase).toBe('flop');
  });

  // The ten-hand history is the great bulk of a state payload and changes only
  // when a hand ends, so the emit path sends it on the first push after each
  // hand and leaves it off the rest. Sending it per action meant rebuilding
  // and restringifying the same ten hands for every seat on every bet, which
  // is what put the server into a heap-exhaustion crash on a three-table field.
  test('the hand history can be left out of a state payload', () => {
    const game = armedTable('history_optional', { actionTimeoutMs: 0 });
    for (let i = 0; i < 4; i++) game.addPlayer({ id: `p${i}`, uid: `u${i}`, name: `P${i}` });
    // Play a couple of hands so there is a history worth omitting.
    for (let h = 0; h < 2; h++) {
      if (!game.startRound()) break;
      let guard = 0;
      while (game.isRunning && guard++ < 200) {
        const cur = game.players[game.currentPlayerIndex];
        if (!cur) break;
        const toCall = game.currentBet - cur.bet;
        if (!game.handleAction(cur.id, toCall > 0 ? 'call' : 'check')) {
          if (!game.handleAction(cur.id, 'fold')) break;
        }
      }
    }
    expect(game.handHistory.hands.length).toBeGreaterThan(0);

    // A caller that says nothing still gets everything.
    const full = game.getStateForPlayer('p0');
    expect(Array.isArray(full.recentHands)).toBe(true);
    expect(full.recentHands.length).toBeGreaterThan(0);

    const lean = game.getStateForPlayer('p0', { includeHistory: false });
    expect('recentHands' in lean).toBe(false);
    // Everything the felt needs to draw the moment is still there.
    expect(lean.players).toHaveLength(4);
    expect(lean.phase).toBe(full.phase);
    expect(lean.pot).toBe(full.pot);
    expect(JSON.stringify(lean).length).toBeLessThan(JSON.stringify(full).length / 2);
  });

  test('the history is rebuilt once per hand, not once per push', () => {
    const game = armedTable('history_cached', { actionTimeoutMs: 0 });
    for (let i = 0; i < 3; i++) game.addPlayer({ id: `p${i}`, uid: `u${i}`, name: `P${i}` });
    game.startRound();
    let guard = 0;
    while (game.isRunning && guard++ < 200) {
      const cur = game.players[game.currentPlayerIndex];
      if (!cur) break;
      const toCall = game.currentBet - cur.bet;
      if (!game.handleAction(cur.id, toCall > 0 ? 'call' : 'check')) break;
    }

    const first = game.getStateForPlayer('p0').recentHands;
    const second = game.getStateForPlayer('p0').recentHands;
    // Same array object: between hands there is nothing to rebuild.
    expect(second).toBe(first);

    const versionBefore = game.handHistory.version;
    game.startRound();
    let g2 = 0;
    while (game.isRunning && g2++ < 200) {
      const cur = game.players[game.currentPlayerIndex];
      if (!cur) break;
      const toCall = game.currentBet - cur.bet;
      if (!game.handleAction(cur.id, toCall > 0 ? 'call' : 'check')) break;
    }
    expect(game.handHistory.version).toBeGreaterThan(versionBefore);
    // A hand ended, so the next ask builds afresh.
    expect(game.getStateForPlayer('p0').recentHands).not.toBe(first);
  });

  // Seen on a live 200-player field: five players all matched at the same price,
  // all checking, round and round, for eight minutes. The betting round never
  // closed and the table never dealt another hand. The walk in advanceAction
  // ends a street by returning to lastRaiserIndex, which is a proxy for the
  // real rule; when those indices stop agreeing with the table the proxy has no
  // terminator and hands the turn on forever. The rule itself cannot do that.
  test('a betting round ends when nobody owes anything, whatever the indices say', () => {
    const game = armedTable('betting_backstop', { actionTimeoutMs: 0 });
    for (let i = 0; i < 5; i++)
      game.addPlayer({ id: `p${i}`, uid: `u${i}`, name: `P${i}`, chips: 5000 });
    game.startRound();

    // Everyone in, everyone matched, everyone has acted.
    game.currentBet = 60;
    game.players.forEach((p) => {
      p.bet = 60;
      p.chips = 4940;
      p.folded = false;
      p.allIn = false;
      p.actedThisStreet = true;
      p.lastAction = { action: 'call', amount: 60, time: Date.now() };
    });
    game.pot = 300;
    game.currentPlayerIndex = 0;
    // ...and the terminator the walk is looking for is not something it can
    // ever land on.
    game.lastRaiserIndex = 99;

    let checks = 0;
    while (game.isRunning && game.phase === 'preflop' && checks < 60) {
      const cur = game.players[game.currentPlayerIndex];
      if (!cur || !game.handleAction(cur.id, 'check')) break;
      checks += 1;
    }

    // The street closes rather than circling the table.
    expect(game.phase).not.toBe('preflop');
    expect(checks).toBeLessThan(6);
  });

  test('the backstop does not end a street somebody still owes into', () => {
    const game = armedTable('backstop_not_early', { actionTimeoutMs: 0 });
    for (let i = 0; i < 4; i++)
      game.addPlayer({ id: `p${i}`, uid: `u${i}`, name: `P${i}`, chips: 5000 });
    game.startRound();
    // A raise leaves the rest owing, and the street must stay open for them.
    const first = game.players[game.currentPlayerIndex];
    expect(game.handleAction(first.id, 'raise', 200)).toBe(true);
    expect(game.phase).toBe('preflop');
    const owing = game.players.filter((p) => !p.folded && !p.allIn && p.bet < game.currentBet);
    expect(owing.length).toBeGreaterThan(0);
  });

  // ── Pre-actions ────────────────────────────────────────────────────────────
  // A line armed before the turn opens. Every one of these drives the arm
  // through beginCurrentTurn, because that is the only door a turn opens
  // through and the only place an arm is played.

  // A clock long enough to stay out of the way. These tests are about what a
  // pre-action does when the turn opens, and they advance past the auto-turn
  // beat to see it; a 30ms action clock fires inside that window and folds the
  // seat, which is the timeout being tested, not the arm.
  function armedTable(name, opts = {}) {
    const game = new PokerGame(name, {
      smallBlind: 10,
      bigBlind: 20,
      actionTimeoutMs: 5000,
      ...opts,
    });
    game.onMessage = () => {};
    game.onUpdate = () => {};
    game.onChat = () => {};
    game.onRoundEnd = () => {};
    return game;
  }

  // Puts `hero` on turn with a given price in front of them, without driving a
  // whole hand there: these tests are about the arm, not about the betting.
  function putOnTurn(game, hero, { currentBet, heroBet }) {
    game.currentPlayerIndex = hero.seatIndex;
    game.currentBet = currentBet;
    hero.bet = heroBet;
    hero.folded = false;
    hero.allIn = false;
    game.isRunning = true;
    game.clearActionTimeout();
  }

  test('an armed check/fold checks when the price is free and folds when it is not', () => {
    jest.useFakeTimers();
    try {
      for (const [currentBet, expected] of [
        [10, 'check'],
        [40, 'fold'],
      ]) {
        const game = armedTable(`checkfold_${expected}`);
        const hero = game.addPlayer({ id: 'p1', name: 'Hero' });
        game.addPlayer({ id: 'p2', name: 'Villain' });
        game.startRound();
        putOnTurn(game, hero, { currentBet, heroBet: 10 });
        hero.preAction = { kind: 'checkfold', atBet: null, atToCall: null };

        game.beginCurrentTurn();
        jest.advanceTimersByTime(AUTO_TURN_DELAY_MS + 100);

        expect(hero.lastAction).toBeTruthy();
        expect(hero.lastAction.action).toBe(expected);
        expect(hero.preAction).toBeNull();
      }
    } finally {
      jest.useRealTimers();
    }
  });

  test('an armed call at a price the table has left is not played', () => {
    jest.useFakeTimers();
    try {
      const game = armedTable('call_price_moved');
      const hero = game.addPlayer({ id: 'p1', name: 'Hero' });
      game.addPlayer({ id: 'p2', name: 'Villain' });
      game.startRound();
      putOnTurn(game, hero, { currentBet: 60, heroBet: 10 });
      // Armed when it was 20 to go. It is 60 now: a different decision.
      hero.preAction = { kind: 'call', atBet: 20, atToCall: 10 };
      const chipsBefore = hero.chips;

      game.beginCurrentTurn();
      jest.advanceTimersByTime(AUTO_TURN_DELAY_MS + 100);

      expect(hero.chips).toBe(chipsBefore);
      expect(hero.lastAction).toBeNull();
      expect(hero.preAction).toBeNull();
      // And the turn is theirs again, with a clock on it.
      expect(game.actionTimeout).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  test('an armed call at the price it was armed against is played', () => {
    jest.useFakeTimers();
    try {
      const game = armedTable('call_price_held');
      const hero = game.addPlayer({ id: 'p1', name: 'Hero' });
      game.addPlayer({ id: 'p2', name: 'Villain' });
      game.startRound();
      putOnTurn(game, hero, { currentBet: 20, heroBet: 10 });
      hero.preAction = { kind: 'call', atBet: 20, atToCall: 10 };
      const chipsBefore = hero.chips;

      game.beginCurrentTurn();
      jest.advanceTimersByTime(AUTO_TURN_DELAY_MS + 100);

      expect(hero.lastAction.action).toBe('call');
      expect(hero.chips).toBe(chipsBefore - 10);
    } finally {
      jest.useRealTimers();
    }
  });

  test('an armed check is refused once somebody has bet', () => {
    jest.useFakeTimers();
    try {
      const game = armedTable('check_refused');
      const hero = game.addPlayer({ id: 'p1', name: 'Hero' });
      game.addPlayer({ id: 'p2', name: 'Villain' });
      game.startRound();
      putOnTurn(game, hero, { currentBet: 80, heroBet: 20 });
      hero.preAction = { kind: 'check', atBet: 20, atToCall: 0 };
      const chipsBefore = hero.chips;

      game.beginCurrentTurn();
      jest.advanceTimersByTime(AUTO_TURN_DELAY_MS + 100);

      // Not folded. They said they would check, not that they would give up.
      expect(hero.lastAction).toBeNull();
      expect(hero.folded).toBe(false);
      expect(hero.chips).toBe(chipsBefore);
      expect(game.actionTimeout).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  test('call any pays whatever the price became, and checks when there is none', () => {
    jest.useFakeTimers();
    try {
      const raised = armedTable('callany_raised');
      const hero = raised.addPlayer({ id: 'p1', name: 'Hero' });
      raised.addPlayer({ id: 'p2', name: 'Villain' });
      raised.startRound();
      putOnTurn(raised, hero, { currentBet: 500, heroBet: 20 });
      hero.preAction = { kind: 'callany', atBet: null, atToCall: null };
      const chipsBefore = hero.chips;

      raised.beginCurrentTurn();
      jest.advanceTimersByTime(AUTO_TURN_DELAY_MS + 100);

      expect(hero.lastAction.action).toBe('call');
      expect(hero.chips).toBe(chipsBefore - 480);

      // Nothing owed: handleAction turns the call into a check.
      const free = armedTable('callany_free');
      const hero2 = free.addPlayer({ id: 'p1', name: 'Hero' });
      free.addPlayer({ id: 'p2', name: 'Villain' });
      free.startRound();
      putOnTurn(free, hero2, { currentBet: 20, heroBet: 20 });
      hero2.preAction = { kind: 'callany', atBet: null, atToCall: null };
      const chips2 = hero2.chips;

      free.beginCurrentTurn();
      jest.advanceTimersByTime(AUTO_TURN_DELAY_MS + 100);

      expect(hero2.lastAction.action).toBe('check');
      expect(hero2.chips).toBe(chips2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('call any with a short stack is an all-in, not a debt', () => {
    jest.useFakeTimers();
    try {
      const game = armedTable('callany_short');
      const hero = game.addPlayer({ id: 'p1', name: 'Hero', chips: 120 });
      game.addPlayer({ id: 'p2', name: 'Villain', chips: 5000 });
      game.startRound();
      putOnTurn(game, hero, { currentBet: 900, heroBet: 0 });
      hero.chips = 120;
      hero.preAction = { kind: 'callany', atBet: null, atToCall: null };

      game.beginCurrentTurn();
      jest.advanceTimersByTime(AUTO_TURN_DELAY_MS + 100);

      expect(hero.chips).toBe(0);
      expect(hero.allIn).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a raise disarms every arm made against the price it replaced', () => {
    const game = armedTable('sweep', { actionTimeoutMs: 0 });
    for (let i = 0; i < 5; i++) {
      game.addPlayer({ id: `p${i}`, name: `P${i}`, chips: 5000 });
    }
    game.startRound();

    const raiser = game.players[game.currentPlayerIndex];
    const others = game.players.filter((p) => p !== raiser);
    others[0].preAction = { kind: 'check', atBet: 20, atToCall: 0 };
    others[1].preAction = { kind: 'call', atBet: 20, atToCall: 20 };
    others[2].preAction = { kind: 'checkfold', atBet: null, atToCall: null };
    others[3].preAction = { kind: 'callany', atBet: null, atToCall: null };

    game.handleAction(raiser.id, 'raise', 200);

    // The two made against a price of 20 are gone; the price-agnostic two hold.
    expect(others[0].preAction).toBeNull();
    expect(others[1].preAction).toBeNull();
    expect(others[2].preAction).toMatchObject({ kind: 'checkfold' });
    expect(others[3].preAction).toMatchObject({ kind: 'callany' });
  });

  // A player can act by hand during the beat before their arm fires, because
  // the action bar is up: it is their turn, that is why the arm is firing. The
  // pending timer then finds the turn moved and leaves the arm where it is, so
  // acting has to spend it, or it plays itself when the betting comes back.
  test('acting by hand spends the arm rather than leaving it to fire later', () => {
    jest.useFakeTimers();
    try {
      const game = armedTable('arm_overtaken');
      const hero = game.addPlayer({ id: 'p1', name: 'Hero', chips: 5000 });
      game.addPlayer({ id: 'p2', name: 'Villain', chips: 5000 });
      game.addPlayer({ id: 'p3', name: 'Third', chips: 5000 });
      game.startRound();
      putOnTurn(game, hero, { currentBet: 20, heroBet: 0 });
      hero.preAction = { kind: 'callany', atBet: null, atToCall: null };

      game.beginCurrentTurn();
      // They beat their own arm to it and raise instead.
      jest.advanceTimersByTime(Math.max(1, Math.floor(AUTO_TURN_DELAY_MS / 2)));
      expect(game.handleAction(hero.id, 'raise', 200)).toBe(true);
      jest.advanceTimersByTime(AUTO_TURN_DELAY_MS + 100);

      expect(hero.preAction).toBeNull();
      expect(hero.lastAction.action).toBe('raise');
    } finally {
      jest.useRealTimers();
    }
  });

  test('an arm disarmed inside the beat hands the turn back with a clock', () => {
    jest.useFakeTimers();
    try {
      const game = armedTable('disarm_midbeat');
      const hero = game.addPlayer({ id: 'p1', name: 'Hero' });
      game.addPlayer({ id: 'p2', name: 'Villain' });
      game.startRound();
      putOnTurn(game, hero, { currentBet: 20, heroBet: 10 });
      hero.preAction = { kind: 'checkfold', atBet: null, atToCall: null };

      game.beginCurrentTurn();
      // The player changes their mind before the beat is out.
      jest.advanceTimersByTime(Math.max(1, Math.floor(AUTO_TURN_DELAY_MS / 2)));
      hero.preAction = null;
      jest.advanceTimersByTime(AUTO_TURN_DELAY_MS + 100);

      expect(hero.lastAction).toBeNull();
      expect(game.actionTimeout).toBeTruthy();
      expect(game.turnExpiresAt).toBeGreaterThan(Date.now());
    } finally {
      jest.useRealTimers();
    }
  });

  test('a new street and a new hand each clear every arm', () => {
    const game = armedTable('arms_cleared', { actionTimeoutMs: 0 });
    const a = game.addPlayer({ id: 'p1', name: 'A', chips: 5000 });
    const b = game.addPlayer({ id: 'p2', name: 'B', chips: 5000 });
    game.startRound();

    a.preAction = { kind: 'checkfold', atBet: null, atToCall: null };
    b.preAction = { kind: 'callany', atBet: null, atToCall: null };
    game._openStreet(0);
    expect(a.preAction).toBeNull();
    expect(b.preAction).toBeNull();

    a.preAction = { kind: 'checkfold', atBet: null, atToCall: null };
    game.startRound();
    expect(a.preAction).toBeNull();
  });

  test('sit out next hand waits for the deal, and the blinds still post', () => {
    const game = armedTable('sitout_next', { actionTimeoutMs: 0 });
    const hero = game.addPlayer({ id: 'p1', name: 'Hero', chips: 5000 });
    game.addPlayer({ id: 'p2', name: 'Villain', chips: 5000 });
    game.startRound();

    hero.sitOutNextHand = true;
    // The hand in progress is untouched: that is the whole difference from
    // setAutoPlay, which sits a seat out where it stands.
    expect(hero.autoPlay).toBe(false);

    game.startRound();

    expect(hero.sitOutNextHand).toBe(false);
    expect(hero.autoPlay).toBe(true);
    // 'requested', so a reconnect leaves it alone.
    expect(hero.sitOutReason).toBe('requested');
    // Still dealt in, and still paying for the privilege.
    expect(hero.holeCards).toHaveLength(2);
    const inABlind = hero.seatIndex === game.sbIndex || hero.seatIndex === game.bbIndex;
    if (inABlind) expect(hero.bet).toBeGreaterThan(0);
  });

  test('an arm is never visible to another seat', () => {
    const game = armedTable('arm_privacy', { actionTimeoutMs: 0 });
    const hero = game.addPlayer({ id: 'p1', name: 'Hero' });
    game.addPlayer({ id: 'p2', name: 'Villain' });
    game.startRound();
    hero.preAction = { kind: 'callany', atBet: null, atToCall: null };
    hero.sitOutNextHand = true;

    const mine = game.getStateForPlayer('p1');
    expect(mine.myPreAction).toMatchObject({ kind: 'callany' });
    expect(mine.mySitOutNextHand).toBe(true);

    const theirs = game.getStateForPlayer('p2');
    expect(theirs.myPreAction).toBeNull();
    expect(theirs.mySitOutNextHand).toBe(false);
    expect(JSON.stringify(theirs.players)).not.toContain('preAction');
    expect(JSON.stringify(theirs.players)).not.toContain('sitOutNextHand');

    // A watcher with no seat at all is sent state too, and must not throw.
    expect(() => game.getStateForPlayer('nobody')).not.toThrow();
    expect(game.getStateForPlayer('nobody').myPreAction).toBeNull();
  });

  test('a pause inside the beat resumes into the same arm', () => {
    jest.useFakeTimers();
    try {
      const game = armedTable('arm_paused');
      const hero = game.addPlayer({ id: 'p1', name: 'Hero' });
      game.addPlayer({ id: 'p2', name: 'Villain' });
      game.startRound();
      putOnTurn(game, hero, { currentBet: 20, heroBet: 20 });
      hero.preAction = { kind: 'checkfold', atBet: null, atToCall: null };

      game.beginCurrentTurn();
      game.pause();
      jest.advanceTimersByTime(AUTO_TURN_DELAY_MS + 100);
      // Held, not spent.
      expect(hero.lastAction).toBeNull();
      expect(hero.preAction).toBeTruthy();

      game.resume();
      jest.advanceTimersByTime(AUTO_TURN_DELAY_MS + 100);
      expect(hero.lastAction.action).toBe('check');
    } finally {
      jest.useRealTimers();
    }
  });

  test('sitting out beats an arm: the seat folds rather than paying', () => {
    jest.useFakeTimers();
    try {
      const game = armedTable('arm_vs_sitout');
      const hero = game.addPlayer({ id: 'p1', name: 'Hero' });
      game.addPlayer({ id: 'p2', name: 'Villain' });
      game.startRound();
      putOnTurn(game, hero, { currentBet: 500, heroBet: 20 });
      hero.preAction = { kind: 'callany', atBet: null, atToCall: null };
      // They drop before the turn opens; the seat is the sit-out's now.
      hero.autoPlay = true;
      const chipsBefore = hero.chips;

      game.beginCurrentTurn();
      jest.advanceTimersByTime(AUTO_TURN_DELAY_MS + 100);

      expect(hero.lastAction.action).toBe('fold');
      expect(hero.chips).toBe(chipsBefore);
    } finally {
      jest.useRealTimers();
    }
  });

  test('requesting time defers the clock by the grant, once per hand', () => {
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

      // The original deadline passes without the clock firing...
      jest.advanceTimersByTime(60);
      expect(hero.timeoutStrikes).toBe(0);
      expect(hero.lastAction).toBeNull();
      // ...and the extended one fires it: 40ms remained plus the 200ms grant.
      // One strike folds the hand; the seat is only sat out on the second.
      jest.advanceTimersByTime(190);
      expect(hero.timeoutStrikes).toBe(1);
      // Checked rather than folded: nothing was owed at that point. Either way
      // the hand is given up and the seat stays in.
      expect(hero.lastAction.action).toBe('check');
      expect(hero.autoPlay).toBe(false);
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
      expect(new Set(game.lastRoundWinnerIds).size === game.lastRoundWinnerIds.length).toBeTruthy();
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

  test('an all-in run-out deals a street at a time on the same beat', () => {
    jest.useFakeTimers();
    try {
      const { game, a, b } = twoHanded({ streetPauseMs: 300 });
      a.holeCards = [Card('spades', 14), Card('hearts', 14)];
      b.holeCards = [Card('clubs', 2), Card('diamonds', 7)];
      a.allIn = true;
      b.allIn = true;

      // A street a beat, not a card a beat: the board nobody could bet on
      // still comes out as a flop, a turn and a river.
      game.dealRemainingCards();
      expect(game.communityCards).toHaveLength(3);
      expect(game.phase).toBe('flop');
      jest.advanceTimersByTime(320);
      expect(game.communityCards).toHaveLength(4);
      expect(game.phase).toBe('turn');
      jest.advanceTimersByTime(320);
      expect(game.communityCards).toHaveLength(5);
      expect(game.phase).toBe('river');
      jest.advanceTimersByTime(320);
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

describe('a recorded hand keeps unshown cards private', () => {
  function table() {
    const game = new PokerGame('history', { smallBlind: 10, bigBlind: 20 });
    game.onMessage = () => {};
    game.onUpdate = () => {};
    game.onChat = () => {};
    game.onRoundEnd = () => {};
    return game;
  }

  const seen = (game, viewerId) =>
    Object.keys(game.getStateForPlayer(viewerId).recentHands[0].holeCards).sort();

  // Five off the top of the same deck, so a showdown has something to
  // evaluate and no card is dealt twice.
  const board = (game) => {
    game.communityCards = [0, 0, 0, 0, 0].map(() => game.deck.pop());
  };

  // By id, never by index: startRound seats the field and the array comes back
  // in seating order, so players[2] is not the third player added.
  const fold = (game, ...ids) => {
    for (const id of ids) game.players.find((p) => p.id === id).folded = true;
  };

  test("a hand won by folding shows the viewer their own cards and nobody else's", () => {
    const game = table();
    game.addPlayer({ id: 'p1', name: 'Hero', uid: 'u1' });
    game.addPlayer({ id: 'p2', name: 'Villain', uid: 'u2' });
    game.addPlayer({ id: 'p3', name: 'Third', uid: 'u3' });
    game.startRound();
    fold(game, 'p2', 'p3');

    game.showdown(); // one contender left: the pot is pushed, nothing is shown

    // The recorder still holds all three hands. What each viewer is sent is
    // their own, which is the whole point of the redaction.
    expect(Object.keys(game.handHistory.hands[0].holeCards).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(seen(game, 'p1')).toEqual(['p1']);
    expect(seen(game, 'p2')).toEqual(['p2']);
    expect(seen(game, 'p3')).toEqual(['p3']);
  });

  test('a showdown opens the hands that were turned over, and only those', () => {
    const game = table();
    game.addPlayer({ id: 'p1', name: 'Hero', uid: 'u1' });
    game.addPlayer({ id: 'p2', name: 'Villain', uid: 'u2' });
    game.addPlayer({ id: 'p3', name: 'Folder', uid: 'u3' });
    game.startRound();
    board(game);
    fold(game, 'p3');

    game.showdown();

    // Two contenders showed. The third folded and is still nobody's business,
    // including to the two who beat them.
    expect(game.handHistory.hands[0].shownPlayerIds.sort()).toEqual(['p1', 'p2']);
    expect(seen(game, 'p1')).toEqual(['p1', 'p2']);
    expect(seen(game, 'p2')).toEqual(['p1', 'p2']);
    expect(seen(game, 'p3')).toEqual(['p1', 'p2', 'p3']);
  });

  test('a reconnect keeps a player the cards they were dealt', () => {
    const game = table();
    game.addPlayer({ id: 'p1', name: 'Hero', uid: 'u1' });
    game.addPlayer({ id: 'p2', name: 'Villain', uid: 'u2' });
    game.startRound();
    board(game);
    fold(game, 'p2');
    game.showdown();

    // The seat comes back on a new socket. History is keyed by the id it had
    // when the hand was dealt, so without the uid this viewer would lose
    // sight of their own holding.
    game.players.find((p) => p.id === 'p1').id = 'p1-again';
    expect(seen(game, 'p1-again')).toEqual(['p1']);
  });

  test('a spectator is shown only what was turned face up', () => {
    const game = table();
    game.addPlayer({ id: 'p1', name: 'Hero', uid: 'u1' });
    game.addPlayer({ id: 'p2', name: 'Villain', uid: 'u2' });
    game.startRound();
    board(game);
    game.showdown();

    // Nobody by that id sat in the hand, so nothing is theirs to see; both
    // contenders showed, so both are public.
    expect(seen(game, 'nobody')).toEqual(['p1', 'p2']);
  });
});

describe('Turning the hands face up', () => {
  // A paced run-out, so the stretch between "no more betting is possible" and
  // "showdown" actually exists to be looked at. With no pause the whole board
  // lands in one synchronous stack and that window never opens.
  const table = () => new PokerGame('expose', { smallBlind: 10, bigBlind: 20, streetPauseMs: 50 });

  const seat = (game, id, chips) => {
    game.addPlayer({ id, name: id, uid: `u-${id}` }).chips = chips;
  };

  // Seat order is the engine's business, so drive whoever it says is up.
  const act = (game, action, amount) => {
    const up = game.players[game.currentPlayerIndex];
    game.handleAction(up.id, action, amount);
    return up.id;
  };

  const opponentCards = (game, viewerId) =>
    Object.fromEntries(
      game
        .getStateForPlayer(viewerId)
        .players.filter((p) => p.id !== viewerId)
        .map((p) => [p.id, p.holeCards ? p.holeCards.length : null])
    );

  test('an all-in run-out shows the live hands before the board is finished', () => {
    jest.useFakeTimers();
    try {
      const game = table();
      for (const id of ['p1', 'p2', 'p3', 'p4']) seat(game, id, 100);
      game.startRound();

      const folded = act(game, 'fold');
      act(game, 'allin');
      act(game, 'allin');
      act(game, 'allin');

      // The hands come up the moment the last chips are in, on the frame that
      // still shows them going in; the board follows on the next beat.
      expect(game.cardsExposed).toBe(true);
      expect(game.communityCards).toHaveLength(0);
      jest.advanceTimersByTime(60);

      // Nobody left in the hand can put another chip in, so the rest of the
      // board is a formality - and the hands are up for it.
      expect(game.cardsExposed).toBe(true);
      expect(game.phase).not.toBe('showdown');
      expect(game.communityCards.length).toBeLessThan(5);

      const live = ['p1', 'p2', 'p3', 'p4'].filter((id) => id !== folded);
      for (const viewer of ['p1', 'p2', 'p3', 'p4', 'nobody-watching']) {
        const seen = opponentCards(game, viewer);
        for (const id of live) if (id !== viewer) expect(seen[id]).toBe(2);
        if (folded !== viewer) expect(seen[folded]).toBeNull();
      }
    } finally {
      jest.useRealTimers();
    }
  });

  test('a hand still being bet on keeps every holding private', () => {
    const game = table();
    for (const id of ['p1', 'p2', 'p3']) seat(game, id, 1000);
    game.startRound();
    act(game, 'call');

    expect(game.cardsExposed).toBe(false);
    expect(opponentCards(game, 'p1')).toEqual({ p2: null, p3: null });
  });

  test('a pot taken uncontested shows nobody anything', () => {
    const game = table();
    for (const id of ['p1', 'p2', 'p3']) seat(game, id, 1000);
    game.startRound();

    act(game, 'fold');
    act(game, 'fold');

    expect(game.isRunning).toBe(false);
    expect(game.cardsExposed).toBe(false);
    expect(opponentCards(game, 'nobody-watching')).toEqual({ p1: null, p2: null, p3: null });
  });

  test('one contender left is never a showdown, whatever the phase says', () => {
    const game = table();
    for (const id of ['p1', 'p2']) seat(game, id, 1000);
    game.startRound();
    game.players.find((p) => p.id === 'p2').folded = true;
    game.showdown();

    // showdown() sets the phase before it counts the contenders, so the phase
    // on its own must never be what opens the cards.
    expect(game.phase).toBe('showdown');
    expect(opponentCards(game, 'nobody-watching')).toEqual({ p1: null, p2: null });
  });

  test('an all-in run-out deals real streets: a flop of three, one burn each', () => {
    jest.useFakeTimers();
    try {
      const game = table();
      const streets = [];
      game.onMessage = (msg, meta) => {
        if (meta && meta.kind === 'street') streets.push(meta.street);
      };
      for (const id of ['p1', 'p2']) seat(game, id, 100);
      game.startRound();
      const deckAfterDeal = game.deck.length;

      act(game, 'allin');
      act(game, 'allin');

      // Beat one is the flop, and a flop is three cards.
      jest.advanceTimersByTime(60);
      expect(game.communityCards).toHaveLength(3);
      expect(game.phase).toBe('flop');

      jest.advanceTimersByTime(60);
      expect(game.communityCards).toHaveLength(4);
      expect(game.phase).toBe('turn');

      jest.advanceTimersByTime(60);
      expect(game.communityCards).toHaveLength(5);
      expect(game.phase).toBe('river');

      // Three burns and five board cards, the same eight a played hand uses -
      // not a burn before every single card.
      expect(deckAfterDeal - game.deck.length).toBe(8);
      expect(streets).toEqual(['flop', 'turn', 'river']);

      jest.advanceTimersByTime(60);
      expect(game.phase).toBe('showdown');
    } finally {
      jest.useRealTimers();
    }
  });

  test('a lone player with chips has nobody to bet against, so the hands come up', () => {
    jest.useFakeTimers();
    try {
      const game = table();
      for (const id of ['p1', 'p2']) seat(game, id, 1000);
      game.startRound();
      const short = game.players[game.currentPlayerIndex];
      short.chips = 40;

      act(game, 'allin');
      const caller = act(game, 'call');

      // One seat is all in and the other still has a stack - but with nobody
      // to bet it against, the hand is as settled as if they were both in.
      expect(game.players.find((p) => p.id === caller).chips).toBeGreaterThan(0);
      expect(game.cardsExposed).toBe(true);
      expect(opponentCards(game, caller)[short.id]).toBe(2);

      jest.advanceTimersByTime(60);
      expect(game.communityCards).toHaveLength(3);
    } finally {
      jest.useRealTimers();
    }
  });

  test('the next deal puts the cards back down', () => {
    // No street pause here: the hand runs itself out to the end in one stack,
    // which is the state the next deal has to clear up after.
    const game = new PokerGame('expose_reset', { smallBlind: 10, bigBlind: 20 });
    for (const id of ['p1', 'p2']) seat(game, id, 100);
    game.startRound();
    act(game, 'allin');
    act(game, 'allin');
    expect(game.cardsExposed).toBe(true);

    for (const p of game.players) p.chips = 1000;
    game.startRound();
    expect(game.cardsExposed).toBe(false);
    expect(opponentCards(game, 'p1')).toEqual({ p2: null });
  });
});

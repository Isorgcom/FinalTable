const { PokerGame } = require('../engine');

// Phase 2 trust anchor. Multi-table play is only safe if chips are conserved
// across every table move, so this suite exists before any orchestration does.
// If it ever fails, the tournament is minting or destroying money.

function makeTable(id, seats = 10) {
  return new PokerGame(id, { startChips: 1000, maxPlayers: seats });
}

function fieldTotal(tables) {
  return tables.reduce((sum, t) => sum + t.totalChips(), 0);
}

// The move primitive a TournamentDirector will use. Seat at the destination
// FIRST, and only remove from the source once that succeeded: reversing the
// order means a rejected seat (table full, bad stack) silently destroys the
// player's chips.
function movePlayer(from, to, uid, seatIndex) {
  const player = from.players.find((p) => p.uid === uid);
  if (!player) return false;
  const seated = to.addPlayer({
    id: player.id,
    uid: player.uid,
    name: player.name,
    chips: player.chips,
    ...(seatIndex === undefined ? {} : { seatIndex }),
  });
  if (!seated) return false;
  from.removePlayer(player.id);
  return true;
}

describe('chip conservation', () => {
  test('totalChips counts stacks plus pot, without double-counting bets', () => {
    const t = makeTable('t1');
    t.addPlayer({ id: 'a', name: 'A' });
    t.addPlayer({ id: 'b', name: 'B' });
    expect(t.totalChips()).toBe(2000);

    t.startRound(); // posts blinds: chips leave stacks and enter the pot
    expect(t.totalChips()).toBe(2000);
    expect(t.pot).toBeGreaterThan(0);
  });

  test('a move carries the exact stack and conserves the field total', () => {
    const a = makeTable('a');
    const b = makeTable('b');
    const p = a.addPlayer({ id: 'p1', name: 'Mover' });
    p.chips = 3737; // an awkward number: nothing should round it
    a.addPlayer({ id: 'p2', name: 'Stay' });
    b.addPlayer({ id: 'p3', name: 'Other' });

    const before = fieldTotal([a, b]);
    expect(movePlayer(a, b, p.uid)).toBe(true);
    expect(fieldTotal([a, b])).toBe(before);

    const moved = b.players.find((x) => x.uid === p.uid);
    expect(moved.chips).toBe(3737);
    expect(a.players.find((x) => x.uid === p.uid)).toBeUndefined();
  });

  test('a move preserves identity, so host and standings survive it', () => {
    const a = makeTable('a');
    const b = makeTable('b');
    const p = a.addPlayer({ id: 'p1', name: 'Mover' });
    const uid = p.uid;
    movePlayer(a, b, uid);
    expect(b.players.find((x) => x.uid === uid)).toBeDefined();
  });

  test('a rejected seat loses nobody: add must succeed before remove', () => {
    const a = makeTable('a');
    const full = makeTable('full', 2);
    full.addPlayer({ id: 'f1', name: 'F1' });
    full.addPlayer({ id: 'f2', name: 'F2' });
    const p = a.addPlayer({ id: 'p1', name: 'Mover' });
    p.chips = 5000;

    const before = fieldTotal([a, full]);
    expect(movePlayer(a, full, p.uid)).toBe(false);
    expect(fieldTotal([a, full])).toBe(before);
    // Still seated at the source, with the stack intact.
    expect(a.players.find((x) => x.uid === p.uid).chips).toBe(5000);
  });

  test('invalid stacks are refused rather than coerced', () => {
    const t = makeTable('t');
    const before = t.totalChips();
    for (const bad of [-1, NaN, Infinity, 1.5, '500', {}]) {
      expect(t.addPlayer({ id: 'x', name: 'X', chips: bad })).toBeNull();
    }
    expect(t.totalChips()).toBe(before);
    // Zero is legitimate: a busted player can be moved before elimination.
    expect(t.addPlayer({ id: 'z', name: 'Z', chips: 0 })).not.toBeNull();
  });

  test('conserved across 400 randomised moves over 4 tables', () => {
    const tables = ['t0', 't1', 't2', 't3'].map((id) => makeTable(id));
    let seq = 0;
    for (const t of tables) {
      for (let i = 0; i < 6; i++) {
        const p = t.addPlayer({ id: `p${seq}`, name: `P${seq}` });
        // Uneven stacks, so a bug cannot hide behind identical numbers.
        p.chips = 100 + ((seq * 137) % 4000);
        seq++;
      }
    }
    const expected = fieldTotal(tables);
    expect(expected).toBeGreaterThan(0);

    let moves = 0;
    for (let i = 0; i < 400; i++) {
      const from = tables[Math.floor(Math.random() * tables.length)];
      const to = tables[Math.floor(Math.random() * tables.length)];
      if (from === to || from.players.length === 0) continue;
      const victim = from.players[Math.floor(Math.random() * from.players.length)];
      const seat = Math.floor(Math.random() * (to.players.length + 1));
      if (movePlayer(from, to, victim.uid, seat)) moves++;
      // The invariant must hold after every single move, not just at the end.
      expect(fieldTotal(tables)).toBe(expected);
    }
    expect(moves).toBeGreaterThan(50);
  });

  test('conserved across a full hand played to completion', () => {
    const t = makeTable('hand');
    for (let i = 0; i < 4; i++) t.addPlayer({ id: `p${i}`, name: `P${i}` });
    const expected = t.totalChips();

    t.startRound();
    let guard = 0;
    while (t.isRunning && guard++ < 200) {
      const cur = t.players[t.currentPlayerIndex];
      if (!cur) break;
      t.handleAction(cur.id, 'call');
      expect(t.totalChips()).toBe(expected); // holds mid-hand too
    }
    expect(t.totalChips()).toBe(expected);
  });

  test('seatIndex places the arriving player where the caller asked', () => {
    const t = makeTable('seats');
    t.addPlayer({ id: 'a', name: 'A' });
    t.addPlayer({ id: 'b', name: 'B' });
    t.addPlayer({ id: 'c', name: 'C' });
    const mid = t.addPlayer({ id: 'm', name: 'M', chips: 500, seatIndex: 1 });
    expect(mid.seatIndex).toBe(1);
    expect(t.players[1].name).toBe('M');
    expect(t.players.map((p) => p.seatIndex)).toEqual([0, 1, 2, 3]);
  });
});

describe('chip conservation with antes', () => {
  test('totalChips holds when the big blind antes, short or not', () => {
    const t = new PokerGame('ante', { startChips: 1000, maxPlayers: 6, ante: 25 });
    t.addPlayer({ id: 'a', name: 'A' });
    t.addPlayer({ id: 'b', name: 'B' });
    t.addPlayer({ id: 'c', name: 'C' });
    // Seats are drawn, so whoever lands in the big blind may be the short one.
    t.players[2].chips = 10;
    expect(t.totalChips()).toBe(2010);
    t.startRound();
    expect(t.totalChips()).toBe(2010);
    expect(t.anteTotal).toBeGreaterThan(0);
    expect(t.pot).toBe(t.anteTotal + t.players.reduce((sum, p) => sum + p.bet, 0));
  });
});

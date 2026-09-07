const { TournamentDirector, ChipConservationError, payoutPercentagesFor } = require('../director');

// Phase 3: several tables on one shared blind clock, run to completion.
// Balancing is not implemented yet, so these tests assert the properties that
// must hold without it, plus the collapse that lets a field finish at all.

function makeDirector(entrants, opts = {}) {
  const d = new TournamentDirector({
    id: 'test',
    tableSize: opts.tableSize || 6,
    startChips: opts.startChips || 2000,
    levelDuration: 99999, // never level up mid-test unless asked
    gameOptions: { actionTimeoutMs: 0 },
    ...opts,
  });
  for (let i = 0; i < entrants; i++) {
    d.register({ id: `p${i}`, uid: `p${i}`, name: `P${i}` });
  }
  return d;
}

// Drives one hand on a table to completion with deterministic-ish aggression,
// so stacks actually collide and players bust rather than limping forever.
function playHand(table, rng, aggression = 0.55) {
  let guard = 0;
  while (table.isRunning && guard++ < 400) {
    const cur = table.players[table.currentPlayerIndex];
    if (!cur || cur.chips <= 0) break;
    const roll = rng();
    const action = roll < aggression ? 'allin' : roll < 0.9 ? 'call' : 'fold';
    if (!table.handleAction(cur.id, action)) {
      // Fall back to something always legal so the hand cannot wedge.
      if (!table.handleAction(cur.id, 'call')) table.handleAction(cur.id, 'fold');
    }
  }
}

// `aggression` is the chance a player shoves. High values bust the field in a
// handful of hands, which is fine for "does it finish" but useless for anything
// that needs several tables alive at once; lower it to keep the field spread
// across tables for longer.
function runToCompletion(director, maxHands = 3000, aggression = 0.55) {
  let seed = 12345;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let hands = 0;
  while (!director.finished && hands < maxHands) {
    const started = director.startHandsWhereReady();
    if (started === 0) break;
    for (const table of director.tables) {
      if (table.isRunning) {
        playHand(table, rng, aggression);
        hands++;
      }
    }
  }
  return hands;
}

describe('TournamentDirector', () => {
  test('seats the field across the right number of tables', () => {
    const d = makeDirector(14, { tableSize: 6 });
    d.start();
    expect(d.tables).toHaveLength(3); // ceil(14 / 6)
    const counts = d.tables.map((t) => t.players.length).sort();
    expect(counts.reduce((a, b) => a + b, 0)).toBe(14);
    // Round-robin, so no table starts more than one seat off another.
    expect(counts[counts.length - 1] - counts[0]).toBeLessThanOrEqual(1);
    d.stop();
  });

  test('every table shares one Tournament instance, not a copy', () => {
    const d = makeDirector(12);
    d.start();
    for (const t of d.tables) expect(t.tournament).toBe(d.tournament);
    d.stop();
  });

  test('a blind level change reaches every table', () => {
    const d = makeDirector(12);
    d.start();
    d.tournament.currentLevel = 2;
    d.tournament.onLevelUp(2, d.tournament.getCurrentBlinds());
    const blinds = d.tournament.getCurrentBlinds();
    for (const t of d.tables) {
      expect(t.smallBlind).toBe(blinds.sb);
      expect(t.bigBlind).toBe(blinds.bb);
    }
    d.stop();
  });

  test('one table emptying does not end the tournament', () => {
    const d = makeDirector(12, { tableSize: 4 });
    d.start();
    expect(d.tables.length).toBe(3);

    // Bust everyone on table 1 outright.
    const doomed = d.tables[0];
    const survivors = d.fieldPlayers().length - doomed.players.length;
    for (const p of doomed.players) p.chips = 0;
    // Chips have to go somewhere or conservation trips, which is the point.
    d._expectedChips = d.totalChips();
    d._handleRoundEnd(doomed, null);

    expect(d.finished).toBeNull();
    expect(d.playersRemaining()).toBe(survivors);
    d.stop();
  });

  test('field total is conserved through a whole tournament', () => {
    const d = makeDirector(18, { tableSize: 6, startChips: 2000 });
    d.start();
    const expected = 18 * 2000;
    expect(d.totalChips()).toBe(expected);

    runToCompletion(d);

    // The director asserts this internally after every round; if it had ever
    // been violated the run would have thrown ChipConservationError.
    expect(d.totalChips()).toBe(expected);
    d.stop();
  });

  test('runs a multi-table field down to a single winner', () => {
    const d = makeDirector(18, { tableSize: 6 });
    d.start();
    expect(d.tables.length).toBe(3);

    const hands = runToCompletion(d);

    expect(d.finished).not.toBeNull();
    expect(d.finished.winner).toBeTruthy();
    expect(d.playersRemaining()).toBe(1);
    expect(hands).toBeGreaterThan(0);
    d.stop();
  });

  test('finishing places are field-wide, complete and unique', () => {
    const d = makeDirector(12, { tableSize: 4 });
    d.start();
    runToCompletion(d);
    expect(d.finished).not.toBeNull();

    const places = d.tournament.eliminations.map((e) => e.place);
    expect(places.length).toBe(12);
    expect(new Set(places).size).toBe(12); // no duplicates
    expect(Math.min(...places)).toBe(1);
    expect(Math.max(...places)).toBe(12);
    d.stop();
  });

  test('a table that can no longer deal is collapsed into another', () => {
    // tableSize 8 with 12 entrants gives two tables of six, so the destination
    // has room. With tableSize 6 both tables start full and the survivor is
    // correctly left put, which is a different case (covered below).
    const d = makeDirector(12, { tableSize: 8 });
    d.start();
    const [a, b] = d.tables;
    // Leave table A with a single survivor.
    const keep = a.players[0];
    for (const p of a.players.slice(1)) a.removePlayer(p.id);
    d._expectedChips = d.totalChips();

    const before = b.players.length;
    d._collapseIfStalled(a);

    expect(a.players).toHaveLength(0);
    expect(b.players.length).toBe(before + 1);
    expect(b.players.find((p) => p.uid === keep.uid).chips).toBe(keep.chips);
    expect(d.totalChips()).toBe(d._expectedChips);
    d.stop();
  });

  test('a survivor with nowhere to go stays put, and is rescued later', () => {
    const d = makeDirector(12, { tableSize: 6 }); // two tables, both full
    d.start();
    const [a, b] = d.tables;
    const keep = a.players[0];
    for (const p of a.players.slice(1)) a.removePlayer(p.id);
    d._expectedChips = d.totalChips();

    d._collapseStalledTables();
    expect(a.players).toHaveLength(1); // table B is full; nowhere to move
    expect(d.totalChips()).toBe(d._expectedChips);

    // Once table B has room, the sweep run from anyone's round end rescues them.
    b.removePlayer(b.players[0].id);
    d._expectedChips = d.totalChips();
    d._collapseStalledTables();
    expect(a.players).toHaveLength(0);
    expect(b.players.find((p) => p.uid === keep.uid)).toBeDefined();
    expect(d.totalChips()).toBe(d._expectedChips);
    d.stop();
  });

  test('the final table is never collapsed away', () => {
    const d = makeDirector(4, { tableSize: 6 });
    d.start();
    expect(d.tables.length).toBe(1);
    const only = d.tables[0];
    for (const p of only.players.slice(1)) only.removePlayer(p.id);
    d._expectedChips = d.totalChips();
    d._collapseIfStalled(only);
    expect(only.players).toHaveLength(1); // nowhere to move, and that is correct
    d.stop();
  });

  test('the field hold gates dealing, for hand-for-hand later', () => {
    const d = makeDirector(12);
    d.start();
    expect(d.startHandsWhereReady()).toBeGreaterThan(0);
    for (const t of d.tables) t.isRunning = false;

    d.holdField('bubble');
    expect(d.startHandsWhereReady()).toBe(0);
    d.releaseField();
    expect(d.startHandsWhereReady()).toBeGreaterThan(0);
    d.stop();
  });

  test('chip conservation failures are loud, not silent', () => {
    const d = makeDirector(12);
    d.start();
    d.tables[0].players[0].chips += 1; // a single chip conjured from nowhere
    expect(() => d.assertChipConservation()).toThrow(ChipConservationError);
    d.stop();
  });

  test('registration closes once the tournament starts', () => {
    const d = makeDirector(6);
    d.start();
    expect(() => d.register({ id: 'late', name: 'Late' })).toThrow();
    d.stop();
  });
});

describe('TournamentDirector balancing (phase 4)', () => {
  test('keeps every table within one seat of every other', () => {
    const d = makeDirector(20, { tableSize: 9 });
    d.start();
    // Force a lopsided field: pile everyone onto table 1 that will fit.
    const [a, b] = d.tables;
    while (b.players.length > 1 && a.players.length < 9) {
      const p = b.players[b.players.length - 1];
      a.addPlayer({ id: p.id, uid: p.uid, name: p.name, chips: p.chips });
      b.removePlayer(p.id);
    }
    d._expectedChips = d.totalChips();
    d.rebalanceField();

    const counts = d.activeTables().map((t) => t.players.length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(d.totalChips()).toBe(d._expectedChips);
    d.stop();
  });

  test('breaks a table once the field fits on fewer', () => {
    const d = makeDirector(18, { tableSize: 9 }); // 2 tables of 9
    d.start();
    expect(d.activeTables()).toHaveLength(2);

    // Bust down to 9, which fits on a single table.
    const doomed = d.fieldPlayers().slice(0, 9);
    for (const p of doomed) p.chips = 0;
    for (const table of d.tables) {
      for (const p of table.players.filter((x) => x.chips <= 0)) table.removePlayer(p.id);
    }
    d._expectedChips = d.totalChips();
    d.rebalanceField();

    expect(d.activeTables()).toHaveLength(1);
    expect(d.playersRemaining()).toBe(9);
    expect(d.totalChips()).toBe(d._expectedChips);
    d.stop();
  });

  test('break order is fixed at start, not chosen on the fly', () => {
    const d = makeDirector(27, { tableSize: 9 });
    d.start();
    expect(d.breakOrder).toEqual([3, 2, 1]); // highest table number breaks first
    const snapshot = [...d.breakOrder];
    d.rebalanceField();
    expect(d.breakOrder).toEqual(snapshot);
    d.stop();
  });

  test('a moved player is seated to post the big blind, not to skip it', () => {
    // 12 at tableSize 9 leaves room at the destination; 18 would fill both
    // tables and every move would correctly be refused.
    const d = makeDirector(12, { tableSize: 9 });
    d.start();
    const [a, b] = d.tables;
    // Advance table B's button by playing a hand, so this is not the trivial case.
    b.startRound();
    let guard = 0;
    while (b.isRunning && guard++ < 200) {
      const cur = b.players[b.currentPlayerIndex];
      if (!cur) break;
      b.handleAction(cur.id, 'call');
    }

    for (let i = 0; i < 5; i++) {
      const mover = d._playerToMove(a);
      if (!mover) break;
      const uid = mover.uid;
      expect(d._movePlayer(a, b, mover)).toBe(true);
      b.startRound();
      expect(b.players[b.bbIndex].uid).toBe(uid);
      let g2 = 0;
      while (b.isRunning && g2++ < 200) {
        const cur = b.players[b.currentPlayerIndex];
        if (!cur) break;
        b.handleAction(cur.id, 'call');
      }
    }
    d.stop();
  });

  test('balance holds and chips are conserved across a whole tournament', () => {
    const d = makeDirector(27, { tableSize: 9, startChips: 1500 });
    d.start();
    const expected = 27 * 1500;

    // Wrap rebalanceField so the seat-count rule is checked every time it can
    // actually act. It deliberately defers while any table has a hand in
    // progress, so measuring then would be measuring the deferral, not the
    // rule: assert only once the field is idle and balancing has had its say.
    const original = d.rebalanceField.bind(d);
    let worstSpread = 0;
    let assertedAt = 0;
    d.rebalanceField = () => {
      original();
      if (d.tables.some((t) => t.isRunning)) return;
      const counts = d.activeTables().map((t) => t.players.length);
      if (counts.length > 1) {
        worstSpread = Math.max(worstSpread, Math.max(...counts) - Math.min(...counts));
        assertedAt++;
      }
    };

    // Gentle aggression so the field stays spread over several tables long
    // enough for balancing to have something to do.
    runToCompletion(d, 3000, 0.06);

    expect(d.finished).not.toBeNull();
    expect(d.totalChips()).toBe(expected);
    expect(assertedAt).toBeGreaterThan(0); // the rule was actually exercised
    expect(worstSpread).toBeLessThanOrEqual(1);
    d.stop();
  });

  test('the final table is not broken out from under the last players', () => {
    const d = makeDirector(6, { tableSize: 9 });
    d.start();
    expect(d.activeTables()).toHaveLength(1);
    d._expectedChips = d.totalChips();
    d.rebalanceField();
    expect(d.activeTables()).toHaveLength(1);
    expect(d.playersRemaining()).toBe(6);
    d.stop();
  });

  // Shrinks the field to `keep` survivors and runs the rebalance, which is the
  // only honest way to trigger a break: a table can only be emptied into others
  // once the field actually fits on fewer tables.
  function breakDownTo(d, keep) {
    const doomed = d.fieldPlayers().slice(keep);
    for (const p of doomed) p.chips = 0;
    for (const table of d.tables) {
      for (const p of table.players.filter((x) => x.chips <= 0)) table.removePlayer(p.id);
    }
    d._expectedChips = d.totalChips();
    d.rebalanceField();
  }

  test('a broken table is never reopened', () => {
    const d = makeDirector(18, { tableSize: 9 });
    d.start();
    breakDownTo(d, 9); // 9 survivors fit one table, so one table breaks

    const broken = d.tables.filter((t) => t._broken);
    expect(broken.length).toBe(1);
    expect(d.activeTables()).toHaveLength(1);

    // Even with seats free elsewhere, the broken table is not a destination.
    const survivor = d.activeTables()[0];
    expect(d._emptiestTableExcept(survivor)).toBeUndefined();

    d.rebalanceField();
    expect(broken[0].players).toHaveLength(0);
    expect(d.totalChips()).toBe(d._expectedChips);
    d.stop();
  });

  test('a break is announced once, not on every later sweep', () => {
    const said = [];
    const d = makeDirector(18, { tableSize: 9, onMessage: (m) => said.push(m) });
    d.start();
    breakDownTo(d, 9);

    d.rebalanceField();
    d.rebalanceField();
    d._collapseStalledTables();

    const announcements = said.filter((m) => /is broken/.test(m));
    expect(announcements).toHaveLength(1);
    d.stop();
  });
});

describe('TournamentDirector money (phase 5)', () => {
  test('every payout structure sums to exactly 100 percent', () => {
    for (const field of [2, 5, 6, 9, 10, 17, 18, 29, 30, 49, 50, 200]) {
      const pct = payoutPercentagesFor(field);
      expect(pct.reduce((a, b) => a + b, 0)).toBe(100);
      expect(pct.length).toBeGreaterThan(0);
      // Monotonic: no place pays more than the one above it.
      for (let i = 1; i < pct.length; i++) expect(pct[i]).toBeLessThanOrEqual(pct[i - 1]);
    }
  });

  test('places paid grow with the field but stay a minority of it', () => {
    let previous = 0;
    for (const field of [4, 8, 15, 25, 40, 80]) {
      const paid = payoutPercentagesFor(field).length;
      expect(paid).toBeGreaterThanOrEqual(previous);
      expect(paid).toBeLessThan(field); // never pay the whole field
      previous = paid;
    }
  });

  test('payouts add back up to the pool exactly, losing nothing to rounding', () => {
    // 7 is deliberately awkward: 33% of 7 does not divide evenly.
    for (const [entrants, buyIn] of [
      [25, 20],
      [9, 7],
      [50, 33],
      [3, 1],
    ]) {
      const d = makeDirector(entrants, { buyIn, tableSize: 9 });
      d.start();
      const pool = d.prizePool();
      expect(pool).toBe(entrants * buyIn);
      const total = d.payouts().reduce((sum, s) => sum + s.amount, 0);
      expect(total).toBe(pool);
      d.stop();
    }
  });

  test('a free tournament pays zero without breaking the structure', () => {
    const d = makeDirector(20, { tableSize: 9 }); // no buyIn
    d.start();
    expect(d.prizePool()).toBe(0);
    expect(d.payouts().every((s) => s.amount === 0)).toBe(true);
    expect(d.paidPlaces).toBeGreaterThan(0);
    d.stop();
  });

  test('the bubble is one player from the money', () => {
    const d = makeDirector(20, { tableSize: 9, buyIn: 10 });
    d.start();
    expect(d.paidPlaces).toBe(4); // 20 players
    expect(d.isOnBubble()).toBe(false);

    // Bust down to exactly paidPlaces + 1.
    const doomed = d.fieldPlayers().slice(0, 20 - (d.paidPlaces + 1));
    for (const p of doomed) p.chips = 0;
    for (const table of d.tables) {
      for (const p of table.players.filter((x) => x.chips <= 0)) table.removePlayer(p.id);
    }
    expect(d.playersRemaining()).toBe(5);
    expect(d.isOnBubble()).toBe(true);

    // One more out and the bubble has burst.
    const next = d.fieldPlayers().find((p) => p.chips > 0);
    next.chips = 0;
    expect(d.isOnBubble()).toBe(false);
    d.stop();
  });

  test('hand for hand: on the bubble a table waits for the others', () => {
    const d = makeDirector(20, { tableSize: 9, buyIn: 10 });
    d.start();
    const doomed = d.fieldPlayers().slice(0, 15);
    for (const p of doomed) p.chips = 0;
    for (const table of d.tables) {
      for (const p of table.players.filter((x) => x.chips <= 0)) table.removePlayer(p.id);
    }
    d._expectedChips = d.totalChips();
    expect(d.isOnBubble()).toBe(true);

    const playable = d.tables.filter((t) => t.players.filter((p) => p.chips > 0).length >= 2);
    if (playable.length >= 2) {
      playable[0].isRunning = true; // one table still mid-hand
      expect(d.canStartHand(playable[1])).toBe(false); // the other must wait
      playable[0].isRunning = false;
      expect(d.canStartHand(playable[1])).toBe(true);
    }
    d.stop();
  });

  test('off the bubble, tables do not wait for each other', () => {
    const d = makeDirector(20, { tableSize: 9, buyIn: 10 });
    d.start();
    expect(d.isOnBubble()).toBe(false);
    d.tables[0].isRunning = true;
    expect(d.canStartHand(d.tables[1])).toBe(true);
    d.tables[0].isRunning = false;
    d.stop();
  });

  test('simultaneous bustouts are placed by hand-start stack, not by seat', () => {
    const d = makeDirector(12, { tableSize: 9, buyIn: 5 });
    d.start();
    const table = d.tables[0];
    const [a, b, c, winner] = table.players;
    // Seat order a, b, c but stacks say otherwise.
    table.handStartStacks = { [a.id]: 50, [b.id]: 900, [c.id]: 400 };
    table.roundCount = 3;
    // Their chips go to the winner, as a real hand would move them. Simply
    // zeroing three stacks destroys 6,000 chips and the conservation guard
    // rightly refuses to let the tournament continue.
    const pot = a.chips + b.chips + c.chips;
    a.chips = 0;
    b.chips = 0;
    c.chips = 0;
    winner.chips += pot;
    table.endRound();

    const byName = Object.fromEntries(d.tournament.eliminations.map((e) => [e.name, e.place]));
    // Bigger starting stack finishes higher, i.e. a lower place number.
    expect(byName[b.name]).toBeLessThan(byName[c.name]);
    expect(byName[c.name]).toBeLessThan(byName[a.name]);
    d.stop();
  });

  test('final results pair every place with its prize', () => {
    const d = makeDirector(12, { tableSize: 6, buyIn: 10 });
    d.start();
    const paid = d.paidPlaces;
    runToCompletion(d);
    expect(d.finished).not.toBeNull();

    const results = d.finalResults();
    expect(results).toHaveLength(12);
    expect(results[0].place).toBe(1);
    expect(results[0].inTheMoney).toBe(true);
    expect(results[paid - 1].inTheMoney).toBe(true);
    expect(results[paid].inTheMoney).toBe(false); // first out of the money
    expect(results[paid].prize).toBe(0);

    const paidOut = results.reduce((sum, r) => sum + r.prize, 0);
    expect(paidOut).toBe(d.prizePool());
    d.stop();
  });

  test('bubble and in-the-money are each announced once', () => {
    const said = [];
    const d = makeDirector(12, { tableSize: 6, buyIn: 10, onMessage: (m) => said.push(m) });
    d.start();
    runToCompletion(d, 3000, 0.12);
    expect(said.filter((m) => /Bubble:/.test(m)).length).toBeLessThanOrEqual(1);
    expect(said.filter((m) => /In the money/.test(m)).length).toBeLessThanOrEqual(1);
    d.stop();
  });
});

describe('Lobby phase 0: pre-start summary, avatars, tournament clock', () => {
  test('fieldSummary and payouts are safe before start and project a ladder', () => {
    const d = makeDirector(3, { buyIn: 100 });
    expect(() => d.fieldSummary('p0')).not.toThrow();
    const summary = d.fieldSummary('p0');
    expect(summary.isRunning).toBe(false);
    expect(summary.entrants).toBe(3);
    expect(summary.prizePool).toBe(300);
    expect(summary.payouts.length).toBeGreaterThan(0);
    expect(summary.payouts.reduce((sum, p) => sum + p.amount, 0)).toBe(300);
    expect(() => new TournamentDirector({ id: 'empty' }).fieldSummary()).not.toThrow();
  });

  test('avatars are carried through seating and a balance move', () => {
    const d = new TournamentDirector({
      id: 'avatars',
      tableSize: 3,
      startChips: 1000,
      levelDuration: 99999,
      gameOptions: { actionTimeoutMs: 0 },
    });
    ['🦊', '🐸', '🦁', '🐯'].forEach((avatar, i) =>
      d.register({ id: `p${i}`, uid: `u${i}`, name: `P${i}`, avatar })
    );
    d.start();
    for (const table of d.tables) {
      for (const p of table.players) expect(p.avatar).toMatch(/^[🦊🐸🦁🐯]$/u);
    }
    const from = d.tables[0];
    const to = d.tables[1];
    const mover = from.players[0];
    expect(d._movePlayer(from, to, mover)).toBe(true);
    const moved = to.players.find((p) => p.uid === mover.uid);
    expect(moved.avatar).toBe(mover.avatar);
    expect(to.getStateForPlayer(moved.id).players.find((p) => p.uid === mover.uid).avatar).toBe(
      mover.avatar
    );
  });

  test('director tables run the tournament action clock', () => {
    const d = makeDirector(2, { gameOptions: {} });
    d.start();
    expect(d.tables[0].gameMode).toBe('tournament');
    expect(d.tables[0].getHumanActionTimeoutMs()).toBe(25000);
    // A caller can still override the mode, which is how the tests above keep
    // their zero action clock.
    const quiet = makeDirector(2);
    quiet.start();
    expect(quiet.tables[0].gameMode).toBe('tournament');
  });
});

describe('Lobby phase 2: late registration, unregister, roster, placements', () => {
  function seededRng(seed = 4242) {
    return () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
  }

  test('unregister only works before the start', () => {
    const d = makeDirector(3);
    expect(d.unregister('p1')).toBe(true);
    expect(d.entrants.map((e) => e.id)).toEqual(['p0', 'p2']);
    d.start();
    expect(d.unregister('p0')).toBe(false);
  });

  test('a late entrant sits at the smallest table with the starting stack, conserving chips', () => {
    const d = makeDirector(7, { tableSize: 4, lateRegLevels: 3 });
    d.start();
    expect(d.lateRegOpen()).toBe(true);
    const expected = d.totalChips() + 2000;
    const { table, player } = d.registerLate({
      id: 'late',
      uid: 'late',
      name: 'Late',
      avatar: '🦊',
    });
    expect(player.chips).toBe(2000);
    expect(player.avatar).toBe('🦊');
    expect(table.players.length).toBe(4); // the 3-seat table, now full
    expect(d.entrants).toHaveLength(8);
    expect(d.tournament.startingPlayers).toBe(8);
    expect(d.totalChips()).toBe(expected);
    expect(() => d.assertChipConservation()).not.toThrow();
    expect(d.roster().find((r) => r.uid === 'late')).toMatchObject({
      table: table.tableNumber,
      chips: 2000,
    });
  });

  test('a late entrant onto a running table waits out the hand, then plays', () => {
    const d = makeDirector(4, { tableSize: 6, lateRegLevels: 3 });
    d.start();
    const table = d.tables[0];
    expect(d.startHandsWhereReady()).toBe(1);
    expect(table.isRunning).toBe(true);
    const dealer = table.dealerIndex;
    const current = table.currentPlayerIndex;
    const { player } = d.registerLate({ id: 'late', uid: 'late', name: 'Late' });
    expect(player.folded).toBe(true);
    expect(table.dealerIndex).toBe(dealer);
    expect(table.currentPlayerIndex).toBe(current);
    const rng = seededRng();
    playHand(table, rng, 0.2);
    expect(table.isRunning).toBe(false);
    expect(() => d.assertChipConservation()).not.toThrow();
    // Next deal includes them.
    d.startHandsWhereReady();
    const late = table.players.find((p) => p.uid === 'late');
    expect(late).toBeTruthy();
    expect(late.folded).toBe(false);
    expect(late.holeCards).toHaveLength(2);
  });

  test('when every table is full a late entrant opens a table that breaks first', () => {
    const d = makeDirector(4, { tableSize: 2, lateRegLevels: 3 });
    d.start();
    expect(d.tables).toHaveLength(2);
    const before = [...d.breakOrder];
    const { table } = d.registerLate({ id: 'late', uid: 'late', name: 'Late' });
    expect(d.tables).toHaveLength(3);
    expect(table.tableNumber).toBe(3);
    expect(d.breakOrder[0]).toBe(3);
    expect(d.breakOrder.slice(1)).toEqual(before);
    expect(table.smallBlind).toBe(d.tables[0].smallBlind);
    expect(() => d.assertChipConservation()).not.toThrow();
  });

  test('late registration recomputes the payout ladder and renumbers earlier bust-outs', () => {
    const d = makeDirector(5, { tableSize: 6, lateRegLevels: 3 });
    d.start();
    expect(d.paidPlaces).toBe(1); // 5 entrants: winner takes all
    // Two bust-outs recorded before anyone registers late.
    d.tournament.recordElimination('P4', 1, 'p4');
    d.tournament.recordElimination('P3', 2, 'p3');
    expect(d.tournament.eliminations.map((e) => e.place)).toEqual([5, 4]);
    d.registerLate({ id: 'l1', uid: 'l1', name: 'L1' });
    expect(d.paidPlaces).toBe(2); // 6 entrants: two paid
    expect(d.tournament.eliminations.map((e) => e.place)).toEqual([6, 5]);
    d.tournament.recordElimination('P2', 3, 'p2');
    expect(d.tournament.eliminations.map((e) => e.place)).toEqual([6, 5, 4]);
    const places = d.tournament.eliminations.map((e) => e.place);
    expect(new Set(places).size).toBe(places.length);
  });

  test('late registration closes once the level passes and the close is announced once', () => {
    const d = makeDirector(3, { tableSize: 6, lateRegLevels: 1 });
    const said = [];
    d.onMessage = (m) => said.push(m);
    d.start();
    expect(d.lateRegOpen()).toBe(true);
    d.tournament.currentLevel = 1;
    d.tournament.onLevelUp(1, d.tournament.getCurrentBlinds());
    expect(d.lateRegOpen()).toBe(false);
    expect(() => d.registerLate({ id: 'x', uid: 'x', name: 'X' })).toThrow(/closed/);
    d.tournament.onLevelUp(2, d.tournament.getCurrentBlinds());
    expect(said.filter((m) => /Late registration closed/.test(m))).toHaveLength(1);
    const none = makeDirector(2, { lateRegLevels: 0 });
    none.start();
    expect(none.lateRegOpen()).toBe(false);
  });

  test('onPlayerEliminated fires for a busted human with their place', () => {
    const fired = [];
    const d = makeDirector(3, { tableSize: 6, onPlayerEliminated: (e) => fired.push(e) });
    d.start();
    const table = d.tables[0];
    const victim = table.players[0];
    victim.chips = 0;
    d.tournament.recordElimination(victim.name, 1, victim.uid);
    const expectedChips = d._expectedChips;
    d._expectedChips = null; // this test moves chips by hand
    d._handleRoundEnd(table, null);
    d._expectedChips = expectedChips;
    expect(fired).toEqual([{ uid: victim.uid, name: victim.name, place: 3, tableId: table.id }]);
    expect(table.players.some((p) => p.uid === victim.uid)).toBe(false);
    expect(d.roster().find((r) => r.uid === victim.uid)).toMatchObject({ place: 3, table: null });
  });

  test('the next hand waits out the pause after the last one ended', () => {
    let clock = 100000;
    const d = makeDirector(3, { handPauseMs: 4000, now: () => clock });
    d.start();
    const table = d.tables[0];
    // start() seats the field; hands begin on the director's tick, so the
    // table is idle and ready until a hand has actually ended on it.
    expect(d.canStartHand(table)).toBe(true);

    // End a hand the way the engine does, through the director's own hook.
    d._handleRoundEnd(table, null);
    expect(d.canStartHand(table)).toBe(false); // held: the result is still up

    clock += 3999;
    expect(d.canStartHand(table)).toBe(false);
    clock += 2;
    expect(d.canStartHand(table)).toBe(true);
  });

  test('with no pause the next hand can start straight away', () => {
    const d = makeDirector(3, { handPauseMs: 0 });
    d.start();
    const table = d.tables[0];
    d._handleRoundEnd(table, null);
    expect(d.canStartHand(table)).toBe(true);
  });
});

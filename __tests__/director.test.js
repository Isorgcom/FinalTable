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

  // Sitting out is a property of the player, not of the seat. addPlayer builds a
  // fresh record with autoPlay false, so without the carry a balance move sits
  // a player back in who asked to sit out: they come back live, burn a full
  // clock and time out into a sit-out they never left.
  test('a balance move carries a sitting-out seat with it', () => {
    const d = new TournamentDirector({
      id: 'sitout_move',
      tableSize: 3,
      startChips: 1000,
      levelDuration: 99999,
      gameOptions: { actionTimeoutMs: 0 },
    });
    for (let i = 0; i < 4; i++) d.register({ id: `p${i}`, uid: `u${i}`, name: `P${i}` });
    d.start();

    const from = d.tables[0];
    const to = d.tables[1];
    const mover = from.players[0];
    mover.autoPlay = true;
    mover.sitOutReason = 'requested';
    mover.sitOutNextHand = true;

    expect(d._movePlayer(from, to, mover)).toBe(true);

    const moved = to.players.find((p) => p.uid === mover.uid);
    expect(moved.autoPlay).toBe(true);
    expect(moved.sitOutReason).toBe('requested');
    expect(moved.sitOutNextHand).toBe(true);
  });

  // rebalanceField runs from one table's round end, which is precisely the
  // moment the other tables are most likely to be mid-hand. Gating the whole
  // consolidation on every table being idle at once means it almost never runs:
  // observed on a live 21-player field that fell to nine players and stayed
  // spread across three tables, when nine fit on one.
  test('a table is broken even while another table is mid-hand', () => {
    const d = new TournamentDirector({
      id: 'break_while_running',
      tableSize: 9,
      startChips: 1000,
      levelDuration: 99999,
      gameOptions: { actionTimeoutMs: 0 },
    });
    for (let i = 0; i < 20; i++) d.register({ id: `p${i}`, uid: `u${i}`, name: `P${i}` });
    d.start();
    expect(d.tables.length).toBe(3);

    // Bust the field down to nine, three at each table, so the whole field
    // would fit on a single table. Chips are handed to a survivor rather than
    // zeroed: busting moves a stack, it does not destroy one, and the
    // director's conservation check is right to object if it goes missing.
    for (const table of d.tables) {
      const survivors = table.players.slice(0, 3);
      table.players.slice(3).forEach((p) => {
        survivors[0].chips += p.chips;
        p.chips = 0;
      });
      table.players = table.players.filter((p) => p.chips > 0);
    }
    expect(d.playersRemaining()).toBe(9);
    const before = d.activeTables().length;

    // A table is dealing, and it is not the one due to break. Break order is
    // fixed at the start, highest number first, so table 3 is the candidate;
    // table 1 dealing must neither stop it nor lose its own seats.
    d.tables[0].isRunning = true;
    d.rebalanceField();

    expect(d.activeTables().length).toBeLessThan(before);
    expect(d.tables[0].players).toHaveLength(3);
    expect(d.totalChips()).toBe(20 * 1000);
  });

  test('balancing also runs while another table is mid-hand', () => {
    const d = new TournamentDirector({
      id: 'balance_while_running',
      tableSize: 9,
      startChips: 1000,
      levelDuration: 99999,
      gameOptions: { actionTimeoutMs: 0 },
    });
    for (let i = 0; i < 27; i++) d.register({ id: `p${i}`, uid: `u${i}`, name: `P${i}` });
    d.start();
    expect(d.tables.length).toBe(3);

    // Lopsided, with the dealing table sitting between the other two so it is
    // neither the fullest nor the emptiest: the pair that needs balancing is
    // free, so the work goes ahead around it.
    const shed = (table, keepN) => {
      const keep = table.players.slice(0, keepN);
      table.players.slice(keepN).forEach((p) => {
        keep[0].chips += p.chips;
        p.chips = 0;
      });
      table.players = table.players.filter((p) => p.chips > 0);
    };
    shed(d.tables[1], 2);
    shed(d.tables[2], 5);
    d.tables[2].isRunning = true;
    const spread = () => {
      const live = d.activeTables().filter((t) => !t.isRunning);
      return (
        Math.max(...live.map((t) => t.players.length)) -
        Math.min(...live.map((t) => t.players.length))
      );
    };
    expect(spread()).toBeGreaterThan(1);

    d.rebalanceField();

    expect(spread()).toBeLessThanOrEqual(1);
    // The table that was dealing was not touched.
    expect(d.tables[2].players).toHaveLength(5);
  });

  // A running tournament lives only in memory, so a crash used to take the
  // field with it: the server came back in a second and every seat found the
  // tournament simply gone. A snapshot taken between hands is enough to seat
  // everyone again with the stacks they had.
  test('a field survives a snapshot and restore with its chips intact', () => {
    const d = makeDirector(12, { tableSize: 6, startChips: 1000 });
    d.start();
    expect(d.tables.length).toBe(2);

    // Move some chips around so the restore has something to get wrong.
    const t0 = d.tables[0];
    t0.players[0].chips += 700;
    t0.players[1].chips -= 700;
    const before = d.totalChips();
    const seatsBefore = d.tables.map((t) => t.players.map((p) => `${p.uid}:${p.chips}`).join(','));

    // Move the button off zero so a restore that ignores it is visible.
    d.tables[0].dealerIndex = 3;
    const buttonBefore = d.tables.map((t) => t.dealerIndex);

    const snap = d.snapshot();
    expect(snap.tables).toHaveLength(2);

    const revived = new TournamentDirector({
      id: snap.id,
      tableSize: snap.tableSize,
      startChips: snap.startChips,
      levelDuration: 99999,
      gameOptions: { actionTimeoutMs: 0 },
    });
    expect(revived.restoreFrom(snap)).toBe(true);

    expect(revived.tables).toHaveLength(2);
    expect(revived.totalChips()).toBe(before);
    expect(
      revived.tables.map((t) => t.players.map((p) => `${p.uid}:${p.chips}`).join(','))
    ).toEqual(seatsBefore);
    expect(revived.isRunning).toBe(true);
    expect(revived.tables.map((t) => t.dealerIndex)).toEqual(buttonBefore);
    // Every restored seat is sitting out until its player comes back to it.
    for (const table of revived.tables) {
      for (const p of table.players) expect(p.autoPlay).toBe(true);
    }
    // And the field can be dealt again.
    expect(revived.canStartHand(revived.tables[0])).toBe(true);
    revived.stop();
    d.stop();
  });

  test('a table mid-hand keeps the roster it had, and is restored to before that hand', () => {
    const d = makeDirector(12, { tableSize: 6, startChips: 1000 });
    d.start();
    const [a, b] = d.tables;

    // Table A is recorded while idle, then starts dealing.
    d._captureIdleTables();
    const stacksBeforeHand = a.players.map((p) => p.chips);
    a.startRound();
    expect(a.isRunning).toBe(true);
    // Blinds are now in the pot, so the live stacks are short.
    expect(a.players.map((p) => p.chips)).not.toEqual(stacksBeforeHand);

    // Snapshotting now must not record the short stacks.
    const snap = d.snapshot();
    const entryA = snap.tables.find((t) => t.tableNumber === a.tableNumber);
    expect(entryA.players.map((p) => p.chips)).toEqual(stacksBeforeHand);
    // The idle table is recorded live.
    const entryB = snap.tables.find((t) => t.tableNumber === b.tableNumber);
    expect(entryB.players.map((p) => p.chips)).toEqual(b.players.map((p) => p.chips));

    // The whole field still balances: the hand in flight is simply undone.
    const revived = new TournamentDirector({
      id: snap.id,
      tableSize: snap.tableSize,
      startChips: snap.startChips,
      levelDuration: 99999,
      gameOptions: { actionTimeoutMs: 0 },
    });
    revived.restoreFrom(snap);
    expect(revived.totalChips()).toBe(12 * 1000);
    revived.stop();
    d.stop();
  });

  test('the blind clock resumes where it stopped, not where it would have been', () => {
    const d = makeDirector(4, { tableSize: 4, startChips: 1000, levelDuration: 300 });
    d.start();
    d.tournament.currentLevel = 2;
    d.tournament.startTime = Date.now() - 700 * 1000; // deep into level 2
    const snap = d.snapshot();
    expect(snap.clock.currentLevel).toBe(2);
    expect(snap.clock.elapsedMs).toBeGreaterThan(600 * 1000);

    // The server is "down" for a long time before the restore.
    snap.clock.elapsedMs = 700 * 1000;
    const revived = new TournamentDirector({
      id: snap.id,
      tableSize: snap.tableSize,
      startChips: snap.startChips,
      levelDuration: 300,
      gameOptions: { actionTimeoutMs: 0 },
    });
    revived.restoreFrom(snap);
    // Level 2 still, not level 5: downtime is not charged to the field.
    expect(revived.tournament.currentLevel).toBe(2);
    expect(revived.tables[0].smallBlind).toBe(revived.tournament.getCurrentBlinds().sb);
    revived.stop();
    d.stop();
  });

  // Ranking only the idle tables ranks a different field on every round end,
  // so the same table is the obvious one to empty now and the wrong one a
  // second later. Observed on a live 200-player field: players carried from one
  // table to another and straight back inside the same second, over and over.
  test('a break that cannot finish does not get refilled behind it', () => {
    const d = new TournamentDirector({
      id: 'partial_break',
      tableSize: 9,
      startChips: 1000,
      levelDuration: 99999,
      gameOptions: { actionTimeoutMs: 0 },
    });
    for (let i = 0; i < 27; i++) d.register({ id: `p${i}`, uid: `u${i}`, name: `P${i}` });
    d.start();
    d._say = () => {};
    const shed = (table, keepN) => {
      const keep = table.players.slice(0, keepN);
      table.players.slice(keepN).forEach((p) => {
        keep[0].chips += p.chips;
        p.chips = 0;
      });
      table.players = table.players.filter((p) => p.chips > 0);
    };
    // Eight, eight, two: the field fits on two tables, so table 3 should break.
    shed(d.tables[0], 8);
    shed(d.tables[1], 8);
    shed(d.tables[2], 2);
    // But the only real spare seat is on a table that is dealing, so the break
    // cannot finish. It must not start one it cannot complete and leave a
    // stranded table for the balancer to fill straight back up.
    d.tables[1].isRunning = true;

    const moves = [];
    d.onPlayerMoved = (m) => moves.push(`${m.uid}:${m.fromTable}->${m.toTable}`);
    d.rebalanceField();
    d.tables.forEach((t) => {
      t.isRunning = false;
    });

    const sizes = d.tables.map((t) => t.players.length);
    // Either table 3 emptied completely, or it was left exactly as it was.
    expect(sizes[2] === 0 || sizes[2] === 2).toBe(true);
    // Nobody is carried out of a table and then back into it.
    const perPlayer = {};
    for (const m of moves) {
      const uid = m.split(':')[0];
      perPlayer[uid] = (perPlayer[uid] || 0) + 1;
    }
    expect(Object.entries(perPlayer).filter(([, n]) => n > 1)).toEqual([]);
    expect(d.totalChips()).toBe(27 * 1000);
    d.stop();
  });

  test('balancing does not carry the same player back and forth', () => {
    const d = new TournamentDirector({
      id: 'no_oscillation',
      tableSize: 9,
      startChips: 1000,
      levelDuration: 99999,
      gameOptions: { actionTimeoutMs: 0 },
    });
    for (let i = 0; i < 27; i++) d.register({ id: `p${i}`, uid: `u${i}`, name: `P${i}` });
    d.start();
    d._say = () => {};

    const shed = (table, keepN) => {
      const keep = table.players.slice(0, keepN);
      table.players.slice(keepN).forEach((p) => {
        keep[0].chips += p.chips;
        p.chips = 0;
      });
      table.players = table.players.filter((p) => p.chips > 0);
    };
    shed(d.tables[1], 5);
    shed(d.tables[2], 4);

    const moves = [];
    d.onPlayerMoved = (m) => moves.push(m.uid);

    // Round ends arrive from one table at a time, so a different table is
    // dealing on each pass. That rotation is what used to change the answer.
    for (let round = 0; round < 20; round += 1) {
      d.tables.forEach((t, i) => {
        t.isRunning = i === round % d.tables.length;
      });
      d.rebalanceField();
    }
    d.tables.forEach((t) => {
      t.isRunning = false;
    });

    const counts = {};
    for (const uid of moves) counts[uid] = (counts[uid] || 0) + 1;
    const carriedTwice = Object.entries(counts).filter(([, n]) => n > 1);
    expect(carriedTwice).toEqual([]);
    // And it settles rather than churning: nobody is moved more than the field
    // actually needs.
    expect(moves.length).toBeLessThanOrEqual(9);
    expect(d.totalChips()).toBe(27 * 1000);
    d.stop();
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

// ============================================================
//  Blind structures: breaks, antes and the structure a restore runs on
// ============================================================
describe('blind structures', () => {
  const SCHEDULE = [
    { sb: 10, bb: 20, ante: 0, duration: 99999 },
    { break: true, duration: 99999 },
    { sb: 20, bb: 40, ante: 40, duration: 99999 },
    { sb: 30, bb: 60, ante: 60, duration: 99999 },
  ];

  function levelUp(d, level) {
    d.tournament.currentLevel = level;
    d.tournament.onLevelUp(level, d.tournament.getCurrentBlinds());
  }

  test('a break holds every table, a hand in play finishes, and dealing resumes after it', () => {
    const said = [];
    const d = makeDirector(8, {
      tableSize: 4,
      blindSchedule: SCHEDULE,
      onMessage: (m) => said.push(m),
    });
    d.start();
    const [a, b] = d.tables;
    expect(d.canStartHand(a)).toBe(true);
    a.startRound();
    expect(a.isRunning).toBe(true);

    levelUp(d, 1);
    expect(d.tournament.onBreak()).toBe(true);
    expect(said.some((m) => /^Break: 99999s · play resumes at 20\/40 ante 40$/.test(m))).toBe(true);
    // The hand already dealt plays on at the blinds it was dealt with.
    expect(a.isRunning).toBe(true);
    expect(a.bigBlind).toBe(20);
    // Nothing new deals.
    expect(d.canStartHand(b)).toBe(false);
    expect(d.startHandsWhereReady()).toBe(0);

    levelUp(d, 2);
    expect(d.tournament.onBreak()).toBe(false);
    expect(said.some((m) => /^Blinds up: 20\/40 ante 40 \(level 2\)$/.test(m))).toBe(true);
    for (const t of d.tables) {
      expect(t.smallBlind).toBe(20);
      expect(t.bigBlind).toBe(40);
      expect(t.ante).toBe(40);
    }
    expect(d.canStartHand(b)).toBe(true);
    b.startRound();
    expect(b.ante).toBe(40);
    expect(b.players[b.bbIndex].ante).toBe(40);
    d.stop();
  });

  test('late registration stays open through the break after its last level', () => {
    const said = [];
    const d = makeDirector(4, {
      tableSize: 4,
      lateRegLevels: 1,
      blindSchedule: SCHEDULE,
      onMessage: (m) => said.push(m),
    });
    d.start();
    expect(d.lateRegOpen()).toBe(true);
    levelUp(d, 1); // the break after level 1
    expect(d.lateRegOpen()).toBe(true);
    expect(said.filter((m) => /Late registration closed/.test(m))).toHaveLength(0);
    levelUp(d, 2); // level 2 begins
    expect(d.lateRegOpen()).toBe(false);
    expect(said.filter((m) => /Late registration closed/.test(m))).toHaveLength(1);
    d.stop();
  });

  test('onLevelChange fires with the level number and the break flag', () => {
    const changes = [];
    const d = makeDirector(4, {
      tableSize: 4,
      blindSchedule: SCHEDULE,
      onLevelChange: (info) => changes.push(info),
    });
    d.start();
    levelUp(d, 1);
    levelUp(d, 2);
    expect(changes).toEqual([
      {
        level: 1,
        blinds: { sb: 20, bb: 40, ante: 40 },
        onBreak: true,
        nextLevelIn: expect.any(Number),
        manual: false,
      },
      {
        level: 2,
        blinds: { sb: 20, bb: 40, ante: 40 },
        onBreak: false,
        nextLevelIn: expect.any(Number),
        manual: false,
      },
    ]);
    expect(d.fieldSummary()).toMatchObject({
      level: 2,
      levelCount: 3,
      onBreak: false,
      finalLevel: false,
    });
    d.stop();
  });

  test('a restore runs on the structure the field was dealt with', () => {
    const d = makeDirector(4, { tableSize: 4, blindSchedule: SCHEDULE });
    d.start();
    levelUp(d, 2);
    const snap = d.snapshot();
    expect(snap.clock.schedule).toHaveLength(4);
    const revived = new TournamentDirector({
      id: snap.id,
      tableSize: snap.tableSize,
      startChips: snap.startChips,
      levelDuration: 300, // Standard, which the snapshot must override
      gameOptions: { actionTimeoutMs: 0 },
    });
    revived.restoreFrom(snap);
    expect(revived.tournament.blindSchedule).toEqual(d.tournament.blindSchedule);
    expect(revived.tournament.currentLevel).toBe(2);
    expect(revived.tables[0].ante).toBe(40);
    expect(revived.fieldSummary().level).toBe(2);
    revived.stop();
    d.stop();
  });
});

// ============================================================
//  The host at the table: pause, the level, removing and moving players
// ============================================================
describe('the host at the table', () => {
  const SCHEDULE = [
    { sb: 10, bb: 20, ante: 0, duration: 99999 },
    { break: true, duration: 99999 },
    { sb: 20, bb: 40, ante: 40, duration: 99999 },
    { sb: 30, bb: 60, ante: 60, duration: 99999 },
  ];
  function lcg(seed = 777) {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
  }

  test('pause holds dealing and the clock; resume restarts both', () => {
    const said = [];
    const d = makeDirector(4, {
      tableSize: 4,
      blindSchedule: SCHEDULE,
      onMessage: (m) => said.push(m),
    });
    d.start();
    expect(d.pause()).toBe(true);
    expect(d.isPaused()).toBe(true);
    expect(d.tournament.isPaused()).toBe(true);
    expect(d.canStartHand(d.tables[0])).toBe(false);
    expect(d.tick()).toBe(0);
    expect(d.fieldSummary().paused).toBe(true);
    expect(said).toContain('Paused by the host');
    expect(d.pause()).toBe(false);
    expect(d.resume()).toBe(true);
    expect(d.isPaused()).toBe(false);
    expect(d.canStartHand(d.tables[0])).toBe(true);
    expect(said).toContain('Play resumes');
    expect(d.resume()).toBe(false);
    d.stop();
  });

  test('a level stepped back says so and can reopen late registration', () => {
    const said = [];
    const d = makeDirector(4, {
      tableSize: 4,
      lateRegLevels: 1,
      blindSchedule: SCHEDULE,
      onMessage: (m) => said.push(m),
    });
    d.start();
    expect(d.stepLevel(-1)).toEqual({ error: 'Already on the first level' });
    expect(d.stepLevel(1)).toEqual({ level: 1, onBreak: true });
    expect(d.stepLevel(1)).toEqual({ level: 2, onBreak: false });
    expect(d.lateRegOpen()).toBe(false);
    expect(said.filter((m) => /Late registration closed/.test(m))).toHaveLength(1);
    expect(d.tables[0].bigBlind).toBe(40);
    expect(d.stepLevel(-1)).toEqual({ level: 1, onBreak: true });
    expect(d.stepLevel(-1)).toEqual({ level: 1, onBreak: false });
    expect(said.some((m) => m === 'Blinds back to 10/20 (level 1)')).toBe(true);
    expect(d.tables[0].bigBlind).toBe(20);
    expect(d.lateRegOpen()).toBe(true);
    d.stepLevel(1);
    d.stepLevel(1);
    expect(said.filter((m) => /Late registration closed/.test(m))).toHaveLength(2);
    expect(d.stepLevel(1)).toEqual({ level: 3, onBreak: false });
    expect(d.stepLevel(1)).toEqual({ error: 'Already on the last level' });
    expect(d.tables[0].ante).toBe(60);
    d.stop();
  });

  test('a minute goes on or off the level, but not on the last one', () => {
    const said = [];
    const d = makeDirector(3, {
      tableSize: 4,
      blindSchedule: SCHEDULE.map((r) => ({ ...r, duration: 300 })),
      onMessage: (m) => said.push(m),
    });
    d.start();
    const before = d.tournament.getTimeUntilNextLevel();
    const more = d.adjustClock(60);
    expect(Math.abs(more.nextLevelIn - (before + 60))).toBeLessThanOrEqual(1);
    expect(said).toContain('1 min added to the level by the host');
    const less = d.adjustClock(-60);
    expect(Math.abs(less.nextLevelIn - before)).toBeLessThanOrEqual(1);
    expect(said).toContain('1 min taken off the level by the host');
    d.tournament.goToLevel(3);
    expect(d.adjustClock(60)).toEqual({ error: 'Nothing is counting down on the final level' });
    d.stop();
  });

  test('a removed player leaves with their chips, finishing where they stand', () => {
    const said = [];
    const out = [];
    let snaps = 0;
    const d = makeDirector(6, {
      tableSize: 6,
      onMessage: (m) => said.push(m),
      onPlayerEliminated: (e) => out.push(e),
      onSnapshot: () => snaps++,
    });
    d.start();
    const table = d.tables[0];
    const victim = table.players[2];
    const total = d._expectedChips;
    expect(d.removeFromPlay(victim.uid)).toEqual({ removed: true, place: 6 });
    expect(table.players.some((p) => p.uid === victim.uid)).toBe(false);
    expect(d._expectedChips).toBe(total - 2000);
    expect(d.totalChips()).toBe(total - 2000);
    expect(() => d.assertChipConservation()).not.toThrow();
    expect(out).toEqual([
      { uid: victim.uid, name: victim.name, place: 6, tableId: table.id, removed: true },
    ]);
    expect(said).toContain(`${victim.name} removed from the game by the host, finishing #6`);
    expect(d.roster().find((r) => r.uid === victim.uid)).toMatchObject({ place: 6, table: null });
    expect(d.playersRemaining()).toBe(5);
    expect(snaps).toBe(1);
    expect(d.removeFromPlay(victim.uid)).toEqual({ error: 'They are not seated' });
    d.stop();
  });

  test('a removal during a hand waits for the hand, then goes through once', () => {
    const out = [];
    const d = makeDirector(3, { tableSize: 3, onPlayerEliminated: (e) => out.push(e) });
    d.start();
    const table = d.tables[0];
    table.startRound();
    const victim = table.players[0];
    expect(d.removeFromPlay(victim.uid)).toEqual({ queued: true });
    expect(table.players.some((p) => p.uid === victim.uid)).toBe(true);
    expect(victim.autoPlay).toBe(true);
    expect(victim.sitOutReason).toBe('removed');
    expect(out).toEqual([]);
    playHand(table, lcg(), 0);
    expect(table.isRunning).toBe(false);
    expect(table.players.some((p) => p.uid === victim.uid)).toBe(false);
    expect(out.filter((e) => e.uid === victim.uid)).toHaveLength(1);
    expect(d.tournament.eliminations.filter((e) => e.uid === victim.uid)).toHaveLength(1);
    expect(d._pendingRemovals.size).toBe(0);
    expect(() => d.assertChipConservation()).not.toThrow();
    d.stop();
  });

  test('removing down to one player finishes the tournament with a winner', () => {
    const finished = [];
    const d = makeDirector(2, { tableSize: 2, onFinished: (f) => finished.push(f) });
    d.start();
    const [a, b] = d.tables[0].players;
    expect(d.removeFromPlay(b.uid)).toEqual({ removed: true, place: 2 });
    expect(d.isRunning).toBe(false);
    expect(d.finished.winner).toBe(a.name);
    expect(finished).toHaveLength(1);
    expect(d.finalResults().map((x) => [x.place, x.name])).toEqual([
      [1, a.name],
      [2, b.name],
    ]);
    d.stop();
  });

  test('a host move is made between hands, waits on one, and keeps the tables level', () => {
    const said = [];
    const moves = [];
    const d = makeDirector(9, {
      tableSize: 6,
      onMessage: (m) => said.push(m),
      onPlayerMoved: (m) => moves.push(m),
    });
    d.start();
    const [big, small] = [...d.tables].sort((x, y) => y.players.length - x.players.length);
    expect([big.players.length, small.players.length]).toEqual([5, 4]);
    const mover = big.players[0];
    expect(d.requestMove(mover.uid, small.tableNumber)).toEqual({ moved: true });
    expect(small.players.some((p) => p.uid === mover.uid)).toBe(true);
    expect([big.players.length, small.players.length]).toEqual([4, 5]);
    expect(moves[0]).toMatchObject({ uid: mover.uid, toTable: small.tableNumber });
    expect(said).toContain(`${mover.name} moves to table ${small.tableNumber} (by the host)`);
    // Within a seat of each other, so the balancer leaves it alone.
    d.rebalanceField();
    expect(small.players.some((p) => p.uid === mover.uid)).toBe(true);

    expect(d.requestMove(big.players[0].uid, small.tableNumber).error).toMatch(
      /would then have more players/
    );
    expect(d.requestMove(mover.uid, small.tableNumber).error).toMatch(/already at table/);
    expect(d.requestMove(mover.uid, 99).error).toMatch(/no table 99/);
    expect(d.requestMove('nobody', big.tableNumber)).toEqual({ error: 'They are not seated' });

    // A hand in the way: the move waits, and is made at that hand's end.
    big.startRound();
    expect(d.requestMove(mover.uid, big.tableNumber)).toEqual({ queued: true });
    expect(d._pendingMoves.get(mover.uid)).toBe(big.tableNumber);
    expect(small.players.some((p) => p.uid === mover.uid)).toBe(true);
    playHand(big, lcg(), 0);
    expect(big.isRunning).toBe(false);
    expect(big.players.some((p) => p.uid === mover.uid)).toBe(true);
    expect(d._pendingMoves.size).toBe(0);
    expect(() => d.assertChipConservation()).not.toThrow();

    const full = makeDirector(12, { tableSize: 6 });
    full.start();
    const [t1, t2] = full.tables;
    expect(full.requestMove(t1.players[0].uid, t2.tableNumber)).toEqual({
      error: `Table ${t2.tableNumber} is full`,
    });
    full.stop();
    d.stop();
  });

  test('a paused field is written down paused and comes back paused', () => {
    const d = makeDirector(4, { tableSize: 4 });
    d.start();
    d.pause();
    const snap = d.snapshot();
    expect(snap.paused).toBe(true);
    expect(snap.clock.paused).toBe(true);
    const revived = new TournamentDirector({
      id: snap.id,
      tableSize: 4,
      startChips: snap.startChips,
      levelDuration: 99999,
      gameOptions: { actionTimeoutMs: 0 },
    });
    revived.restoreFrom(snap);
    expect(revived.isPaused()).toBe(true);
    expect(revived.canStartHand(revived.tables[0])).toBe(false);
    expect(revived.resume()).toBe(true);
    expect(revived.canStartHand(revived.tables[0])).toBe(true);
    revived.stop();
    d.stop();
  });
});

// ============================================================
//  Tables that never rest at the same moment
// ============================================================
describe('a field waiting on a table', () => {
  function lcg(seed = 99) {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
  }
  // Bust `n` players at a table by handing their chips to a survivor, then
  // let the director see that hand end. Conservation holds throughout.
  function bustAt(d, table, n) {
    const keeper = table.players[0];
    for (const p of table.players.slice(1, 1 + n)) {
      keeper.chips += p.chips;
      p.chips = 0;
      d.tournament.recordElimination(p.name, 1, p.uid);
    }
    d._handleRoundEnd(table, null);
  }

  test('a table due to break sits out a hand, and the merge happens at the next round end', () => {
    const d = makeDirector(7, { tableSize: 6 });
    d.start();
    const t1 = d.tables.find((t) => t.tableNumber === 1);
    const t2 = d.tables.find((t) => t.tableNumber === 2);
    expect([t1.players.length, t2.players.length]).toEqual([4, 3]);
    // Table 2 is mid-hand when table 1 loses a player; six now fit one table.
    t2.startRound();
    bustAt(d, t1, 1);
    expect(d.playersRemaining()).toBe(6);
    expect(d.activeTables()).toHaveLength(2); // table 2 is dealing: not yet
    // Table 1 deals again, as it would; table 2 finishes and must not.
    t1.startRound();
    playHand(t2, lcg(), 0);
    expect(t2.isRunning).toBe(false);
    expect(d.activeTables()).toHaveLength(2); // table 1 is dealing: not yet
    expect(d.canStartHand(t2)).toBe(false);
    expect(d.startHandsWhereReady()).toBe(0);
    // Table 1's hand ends: both idle, and table 2 breaks into it.
    playHand(t1, lcg(5), 0);
    expect(t2._broken).toBe(true);
    expect(t1.players.length).toBe(6);
    expect(d.activeTables()).toHaveLength(1);
    expect(d.canStartHand(t1)).toBe(true);
    d.stop();
  });

  test('a table due to give a player up sits out a hand, and the move is made', () => {
    const d = makeDirector(9, { tableSize: 5 });
    d.start();
    const t1 = d.tables.find((t) => t.tableNumber === 1);
    const t2 = d.tables.find((t) => t.tableNumber === 2);
    expect([t1.players.length, t2.players.length]).toEqual([5, 4]);
    t1.startRound();
    bustAt(d, t2, 2); // 5 and 2: seven players, no break, a move due
    expect([t1.players.length, t2.players.length]).toEqual([5, 2]);
    t2.startRound();
    playHand(t1, lcg(), 0);
    expect([t1.players.length, t2.players.length]).toEqual([5, 2]); // table 2 is dealing
    expect(d.canStartHand(t1)).toBe(false);
    expect(d.canStartHand(t2)).toBe(false); // it is dealing
    playHand(t2, lcg(7), 0);
    expect([t1.players.length, t2.players.length]).toEqual([4, 3]);
    expect(d.canStartHand(t1)).toBe(true);
    d.stop();
  });

  test('with nothing dealing, a field that is waiting settles itself from the tick', () => {
    const d = makeDirector(8, { tableSize: 6 });
    d.start();
    const t1 = d.tables.find((t) => t.tableNumber === 1);
    const t2 = d.tables.find((t) => t.tableNumber === 2);
    // Two players leave table 2 between hands without a round end: the state
    // a restart, or a removal, can leave the field in.
    for (const p of t2.players.slice(0, 2)) {
      d._expectedChips -= p.chips;
      p.chips = 0;
      t2.removePlayer(p.id);
    }
    expect([t1.players.length, t2.players.length]).toEqual([4, 2]);
    expect(d._tableDueToBreak()).toBe(t2);
    expect(d._tableDueToGive()).toBe(t1);
    expect(d.tick()).toBe(1);
    expect(t2._broken).toBe(true);
    expect(t1.players.length).toBe(6);
    expect(t1.isRunning).toBe(true);
    d.stop();
  });
});

describe('re-entry and the add-on', () => {
  // Two levels, the first break, a level, a second break, a level.
  const SCHEDULE = [
    { sb: 10, bb: 20, ante: 0, duration: 99999 },
    { sb: 15, bb: 30, ante: 0, duration: 99999 },
    { break: true, duration: 99999 },
    { sb: 20, bb: 40, ante: 40, duration: 99999 },
    { break: true, duration: 99999 },
    { sb: 30, bb: 60, ante: 60, duration: 99999 },
  ];
  const FLAT = [
    { sb: 10, bb: 20, ante: 0, duration: 99999 },
    { sb: 20, bb: 40, ante: 0, duration: 99999 },
  ];

  function levelUp(d, level) {
    d.tournament.currentLevel = level;
    d.tournament.onLevelUp(level, d.tournament.getCurrentBlinds());
  }

  function rng(seed = 777) {
    return () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
  }

  // Busts one player by hand between hands: the stack goes to a neighbour,
  // the ledger records the place, and the round end takes them off the table.
  function bust(d, uid) {
    const { table, player } = d.playerByUid(uid);
    const keeper = table.players.find((p) => p.uid !== uid && p.chips > 0);
    keeper.chips += player.chips;
    player.chips = 0;
    d.tournament.recordElimination(player.name, 1, uid);
    d._handleRoundEnd(table, null);
  }

  test('a re-entry seats the busted player with a fresh stack, strikes the bust-out, and grows the pool', () => {
    const said = [];
    const d = makeDirector(6, { tableSize: 6, reentryLevels: 2, buyIn: 100 });
    d.onMessage = (m) => said.push(m);
    d.start();
    expect(d.reentryOpen()).toBe(true);
    expect(d.prizePool()).toBe(600);
    expect(d.paidPlaces).toBe(2);
    bust(d, 'p5');
    expect(d.playerByUid('p5')).toBeNull();
    expect(d.tournament.eliminations.map((e) => [e.uid, e.place])).toEqual([['p5', 6]]);
    expect(d.fieldSummary('p5')).toMatchObject({ reentryOpen: true, entries: 6, myReentries: 0 });

    const before = d.totalChips();
    const seat = d.reenter({ uid: 'p5', id: 'p5-again' });
    expect(seat.player.chips).toBe(2000);
    expect(seat.player.id).toBe('p5-again');
    expect(d.entrants.find((e) => e.uid === 'p5').id).toBe('p5-again');
    expect(d.totalChips()).toBe(before + 2000);
    expect(() => d.assertChipConservation()).not.toThrow();
    // The same person, not a new entrant: the record is gone, the ladder's
    // depth is unchanged, the pool is up one buy-in.
    expect(d.tournament.eliminations).toEqual([]);
    expect(d.entrants).toHaveLength(6);
    expect(d.tournament.startingPlayers).toBe(6);
    expect(d.paidPlaces).toBe(2);
    expect(d.extraEntries).toBe(1);
    expect(d.prizePool()).toBe(700);
    expect(d.roster().find((r) => r.uid === 'p5')).toMatchObject({
      chips: 2000,
      reentries: 1,
      place: null,
      table: 1,
    });
    expect(d.fieldSummary('p5')).toMatchObject({ entries: 7, myReentries: 1, prizePool: 700 });
    expect(said).toContain('P5 re-enters with 2000 at table 1 · 7 entries, pool 700');
  });

  test('busting again is recorded once more, places stay complete and unique, and the door stays open', () => {
    const d = makeDirector(5, { tableSize: 6, reentryLevels: 3, buyIn: 50 });
    d.start();
    bust(d, 'p4'); // 5th
    bust(d, 'p3'); // 4th
    expect(d.tournament.eliminations.map((e) => [e.uid, e.place])).toEqual([
      ['p4', 5],
      ['p3', 4],
    ]);
    d.reenter({ uid: 'p4' });
    expect(d.tournament.eliminations.map((e) => [e.uid, e.place])).toEqual([['p3', 5]]);
    bust(d, 'p2');
    bust(d, 'p4');
    expect(d.tournament.eliminations.map((e) => [e.uid, e.place])).toEqual([
      ['p3', 5],
      ['p2', 4],
      ['p4', 3],
    ]);
    // Unlimited while the window is open.
    d.reenter({ uid: 'p4' });
    expect(d.extraEntries).toBe(2);
    expect(d.roster().find((r) => r.uid === 'p4')).toMatchObject({ reentries: 2, place: null });
    expect(d.prizePool()).toBe(50 * 7);
    expect(d.tournament.eliminations.map((e) => e.place)).toEqual([5, 4]);
    expect(() => d.assertChipConservation()).not.toThrow();
  });

  test('the winner is right after a re-entry', () => {
    const d = makeDirector(3, { tableSize: 6, reentryLevels: 3 });
    d.start();
    bust(d, 'p2');
    d.reenter({ uid: 'p2' });
    bust(d, 'p0');
    bust(d, 'p1');
    expect(d.finished).toBeTruthy();
    expect(d.finished.winner).toBe('P2');
    // The finish writes the winner's own record after the bust-outs.
    expect(d.tournament.eliminations.slice(0, 2).map((e) => [e.uid, e.place])).toEqual([
      ['p0', 3],
      ['p1', 2],
    ]);
  });

  test('re-entry is refused when closed, for a seated player, and for a stranger; open through the break', () => {
    const d = makeDirector(4, { tableSize: 6, reentryLevels: 2, blindSchedule: SCHEDULE });
    d.start();
    expect(() => d.reenter({ uid: 'p0' })).toThrow(/Still seated/);
    expect(() => d.reenter({ uid: 'nobody' })).toThrow(/Not an entrant/);
    bust(d, 'p3');
    levelUp(d, 1); // level 2
    expect(d.reentryOpen()).toBe(true);
    levelUp(d, 2); // the break after level 2 counts as level 2
    expect(d.reentryOpen()).toBe(true);
    levelUp(d, 3); // level 3: shut
    expect(d.reentryOpen()).toBe(false);
    expect(() => d.reenter({ uid: 'p3' })).toThrow(/closed/);
    expect(d.fieldSummary('p3')).toMatchObject({ reentryOpen: false, reentryLevels: 2 });

    const none = makeDirector(3, { reentryLevels: 0 });
    none.start();
    expect(none.reentryOpen()).toBe(false);
    d.stop();
  });

  test('the add-on at an idle table: one stack, once, during the first break only', () => {
    const said = [];
    const d = makeDirector(4, { tableSize: 6, addOn: true, buyIn: 100, blindSchedule: SCHEDULE });
    d.onMessage = (m) => said.push(m);
    d.start();
    expect(d.addOnOpen()).toBe(false);
    expect(() => d.takeAddOn('p0')).toThrow(/first break only/);
    levelUp(d, 1);
    levelUp(d, 2); // the first break
    expect(d.tournament.onBreak()).toBe(true);
    expect(d.addOnOpen()).toBe(true);
    expect(said).toContain('Break: 99999s · play resumes at 20/40 ante 40 · add-ons open');

    const before = d.totalChips();
    expect(d.takeAddOn('p0')).toEqual({ queued: false, chips: 4000 });
    expect(d.totalChips()).toBe(before + 2000);
    expect(() => d.assertChipConservation()).not.toThrow();
    expect(d.extraEntries).toBe(1);
    expect(d.prizePool()).toBe(500);
    expect(d.hasAddOn('p0')).toBe(true);
    expect(() => d.takeAddOn('p0')).toThrow(/have taken/);
    expect(d.roster().find((r) => r.uid === 'p0')).toMatchObject({ chips: 4000, addOn: true });
    expect(d.fieldSummary('p0')).toMatchObject({ addOnOpen: true, myAddOn: true, entries: 5 });
    expect(d.fieldSummary('p1')).toMatchObject({ addOnOpen: true, myAddOn: false });
    expect(said).toContain('P0 takes the add-on: 2000 more · 5 entries, pool 500');

    // Not seated: nothing to add to.
    bust(d, 'p3');
    expect(() => d.takeAddOn('p3')).toThrow(/not seated/);

    // The second break is not the first.
    levelUp(d, 3);
    expect(d.addOnOpen()).toBe(false);
    levelUp(d, 4);
    expect(d.tournament.onBreak()).toBe(true);
    expect(d.addOnOpen()).toBe(false);
    expect(() => d.takeAddOn('p1')).toThrow(/first break only/);
    expect(said.filter((m) => /add-ons open/.test(m))).toHaveLength(1);
    d.stop();
  });

  test('no add-on without a break in the structure, or when the host did not ask', () => {
    const flat = makeDirector(3, { addOn: true, blindSchedule: FLAT });
    flat.start();
    expect(flat.firstBreakIndex()).toBe(-1);
    levelUp(flat, 1);
    expect(flat.addOnOpen()).toBe(false);
    expect(() => flat.takeAddOn('p0')).toThrow(/first break only/);
    flat.stop();

    const said = [];
    const off = makeDirector(3, { addOn: false, blindSchedule: SCHEDULE });
    off.onMessage = (m) => said.push(m);
    off.start();
    levelUp(off, 1);
    levelUp(off, 2);
    expect(off.tournament.onBreak()).toBe(true);
    expect(off.addOnOpen()).toBe(false);
    expect(() => off.takeAddOn('p0')).toThrow(/first break only/);
    expect(said.some((m) => /add-ons open/.test(m))).toBe(false);
    off.stop();
  });

  test('an add-on asked for mid-hand lands when the hand does', () => {
    const d = makeDirector(4, { tableSize: 6, addOn: true, buyIn: 100, blindSchedule: SCHEDULE });
    d.start();
    const table = d.tables[0];
    levelUp(d, 1);
    expect(d.startHandsWhereReady()).toBe(1);
    levelUp(d, 2); // the break arrives with a hand in play
    expect(table.isRunning).toBe(true);
    expect(d.addOnOpen()).toBe(true);
    const before = d.totalChips();
    expect(d.takeAddOn('p0')).toEqual({ queued: true });
    expect(d.totalChips()).toBe(before);
    expect(d.hasAddOn('p0')).toBe(true);
    expect(d.fieldSummary('p0').myAddOn).toBe(true);
    expect(() => d.takeAddOn('p0')).toThrow(/have taken/);
    expect(d.extraEntries).toBe(0);

    playHand(table, rng(), 0);
    expect(table.isRunning).toBe(false);
    expect(d.totalChips()).toBe(before + 2000);
    expect(() => d.assertChipConservation()).not.toThrow();
    expect(d._pendingAddOns.size).toBe(0);
    expect(d.roster().find((r) => r.uid === 'p0').addOn).toBe(true);
    expect(d.extraEntries).toBe(1);
    expect(d.prizePool()).toBe(500);
    d.stop();
  });

  test('entries, re-entries and add-ons survive a snapshot and a restore', () => {
    const d = makeDirector(4, {
      tableSize: 6,
      reentryLevels: 2,
      addOn: true,
      buyIn: 100,
      blindSchedule: SCHEDULE,
    });
    d.start();
    bust(d, 'p3');
    d.reenter({ uid: 'p3' });
    levelUp(d, 1);
    levelUp(d, 2);
    d.takeAddOn('p0');
    const snap = d.snapshot();
    expect(snap).toMatchObject({
      reentryLevels: 2,
      addOn: true,
      extraEntries: 2,
      reentries: [['p3', 1]],
      addOns: ['p0'],
    });

    const revived = new TournamentDirector({
      id: snap.id,
      tableSize: snap.tableSize,
      startChips: snap.startChips,
      buyIn: 100,
      reentryLevels: 2,
      addOn: true,
      levelDuration: 99999,
      blindSchedule: SCHEDULE,
      gameOptions: { actionTimeoutMs: 0 },
    });
    expect(revived.restoreFrom(snap)).toBe(true);
    expect(revived.extraEntries).toBe(2);
    expect(revived.prizePool()).toBe(600);
    expect(revived.hasAddOn('p0')).toBe(true);
    expect(revived.roster().find((r) => r.uid === 'p3')).toMatchObject({ reentries: 1 });
    expect(revived.totalChips()).toBe(d.totalChips());
    expect(() => revived.assertChipConservation()).not.toThrow();
    d.stop();
    revived.stop();
  });
});

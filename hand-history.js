// hand-history.js - Records complete hand histories for replay and stats
class HandHistory {
  constructor() {
    this.version = 0;
    this.hands = []; // Last 20 completed hands
    this.maxHands = 20;
  }

  static cloneCard(card) {
    return card ? { ...card } : card;
  }

  static cloneHand(hand) {
    if (!hand) return null;
    return {
      ...hand,
      players: (hand.players || []).map((player) => ({ ...player })),
      holeCards: Object.fromEntries(
        Object.entries(hand.holeCards || {}).map(([playerId, cards]) => [
          playerId,
          (cards || []).map((card) => HandHistory.cloneCard(card)),
        ])
      ),
      shownPlayerIds: [...(hand.shownPlayerIds || [])],
      shownCards: Object.fromEntries(
        Object.entries(hand.shownCards || {}).map(([playerId, idx]) => [playerId, [...idx]])
      ),
      communityCards: (hand.communityCards || []).map((card) => HandHistory.cloneCard(card)),
      actions: (hand.actions || []).map((action) => ({ ...action })),
      winners: (hand.winners || []).map((winner) => ({ ...winner })),
    };
  }

  startHand(handNum, players, dealerIdx, sbIdx, bbIdx, blinds) {
    this.current = {
      handNum,
      timestamp: Date.now(),
      players: players.map((p) => ({
        id: p.id,
        // The identity behind the seat. Everything else here is keyed by the
        // socket id the seat had when the hand was dealt, and a reconnect
        // issues a new one; without the uid a player who dropped and came
        // back could no longer be recognised as the owner of their own cards.
        uid: p.uid,
        name: p.name,
        chips: p.chips,
        seatIndex: p.seatIndex,
      })),
      dealerIndex: dealerIdx,
      sbIndex: sbIdx,
      bbIndex: bbIdx,
      smallBlind: blinds.sb,
      bigBlind: blinds.bb,
      ante: blinds.ante || 0,
      holeCards: {}, // playerId → [card, card], every seat, server-side
      shownPlayerIds: [], // who turned anything face up
      // playerId -> which of their two cards were turned over. A showdown
      // records both; a winner showing after an uncontested pot may record
      // one. Everybody in shownPlayerIds has an entry here.
      shownCards: {},
      communityCards: [],
      actions: [], // {phase, playerId, playerName, action, amount, pot}
      winners: [], // {playerId, playerName, amount, handName}
      pot: 0,
    };
    // Every hand in full, for the server's own use. What may leave the server
    // is decided per viewer in getStateForPlayer, not here: cards a player was
    // never made to show are never anyone else's to see.
    for (const p of players) {
      if (p.holeCards && p.holeCards.length === 2) {
        this.current.holeCards[p.id] = p.holeCards.map((card) => HandHistory.cloneCard(card));
      }
    }
  }

  // Called for each hand turned face up. Showing is the only event that makes
  // a holding public, so it is the only thing that unlocks it in the replay: a
  // fold takes the cards to the muck unseen, and they stay unseen afterwards.
  //
  // indices says which of the two were turned over, because a winner who takes
  // a pot uncontested may show one and keep the other. A showdown passes both
  // and reads exactly as it always did.
  recordShown(playerId, indices = [0, 1]) {
    if (!this.current || !playerId) return;
    this._markShown(this.current, playerId, indices);
  }

  // The same, for a hand that has already been filed. A pot taken uncontested
  // is over before its winner decides whether to show: endRound files the hand
  // and drops `current`, and the answer arrives seconds later. Without this
  // the reveal would reach the felt and never the replay.
  recordShownOnLast(playerId, indices = [0, 1]) {
    const last = this.hands[this.hands.length - 1];
    if (!last || !playerId) return false;
    if (!last.holeCards || !last.holeCards[playerId]) return false;
    this._markShown(last, playerId, indices);
    // Readers cache what they build against this number, so a hand amended
    // after it was filed has to say so or nobody refetches it.
    this.version++;
    return true;
  }

  _markShown(hand, playerId, indices) {
    const wanted = (Array.isArray(indices) ? indices : [indices])
      .map((i) => Number(i))
      .filter((i) => i === 0 || i === 1);
    if (!wanted.length) return;
    if (!hand.shownPlayerIds.includes(playerId)) hand.shownPlayerIds.push(playerId);
    if (!hand.shownCards) hand.shownCards = {};
    const had = hand.shownCards[playerId] || [];
    hand.shownCards[playerId] = [...new Set([...had, ...wanted])].sort();
  }

  recordAction(playerId, playerName, phase, action, amount, pot) {
    if (!this.current) return;
    this.current.actions.push({
      phase,
      playerId,
      playerName,
      action,
      amount,
      pot,
      time: Date.now(),
    });
  }

  recordCommunityCards(cards) {
    if (!this.current) return;
    this.current.communityCards = cards.map((c) => ({ ...c }));
  }

  recordWinner(playerId, playerName, amount, handName) {
    if (!this.current) return;
    this.current.winners.push({ playerId, playerName, amount, handName });
  }

  finishHand(finalPot, finalPhase) {
    if (!this.current) return;
    this.current.pot = finalPot;
    this.current.finalPhase = finalPhase || null;
    this.current.endTime = Date.now();
    this.hands.push(this.current);
    if (this.hands.length > this.maxHands) this.hands.shift();
    // Bumped on the only mutation this record has. Readers cache what they
    // build out of it against this number instead of rebuilding per push.
    this.version++;
    const finished = this.current;
    this.current = null;
    return finished;
  }

  getRecentHands(count = 10) {
    return this.hands.slice(-count).map((hand) => HandHistory.cloneHand(hand));
  }

  getHandForReplay(handNum) {
    return HandHistory.cloneHand(this.hands.find((h) => h.handNum === handNum) || null);
  }

  // Generate war report for a finished hand
  static generateWarReport(hand) {
    if (!hand) return null;
    const report = {
      handNum: hand.handNum,
      pot: hand.pot,
      winners: hand.winners,
      playerStats: {},
      highlights: [],
    };

    // Per-player stats for this hand
    for (const p of hand.players) {
      const actions = hand.actions.filter((a) => a.playerId === p.id);
      const raised = actions.filter((a) => a.action === 'raise' || a.action === 'allin');
      const folded = actions.some((a) => a.action === 'fold');
      const maxBet = raised.length > 0 ? Math.max(...raised.map((a) => a.amount || 0)) : 0;

      report.playerStats[p.id] = {
        name: p.name,
        startChips: p.chips,
        actions: actions.length,
        raised: raised.length,
        folded,
        maxBet,
        isWinner: hand.winners.some((w) => w.playerId === p.id),
        winAmount: hand.winners
          .filter((w) => w.playerId === p.id)
          .reduce((s, w) => s + w.amount, 0),
      };
    }

    // Highlights
    if (hand.winners.length > 0) {
      const bigWin = hand.winners.reduce((a, b) => (a.amount > b.amount ? a : b));
      report.highlights.push(
        `🏆 ${bigWin.playerName} wins ${bigWin.amount}` +
          (bigWin.handName ? ` (${bigWin.handName})` : '')
      );
    }

    const allInPlayers = hand.actions.filter((a) => a.action === 'allin');
    if (allInPlayers.length > 0) {
      report.highlights.push(`💥 ${allInPlayers.length}  players all-in`);
    }

    if (hand.pot > hand.bigBlind * 20) {
      report.highlights.push(`💰 Big pot: ${hand.pot}`);
    }

    return report;
  }
}

// Leaderboard stats (cumulative across hands)
class Leaderboard {
  // Keyed by name by default, which is all a single table needs: everybody at
  // it is on screen at once and their names are distinct. A tournament passes
  // uid instead, because that is what a player keeps through a reconnect, a
  // move to another table and a re-entry - and their record has to follow them
  // rather than start again at whichever table they were carried to.
  constructor(options = {}) {
    this.keyBy = typeof options.keyBy === 'function' ? options.keyBy : (p) => p.name;
    this.stats = {}; // key → stats
  }

  update(hand) {
    if (!hand) return;

    for (const p of hand.players) {
      const key = this.keyBy(p);
      if (key === undefined || key === null || key === '') continue;
      if (!this.stats[key]) {
        this.stats[key] = {
          key,
          uid: p.uid || null,
          name: p.name,
          handsPlayed: 0,
          handsWon: 0,
          totalWinnings: 0,
          totalLosses: 0,
          biggestPot: 0,
          allInCount: 0,
          foldCount: 0,
          raiseCount: 0,
          bestHand: null,
          bestHandRank: 0,
        };
      }
      const s = this.stats[key];
      // Whatever they are called now. Keyed by uid a rename is the same
      // player, and the board should say the name they are wearing.
      s.name = p.name;
      s.handsPlayed++;

      const actions = hand.actions.filter((a) => a.playerId === p.id);
      s.raiseCount += actions.filter((a) => a.action === 'raise').length;
      s.allInCount += actions.filter((a) => a.action === 'allin').length;
      if (actions.some((a) => a.action === 'fold')) s.foldCount++;

      const win = hand.winners.find((w) => w.playerId === p.id);
      if (win) {
        s.handsWon++;
        s.totalWinnings += win.amount;
        if (win.amount > s.biggestPot) s.biggestPot = win.amount;
        if (win.handName) s.bestHand = win.handName;
      }
    }
  }

  getRankings() {
    return Object.values(this.stats).sort(
      (a, b) => b.totalWinnings - b.totalLosses - (a.totalWinnings - a.totalLosses)
    );
  }

  getPlayerStats(key) {
    return this.stats[key] || null;
  }

  // For a tournament's snapshot: the whole board, and back again. A field that
  // is restored after a restart keeps what everybody has played rather than
  // starting the record from zero halfway through.
  toJSON() {
    return Object.values(this.stats).map((s) => ({ ...s }));
  }

  load(rows) {
    this.stats = {};
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || row.key === undefined || row.key === null) continue;
      this.stats[row.key] = { ...row };
    }
    return Object.keys(this.stats).length;
  }

  reset() {
    this.stats = {};
  }
}

// ── Who may see what, in one place ──────────────────────────────────────────
//
// This is what stands between a replay and handing every player the folding
// range of everybody else, so it is written once and called from both the
// engine (a viewer at a table) and the director (a whole game, exported). A
// second copy of it would be a second thing to get wrong.

// The seats in a recorded hand that belong to one identity. A reconnect issues
// a new socket id and a move to another table a new seat, so the uid is the
// only handle that holds across a whole game.
function seatIdsForUid(hand, uid) {
  const ids = new Set();
  if (!uid) return ids;
  for (const p of (hand && hand.players) || []) {
    if (p && p.uid === uid) ids.add(p.id);
  }
  return ids;
}

// A recorded hand's cards as the holder of those seats is allowed to see them:
// their own, and whatever was actually turned face up. A seat that folded is
// absent from the result rather than null - there is nothing to say about it.
//
// A showdown turns both cards over; the winner of an uncontested pot may have
// turned one. The card that stayed down comes back as a null, not a gap, so a
// reader draws a back where the felt drew one.
function visibleCardsFor(hand, ownSeatIds) {
  const mine = ownSeatIds instanceof Set ? ownSeatIds : new Set(ownSeatIds || []);
  const shown = new Set((hand && hand.shownPlayerIds) || []);
  const perCard = (hand && hand.shownCards) || {};
  const visible = {};
  for (const [id, cards] of Object.entries((hand && hand.holeCards) || {})) {
    if (mine.has(id)) {
      visible[id] = cards;
    } else if (shown.has(id)) {
      const idx = perCard[id];
      visible[id] = idx ? cards.map((c, i) => (idx.includes(i) ? c : null)) : cards;
    }
  }
  return visible;
}

// One recorded hand as one player is allowed to see it, in the shape the
// export writes and the replay panel draws. Null when that player was not in
// the hand at all.
//
// `row` is the director's stored form - the hand, plus the two things a hand
// does not know about itself: which table dealt it, and the level the clock
// was on. The same function serves the game being played and one read back
// off the disk a month later, so there is no second copy of the rule to get
// wrong.
//
// No uid comes out of it, the asker's own included: `you` names the seats that
// were theirs, and a file that gets pasted into a thread has no business
// carrying anybody's identifier.
function exportRowFor(row, uid) {
  const hand = row && row.hand;
  if (!hand) return null;
  const mine = seatIdsForUid(hand, uid);
  if (!mine.size) return null;
  return {
    handNum: hand.handNum,
    tableNumber: row.tableNumber === undefined ? null : row.tableNumber,
    level: row.level === undefined ? null : row.level,
    at: hand.timestamp || null,
    pot: hand.pot,
    phase: hand.finalPhase,
    winners: hand.winners,
    communityCards: hand.communityCards,
    holeCards: visibleCardsFor(hand, mine),
    actions: hand.actions,
    players: (hand.players || []).map((p) => ({
      id: p.id,
      name: p.name,
      chips: p.chips,
      seatIndex: p.seatIndex,
    })),
    you: [...mine],
    dealerIndex: hand.dealerIndex,
    sbIndex: hand.sbIndex,
    bbIndex: hand.bbIndex,
    smallBlind: hand.smallBlind,
    bigBlind: hand.bigBlind,
    ante: hand.ante || 0,
  };
}

// Oldest first, which is the order they were played. A hand number is its
// table's round count, so a field of three tables deals three hand 7s; the
// time is what orders them and the table number is what tells them apart.
function exportHandsFor(rows, uid) {
  if (!uid || !Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    const record = exportRowFor(row, uid);
    if (record) out.push(record);
  }
  return out.sort(
    (a, b) => (a.at || 0) - (b.at || 0) || (a.tableNumber || 0) - (b.tableNumber || 0)
  );
}

module.exports = {
  HandHistory,
  Leaderboard,
  seatIdsForUid,
  visibleCardsFor,
  exportRowFor,
  exportHandsFor,
};

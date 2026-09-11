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
      shownPlayerIds: [], // who actually turned them face up at showdown
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

  // Called for each hand turned face up at showdown. That is the only event
  // that makes a holding public, so it is the only thing that unlocks it in
  // the replay: a fold takes the cards to the muck unseen, and they stay
  // unseen afterwards.
  recordShown(playerId) {
    if (!this.current || !playerId) return;
    if (!this.current.shownPlayerIds.includes(playerId)) {
      this.current.shownPlayerIds.push(playerId);
    }
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
  constructor() {
    this.stats = {}; // playerName → stats
  }

  update(hand) {
    if (!hand) return;

    for (const p of hand.players) {
      if (!this.stats[p.name]) {
        this.stats[p.name] = {
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
      const s = this.stats[p.name];
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

  getPlayerStats(name) {
    return this.stats[name] || null;
  }

  reset() {
    this.stats = {};
  }
}

module.exports = { HandHistory, Leaderboard };

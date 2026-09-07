// engine.js - Texas Hold'em game engine
const { createDeck, shuffle } = require('./deck');
const { evaluateHand, compareHands, HAND_NAMES } = require('./hand-eval');
const { describeHand, describeBest } = require('./hand-describe');
const random = require('./random');
const { createStructuredLogger } = require('./server/logger');
const { HandHistory, Leaderboard } = require('./hand-history');
const { Tournament } = require('./tournament');

const PHASES = ['waiting', 'preflop', 'flop', 'turn', 'river', 'showdown'];

// ── Configuration Constants ──
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'; // 'debug' | 'info' | 'warn' | 'error'
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const GAMEPLAY_TEXT_LOGS = process.env.GAMEPLAY_TEXT_LOGS === '1';
const envInt = (name, fallback) => {
  const raw = parseInt(process.env[name], 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
};
// Seats per table.
const DEFAULT_MAX_PLAYERS = 10;

// A seat on auto-play pauses this long before it acts, divided by the table's
// speed multiplier. The pause is cosmetic: there is nothing to decide, but the
// client needs a moment to draw the seat as active before the action lands,
// and a table of sit-outs should not cycle hands faster than the felt can
// render them. Tunable without a code change:
//   AUTO_TURN_DELAY_MS=200 docker compose up -d
const AUTO_TURN_DELAY_MS = envInt('AUTO_TURN_DELAY_MS', 600);
const PRACTICE_NEXT_DELAY = 2500; // Delay before next round in practice mode (ms)
const CASH_NEXT_DELAY = 5000; // Delay before next round in cash/tournament (ms)
const PRACTICE_ACTION_TIMEOUT_MS = 18000;
const TOURNAMENT_ACTION_TIMEOUT_MS = 25000;
const CASH_IDLE_TIMEOUT_MS = 90000;
// Request Time: each seat may add TIME_BANK_GRANT_MS to its clock this many
// times per hand.
const TIME_BANK_GRANT_MS = 30000;
const TIME_BANK_PER_HAND = 1;
const structuredEngineLog = createStructuredLogger('engine');

class PokerGame {
  constructor(id, options = {}) {
    this.id = id;
    this.smallBlind = options.smallBlind || 10;
    this.bigBlind = options.bigBlind || 20;
    this.startChips = options.startChips || 1000;
    this.maxPlayers = options.maxPlayers || DEFAULT_MAX_PLAYERS;
    this.timeBankGrantMs = options.timeBankGrantMs || TIME_BANK_GRANT_MS;
    this.players = [];
    this.deck = [];
    this.communityCards = [];
    this.pot = 0;
    this.sidePots = [];
    this.phase = 'waiting';
    this.dealerIndex = 0;
    this.currentPlayerIndex = 0;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.roundBets = {};
    this.lastRaiserIndex = -1;
    this.isRunning = false;
    this.actionTimeout = null;
    this.configuredActionTimeoutMs = options.actionTimeoutMs || 0;
    this.actionTimeoutMs = this.configuredActionTimeoutMs || 0;
    this.onUpdate = null;
    this.onMessage = null;

    // Player behavior tracking
    this.handActionHistory = {};
    this.handActionLog = [];
    this.handStartPlayerCount = 0;
    this.handStartStacks = {};
    this.preflopRaiserId = null;

    // Winner tracking (authoritative, sent to client)
    this.lastRoundWinnerIds = [];
    this.lastRoundRefunds = [];
    this.sbIndex = -1;

    // Logging helpers
    const suitSymbol = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };
    this._card = (c) => `${c.rank}${suitSymbol[c.suit] || c.suit}`;
    this._cards = (arr) => arr.map((c) => this._card(c)).join(' ');
    this._logEvent = (event, data = {}, level = 'info', message = '') => {
      structuredEngineLog({
        level,
        event,
        roomId: this.id,
        message,
        data: {
          phase: this.phase,
          roundCount: this.roundCount,
          pot: this.pot,
          ...data,
        },
      });
    };
    this._log = (msg, level = 'info') => {
      if (LOG_LEVELS[level] === undefined || LOG_LEVELS[level] < LOG_LEVELS[LOG_LEVEL]) return;
      if (!GAMEPLAY_TEXT_LOGS) {
        if (level === 'warn' || level === 'error') {
          this._logEvent('engine_diag', { detail: msg }, level, 'Engine diagnostic');
        }
        return;
      }
      const ts = new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
      const seated = this.players.map((p) => p.name).join(',') || '-';
      console.log(`[${ts}] [room:${this.id}] [players:${seated}] ${msg}`);
    };
    this.bbIndex = -1;

    // Game mode, speed control, pause
    this.gameMode = options.gameMode || 'cash'; // 'cash' | 'tournament' | 'practice'
    this.speedMultiplier = 1; // 1=normal, 2=fast, 3=turbo
    this.isPaused = false;
    this._pausedAutoPending = false; // automated turn pending while paused

    // Hand history & leaderboard
    this.handHistory = new HandHistory();
    this.leaderboard = new Leaderboard();

    // Tournament mode
    this.tournament = null;
    this.roundCount = 0;
    this.gameOver = null;
    this.turnExpiresAt = null;
    this.turnDurationMs = 0;
  }

  // Total chips this table is accountable for. Chips move straight from
  // player.chips into this.pot (see postBlind), so `bet` and `totalBet` are a
  // record of the street and are already counted in the pot -- adding them
  // would double-count. This is the quantity a tournament must hold invariant
  // across every table move.
  totalChips() {
    return this.players.reduce((sum, p) => sum + p.chips, 0) + this.pot;
  }

  addPlayer(playerData) {
    if (this.players.length >= this.maxPlayers) return null;

    // A player moved between tables must arrive with the stack they earned,
    // not a fresh buy-in. Validated strictly rather than coerced: a NaN or a
    // negative here would silently mint or destroy chips, and the field's
    // total is the one number a tournament cannot let drift.
    let chips = this.startChips;
    if (playerData.chips !== undefined && playerData.chips !== null) {
      const requested = playerData.chips;
      if (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 0) {
        this._log(`⚠ refused seat for ${playerData.name}: invalid chips ${playerData.chips}`);
        return null;
      }
      chips = requested;
    }

    const player = {
      id: playerData.id,
      // Stable identity for the life of the seat. `id` is the socket id and is
      // reassigned on reconnect, so it cannot carry authority; `uid` can.
      uid: playerData.uid || random.randomId('u_'),
      name: playerData.name,
      chips,
      holeCards: [],
      bet: 0,
      totalBet: 0,
      folded: false,
      allIn: false,
      avatar: playerData.avatar || null,
      seatIndex: this.players.length,
      isConnected: true,
      isReady: false,
      autoPlay: false,
      wins: 0,
      handsPlayed: 0,
    };
    // An explicit seat is how a tournament places an arriving player in a
    // chosen position (which matters for blind fairness when balancing tables).
    // Absent one, keep the existing behaviour: random draw before the first
    // hand, append thereafter.
    const explicitSeat = Number.isInteger(playerData.seatIndex) ? playerData.seatIndex : null;
    if (explicitSeat !== null) {
      const at = Math.max(0, Math.min(this.players.length, explicitSeat));
      this.players.splice(at, 0, player);
      // Mirror removePlayer: an insert at or before the button shifts it.
      if (this.players.length > 1 && at <= this.dealerIndex) {
        this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
      }
      this.players.forEach((p, i) => (p.seatIndex = i));
    } else if (!this.isRunning && this.roundCount === 0 && this.players.length > 0) {
      const insertAt = random.randomInt(this.players.length + 1);
      this.players.splice(insertAt, 0, player);
      this.players.forEach((p, i) => (p.seatIndex = i));
    } else {
      this.players.push(player);
    }
    this._log(`📥 seated ${player.name} chips:${player.chips}`);
    this._logEvent(
      'player_joined',
      {
        playerId: player.id,
        playerName: this.getPublicName(player),
        seatIndex: player.seatIndex,
        chips: player.chips,
      },
      'info',
      'Player joined room'
    );
    return player;
  }

  removePlayer(playerId) {
    const idx = this.players.findIndex((p) => p.id === playerId);
    if (idx === -1) return;
    const removed = this.players[idx];
    this._log(
      `📤 left ${removed.name} chips:${removed.chips}`
    );
    this.players.splice(idx, 1);
    // Adjust dealerIndex if removed player was before or at dealer position
    if (this.players.length > 0) {
      if (idx < this.dealerIndex) {
        this.dealerIndex--;
      } else if (idx === this.dealerIndex) {
        // Dealer was removed; dealerIndex now points to next player automatically
        // but clamp to valid range
        this.dealerIndex = this.dealerIndex % this.players.length;
      }
      if (this.dealerIndex >= this.players.length) {
        this.dealerIndex = 0;
      }
    } else {
      this.dealerIndex = 0;
    }
    this.players.forEach((p, i) => (p.seatIndex = i));
    this._logEvent(
      'player_left',
      {
        playerId: removed.id,
        playerName: this.getPublicName(removed),
        chips: removed.chips,
      },
      'info',
      'Player left room'
    );
  }

  getActivePlayers() {
    return this.players.filter((p) => !p.folded && p.chips > 0);
  }

  getPlayersInHand() {
    return this.players.filter((p) => !p.folded && (p.chips > 0 || p.allIn));
  }

  isSpectatorPlayer(player) {
    return !!(player && player.folded && (!player.holeCards || player.holeCards.length === 0));
  }

  clearActionTimeout() {
    if (this.actionTimeout) {
      clearTimeout(this.actionTimeout);
      this.actionTimeout = null;
    }
    this.turnExpiresAt = null;
    this.turnDurationMs = 0;
  }

  getHumanActionTimeoutMs() {
    if (this.configuredActionTimeoutMs > 0) return this.configuredActionTimeoutMs;
    if (this.gameMode === 'practice') return PRACTICE_ACTION_TIMEOUT_MS;
    if (this.gameMode === 'tournament') return TOURNAMENT_ACTION_TIMEOUT_MS;
    return CASH_IDLE_TIMEOUT_MS;
  }

  scheduleActionTimeout() {
    this.clearActionTimeout();
    if (!this.isRunning || this.isPaused) return;
    const current = this.players[this.currentPlayerIndex];
    if (
      !current ||
      current.folded ||
      current.allIn ||
      this.isAutomatedPlayer(current)
    ) {
      return;
    }
    this.armActionTimeout(current, this.getHumanActionTimeoutMs());
  }

  // Arm the human action clock for `player`. durationMs is what the client's
  // timer bar measures against; when time is added it grows with the timeout
  // so the bar refills instead of jumping past full.
  armActionTimeout(player, timeoutMs, durationMs = timeoutMs) {
    this.clearActionTimeout();
    this.actionTimeoutMs = timeoutMs;
    this.turnDurationMs = durationMs;
    this.turnExpiresAt = Date.now() + timeoutMs;
    this.actionTimeout = setTimeout(() => {
      if (!this.isRunning || this.isPaused) return;
      const liveCurrent = this.players[this.currentPlayerIndex];
      if (
        !liveCurrent ||
        liveCurrent.id !== player.id ||
        liveCurrent.folded ||
        liveCurrent.allIn ||
        this.isAutomatedPlayer(liveCurrent)
      ) {
        return;
      }
      liveCurrent.autoPlay = true;
      this.emitMessage(`${this.getPublicName(liveCurrent)} timed out and is sitting out`, {
        kind: 'timebank',
      });
      this._log(`⏱ ${this.getPublicName(liveCurrent)} timed out -> sitting out`);
      this.emitUpdate();
      this.processAutoTurn();
    }, timeoutMs);
    if (this.actionTimeout.unref) this.actionTimeout.unref();
  }

  // A player asks for more time on their own turn. The per-hand allowance is
  // the real guard against stalling a table; a spammed request returns false.
  requestTimeExtension(playerId) {
    if (!this.isRunning || this.isPaused) return false;
    const current = this.players[this.currentPlayerIndex];
    if (!current || current.id !== playerId) return false;
    if (current.folded || current.allIn || this.isAutomatedPlayer(current)) {
      return false;
    }
    if (!this.actionTimeout || !this.turnExpiresAt) return false;
    if ((current.timeExtensionsLeft || 0) <= 0) return false;
    current.timeExtensionsLeft -= 1;
    const remaining = Math.max(0, this.turnExpiresAt - Date.now());
    const grant = this.timeBankGrantMs;
    this.armActionTimeout(current, remaining + grant, (this.turnDurationMs || remaining) + grant);
    this.emitMessage(`⏱ ${this.getPublicName(current)} requested time`, { kind: 'timebank' });
    this.emitUpdate();
    return true;
  }

  beginCurrentTurn() {
    const current = this.players[this.currentPlayerIndex];
    if (!current || !this.isRunning) {
      this.clearActionTimeout();
      this.emitUpdate();
      return;
    }
    if (this.isAutomatedPlayer(current)) {
      this.clearActionTimeout();
      this.emitUpdate();
      this.processAutoTurn();
      return;
    }
    this.scheduleActionTimeout();
    this.emitUpdate();
  }

  startRound() {
    const startedAt = Number(process.hrtime.bigint()) / 1e6;
    if (this.players.length < 2) return false;
    this.gameOver = null;
    this.clearActionTimeout();

    if (this.players.filter((p) => p.chips > 0).length < 2) return false;

    this.roundCount++;

    for (const p of this.players) {
      p.timeExtensionsLeft = TIME_BANK_PER_HAND;
    }

    this.deck = shuffle(createDeck());
    this.communityCards = [];
    this.pot = 0;
    this.sidePots = [];
    this.currentBet = 0;
    // Tournament: update blinds from current level
    if (this.tournament && this.tournament.isActive) {
      const blinds = this.tournament.getCurrentBlinds();
      this.smallBlind = blinds.sb;
      this.bigBlind = blinds.bb;
    }
    this.minRaise = this.bigBlind;
    this.roundBets = {};
    this.raiseCount = 0; // Raise cap: max 4 raises per betting round

    // v4: Initialize hand tracking for opponent modeling
    this.handActionHistory = {};
    this.handActionLog = [];
    this.handStartPlayerCount = 0;
    this.handStartStacks = {};
    this.preflopRaiserId = null;
    this.lastRoundWinnerIds = [];
    this.lastRoundRefunds = [];

    // Reset player states
    for (const p of this.players) {
      p.holeCards = [];
      p.bet = 0;
      p.totalBet = 0;
      p.folded = p.chips <= 0;
      p.allIn = false;
      p.lastAction = null;
      p.handsPlayed++;
    }

    // Move dealer
    this.dealerIndex = this.dealerIndex % this.players.length;
    while (this.players[this.dealerIndex].chips <= 0) {
      this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
    }

    // Post blinds — heads-up special rule: dealer posts SB
    const activePlayers = this.players.filter((p) => p.chips > 0);
    this.handStartPlayerCount = activePlayers.length;
    this.handStartStacks = Object.fromEntries(activePlayers.map((player) => [player.id, player.chips]));
    let sbIdx, bbIdx;
    if (activePlayers.length === 2) {
      // Heads-up: dealer IS the small blind
      sbIdx = this.dealerIndex;
      bbIdx = this.getNextActiveIndex(this.dealerIndex);
    } else {
      // 3+ players: standard order
      sbIdx = this.getNextActiveIndex(this.dealerIndex);
      bbIdx = this.getNextActiveIndex(sbIdx);
    }
    this.sbIndex = sbIdx;
    this.bbIndex = bbIdx;
    this.postBlind(sbIdx, this.smallBlind);
    this.postBlind(bbIdx, this.bigBlind);
    this.currentBet = this.bigBlind;

    // Deal hole cards
    for (const p of this.players) {
      if (!p.folded) {
        p.holeCards = [this.deck.pop(), this.deck.pop()];
      }
    }

    this.phase = 'preflop';
    // Heads-up preflop: SB (dealer) acts first
    if (activePlayers.length === 2) {
      this.currentPlayerIndex = sbIdx;
    } else {
      this.currentPlayerIndex = this.getNextActiveIndex(bbIdx);
    }
    this.lastRaiserIndex = bbIdx;
    this.isRunning = true;

    // Start tracking this hand
    const activeIds = this.players.filter((p) => !p.folded).map((p) => p.id);
    for (const id of activeIds) {
      this.handActionHistory[id] = [];
    }

    // Hand history recording
    this.handHistory.startHand(
      this.roundCount,
      this.players.filter((p) => !p.folded),
      this.dealerIndex,
      sbIdx,
      bbIdx,
      { sb: this.smallBlind, bb: this.bigBlind }
    );

    const dealer = this.players[this.dealerIndex];
    const sbPlayer = this.players[sbIdx];
    const bbPlayer = this.players[bbIdx];
    this.emitMessage(
      `🃏 Hand ${this.roundCount} starts! Dealer: ${this.players[this.dealerIndex].name}` +
        ` | blinds ${this.smallBlind}/${this.bigBlind}`,
      { kind: 'handStart', handNum: this.roundCount }
    );
    this.emitMessage(`${this.getPublicName(sbPlayer)} posts small blind ${sbPlayer.bet}`, {
      kind: 'blind',
    });
    this.emitMessage(`${this.getPublicName(bbPlayer)} posts big blind ${bbPlayer.bet}`, {
      kind: 'blind',
    });
    this._logEvent(
      'round_start',
      {
        durationMs: Math.round((Number(process.hrtime.bigint()) / 1e6 - startedAt) * 100) / 100,
        dealer: this.getPublicName(dealer),
        smallBlindPlayer: this.getPublicName(sbPlayer),
        bigBlindPlayer: this.getPublicName(bbPlayer),
        smallBlind: this.smallBlind,
        bigBlind: this.bigBlind,
        playerOrder: this.players.map((player) => ({
          id: player.id,
          name: this.getPublicName(player),
          seatIndex: player.seatIndex,
          chips: player.chips,
        })),
      },
      'info',
      'Round started'
    );

    // Log deal: dealer, blinds, hole cards
    this._log(
      `🎰 D:${dealer.name} SB:${sbPlayer.name}(${this.smallBlind}) BB:${bbPlayer.name}(${this.bigBlind})`
    );
    for (const p of this.players) {
      if (!p.folded && p.holeCards.length === 2) {
        this._log(`🃏 ${p.name}: [hidden]`);
      }
    }

    this.beginCurrentTurn();

    return true;
  }

  postBlind(playerIdx, amount) {
    const player = this.players[playerIdx];
    const actual = Math.min(amount, player.chips);
    player.chips -= actual;
    player.bet = actual;
    player.totalBet = actual;
    this.pot += actual;
    if (player.chips === 0) player.allIn = true;
  }

  getNextActiveIndex(fromIndex) {
    let idx = (fromIndex + 1) % this.players.length;
    let safety = 0;
    while (
      (this.players[idx].folded || this.players[idx].allIn || this.players[idx].chips <= 0) &&
      safety < this.players.length
    ) {
      idx = (idx + 1) % this.players.length;
      safety++;
    }
    // If safety exhausted (all players folded/allIn), return fromIndex+1 clamped
    // This prevents infinite loops and lets advanceAction handle the end-of-round
    if (safety >= this.players.length) {
      return (fromIndex + 1) % this.players.length;
    }
    return idx;
  }

  handleAction(playerId, action, amount = 0) {
    const playerIdx = this.players.findIndex((p) => p.id === playerId);
    if (playerIdx === -1 || playerIdx !== this.currentPlayerIndex) return false;
    const player = this.players[playerIdx];
    if (player.folded || player.allIn) return false;

    const toCall = this.currentBet - player.bet;
    const potBeforeAction = this.pot;
    const currentBetBeforeAction = this.currentBet;
    const playerBetBeforeAction = player.bet;
    const chipsBeforeAction = player.chips;

    // ── FIX: Action Validation ──
    // If all other non-folded players are all-in, you can only call or fold.
    // Raising has no meaning because nobody can respond.
    const othersCanAct = this.players.filter(
      (p) => p.id !== playerId && !p.folded && !p.allIn && p.chips > 0
    );
    if (othersCanAct.length === 0 && (action === 'raise' || action === 'allin')) {
      // Force to call (or fold if they choose)
      action = toCall > 0 ? 'call' : 'check';
    }

    let recordedAmount = 0;

    switch (action) {
      case 'fold':
        player.folded = true;
        this.emitMessage(`${this.getPublicName(player)} folds`, { kind: 'action' });
        recordedAmount = 0;
        break;

      case 'check':
        if (toCall > 0) return false;
        this.emitMessage(`${this.getPublicName(player)} checks`, { kind: 'action' });
        recordedAmount = 0;
        break;

      case 'call':
        if (toCall <= 0) {
          this.emitMessage(`${this.getPublicName(player)} checks`, { kind: 'action' });
          recordedAmount = 0;
          action = 'check';
          break;
        }
        const callAmount = Math.min(toCall, player.chips);
        player.chips -= callAmount;
        player.bet += callAmount;
        player.totalBet += callAmount;
        this.pot += callAmount;
        if (player.chips === 0) player.allIn = true;
        this.emitMessage(`${this.getPublicName(player)} calls ${callAmount}`, { kind: 'action' });
        recordedAmount = callAmount;
        break;

      case 'raise':
        // Enforce raise cap (max 4 raises per betting round)
        if (this.raiseCount >= 4) {
          // Cap reached, convert to call
          const capCall = Math.min(this.currentBet - player.bet, player.chips);
          if (capCall > 0) {
            player.chips -= capCall;
            player.bet += capCall;
            player.totalBet += capCall;
            this.pot += capCall;
            if (player.chips === 0) player.allIn = true;
          }
          this.emitMessage(`${this.getPublicName(player)} calls ${capCall} (raise cap)`, { kind: 'action' });
          recordedAmount = capCall;
          action = 'call';
          break;
        }
        const minRaiseTotal = this.currentBet + this.minRaise;
        const maxReachableTotal = player.bet + player.chips;
        if (maxReachableTotal <= this.currentBet) {
          const forcedCall = Math.min(toCall, player.chips);
          player.chips -= forcedCall;
          player.bet += forcedCall;
          player.totalBet += forcedCall;
          this.pot += forcedCall;
          if (player.chips === 0) player.allIn = true;
          this.emitMessage(`${this.getPublicName(player)} calls ${forcedCall}`, { kind: 'action' });
          recordedAmount = forcedCall;
          action = forcedCall > 0 ? 'call' : 'check';
          break;
        }
        if (maxReachableTotal < minRaiseTotal) {
          const shortAllInAmount = player.chips;
          player.bet += shortAllInAmount;
          player.totalBet += shortAllInAmount;
          this.pot += shortAllInAmount;
          player.chips = 0;
          player.allIn = true;
          if (player.bet > this.currentBet) {
            const raiseIncrement = player.bet - this.currentBet;
            const isFullRaise = raiseIncrement >= this.minRaise;
            this.currentBet = player.bet;
            if (isFullRaise) {
              this.lastRaiserIndex = playerIdx;
              this.minRaise = Math.max(this.bigBlind, raiseIncrement);
            }
          }
          this.emitMessage(`${this.getPublicName(player)} all-in ${shortAllInAmount}!`, { kind: 'action' });
          recordedAmount = player.bet;
          action = 'allin';
          break;
        }
        this.raiseCount++;
        const raiseTotal = Math.max(amount, minRaiseTotal);
        const raiseAmount = Math.min(raiseTotal - player.bet, player.chips);
        player.chips -= raiseAmount;
        player.bet += raiseAmount;
        player.totalBet += raiseAmount;
        this.pot += raiseAmount;
        const prevBet = this.currentBet;
        this.currentBet = player.bet;
        this.minRaise = Math.max(this.bigBlind, player.bet - prevBet);
        this.lastRaiserIndex = playerIdx;
        if (player.chips === 0) {
          player.allIn = true;
          this.emitMessage(`${this.getPublicName(player)} all-in ${raiseAmount}!`, { kind: 'action' });
          recordedAmount = player.bet;
        } else {
          this.emitMessage(`${this.getPublicName(player)} raises to ${player.bet}`, { kind: 'action' });
          recordedAmount = player.bet;
        }
        break;

      case 'allin':
        const allInAmount = player.chips;
        player.bet += allInAmount;
        player.totalBet += allInAmount;
        this.pot += allInAmount;
        player.chips = 0;
        player.allIn = true;
        if (player.bet > this.currentBet) {
          const raiseIncrement = player.bet - this.currentBet;
          const isFullRaise = raiseIncrement >= this.minRaise;
          this.currentBet = player.bet;
          if (isFullRaise) {
            // Full raise: reopen action, all players get to act again
            this.lastRaiserIndex = playerIdx;
            this.minRaise = Math.max(this.bigBlind, raiseIncrement);
          }
          // If NOT a full raise: currentBet updates (so others know the call price)
          // but lastRaiserIndex stays unchanged (doesn't reopen action for
          // players who already acted — they only need to match or fold)
        }
        this.emitMessage(`${this.getPublicName(player)} all-in ${allInAmount}!`, { kind: 'action' });
        recordedAmount = player.bet;
        break;

      default:
        return false;
    }

    this.clearActionTimeout();

    if (this.handActionHistory[playerId]) {
      this.handActionHistory[playerId].push({ phase: this.phase, action, amount: recordedAmount });
    }
    this.handActionLog.push({
      phase: this.phase,
      playerId,
      action,
      amount: recordedAmount,
      contribution: Math.max(0, player.bet - playerBetBeforeAction),
      potBeforeAction,
      potAfterAction: this.pot,
      currentBetBeforeAction,
      currentBetAfterAction: this.currentBet,
      playerBetBeforeAction,
      playerBetAfterAction: player.bet,
      toCallBeforeAction: toCall,
      chipsBeforeAction,
      chipsAfterAction: player.chips,
    });

    {
      const actStr =
        action === 'raise'
          ? `raise ${player.bet}`
          : action === 'allin'
            ? `all_in ${player.bet}`
            : action === 'call'
              ? `call ${recordedAmount}`
              : action;
      this._log(
        `👤 ${player.name}: ${actStr} (chips:${player.chips} invested:${player.totalBet} pot:${this.pot})`
      );
    }
    // Track preflop raiser for c-bet detection
    if (this.phase === 'preflop' && (action === 'raise' || action === 'allin')) {
      this.preflopRaiserId = playerId;
    }

    // Hand history recording
    const p = this.players.find((pp) => pp.id === playerId);
    if (p) p.lastAction = { action, amount: recordedAmount, time: Date.now() };
    this.handHistory.recordAction(
      playerId,
      p ? this.getPublicName(p) : '?',
      this.phase,
      action,
      recordedAmount,
      this.pot
    );
    this._logEvent(
      'player_action',
      {
        playerId,
        playerName: p ? this.getPublicName(p) : playerId,
        action,
        amount: recordedAmount,
        currentBet: this.currentBet,
        playerBet: p ? p.bet : 0,
        playerChips: p ? p.chips : 0,
        toCallAfterAction: p ? Math.max(0, this.currentBet - p.bet) : 0,
      },
      'info',
      'Player action applied'
    );

    // v7: Track recent actions for self-image awareness (keep last 30)
    if (p) {
      if (!p._recentActions) p._recentActions = [];
      p._recentActions.push({ action, phase: this.phase });
      if (p._recentActions.length > 30) p._recentActions.shift();
    }

    this.advanceAction();
    return true;
  }

  advanceAction() {
    // Check if only one player left
    const activePlayers = this.getPlayersInHand();
    if (activePlayers.filter((p) => !p.folded).length === 1) {
      this.awardPot(activePlayers.filter((p) => !p.folded));
      this.endRound();
      return;
    }

    // Find next player who can act
    let nextIdx = (this.currentPlayerIndex + 1) % this.players.length;
    let safety = 0;
    while (safety < this.players.length) {
      const p = this.players[nextIdx];
      if (!p.folded && !p.allIn && p.chips > 0) {
        // Check if betting round is complete
        if (nextIdx === this.lastRaiserIndex) {
          // Edge case: a short all-in after us raised currentBet
          // but didn't reopen action. We still need to match or fold.
          if (p.bet < this.currentBet) {
            break; // Let this player act (fold/call to match)
          }
          this.nextPhase();
          return;
        }
        break;
      }
      nextIdx = (nextIdx + 1) % this.players.length;
      safety++;

      if (nextIdx === this.lastRaiserIndex) {
        // Check if this player still needs to act
        const lp = this.players[nextIdx];
        if (lp.folded || lp.allIn) {
          this.nextPhase();
          return;
        }
        // If their bet < currentBet (short all-in raised the price), they must act
        if (lp.bet >= this.currentBet) {
          this.nextPhase();
          return;
        }
        break;
      }
    }

    // If all remaining players are all-in or folded
    const canAct = this.players.filter((p) => !p.folded && !p.allIn && p.chips > 0);
    if (canAct.length === 0) {
      // Deal remaining community cards
      this.dealRemainingCards();
      return;
    }

    if (canAct.length === 1 && canAct[0].bet >= this.currentBet) {
      // Preflop live blind: BB gets option to raise even if everyone limped/folded
      const isBBLiveBlind =
        this.phase === 'preflop' && canAct[0].seatIndex === this.bbIndex && !canAct[0].lastAction; // BB hasn't acted yet this hand
      if (isBBLiveBlind) {
        this.currentPlayerIndex = canAct[0].seatIndex;
        this.emitUpdate();
        this.processAutoTurn();
        return;
      }
      this.nextPhase();
      return;
    }

    this.currentPlayerIndex = nextIdx;
    this.beginCurrentTurn();
  }

  dealRemainingCards() {
    while (this.communityCards.length < 5) {
      this.deck.pop(); // burn
      this.communityCards.push(this.deck.pop());
    }
    this.phase = 'showdown';
    this.showdown();
  }

  nextPhase() {
    const phaseIdx = PHASES.indexOf(this.phase);
    if (phaseIdx >= 4) {
      this.phase = 'showdown';
      this.showdown();
      return;
    }

    // Reset bets for new betting round
    for (const p of this.players) {
      p.bet = 0;
    }
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.raiseCount = 0;

    switch (PHASES[phaseIdx + 1]) {
      case 'flop':
        this.deck.pop(); // burn
        this.communityCards.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
        this.phase = 'flop';
        this.emitMessage(`── Flop ── ${this._cards(this.communityCards)}`, {
          kind: 'street',
          street: 'flop',
        });
        this._log(`🂠 flop: ${this._cards(this.communityCards)} (pot:${this.pot})`);
        this._logEvent(
          'street_advance',
          { street: 'flop', communityCards: this.communityCards.map((card) => this._card(card)) },
          'info',
          'Street advanced to flop'
        );
        break;
      case 'turn':
        this.deck.pop();
        this.communityCards.push(this.deck.pop());
        this.phase = 'turn';
        this.emitMessage(`── Turn ── ${this._card(this.communityCards[3])}`, {
          kind: 'street',
          street: 'turn',
        });
        this._log(
          `🂠 turn: ${this._card(this.communityCards[3])} → ${this._cards(this.communityCards)} (pot:${this.pot})`
        );
        this._logEvent(
          'street_advance',
          { street: 'turn', communityCards: this.communityCards.map((card) => this._card(card)) },
          'info',
          'Street advanced to turn'
        );
        break;
      case 'river':
        this.deck.pop();
        this.communityCards.push(this.deck.pop());
        this.phase = 'river';
        this.emitMessage(`── River ── ${this._card(this.communityCards[4])}`, {
          kind: 'street',
          street: 'river',
        });
        this._log(
          `🂠 river: ${this._card(this.communityCards[4])} → ${this._cards(this.communityCards)} (pot:${this.pot})`
        );
        this._logEvent(
          'street_advance',
          { street: 'river', communityCards: this.communityCards.map((card) => this._card(card)) },
          'info',
          'Street advanced to river'
        );
        break;
    }

    // Record community cards for replay
    this.handHistory.recordCommunityCards(this.communityCards);

    // First to act is after dealer
    this.currentPlayerIndex = this.getNextActiveIndex(this.dealerIndex);
    this.lastRaiserIndex = this.currentPlayerIndex;

    // Check if only all-in players remain
    const canAct = this.players.filter((p) => !p.folded && !p.allIn && p.chips > 0);
    if (canAct.length <= 1) {
      if (this.communityCards.length < 5) {
        this.dealRemainingCards();
        return;
      }
      this.phase = 'showdown';
      this.showdown();
      return;
    }

    this.beginCurrentTurn();
  }

  showdown() {
    this.phase = 'showdown';
    const contenders = this.players.filter((p) => !p.folded);

    if (contenders.length === 1) {
      this.awardPot(contenders);
      this.endRound();
      return;
    }

    // Evaluate hands
    const results = contenders.map((p) => {
      const allCards = [...p.holeCards, ...this.communityCards];
      const hand = evaluateHand(allCards);
      return { player: p, hand };
    });

    // Sort by hand strength
    results.sort((a, b) => compareHands(b.hand, a.hand));

    // Announce hands
    for (const r of results) {
      this.emitMessage(
        `${this.getPublicName(r.player)} shows ${this._cards(r.player.holeCards)} · ${describeBest(r.hand)}`,
        { kind: 'show' }
      );
    }

    // Handle side pots and main pot
    this.distributePot(results);

    this.endRound();
  }

  distributePot(results) {
    // ── Proper side pot distribution ──
    // 1. Collect all unique totalBet levels from contenders (non-folded)
    // 2. For each level, calculate the pot slice and award to best hand
    // 3. Excess chips (uncontested) get refunded

    const contenders = results.map((r) => r.player);
    const allPlayers = this.players; // includes folded players who contributed

    // Get unique bet levels sorted ascending
    const betLevels = [...new Set(contenders.map((p) => p.totalBet))].sort((a, b) => a - b);

    let previousLevel = 0;
    let totalAwarded = 0;

    for (const level of betLevels) {
      // Calculate this pot slice: each player contributes (level - previousLevel) capped by their totalBet
      let potSlice = 0;
      for (const p of allPlayers) {
        const contribution = Math.min(p.totalBet, level) - Math.min(p.totalBet, previousLevel);
        potSlice += Math.max(0, contribution);
      }

      if (potSlice <= 0) {
        previousLevel = level;
        continue;
      }

      // Who is eligible for this pot slice? Contenders whose totalBet >= level
      const eligible = results.filter((r) => r.player.totalBet >= level);
      if (eligible.length === 0) {
        previousLevel = level;
        continue;
      }

      // Find the best hand(s) among eligible
      eligible.sort((a, b) => compareHands(b.hand, a.hand));
      const bestHand = eligible[0].hand;
      const winners = eligible.filter((r) => compareHands(r.hand, bestHand) === 0);

      // Split pot slice among winners
      const share = Math.floor(potSlice / winners.length);
      let remainder = potSlice - share * winners.length;

      for (const winner of winners) {
        const award = share + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder--;
        winner.player.chips += award;
        totalAwarded += award;
        if (!winner._awarded) winner._awarded = 0;
        winner._awarded += award;
        // Track: did this player win a CONTESTED pot (2+ eligible players)?
        // If so, they're a real winner. If they only got money from a level
        // where they were the sole eligible player, it's a refund.
        if (eligible.length >= 2) {
          winner._wonContestedPot = true;
        }
      }

      previousLevel = level;
    }

    // Emit winner messages
    const awardedPlayers = results.filter((r) => r._awarded && r._awarded > 0);
    const isSplitPot =
      awardedPlayers.length > 1 &&
      awardedPlayers.filter((r) => r._wonContestedPot).length > 1 &&
      awardedPlayers
        .filter((r) => r._wonContestedPot)
        .every(
          (r) =>
            compareHands(r.hand, awardedPlayers.filter((x) => x._wonContestedPot)[0].hand) === 0
        );

    for (const r of results) {
      if (r._awarded && r._awarded > 0) {
        if (r._wonContestedPot) {
          // This player won a pot slice where they beat at least one other player
          r.player.wins++;
          this.lastRoundWinnerIds.push(r.player.id);
          if (isSplitPot) {
            this.emitMessage(
              `🤝 ${this.getPublicName(r.player)} splits pot ${r._awarded} (${r.hand.name})`,
              { kind: 'win', handNum: this.roundCount, amount: r._awarded, handName: r.hand.name }
            );
          } else {
            this.emitMessage(
              `🏆 ${this.getPublicName(r.player)} wins ${r._awarded}! (${r.hand.name})`,
              { kind: 'win', handNum: this.roundCount, amount: r._awarded, handName: r.hand.name }
            );
          }
          this._log(
            `💰 ${this.getPublicName(r.player)} wins ${r._awarded} (${r.hand.name}) bal:${r.player.chips}`
          );
          this.handHistory.recordWinner(
            r.player.id,
            this.getPublicName(r.player),
            r._awarded,
            r.hand.name
          );
        } else {
          // Only got money from uncontested levels — refund
          this.lastRoundRefunds.push({
            playerId: r.player.id,
            playerName: this.getPublicName(r.player),
            amount: r._awarded,
            reason: 'unmatched all-in chips',
          });
          this.emitMessage(
            `↩ ${this.getPublicName(r.player)} unmatched chips returned ${r._awarded}`,
            { kind: 'refund' }
          );
          this._log(`💰 ${this.getPublicName(r.player)} refund ${r._awarded} bal:${r.player.chips}`);
        }
      }
    }

    // Safety check: if any chips were unaccounted for due to rounding,
    // refund to the player with the highest totalBet (ONLY if betLevels didn't already handle it)
    const totalPot = this.pot;
    const unawarded = totalPot - totalAwarded;
    if (unawarded > 0) {
      // Check if any contender already received a refund at their betLevel
      // (sole eligible at top level = already refunded via betLevels loop)
      const topLevel = betLevels[betLevels.length - 1];
      const topEligible = results.filter((r) => r.player.totalBet >= topLevel);
      const alreadyRefunded = topEligible.length === 1 && topEligible[0]._awarded > 0;
      if (!alreadyRefunded) {
        const maxBettor = contenders.reduce((a, b) => (a.totalBet > b.totalBet ? a : b));
        maxBettor.chips += unawarded;
        totalAwarded += unawarded;
        this.lastRoundRefunds.push({
          playerId: maxBettor.id,
          playerName: this.getPublicName(maxBettor),
          amount: unawarded,
          reason: 'unmatched all-in chips',
        });
        this.emitMessage(
          `↩ ${this.getPublicName(maxBettor)} unmatched chips returned ${unawarded}`,
          { kind: 'refund' }
        );
      }
    }
  }

  awardPot(winners) {
    const share = Math.floor(this.pot / winners.length);
    for (const winner of winners) {
      winner.chips += share;
      winner.wins++;
      this.lastRoundWinnerIds.push(winner.id);
      this.emitMessage(`🏆 ${this.getPublicName(winner)} wins ${share}!`, {
        kind: 'win',
        handNum: this.roundCount,
        amount: share,
      });
      this._log(`💰 ${this.getPublicName(winner)} wins ${share} (all folded) bal:${winner.chips}`);
      this.handHistory.recordWinner(
        winner.id,
        this.getPublicName(winner),
        share,
        'all opponents folded'
      );
    }
  }

  endRound() {
    this.isRunning = false;
    this.clearActionTimeout();
    this.dealerIndex = (this.dealerIndex + 1) % this.players.length;

    // Finish hand history and update leaderboard
    this.handHistory.recordCommunityCards(this.communityCards);
    const finishedHand = this.handHistory.finishHand(this.pot, this.phase);
    if (finishedHand) {
      this.leaderboard.update(finishedHand);
      this.lastWarReport = HandHistory.generateWarReport(finishedHand);
    }

    // Handle busted players
    // When several players bust on the same hand, the one who STARTED the hand
    // with more chips finishes higher. Recording them in seat order instead
    // hands out places by where someone happened to sit, which decides real
    // money on the bubble. handStartStacks is snapshotted in startRound.
    // Eliminations are recorded worst place first, so sort ascending by the
    // stack they brought into the hand.
    const bustedPlayers = this.players
      .filter((p) => p.chips <= 0)
      .sort((a, b) => {
        const sa = this.handStartStacks[a.id] ?? 0;
        const sb = this.handStartStacks[b.id] ?? 0;
        return sa - sb;
      });
    for (const p of bustedPlayers) {
      this.emitMessage(`${this.getPublicName(p)} eliminated`, { kind: 'eliminate' });
      this._log(`❌ eliminated ${this.getPublicName(p)}`);
      if (this.tournament && this.tournament.isActive) {
        const place = this.tournament.recordElimination(
          this.getPublicName(p),
          this.roundCount,
          p.uid
        );
        this.emitMessage(`📊 ${this.getPublicName(p)} placed #${place}`, { kind: 'eliminate' });
      }
    }

    // v9: print chip standings after each round
    const standings = this.players
      .filter((p) => p.chips > 0)
      .sort((a, b) => b.chips - a.chips)
      .map((p) => `${p.name}:${p.chips}`)
      .join(' | ');
    this._log(`📊 Hand ${this.roundCount} end pot:${this.pot} standings: ${standings}`);

    // The pot has been paid out to the winners' stacks by this point, so it is
    // no longer money in flight. It used to stay populated until the next
    // startRound, which meant anything summing stacks + pot between hands
    // double-counted the award. A tournament checks chip conservation at
    // exactly that moment, so clear it once the hand record and the log above
    // have taken their copies.
    this.pot = 0;

    // Tournament: check if tournament is over
    let tournamentResult = null;
    if (this.tournament && this.tournament.isActive) {
      tournamentResult = this.tournament.checkTournamentEnd(this.players);
      if (tournamentResult) {
        this.emitMessage('🏆 Tournament over!', { kind: 'system' });
      }
      this.gameOver = null;
    } else {
      const survivors = this.players.filter((p) => p.chips > 0);
      if (survivors.length < 2) {
        const winner = survivors[0] || null;
        this.gameOver = {
          reason: 'last-player-standing',
          winnerId: winner ? winner.id : null,
          winnerName: winner ? this.getPublicName(winner) : null,
          remainingPlayers: survivors.length,
        };
        if (winner) {
          this.emitMessage(`🏁 ${this.getPublicName(winner)} wins the table`, { kind: 'system' });
        } else {
          this.emitMessage('🏁 Table finished', { kind: 'system' });
        }
      } else {
        this.gameOver = null;
      }
    }

    this._logEvent(
      'round_end',
      {
        finalPhase: this.phase,
        communityCards: this.communityCards.map((card) => this._card(card)),
        winners: this.lastRoundWinnerIds.map((winnerId) => {
          const player = this.players.find((entry) => entry.id === winnerId);
          return {
            id: winnerId,
            name: player ? this.getPublicName(player) : winnerId,
            chips: player ? player.chips : null,
          };
        }),
        refunds: this.lastRoundRefunds,
        players: this.players.map((player) => ({
          id: player.id,
          name: this.getPublicName(player),
          chips: player.chips,
          folded: player.folded,
          allIn: player.allIn,
        })),
        gameOver: this.gameOver,
        tournamentActive: !!(this.tournament && this.tournament.isActive),
      },
      'info',
      'Round ended'
    );

    this.emitUpdate();

    // Auto-advance: notify server to schedule next round
    if (this.onRoundEnd) this.onRoundEnd(this, tournamentResult);
  }

  // Stop the engine and cancel any pending automated turn.
  stop() {
    this.isRunning = false;
    this.clearActionTimeout();
    if (this._autoTurnTimer) {
      clearTimeout(this._autoTurnTimer);
      this._autoTurnTimer = null;
    }
    this._log('🛑 Game engine stopped');
  }

  // Pause / Resume
  pause() {
    if (this.isPaused) return;
    this.isPaused = true;
    this.clearActionTimeout();
    if (this._autoTurnTimer) {
      clearTimeout(this._autoTurnTimer);
      this._autoTurnTimer = null;
      this._pausedAutoPending = true;
    }
    this._log('⏸ Game paused');
    this.emitUpdate();
  }

  resume() {
    if (!this.isPaused) return;
    this.isPaused = false;
    this._log('▶ Game resumed');
    if (this._pausedAutoPending) this._pausedAutoPending = false;
    if (this.isRunning) this.beginCurrentTurn();
    else this.emitUpdate();
  }

  // Speed control
  setSpeed(multiplier) {
    this.speedMultiplier = Math.max(1, Math.min(3, multiplier));
    this._log(`⚡ Speed set to ${this.speedMultiplier}x`);
  }

  isAutomatedPlayer(player) {
    return !!(player && player.autoPlay);
  }

  getPublicName(player) {
    if (!player) return '';
    return player.name;
  }

  // A seat on auto-play takes the passive line: check when it is free, fold to
  // a bet. This is a sit-out, not a strategy. A seat only reaches it because
  // its player disconnected, left the table, or ran out their clock, and a
  // sit-out must never put chips in on somebody's behalf.
  processAutoTurn() {
    const current = this.players[this.currentPlayerIndex];
    if (!current || !this.isAutomatedPlayer(current) || current.folded || current.allIn) return;

    // Paused: mark the automated turn as pending and pick it up on resume.
    if (this.isPaused) {
      this._pausedAutoPending = true;
      return;
    }

    // Math.max(1) matters: a chain of zero-delay timeouts is a hot loop.
    const delay = Math.max(1, Math.round(AUTO_TURN_DELAY_MS / (this.speedMultiplier || 1)));

    if (this._autoTurnTimer) {
      clearTimeout(this._autoTurnTimer);
      this._autoTurnTimer = null;
    }
    this.turnDurationMs = delay;
    this.turnExpiresAt = Date.now() + delay;
    this.emitUpdate();

    this._autoTurnTimer = setTimeout(() => {
      this._autoTurnTimer = null;
      if (!this.isRunning) return;
      // The turn may have moved while the timer was pending: someone acted, the
      // hand ended, the seat was moved between tables, or the player took back
      // control. Identity is re-checked here rather than captured.
      const live = this.players[this.currentPlayerIndex];
      if (!live || live.id !== current.id || !this.isAutomatedPlayer(live)) return;
      if (live.folded || live.allIn) return;
      if (this.isPaused) {
        this._pausedAutoPending = true;
        return;
      }
      const canCheck = this.currentBet <= live.bet;
      live.lastAction = { action: canCheck ? 'check' : 'fold', amount: 0, time: Date.now() };
      this.handleAction(live.id, canCheck ? 'check' : 'fold');
    }, delay);
    if (this._autoTurnTimer.unref) this._autoTurnTimer.unref();
  }

  getStateForPlayer(playerId) {
    const viewer = this.players.find((p) => p.id === playerId);
    const hostPlayer = this.hostPlayerId
      ? this.players.find((p) => p.uid === this.hostPlayerId)
      : null;
    return {
      id: this.id,
      phase: this.phase,
      pot: this.pot,
      communityCards: this.communityCards,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      dealerIndex: this.dealerIndex,
      sbIndex: this.sbIndex,
      bbIndex: this.bbIndex,
      currentPlayerIndex: this.currentPlayerIndex,
      roundCount: this.roundCount,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      maxPlayers: this.maxPlayers,
      hostName: hostPlayer ? hostPlayer.name : null,
      hostId: this.hostPlayerId || null,
      isHost: !!(viewer && viewer.uid && viewer.uid === this.hostPlayerId),
      players: this.players.map((p) => ({
        id: p.id,
        uid: p.uid,
        name: p.name,
        chips: p.chips,
        bet: p.bet,
        totalBet: p.totalBet,
        folded: p.folded,
        allIn: p.allIn,
        seatIndex: p.seatIndex,
        isConnected: p.isConnected,
        isReady: !!p.isReady,
        autoPlay: !!p.autoPlay,
        isSpectator: this.isSpectatorPlayer(p),
        avatar: p.avatar || null,
        lastAction: p.lastAction || null,
        wins: p.wins,
        handsPlayed: p.handsPlayed,
        // Only show hole cards to the player themselves, or during showdown
        holeCards:
          p.id === playerId || (this.phase === 'showdown' && !p.folded) ? p.holeCards : null,
      })),
      isMyTurn: viewer && this.currentPlayerIndex === viewer.seatIndex && this.isRunning,
      canCheck: viewer && this.currentBet === (viewer.bet || 0),
      canRaise: viewer
        ? this.players.some((p) => p.id !== playerId && !p.folded && !p.allIn && p.chips > 0)
        : false,
      toCall: viewer ? this.currentBet - (viewer.bet || 0) : 0,
      isRunning: this.isRunning,
      lastRoundWinnerIds: this.lastRoundWinnerIds,
      lastRoundRefunds: this.lastRoundRefunds,
      // War report & leaderboard
      warReport: this.lastWarReport || null,
      leaderboard: this.leaderboard.getRankings(),
      recentHands: this.handHistory.getRecentHands(10).map((h) => ({
        handNum: h.handNum,
        pot: h.pot,
        phase: h.finalPhase,
        winners: h.winners,
        communityCards: h.communityCards,
        holeCards: h.holeCards,
        actions: h.actions,
        players: h.players,
        dealerIndex: h.dealerIndex,
        sbIndex: h.sbIndex,
        bbIndex: h.bbIndex,
        smallBlind: h.smallBlind,
        bigBlind: h.bigBlind,
      })),
      // Tournament
      tournament: this.tournament ? this.tournament.getState() : null,
      gameOver: this.gameOver,
      viewerIsSpectator: this.isSpectatorPlayer(viewer),
      turnExpiresAt: this.turnExpiresAt,
      turnDurationMs: this.turnDurationMs,
      // The viewer's own hand in words, never anyone else's.
      myHand:
        viewer &&
        !viewer.folded &&
        Array.isArray(viewer.holeCards) &&
        viewer.holeCards.length === 2 &&
        (this.isRunning || this.phase === 'showdown')
          ? describeHand(viewer.holeCards, this.communityCards)
          : null,
      timeBank: viewer
        ? { extensionsLeft: viewer.timeExtensionsLeft || 0, grantMs: this.timeBankGrantMs }
        : null,
      // v11
      gameMode: this.gameMode,
      isPaused: this.isPaused,
      speedMultiplier: this.speedMultiplier,
    };
  }

  emitUpdate() {
    if (this.onUpdate) this.onUpdate(this);
  }

  // meta, when given, tags the line for the client's log ({ kind, ... }).
  // Every existing string is unchanged: the client picks sounds and the
  // result modal off substrings of these messages.
  emitMessage(msg, meta) {
    if (this.onMessage) this.onMessage(msg, meta);
  }
}

// AUTO_TURN_DELAY_MS is exported so tests can advance fake timers past the
// real configured delay instead of hardcoding a literal that silently breaks
// the next time the pacing is retuned.
module.exports = {
  PokerGame,
  DEFAULT_MAX_PLAYERS,
  AUTO_TURN_DELAY_MS,
  TIME_BANK_GRANT_MS,
  TIME_BANK_PER_HAND,
};

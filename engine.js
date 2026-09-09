// engine.js - Texas Hold'em game engine
const { createDeck, shuffle } = require('./deck');
const { evaluateHand, compareHands } = require('./hand-eval');
const { describeHand, describeBest } = require('./hand-describe');
const random = require('./random');
const { createStructuredLogger } = require('./server/logger');
const { HandHistory, Leaderboard } = require('./hand-history');

const PHASES = ['waiting', 'preflop', 'flop', 'turn', 'river', 'showdown'];

// ── Configuration Constants ──
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'; // 'debug' | 'info' | 'warn' | 'error'
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const GAMEPLAY_TEXT_LOGS = process.env.GAMEPLAY_TEXT_LOGS === '1';
const envInt = (name, fallback) => {
  const raw = parseInt(process.env[name], 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
};
// Seats per table. Eight is the shape the felt is laid out for: two seats
// across the top, two a side and two along the bottom, with the top and bottom
// centre lanes left clear for the level banner and the action bar.
const DEFAULT_MAX_PLAYERS = 8;

// A seat on auto-play pauses this long before it acts, divided by the table's
// speed multiplier. The pause is cosmetic: there is nothing to decide, but the
// client needs a moment to draw the seat as active before the action lands,
// and a table of sit-outs should not cycle hands faster than the felt can
// render them. Tunable without a code change:
//   AUTO_TURN_DELAY_MS=200 docker compose up -d
const AUTO_TURN_DELAY_MS = envInt('AUTO_TURN_DELAY_MS', 600);
const PRACTICE_ACTION_TIMEOUT_MS = 18000;
const TOURNAMENT_ACTION_TIMEOUT_MS = 25000;
const CASH_IDLE_TIMEOUT_MS = 90000;
// Request Time: each seat may add TIME_BANK_GRANT_MS to its clock this many
// times per hand.
const TIME_BANK_GRANT_MS = 30000;
// How many turns in a row a seat may let go before it is sat out.
const TIMEOUT_STRIKES_BEFORE_SITOUT = 2;
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

    // Hand-shape tracking, used by the chip-conservation assertions.
    this.handStartPlayerCount = 0;
    this.handStartStacks = {};

    // Winner tracking (authoritative, sent to client)
    this.lastRoundWinnerIds = [];
    this.lastRoundRefunds = [];
    // The five cards that made the winning hand at the last showdown, as
    // `${rank}${suit}` keys. Empty for a hand won by everyone folding: there
    // is no evaluated hand there and nothing is face up to mark.
    this.showdownWinningCards = [];
    // Set once the betting can produce nothing further and the board is only
    // being run out. Distinct from the showdown phase, which is the end of the
    // hand: this is the stretch before it, with cards still to come.
    this.cardsExposed = false;
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
    // A held beat between the end of a betting round and the next street, so
    // the chips can be seen going in and the cards can be seen turning over.
    // Zero keeps the hand loop synchronous, which is what the engine tests
    // and the director's own hand driver expect; the server sets a real one.
    this.streetPauseMs = Math.max(0, options.streetPauseMs || 0);
    this._streetTimer = null;
    // Shared by the sit-out driver and the pre-action driver: only one seat is
    // ever current, so only one of them can be pending. stop() and pause()
    // clear it, which is what makes both paths safe to tear down.
    this._autoTurnTimer = null;

    // The last ten hands as each viewer is allowed to see them, held against
    // the history's version. It is 88% of a state payload and changes only
    // when a hand ends, so building it per push meant rebuilding the same
    // thing for every player on every single action.
    this._historyCache = new Map();
    this._historyCacheVersion = -1;

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
      // A seat played by the server for testing. Unlike autoPlay, which is a
      // human stepping away and must never put chips in on their behalf, a bot
      // is meant to play - badly, but genuinely.
      isBot: !!playerData.isBot,
      autoPlay: false,
      // Consecutive turns let go on the clock. One is a moment of inattention
      // and costs only that hand; two in a row is somebody who has walked away.
      // Any action they take themselves puts it back to nought.
      timeoutStrikes: 0,
      // Why this seat is sitting out: 'requested' when the player asked for
      // it, 'timeout' | 'disconnect' | 'left' when it was decided for them.
      // Only the first survives their return: see bind() in the registry.
      sitOutReason: null,
      // The line this seat has armed for a turn that has not opened yet:
      // { kind, atBet, atToCall } or null. Viewer-private — an opponent must
      // never learn it — and scoped to one street, since the price it was armed
      // against does not survive one.
      preAction: null,
      // Asked to sit out, but not until the hand in progress is over. startRound
      // consumes it; unlike setAutoPlay it never touches the current hand.
      sitOutNextHand: false,
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
    this._log(`📤 left ${removed.name} chips:${removed.chips}`);
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
    if (!current || current.folded || current.allIn || this.isAutomatedPlayer(current)) {
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
      liveCurrent.timeoutStrikes = (liveCurrent.timeoutStrikes || 0) + 1;
      const name = this.getPublicName(liveCurrent);

      // First one is forgiven. Losing a hand to a moment of inattention is a
      // fair price; losing the rest of the tournament to it is not, and a
      // player who comes back to find themselves sitting out has to notice
      // that before they can undo it.
      if (liveCurrent.timeoutStrikes < TIMEOUT_STRIKES_BEFORE_SITOUT) {
        const free = this.currentBet - liveCurrent.bet <= 0;
        this.emitMessage(`${name} ran out of time and ${free ? 'checks' : 'folds'}`, {
          kind: 'timebank',
        });
        this._log(`⏱ ${name} timed out -> ${free ? 'check' : 'fold'} (strike 1)`);
        // Flagged so the action below is not mistaken for the player acting,
        // which would clear the very strike it is being given.
        this._actingForTimeout = true;
        try {
          this.handleAction(liveCurrent.id, free ? 'check' : 'fold');
        } finally {
          this._actingForTimeout = false;
        }
        return;
      }

      liveCurrent.autoPlay = true;
      liveCurrent.sitOutReason = 'timeout';
      this.emitMessage(`${name} timed out twice and is sitting out`, {
        kind: 'timebank',
      });
      this._log(`⏱ ${name} timed out twice -> sitting out`);
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
    // A line armed before the turn opened. Sitting out wins over it above, and
    // a seat with nothing to decide is left to the ordinary path.
    if (current.preAction && !current.folded && !current.allIn) {
      this.clearActionTimeout();
      this.emitUpdate();
      this._firePreAction();
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

    this.handStartPlayerCount = 0;
    this.handStartStacks = {};
    this.lastRoundWinnerIds = [];
    this.lastRoundRefunds = [];
    this.showdownWinningCards = [];
    this.cardsExposed = false;

    // Reset player states
    const sittingOutNow = [];
    for (const p of this.players) {
      p.holeCards = [];
      p.bet = 0;
      p.totalBet = 0;
      p.folded = p.chips <= 0;
      p.allIn = false;
      p.lastAction = null;
      p.actedThisStreet = false;
      p.handsPlayed++;
      // A new hand is a new price. Nothing armed against the last one survives.
      p.preAction = null;
      if (p.sitOutNextHand) {
        p.sitOutNextHand = false;
        p.autoPlay = true;
        // 'requested' rather than 'timeout': they asked for this, so it must
        // survive their reconnect. See resumeSeat() in the registry.
        p.sitOutReason = 'requested';
        p.isReady = false;
        sittingOutNow.push(p);
      }
    }

    // Move dealer
    this.dealerIndex = this.dealerIndex % this.players.length;
    while (this.players[this.dealerIndex].chips <= 0) {
      this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
    }

    // Post blinds — heads-up special rule: dealer posts SB
    const activePlayers = this.players.filter((p) => p.chips > 0);
    this.handStartPlayerCount = activePlayers.length;
    this.handStartStacks = Object.fromEntries(
      activePlayers.map((player) => [player.id, player.chips])
    );
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
    // After the blinds, not from inside the reset loop: the deal reads as the
    // deal, and a seat that stepped out this hand reads as a consequence of it.
    for (const p of sittingOutNow) {
      this.emitMessage(`${this.getPublicName(p)} is sitting out`, { kind: 'system' });
    }
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
    // The betting round is over and the street is mid-pause: currentPlayerIndex
    // still points at whoever closed it, so without this they could act twice.
    if (this._streetTimer) return false;
    const playerIdx = this.players.findIndex((p) => p.id === playerId);
    if (playerIdx === -1 || playerIdx !== this.currentPlayerIndex) return false;
    const player = this.players[playerIdx];
    if (player.folded || player.allIn) return false;

    const toCall = this.currentBet - player.bet;
    // Kept for the pre-action sweep below, which disarms every line that was
    // armed against a price this action is about to raise.
    const currentBetBeforeAction = this.currentBet;

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
          this.emitMessage(`${this.getPublicName(player)} calls ${capCall} (raise cap)`, {
            kind: 'action',
          });
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
          this.emitMessage(`${this.getPublicName(player)} all-in ${shortAllInAmount}!`, {
            kind: 'action',
          });
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
          this.emitMessage(`${this.getPublicName(player)} all-in ${raiseAmount}!`, {
            kind: 'action',
          });
          recordedAmount = player.bet;
        } else {
          this.emitMessage(`${this.getPublicName(player)} raises to ${player.bet}`, {
            kind: 'action',
          });
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
        this.emitMessage(`${this.getPublicName(player)} all-in ${allInAmount}!`, {
          kind: 'action',
        });
        recordedAmount = player.bet;
        break;

      default:
        return false;
    }

    this.clearActionTimeout();

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

    player.actedThisStreet = true;
    // Acting under your own steam clears the strikes; the clock running out and
    // acting for you does not, or the second strike could never land.
    if (!this._actingForTimeout) player.timeoutStrikes = 0;

    // Acting spends whatever this seat had armed, however the action arrived.
    // The fire path clears the arm it plays, but a player who clicks during the
    // beat leaves one behind — the action bar is up, because it is their turn —
    // and a leftover must not play itself when the betting comes back round.
    player.preAction = null;

    // A rising price kills every arm that was made against the old one, so the
    // button visibly disarms rather than going quiet on the player. checkfold
    // and callany are price-agnostic by design and survive. This is belt to the
    // braces the fire path already wears, which re-checks the price before it
    // acts; the point of doing it here is that the client sees it happen.
    if (this.currentBet > currentBetBeforeAction) {
      for (const other of this.players) {
        if (!other.preAction) continue;
        const kind = other.preAction.kind;
        if (kind === 'check' || kind === 'call') other.preAction = null;
      }
    }

    this.advanceAction();
    return true;
  }

  // The big blind is live: it went in before anybody chose anything, so having
  // matched the price does not mean having acted on it. A limped pot still owes
  // that seat the option to raise. lastRaiserIndex starts the hand pointing at
  // the big blind, so the walk below would otherwise read the posted blind as
  // the last aggressive action and close the street on top of them.
  _isLiveBlindOption(player) {
    return (
      this.phase === 'preflop' &&
      !!player &&
      player.seatIndex === this.bbIndex &&
      !player.lastAction &&
      player.bet >= this.currentBet
    );
  }

  advanceAction() {
    // Check if only one player left
    const activePlayers = this.getPlayersInHand();
    if (activePlayers.filter((p) => !p.folded).length === 1) {
      this.awardPot(activePlayers.filter((p) => !p.folded));
      this.endRound();
      return;
    }

    // The big blind has just taken its option. The walk below has only one
    // terminator preflop — the big blind itself — and it has just stepped past
    // it, so left alone it would break at the first seat that can act and deal
    // a whole second orbit. If the option was checked rather than raised,
    // everybody has matched and the street is finished here. A raise leaves
    // seats owing chips, and those seats get their turn through the walk.
    if (this.phase === 'preflop' && this.currentPlayerIndex === this.bbIndex) {
      const blind = this.players[this.bbIndex];
      if (blind && blind.lastAction && this.lastRaiserIndex === this.bbIndex) {
        const owed = this.players.some(
          (p) => !p.folded && !p.allIn && p.chips > 0 && p.bet < this.currentBet
        );
        if (!owed) {
          this.nextPhase();
          return;
        }
      }
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
          // A limped pot owes the big blind its option before the flop.
          if (this._isLiveBlindOption(p)) {
            break;
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
        if (lp.bet >= this.currentBet && !this._isLiveBlindOption(lp)) {
          this.nextPhase();
          return;
        }
        break;
      }
    }

    // If all remaining players are all-in or folded
    const canAct = this.players.filter((p) => !p.folded && !p.allIn && p.chips > 0);
    if (canAct.length === 0) {
      // The last chips are in and nothing more can be bet. Hold the closing
      // frame the way nextPhase does - that money is worth seeing land, and
      // the hands come up on it - then run the board out on the street beat.
      this.clearActionTimeout();
      this._exposeHands();
      this.emitUpdate();
      this._afterStreetPause(() => this.dealRemainingCards());
      return;
    }

    if (canAct.length === 1 && canAct[0].bet >= this.currentBet) {
      // Preflop live blind: BB gets option to raise even if everyone limped/folded
      const isBBLiveBlind =
        this.phase === 'preflop' && canAct[0].seatIndex === this.bbIndex && !canAct[0].lastAction; // BB hasn't acted yet this hand
      if (isBBLiveBlind) {
        this.currentPlayerIndex = canAct[0].seatIndex;
        // beginCurrentTurn rather than emitUpdate + processAutoTurn: an
        // automated seat takes the same path either way, but a human big blind
        // needs a clock, and processAutoTurn returns without arming one for a
        // seat that is not automated. Every turn opens through here.
        this.beginCurrentTurn();
        return;
      }
      this.nextPhase();
      return;
    }

    // A backstop over the index bookkeeping above. The walk decides the street
    // is over by returning to lastRaiserIndex, which is a proxy for the actual
    // rule: betting ends when everyone still in the hand has acted on this
    // street and matched the price. If those indices ever disagree with the
    // table — and on a live 200 player field something got them to — the walk
    // hands the turn round and round and the table never deals again. The rule
    // itself does not have that failure mode, so it is checked here too.
    const owing = this.players.filter(
      (p) => !p.folded && !p.allIn && p.chips > 0 && (!p.actedThisStreet || p.bet < this.currentBet)
    );
    if (owing.length === 0) {
      this.nextPhase();
      return;
    }

    this.currentPlayerIndex = nextIdx;
    this.beginCurrentTurn();
  }

  // The next street: the burn, the cards, the phase and the announcement. The
  // all-in run-out deals through here too, so a board nobody could bet on
  // comes out exactly like one that was played - three cards for the flop,
  // one burn a street, and the same line in the log and the replay.
  _dealStreet(street) {
    this.deck.pop(); // burn
    if (street === 'flop') {
      this.communityCards.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
    } else {
      this.communityCards.push(this.deck.pop());
    }
    this.phase = street;

    // A flop is read as a whole; a turn or river is the one new card, against
    // the board that was already sitting there.
    const dealt =
      street === 'flop'
        ? this._cards(this.communityCards)
        : this._card(this.communityCards[this.communityCards.length - 1]);
    const label = street[0].toUpperCase() + street.slice(1);
    this.emitMessage(`── ${label} ── ${dealt}`, { kind: 'street', street });
    this._log(
      street === 'flop'
        ? `🂠 flop: ${dealt} (pot:${this.pot})`
        : `🂠 ${street}: ${dealt} → ${this._cards(this.communityCards)} (pot:${this.pot})`
    );
    this._logEvent(
      'street_advance',
      { street, communityCards: this.communityCards.map((card) => this._card(card)) },
      'info',
      `Street advanced to ${street}`
    );
    this.handHistory.recordCommunityCards(this.communityCards);
  }

  // Betting is over for good: nobody left in the hand can put another chip in,
  // whatever the board brings. That is the moment a real table turns the hands
  // face up, and watching the run-out blind is the difference between a hand
  // and a slot machine.
  //
  // It asks the table rather than trusting the caller, so it can be called
  // from every route that might have closed the betting and only fires on the
  // one that did. Two conditions: two live hands, because one player left is a
  // fold and nobody is owed a look at the cards; and at most one seat that
  // could still bet, because a lone player with chips has nobody to bet
  // against and the hand is just as settled as if they were all in.
  _exposeHands() {
    if (this.cardsExposed) return;
    if (this.players.filter((p) => !p.folded).length < 2) return;
    if (this.players.filter((p) => !p.folded && !p.allIn && p.chips > 0).length > 1) return;
    this.cardsExposed = true;
  }

  // Everyone is all in, so the rest of the board is a formality. It is still
  // dealt a card at a time on the street beat: five cards appearing at once is
  // the moment of the hand going past too fast to watch.
  dealRemainingCards() {
    this._exposeHands();
    if (this.communityCards.length >= 5) {
      this.phase = 'showdown';
      this.showdown();
      return;
    }
    const n = this.communityCards.length;
    this._dealStreet(n === 0 ? 'flop' : n === 3 ? 'turn' : 'river');
    this.emitUpdate();
    this._afterStreetPause(() => this.dealRemainingCards());
  }

  // Runs fn after the street pause, or immediately when there is none. Only
  // one can be pending: a hand has a single thread of progress.
  _afterStreetPause(fn) {
    if (this._streetTimer) {
      clearTimeout(this._streetTimer);
      this._streetTimer = null;
    }
    if (!this.streetPauseMs) {
      fn();
      return;
    }
    this._streetTimer = setTimeout(() => {
      this._streetTimer = null;
      if (!this.isRunning) return;
      fn();
    }, this.streetPauseMs);
    if (this._streetTimer.unref) this._streetTimer.unref();
  }

  nextPhase() {
    // The street is closing. If it closed the betting for the whole hand, this
    // is the frame the hands come up on - whichever route got here.
    this._exposeHands();
    const phaseIdx = PHASES.indexOf(this.phase);
    if (phaseIdx >= 4) {
      // The river's betting is over. Hold the same beat before the cards are
      // turned up: this is the last money to go in, and the showdown landing
      // on top of it is the moment of the hand nobody gets to see.
      this.clearActionTimeout();
      this.emitUpdate();
      this._afterStreetPause(() => {
        this.phase = 'showdown';
        this.showdown();
      });
      return;
    }

    // The last frame in which this street's bets exist. Everything below runs
    // in one synchronous stack that ends in a single emit, so without this the
    // client's first sight of the flop already has every bet at zero and the
    // closing player's bet was never sent at all: no chips could travel, and
    // the player who closed the street got no animation for their own money.
    // It is also the frame the pause holds on, so the bets can be read before
    // they are swept in.
    this.clearActionTimeout();
    this.emitUpdate();
    this._afterStreetPause(() => this._openStreet(phaseIdx));
  }

  // Everything the new street brings: the bets go to the middle, the cards
  // come out, and somebody is to act again.
  _openStreet(phaseIdx) {
    // Reset bets for new betting round
    for (const p of this.players) {
      p.bet = 0;
      p.actedThisStreet = false;
      // Armed against the street that just closed, and that price is gone.
      p.preAction = null;
    }
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.raiseCount = 0;

    this._dealStreet(PHASES[phaseIdx + 1]);

    // First to act is after dealer
    this.currentPlayerIndex = this.getNextActiveIndex(this.dealerIndex);
    this.lastRaiserIndex = this.currentPlayerIndex;

    // Check if only all-in players remain
    const canAct = this.players.filter((p) => !p.folded && !p.allIn && p.chips > 0);
    if (canAct.length <= 1) {
      if (this.communityCards.length < 5) {
        // This street has just been dealt and nobody can bet on it. It gets
        // its own frame regardless: handing straight to the run-out puts the
        // flop and the turn on the felt together and the flop is never seen.
        this._exposeHands();
        this.emitUpdate();
        this._afterStreetPause(() => this.dealRemainingCards());
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

    // Announce hands. Saying it out loud is what makes a holding public, so
    // the recorder is told at the same moment: the replay shows exactly the
    // cards that were turned over here and nothing else.
    for (const r of results) {
      this.emitMessage(
        `${this.getPublicName(r.player)} shows ${this._cards(r.player.holeCards)} · ${describeBest(r.hand)}`,
        { kind: 'show' }
      );
      this.handHistory.recordShown(r.player.id);
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
          // The five that made the hand, so the felt can show why it won.
          // evaluateHand already picked them out of the seven; nothing else
          // has ever read them. Taking the union across contested winners is
          // what makes a split pot light both hands and a side pot light each
          // pot's winner, with no per-seat bookkeeping: a card is unique in a
          // deck, so a flat list of keys is unambiguous.
          for (const card of r.hand.cards || []) {
            const key = `${card.rank}${card.suit}`;
            if (!this.showdownWinningCards.includes(key)) {
              this.showdownWinningCards.push(key);
            }
          }
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
          this._log(
            `💰 ${this.getPublicName(r.player)} refund ${r._awarded} bal:${r.player.chips}`
          );
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
    if (this._streetTimer) {
      clearTimeout(this._streetTimer);
      this._streetTimer = null;
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
    return !!(player && (player.autoPlay || player.isBot));
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
      // A bot plays its hand; a seat that is sitting out gives it up. The
      // distinction matters - sitting out is a person who stepped away, and
      // putting their chips in for them is the one thing it must never do.
      const move = live.isBot
        ? this._donkeyMove(live)
        : { action: canCheck ? 'check' : 'fold', amount: 0 };
      live.lastAction = { action: move.action, amount: move.amount || 0, time: Date.now() };
      this.handleAction(live.id, move.action, move.amount);
    }, delay);
    if (this._autoTurnTimer.unref) this._autoTurnTimer.unref();
  }

  // A donkey: calls far too much, raises without a reason, folds only when the
  // price is most of what it has left. Deliberately not a poker player - these
  // exist so a table can be filled for testing, and a good one would make that
  // testing worse by ending hands quickly and folding the interesting spots.
  //
  // Everything it does goes through handleAction, so it cannot make a move the
  // rules do not allow: the raise below is clamped there, and a call larger
  // than the stack becomes an all-in.
  _donkeyMove(player) {
    const toCall = Math.max(0, this.currentBet - player.bet);
    const roll = random.randomInt(100);

    if (toCall <= 0) {
      // Nothing owed. Mostly check, occasionally put a bet in for no reason.
      if (roll < 20 && this.canAnyoneRespond(player)) {
        return { action: 'raise', amount: this._donkeyRaise() };
      }
      return { action: 'check', amount: 0 };
    }

    // Facing a bet. A donkey pays it unless it is most of the stack, and even
    // then it pays sometimes.
    const priceShare = toCall / Math.max(1, player.chips);
    if (priceShare > 0.6 && roll < 70) return { action: 'fold', amount: 0 };
    if (roll < 10 && this.canAnyoneRespond(player)) {
      return { action: 'raise', amount: this._donkeyRaise() };
    }
    return { action: 'call', amount: 0 };
  }

  // Half the pot on top of the current bet, or the minimum if that is more.
  // Sizing off the pot rather than off the minimum matters at a table of five
  // of them: min-raises get called round and round and the street barely
  // closes, where a raise worth making ends it.
  _donkeyRaise() {
    return this.currentBet + Math.max(this.minRaise, Math.round(this.pot / 2));
  }

  // Is there anybody left who could answer a raise? Raising into a table where
  // everyone else is all in or folded is not a move, and handleAction refuses
  // it - better to ask before making one.
  canAnyoneRespond(player) {
    return this.players.some((p) => p.id !== player.id && !p.folded && !p.allIn && p.chips > 0);
  }

  // What an armed line comes to at the price the table actually reached. Null
  // means it no longer applies and the player takes their turn back, which is
  // the whole reason a pre-action is resolved here rather than at arming time:
  // the table moves between the click and the turn.
  _resolvePreAction(player) {
    const arm = player.preAction;
    if (!arm) return null;
    const canCheck = this.currentBet <= player.bet;
    switch (arm.kind) {
      // Check when it is free, fold when it is not. Holds at any price, which
      // is why it is also the line behind the "fold" button the client shows
      // when there is already a bet to answer.
      case 'checkfold':
        return { action: canCheck ? 'check' : 'fold' };
      // Only ever a check. Somebody betting first hands the turn back rather
      // than folding a hand the player never said they would fold.
      case 'check':
        return canCheck ? { action: 'check' } : null;
      // Whatever it costs by the time it arrives, up to the whole stack.
      // handleAction turns a call into a check when nothing is owed.
      case 'callany':
        return { action: 'call' };
      // Only at the price it was armed against. A raise in between is a
      // different decision from the one the player made, so it is not made for
      // them. Both halves are checked: the table's price and what it costs this
      // seat, which are the same invariant from either end.
      case 'call':
        if (this.currentBet !== arm.atBet) return null;
        if (this.currentBet - player.bet !== arm.atToCall) return null;
        return { action: 'call' };
      default:
        return null;
    }
  }

  // A line armed before the turn opened, played now that it has. The
  // scaffolding mirrors processAutoTurn above: the same beat so the felt can
  // draw the seat as active before the action lands, the same pause guard, the
  // same single timer. The two are siblings rather than one driver because they
  // differ in everything that matters — which seats they claim, how they
  // recognise one across the wait, what they decide, and what they owe a seat
  // when they decline to act.
  _firePreAction() {
    const current = this.players[this.currentPlayerIndex];
    if (!current || !current.preAction || current.folded || current.allIn) return;
    if (this.isAutomatedPlayer(current)) return;

    // Paused: resume() calls beginCurrentTurn again and the arm is still on the
    // seat, because it is consumed in the timer rather than here.
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

    // uid, not id. id is the socket id and is reassigned on reconnect, and a
    // reload inside this window is exactly what an armed line has to survive;
    // processAutoTurn can compare id because a dropped seat is not coming back
    // inside its beat.
    const armedUid = current.uid;

    this._autoTurnTimer = setTimeout(() => {
      this._autoTurnTimer = null;
      if (!this.isRunning) return;
      if (this.isPaused) {
        this._pausedAutoPending = true;
        return;
      }
      // The turn may have moved while the timer was pending: someone acted, the
      // hand ended, or the seat was moved between tables. Identity is
      // re-checked here rather than captured.
      const live = this.players[this.currentPlayerIndex];
      if (!live || live.uid !== armedUid) return;
      // Sitting out claimed the seat while we waited — a drop, or the player
      // asking for it. That path owns the turn now, and it folds where this one
      // might have called: a sit-out never puts chips in on somebody's behalf.
      if (this.isAutomatedPlayer(live)) return;

      const decided = this._resolvePreAction(live);
      // Cleared before the call, not after: handleAction runs advanceAction,
      // which can re-enter beginCurrentTurn synchronously.
      live.preAction = null;
      if (decided && this.handleAction(live.id, decided.action)) return;

      // Disarmed mid-beat, no longer valid at the price the table reached, or
      // refused by handleAction. The turn belongs to the player again and it
      // needs a clock: without this the seat sits there with no timer and no
      // action, and the table waits for the abandon sweep.
      this.scheduleActionTimeout();
      this.emitUpdate();
    }, delay);
    if (this._autoTurnTimer.unref) this._autoTurnTimer.unref();
  }

  // includeHistory: the ten recent hands are 88% of this payload and change
  // only when a hand ends, so the emit path attaches them to the first push
  // after each hand and leaves them off the rest. Left on by default, because
  // a caller asking for a whole state without saying otherwise wants all of
  // it; the client carries the last set it was sent forward across the pushes
  // that omit them.
  getStateForPlayer(playerId, { includeHistory = true } = {}) {
    const viewer = this.players.find((p) => p.id === playerId);
    const hostPlayer = this.hostPlayerId
      ? this.players.find((p) => p.uid === this.hostPlayerId)
      : null;
    // Hands are face up when there is something to compare: at showdown, and
    // through a run-out where the betting is already finished. A pot taken
    // uncontested is neither - the last player standing is never made to show,
    // and showdown is the phase that hand ends in too.
    const handsFaceUp =
      (this.phase === 'showdown' || this.cardsExposed) &&
      this.players.filter((p) => !p.folded).length >= 2;
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
        sitOutReason: p.sitOutReason || null,
        isSpectator: this.isSpectatorPlayer(p),
        avatar: p.avatar || null,
        lastAction: p.lastAction || null,
        wins: p.wins,
        handsPlayed: p.handsPlayed,
        // Only to the player themselves, or to everyone once the hands are up.
        holeCards: p.id === playerId || (handsFaceUp && !p.folded) ? p.holeCards : null,
      })),
      // A seat that is sitting out is not the viewer's turn to act: the seat
      // acts for them. Saying otherwise flashes the action bar up for the
      // length of the sit-out delay and invites a click that races it.
      isMyTurn:
        viewer &&
        this.currentPlayerIndex === viewer.seatIndex &&
        this.isRunning &&
        !this._streetTimer &&
        !this.isAutomatedPlayer(viewer),
      canCheck: viewer && this.currentBet === (viewer.bet || 0),
      canRaise: viewer
        ? this.players.some((p) => p.id !== playerId && !p.folded && !p.allIn && p.chips > 0)
        : false,
      toCall: viewer ? this.currentBet - (viewer.bet || 0) : 0,
      // Viewer-private, and it has to stay that way: knowing an opponent has
      // armed "call any" is a read they are not entitled to. Never in players[].
      // The viewer can be absent here — a busted watcher is sent state too.
      myPreAction: viewer && viewer.preAction ? { ...viewer.preAction } : null,
      mySitOutNextHand: !!(viewer && viewer.sitOutNextHand),
      isRunning: this.isRunning,
      lastRoundWinnerIds: this.lastRoundWinnerIds,
      showdownWinningCards: this.showdownWinningCards,
      lastRoundRefunds: this.lastRoundRefunds,
      // War report & leaderboard
      warReport: this.lastWarReport || null,
      leaderboard: this.leaderboard.getRankings(),
      ...(includeHistory ? { recentHands: this._recentHandsFor(playerId) } : {}),
      // Tournament
      tournament: this.tournament ? this.tournament.getState() : null,
      gameOver: this.gameOver,
      viewerIsSpectator: this.isSpectatorPlayer(viewer),
      // No clock runs while the street beat is held: nobody is to act, and a
      // countdown ticking down on the last actor's seat reads as their turn.
      // Stamped so the client can tell how far its own clock is from this one.
      // turnExpiresAt is an absolute time on the server's clock, and a device a
      // few seconds behind reads it as more time remaining than the whole turn
      // is worth - which shows up as a clock that sits full and does not start.
      serverNow: Date.now(),
      turnExpiresAt: this._streetTimer ? null : this.turnExpiresAt,
      turnDurationMs: this._streetTimer ? null : this.turnDurationMs,
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

  // Which recorded seats belong to this viewer. History is keyed by the socket
  // id a seat held when the hand was dealt and a reconnect issues a new one,
  // so identity has to come off the uid or a player loses sight of their own
  // cards the moment they drop and come back.
  historyIdsForViewer(hand, viewerId) {
    const ids = new Set(viewerId ? [viewerId] : []);
    const viewer = this.players.find((p) => p.id === viewerId);
    if (viewer && viewer.uid) {
      for (const p of hand.players || []) {
        if (p.uid && p.uid === viewer.uid) ids.add(p.id);
      }
    }
    return ids;
  }

  // A recorded hand's cards as this viewer is allowed to see them: their own,
  // and whatever was turned face up at showdown.
  visibleHistoryCards(hand, viewerId) {
    const mine = this.historyIdsForViewer(hand, viewerId);
    const shown = new Set(hand.shownPlayerIds || []);
    const visible = {};
    for (const [id, cards] of Object.entries(hand.holeCards || {})) {
      if (mine.has(id) || shown.has(id)) visible[id] = cards;
    }
    return visible;
  }

  // The ten-hand window this viewer is entitled to see. Rebuilt only when a
  // hand has ended since the last time it was asked for; between hands every
  // push reuses the same array. The map is dropped wholesale on a new version
  // rather than pruned, which keeps it to the viewers actually being served
  // and means a reconnect's new socket id cannot pile up in it.
  _recentHandsFor(playerId) {
    const version = this.handHistory.version;
    if (this._historyCacheVersion !== version) {
      this._historyCache.clear();
      this._historyCacheVersion = version;
    }
    const cached = this._historyCache.get(playerId);
    if (cached) return cached;
    const built = this.handHistory.getRecentHands(10).map((h) => ({
      handNum: h.handNum,
      pot: h.pot,
      phase: h.finalPhase,
      winners: h.winners,
      communityCards: h.communityCards,
      // Never the whole table's cards. The recorder keeps every hand in
      // full server-side; a viewer is sent their own holding plus the ones
      // actually shown down. Sending the lot handed everyone at the table
      // the folding range of everyone else, ten hands deep, in a payload
      // the replay panel then drew.
      holeCards: this.visibleHistoryCards(h, playerId),
      actions: h.actions,
      players: h.players,
      dealerIndex: h.dealerIndex,
      sbIndex: h.sbIndex,
      bbIndex: h.bbIndex,
      smallBlind: h.smallBlind,
      bigBlind: h.bigBlind,
    }));
    this._historyCache.set(playerId, built);
    return built;
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

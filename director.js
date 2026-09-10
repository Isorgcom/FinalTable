// director.js - runs one tournament across several tables.
//
// The engine stays a single-table engine. This sits above it and owns the only
// cross-table authority in the system: who is seated where, when a table may
// deal, and when the tournament is over.
//
// Phase 3 scope: N tables on one shared blind clock, run to completion.
// It does NOT balance tables (keeping seat counts even is phase 4). It does
// collapse a table that can no longer deal, because without that a field of
// three tables simply stalls at three separate survivors and never finishes.

const { PokerGame, DEFAULT_MAX_PLAYERS } = require('./engine');
const { Tournament } = require('./tournament');
const random = require('./random');

class ChipConservationError extends Error {}

// Prize distribution by field size. Percentages, first place first, each row
// summing to exactly 100. Roughly the top 10-15% of the field is paid, which is
// the usual shape for a home tournament: enough places that finishing near the
// bubble still means something, few enough that a min-cash is not a rounding
// error.
const PAYOUT_STRUCTURES = [
  { upTo: 5, pct: [100] },
  { upTo: 9, pct: [65, 35] },
  { upTo: 17, pct: [50, 30, 20] },
  { upTo: 29, pct: [40, 27, 20, 13] },
  { upTo: 49, pct: [35, 22, 16, 12, 9, 6] },
  { upTo: Infinity, pct: [30, 20, 14, 10, 8, 7, 5, 4, 2] },
];

function payoutPercentagesFor(fieldSize) {
  return PAYOUT_STRUCTURES.find((s) => fieldSize <= s.upTo).pct;
}

class TournamentDirector {
  constructor(options = {}) {
    this.id = options.id || random.randomId('t_');
    this.tableSize = options.tableSize || DEFAULT_MAX_PLAYERS;
    this.startChips = options.startChips || 5000;
    this.buyIn = options.buyIn || 0;
    this.gameOptions = options.gameOptions || {};
    this.payoutPct = options.payoutPct || null; // override the default structure
    this._payoutOverride = !!options.payoutPct;
    // Late registration stays open through this many levels (0 = closes at start).
    this.lateRegLevels = Number.isInteger(options.lateRegLevels) ? options.lateRegLevels : 3;
    this._lateRegClosedAnnounced = false;
    // tableNumber -> the last state that table was in while it was not
    // dealing. See _captureIdleTables for why it is kept per table.
    this._tableSnapshots = new Map();
    this._bubbleAnnounced = false;
    this._inTheMoneyAnnounced = false;

    // One Tournament instance is shared by every table, which is what gives a
    // synchronised blind clock and a single elimination ledger. The field
    // provider is what stops any one table declaring the tournament over the
    // moment it empties.
    this.tournament = new Tournament({
      levelDuration: options.levelDuration,
      blindSchedule: options.blindSchedule,
      fieldProvider: () => this.fieldPlayers(),
    });

    this.tables = [];
    this.entrants = [];
    this.isRunning = false;
    this.finished = null;
    this._expectedChips = null;
    this._paused = false;
    // A held beat between hands, so the showdown and the pot going to the
    // winner can be watched rather than glimpsed. Zero keeps the tests'
    // hand driver immediate; the server sets a real one. The director's tick
    // is the granularity, so the wait is this rounded up to the next tick.
    this.handPauseMs = Math.max(0, options.handPauseMs || 0);
    this.now = options.now || (() => Date.now());

    // Hooks the host (a server, or a test) supplies.
    this.onMessage = options.onMessage || null;
    this.onTableCreated = options.onTableCreated || null;
    this.onTableBroken = options.onTableBroken || null;
    this.onFinished = options.onFinished || null;
    // Fired when a player changes table, so a host can tell that player
    // specifically rather than making them notice their seat changed.
    this.onPlayerMoved = options.onPlayerMoved || null;
    // Called when the field has settled after a hand, so the host can persist
    // whatever snapshot() now returns.
    this.onSnapshot = options.onSnapshot || null;
    // Fired whenever the field summary changes in a way worth pushing.
    this.onFieldUpdate = options.onFieldUpdate || null;
    // Fired for a human who busts, with their place, before they leave the
    // table, so a host can keep sending them that table as a spectator.
    this.onPlayerEliminated = options.onPlayerEliminated || null;
  }

  // ── Field queries ────────────────────────────────────────────────────────

  fieldPlayers() {
    return this.tables.flatMap((t) => t.players);
  }

  playersRemaining() {
    return this.fieldPlayers().filter((p) => p.chips > 0).length;
  }

  // Total chips the whole field is accountable for. This must not change for
  // the life of the tournament; see assertChipConservation.
  totalChips() {
    return this.tables.reduce((sum, t) => sum + t.totalChips(), 0);
  }

  // The table a player is seated at right now. Their socket id changes on
  // reconnect and their table changes on a balance move, so callers must look
  // this up per action rather than caching it.
  tableForPlayer(uid) {
    return this.tables.find((t) => t.players.some((p) => p.uid === uid)) || null;
  }

  playerByUid(uid) {
    for (const table of this.tables) {
      const found = table.players.find((p) => p.uid === uid);
      if (found) return { table, player: found };
    }
    return null;
  }

  // The half of a field summary that does not depend on who is looking. Built
  // once and handed to every fieldSummary call in the same broadcast.
  fieldShared() {
    const seats = this.seatIndex();
    const alive = this.fieldPlayers().filter((p) => p.chips > 0);
    const sorted = [...alive].sort((a, b) => b.chips - a.chips);
    const rankByUid = new Map();
    sorted.forEach((p, i) => rankByUid.set(p.uid, i + 1));
    return { seats, alive, sorted, leader: sorted[0] || null, rankByUid };
  }

  // Field summary for the UI: everything a player needs to know about where
  // they stand without opening another screen.
  // shared, when given, is fieldShared() computed once for a whole broadcast.
  // Everything in it is the same for every viewer, and recomputing it per
  // recipient is what made a push cost the square of the field.
  fieldSummary(viewerUid = null, shared = this.fieldShared()) {
    const { alive, sorted, leader, seats, rankByUid } = shared;
    const me = viewerUid ? seats.get(viewerUid) : null;
    const mePlayer = me && me.player.chips > 0 ? me.player : null;
    const myRank = mePlayer ? rankByUid.get(viewerUid) || null : null;
    const seat = me || null;
    return {
      id: this.id,
      isRunning: this.isRunning,
      finished: this.finished,
      entrants: this.entrants.length,
      remaining: this.isRunning || this.finished ? alive.length : this.entrants.length,
      tableSize: this.tableSize,
      startChips: this.startChips,
      levelDuration: this.tournament.levelDuration,
      buyIn: this.buyIn,
      lateRegLevels: this.lateRegLevels,
      lateRegOpen: this.lateRegOpen(),
      averageStack: alive.length ? Math.floor(this.totalChips() / alive.length) : 0,
      chipLeader: leader ? { name: leader.name, chips: leader.chips } : null,
      myChips: mePlayer ? mePlayer.chips : null,
      myRank,
      myTable: seat ? seat.table.tableNumber : null,
      tablesLeft: this.activeTables().length,
      paidPlaces: this.paidPlaces || 0,
      prizePool: this.prizePool(),
      payouts: this.payouts(),
      onBubble: this.isOnBubble(),
      inTheMoney: this.paidPlaces ? alive.length <= this.paidPlaces : false,
      blinds: this.tournament.getCurrentBlinds(),
      level: this.tournament.currentLevel + 1,
      nextLevelIn: this.tournament.getTimeUntilNextLevel(),
    };
  }

  activeTables() {
    return this.tables.filter((t) => t.players.length > 0);
  }

  // Tables still in play: not broken, and therefore valid move destinations.
  openTables() {
    return this.tables.filter((t) => !t._broken);
  }

  // ── Registration and seating ─────────────────────────────────────────────

  register(entrant) {
    if (this.isRunning) throw new Error('Cannot register after the tournament has started');
    // The uid is the entrant's identity for the life of the tournament; the
    // roster and the seats must agree on it, so mint it here if it is missing.
    if (!entrant.uid) entrant.uid = random.randomId('u_');
    this.entrants.push(entrant);
    return this.entrants.length;
  }

  // Before the start only; a seated stack cannot leave a tournament.
  unregister(uid) {
    if (this.isRunning) return false;
    const before = this.entrants.length;
    this.entrants = this.entrants.filter((e) => e.uid !== uid);
    return this.entrants.length < before;
  }

  lateRegOpen() {
    return this.isRunning && !this.finished && this.tournament.currentLevel < this.lateRegLevels;
  }

  // Late registration: a newcomer sits down with the starting stack at the
  // table with the fewest players. A table mid-hand takes them as a folded
  // spectator until its next deal (the same trick the room layer uses for a
  // mid-hand join), because splicing a seat into a running hand is exactly
  // what _movePlayer refuses to do. The chip ledger grows before the seat is
  // taken and shrinks back if seating fails, so conservation never sees a
  // half-registered stack.
  registerLate(entrant) {
    if (!this.lateRegOpen()) throw new Error('Late registration is closed');
    let table = this.tables
      .filter((t) => !t._broken && t.players.length > 0 && t.players.length < this.tableSize)
      .sort((a, b) => a.players.length - b.players.length)[0];
    if (!table) {
      table = this._createTable(this.tables.length);
      // A late table breaks first: break order is otherwise fixed at start.
      this.breakOrder.unshift(table.tableNumber);
      const blinds = this.tournament.getCurrentBlinds();
      table.smallBlind = blinds.sb;
      table.bigBlind = blinds.bb;
    }
    this._expectedChips += this.startChips;
    const seated = table.addPlayer({
      id: entrant.id,
      uid: entrant.uid,
      name: entrant.name,
      avatar: entrant.avatar || null,
      chips: this.startChips,
      isBot: !!entrant.isBot,
    });
    if (!seated) {
      this._expectedChips -= this.startChips;
      throw new Error('No seat available');
    }
    if (table.isRunning) {
      seated.folded = true;
      seated.holeCards = [];
    }
    this.entrants.push(entrant);
    this.tournament.setFieldSize(this.entrants.length);
    if (!this._payoutOverride) {
      this.payoutPct = payoutPercentagesFor(this.entrants.length);
      this.paidPlaces = this.payoutPct.length;
    }
    this._say(
      `${entrant.name} registers late and sits at table ${table.tableNumber} · ${this.entrants.length} entrants, ${this.paidPlaces} paid`
    );
    if (this.onFieldUpdate) this.onFieldUpdate();
    return { table, player: seated };
  }

  // uid -> where that player is sitting, in one pass over the field. Callers
  // that need this for every entrant used to reach for playerByUid each time,
  // which walks every table: fine for eight players, quadratic for two hundred,
  // and the roster and the field summary are both built from it on every push.
  seatIndex() {
    const index = new Map();
    for (const table of this.tables) {
      for (const player of table.players) index.set(player.uid, { table, player });
    }
    return index;
  }

  // Everyone who registered, with where they stand now. Connection status is
  // the socket layer's business and is added there.
  roster(seats = this.seatIndex()) {
    const placeByUid = new Map();
    for (const e of this.tournament.eliminations) if (e.uid) placeByUid.set(e.uid, e.place);
    return this.entrants.map((e) => {
      const seat = seats.get(e.uid) || null;
      return {
        uid: e.uid,
        name: e.name,
        avatar: e.avatar || null,
        chips: seat ? seat.player.chips : null,
        table: seat ? seat.table.tableNumber : null,
        place: placeByUid.get(e.uid) || null,
        autoPlay: seat ? !!seat.player.autoPlay : false,
        isBot: !!e.isBot,
        // Where the player came from: a typed name, or a GameNight account.
        provider: e.provider || 'guest',
      };
    });
  }

  start() {
    if (this.isRunning) return false;
    if (this.entrants.length < 2) throw new Error('Need at least 2 entrants');

    const tableCount = Math.ceil(this.entrants.length / this.tableSize);
    for (let i = 0; i < tableCount; i++) this._createTable(i);

    // Seat draw: shuffle with the same crypto RNG the deal uses, then deal
    // round-robin so tables start as even as the field allows.
    const draw = this._shuffled(this.entrants);
    draw.forEach((entrant, i) => {
      const table = this.tables[i % tableCount];
      table.addPlayer({
        id: entrant.id,
        uid: entrant.uid,
        name: entrant.name,
        avatar: entrant.avatar || null,
        chips: this.startChips,
        isBot: !!entrant.isBot,
      });
    });

    this.payoutPct = this.payoutPct || payoutPercentagesFor(this.entrants.length);
    this.paidPlaces = this.payoutPct.length;

    // Fixed at start: a table's break priority must not depend on the state of
    // the moment, or debugging a finish becomes guesswork. Highest table number
    // breaks first.
    this.breakOrder = [...this.tables].reverse().map((t) => t.tableNumber);

    this.isRunning = true;
    this._expectedChips = this.totalChips();
    this.tournament.start(this.entrants.length);

    this._wireLevelUp();

    const blinds = this.tournament.getCurrentBlinds();
    for (const table of this.tables) {
      table.smallBlind = blinds.sb;
      table.bigBlind = blinds.bb;
    }

    this._say(
      `Tournament started: ${this.entrants.length} players across ${tableCount} table${tableCount === 1 ? '' : 's'}` +
        ` · ${this.paidPlaces} paid`
    );
    return true;
  }

  _createTable(index) {
    // A director table is a tournament table unless the caller says otherwise:
    // that is what selects the tournament action clock in the engine.
    const table = new PokerGame(`${this.id}_t${index + 1}`, {
      gameMode: 'tournament',
      ...this.gameOptions,
      maxPlayers: this.tableSize,
      startChips: this.startChips,
    });
    table.tableNumber = index + 1;
    // Same instance on every table, not a copy.
    table.tournament = this.tournament;
    table.onRoundEnd = (g, tournamentResult) => this._handleRoundEnd(g, tournamentResult);
    this.tables.push(table);
    if (this.onTableCreated) this.onTableCreated(table);
    return table;
  }

  _shuffled(list) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = random.randomInt(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  // ── Money ────────────────────────────────────────────────────────────────

  prizePool() {
    return this.buyIn * this.entrants.length;
  }

  // Percentages resolved to whole chips. Floor each share and give the
  // remainder to first place, so the payouts always add back up to the pool
  // exactly rather than losing a unit to rounding.
  // Before start() the structure is projected from the entrants so far, so a
  // waiting room can show the ladder instead of the caller blowing up.
  payouts() {
    const pool = this.prizePool();
    const pct = this.payoutPct || payoutPercentagesFor(Math.max(2, this.entrants.length));
    const shares = pct.map((pct, i) => ({
      place: i + 1,
      pct,
      amount: pool > 0 ? Math.floor((pool * pct) / 100) : 0,
    }));
    if (pool > 0 && shares.length > 0) {
      const allocated = shares.reduce((sum, s) => sum + s.amount, 0);
      shares[0].amount += pool - allocated;
    }
    return shares;
  }

  // One player away from the money.
  isOnBubble() {
    if (!this.isRunning || this.finished || !this.paidPlaces) return false;
    return this.playersRemaining() === this.paidPlaces + 1;
  }

  // Places, names and prizes together. Eliminations are stored worst-first, so
  // reverse to read as a finishing order.
  finalResults() {
    const prizes = new Map(this.payouts().map((s) => [s.place, s]));
    return [...this.tournament.eliminations]
      .sort((a, b) => a.place - b.place)
      .map((e) => {
        const prize = prizes.get(e.place);
        return {
          place: e.place,
          name: e.name,
          prize: prize ? prize.amount : 0,
          pct: prize ? prize.pct : 0,
          inTheMoney: !!prize,
        };
      });
  }

  _checkMoneyMilestones() {
    if (!this.paidPlaces) return;
    if (this.isOnBubble() && !this._bubbleAnnounced) {
      this._bubbleAnnounced = true;
      this._say(`Bubble: ${this.playersRemaining()} left, ${this.paidPlaces} paid. Hand for hand.`);
    }
    if (
      !this._inTheMoneyAnnounced &&
      this.playersRemaining() <= this.paidPlaces &&
      this.playersRemaining() > 0
    ) {
      this._inTheMoneyAnnounced = true;
      this._say(`In the money: everyone left is guaranteed a payout.`);
    }
  }

  // ── Running hands ────────────────────────────────────────────────────────

  // A table may deal when it is not already running, has two players with
  // chips, and the director is not holding the field. The hold exists so
  // hand-for-hand play at the money bubble can be added without reworking this
  // control flow later.
  canStartHand(table) {
    if (!this.isRunning || this.finished || this._paused) return false;
    if (table.isRunning) return false;
    if (
      this.handPauseMs &&
      table._handEndedAt &&
      this.now() - table._handEndedAt < this.handPauseMs
    )
      return false;
    // Hand for hand on the bubble: a table that finishes early waits for the
    // rest, so no table can stall its way past the money while another plays
    // on. Without it a big stack simply slows down and folds into a payout.
    if (this.isOnBubble() && this.tables.some((t) => t.isRunning)) return false;
    return table.players.filter((p) => p.chips > 0).length >= 2;
  }

  startHandsWhereReady() {
    let started = 0;
    for (const table of this.tables) {
      if (this.canStartHand(table)) {
        table.startRound();
        started++;
      }
    }
    return started;
  }

  // Called on a timer by the host. Starts whatever hands can start; the engine
  // drives bot turns and human actions arrive over sockets.
  tick() {
    if (!this.isRunning || this.finished) return 0;
    return this.startHandsWhereReady();
  }

  holdField(reason = '') {
    this._paused = true;
    if (reason) this._say(`Field held: ${reason}`);
  }

  releaseField() {
    this._paused = false;
  }

  // ── Round end ────────────────────────────────────────────────────────────

  _handleRoundEnd(table, tournamentResult) {
    if (!this.isRunning) return;
    // When the next hand may start from here. Stamped before anything else so
    // an early return still holds the table for its beat.
    table._handEndedAt = this.now();

    // Busted players leave their seat. The engine has already recorded their
    // finishing place in the shared ledger by this point.
    const busted = table.players.filter((p) => p.chips <= 0);
    if (this.onPlayerEliminated) {
      for (const p of busted) {
        const record = [...this.tournament.eliminations].reverse().find((e) => e.uid === p.uid);
        this.onPlayerEliminated({
          uid: p.uid,
          name: p.name,
          place: record ? record.place : null,
          tableId: table.id,
        });
      }
    }
    for (const p of busted) table.removePlayer(p.id);

    // The invariant from phase 2. Checked here because this is the only moment
    // the director moves anyone, so it is the only moment chips could go
    // missing. A failure means the tournament is minting or destroying money
    // and must not continue.
    this.assertChipConservation();

    this._checkMoneyMilestones();

    if (tournamentResult || this.playersRemaining() <= 1) {
      this._finish(tournamentResult);
      return;
    }

    // Break a table when the field fits on fewer, keep the rest within one
    // seat of each other, and rescue anything that still cannot deal. Every
    // table is considered, not just the one that finished: a table unable to
    // deal never fires another round end, so only somebody else's round end
    // will ever get its players unstuck.
    this.rebalanceField();

    // The field has settled: busts are out, moves are done, chips are checked.
    // Record every table that is not mid-hand, and tell the host so it can be
    // written somewhere that survives this process.
    this._captureIdleTables();
    if (this.onSnapshot) this.onSnapshot(this);
    if (this.onFieldUpdate) this.onFieldUpdate();
  }

  // ── Seat maths ───────────────────────────────────────────────────────────

  // Index of the seat that will post the big blind on the next hand.
  //
  // Deliberately counts only players with chips, and does NOT use
  // getNextActiveIndex: that helper also skips folded and all-in players, and
  // `folded` is only cleared inside startRound, so between hands it still holds
  // the previous hand's values. endRound has already advanced dealerIndex by
  // the time this is called, so this mirrors what startRound will decide.
  _nextBigBlindIndex(table) {
    const n = table.players.length;
    if (n === 0) return 0;
    const hasChips = (i) => table.players[i].chips > 0;
    const step = (from) => {
      let j = (from + 1) % n;
      for (let guard = 0; guard < n && !hasChips(j); guard++) j = (j + 1) % n;
      return j;
    };
    const dealer = table.dealerIndex % n;
    const active = table.players.filter((p) => p.chips > 0).length;
    // Heads-up inverts it: the button is the small blind.
    if (active === 2) return step(dealer);
    return step(step(dealer));
  }

  // The player a balance move should take. Standard practice is to move the
  // player who is about to post the big blind and seat them where they will
  // post it again, so the move costs them exactly one blind: pick anyone else
  // and they either get a free orbit or pay twice, which players notice
  // immediately and which quietly changes who wins.
  _playerToMove(table) {
    const seated = table.players.filter((p) => p.chips > 0);
    if (seated.length === 0) return null;
    const idx = this._nextBigBlindIndex(table);
    return table.players[idx] && table.players[idx].chips > 0 ? table.players[idx] : seated[0];
  }

  // Move one player, seating them in the destination's big-blind seat.
  // Seat before remove, always: a rejected seat must not destroy a stack.
  //
  // Never touches a table with a hand in progress. Inserting a seat mid-hand
  // shifts every index the hand is built on, including the button, and drops in
  // a player who holds no cards but is not folded. It loses chips: an observed
  // run drifted by exactly one big blind. Deferring is safe, because a running
  // table fires its own round end when it finishes and the rebalance runs again.
  _movePlayer(from, to, player) {
    if (from.isRunning || to.isRunning) return false;
    const seatIndex = this._nextBigBlindIndex(to);
    const seated = to.addPlayer({
      id: player.id,
      uid: player.uid,
      name: player.name,
      avatar: player.avatar || null,
      chips: player.chips,
      isBot: !!player.isBot,
      seatIndex,
    });
    if (!seated) return false;
    // Sitting out is a property of the player, not of the seat they happen to
    // hold. addPlayer builds a fresh record with autoPlay false, so without this
    // a balance move sits a player back in who asked to sit out: they return
    // live, burn a full clock, and time out into a sit-out they never left.
    seated.autoPlay = player.autoPlay;
    seated.sitOutReason = player.sitOutReason;
    seated.sitOutNextHand = player.sitOutNextHand;
    seated.timeoutStrikes = player.timeoutStrikes || 0;
    // preAction is deliberately not carried: it is armed against one street's
    // price, and a move only happens between hands.
    from.removePlayer(player.id);
    this._say(`${player.name} moves to table ${to.tableNumber}`);
    if (this.onPlayerMoved) {
      this.onPlayerMoved({
        uid: player.uid,
        id: player.id,
        name: player.name,
        fromTable: from.tableNumber,
        toTable: to.tableNumber,
        chips: seated.chips,
      });
    }
    return true;
  }

  // ── Balancing and breaking ───────────────────────────────────────────────

  // Break a table when the field fits on one fewer, then balance what is left.
  // Balance keeps every table within one seat of every other, which is the
  // standard rule and the thing that stops one table playing five-handed while
  // another plays eight.
  rebalanceField() {
    if (!this.isRunning || this.finished) return;
    this._breakIfPossible();
    this._balanceTables();
    // Anything still unable to deal gets rescued the phase 3 way.
    this._collapseStalledTables();

    // Any empty table is out of play, however it emptied: broken deliberately,
    // or simply everyone seated at it busting on the same hand. Marking both
    // the same way is what stops it being handed players again later.
    for (const table of this.tables) {
      if (table.players.length === 0) this._announceBreak(table);
    }

    this.assertChipConservation();
  }

  _breakIfPossible() {
    for (let pass = 0; pass < this.tables.length; pass++) {
      const active = this.activeTables();
      if (active.length <= 1) return;
      const capacityWithoutOne = (active.length - 1) * this.tableSize;
      if (this.playersRemaining() > capacityWithoutOne) return;

      // Which table breaks is decided over the whole field and never over the
      // subset that happens to be idle. Choosing among the free tables looks
      // harmless and is not: the free set changes from one round end to the
      // next, so the same table is the obvious one to break now and the wrong
      // one a second later, and players get carried back and forth. Decide
      // first, then act only if the table chosen is free; if it is dealing,
      // wait for it rather than picking a different answer.
      const doomed = this.breakOrder
        .map((num) => this.tables.find((t) => t.tableNumber === num))
        .find((t) => t && t.players.length > 0);
      if (!doomed || doomed.isRunning) return;

      // And only start a break that can be finished. The capacity test above
      // counts every table in play, but a table mid-hand cannot take a seat, so
      // the room may not be there yet. Beginning anyway empties the doomed
      // table halfway, and the balancer behind it reads what is left as the
      // emptiest table in the field and fills it straight back up — which is
      // players carried out and back, over and over, for as long as it takes.
      const room = this.tables
        .filter(
          (t) => t !== doomed && !t._broken && !t.isRunning && t.players.length < this.tableSize
        )
        .reduce((sum, t) => sum + (this.tableSize - t.players.length), 0);
      if (room < doomed.players.length) return;

      for (const player of [...doomed.players]) {
        const target = this._emptiestTableExcept(doomed);
        if (!target) break;
        if (!this._movePlayer(doomed, target, player)) break;
      }
      if (doomed.players.length === 0) {
        this._announceBreak(doomed);
      } else {
        return; // could not fully empty it; stop rather than loop
      }
    }
  }

  _balanceTables() {
    for (let pass = 0; pass < 50; pass++) {
      const active = this.activeTables();
      if (active.length < 2) return;
      // Sorted over every table in play, dealing or not. Ranking only the idle
      // ones ranks a different field every time and sends players back and
      // forth between two tables that were never out of balance to begin with.
      const sorted = [...active]
        .filter((t) => !t._broken)
        .sort((a, b) => a.players.length - b.players.length);
      if (sorted.length < 2) return;
      const smallest = sorted[0];
      const largest = sorted[sorted.length - 1];
      if (largest.players.length - smallest.players.length <= 1) return;
      // The two that need balancing are the two that must be free. If either is
      // mid-hand the answer does not change, so wait for it.
      if (smallest.isRunning || largest.isRunning) return;

      const mover = this._playerToMove(largest);
      if (!mover) return;
      if (!this._movePlayer(largest, smallest, mover)) return;
    }
  }

  // A broken table stays broken. Without this an emptied table is still just
  // "a table with free seats" and players get moved back onto it, which no
  // tournament does and which reads as a bug from the seat.
  _emptiestTableExcept(exclude) {
    return this.tables
      .filter(
        (t) => t !== exclude && !t._broken && !t.isRunning && t.players.length < this.tableSize
      )
      .sort((a, b) => a.players.length - b.players.length)[0];
  }

  _collapseStalledTables() {
    for (const table of [...this.tables]) {
      if (table.isRunning || table.players.length === 0) continue;
      this._collapseIfStalled(table);
    }
  }

  _collapseIfStalled(table) {
    const survivors = table.players.filter((p) => p.chips > 0);
    if (survivors.length >= 2) return;
    if (this.activeTables().length <= 1) return; // nowhere to go; this is the final table

    for (const player of [...survivors]) {
      // Never a table that is dealing: addPlayer on a running table changes the
      // seat count a hand is being played against. _movePlayer refuses this;
      // this path reached for a table directly and did not.
      const target = this.tables
        .filter(
          (t) =>
            t !== table &&
            !t._broken &&
            !t.isRunning &&
            t.players.length > 0 &&
            t.players.length < this.tableSize
        )
        .sort((a, b) => a.players.length - b.players.length)[0];
      if (!target) return; // every other table is full; leave them put

      // Seat first, remove second. A rejected seat must never destroy a stack.
      const seated = target.addPlayer({
        id: player.id,
        uid: player.uid,
        name: player.name,
        avatar: player.avatar || null,
        chips: player.chips,
        isBot: !!player.isBot,
      });
      if (!seated) return;
      // Same carry as _movePlayer: a collapse must not sit a player back in.
      seated.autoPlay = player.autoPlay;
      seated.sitOutReason = player.sitOutReason;
      seated.sitOutNextHand = player.sitOutNextHand;
      seated.timeoutStrikes = player.timeoutStrikes || 0;
      table.removePlayer(player.id);
      this._say(`${player.name} moves to table ${target.tableNumber}`);
    }

    if (table.players.length === 0) {
      this._announceBreak(table);
    }
  }

  // A table is broken once. Without the flag an emptied table re-announces
  // itself on every subsequent sweep, which floods the message log.
  _announceBreak(table) {
    if (table._broken) return;
    table._broken = true;
    this._say(`Table ${table.tableNumber} is broken`);
    // Nobody sits here again - the table keeps its number but never takes a
    // player - so anything held on its behalf can go now rather than waiting
    // for the whole tournament to be reaped.
    if (this.onTableBroken) this.onTableBroken(table);
  }

  assertChipConservation() {
    if (this._expectedChips === null) return;
    const actual = this.totalChips();
    if (actual !== this._expectedChips) {
      throw new ChipConservationError(
        `Chip conservation violated: expected ${this._expectedChips}, found ${actual} ` +
          `(drift ${actual - this._expectedChips})`
      );
    }
  }

  _finish(tournamentResult) {
    if (this.finished) return;
    this.isRunning = false;
    const results = tournamentResult || this.tournament.getResults();
    const winner = this.fieldPlayers().find((p) => p.chips > 0) || null;
    this.finished = { results, winner: winner ? winner.name : null };
    this.tournament.stop();
    this._say(winner ? `${winner.name} wins the tournament` : 'Tournament over');
    if (this.onFinished) this.onFinished(this.finished);
  }

  stop() {
    this.isRunning = false;
    this.tournament.stop();
    for (const table of this.tables) table.stop();
  }

  // ── State ────────────────────────────────────────────────────────────────

  getState() {
    const alive = this.playersRemaining();
    return {
      id: this.id,
      isRunning: this.isRunning,
      finished: this.finished,
      entrants: this.entrants.length,
      playersRemaining: alive,
      averageStack: alive > 0 ? Math.floor(this.totalChips() / alive) : 0,
      totalChips: this.totalChips(),
      tables: this.tables.map((t) => ({
        tableNumber: t.tableNumber,
        id: t.id,
        players: t.players.length,
        isRunning: t.isRunning,
        chips: t.totalChips(),
      })),
      paidPlaces: this.paidPlaces || 0,
      prizePool: this.prizePool(),
      onBubble: this.isOnBubble(),
      inTheMoney: this.paidPlaces ? this.playersRemaining() <= this.paidPlaces : false,
      tournament: this.tournament.getState(),
    };
  }

  // Push every level change to every table, so a player moved at level 6 does
  // not find themselves playing level 3 blinds. Shared by start and restore:
  // a resumed tournament needs the same wiring a fresh one gets.
  _wireLevelUp() {
    this.tournament.onLevelUp = (level, blinds) => {
      for (const table of this.tables) {
        table.smallBlind = blinds.sb;
        table.bigBlind = blinds.bb;
      }
      this._say(`Blinds up: ${blinds.sb}/${blinds.bb} (level ${level + 1})`);
      if (this.lateRegLevels > 0 && !this._lateRegClosedAnnounced && !this.lateRegOpen()) {
        this._lateRegClosedAnnounced = true;
        this._say(
          `Late registration closed: ${this.entrants.length} entrants, ${this.paidPlaces} paid`
        );
      }
    };
  }

  // A table is only worth recording between hands: mid-hand its stacks are
  // short by whatever is in the pot, and restoring that would quietly destroy
  // chips. So each table's entry is rewritten whenever it is idle and left
  // alone while it deals.
  //
  // That is enough for the field as a whole to stay consistent, because chips
  // only cross tables through _movePlayer, which refuses unless both ends are
  // idle. A table that is dealing cannot have gained or lost a player since
  // its entry was written; only its stacks are stale, by exactly the hand it
  // is playing. Restoring therefore costs at most the hand in flight, per
  // table, and never a torn field.
  _captureIdleTables() {
    for (const table of this.tables) {
      if (table.isRunning) continue;
      this._tableSnapshots.set(table.tableNumber, {
        tableNumber: table.tableNumber,
        dealerIndex: table.dealerIndex || 0,
        broken: !!table._broken,
        players: table.players.map((p) => ({
          uid: p.uid,
          name: p.name,
          avatar: p.avatar || null,
          chips: p.chips,
          autoPlay: !!p.autoPlay,
          sitOutReason: p.sitOutReason || null,
          isBot: !!p.isBot,
        })),
      });
    }
  }

  // Everything needed to seat this field again after a restart. No deck, no
  // hole cards, no timers, no socket ids: a hand in progress is not restorable
  // and is not attempted.
  snapshot() {
    this._captureIdleTables();
    return {
      version: 1,
      id: this.id,
      tableSize: this.tableSize,
      startChips: this.startChips,
      buyIn: this.buyIn,
      lateRegLevels: this.lateRegLevels,
      payoutPct: this.payoutPct,
      paidPlaces: this.paidPlaces,
      breakOrder: [...(this.breakOrder || [])],
      expectedChips: this._expectedChips,
      entrants: this.entrants.map((e) => ({
        uid: e.uid,
        name: e.name,
        avatar: e.avatar || null,
        provider: e.provider || 'guest',
        isBot: !!e.isBot,
      })),
      tables: [...this._tableSnapshots.values()].map((t) => ({
        ...t,
        players: t.players.map((p) => ({ ...p })),
      })),
      clock: this.tournament.snapshotClock(),
    };
  }

  // Seat a stored field and start its clock again. The inverse of snapshot,
  // and deliberately not a variant of start(): there is no draw here, every
  // seat and stack is already decided.
  restoreFrom(snap) {
    if (!snap || !Array.isArray(snap.tables) || snap.tables.length === 0) return false;
    this.entrants = (snap.entrants || []).map((e) => ({ ...e }));
    this.payoutPct = snap.payoutPct || this.payoutPct;
    this.paidPlaces = snap.paidPlaces || (this.payoutPct ? this.payoutPct.length : 0);

    for (const entry of snap.tables) {
      const table = this._createTable(entry.tableNumber - 1);
      if (entry.broken) table._broken = true;
      const roster = entry.players || [];
      roster.forEach((p, i) => {
        // Seated explicitly and in the recorded order. Without a seat index
        // addPlayer draws for position, which would reshuffle the table and
        // move the button and the blinds onto different people.
        const seated = table.addPlayer({
          id: p.uid, // rebound to a socket id when the player reconnects
          uid: p.uid,
          name: p.name,
          avatar: p.avatar || null,
          chips: p.chips,
          isBot: !!p.isBot,
          seatIndex: i,
        });
        if (seated && !seated.isBot) {
          // Nobody is connected yet, so every restored seat starts sitting out
          // and is taken back by its player when they return. A demo seat has
          // nobody to wait for and carries on where it left off.
          seated.autoPlay = true;
          seated.sitOutReason = p.sitOutReason || 'disconnect';
        }
      });
      // After seating: inserting a seat at or before the button moves it, so
      // setting it first would leave the button somewhere else entirely.
      table.dealerIndex = Math.min(entry.dealerIndex || 0, Math.max(0, table.players.length - 1));
      this._tableSnapshots.set(table.tableNumber, { ...entry });
    }

    this.breakOrder =
      snap.breakOrder && snap.breakOrder.length
        ? [...snap.breakOrder]
        : [...this.tables].reverse().map((t) => t.tableNumber);
    this.isRunning = true;
    this._expectedChips = this.totalChips();
    this.tournament.resumeFrom(snap.clock || {});
    this._wireLevelUp();
    const blinds = this.tournament.getCurrentBlinds();
    for (const table of this.tables) {
      table.smallBlind = blinds.sb;
      table.bigBlind = blinds.bb;
    }
    return true;
  }

  _say(message) {
    if (this.onMessage) this.onMessage(message);
  }
}

module.exports = { TournamentDirector, ChipConservationError, payoutPercentagesFor };

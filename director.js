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

class TournamentDirector {
  constructor(options = {}) {
    this.id = options.id || random.randomId('t_');
    this.tableSize = options.tableSize || DEFAULT_MAX_PLAYERS;
    this.startChips = options.startChips || 5000;
    this.gameOptions = options.gameOptions || {};

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

    // Hooks the host (a server, or a test) supplies.
    this.onMessage = options.onMessage || null;
    this.onTableCreated = options.onTableCreated || null;
    this.onFinished = options.onFinished || null;
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

  activeTables() {
    return this.tables.filter((t) => t.players.length > 0);
  }

  // ── Registration and seating ─────────────────────────────────────────────

  register(entrant) {
    if (this.isRunning) throw new Error('Cannot register after the tournament has started');
    this.entrants.push(entrant);
    return this.entrants.length;
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
        isNPC: entrant.isNPC || false,
        npcProfile: entrant.npcProfile || null,
        chips: this.startChips,
      });
    });

    this.isRunning = true;
    this._expectedChips = this.totalChips();
    this.tournament.start(this.entrants.length);

    // Push every level change to every table, so a player moved at level 6
    // does not find themselves playing level 3 blinds.
    this.tournament.onLevelUp = (level, blinds) => {
      for (const table of this.tables) {
        table.smallBlind = blinds.sb;
        table.bigBlind = blinds.bb;
      }
      this._say(`Blinds up: ${blinds.sb}/${blinds.bb} (level ${level + 1})`);
    };

    const blinds = this.tournament.getCurrentBlinds();
    for (const table of this.tables) {
      table.smallBlind = blinds.sb;
      table.bigBlind = blinds.bb;
    }

    this._say(
      `Tournament started: ${this.entrants.length} players across ${tableCount} table${tableCount === 1 ? '' : 's'}`
    );
    return true;
  }

  _createTable(index) {
    const table = new PokerGame(`${this.id}_t${index + 1}`, {
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

  // ── Running hands ────────────────────────────────────────────────────────

  // A table may deal when it is not already running, has two players with
  // chips, and the director is not holding the field. The hold exists so
  // hand-for-hand play at the money bubble can be added without reworking this
  // control flow later.
  canStartHand(table) {
    if (!this.isRunning || this.finished || this._paused) return false;
    if (table.isRunning) return false;
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

    // Busted players leave their seat. The engine has already recorded their
    // finishing place in the shared ledger by this point.
    const busted = table.players.filter((p) => p.chips <= 0);
    for (const p of busted) table.removePlayer(p.id);

    // The invariant from phase 2. Checked here because this is the only moment
    // the director moves anyone, so it is the only moment chips could go
    // missing. A failure means the tournament is minting or destroying money
    // and must not continue.
    this.assertChipConservation();

    if (tournamentResult || this.playersRemaining() <= 1) {
      this._finish(tournamentResult);
      return;
    }

    // Not balancing: only rescuing tables that can no longer deal. Without
    // this the field ends as one lone survivor per table and never resolves.
    //
    // Every stalled table is swept, not just the one that finished. A table
    // that cannot deal never fires another round end, so if a survivor could
    // not be moved when their table stalled (everywhere else was full), only
    // somebody else's round end will ever get them unstuck.
    this._collapseStalledTables();
    this.assertChipConservation();
  }

  _collapseStalledTables() {
    for (const table of [...this.tables]) {
      if (table.isRunning) continue;
      this._collapseIfStalled(table);
    }
  }

  _collapseIfStalled(table) {
    const survivors = table.players.filter((p) => p.chips > 0);
    if (survivors.length >= 2) return;
    if (this.activeTables().length <= 1) return; // nowhere to go; this is the final table

    for (const player of [...survivors]) {
      const target = this.tables
        .filter((t) => t !== table && t.players.length > 0 && t.players.length < this.tableSize)
        .sort((a, b) => a.players.length - b.players.length)[0];
      if (!target) return; // every other table is full; leave them put

      // Seat first, remove second. A rejected seat must never destroy a stack.
      const seated = target.addPlayer({
        id: player.id,
        uid: player.uid,
        name: player.name,
        isNPC: player.isNPC,
        npcProfile: player.npcProfile,
        chips: player.chips,
      });
      if (!seated) return;
      table.removePlayer(player.id);
      this._say(`${player.name} moves to table ${target.tableNumber}`);
    }

    if (table.players.length === 0) {
      this._say(`Table ${table.tableNumber} is broken`);
    }
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
      tournament: this.tournament.getState(),
    };
  }

  _say(message) {
    if (this.onMessage) this.onMessage(message);
  }
}

module.exports = { TournamentDirector, ChipConservationError };

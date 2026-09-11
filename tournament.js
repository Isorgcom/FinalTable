// tournament.js - Sit & Go Tournament Mode
// Blind levels increase on a timer, players eliminated when busted

const { materialize } = require('./blind-structures');

class Tournament {
  constructor(options = {}) {
    this.isActive = false;
    this.startTime = null;

    // The level length a row falls back to when it carries none of its own:
    // a hand-built schedule in a test, or a caller from before rows had one.
    this.levelDuration = options.levelDuration || 180; // 3 minutes per level
    this.currentLevel = 0;
    // Standard, at this clock's level length: the rows come without one so
    // setSchedule gives them the length asked for, clamped or not.
    this.setSchedule(
      options.blindSchedule || materialize('standard').levels.map(({ duration: _d, ...row }) => row)
    );

    // When a TournamentDirector runs several tables on one clock, it supplies
    // a provider returning every player in the field. Without it the class
    // behaves exactly as before and judges the tournament by one table, which
    // would declare a winner the moment any single table emptied.
    this.fieldProvider = options.fieldProvider || null;

    this.eliminations = []; // [{name, place, handNum, time}]
    this.startingPlayers = 0;
    this.timer = null;
    this.onLevelUp = null; // callback(level, blinds)
    this.onTournamentEnd = null; // callback(results)
  }

  // The schedule as the clock runs it: every row with its own length, and
  // the second at which each begins worked out once rather than on every
  // tick. A break is a row with no blinds.
  setSchedule(rows) {
    const list = Array.isArray(rows) && rows.length ? rows : [{ sb: 10, bb: 20 }];
    this.blindSchedule = list.map((r) => ({
      sb: r.sb || 0,
      bb: r.bb || 0,
      ante: r.ante || 0,
      duration: r.duration > 0 ? r.duration : this.levelDuration,
      break: !!r.break,
    }));
    this._startsAt = [];
    let t = 0;
    for (const row of this.blindSchedule) {
      this._startsAt.push(t);
      t += row.duration;
    }
    this._startsAt.push(t);
  }

  start(playerCount) {
    this.isActive = true;
    this.startTime = Date.now();
    this.currentLevel = 0;
    this.startingPlayers = playerCount;
    this.eliminations = [];

    // Start blind level timer
    this.timer = setInterval(() => {
      this.checkLevelUp();
    }, 1000);
    // Do not hold the process open just for the blind clock. Matches the
    // treatment of the host-transfer and rate-limit timers elsewhere.
    if (this.timer.unref) this.timer.unref();

    return this.getCurrentBlinds();
  }

  // The clock as a plain object. Elapsed rather than the absolute start, so a
  // restore resumes where the field left off instead of charging it for the
  // time the server was down: a tournament that crashed at level 3 and came
  // back ten minutes later is still at level 3. The schedule rides along, so
  // the field comes back on the structure it was dealt with.
  snapshotClock() {
    return {
      currentLevel: this.currentLevel,
      elapsedMs: this.startTime ? Date.now() - this.startTime : 0,
      levelDuration: this.levelDuration,
      schedule: this.blindSchedule.map((r) => ({ ...r })),
      startingPlayers: this.startingPlayers,
      eliminations: this.eliminations.map((e) => ({ ...e })),
    };
  }

  // Pick the clock back up mid-tournament. Everything start() does except the
  // draw: the level and the eliminations already happened and are restored,
  // not recomputed.
  resumeFrom(snap = {}) {
    this.isActive = true;
    if (snap.levelDuration) this.levelDuration = snap.levelDuration;
    if (Array.isArray(snap.schedule) && snap.schedule.length) this.setSchedule(snap.schedule);
    this.currentLevel = Number.isInteger(snap.currentLevel)
      ? Math.min(snap.currentLevel, this.blindSchedule.length - 1)
      : 0;
    this.startingPlayers = snap.startingPlayers || 0;
    this.eliminations = Array.isArray(snap.eliminations)
      ? snap.eliminations.map((e) => ({ ...e }))
      : [];
    const elapsed = Math.max(0, Number(snap.elapsedMs) || 0);
    this.startTime = Date.now() - elapsed;

    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.checkLevelUp();
    }, 1000);
    if (this.timer.unref) this.timer.unref();
    return this.getCurrentBlinds();
  }

  stop() {
    this.isActive = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  _elapsedSeconds() {
    return this.startTime ? (Date.now() - this.startTime) / 1000 : 0;
  }

  // The row the clock is on after this many seconds; the last row holds.
  _levelAt(elapsed) {
    let level = 0;
    for (let i = 1; i < this.blindSchedule.length; i++) {
      if (this._startsAt[i] <= elapsed) level = i;
      else break;
    }
    return level;
  }

  checkLevelUp() {
    if (!this.isActive) return;
    const newLevel = this._levelAt(this._elapsedSeconds());

    if (newLevel > this.currentLevel) {
      this.currentLevel = newLevel;
      if (this.onLevelUp) {
        this.onLevelUp(this.currentLevel, this.getCurrentBlinds());
      }
    }
  }

  _row(index = this.currentLevel) {
    return this.blindSchedule[Math.min(Math.max(0, index), this.blindSchedule.length - 1)];
  }

  isFinalLevel() {
    return this.currentLevel >= this.blindSchedule.length - 1;
  }

  onBreak() {
    return this._row().break;
  }

  // The blinds in play: this level's, or on a break, the level play resumes
  // at, so a table stamped during the break is stamped with what it will deal.
  getCurrentBlinds() {
    let row = this._row();
    if (row.break) {
      const i = this.currentLevel;
      row =
        this.blindSchedule.slice(i + 1).find((r) => !r.break) ||
        [...this.blindSchedule.slice(0, i)].reverse().find((r) => !r.break) ||
        row;
    }
    return { sb: row.sb, bb: row.bb, ante: row.ante };
  }

  // The number a player sees. Levels of play count; a break carries the
  // number of the level before it, so "through level 3" reaches the end of
  // the break that follows level 3.
  levelNumber() {
    let n = 0;
    for (let i = 0; i <= Math.min(this.currentLevel, this.blindSchedule.length - 1); i++) {
      if (!this.blindSchedule[i].break) n++;
    }
    return n;
  }

  playLevelCount() {
    return this.blindSchedule.filter((r) => !r.break).length;
  }

  getTimeUntilNextLevel() {
    if (!this.isActive || !this.startTime) return 0;
    if (this.isFinalLevel()) return 0;
    const nextLevelAt = this._startsAt[this.currentLevel + 1];
    return Math.max(0, Math.ceil(nextLevelAt - this._elapsedSeconds()));
  }

  recordElimination(playerName, handNum, uid = null) {
    const place = this.startingPlayers - this.eliminations.length;
    this.eliminations.push({
      name: playerName,
      uid,
      place,
      handNum,
      time: Date.now(),
    });
    return place;
  }

  // Late registration grows the field after bust-outs have been recorded.
  // Places are "field size minus players out before you", so earlier
  // bust-outs move down a place, exactly as a live event renumbers them. The
  // ledger is worst-first, which makes the renumbering a single pass.
  setFieldSize(n) {
    this.startingPlayers = n;
    this.eliminations.forEach((e, i) => {
      e.place = n - i;
    });
  }

  // The field, when one is supplied; otherwise just the table that asked.
  _scope(players) {
    return this.fieldProvider ? this.fieldProvider() : players;
  }

  getAliveCount(players) {
    return this._scope(players).filter((p) => p.chips > 0).length;
  }

  checkTournamentEnd(players) {
    const scope = this._scope(players);
    const alive = this.getAliveCount(players);
    if (alive <= 1 && this.isActive) {
      this.stop();
      const winner = scope.find((p) => p.chips > 0);
      if (winner) {
        this.eliminations.push({
          name: winner.name,
          place: 1,
          handNum: -1,
          time: Date.now(),
        });
      }
      return this.getResults();
    }
    return null;
  }

  getResults() {
    return {
      eliminations: [...this.eliminations].reverse(), // 1st place first
      duration: this.startTime ? Date.now() - this.startTime : 0,
      totalHands:
        this.eliminations.length > 0 ? Math.max(...this.eliminations.map((e) => e.handNum)) : 0,
      finalLevel: this.levelNumber(),
    };
  }

  getState() {
    return {
      isActive: this.isActive,
      currentLevel: this.currentLevel,
      levelNumber: this.levelNumber(),
      levelCount: this.playLevelCount(),
      onBreak: this.onBreak(),
      finalLevel: this.isFinalLevel(),
      blinds: this.getCurrentBlinds(),
      timeUntilNextLevel: this.getTimeUntilNextLevel(),
      levelDuration: this.levelDuration,
      eliminations: this.eliminations,
      startingPlayers: this.startingPlayers,
    };
  }
}

module.exports = { Tournament };

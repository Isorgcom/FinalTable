// tournament.js - Sit & Go Tournament Mode
// Blind levels increase on a timer, players eliminated when busted

class Tournament {
  constructor(options = {}) {
    this.isActive = false;
    this.startTime = null;

    // Blind schedule: each level lasts `levelDuration` seconds
    this.levelDuration = options.levelDuration || 180; // 3 minutes per level
    this.currentLevel = 0;
    this.blindSchedule = options.blindSchedule || [
      { sb: 10, bb: 20 },
      { sb: 15, bb: 30 },
      { sb: 25, bb: 50 },
      { sb: 40, bb: 80 },
      { sb: 50, bb: 100 },
      { sb: 75, bb: 150 },
      { sb: 100, bb: 200 },
      { sb: 150, bb: 300 },
      { sb: 200, bb: 400 },
      { sb: 300, bb: 600 },
      { sb: 500, bb: 1000 },
      { sb: 750, bb: 1500 },
      { sb: 1000, bb: 2000 },
    ];

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

  stop() {
    this.isActive = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  checkLevelUp() {
    if (!this.isActive) return;
    const elapsed = (Date.now() - this.startTime) / 1000;
    const newLevel = Math.min(
      Math.floor(elapsed / this.levelDuration),
      this.blindSchedule.length - 1
    );

    if (newLevel > this.currentLevel) {
      this.currentLevel = newLevel;
      if (this.onLevelUp) {
        this.onLevelUp(this.currentLevel, this.getCurrentBlinds());
      }
    }
  }

  getCurrentBlinds() {
    return this.blindSchedule[Math.min(this.currentLevel, this.blindSchedule.length - 1)];
  }

  getTimeUntilNextLevel() {
    if (!this.isActive || !this.startTime) return 0;
    const elapsed = (Date.now() - this.startTime) / 1000;
    const nextLevelAt = (this.currentLevel + 1) * this.levelDuration;
    return Math.max(0, Math.ceil(nextLevelAt - elapsed));
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
      finalLevel: this.currentLevel,
    };
  }

  getState() {
    return {
      isActive: this.isActive,
      currentLevel: this.currentLevel,
      blinds: this.getCurrentBlinds(),
      timeUntilNextLevel: this.getTimeUntilNextLevel(),
      levelDuration: this.levelDuration,
      eliminations: this.eliminations,
      startingPlayers: this.startingPlayers,
    };
  }
}

module.exports = { Tournament };

// webhook-payloads.js - what a webhook says, built from the director.
//
// Pure: an entry in, a plain object out, nothing sent and nothing kept. The
// field names are GameNight's - snake_case, `user_id` for its own id - since
// GameNight is the only reader. A player is named three ways so the receiver
// can pick: this server's uid, GameNight's user id when they have one, and
// the name as it was at the table. Bots take places too, and are sent
// flagged so the stream and the standings agree.

function userId(uid) {
  return typeof uid === 'string' && uid.startsWith('gn_') ? uid.slice(3) : null;
}

function playerRef(entry, uid, name) {
  const entrant = entry.director.entrants.find((e) => e.uid === uid) || null;
  return {
    uid,
    user_id: userId(uid),
    name: name || (entrant ? entrant.name : null),
    is_bot: !!(entrant && entrant.isBot),
  };
}

function prizeFor(director, place) {
  const paid = director.payouts().find((p) => p.place === place);
  return { prize: paid ? paid.amount : 0, in_the_money: !!paid };
}

// Every place, first to last. The eliminations carry a uid for everybody who
// busted and none for the winner; the director records the winner's uid
// separately, and a finish reached without a place-1 row gets one made.
function standings(entry) {
  const d = entry.director;
  const rosterByUid = new Map(d.roster().map((r) => [r.uid, r]));
  const winnerUid = d.finished ? d.finished.winnerUid || null : null;
  const list = d.tournament.eliminations.map((e) => ({
    place: e.place,
    uid: e.uid || (e.place === 1 ? winnerUid : null),
    name: e.name,
  }));
  if (d.finished && winnerUid && !list.some((row) => row.place === 1)) {
    list.push({ place: 1, uid: winnerUid, name: d.finished.winner });
  }
  return list
    .sort((a, b) => a.place - b.place)
    .map((row) => {
      const ref = playerRef(entry, row.uid, row.name);
      const seat = row.uid ? rosterByUid.get(row.uid) : null;
      return {
        place: row.place,
        ...ref,
        ...prizeFor(d, row.place),
        reentries: seat ? seat.reentries : 0,
        add_on: !!(seat && seat.addOn),
      };
    });
}

function eliminated(entry, { uid, name, place, forfeit, removed }, at) {
  const d = entry.director;
  return {
    player: playerRef(entry, uid, name),
    place,
    ...prizeFor(d, place),
    // Provisional while somebody could still come in behind them: a late
    // entrant or a re-entry moves every place already handed out.
    final: !d.lateRegOpen() && !d.reentryOpen(),
    how: forfeit ? 'forfeit' : removed ? 'removed' : 'busted',
    remaining: d.playersRemaining(),
    entrants: d.entrants.length,
    at,
  };
}

function reentered(entry, uid, at) {
  const d = entry.director;
  const seat = d.roster().find((r) => r.uid === uid) || null;
  return {
    player: playerRef(entry, uid),
    reentries: seat ? seat.reentries : 0,
    remaining: d.playersRemaining(),
    entries: d.entrants.length + d.extraEntries,
    at,
  };
}

function completed(entry) {
  const d = entry.director;
  const results = d.finished ? d.finished.results : null;
  const winnerUid = d.finished ? d.finished.winnerUid || null : null;
  return {
    outcome: 'winner',
    winner: winnerUid
      ? { uid: winnerUid, user_id: userId(winnerUid), name: d.finished.winner }
      : { uid: null, user_id: null, name: d.finished ? d.finished.winner : null },
    standings: standings(entry),
    entrants: d.entrants.length,
    humans: d.entrants.filter((e) => !e.isBot).length,
    entries: d.entrants.length + d.extraEntries,
    prize_pool: d.prizePool(),
    buy_in: d.buyIn,
    level: results ? results.finalLevel : null,
    hands: d.handsDealt(),
    started_at: entry.startedAt || null,
    finished_at: entry.finishedAt || null,
  };
}

function cancelled(entry, reason, at) {
  const d = entry.director;
  return {
    outcome: 'cancelled',
    reason: reason || 'ended',
    standings: standings(entry),
    entrants: d.entrants.length,
    started_at: entry.startedAt || null,
    ended_at: entry.finishedAt || at,
  };
}

// ── The clock ────────────────────────────────────────────────────────────

// Where the clock stands. On a break, `level` is the level just finished and
// `blinds` are the ones play resumes at, which is how the director reads
// them; `duration` is the current row's, break or level, in seconds.
function clock(entry) {
  const d = entry.director;
  const t = d.tournament;
  const row = t.blindSchedule[t.currentLevel] || {};
  const blinds = t.getCurrentBlinds();
  return {
    level: t.levelNumber(),
    on_break: t.onBreak(),
    blinds: { sb: blinds.sb, bb: blinds.bb, ante: blinds.ante || 0 },
    duration: Number.isFinite(row.duration) ? row.duration : null,
    next_level_in: t.getTimeUntilNextLevel(),
    levels: t.playLevelCount(),
    final_level: t.isFinalLevel(),
    late_reg_open: d.lateRegOpen(),
    reentry_open: d.reentryOpen(),
    add_on_open: d.addOnOpen(),
  };
}

// How the field stands. The average stack is the director's own arithmetic
// from fieldSummary, done here because there is no accessor for it.
function field(entry) {
  const d = entry.director;
  const alive = d.fieldPlayers().filter((p) => p.chips > 0).length;
  return {
    remaining: d.playersRemaining(),
    entrants: d.entrants.length,
    humans: d.entrants.filter((e) => !e.isBot).length,
    entries: d.entrants.length + d.extraEntries,
    tables: d.activeTables().length,
    average_stack: alive ? Math.floor(d.totalChips() / alive) : 0,
    prize_pool: d.prizePool(),
    paid_places: d.paidPlaces,
  };
}

// The clock started. Level one and its blinds come here and nowhere else:
// the level hook is wired after the clock starts, so it never says them.
function started(entry, at) {
  return { ...clock(entry), ...field(entry), buy_in: entry.director.buyIn, at };
}

function level(entry, { manual, back } = {}, at) {
  return { ...clock(entry), manual: !!manual, back: !!back, ...field(entry), at };
}

function clockStop(entry, at) {
  const c = clock(entry);
  return {
    level: c.level,
    on_break: c.on_break,
    next_level_in: c.next_level_in,
    remaining: entry.director.playersRemaining(),
    at,
  };
}

const paused = clockStop;
const resumed = clockStop;

// Still here, every few minutes. Enough to tell a paused game from an empty
// room from a dead server; nothing a poller of GET /api/games/:id would not
// see.
function heartbeat(entry, at) {
  const d = entry.director;
  const running = entry.status === 'running';
  return {
    status: entry.status,
    ...(running ? clock(entry) : {}),
    remaining: running ? d.playersRemaining() : d.entrants.length,
    entrants: d.entrants.length,
    paused: d.isPaused(),
    away_held: running && d.isHeldForAbsence(),
    away_held_since: entry.awayHeldSince || null,
    at,
  };
}

module.exports = {
  playerRef,
  standings,
  eliminated,
  reentered,
  completed,
  cancelled,
  started,
  level,
  paused,
  resumed,
  heartbeat,
  clock,
  field,
  userId,
};

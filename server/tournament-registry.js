// tournament-registry.js - the life of a tournament, from creation to teardown.
//
// Everything about a tournament that is not the poker itself lives here:
// who registered, who is connected, when it starts, who hosts, what happens
// when the last human drops, and when a finished one is forgotten. The
// director owns the tables and the chips; the socket handlers are a thin
// shim over this module; and everything here is keyed by identity uid.
//
// Time is one sweep on a short interval rather than a timeout per entry. A
// sweep survives clock jumps, restores trivially after a restart (an overdue
// entry simply starts on the first pass), and the reaper and host transfer
// need the same loop anyway. `now` and `timers` are injectable for tests.

const { TournamentDirector } = require('../director');
const random = require('../random');

const TICK_MS = 1200;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const START_CHIPS = [1000, 2000, 5000, 10000];
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function createTournamentRegistry(deps = {}) {
  const {
    io,
    identity,
    sanitizeName = (v, max = 16) =>
      String(v || '')
        .trim()
        .slice(0, max),
    normalizeNameKey = (v) =>
      String(v || '')
        .trim()
        .toLowerCase(),
    maxTournaments = 8,
    tableOptions = {},
    handPauseMs = 0,
    // Every connected socket, for the personalised tournament list. Injectable
    // so the registry tests can drive it without a real socket.io server.
    connectedSockets = () => (io && io.sockets ? io.sockets.sockets.values() : []),
    finishedTtlMs = 10 * 60 * 1000,
    abandonGraceMs = 2 * 60 * 1000,
    hostTransferGraceMs = 2 * 60 * 1000,
    overdueAbandonMs = 30 * 60 * 1000,
    sweepMs = 1000,
    now = () => Date.now(),
    store = null,
  } = deps;
  const timers = deps.timers || {
    setInterval: (...a) => setInterval(...a),
    clearInterval: (...a) => clearInterval(...a),
  };

  // id -> entry
  const tournaments = new Map();
  let sweepTimer = null;
  let sweeps = 0;
  let persistTimer = null;

  // ── Persistence ──────────────────────────────────────────────────────────
  // Registering tournaments are written on every change (debounced); once one
  // starts it drops out of the file, because a running one cannot be rebuilt.

  function serialize(entry) {
    return {
      id: entry.id,
      code: entry.code,
      name: entry.name,
      createdAt: entry.createdAt,
      startsAt: entry.startsAt,
      hostUid: entry.hostUid,
      settings: { ...entry.settings },
      entrants: entry.director.entrants.map((e) => ({
        uid: e.uid,
        name: e.name,
        avatar: e.avatar || null,
      })),
      registrations: [...entry.registrations.entries()].map(([uid, r]) => ({
        uid,
        joinedAt: r.joinedAt,
      })),
      status: entry.status,
      // A running tournament carries the field as it stood between hands, so a
      // restart seats everyone again instead of the tournament ceasing to
      // exist. Registrations alone are enough for one that has not dealt.
      field: entry.status === 'running' ? entry.director.snapshot() : null,
    };
  }

  function flush() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (!store) return;
    const list = [...tournaments.values()]
      .filter((e) => e.status === 'registering' || e.status === 'running')
      .map(serialize);
    try {
      store.save(list);
    } catch (_err) {
      /* the next change tries again */
    }
  }

  function persist() {
    if (!store || persistTimer) return;
    persistTimer = setTimeout(flush, 250);
    if (persistTimer.unref) persistTimer.unref();
  }

  // ── Small helpers ────────────────────────────────────────────────────────

  function makeCode() {
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = '';
      for (let i = 0; i < 5; i++) code += CODE_ALPHABET[random.randomInt(CODE_ALPHABET.length)];
      if (![...tournaments.values()].some((t) => t.code === code)) return code;
    }
    return random.randomId('').slice(0, 5).toUpperCase();
  }

  function byCode(code) {
    const key = String(code || '')
      .trim()
      .toUpperCase();
    return [...tournaments.values()].find((t) => t.code === key) || null;
  }

  function connectedHumans(entry) {
    return [...entry.registrations.values()].filter((r) => r.socketId).length;
  }

  function hostName(entry) {
    const who = identity.get(entry.hostUid);
    return who ? who.name : null;
  }

  function emitTo(entry, uid, event, payload) {
    const reg = entry.registrations.get(uid);
    if (reg && reg.socketId) io.to(reg.socketId).emit(event, payload);
  }

  function emitAll(entry, event, payload) {
    for (const reg of entry.registrations.values()) {
      if (reg.socketId) io.to(reg.socketId).emit(event, payload);
    }
  }

  // The list is personalised: a card has to know whether this tournament is
  // already yours, so it can offer Open or Rejoin instead of a Join button
  // that late registration will close. io.emit cannot do that, so the rows are
  // built per socket. A home game has a handful of them.
  function emitList() {
    for (const socket of connectedSockets()) {
      socket.emit('tournamentList', listFor(socket.data && socket.data.uid));
    }
  }

  // Everyone connected gets the state from their own point of view. The
  // legacy `tournamentField` event carries the same payload until the client
  // has moved to `tournamentState`.
  function emitState(entry) {
    for (const [uid, reg] of entry.registrations) {
      if (!reg.socketId) continue;
      const state = stateFor(entry, uid);
      io.to(reg.socketId).emit('tournamentState', state);
      io.to(reg.socketId).emit('tournamentField', state);
    }
  }

  function requireHost(entry, uid) {
    return !!uid && uid === entry.hostUid;
  }

  // ── Views ────────────────────────────────────────────────────────────────

  function summarize(entry) {
    const d = entry.director;
    const humans = entry.registrations.size;
    const total = d.entrants.length;
    return {
      id: entry.id,
      code: entry.code,
      name: entry.name,
      status: entry.status,
      createdAt: entry.createdAt,
      startsAt: entry.startsAt,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      hostName: hostName(entry),
      entrants: { humans, total },
      tableSize: d.tableSize,
      startChips: d.startChips,
      levelDuration: d.tournament.levelDuration,
      lateRegLevels: d.lateRegLevels,
      lateRegOpen: d.lateRegOpen(),
      level: d.tournament.currentLevel + 1,
      remaining: entry.status === 'registering' ? total : d.playersRemaining(),
      buyIn: d.buyIn,
      prizePool: d.prizePool(),
      winner: d.finished ? d.finished.winner : null,
      // Kept for the pre-lobby client's list shape.
      running: entry.status === 'running',
      finished: entry.status === 'finished',
    };
  }

  function publicList() {
    return [...tournaments.values()].map(summarize);
  }

  function listFor(uid) {
    return [...tournaments.values()].map((entry) => ({
      ...summarize(entry),
      you: {
        registered: entry.registrations.has(uid) && !entry.registrations.get(uid).left,
        // Left the table but the stack is still in play: the card offers a way
        // back, and it must not depend on late registration being open.
        left: !!(entry.registrations.has(uid) && entry.registrations.get(uid).left),
        eliminated: entry.watching.has(uid),
      },
    }));
  }

  function stateFor(entry, uid) {
    const d = entry.director;
    const reg = entry.registrations.get(uid) || null;
    const seat = d.playerByUid(uid);
    const place = d.tournament.eliminations.find((e) => e.uid === uid);
    const roster = d.roster().map((row) => {
      const r = entry.registrations.get(row.uid);
      return {
        ...row,
        isHost: row.uid === entry.hostUid,
        connected: !!(r && r.socketId),
      };
    });
    return {
      ...d.fieldSummary(uid),
      id: entry.id,
      code: entry.code,
      name: entry.name,
      status: entry.status,
      startsAt: entry.startsAt,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      waitingReason: entry.waitingReason,
      host: { uid: entry.hostUid, name: hostName(entry) },
      isHost: requireHost(entry, uid),
      settings: { ...entry.settings },
      you: {
        uid,
        playerId: seat ? seat.player.id : reg && reg.socketId ? reg.socketId : null,
        registered: !!reg && !reg.left,
        left: !!(reg && reg.left),
        seated: !!seat,
        eliminated: entry.watching.has(uid),
        place: place ? place.place : null,
        watchingTable: entry.watching.has(uid)
          ? (d.tables.find((t) => t.id === entry.watching.get(uid)) || {}).tableNumber || null
          : null,
      },
      roster,
    };
  }

  // ── Tables ───────────────────────────────────────────────────────────────

  // Seated humans get their table's state; so does anyone watching that table
  // after busting. An unseated viewer already yields a spectator view from
  // getStateForPlayer (no hole cards, no turn).
  function recipientsFor(entry, table) {
    const out = [];
    for (const p of table.players) {
      const reg = entry.registrations.get(p.uid);
      if (reg && reg.socketId) out.push({ socketId: reg.socketId, playerId: p.id });
    }
    for (const [uid, tableId] of entry.watching) {
      if (tableId !== table.id) continue;
      const reg = entry.registrations.get(uid);
      if (reg && reg.socketId) out.push({ socketId: reg.socketId, playerId: reg.socketId });
    }
    return out;
  }

  function wireTable(entry, table) {
    table.hostPlayerId = entry.hostUid;
    table.onUpdate = (g) => {
      // The hand history goes out on the first push after it changes and is
      // left off every push in between. It is the great bulk of a state
      // payload and a hand's worth of it is identical for the whole street,
      // so sending it per action was rebuilding and restringifying the same
      // ten hands for every seat on every bet.
      //
      // Tracked per recipient rather than per table, because a socket that
      // arrives mid-hand has nothing cached and must be sent the history on
      // its first push. A table-wide flag cannot see that: the arriving client
      // would take whichever routine push happened to reach it first and sit
      // there with no history until the hand ended.
      const version = g.handHistory ? g.handHistory.version : 0;
      if (g._historyVersionSent !== version) {
        g._historyVersionSent = version;
        g._historySentTo = new Set();
      }
      for (const r of recipientsFor(entry, g)) {
        const includeHistory = !g._historySentTo.has(r.socketId);
        if (includeHistory) g._historySentTo.add(r.socketId);
        io.to(r.socketId).emit('gameState', g.getStateForPlayer(r.playerId, { includeHistory }));
      }
    };
    table.onMessage = (msg, meta) => {
      for (const r of recipientsFor(entry, table)) {
        io.to(r.socketId).emit('gameMessage', msg, meta || null);
      }
    };
  }

  // A watcher whose table emptied moves to the biggest table left.
  function repointWatchers(entry) {
    const d = entry.director;
    for (const [uid, tableId] of entry.watching) {
      const table = d.tables.find((t) => t.id === tableId);
      if (table && table.players.length > 0) continue;
      const biggest = [...d.tables]
        .filter((t) => t.players.length > 0)
        .sort((a, b) => b.players.length - a.players.length)[0];
      if (biggest) entry.watching.set(uid, biggest.id);
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  function clampSettings(payload = {}) {
    const int = (v, fallback) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : fallback;
    };
    const t = now();
    let startsAt = int(payload.startsAt, t);
    if (startsAt < t - 60 * 1000 || startsAt > t + WEEK_MS) startsAt = t;
    const startChips = int(payload.startChips, 5000);
    return {
      startsAt,
      settings: {
        tableSize: Math.max(2, Math.min(10, int(payload.tableSize, 9))),
        startChips: START_CHIPS.includes(startChips) ? startChips : 5000,
        levelDuration: Math.max(30, Math.min(3600, int(payload.levelDuration, 300))),
        lateRegLevels: Math.max(0, Math.min(8, int(payload.lateRegLevels, 3))),
        buyIn: Math.max(0, Math.min(10000, int(payload.buyIn, 0))),
      },
    };
  }

  function create(uid, payload = {}, socket) {
    const who = identity.get(uid);
    if (!who) return { error: 'Identify first' };
    if (findByUid(uid, { includeLeft: true })) return { error: 'You are already in a tournament' };
    if (tournaments.size >= maxTournaments) return { error: 'Too many tournaments running' };

    const name = sanitizeName(payload.name || 'Tournament', 24) || 'Tournament';
    const { startsAt, settings } = clampSettings(payload);
    const entry = buildEntry({ name, startsAt, hostUid: uid, settings });
    entry.director.register({
      id: socket ? socket.id : null,
      uid,
      name: who.name,
      avatar: who.avatar,
    });
    entry.registrations.set(uid, {
      socketId: null,
      disconnectedAt: null,
      joinedAt: now(),
      left: false,
    });
    tournaments.set(entry.id, entry);
    if (socket) bind(entry, uid, socket);
    persist();
    emitList();
    return { entry };
  }

  // The entry and its director, with every callback wired. Shared by create()
  // and restore().
  function buildEntry({ id = null, code = null, name, startsAt, hostUid, settings, createdAt }) {
    const entry = {
      id,
      code: code || makeCode(),
      name,
      status: 'registering',
      createdAt: createdAt || now(),
      startsAt,
      startedAt: null,
      finishedAt: null,
      hostUid,
      settings,
      director: null,
      registrations: new Map(),
      watching: new Map(),
      timer: null,
      waitingReason: null,
      noHumansSince: null,
    };
    const director = new TournamentDirector({
      id: id || undefined,
      tableSize: settings.tableSize,
      startChips: settings.startChips,
      buyIn: settings.buyIn,
      levelDuration: settings.levelDuration,
      lateRegLevels: settings.lateRegLevels,
      handPauseMs,
      gameOptions: { gameMode: 'tournament', ...tableOptions },
      onTableCreated: (table) => wireTable(entry, table),
      onMessage: (msg) => emitAll(entry, 'gameMessage', msg),
      onPlayerMoved: (move) => emitTo(entry, move.uid, 'tableMoved', move),
      // The field has settled after a hand: write it down.
      onSnapshot: () => persist(),
      onFieldUpdate: () => {
        repointWatchers(entry);
        emitState(entry);
      },
      onPlayerEliminated: ({ uid: outUid, place, tableId }) => {
        entry.watching.set(outUid, tableId);
        const prize = director.payouts().find((p) => p.place === place);
        emitTo(entry, outUid, 'tournamentEliminated', {
          place,
          entrants: director.entrants.length,
          prize: prize ? prize.amount : 0,
          inTheMoney: !!prize,
          lateRegOpen: director.lateRegOpen(),
        });
      },
      onFinished: (result) => {
        entry.status = 'finished';
        entry.finishedAt = now();
        if (entry.timer) {
          timers.clearInterval(entry.timer);
          entry.timer = null;
        }
        const results = director.finalResults();
        for (const [regUid, reg] of entry.registrations) {
          if (!reg.socketId) continue;
          const mine = results.find((r) => r.name === (identity.get(regUid) || {}).name) || null;
          io.to(reg.socketId).emit('tournamentFinished', {
            ...result,
            results,
            you: mine ? { place: mine.place, prize: mine.prize } : null,
          });
        }
        emitState(entry);
        emitList();
      },
    });
    entry.id = director.id;
    entry.director = director;
    return entry;
  }

  function join(uid, { code, tournamentId } = {}, socket) {
    const who = identity.get(uid);
    if (!who) return { error: 'Identify first' };
    const entry = (code ? byCode(code) : null) || tournaments.get(tournamentId) || null;
    if (!entry) return { error: 'Tournament not found' };

    const existing = entry.registrations.get(uid);
    if (existing) {
      // Back for more: a player rejoins their own seat. bind() takes it off
      // sit-out, the same as any other return.
      existing.left = false;
      if (socket) bind(entry, uid, socket, { resumed: true });
      emitState(entry);
      emitList();
      return { entry };
    }
    if (findByUid(uid, { includeLeft: true })) return { error: 'You are already in a tournament' };
    if (entry.status === 'finished') return { error: 'That tournament is over' };
    const key = normalizeNameKey(who.name);
    if (entry.director.entrants.some((e) => normalizeNameKey(e.name) === key)) {
      return { error: 'Name already taken in this tournament' };
    }
    const entrant = { id: socket ? socket.id : null, uid, name: who.name, avatar: who.avatar };
    if (entry.status === 'registering') {
      entry.director.register(entrant);
    } else if (entry.director.lateRegOpen()) {
      try {
        entry.director.registerLate(entrant);
      } catch (err) {
        return { error: err.message };
      }
    } else {
      return { error: 'Late registration is closed' };
    }
    entry.registrations.set(uid, {
      socketId: null,
      disconnectedAt: null,
      joinedAt: now(),
      left: false,
    });
    if (socket) bind(entry, uid, socket);
    persist();
    emitState(entry);
    emitList();
    return { entry };
  }

  // A seat sits out when its player drops, leaves or lets the clock run out.
  // None of those are a decision to sit out, so being back at the keyboard
  // undoes them: the seat plays again without anyone having to notice a badge
  // and press a button. A seat the player deliberately sat out stays sitting
  // out, because that one *was* the decision.
  //
  // If it is their turn when they land, the clock has to be handed back too:
  // the pending sit-out timer will see a non-automated seat and bail without
  // acting, leaving the turn with nothing driving it.
  function resumeSeat(seat) {
    const { table, player } = seat;
    if (!player.autoPlay || player.sitOutReason === 'requested') return false;
    player.autoPlay = false;
    player.sitOutReason = null;
    table.emitMessage(`${player.name} is back at the table`, { kind: 'system' });
    const idx = table.players.findIndex((p) => p.id === player.id);
    if (table.isRunning && idx === table.currentPlayerIndex) table.beginCurrentTurn();
    else table.emitUpdate();
    return true;
  }

  // Bind a socket to its registration. On a rejoin the seated player's id is
  // rebound to the new socket, exactly as the room layer does on reconnect,
  // so every socket-id-keyed path in the engine and the client keeps working.
  function bind(entry, uid, socket, { resumed = false } = {}) {
    const reg = entry.registrations.get(uid);
    if (!reg) return false;
    reg.socketId = socket.id;
    reg.disconnectedAt = null;
    reg.left = false;
    entry.noHumansSince = null;
    socket.data.tournamentId = entry.id;
    socket.data.tournamentUid = uid;
    const entrant = entry.director.entrants.find((e) => e.uid === uid);
    if (entrant) entrant.id = socket.id;
    const seat = entry.director.playerByUid(uid);
    if (seat) {
      seat.player.id = socket.id;
      seat.player.isConnected = true;
      seat.player.disconnectedAt = null;
      resumeSeat(seat);
    }
    socket.emit('tournamentJoined', {
      id: entry.id,
      code: entry.code,
      uid,
      host: requireHost(entry, uid),
      name: entry.name,
      status: entry.status,
      you: { uid, playerId: socket.id },
      resumed,
    });
    const state = stateFor(entry, uid);
    socket.emit('tournamentState', state);
    socket.emit('tournamentField', state);
    if (seat) seat.table.emitUpdate();
    else if (entry.watching.has(uid)) {
      const table = entry.director.tables.find((t) => t.id === entry.watching.get(uid));
      if (table) socket.emit('gameState', table.getStateForPlayer(socket.id));
    }
    if (resumed) emitState(entry);
    return true;
  }

  // The socket went away. The registration stays; the sweep decides later
  // whether anyone is coming back. Lifted from the room layer's disconnect.
  function unbind(entry, uid, socket) {
    const reg = entry.registrations.get(uid);
    if (!reg || reg.socketId !== socket.id) return;
    reg.socketId = null;
    reg.disconnectedAt = now();
    const seat = entry.director.playerByUid(uid);
    if (seat) {
      const { table, player } = seat;
      player.isConnected = false;
      player.disconnectedAt = now();
      let refreshed = false;
      if (table.isRunning && !player.folded && !player.allIn) {
        if (!player.autoPlay) {
          player.autoPlay = true;
          player.sitOutReason = 'disconnect';
          player.isReady = false;
          table.emitMessage(`${player.name} is sitting out after a dropped connection`, {
            kind: 'system',
          });
        }
        const idx = table.players.findIndex((p) => p.id === player.id);
        if (idx === table.currentPlayerIndex && table.isAutomatedPlayer(player)) {
          table.beginCurrentTurn();
          refreshed = true;
        }
      }
      if (!refreshed) table.emitUpdate();
    }
    if (connectedHumans(entry) === 0) entry.noHumansSince = now();
    emitState(entry);
  }

  function unregister(entry, uid, socket) {
    if (entry.status !== 'registering') return { error: 'The tournament has started' };
    const reg = entry.registrations.get(uid);
    if (!reg) return { error: 'You are not registered' };
    entry.director.unregister(uid);
    entry.registrations.delete(uid);
    if (socket) {
      socket.data.tournamentId = null;
      socket.data.tournamentUid = null;
      socket.emit('leftTournament', { id: entry.id, reason: 'unregistered' });
    }
    if (entry.registrations.size === 0) {
      remove(entry, 'empty');
      return { entry };
    }
    if (uid === entry.hostUid) transferHost(entry, { force: true });
    persist();
    emitState(entry);
    emitList();
    return { entry };
  }

  // Leaving a running tournament: the stack cannot leave, so the seat stays
  // sitting out and the registration is marked as left. Auto-return will
  // not pull them back in; joining by code rebinds their own seat.
  function leave(entry, uid, socket) {
    if (entry.status === 'registering') return unregister(entry, uid, socket);
    const reg = entry.registrations.get(uid);
    if (!reg) return { error: 'You are not registered' };
    if (socket && reg.socketId === socket.id) unbind(entry, uid, socket);
    reg.left = true;
    const seat = entry.director.playerByUid(uid);
    if (seat) {
      // Walking out settles anything the seat had queued: a line armed for a
      // turn they will not be here for, and a sit-out they have overtaken.
      seat.player.preAction = null;
      seat.player.sitOutNextHand = false;
    }
    if (seat && !seat.player.autoPlay) {
      seat.player.autoPlay = true;
      seat.player.sitOutReason = 'left';
      seat.table.emitMessage(`${seat.player.name} left the table and is sitting out`, {
        kind: 'system',
      });
      seat.table.emitUpdate();
    }
    if (socket) {
      socket.data.tournamentId = null;
      socket.data.tournamentUid = null;
      socket.emit('leftTournament', { id: entry.id, reason: 'left' });
    }
    emitState(entry);
    return { entry };
  }

  function startNow(entry, uid) {
    if (!requireHost(entry, uid)) return { error: 'Only the host can start the tournament' };
    if (entry.status !== 'registering') return { error: 'Already started' };
    if (entry.director.entrants.length < 2) return { error: 'Need at least 2 entrants' };
    start(entry);
    return { entry };
  }

  function cancel(entry, uid) {
    if (!requireHost(entry, uid)) return { error: 'Only the host can cancel the tournament' };
    if (entry.status === 'finished') return { error: 'Already finished' };
    cancelEntry(entry, 'cancelled by the host');
    return { entry };
  }

  // Everything start() does except the draw: the field is already seated from
  // a snapshot, so only the clock and the tick need starting.
  function resume(entry) {
    entry.status = 'running';
    entry.startedAt = entry.startedAt || now();
    entry.waitingReason = null;
    entry.timer = timers.setInterval(() => {
      try {
        entry.director.tick();
        emitState(entry);
      } catch (err) {
        emitAll(entry, 'gameMessage', `Tournament halted: ${err.message}`);
        remove(entry, 'halted');
      }
    }, TICK_MS);
    if (entry.timer && entry.timer.unref) entry.timer.unref();
  }

  function start(entry) {
    entry.director.start();
    entry.status = 'running';
    entry.startedAt = now();
    entry.waitingReason = null;
    entry.timer = timers.setInterval(() => {
      try {
        entry.director.tick();
        emitState(entry);
      } catch (err) {
        emitAll(entry, 'gameMessage', `Tournament halted: ${err.message}`);
        remove(entry, 'halted');
      }
    }, TICK_MS);
    if (entry.timer && entry.timer.unref) entry.timer.unref();
    persist();
    emitState(entry);
    emitList();
  }

  function cancelEntry(entry, reason) {
    emitAll(entry, 'tournamentCancelled', { id: entry.id, name: entry.name, reason });
    remove(entry, reason);
  }

  function remove(entry) {
    if (entry.timer) {
      timers.clearInterval(entry.timer);
      entry.timer = null;
    }
    entry.director.stop();
    tournaments.delete(entry.id);
    persist();
    emitList();
  }

  // Host goes to the earliest-registered connected human when the host has
  // been gone past the grace, or at once when the host leaves. Compared by
  // uid, never by name.
  function transferHost(entry, { force = false } = {}) {
    const current = entry.registrations.get(entry.hostUid);
    if (!force && current && current.socketId && !current.left) return false;
    if (!force && current && !current.left) {
      const gone = now() - (current.disconnectedAt || now());
      if (gone < hostTransferGraceMs) return false;
    }
    const next = [...entry.registrations.entries()]
      .filter(([uid, r]) => uid !== entry.hostUid && !r.left && r.socketId)
      .sort((a, b) => a[1].joinedAt - b[1].joinedAt)[0];
    if (!next) return false;
    entry.hostUid = next[0];
    for (const table of entry.director.tables) table.hostPlayerId = entry.hostUid;
    const who = identity.get(entry.hostUid);
    entry.director._say(`${who ? who.name : 'Someone'} is now the host`);
    persist();
    emitState(entry);
    emitList();
    return true;
  }

  function findByUid(uid, { includeLeft = false } = {}) {
    if (!uid) return null;
    for (const entry of tournaments.values()) {
      if (entry.status === 'finished') continue;
      const reg = entry.registrations.get(uid);
      if (reg && (includeLeft || !reg.left)) return entry;
    }
    return null;
  }

  // ── The sweep ────────────────────────────────────────────────────────────

  function sweep() {
    const t = now();
    for (const entry of [...tournaments.values()]) {
      if (entry.status === 'registering') {
        if (entry.registrations.size === 0) {
          remove(entry, 'empty');
          continue;
        }
        if (t >= entry.startsAt) {
          if (entry.director.entrants.length >= 2) {
            start(entry);
          } else if (t - entry.startsAt > overdueAbandonMs) {
            cancelEntry(entry, 'nobody else came');
          } else if (!entry.waitingReason) {
            entry.waitingReason = 'Waiting for one more entrant';
            emitState(entry);
          }
        }
        transferHost(entry);
      } else if (entry.status === 'running') {
        transferHost(entry);
        if (
          connectedHumans(entry) === 0 &&
          entry.noHumansSince !== null &&
          t - entry.noHumansSince > abandonGraceMs
        ) {
          remove(entry, 'abandoned');
        }
      } else if (entry.status === 'finished') {
        if (t - entry.finishedAt > finishedTtlMs) remove(entry, 'expired');
      }
    }
    sweeps++;
    if (sweeps % Math.max(1, Math.round(60000 / sweepMs)) === 0 && identity.expireIdle) {
      identity.expireIdle();
    }
  }

  function startSweep() {
    if (sweepTimer) return;
    sweepTimer = timers.setInterval(sweep, sweepMs);
    if (sweepTimer && sweepTimer.unref) sweepTimer.unref();
  }

  function stop() {
    flush();
    if (sweepTimer) {
      timers.clearInterval(sweepTimer);
      sweepTimer = null;
    }
    for (const entry of tournaments.values()) {
      if (entry.timer) timers.clearInterval(entry.timer);
      entry.timer = null;
      entry.director.stop();
    }
  }

  // Rebuild registering tournaments from the store at boot. Everyone comes
  // back unbound: they identify and are rebound. The first sweep starts
  // anything that is overdue.
  function restore() {
    if (!store) return 0;
    let restored = 0;
    for (const saved of store.load()) {
      if (!saved || !saved.id || tournaments.has(saved.id)) continue;
      const { settings } = clampSettings({ ...saved.settings, startsAt: saved.startsAt });
      const entry = buildEntry({
        id: saved.id,
        code: saved.code,
        name: saved.name,
        startsAt: Number(saved.startsAt) || now(),
        hostUid: saved.hostUid,
        settings,
        createdAt: saved.createdAt,
      });
      for (const e of saved.entrants || []) {
        // A file written before the bots were removed carries them; skip those
        // rows rather than choking on a tournament that is otherwise fine.
        if (e.isNPC) continue;
        entry.director.register({ id: null, uid: e.uid, name: e.name, avatar: e.avatar || null });
      }
      for (const r of saved.registrations || []) {
        if (!r || !r.uid) continue;
        entry.registrations.set(r.uid, {
          socketId: null,
          disconnectedAt: null,
          joinedAt: r.joinedAt || entry.createdAt,
          left: false,
        });
      }
      if (entry.registrations.size === 0) continue;
      if (!entry.registrations.has(entry.hostUid)) {
        entry.hostUid = [...entry.registrations.keys()][0];
      }
      // A tournament that was mid-play when the process went down is seated
      // again from the field it recorded between hands. Every seat comes back
      // sitting out and is taken over by its player when they reconnect, so a
      // field nobody returns to plays itself out rather than hanging.
      if (saved.status === 'running' && saved.field) {
        try {
          if (entry.director.restoreFrom(saved.field)) {
            for (const table of entry.director.tables) wireTable(entry, table);
            resume(entry);
          }
        } catch (_err) {
          // A field that will not seat is not worth taking the whole
          // tournament down for; it falls back to its registrations.
        }
      }
      tournaments.set(entry.id, entry);
      restored++;
    }
    if (restored) emitList();
    return restored;
  }

  startSweep();

  return {
    tournaments,
    create,
    join,
    bind,
    unbind,
    unregister,
    leave,
    startNow,
    cancel,
    stateFor,
    listFor,
    publicList,
    findByUid,
    byCode,
    requireHost,
    sweep,
    restore,
    flush,
    stop,
  };
}

module.exports = { createTournamentRegistry, TICK_MS };

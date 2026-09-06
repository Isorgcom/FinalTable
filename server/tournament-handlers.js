// tournament-handlers.js - socket layer for multi-table tournaments.
//
// Deliberately separate from socket-handlers.js. The single-table game works
// and is untouched by any of this; a tournament is a different object with a
// different lifecycle, and folding it into the existing room handlers would
// have put the working game at risk for no benefit.
//
// The one thing that makes this tractable: table state already reaches players
// by socket id (io.to(player.id)), not by socket.io room. So when the director
// moves someone to another table, their socket simply starts receiving state
// from the new table. There is no room membership to migrate.

const { TournamentDirector } = require('../director');
const { getAvailableNPCs } = require('../npc');
const random = require('../random');

const TICK_MS = 1200;

function registerTournamentHandlers(deps) {
  const { io, sanitizeName, sanitizeAvatar, maxTournaments = 8 } = deps;

  // tournamentId -> { director, hostUid, name, seats: Map(uid -> socketId), timer }
  const tournaments = new Map();

  function publicList() {
    return [...tournaments.values()].map((t) => ({
      id: t.director.id,
      name: t.name,
      entrants: t.director.entrants.length,
      running: t.director.isRunning,
      finished: !!t.director.finished,
      tableSize: t.director.tableSize,
      buyIn: t.director.buyIn,
    }));
  }

  function broadcastList() {
    io.emit('tournamentList', publicList());
  }

  // Every seated human gets the field summary from their own point of view:
  // their rank, their table, their stack. One broadcast, personalised.
  function broadcastField(entry) {
    for (const [uid, socketId] of entry.seats) {
      io.to(socketId).emit('tournamentField', entry.director.fieldSummary(uid));
    }
  }

  function socketIdFor(entry, uid) {
    return entry.seats.get(uid) || null;
  }

  // Wire a table so its state reaches the humans sitting at it. Same shape as
  // the single-table server uses, which is what lets a moved player keep
  // receiving updates with no resubscription.
  function wireTable(entry, table) {
    table.onUpdate = (g) => {
      for (const p of g.players) {
        if (p.isNPC) continue;
        const sid = socketIdFor(entry, p.uid);
        if (sid) io.to(sid).emit('gameState', g.getStateForPlayer(p.id));
      }
    };
    table.onMessage = (msg, meta) => {
      for (const p of table.players) {
        if (p.isNPC) continue;
        const sid = socketIdFor(entry, p.uid);
        if (sid) io.to(sid).emit('gameMessage', msg, meta || null);
      }
    };
  }

  // Bot entrants. There are only ~22 distinct profiles and getAvailableNPCs
  // caps two per source, so a large field reuses them with a numeric suffix
  // rather than silently seating fewer bots than asked for.
  function makeBotEntrants(count) {
    const pool = getAvailableNPCs(Math.min(count, 22));
    const bots = [];
    for (let i = 0; i < count; i++) {
      const profile = pool[i % pool.length];
      if (!profile) break;
      const round = Math.floor(i / pool.length);
      bots.push({
        id: random.randomId('npc_'),
        uid: random.randomId('u_'),
        name: round === 0 ? profile.name : `${profile.name} ${round + 1}`,
        isNPC: true,
        npcProfile: profile,
      });
    }
    return bots;
  }

  function stopTournament(entry) {
    if (entry.timer) {
      clearInterval(entry.timer);
      entry.timer = null;
    }
    entry.director.stop();
  }

  io.on('connection', (socket) => {
    socket.emit('tournamentList', publicList());

    socket.on('listTournaments', () => socket.emit('tournamentList', publicList()));

    socket.on('createTournament', (payload = {}) => {
      if (tournaments.size >= maxTournaments) {
        socket.emit('error', { message: 'Too many tournaments running' });
        return;
      }
      const name = sanitizeName(payload.name || 'Tournament', 24) || 'Tournament';
      const playerName = sanitizeName(payload.playerName);
      if (!playerName) {
        socket.emit('error', { message: 'Enter a name first' });
        return;
      }
      const tableSize = Math.max(2, Math.min(10, parseInt(payload.tableSize, 10) || 9));
      const botCount = Math.max(0, Math.min(60, parseInt(payload.botCount, 10) || 0));
      const buyIn = Math.max(0, Math.min(10000, parseInt(payload.buyIn, 10) || 0));
      const startChips = [1000, 2000, 5000, 10000].includes(parseInt(payload.startChips, 10))
        ? parseInt(payload.startChips, 10)
        : 5000;
      const levelDuration = Math.max(
        30,
        Math.min(3600, parseInt(payload.levelDuration, 10) || 300)
      );

      const hostUid = random.randomId('u_');
      const entry = {
        name,
        hostUid,
        seats: new Map([[hostUid, socket.id]]),
        timer: null,
        director: null,
      };

      const director = new TournamentDirector({
        tableSize,
        startChips,
        buyIn,
        levelDuration,
        gameOptions: {},
        onTableCreated: (table) => wireTable(entry, table),
        onMessage: (msg) => {
          for (const sid of entry.seats.values()) io.to(sid).emit('gameMessage', msg);
        },
        onPlayerMoved: (move) => {
          const sid = socketIdFor(entry, move.uid);
          if (sid) io.to(sid).emit('tableMoved', move);
        },
        onFieldUpdate: () => broadcastField(entry),
        onFinished: (result) => {
          for (const sid of entry.seats.values()) {
            io.to(sid).emit('tournamentFinished', {
              ...result,
              results: director.finalResults(),
            });
          }
          stopTournament(entry);
          broadcastList();
        },
      });
      entry.director = director;

      director.register({
        id: socket.id,
        uid: hostUid,
        name: playerName,
        avatar: sanitizeAvatar(payload.playerAvatar),
      });
      for (const bot of makeBotEntrants(botCount)) director.register(bot);

      tournaments.set(director.id, entry);
      socket.data.tournamentId = director.id;
      socket.data.tournamentUid = hostUid;
      socket.emit('tournamentJoined', { id: director.id, uid: hostUid, host: true, name });
      broadcastList();
    });

    socket.on('joinTournament', (payload = {}) => {
      const entry = tournaments.get(payload.tournamentId);
      if (!entry) {
        socket.emit('error', { message: 'Tournament not found' });
        return;
      }
      if (entry.director.isRunning) {
        socket.emit('error', { message: 'Tournament already started' });
        return;
      }
      const playerName = sanitizeName(payload.playerName);
      if (!playerName) {
        socket.emit('error', { message: 'Enter a name first' });
        return;
      }
      const uid = random.randomId('u_');
      entry.seats.set(uid, socket.id);
      entry.director.register({
        id: socket.id,
        uid,
        name: playerName,
        avatar: sanitizeAvatar(payload.playerAvatar),
      });
      socket.data.tournamentId = entry.director.id;
      socket.data.tournamentUid = uid;
      socket.emit('tournamentJoined', {
        id: entry.director.id,
        uid,
        host: false,
        name: entry.name,
      });
      broadcastList();
    });

    socket.on('startTournament', () => {
      const entry = tournaments.get(socket.data.tournamentId);
      if (!entry) return;
      if (socket.data.tournamentUid !== entry.hostUid) {
        socket.emit('error', { message: 'Only the tournament host can start it' });
        return;
      }
      if (entry.director.isRunning) return;
      if (entry.director.entrants.length < 2) {
        socket.emit('error', { message: 'Need at least 2 entrants' });
        return;
      }
      entry.director.start();
      broadcastField(entry);
      broadcastList();
      entry.timer = setInterval(() => {
        try {
          entry.director.tick();
          broadcastField(entry);
        } catch (err) {
          for (const sid of entry.seats.values()) {
            io.to(sid).emit('gameMessage', `Tournament halted: ${err.message}`);
          }
          stopTournament(entry);
        }
      }, TICK_MS);
      if (entry.timer.unref) entry.timer.unref();
    });

    // Actions are routed by uid, never by a cached table: a player's table
    // changes when the field is balanced and their socket id changes on
    // reconnect, so the seat has to be looked up fresh every time.
    function routeAction(payload = {}) {
      const entry = tournaments.get(socket.data.tournamentId);
      if (!entry) return;
      const VALID = ['fold', 'check', 'call', 'raise', 'allin'];
      if (!VALID.includes(payload.action)) return;
      const amount = payload.amount;
      if (amount !== undefined && (typeof amount !== 'number' || amount < 0 || !isFinite(amount))) {
        return;
      }
      const seat = entry.director.playerByUid(socket.data.tournamentUid);
      if (!seat) return;
      seat.table.handleAction(seat.player.id, payload.action, amount);
    }

    // The table UI emits 'action' -- it is the same felt, the same buttons, and
    // it has no idea whether it is showing a cash table or a tournament one.
    // Listening only for 'tournamentAction' meant every click was swallowed by
    // the single-table handler (which finds no room and returns), so the seat
    // sat idle until the 90-second timeout acted for the player. Both names are
    // accepted; the single-table listener still ignores tournament sockets
    // because there is no room of that id.
    socket.on('action', routeAction);
    socket.on('tournamentAction', routeAction);

    // Same seat lookup as an action: the table can change between requests.
    socket.on('requestTime', () => {
      const entry = tournaments.get(socket.data.tournamentId);
      if (!entry) return;
      const seat = entry.director.playerByUid(socket.data.tournamentUid);
      if (!seat) return;
      seat.table.requestTimeExtension(seat.player.id);
    });

    socket.on('requestTournamentField', () => {
      const entry = tournaments.get(socket.data.tournamentId);
      if (!entry) return;
      socket.emit('tournamentField', entry.director.fieldSummary(socket.data.tournamentUid));
    });

    socket.on('leaveTournament', () => {
      const entry = tournaments.get(socket.data.tournamentId);
      if (!entry) return;
      entry.seats.delete(socket.data.tournamentUid);
      socket.data.tournamentId = null;
      socket.data.tournamentUid = null;
      if ([...entry.seats.keys()].length === 0) {
        stopTournament(entry);
        tournaments.delete(entry.director.id);
      }
      broadcastList();
    });

    socket.on('disconnect', () => {
      const entry = tournaments.get(socket.data.tournamentId);
      if (!entry) return;
      // Keep the seat: a disconnected player's chips stay in play and their
      // socket id is rebound if they come back. Only drop the mapping.
      const uid = socket.data.tournamentUid;
      if (uid && entry.seats.get(uid) === socket.id) entry.seats.delete(uid);
      if (entry.seats.size === 0) {
        stopTournament(entry);
        tournaments.delete(entry.director.id);
        broadcastList();
      }
    });
  });

  return { tournaments, publicList };
}

module.exports = { registerTournamentHandlers };

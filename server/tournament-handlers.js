// tournament-handlers.js - socket events for multi-table tournaments.
//
// A thin shim: every event resolves the socket's identity and tournament,
// then hands off to server/tournament-registry.js, which owns the lifecycle.
// Deliberately separate from socket-handlers.js: the single-table room code
// remains for its tests and is not touched by any of this.
//
// Table state reaches players by socket id (io.to(player.id)), not by
// socket.io room, so a player moved between tables simply starts receiving
// state from the new table. There is no room membership to migrate.

const { createTournamentRegistry } = require('./tournament-registry');

function registerTournamentHandlers(deps) {
  const { io, identity } = deps;
  const registry = createTournamentRegistry(deps);

  function fail(socket, error) {
    socket.emit('error', { message: error });
  }

  function entryFor(socket) {
    return registry.tournaments.get(socket.data.tournamentId) || null;
  }

  function seatFor(socket) {
    const entry = entryFor(socket);
    if (!entry) return null;
    return entry.director.playerByUid(socket.data.tournamentUid);
  }

  io.on('connection', (socket) => {
    // socket.io recovered this connection (same id, same data) after a short
    // drop: rebind the seat the disconnect handler released.
    if (socket.recovered && socket.data.tournamentId && socket.data.tournamentUid) {
      const entry = entryFor(socket);
      if (entry) registry.bind(entry, socket.data.tournamentUid, socket, { resumed: true });
    }
    socket.emit('tournamentList', registry.publicList());

    socket.on('listTournaments', () => socket.emit('tournamentList', registry.publicList()));

    // First thing on every connect, reconnects included. Establishes who the
    // socket is and, when that person has a live registration, rebinds it.
    socket.on('identify', (payload = {}) => {
      const ident = identity.identify({
        token: payload.token,
        name: payload.name,
        avatar: payload.avatar,
      });
      if (!ident) return fail(socket, 'Enter a name first');
      socket.data.uid = ident.uid;
      const entry = registry.findByUid(ident.uid);
      let resume = null;
      if (entry) {
        registry.bind(entry, ident.uid, socket, { resumed: true });
        resume = { id: entry.id, code: entry.code, name: entry.name, status: entry.status };
      }
      socket.emit('identified', { ...ident, resume });
    });

    socket.on('createTournament', (payload = {}) => {
      const { error } = registry.create(socket.data.uid, payload, socket);
      if (error) fail(socket, error);
    });

    socket.on('joinTournament', (payload = {}) => {
      const { error } = registry.join(socket.data.uid, payload, socket);
      if (error) fail(socket, error);
    });

    function startNow() {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.startNow(entry, socket.data.uid);
      if (error) fail(socket, error);
    }
    socket.on('startTournamentNow', startNow);
    socket.on('startTournament', startNow); // pre-lobby client

    socket.on('cancelTournament', () => {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.cancel(entry, socket.data.uid);
      if (error) fail(socket, error);
    });

    socket.on('unregisterTournament', () => {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.unregister(entry, socket.data.uid, socket);
      if (error) fail(socket, error);
    });

    function leave() {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.leave(entry, socket.data.uid, socket);
      if (error) fail(socket, error);
    }
    socket.on('leaveTournament', leave);
    socket.on('exitGame', leave); // the table's menu says "exit"

    function sendState() {
      const entry = entryFor(socket);
      if (!entry) return;
      const state = registry.stateFor(entry, socket.data.tournamentUid);
      socket.emit('tournamentState', state);
      socket.emit('tournamentField', state); // pre-lobby client
    }
    socket.on('requestTournamentState', sendState);
    socket.on('requestTournamentField', sendState);

    // The mobile resume path: mark us present again and resend everything.
    socket.on('requestState', () => {
      const entry = entryFor(socket);
      if (!entry) return;
      registry.bind(entry, socket.data.tournamentUid, socket, { resumed: true });
    });

    // Actions are routed by uid, never by a cached table: a player's table
    // changes when the field is balanced and their socket id changes on
    // reconnect, so the seat has to be looked up fresh every time.
    function routeAction(payload = {}) {
      const VALID = ['fold', 'check', 'call', 'raise', 'allin'];
      if (!VALID.includes(payload.action)) return;
      const amount = payload.amount;
      if (amount !== undefined && (typeof amount !== 'number' || amount < 0 || !isFinite(amount))) {
        return;
      }
      const seat = seatFor(socket);
      if (!seat) return;
      seat.table.handleAction(seat.player.id, payload.action, amount);
    }
    // The table UI emits 'action' whatever kind of table it is showing; the
    // single-table listener ignores tournament sockets (no room of that id).
    socket.on('action', routeAction);
    socket.on('tournamentAction', routeAction);

    socket.on('requestTime', () => {
      const seat = seatFor(socket);
      if (!seat) return;
      seat.table.requestTimeExtension(seat.player.id);
    });

    socket.on('setAutoPlay', (payload = {}) => {
      const seat = seatFor(socket);
      if (!seat) return;
      const { table, player } = seat;
      const enabled = payload.enabled !== false;
      if (player.autoPlay === enabled) return;
      player.autoPlay = enabled;
      player.isReady = false;
      table.emitMessage(`${player.name} ${enabled ? 'is sitting out' : 'is back at the table'}`, {
        kind: 'system',
      });
      const idx = table.players.findIndex((p) => p.id === player.id);
      if (enabled && table.isRunning && idx === table.currentPlayerIndex) table.beginCurrentTurn();
      else table.emitUpdate();
    });

    socket.on('disconnect', () => {
      const entry = entryFor(socket);
      if (!entry) return;
      registry.unbind(entry, socket.data.tournamentUid, socket);
    });
  });

  return { registry, tournaments: registry.tournaments, publicList: registry.publicList };
}

module.exports = { registerTournamentHandlers };

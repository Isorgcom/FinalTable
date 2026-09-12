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

// How many wrong passwords a single socket may offer before it stops being
// asked. Low, because there is nothing to guess at but one string, and a
// self-hosted box has no other brake on a client hammering an event.
const ADMIN_MAX_ATTEMPTS = 5;
const ADMIN_FAIL_DELAY_MS = 400;

function registerTournamentHandlers(deps) {
  const { io, identity } = deps;
  const registry = createTournamentRegistry(deps);
  // The operator password: the environment's, or one an operator has since set
  // from the Operator page. No password at all means the admin surface does
  // not exist, rather than existing with a default. It is never sent to a
  // client, logged, or put in state. See server/admin-credential.js.
  const adminCredential = deps.adminCredential || { isEnabled: () => false, verify: () => false };
  const adminEnabled = adminCredential.isEnabled();
  // The GameNight sign-in bridge. Read live on every use: the operator can
  // pair, refresh or unpair while the server runs. Unpaired, a GameNight
  // token is simply not a way in.
  const sso = deps.sso || { get: () => null, status: () => ({ paired: false }) };
  const log = typeof deps.log === 'function' ? deps.log : () => {};

  const version = typeof deps.version === 'string' ? deps.version : '';
  // The build of index.html and its scripts this server hands out. A page
  // compares it with the one it was served with; a phone that kept a tab
  // alive across a deploy is otherwise old code talking to a new server.
  const assetVersion = typeof deps.assetVersion === 'string' ? deps.assetVersion : '';

  function serverInfo() {
    const live = sso.get();
    return {
      version,
      assetVersion,
      adminAvailable: adminEnabled,
      // The set the strip draws, or null when the surface does not exist.
      reactions: registry.reactions,
      gamenight: live
        ? { connectUrl: live.config.connectUrl, audience: live.config.audience }
        : null,
    };
  }

  function fail(socket, error) {
    socket.emit('error', { message: error });
  }

  function notice(socket, message) {
    socket.emit('tournamentNotice', { message });
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
    // The same for somebody who was waiting at the door of an invite-only game.
    if (socket.recovered && socket.data.pendingTournamentId && socket.data.pendingUid) {
      const waiting = registry.tournaments.get(socket.data.pendingTournamentId);
      if (waiting) registry.bindPending(waiting, socket.data.pendingUid, socket, { resumed: true });
    }
    // What this server offers, before the client has said who it is: whether
    // there is an operator surface, and whether a GameNight sign-in exists and
    // where it goes. Never the password, never the key.
    socket.emit('serverInfo', serverInfo());
    socket.emit('tournamentList', registry.listFor(socket.data.uid));

    socket.on('listTournaments', () =>
      socket.emit('tournamentList', registry.listFor(socket.data.uid))
    );

    // First thing on every connect, reconnects included. Establishes who the
    // socket is and, when that person has a live registration, rebinds it.
    //
    // Three ways to say it. A guest sends a name and, after the first time, the
    // token it was given. A player just back from GameNight sends the signed
    // token from the URL, once. A linked browser reconnecting sends its device
    // token with provider set, and no name: when that token has gone stale it
    // is told so, rather than quietly becoming a guest of the same name with a
    // different uid.
    socket.on('identify', (payload = {}) => {
      let ident = null;
      if (typeof payload.gnToken === 'string') {
        const live = sso.get();
        if (!live) {
          return socket.emit('identifyFailed', { provider: 'gamenight', reason: 'not_configured' });
        }
        const result = live.verifier.verify(payload.gnToken);
        if (!result.ok) {
          log({
            level: 'warn',
            event: 'gamenight_token_rejected',
            message: 'GameNight sign-in token rejected',
            data: { reason: result.reason, socketId: socket.id },
          });
          return socket.emit('identifyFailed', { provider: 'gamenight', reason: result.reason });
        }
        ident = identity.identifyFromGameNight({
          sub: result.claims.sub,
          name: result.claims.name,
          avatar: payload.avatar,
        });
        if (!ident)
          return socket.emit('identifyFailed', { provider: 'gamenight', reason: 'malformed' });
        log({
          level: 'info',
          event: 'gamenight_sign_in',
          message: 'Player signed in with GameNight',
          data: { uid: ident.uid, isNew: ident.isNew },
        });
      } else if (payload.provider === 'gamenight') {
        // No name on purpose: with no record for the token, identify() has
        // nothing to mint a guest from and answers null.
        ident = identity.identify({ token: payload.token, avatar: payload.avatar });
        if (!ident || ident.provider !== 'gamenight') {
          return socket.emit('identifyFailed', { provider: 'gamenight', reason: 'signed_out' });
        }
      } else {
        ident = identity.identify({
          token: payload.token,
          name: payload.name,
          avatar: payload.avatar,
        });
        if (!ident) return fail(socket, 'Enter a name first');
      }
      socket.data.uid = ident.uid;
      const entry = registry.findByUid(ident.uid);
      let resume = null;
      let pending = null;
      if (entry) {
        registry.bind(entry, ident.uid, socket, { resumed: true });
        resume = { id: entry.id, code: entry.code, name: entry.name, status: entry.status };
      } else {
        // Not in a game, but perhaps waiting to be let into one.
        const waiting = registry.findPendingByUid(ident.uid);
        if (waiting) {
          registry.bindPending(waiting, ident.uid, socket, { resumed: true });
          pending = { id: waiting.id, name: waiting.name };
        } else {
          // Or on the rail of one.
          const railing = registry.findWatcherByUid(ident.uid);
          if (railing) {
            registry.bindWatcher(railing, ident.uid, socket, { resumed: true });
            resume = { id: railing.id, name: railing.name, status: railing.status, watching: true };
          }
        }
      }
      // Whether the admin surface exists at all, so a client can decide
      // whether to offer it. Never the password, and never whether this socket
      // has already authenticated — that lives on the server.
      socket.emit('identified', { ...ident, resume, pending, adminAvailable: adminEnabled });
      // The list this socket got on connect was built before it had a uid, so
      // none of its cards knew they were this player's. Send it again.
      socket.emit('tournamentList', registry.listFor(ident.uid));
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

    // The door of an invite-only game. The asker can withdraw; the host lets
    // people in or turns them away. Refusals go back on `error`, like the
    // rest of the host's controls.
    socket.on('cancelRequest', () => {
      const waiting = registry.tournaments.get(socket.data.pendingTournamentId);
      if (!waiting) return;
      registry.withdraw(waiting, socket.data.pendingUid, socket);
    });

    // The rail: watch a game by its rail code, or by id when it is public.
    socket.on('watchTournament', (payload = {}) => {
      const { error } = registry.watch(
        socket.data.uid,
        { rail: payload.rail, tournamentId: payload.tournamentId },
        socket
      );
      if (error) fail(socket, error);
    });

    socket.on('watchTable', (payload = {}) => {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.watchTable(entry, socket.data.tournamentUid, payload.table);
      if (error) fail(socket, error);
    });

    socket.on('stopWatching', () => {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.unwatch(entry, socket.data.tournamentUid, socket);
      if (error) fail(socket, error);
    });

    // Re-entry after busting and the add-on at the first break. A refusal
    // here is an answer to a button the player pressed, so it goes out as a
    // notice they will see; `error` is only a log line once at the table.
    socket.on('reenterTournament', () => {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.reenter(entry, socket.data.tournamentUid, socket);
      if (error) notice(socket, error);
    });

    socket.on('takeAddOn', () => {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.takeAddOn(entry, socket.data.tournamentUid);
      if (error) notice(socket, error);
    });

    socket.on('admitPlayer', (payload = {}) => {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.admit(entry, socket.data.tournamentUid, String(payload.uid || ''));
      if (error) fail(socket, error);
    });

    socket.on('declinePlayer', (payload = {}) => {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.decline(
        entry,
        socket.data.tournamentUid,
        String(payload.uid || '')
      );
      if (error) fail(socket, error);
    });

    // The host's controls over a running game. Authorised in the registry;
    // refusals go back on `error` like the door's.
    socket.on('pauseTournament', () => {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.pause(entry, socket.data.tournamentUid);
      if (error) fail(socket, error);
    });

    socket.on('resumeTournament', () => {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.resume(entry, socket.data.tournamentUid);
      if (error) fail(socket, error);
    });

    socket.on('stepLevel', (payload = {}) => {
      const entry = entryFor(socket);
      const delta = Number(payload.delta);
      if (!entry || !delta) return;
      const { error } = registry.stepLevel(entry, socket.data.tournamentUid, delta);
      if (error) fail(socket, error);
    });

    socket.on('adjustClock', (payload = {}) => {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.adjustClock(entry, socket.data.tournamentUid, payload.seconds);
      if (error) fail(socket, error);
    });

    socket.on('removePlayer', (payload = {}) => {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.removePlayer(
        entry,
        socket.data.tournamentUid,
        String(payload.uid || '')
      );
      if (error) fail(socket, error);
    });

    socket.on('movePlayer', (payload = {}) => {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.movePlayer(
        entry,
        socket.data.tournamentUid,
        String(payload.uid || ''),
        parseInt(payload.table, 10)
      );
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
      if (!registry.bind(entry, socket.data.tournamentUid, socket, { resumed: true })) {
        registry.bindWatcher(entry, socket.data.tournamentUid, socket, { resumed: true });
      }
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
      // Asked for, so it survives a reconnect: resumeSeat() leaves this one
      // alone where it undoes a drop, a timeout or a walk-out.
      player.sitOutReason = enabled ? 'requested' : null;
      player.isReady = false;
      // Sitting out now settles anything that was waiting on later: an armed
      // line, and a sit-out that was queued for the next deal.
      if (enabled) {
        player.preAction = null;
        player.sitOutNextHand = false;
      }
      table.emitMessage(`${player.name} ${enabled ? 'is sitting out' : 'is back at the table'}`, {
        kind: 'system',
      });
      const idx = table.players.findIndex((p) => p.id === player.id);
      if (enabled && table.isRunning && idx === table.currentPlayerIndex) table.beginCurrentTurn();
      else table.emitUpdate();
    });

    // Arming a line for a turn that has not opened yet. It lives on the engine's
    // player record rather than in the page, so it survives a reload, a phone
    // locking itself and a dropped connection — which is most of why it is
    // worth having. Nothing about it is public, so the echo goes to this socket
    // alone rather than out to the table.
    socket.on('armPreAction', (payload = {}) => {
      const KINDS = ['checkfold', 'check', 'call', 'callany'];
      const kind = payload.kind == null ? null : payload.kind;
      if (kind !== null && !KINDS.includes(kind)) return;
      // A price-locked call carries the price it was armed at, and the engine
      // refuses to play it at any other. Integers, because chips are.
      let atBet = null;
      let atToCall = null;
      if (kind === 'call') {
        if (!Number.isInteger(payload.atBet) || payload.atBet < 0) return;
        if (!Number.isInteger(payload.atToCall) || payload.atToCall < 0) return;
        atBet = payload.atBet;
        atToCall = payload.atToCall;
      }
      const seat = seatFor(socket);
      if (!seat) return;
      const { table, player } = seat;
      if (player.autoPlay) return;
      // Arming is for a turn you do not have yet. With the action bar up the bar
      // is the way to act, and accepting both is how a click races the beat.
      const idx = table.players.findIndex((p) => p.id === player.id);
      if (table.isRunning && idx === table.currentPlayerIndex) return;
      const before = player.preAction;
      // No-op guard, as on setAutoPlay above: a state payload carries the last
      // ten hands, so an unguarded echo turns arm-spam into an amplifier.
      if (
        (before ? before.kind : null) === kind &&
        (before ? before.atBet : null) === atBet &&
        (before ? before.atToCall : null) === atToCall
      ) {
        return;
      }
      player.preAction = kind === null ? null : { kind, atBet, atToCall };
      socket.emit('gameState', table.getStateForPlayer(player.id, { includeHistory: false }));
    });

    // The deferred sit-out. Unlike setAutoPlay it leaves the hand in progress
    // alone; startRound consumes it. Strictly === true, where setAutoPlay reads
    // !== false: a malformed payload must not cost somebody a hand of blinds.
    socket.on('setSitOutNextHand', (payload = {}) => {
      const enabled = payload.enabled === true;
      const seat = seatFor(socket);
      if (!seat) return;
      const { table, player } = seat;
      if (!!player.sitOutNextHand === enabled) return;
      player.sitOutNextHand = enabled;
      socket.emit('gameState', table.getStateForPlayer(player.id, { includeHistory: false }));
    });

    // ── Operator controls ────────────────────────────────────────────────
    //
    // Caution worth stating: this server is meant to be reachable over plain
    // HTTP on a LAN, so the password crosses the wire in the clear. It is a
    // guard against the other people at the table, not against somebody who
    // can watch the network.
    socket.on('adminLogin', (payload = {}) => {
      if (!adminEnabled) return socket.emit('adminStatus', { ok: false, available: false });
      socket.data.adminAttempts = socket.data.adminAttempts || 0;
      if (socket.data.adminAttempts >= ADMIN_MAX_ATTEMPTS) {
        return socket.emit('adminStatus', { ok: false, available: true, lockedOut: true });
      }
      const ok = adminCredential.verify(String(payload.password || ''));
      if (ok) {
        socket.data.isAdmin = true;
        socket.data.adminAttempts = 0;
        return socket.emit('adminStatus', { ok: true, available: true });
      }
      socket.data.adminAttempts += 1;
      // A wrong answer costs a moment, so guessing is not free.
      setTimeout(() => {
        socket.emit('adminStatus', {
          ok: false,
          available: true,
          attemptsLeft: Math.max(0, ADMIN_MAX_ATTEMPTS - socket.data.adminAttempts),
        });
      }, ADMIN_FAIL_DELAY_MS);
    });

    // Change the operator password. Behind the unlock, and the current password
    // is asked for again: the unlock lives as long as the socket, and a tab
    // left open is not proof that the person at it knows the password. A
    // change signs out every other operator session, because whoever is being
    // locked out is the reason to change it.
    socket.on('adminSetPassword', (payload = {}) => {
      if (!adminEnabled || !socket.data.isAdmin) return;
      const error = adminCredential.change(
        String(payload.current || ''),
        String(payload.next || '')
      );
      if (error) return socket.emit('adminPasswordResult', { ok: false, error });
      for (const [id, other] of io.sockets.sockets) {
        if (id === socket.id || !other.data.isAdmin) continue;
        other.data.isAdmin = false;
        other.emit('adminStatus', { ok: false, available: true, signedOut: true });
      }
      socket.emit('adminPasswordResult', { ok: true });
    });

    // End a tournament that is already running. The host control for this only
    // exists in the waiting room, and the host of a running field may be a seat
    // that busted an hour ago, so without this there is no way to stop one
    // short of shell access.
    socket.on('adminCancelTournament', (payload = {}) => {
      if (!adminEnabled || !socket.data.isAdmin) return;
      const entry =
        (payload.id && registry.tournaments.get(payload.id)) || entryFor(socket) || null;
      if (!entry) return fail(socket, 'No tournament to cancel');
      const result = registry.forceCancel(entry, 'cancelled by the operator');
      if (result.error) return fail(socket, result.error);
    });

    // Every game on the server, listed or not, with its code: the Operator
    // page's list. Answered only to a socket that has unlocked the controls,
    // like the pairing below; anyone else gets silence.
    socket.on('adminListTournaments', () => {
      if (!adminEnabled || !socket.data.isAdmin) return;
      socket.emit('adminTournaments', { list: registry.operatorList() });
    });

    // The GameNight pairing, from the Operator page. All four answer on
    // adminGameNight, and a change is announced to every socket as a fresh
    // serverInfo so the button appears or goes without a reload. Nobody who
    // has not unlocked the admin controls gets an answer at all.
    function sendPairing(extra = {}) {
      socket.emit('adminGameNight', { ...sso.status(), ...extra });
    }
    function announcePairing() {
      io.emit('serverInfo', serverInfo());
    }
    socket.on('adminGetGameNight', () => {
      if (!adminEnabled || !socket.data.isAdmin) return;
      sendPairing();
    });
    socket.on('adminPairGameNight', async (payload = {}) => {
      if (!adminEnabled || !socket.data.isAdmin) return;
      try {
        await sso.pair(payload.url, payload.audience);
        announcePairing();
        sendPairing({ ok: true });
      } catch (err) {
        sendPairing({ ok: false, error: err.message });
      }
    });
    socket.on('adminRefreshGameNight', async () => {
      if (!adminEnabled || !socket.data.isAdmin) return;
      try {
        await sso.refresh();
        announcePairing();
        sendPairing({ ok: true });
      } catch (err) {
        sendPairing({ ok: false, error: err.message });
      }
    });
    socket.on('adminUnpairGameNight', () => {
      if (!adminEnabled || !socket.data.isAdmin) return;
      sso.unpair();
      announcePairing();
      sendPairing({ ok: true });
    });

    // Chat. Deliberately its own event rather than a kind of gameMessage: the
    // client picks sound effects and the result modal off substrings of a
    // gameMessage, so somebody typing "all-in" would play the all-in sound for
    // the whole table and "wins" would pop the winner screen.
    socket.on('chat', (payload = {}) => {
      if (!registry.chatEnabled) return;
      if (typeof payload.text !== 'string') return;
      const entry = entryFor(socket);
      if (!entry) return;
      // Where the host wants it: a table number or 'all'. Anything else is
      // dropped here, and the registry ignores it from anyone but the host.
      const to =
        payload.to === 'all'
          ? 'all'
          : Number.isInteger(payload.to) && payload.to > 0
            ? payload.to
            : undefined;
      const result = registry.postChat(entry, socket.data.tournamentUid, payload.text, socket, {
        to,
      });
      // A refusal goes back on its own event, not through fail(): the client
      // routes 'error' to a lobby dialog, and a rate limit is not a dialog.
      if (result.error) socket.emit('chatDenied', { reason: result.error });
    });

    // A reaction: one of a fixed set, thrown at the room. Refusals ride
    // chatDenied, because the reasons are chat's reasons and the note under
    // the composer is where a player already looks for them.
    socket.on('reaction', (payload = {}) => {
      if (!registry.reactionsEnabled) return;
      const entry = entryFor(socket);
      if (!entry) return;
      const result = registry.postReaction(entry, socket.data.tournamentUid, payload.emoji, socket);
      if (result.error) socket.emit('chatDenied', { reason: result.error });
    });

    socket.on('muteChat', (payload = {}) => {
      if (!registry.chatEnabled) return;
      const entry = entryFor(socket);
      if (!entry) return;
      const result = registry.setChatMute(
        entry,
        socket.data.tournamentUid,
        String(payload.uid || ''),
        payload.muted === true
      );
      if (result.error) return fail(socket, result.error);
    });

    socket.on('disconnect', () => {
      const waiting = registry.tournaments.get(socket.data.pendingTournamentId);
      if (waiting) registry.unbindPending(waiting, socket.data.pendingUid, socket);
      const entry = entryFor(socket);
      if (!entry) return;
      registry.unbind(entry, socket.data.tournamentUid, socket);
      registry.unbindWatcher(entry, socket.data.tournamentUid, socket);
    });
  });

  return { registry, tournaments: registry.tournaments, publicList: registry.publicList };
}

module.exports = { registerTournamentHandlers };

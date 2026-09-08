// socket-client.js - one socket for the life of the page.
//
// Created once when the lobby loads, never torn down. On every connect
// (reconnects included) the client says who it is with `identify`; the join
// proper happens on `identified`, in lobby.js. Everything the table needs
// from the socket is bound here; the lobby binds its own events through
// Lobby.* so the two halves stay separate.

function sanitizeLobbyPlayerName(value, maxLength = 16) {
  const cleaned = String(value || '')
    .normalize('NFKC')
    .replace(/[\p{Cc}<>]/gu, '')
    .replace(/[^\p{L}\p{N} ._'-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const truncated = [...cleaned].slice(0, maxLength).join('').trim();
  return /[\p{L}\p{N}]/u.test(truncated) ? truncated : '';
}

function ensureSocket() {
  if (socket) return socket;
  socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 30000,
  });

  // A resume when the tab comes back to the front.
  _visibilityHandler = () => {
    if (document.visibilityState !== 'visible' || !socket) return;
    if (!socket.connected) socket.connect();
    else if (window.__tournamentActive) socket.emit('requestState');
  };
  document.addEventListener('visibilitychange', _visibilityHandler);

  socket.on('connect', () => {
    if (window.Lobby) Lobby.identify();
  });
  socket.on('disconnect', () => {
    if (window.Lobby) Lobby.setConnection(false);
    if (gameState) addLog('⚠️ Disconnected, reconnecting...');
  });
  // Whether this server has an admin surface at all. The password is never
  // sent here and neither is any claim about being logged in; that is decided
  // per socket on the server and only ever answered to adminLogin.
  socket.on('adminStatus', (st) => {
    if (window.Admin) Admin.onStatus(st);
  });

  socket.on('identified', (ident) => {
    if (window.Admin) Admin.onIdentified(ident);
    if (window.Lobby) Lobby.onIdentified(ident);
  });
  socket.on('sessionReplaced', () => {
    if (window.Lobby) Lobby.onSessionReplaced();
  });

  // Lobby and tournament lifecycle
  socket.on('tournamentList', (list) => {
    if (window.Lobby) Lobby.onList(list);
  });
  socket.on('tournamentJoined', (info) => {
    if (window.Lobby) Lobby.onJoined(info);
  });
  // The roster is one list, the same for everyone in the tournament, so the
  // server broadcasts it on its own when it changes rather than folding a copy
  // into every personal state push. Held here and put back on the state, so
  // everything downstream still reads state.roster as a plain field.
  let _roster = [];
  let _lastState = null;
  socket.on('tournamentRoster', (payload) => {
    if (!payload || !Array.isArray(payload.roster)) return;
    _roster = payload.roster;
    // The personal push goes out before this one, so a client that has already
    // drawn the screen drew it without a roster. Hand it the state again with
    // the list attached rather than leaving the waiting room looking empty.
    if (_lastState && window.Lobby) {
      _lastState.roster = _roster;
      Lobby.onState(_lastState);
    }
  });
  socket.on('tournamentState', (state) => {
    if (state && !state.roster) state.roster = _roster;
    else if (state && Array.isArray(state.roster)) _roster = state.roster;
    _lastState = state;
    if (window.Lobby) Lobby.onState(state);
  });
  socket.on('leftTournament', (data) => {
    if (window.Lobby) Lobby.onLeft(data);
  });
  socket.on('tournamentCancelled', (data) => {
    if (window.Lobby) Lobby.onCancelled(data);
  });
  socket.on('tournamentEliminated', (data) => {
    if (window.Lobby) Lobby.onEliminated(data);
  });
  socket.on('tournamentLevelUp', () => {
    // The line itself arrives as a gameMessage from the server.
    SFX.play('turn');
  });
  if (window.TournamentField) TournamentField.bind(socket);

  // The table
  socket.on('gameState', (state) => {
    // The chime marks the action arriving, so it is latched on the edge rather
    // than on the state. Testing isMyTurn alone re-fired it for every push
    // that happened to land while the turn was still yours: pressing +30s, an
    // opponent dropping, someone toggling sit-out, or a tab-return resync.
    // hadState keeps it quiet on the first push of a session, which is the
    // page loading into a hand rather than the action reaching you.
    const hadState = !!gameState;
    const wasMyTurn = !!(gameState && gameState.isMyTurn);
    updateGameState(state);
    if (state.isMyTurn && !wasMyTurn && hadState) SFX.play('turn');
  });

  socket.on('gameMessage', (msg, meta) => {
    addLog(msg, meta);
    // Nothing about chips or cards is sounded here. Both are timed to their
    // animation instead: chips from flyChips, cards from the deal and the
    // board flip. A log line arrives on the socket tick, which for the board
    // is 420ms before the flip actually starts, so the old street click was
    // already ahead of the card it was meant to accompany.
    if (msg.includes('folds')) SFX.play('fold');
    else if (msg.includes('checks')) SFX.play('check');
    else if (msg.includes('all-in')) SFX.play('allin');
    else if (msg.includes('wins') || msg.includes('splits pot')) SFX.play('win');

    if (msg.includes('starts')) _resultShownThisRound = false;

    if (msg.includes('wins') || msg.includes('splits pot')) {
      if (!_resultShownThisRound) {
        _resultShownThisRound = true;
        setTimeout(() => showResult(), 800);
      }
    }
  });

  socket.on('nameChanged', (data) => {
    addLog(`✅ Name changed to: ${data.name}`);
  });

  socket.on('error', (data) => {
    const message = data && data.message ? data.message : 'Something went wrong';
    addLog('⚠️ ' + message);
    if (window.Lobby) Lobby.onError(message);
  });

  document.addEventListener('click', () => SFX.init(), { once: true });
  return socket;
}

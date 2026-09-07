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

  // Mobile keep-alive, and a resume when the tab comes back to the front.
  _heartbeatTimer = setInterval(() => {
    if (socket && socket.connected) socket.emit('heartbeat');
  }, 15000);
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
  socket.on('identified', (ident) => {
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
  socket.on('tournamentState', (state) => {
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
    const oldPhase = gameState ? gameState.phase : null;
    updateGameState(state);
    if (state.isMyTurn && oldPhase !== null) SFX.play('turn');
  });

  socket.on('gameMessage', (msg, meta) => {
    addLog(msg, meta);
    if (msg.includes('folds')) SFX.play('fold');
    else if (msg.includes('checks')) SFX.play('check');
    else if (msg.includes('calls')) SFX.play('call');
    else if (msg.includes('raises')) SFX.play('raise');
    else if (msg.includes('all-in')) SFX.play('allin');
    else if (msg.includes('wins') || msg.includes('splits pot')) SFX.play('win');
    else if (msg.includes('Flop') || msg.includes('Turn') || msg.includes('River'))
      SFX.play('deal');
    else if (msg.includes('starts')) SFX.play('deal');

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

  socket.on('handReplay', (hand) => {
    if (hand) renderReplayDetail(hand);
  });

  socket.on('error', (data) => {
    const message = data && data.message ? data.message : 'Something went wrong';
    addLog('⚠️ ' + message);
    if (window.Lobby) Lobby.onError(message);
  });

  document.addEventListener('click', () => SFX.init(), { once: true });
  return socket;
}

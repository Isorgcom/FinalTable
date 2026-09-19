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
    // The admin unlock is per socket on the server, so it goes with this one.
    // Said out loud here rather than discovered later by a page whose requests
    // are all being answered with silence.
    if (window.Admin) Admin.onDisconnected();
    if (window.Lobby) Lobby.setConnection(false);
    if (gameState) addLog('⚠️ Disconnected, reconnecting...');
  });
  // Whether this server has an admin surface at all. The password is never
  // sent here and neither is any claim about being logged in; that is decided
  // per socket on the server and only ever answered to adminLogin.
  socket.on('adminStatus', (st) => {
    if (window.Admin) Admin.onStatus(st);
    if (window.Lobby) Lobby.onAdminStatus(st);
  });
  // The GameNight pairing, answered only to a socket that has unlocked the
  // admin controls.
  socket.on('adminGameNight', (data) => {
    if (window.Lobby) Lobby.onAdminGameNight(data);
  });
  // Every game on the server, for the Admin page; the same unlock.
  socket.on('adminMail', (data) => {
    if (window.Lobby) Lobby.onAdminMail(data);
  });

  socket.on('adminServer', (data) => {
    if (window.Lobby) Lobby.onAdminServer(data);
  });

  socket.on('adminUsers', (data) => {
    if (window.Lobby) Lobby.onAdminUsers(data);
  });

  socket.on('adminUser', (data) => {
    if (window.Lobby) Lobby.onAdminUser(data);
  });

  socket.on('adminUserResult', (data) => {
    if (window.Lobby) Lobby.onAdminUserResult(data);
  });

  socket.on('adminTournaments', (data) => {
    if (window.Lobby) Lobby.onAdminTournaments(data);
  });
  // What the server has done, for the Log page. Same unlock as the rest.
  socket.on('adminLogRows', (data) => {
    if (window.Lobby) Lobby.onAdminLogRows(data);
  });
  // A player's own hands, asked for by the History tab's download buttons.
  // Signing up, signing in, forgetting a password: one answer for all of them,
  // and it never says whether a name has an account.
  socket.on('accountResult', (data) => {
    if (window.Lobby) Lobby.onAccountResult(data);
  });
  // The games this player has played that the server still keeps.
  socket.on('myGames', (data) => {
    if (window.Lobby) Lobby.onMyGames(data);
  });
  socket.on('handHistoryExport', (data) => {
    if (typeof onHandHistoryExport === 'function') onHandHistoryExport(data);
  });

  // What the server offers, sent before identify: whether an admin surface
  // exists and whether a GameNight sign-in does. Nothing about this socket.
  socket.on('serverInfo', (info) => {
    if (window.Lobby) Lobby.onServerInfo(info);
  });
  socket.on('identified', (ident) => {
    // Before the lobby, so a table resumed by this same event is already
    // rendering with the settings this person chose rather than with whatever
    // this browser happened to have.
    if (window.adoptPreferences) adoptPreferences(ident && ident.prefs);
    if (window.Admin) Admin.onIdentified(ident);
    if (window.Lobby) Lobby.onIdentified(ident);
  });
  // The server's answer to a save: what it kept, which is not always what was
  // asked for. Adopting it means a value this server would not store does not
  // sit in the browser looking as though it had been.
  socket.on('preferences', (prefs) => {
    if (window.adoptPreferences) adoptPreferences(prefs);
  });
  socket.on('identifyFailed', (data) => {
    if (window.Lobby) Lobby.onIdentifyFailed(data);
  });
  socket.on('sessionReplaced', () => {
    if (window.Lobby) Lobby.onSessionReplaced();
  });
  // The devices this account is signed in on, answered to the account itself.
  socket.on('sessions', (list) => {
    if (window.Lobby) Lobby.onSessions(list);
  });
  // This device has been signed out, from here or from another of them.
  socket.on('sessionEnded', (data) => {
    if (window.Lobby) Lobby.onSessionEnded(data);
  });

  // Lobby and tournament lifecycle
  socket.on('tournamentList', (list) => {
    if (window.Lobby) Lobby.onList(list);
  });
  socket.on('tournamentJoined', (info) => {
    if (window.Lobby) Lobby.onJoined(info);
  });
  // Asked to join an invite-only game: waiting on the host, or answered.
  socket.on('tournamentPending', (info) => {
    if (window.Lobby) Lobby.onPending(info);
  });
  socket.on('tournamentDeclined', (data) => {
    if (window.Lobby) Lobby.onDeclined(data);
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
  // The answer to a button: a refusal the player pressed for, so a dialog
  // rather than the log line `error` gets at the table.
  socket.on('tournamentNotice', (data) => {
    const message = data && data.message ? data.message : 'Something went wrong';
    addLog('⚠️ ' + message);
    if (typeof window.showNoticeDialog === 'function') {
      window.showNoticeDialog({ title: 'Tournament', message, confirmLabel: 'OK' });
    }
  });
  socket.on('tournamentReentered', (data) => {
    const where = data && data.table ? ` at table ${data.table}` : '';
    addLog(
      `🔁 You re-enter with ${data && data.chips ? data.chips.toLocaleString() : 'a fresh stack'}${where}`
    );
  });
  // Both ends of the add-on: the answer to the press, and the stack landing
  // afterwards when the seat was mid-hand. Over the felt as well as into the
  // log, because a player who has just pressed a button is owed something they
  // can see, and the log is not the tab the panel opens on.
  socket.on('tournamentAddOn', (data) => {
    const queued = !!(data && data.queued);
    const more = data && data.added ? data.added.toLocaleString() : 'a starting stack';
    const now = data && data.chips ? `, ${data.chips.toLocaleString()} in front of you` : '';
    const line = queued
      ? '➕ Your add-on lands at the end of this hand'
      : `➕ Add-on taken: ${more} more${now}`;
    addLog(line);
    if (typeof showHostNote === 'function') showHostNote(null, line.replace('➕ ', ''));
  });
  // The seat cannot go mid-hand, so the answer to the button is sometimes "at
  // the end of this one". At the table the elimination dialog says the rest;
  // pressed from a lobby card there is no table and no dialog coming, because
  // this socket is not in the game, so the answer is a notice of its own.
  socket.on('tournamentForfeited', (data) => {
    const queued = !!(data && data.queued);
    const screen = document.getElementById('gameScreen');
    if (screen && screen.classList.contains('active')) {
      if (queued) addLog('🏳️ You forfeit; your seat goes at the end of this hand');
      return;
    }
    if (typeof window.showNoticeDialog !== 'function') return;
    const place = data && data.place ? ` You finish #${data.place}.` : '';
    window.showNoticeDialog({
      title: 'Forfeited',
      message: queued
        ? 'Your seat goes at the end of the hand being played.'
        : `Your chips are out of play.${place} You can still watch the rest.`,
      confirmLabel: 'OK',
    });
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
    // A line the server marked for the felt: a seat that went without a hand
    // to explain it. The log keeps it; this is so somebody who never opens
    // that tab still sees it happen.
    if (meta && meta.felt && typeof showHostNote === 'function') showHostNote(null, msg);
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

  // Chat rides its own event rather than gameMessage, because the handler
  // above keys sound effects and the winner screen off substrings: somebody
  // typing "all-in" would otherwise play the all-in sound for the whole table.
  socket.on('chatMessage', (message) => {
    if (window.TableChat) TableChat.render(message);
  });

  // A reaction is drawn and gone; nothing else keeps it.
  socket.on('reaction', (payload) => {
    if (payload && typeof showSeatReaction === 'function') {
      showSeatReaction(payload.uid, payload.emoji);
    }
  });

  socket.on('chatHistory', (payload) => {
    if (window.TableChat) TableChat.renderHistory(payload);
  });

  // The host's view of every table's room. Nobody else is ever sent it.
  socket.on('chatField', (payload) => {
    if (window.TableChat) TableChat.renderField(payload);
  });

  socket.on('chatDenied', (payload) => {
    if (window.TableChat) TableChat.denied((payload && payload.reason) || 'Not sent');
  });

  socket.on('chatMuted', (payload) => {
    if (!window.TableChat) return;
    TableChat.setCanSend(!(payload && payload.muted), 'The host has muted you');
  });

  socket.on('nameChanged', (data) => {
    addLog(`✅ Name changed to: ${data.name}`);
  });

  socket.on('error', (data) => {
    const message = data && data.message ? data.message : 'Something went wrong';
    addLog('⚠️ ' + message);
    if (window.Lobby) Lobby.onError(message);
  });

  SFX.listen();
  return socket;
}

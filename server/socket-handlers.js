const crypto = require('crypto');
const random = require('../random');
const { createStructuredLogger } = require('./logger');
const { DEFAULT_MAX_PLAYERS } = require('../engine');

const socketLog = createStructuredLogger('socket');

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function registerSocketHandlers(deps) {
  const {
    io,
    games,
    sessionTokens,
    maxWsConnections,
    sanitizeName,
    normalizeNameKey,
    sanitizeAvatar,
    roomIdRegex,
    getOrCreateGame,
    loadGame,
    saveGame,
    deleteSave,
    listSaves,
    getNPCByName,
    NPC_PROFILES,
    Tournament,
    assignHost,
    clearHostTransferTimer,
    requireHost,
    scheduleHostTransfer,
    checkAndResetRoom,
  } = deps;

  function getHumanPlayers(game) {
    return game.players.filter((p) => !p.isNPC);
  }

  function hasHumanNameConflict(game, candidateName, exceptSocketId = null) {
    const candidateKey = normalizeNameKey(candidateName);
    if (!candidateKey) return false;
    return getHumanPlayers(game).some(
      (player) => player.id !== exceptSocketId && normalizeNameKey(player.name) === candidateKey
    );
  }

  function getDisplayName(playerOrProfile) {
    if (!playerOrProfile) return '';
    if (playerOrProfile.isWestern) {
      return playerOrProfile.nameEn || playerOrProfile.name || '';
    }
    if (playerOrProfile.isNPC && playerOrProfile.npcProfile && playerOrProfile.npcProfile.isWestern) {
      return playerOrProfile.npcProfile.nameEn || playerOrProfile.name || '';
    }
    return playerOrProfile.name || '';
  }

  function getNpcSeatLabel(profile) {
    const title = profile.isWestern ? profile.titleEn || profile.title : profile.title;
    const name = getDisplayName(profile);
    return `${title} ${name}`.trim();
  }

  function getReadyPlayers(game) {
    return getHumanPlayers(game).filter(
      (player) => player.uid !== game.hostPlayerId && !player.autoPlay
    );
  }

  function isReadyCheckRequired(game) {
    return (
      !!game &&
      game.gameMode !== 'practice' &&
      !game.isRunning &&
      game.roundCount === 0 &&
      getReadyPlayers(game).length >= 1
    );
  }

  function canAdjustReady(game) {
    return (
      !!game &&
      game.gameMode !== 'practice' &&
      !game.isRunning &&
      (game.roundCount === 0 || !!game.gameOver)
    );
  }

  function resetReadyStates(game) {
    getReadyPlayers(game).forEach((player) => {
      player.isReady = false;
    });
  }

  function areAllHumansReady(game) {
    const readyPlayers = getReadyPlayers(game);
    return readyPlayers.length === 0 || readyPlayers.every((player) => player.isReady);
  }

  function logSocketEvent(event, details = {}, level = 'info', message = '') {
    socketLog({
      level,
      event,
      roomId: details.roomId,
      message,
      data: details,
    });
  }

  io.on('connection', (socket) => {
    // WebSocket connection limit
    if (io.engine.clientsCount > maxWsConnections) {
      socket.emit('error', { message: 'Server at capacity, try again later' });
      socket.disconnect(true);
      return;
    }
    logSocketEvent(
      'socket_connected',
      { socketId: socket.id, connectedClients: io.engine.clientsCount },
      'info',
      'Socket connected'
    );

    // Rate limiting: max 30 events per second per client
    let _msgCount = 0;
    const _rateLimitInterval = setInterval(() => {
      _msgCount = 0;
    }, 1000);
    socket.use((packet, next) => {
      _msgCount++;
      if (_msgCount > 30) return next(new Error('Rate limit exceeded'));
      next();
    });
    socket.on('disconnect', () => clearInterval(_rateLimitInterval));

    socket.on('joinRoom', (payload = {}) => {
      const startedAt = nowMs();
      const {
        roomId,
        playerName,
        npcCount,
        smallBlind,
        startChips,
        playerAvatar,
        gameMode,
        sessionToken,
      } = payload;
      // Input validation
      if (!playerName || typeof playerName !== 'string') return;
      if (!roomId || typeof roomId !== 'string') return;
      const safeName = sanitizeName(playerName);
      const safeRoomId = roomId.trim().substring(0, 20);
      const safeAvatar = sanitizeAvatar(playerAvatar);
      if (!safeName || !safeRoomId) return;
      // A socket seated in a multi-table tournament must not be dropped into a
      // room by a stale client reconnect; its tournament seat is authoritative.
      if (socket.data.tournamentId) {
        socket.emit('error', { message: 'Leave the tournament first' });
        return;
      }
      if (!roomIdRegex.test(safeRoomId)) {
        logSocketEvent(
          'join_rejected',
          { socketId: socket.id, roomId: safeRoomId, reason: 'invalid_room_name' },
          'warn',
          'Join rejected'
        );
        socket.emit('error', { message: 'Invalid room name (letters, numbers, Chinese only)' });
        return;
      }
      const VALID_MODES = ['cash', 'tournament', 'practice'];
      const effectiveMode = VALID_MODES.includes(gameMode) ? gameMode : 'cash';
      // Cap is one below a full table: the requester takes a seat too. Was a
      // hardcoded 7 from the old 8-max default, which silently ignored the
      // 8th and 9th bot once tables grew to 10 seats.
      const maxNpcs = Math.max(0, DEFAULT_MAX_PLAYERS - 1);
      const requestedNpcCount = Math.max(0, Math.min(maxNpcs, parseInt(npcCount) || 0));
      const safeNpcCount =
        effectiveMode === 'practice' ? Math.max(1, requestedNpcCount) : requestedNpcCount;
      const safeSB = [5, 10, 25, 50].includes(parseInt(smallBlind)) ? parseInt(smallBlind) : 10;
      const safeChips = [500, 1000, 2000, 5000].includes(parseInt(startChips))
        ? parseInt(startChips)
        : 1000;

      // If room exists, inherit its settings (ignore new player settings)
      const existingGame = games.get(safeRoomId);
      const game =
        existingGame ||
        getOrCreateGame(safeRoomId, {
          smallBlind: safeSB,
          bigBlind: safeSB * 2,
          startChips: safeChips,
          gameMode: effectiveMode,
        });
      if (!game) {
        logSocketEvent(
          'join_rejected',
          { socketId: socket.id, roomId: safeRoomId, reason: 'room_limit_reached' },
          'warn',
          'Join rejected'
        );
        socket.emit('error', { message: 'Server room limit reached' });
        return;
      }

      // Mode mismatch: notify player of actual room mode
      if (existingGame && effectiveMode !== game.gameMode) {
        // Do not block join, just notify of actual mode
      }

      // Practice mode: single human only
      if (game.gameMode === 'practice') {
        const existingHumans = game.players.filter((p) => !p.isNPC);
        const session =
          sessionToken && typeof sessionToken === 'string' ? sessionTokens.get(sessionToken) : null;
        const isReconnect =
          session &&
          session.roomId === safeRoomId &&
          existingHumans.some((p) => p.name === session.playerName);
        if (existingHumans.length > 0 && !isReconnect) {
          logSocketEvent(
            'join_rejected',
            { socketId: socket.id, roomId: safeRoomId, reason: 'practice_room_full' },
            'warn',
            'Join rejected'
          );
          socket.emit('error', { message: 'Practice mode is single-player only' });
          return;
        }
      }

      // ── Token-based reconnection (secure) ──
      let existing = null;
      let isNewPlayer = false;
      if (sessionToken && typeof sessionToken === 'string' && sessionTokens.has(sessionToken)) {
        const session = sessionTokens.get(sessionToken);
        if (session.roomId === safeRoomId) {
          existing = game.players.find((p) => p.name === session.playerName && !p.isNPC);
        }
      }
      if (!existing && hasHumanNameConflict(game, safeName)) {
        logSocketEvent(
          'join_rejected',
          { socketId: socket.id, roomId: safeRoomId, playerName: safeName, reason: 'name_conflict' },
          'warn',
          'Join rejected'
        );
        socket.emit('error', { message: 'Name already taken in this room' });
        return;
      }

      let newToken;
      let effectivePlayerName = safeName;
      if (existing) {
        existing.id = socket.id;
        existing.isConnected = true;
        existing.disconnectedAt = null;
        existing.avatar = safeAvatar;
        effectivePlayerName = existing.name;
        // Reuse existing token or generate new one
        newToken =
          sessionToken && sessionTokens.has(sessionToken) ? sessionToken : crypto.randomUUID();
      } else {
        const player = game.addPlayer({ id: socket.id, name: safeName });
        if (!player) {
          logSocketEvent(
            'join_rejected',
            { socketId: socket.id, roomId: safeRoomId, playerName: safeName, reason: 'room_full' },
            'warn',
            'Join rejected'
          );
          socket.emit('error', { message: 'Room is full' });
          return;
        }
        player.avatar = safeAvatar;
        isNewPlayer = true;
        newToken = crypto.randomUUID();

        // Mid-game join: mark as folded spectator until next round
        if (game.isRunning) {
          player.folded = true;
          player.holeCards = [];
        }

        // Restore saved chips if save exists for this room
        const save = loadGame(safeRoomId);
        if (save) {
          const savedPlayer = save.players.find((sp) => sp.name === safeName && !sp.isNPC);
          if (savedPlayer) {
            player.chips = savedPlayer.chips;
            player.wins = savedPlayer.wins || 0;
            player.handsPlayed = savedPlayer.handsPlayed || 0;
          }
        }
      }

      // Register session token
      sessionTokens.set(newToken, {
        socketId: socket.id,
        roomId: safeRoomId,
        playerName: effectivePlayerName,
      });

      socket.join(safeRoomId);
      socket.data.roomId = safeRoomId;
      socket.data.playerName = effectivePlayerName;
      socket.data.sessionToken = newToken;

      assignHost(game);
      scheduleHostTransfer(safeRoomId, game);

      // Add NPCs if requested and first human player and no NPCs yet
      const humanCount = game.players.filter((p) => !p.isNPC).length;
      const npcExist = game.players.some((p) => p.isNPC);
      if (humanCount === 1 && safeNpcCount > 0 && !npcExist) {
        game.addNPCs(Math.min(safeNpcCount, game.maxPlayers - game.players.length));
      }

      // If game was stuck (showdown phase, not running), reset it so player can start fresh
      if (game.phase === 'showdown' && !game.isRunning) {
        game.phase = 'waiting';
      }

      socket.emit('joinedRoom', {
        roomId: safeRoomId,
        playerId: socket.id,
        sessionToken: newToken,
        state: game.getStateForPlayer(socket.id),
        // Tell client the actual room mode (may differ from requested)
        actualMode: game.gameMode,
        roomSettings: {
          smallBlind: game.smallBlind,
          bigBlind: game.bigBlind,
          startChips: game.startChips,
        },
      });

      // Notify all
      game.emitUpdate(game);
      let joinMsg = `${effectivePlayerName} joined the table`;
      if (isNewPlayer && game.isRunning) {
        joinMsg += ' (spectating, auto-join next hand)';
      }
      io.to(safeRoomId).emit('gameMessage', joinMsg);
      logSocketEvent(
        'join_room',
        {
          socketId: socket.id,
          roomId: safeRoomId,
          playerName: effectivePlayerName,
          gameMode: game.gameMode,
          isReconnect: !!existing,
          isSpectator: !!(isNewPlayer && game.isRunning),
          npcCount: game.players.filter((p) => p.isNPC).length,
          humanCount: game.players.filter((p) => !p.isNPC).length,
          durationMs: Math.round((nowMs() - startedAt) * 100) / 100,
        },
        'info',
        'Player joined room'
      );
    });

    socket.on('setReady', (payload = {}) => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const game = games.get(roomId);
      if (!game || !canAdjustReady(game)) return;

      const player = game.players.find((p) => p.id === socket.id && !p.isNPC);
      if (!player) return;
      if (player.uid === game.hostPlayerId) return;
      if (player.autoPlay) return;

      player.isReady = payload.ready !== false;
      game.emitUpdate(game);
      logSocketEvent(
        'ready_toggled',
        {
          socketId: socket.id,
          roomId,
          playerName: player.name,
          ready: player.isReady,
        },
        'info',
        'Ready state updated'
      );
    });

    socket.on('setAutoPlay', (payload = {}) => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const game = games.get(roomId);
      if (!game) return;

      const player = game.players.find((p) => p.id === socket.id && !p.isNPC);
      if (!player) return;

      const nextValue = payload.enabled !== false;
      if (player.autoPlay === nextValue) return;

      player.autoPlay = nextValue;
      if (nextValue) {
        player.isReady = false;
        io.to(roomId).emit('gameMessage', `${player.name} switched to auto-play`);
      } else {
        io.to(roomId).emit('gameMessage', `${player.name} resumed control`);
      }

      if (
        game.isRunning &&
        game.currentPlayerIndex === player.seatIndex &&
        !player.folded &&
        !player.allIn
      ) {
        game.beginCurrentTurn();
      } else {
        game.emitUpdate(game);
      }
      logSocketEvent(
        'autoplay_toggled',
        {
          socketId: socket.id,
          roomId,
          playerName: player.name,
          enabled: nextValue,
          gameMode: game.gameMode,
        },
        'info',
        'Auto-play toggled'
      );
    });

    socket.on('startGame', (payload = {}) => {
      const startedAt = nowMs();
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const game = games.get(roomId);
      if (!game) return;
      if (!requireHost(socket, game)) return;

      if (game.isRunning) {
        socket.emit('error', { message: 'Game in progress' });
        return;
      }

      if (game.players.filter((p) => p.chips > 0).length < 2) {
        socket.emit('error', { message: 'Need at least 2 players' });
        return;
      }

      if (isReadyCheckRequired(game) && !payload.force && !areAllHumansReady(game)) {
        socket.emit('error', { message: 'Not all players are ready' });
        return;
      }

      // Clear any leftover tournament state for cash game
      if (game.tournament) {
        game.tournament.stop();
        game.tournament = null;
      }

      resetReadyStates(game);
      game.startRound();
      logSocketEvent(
        'start_game',
        {
          socketId: socket.id,
          roomId,
          hostName: socket.data.playerName,
          gameMode: game.gameMode,
          force: !!payload.force,
          durationMs: Math.round((nowMs() - startedAt) * 100) / 100,
        },
        'info',
        'Host started game'
      );
    });

    // A player asks for more time on their own turn. The engine holds the
    // per-hand allowance, so a repeated request is simply refused.
    socket.on('requestTime', () => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const game = games.get(roomId);
      if (!game) return;
      if (!game.requestTimeExtension(socket.id)) {
        socket.emit('error', { message: 'No time left to request this hand' });
      }
    });

    socket.on('action', (payload = {}) => {
      const { action, amount } = payload;
      // Input validation
      const VALID_ACTIONS = ['fold', 'check', 'call', 'raise', 'allin'];
      if (!action || !VALID_ACTIONS.includes(action)) return;
      if (amount !== undefined && (typeof amount !== 'number' || amount < 0 || !isFinite(amount)))
        return;

      const roomId = socket.data.roomId;
      if (!roomId) return;
      const game = games.get(roomId);
      if (!game) return;

      try {
        const success = game.handleAction(socket.id, action, amount);
        if (!success) {
          logSocketEvent(
            'action_rejected',
            { socketId: socket.id, roomId, playerName: socket.data.playerName, action, amount },
            'warn',
            'Action rejected'
          );
          socket.emit('error', { message: 'Invalid action' });
        } else {
          logSocketEvent(
            'action_received',
            { socketId: socket.id, roomId, playerName: socket.data.playerName, action, amount },
            'info',
            'Action processed'
          );
        }
      } catch (e) {
        logSocketEvent(
          'action_error',
          { socketId: socket.id, roomId, playerName: socket.data.playerName, action, amount, error: e.message },
          'error',
          'Action failed'
        );
        socket.emit('error', { message: 'Server error processing action' });
      }
    });

    socket.on('nextRound', () => {
      const startedAt = nowMs();
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const game = games.get(roomId);
      if (!game || game.isRunning || game.gameOver) return;
      if (!requireHost(socket, game)) return;

      // Cancel auto-advance timer and start immediately
      if (game._autoTimer) {
        clearTimeout(game._autoTimer);
        game._autoTimer = null;
      }

      // Prep players
      if (game.tournament && game.tournament.isActive) {
        // Remove busted NPCs only, keep humans as spectators
        game.players = game.players.filter((p) => p.chips > 0 || !p.isNPC);
      } else {
        game.players = game.players.filter((p) => p.chips > 0 || !p.isNPC);
        game.players
          .filter((p) => p.isNPC && p.chips <= 0)
          .forEach((p) => {
            p.chips = game.startChips;
          });
      }
      game.players.forEach((p, i) => (p.seatIndex = i));

      if (game.players.filter((p) => p.chips > 0).length < 2) return;
      game.startRound();
      logSocketEvent(
        'next_round_started',
        {
          socketId: socket.id,
          roomId,
          hostName: socket.data.playerName,
          gameMode: game.gameMode,
          durationMs: Math.round((nowMs() - startedAt) * 100) / 100,
        },
        'info',
        'Host started next round'
      );
    });

    socket.on('addNPC', (data) => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const game = games.get(roomId);
      if (!game) return;
      if (!requireHost(socket, game)) return;
      if (game.isRunning) {
        socket.emit('error', { message: 'Game in progress, please wait' });
        return;
      }
      if (game.players.length >= game.maxPlayers) {
        socket.emit('error', { message: 'Table is full (max 8)' });
        return;
      }

      // Support adding a specific NPC by name
      let npcProfile = null;
      if (data && data.npcName) {
        npcProfile = getNPCByName(data.npcName);
        if (!npcProfile) {
          socket.emit('error', { message: 'NPC not found' });
          return;
        }
        // Check if this NPC is already at the table
        if (
          game.players.some((p) => p.isNPC && p.npcProfile && p.npcProfile.name === npcProfile.name)
        ) {
          socket.emit('error', { message: `${getDisplayName(npcProfile)} is already at the table` });
          return;
        }
        const player = game.addPlayer({
          id: random.randomId('npc_'),
          name: npcProfile.name,
          isNPC: true,
          npcProfile: npcProfile,
        });
        if (player) {
          game.emitUpdate(game);
          io.to(roomId).emit('gameMessage', `${getNpcSeatLabel(npcProfile)} takes a seat`);
          logSocketEvent(
            'npc_added',
            { socketId: socket.id, roomId, hostName: socket.data.playerName, npcName: getDisplayName(npcProfile) },
            'info',
            'Specific NPC added'
          );
        }
      } else {
        game.addNPCs(1);
        game.emitUpdate(game);
        io.to(roomId).emit('gameMessage', 'NPC player joined');
        logSocketEvent(
          'npc_added',
          { socketId: socket.id, roomId, hostName: socket.data.playerName, mode: 'random' },
          'info',
          'NPC added'
        );
      }
    });

    socket.on('removeNPC', (data) => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const game = games.get(roomId);
      if (!game) return;
      if (!requireHost(socket, game)) return;
      if (game.isRunning) {
        socket.emit('error', { message: 'Game in progress, please wait' });
        return;
      }

      let npc;
      if (data && data.npcName) {
        npc = game.players.find((p) => p.isNPC && p.name === data.npcName);
      } else {
        // Remove last NPC
        const npcs = game.players.filter((p) => p.isNPC);
        npc = npcs[npcs.length - 1];
      }
      if (npc) {
        game.removePlayer(npc.id);
        game.emitUpdate(game);
        io.to(roomId).emit('gameMessage', `${getDisplayName(npc)} left the table`);
        logSocketEvent(
          'npc_removed',
          { socketId: socket.id, roomId, hostName: socket.data.playerName, npcName: getDisplayName(npc) },
          'info',
          'NPC removed'
        );
      } else {
        socket.emit('error', { message: 'No NPC to remove' });
      }
    });

    // Send available NPC list to client
    socket.on('getNPCList', () => {
      socket.emit(
        'npcList',
        NPC_PROFILES.map((p) => ({
          name: p.name,
          nameEn: p.nameEn,
          style: p.style,
          title: p.title,
          titleEn: p.titleEn,
          bio: p.bio,
          bioEn: p.bioEn,
          origin: p.origin,
          originEn: p.originEn,
          avatar: p.avatar,
          isWestern: p.isWestern || false,
        }))
      );
    });

    // Exit game: remove player and go back to login
    // Gift chips to another player before exiting
    socket.on('giftChips', (payload = {}) => {
      const { targetName } = payload;
      const roomId = socket.data.roomId;
      if (!roomId) return;
      if (!targetName || typeof targetName !== 'string') return;
      const safeTarget = sanitizeName(targetName);
      if (!safeTarget) return;
      const game = games.get(roomId);
      if (!game) return;

      // Verify this socket is a valid player in this room
      const player = game.players.find((p) => p.id === socket.id && !p.isNPC);
      const target = game.players.find(
        (p) => p.name === safeTarget && !p.isNPC && p.id !== socket.id
      );
      if (game.isRunning) {
        socket.emit('error', { message: 'Game in progress' });
        return;
      }
      if (!player || !target || player.chips <= 0) {
        socket.emit('error', { message: 'CannotGift chips' });
        return;
      }

      const amount = player.chips;
      target.chips += amount;
      player.chips = 0;
      io.to(roomId).emit(
        'gameMessage',
        `🎁 ${player.name} gifted ${amount} chips to ${target.name}`
      );
      game.emitUpdate(game);
      socket.emit('giftDone');
      logSocketEvent(
        'chips_gifted',
        { socketId: socket.id, roomId, from: player.name, to: target.name, amount },
        'info',
        'Chips gifted'
      );
    });

    socket.on('exitGame', () => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const game = games.get(roomId);
      if (!game) return;

      const player = game.players.find((p) => p.id === socket.id);
      if (player) {
        const wasHost = player.uid === game.hostPlayerId;
        if (
          game.isRunning &&
          game.currentPlayerIndex === player.seatIndex &&
          !player.folded &&
          !player.allIn
        ) {
          game.handleAction(socket.id, 'fold');
        }
        player.folded = true;
        game.removePlayer(socket.id);
        io.to(roomId).emit('gameMessage', `${player.name} left the table`);
        const newHost = assignHost(game);
        if (wasHost) clearHostTransferTimer(game);
        if (wasHost && newHost) {
          io.to(roomId).emit('gameMessage', `${newHost.name} is now the room host`);
        }
        game.emitUpdate(game);

        // Check if all humans are gone → reset room
        checkAndResetRoom(roomId);
      }

      socket.leave(roomId);
      // Clean up session token
      if (socket.data.sessionToken) {
        sessionTokens.delete(socket.data.sessionToken);
      }
      socket.data.roomId = null;
      socket.data.playerName = null;
      socket.data.sessionToken = null;
      socket.emit('exitedGame');
      logSocketEvent(
        'exit_game',
        { socketId: socket.id, roomId, playerName: player ? player.name : null },
        'info',
        'Player exited game'
      );
    });

    // Restart game: reset all chips and game state
    socket.on('restartGame', () => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const game = games.get(roomId);
      if (!game) return;
      if (!requireHost(socket, game)) return;
      const preserveRematchReady = !!game.gameOver && game.gameMode !== 'practice';

      // Reset all players
      game.isRunning = false;
      game.phase = 'waiting';
      game.gameOver = null;
      game.communityCards = [];
      game.pot = 0;
      game.currentBet = 0;
      game.roundCount = 0;

      // Clear tournament and auto-advance
      if (game.tournament) {
        game.tournament.stop();
        game.tournament = null;
      }
      if (game._autoTimer) {
        clearTimeout(game._autoTimer);
        game._autoTimer = null;
      }

      for (const p of game.players) {
        p.chips = game.startChips;
        p.holeCards = [];
        p.bet = 0;
        p.totalBet = 0;
        p.folded = false;
        p.allIn = false;
        p.isReady =
          preserveRematchReady && !p.isNPC && p.uid !== game.hostPlayerId ? !!p.isReady : false;
        p.autoPlay = false;
        p.wins = 0;
        p.handsPlayed = 0;
      }
      game.players.forEach((p, i) => (p.seatIndex = i));

      io.to(roomId).emit('gameMessage', '🔄 Game reset! All chips restored.');
      game.emitUpdate(game);
      logSocketEvent(
        'game_restarted',
        { socketId: socket.id, roomId, hostName: socket.data.playerName, gameMode: game.gameMode },
        'info',
        'Game restarted'
      );
    });

    // Start tournament mode
    socket.on('startTournament', (opts = {}) => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const game = games.get(roomId);
      if (!game || game.isRunning) return;
      if (!requireHost(socket, game)) return;
      if (game.players.filter((p) => p.chips > 0).length < 2) {
        socket.emit('error', { message: 'Need at least 2 players' });
        return;
      }

      if (isReadyCheckRequired(game) && !opts.force && !areAllHumansReady(game)) {
        socket.emit('error', { message: 'Not all players are ready' });
        return;
      }

      game.tournament = new Tournament({
        levelDuration: Math.max(
          60,
          Math.min(600, parseInt((opts && opts.levelDuration) || 180) || 180)
        ),
      });

      // Reset all chips for tournament
      for (const p of game.players) {
        p.chips = game.startChips;
        p.isReady = false;
        p.wins = 0;
        p.handsPlayed = 0;
      }
      game.roundCount = 0;
      game.gameOver = null;
      game.leaderboard.reset();

      const blinds = game.tournament.start(game.players.length);
      game.smallBlind = blinds.sb;
      game.bigBlind = blinds.bb;

      // Level-up callback
      // The level line goes through the engine so it carries a log kind; the
      // client no longer adds its own copy on tournamentLevelUp.
      game.tournament.onLevelUp = (level, newBlinds) => {
        game.emitMessage(`⬆️ Blinds up! Level ${level + 1}: ${newBlinds.sb}/${newBlinds.bb}`, {
          kind: 'level',
        });
        io.to(roomId).emit('tournamentLevelUp', { level, blinds: newBlinds });
      };

      game.emitMessage(
        `🏆 Tournament starts! ${game.players.length} players, blinds ${blinds.sb}/${blinds.bb}`,
        { kind: 'system' }
      );
      game.startRound();
      logSocketEvent(
        'tournament_started',
        {
          socketId: socket.id,
          roomId,
          hostName: socket.data.playerName,
          levelDuration: game.tournament.levelDuration,
          smallBlind: blinds.sb,
          bigBlind: blinds.bb,
        },
        'info',
        'Tournament started'
      );
    });

    // Get hand replay
    socket.on('getReplay', (data) => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      if (
        !data ||
        typeof data.handNum !== 'number' ||
        !Number.isFinite(data.handNum) ||
        data.handNum < 0
      )
        return;
      const game = games.get(roomId);
      if (!game) return;
      const hand = game.handHistory.getHandForReplay(Math.floor(data.handNum));
      socket.emit('handReplay', hand);
    });

    // Get leaderboard
    socket.on('getLeaderboard', () => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const game = games.get(roomId);
      if (!game) return;
      socket.emit('leaderboardData', game.leaderboard.getRankings());
    });

    // Save game
    socket.on('saveGame', () => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const game = games.get(roomId);
      if (!game) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }
      if (!requireHost(socket, game)) return;
      if (game.isRunning) {
        socket.emit('error', { message: 'Wait for current hand to finish before saving' });
        return;
      }

      const ok = saveGame(roomId, game);
      if (ok) {
        io.to(roomId).emit('gameMessage', '💾 Game saved');
        socket.emit('gameSaved', { roomId });
        logSocketEvent(
          'game_saved',
          { socketId: socket.id, roomId, hostName: socket.data.playerName },
          'info',
          'Game saved'
        );
      } else {
        socket.emit('error', { message: 'Save failed' });
      }
    });

    // List saves (for lobby)
    socket.on('listSaves', () => {
      socket.emit('savesList', listSaves());
    });

    socket.on('deleteSave', (payload = {}) => {
      const { roomId: saveRoomId } = payload;
      const activeRoomId = socket.data.roomId;
      if (!activeRoomId) return;
      const game = games.get(activeRoomId);
      if (!game || !requireHost(socket, game)) return;
      if (!saveRoomId || typeof saveRoomId !== 'string') return;
      const safeId = saveRoomId.trim().substring(0, 20);
      if (!roomIdRegex.test(safeId)) return;
      if (safeId !== activeRoomId) {
        socket.emit('error', { message: 'Can only delete the current room save' });
        return;
      }
      const ok = deleteSave(safeId);
      if (ok) {
        socket.emit('saveDeleted', { roomId: saveRoomId });
        logSocketEvent(
          'save_deleted',
          { socketId: socket.id, roomId: saveRoomId, hostName: socket.data.playerName },
          'info',
          'Save deleted'
        );
      } else {
        socket.emit('error', { message: 'Delete save failed' });
      }
    });

    // In-game name change
    socket.on('changeName', (payload = {}) => {
      const { newName } = payload;
      const roomId = socket.data.roomId;
      if (!roomId || !newName || !newName.trim()) return;
      const game = games.get(roomId);
      if (!game) return;
      const name = sanitizeName(newName);
      if (!name) return;
      // Check for duplicate name
      if (hasHumanNameConflict(game, name, socket.id)) {
        socket.emit('error', { message: 'Name already taken' });
        return;
      }
      const player = game.players.find((p) => p.id === socket.id);
      if (!player || player.isNPC) return;
      const oldName = player.name;
      player.name = name;
      if (socket.data.sessionToken && sessionTokens.has(socket.data.sessionToken)) {
        const session = sessionTokens.get(socket.data.sessionToken);
        session.playerName = name;
        sessionTokens.set(socket.data.sessionToken, session);
      }
      socket.data.playerName = name;
      io.to(roomId).emit('gameMessage', `${oldName} renamed to ${name}`);
      game.emitUpdate(game);
      socket.emit('nameChanged', { name });
      logSocketEvent(
        'player_renamed',
        { socketId: socket.id, roomId, oldName, newName: name },
        'info',
        'Player renamed'
      );
    });

    // Mobile keep-alive: client sends heartbeat to prevent timeout
    socket.on('heartbeat', () => {
      /* no-op, keeps connection alive */
    });

    // Mobile resume: client requests fresh state after returning from background
    socket.on('requestState', () => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const game = games.get(roomId);
      if (!game) return;
      const player = game.players.find((p) => p.id === socket.id);
      if (player) {
        player.isConnected = true;
        socket.emit('gameState', game.getStateForPlayer(socket.id));
      }
    });

    // Speed control (practice mode only)
    socket.on('setSpeed', (payload = {}) => {
      const { speed } = payload;
      if (typeof speed !== 'number' || ![1, 2, 3].includes(speed)) return;
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const game = games.get(roomId);
      if (!game || game.gameMode !== 'practice') return;
      game.setSpeed(speed);
      game.emitUpdate(game);
    });

    // Pause / Resume (practice mode only)
    socket.on('pauseGame', () => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const game = games.get(roomId);
      if (!game || game.gameMode !== 'practice') return;
      game.pause();
    });

    socket.on('resumeGame', () => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const game = games.get(roomId);
      if (!game || game.gameMode !== 'practice') return;
      game.resume();
    });

    socket.on('disconnect', () => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const game = games.get(roomId);
      if (!game) return;

      const player = game.players.find((p) => p.id === socket.id);
      if (player) {
        player.isConnected = false;
        player.disconnectedAt = Date.now();
        io.to(roomId).emit('gameMessage', `${player.name} disconnected`);
        logSocketEvent(
          'socket_disconnected',
          { socketId: socket.id, roomId, playerName: player.name, wasHost: player.uid === game.hostPlayerId },
          'info',
          'Socket disconnected'
        );
        let refreshedTurnState = false;

        if (game.isRunning && !player.folded && !player.allIn) {
          if (!player.isNPC && !player.autoPlay) {
            player.autoPlay = true;
            player.isReady = false;
            io.to(roomId).emit('gameMessage', `${player.name} switched to auto-play after disconnect`);
          }
          const playerIdx = game.players.findIndex((p) => p.id === socket.id);
          if (playerIdx === game.currentPlayerIndex && game.isAutomatedPlayer(player)) {
            game.beginCurrentTurn();
            refreshedTurnState = true;
          }
        }

        if (!refreshedTurnState) game.emitUpdate(game);
        if (player.uid === game.hostPlayerId) {
          scheduleHostTransfer(roomId, game);
        }

        // Check if all humans disconnected → reset after short delay
        const roomCleanupTimer = setTimeout(() => checkAndResetRoom(roomId), 120000);
        if (roomCleanupTimer.unref) roomCleanupTimer.unref();
      }
    });
  });
}

module.exports = { registerSocketHandlers };

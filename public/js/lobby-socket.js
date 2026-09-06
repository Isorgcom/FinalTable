// ============================================================
//  ROOM LOBBY SYSTEM
// ============================================================

const PRESET_ROOM_LABELS = {
  长安: "Chang'an",
  金陵: 'Jinling',
  蓬莱: 'Penglai',
  洛阳: 'Luoyang',
  桃源: 'Peach Blossom Spring',
  兰亭: 'Orchid Pavilion',
  滕王阁: 'Pavilion of Prince Teng',
  岳阳楼: 'Yueyang Tower',
};
const PRESET_ROOM_NAMES = Object.keys(PRESET_ROOM_LABELS);
let _lobbyRoomsCache = [];
let _lobbySavesCache = [];
let _lobbyListenersBound = false;
let _lobbyDraftConfig = {
  mode: 'cash',
  npcCount: '3',
  startChips: '1000',
  smallBlind: '10',
};

function sanitizeLobbyPlayerName(value, maxLength = 16) {
  const cleaned = String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/[^\p{L}\p{N} ._'-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const truncated = [...cleaned].slice(0, maxLength).join('').trim();
  return /[\p{L}\p{N}]/u.test(truncated) ? truncated : '';
}

function generatePracticeRoomName() {
  return 'practice_' + Date.now().toString(36);
}

function getSelectedRoomId() {
  const roomId = document.getElementById('roomId');
  return roomId ? roomId.value.trim() : '';
}

function getRoomModeLabel(mode) {
  if (mode === 'practice') return 'Practice';
  if (mode === 'tournament') return 'Tournament';
  return 'Cash';
}

function appendRoomDisplayName(target, roomId) {
  target.textContent = roomId;
  const englishName = PRESET_ROOM_LABELS[roomId];
  if (!englishName) return;
  target.appendChild(document.createTextNode(' '));
  target.appendChild(createTextElement('span', 'room-card-name-en', englishName));
}

function getCreateRoomLabel(mode) {
  return mode === 'tournament' ? 'Create Tournament Room' : 'Create Cash Room';
}

function getJoinRoomLabel(mode) {
  return mode === 'tournament' ? 'Join Tournament Room' : 'Join Cash Room';
}

function getSelectRoomLabel(mode) {
  return mode === 'tournament' ? 'Select Tournament Room' : 'Select Cash Room';
}

function rememberLobbyDraftConfig() {
  const npcCount = document.getElementById('npcCount');
  const startChips = document.getElementById('startChips');
  const smallBlind = document.getElementById('smallBlind');
  if (npcCount && !npcCount.disabled) _lobbyDraftConfig.npcCount = npcCount.value;
  if (startChips && !startChips.disabled) _lobbyDraftConfig.startChips = startChips.value;
  if (smallBlind && !smallBlind.disabled) _lobbyDraftConfig.smallBlind = smallBlind.value;
  _lobbyDraftConfig.mode = _selectedGameMode;
}

function bindLobbyControlListeners() {
  if (_lobbyListenersBound) return;
  _lobbyListenersBound = true;
  ['npcCount', 'startChips', 'smallBlind'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      rememberLobbyDraftConfig();
      updateLobbySelectionUI();
    });
  });
}

function getSelectedRoomMeta(roomId = getSelectedRoomId()) {
  if (!roomId) return null;
  const activeRoom = _lobbyRoomsCache.find((room) => room.id === roomId);
  if (activeRoom) return { kind: 'active', ...activeRoom };
  const savedRoom = _lobbySavesCache.find((room) => room.roomId === roomId);
  if (savedRoom) return { kind: 'saved', id: savedRoom.roomId, ...savedRoom };
  if (PRESET_ROOM_NAMES.includes(roomId)) {
    const smallBlind = parseInt(_lobbyDraftConfig.smallBlind, 10) || 10;
    return {
      kind: 'new',
      id: roomId,
      roomId,
      gameMode: _selectedGameMode,
      npcCount: parseInt(_lobbyDraftConfig.npcCount, 10) || 0,
      startChips: parseInt(_lobbyDraftConfig.startChips, 10) || 1000,
      smallBlind,
      bigBlind: smallBlind * 2,
    };
  }
  return null;
}

function applyLobbySettings(settings = {}, locked = false) {
  const npcCount = document.getElementById('npcCount');
  const startChips = document.getElementById('startChips');
  const smallBlind = document.getElementById('smallBlind');
  if (npcCount && settings.npcCount !== undefined) npcCount.value = String(settings.npcCount);
  if (startChips && settings.startChips !== undefined) startChips.value = String(settings.startChips);
  if (smallBlind && settings.smallBlind !== undefined) smallBlind.value = String(settings.smallBlind);
  [npcCount, startChips, smallBlind].forEach((el) => {
    if (!el) return;
    el.disabled = locked;
    if (locked) el.setAttribute('disabled', 'disabled');
    else el.removeAttribute('disabled');
    el.closest('.form-group')?.classList.toggle('form-group-locked', locked);
  });
}

function unlockLobbySettings(settings = {}) {
  applyLobbySettings(settings, false);
}

function formatLobbySettingsLine(meta) {
  const sb = meta.smallBlind || 10;
  const bb = meta.bigBlind || sb * 2;
  const chips = meta.startChips || 1000;
  const npcCount = meta.npcCount || 0;
  return `${getRoomModeLabel(meta.gameMode)} · ${sb}/${bb} · ${chips} chips · ${npcCount} NPCs`;
}

function updateLobbySelectionUI() {
  const summary = document.getElementById('roomSelectionSummary');
  const nameEl = document.getElementById('roomSelectionName');
  const metaEl = document.getElementById('roomSelectionMeta');
  const seatBtn = document.getElementById('btnTakeASeat');
  if (!summary || !nameEl || !metaEl || !seatBtn) return;

  // A multi-table tournament has no room to select: the director creates and
  // owns its tables. Without this branch the room-selection updater runs after
  // selectMode and puts back a disabled "Select Cash Room" button.
  if (_selectedGameMode === 'multi') {
    unlockLobbySettings(
      {
        npcCount: parseInt(document.getElementById('npcCount').value, 10) || 17,
        startChips: _lobbyDraftConfig.startChips,
        smallBlind: _lobbyDraftConfig.smallBlind,
      },
      false
    );
    summary.dataset.state = 'practice';
    nameEl.textContent = 'Multi-Table Tournament';
    metaEl.textContent =
      'One field across several tables. Tables balance and break as players bust, down to a final table.';
    seatBtn.textContent = 'Start Tournament';
    seatBtn.disabled = false;
    return;
  }

  if (_selectedGameMode === 'practice') {
    unlockLobbySettings(
      {
        npcCount: Math.max(1, parseInt(_lobbyDraftConfig.npcCount, 10) || 3),
        startChips: _lobbyDraftConfig.startChips,
        smallBlind: _lobbyDraftConfig.smallBlind,
      },
      false
    );
    summary.dataset.state = 'practice';
    nameEl.textContent = 'Practice Table';
    metaEl.textContent = 'Single-player with AI only. Your settings apply directly to this table.';
    seatBtn.textContent = 'Start Practice';
    seatBtn.disabled = false;
    return;
  }

  const selectedMeta = getSelectedRoomMeta();
  if (!selectedMeta) {
    unlockLobbySettings(_lobbyDraftConfig);
    summary.dataset.state = 'idle';
    nameEl.textContent = `Select a ${getRoomModeLabel(_selectedGameMode).toLowerCase()} room below`;
    metaEl.textContent = `Empty preset rooms create a new ${getRoomModeLabel(_selectedGameMode).toLowerCase()} table. Active or saved rooms keep their own settings.`;
    seatBtn.textContent = getSelectRoomLabel(_selectedGameMode);
    seatBtn.disabled = true;
    return;
  }

  if (selectedMeta.kind === 'new') {
    unlockLobbySettings(_lobbyDraftConfig);
    summary.dataset.state = 'new';
    nameEl.textContent = `${selectedMeta.roomId} · New Table`;
    metaEl.textContent = `${formatLobbySettingsLine(selectedMeta)} · This empty preset room will use the settings below.`;
    seatBtn.textContent = getCreateRoomLabel(selectedMeta.gameMode);
    seatBtn.disabled = false;
    return;
  }

  applyLobbySettings(
    {
      npcCount: selectedMeta.npcCount,
      startChips: selectedMeta.startChips,
      smallBlind: selectedMeta.smallBlind,
    },
    true
  );

  summary.dataset.state = selectedMeta.kind;
  if (selectedMeta.kind === 'saved') {
    const savedAt = selectedMeta.savedAt
      ? new Date(selectedMeta.savedAt).toLocaleString('en-US', {
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric',
          minute: 'numeric',
        })
      : 'recently';
    nameEl.textContent = `${selectedMeta.roomId} · Saved Table`;
    metaEl.textContent = `${formatLobbySettingsLine(selectedMeta)} · Saved ${savedAt} · Restores the saved room state.`;
    seatBtn.textContent = `Continue ${getRoomModeLabel(selectedMeta.gameMode)} Room`;
    seatBtn.disabled = false;
    return;
  }

  const playerLine = `${selectedMeta.humanCount || 0} human · ${selectedMeta.npcCount || 0} NPC`;
  const nextStep = selectedMeta.isRunning
    ? 'Current hand is in progress. You will spectate and join next hand.'
    : 'Join with the room settings shown below.';
  summary.dataset.state = selectedMeta.isRunning ? 'active' : 'open';
  nameEl.textContent = selectedMeta.isRunning
    ? `${selectedMeta.roomId} · Hand In Progress`
    : `${selectedMeta.roomId} · Open Table`;
  metaEl.textContent = `${formatLobbySettingsLine(selectedMeta)} · ${playerLine} · ${nextStep}`;
  seatBtn.textContent = selectedMeta.isRunning
    ? 'Spectate This Hand'
    : getJoinRoomLabel(selectedMeta.gameMode);
  seatBtn.disabled = false;
}

function clearLobbySelection(options = {}) {
  const { keepDraft = true } = options;
  if (keepDraft) rememberLobbyDraftConfig();
  const roomId = document.getElementById('roomId');
  if (roomId) roomId.value = '';
  document.querySelectorAll('.room-card.selected').forEach((card) => card.classList.remove('selected'));
  updateLobbySelectionUI();
}

function handleLobbyModeChange(mode, options = {}) {
  const { preserveRoomSelection = false } = options;
  const selectedMeta = getSelectedRoomMeta();
  if (mode === 'practice') {
    clearLobbySelection({ keepDraft: true });
    return;
  }

  if (!preserveRoomSelection && selectedMeta && selectedMeta.kind !== 'new') {
    clearLobbySelection({ keepDraft: false });
    return;
  }

  if (!preserveRoomSelection || !selectedMeta || selectedMeta.kind === 'new') {
    rememberLobbyDraftConfig();
  }
  updateLobbySelectionUI();
}

function loadRoomList() {
  bindLobbyControlListeners();
  Promise.all([
    fetch('/api/rooms').then((r) => r.json()),
    fetch('/api/saves').then((r) => r.json()),
  ])
    .then(([rooms, saves]) => {
      _lobbyRoomsCache = Array.isArray(rooms) ? rooms : [];
      _lobbySavesCache = Array.isArray(saves) ? saves : [];
      renderRoomList(_lobbyRoomsCache, _lobbySavesCache);
    })
    .catch(() => {
      const lobbyRooms = document.getElementById('lobbyRooms');
      lobbyRooms.textContent = '';
      lobbyRooms.appendChild(createTextElement('div', 'lobby-empty', 'Cannot connect to server'));
      updateLobbySelectionUI();
    });
}

function createRoomCard(roomId, options = {}) {
  const { infoText = '', subText = '', modeLabel = '', stateLabel = '', stateClass = '' } = options;
  const card = document.createElement('div');
  card.className = 'room-card';
  if (stateClass) card.classList.add(`room-card-${stateClass}`);
  card.dataset.room = roomId;

  const infoBlock = document.createElement('div');
  const heading = document.createElement('div');
  heading.className = 'room-card-heading';

  const name = createTextElement('div', 'room-card-name', '');
  appendRoomDisplayName(name, roomId);
  if (modeLabel) {
    name.appendChild(document.createTextNode(' '));
    name.appendChild(createTextElement('span', 'room-mode-tag', modeLabel));
  }
  heading.appendChild(name);

  if (stateLabel) {
    const badge = createTextElement('span', 'room-status-tag', stateLabel);
    if (stateClass) badge.classList.add(`room-status-tag-${stateClass}`);
    heading.appendChild(badge);
  }

  infoBlock.appendChild(heading);
  if (infoText) infoBlock.appendChild(createTextElement('div', 'room-card-info', infoText));
  if (subText) infoBlock.appendChild(createTextElement('div', 'room-card-sub', subText));

  card.appendChild(infoBlock);
  card.addEventListener('click', () => selectRoom(roomId));
  return card;
}

function renderRoomList(rooms, saves) {
  const container = document.getElementById('lobbyRooms');
  const activeIds = rooms.map((room) => room.id);
  container.textContent = '';

  const savedNotActive = (saves || []).filter((save) => !activeIds.includes(save.roomId));
  for (const save of savedNotActive) {
    const timeStr = new Date(save.savedAt).toLocaleString('en-US', {
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    container.appendChild(
      createRoomCard(save.roomId, {
        infoText: `${getRoomModeLabel(save.gameMode)} · ${save.blinds} · ${save.startChips} chips`,
        subText: `${save.humanCount} human · ${save.npcCount} NPC · Saved ${timeStr}`,
        stateLabel: 'Saved',
        stateClass: 'saved',
      })
    );
  }

  for (const room of rooms) {
    container.appendChild(
      createRoomCard(room.id, {
        infoText: `${getRoomModeLabel(room.gameMode)} · ${room.smallBlind}/${room.bigBlind} · ${room.startChips} chips`,
        subText: `${room.humanCount} human · ${room.npcCount} NPC · ${room.isRunning ? 'Spectate to join next hand' : 'Ready to join'}`,
        modeLabel: room.gameMode === 'tournament' ? 'Tournament' : '',
        stateLabel: room.isRunning ? 'Playing' : 'Open',
        stateClass: room.isRunning ? 'active' : 'open',
      })
    );
  }

  const saveIds = (saves || []).map((save) => save.roomId);
  for (const name of PRESET_ROOM_NAMES) {
    if (!activeIds.includes(name) && !saveIds.includes(name)) {
      container.appendChild(
        createRoomCard(name, {
          infoText: 'Empty preset room',
          subText: 'Create a new family table here',
          stateLabel: 'New',
          stateClass: 'new',
        })
      );
    }
  }

  if (container.children.length === 0) {
    container.appendChild(createTextElement('div', 'lobby-empty', 'No rooms available right now.'));
  }

  const currentRoom = getSelectedRoomId();
  if (currentRoom && !getSelectedRoomMeta(currentRoom)) {
    const roomId = document.getElementById('roomId');
    if (roomId) roomId.value = '';
  }
  if (currentRoom) {
    const selectedCard = container.querySelector(`.room-card[data-room="${CSS.escape(currentRoom)}"]`);
    if (selectedCard) selectedCard.classList.add('selected');
  }
  updateLobbySelectionUI();
}

function selectRoom(roomId) {
  const roomField = document.getElementById('roomId');
  if (roomField) roomField.value = roomId;
  const selectedMeta = getSelectedRoomMeta(roomId);
  if (selectedMeta && selectedMeta.kind !== 'new') {
    selectMode(selectedMeta.gameMode || 'cash', { preserveRoomSelection: true });
  } else if (_selectedGameMode !== _lobbyDraftConfig.mode) {
    selectMode(_lobbyDraftConfig.mode || 'cash', { preserveRoomSelection: true });
  }
  document.querySelectorAll('.room-card').forEach((card) => card.classList.remove('selected'));
  const selectedCard = document.querySelector(`.room-card[data-room="${CSS.escape(roomId)}"]`);
  if (selectedCard) selectedCard.classList.add('selected');
  updateLobbySelectionUI();
}

async function takeASeat() {
  if (_selectedGameMode === 'practice') {
    await startPractice();
  } else if (_selectedGameMode === 'multi') {
    const bots = parseInt(document.getElementById('npcCount').value, 10) || 17;
    const chips = parseInt(document.getElementById('startChips').value, 10) || 5000;
    const blind = parseInt(document.getElementById('smallBlind').value, 10) || 10;
    // Nine-max unless the field is small enough that it would leave one table
    // nearly empty; the director still balances from there.
    const tableSize = bots + 1 <= 12 ? 6 : 9;
    window.startMultiTableTournament({
      botCount: bots,
      tableSize,
      startChips: chips,
      smallBlind: blind,
      buyIn: 0,
    });
  } else {
    await joinGame();
  }
}

async function joinGame() {
  const playerNameInput = document.getElementById('playerName');
  const playerName = sanitizeLobbyPlayerName(playerNameInput.value);
  playerNameInput.value = playerName;
  if (playerName) localStorage.setItem('finaltable_player_name', playerName);
  if (!playerName) {
    playerNameInput.classList.add('input-invalid');
    playerNameInput.focus();
    playerNameInput.select();
    return;
  }

  const selectedRoomMeta = getSelectedRoomMeta();
  let roomId = '';
  if (_selectedGameMode === 'practice') {
    roomId = document.getElementById('roomId').value.trim();
    if (!roomId) {
      roomId = generatePracticeRoomName();
      document.getElementById('roomId').value = roomId;
    }
  } else if (window.__pendingTournament) {
    // A tournament is not a room: the director creates and owns its tables, so
    // there is nothing for the player to pick from the room list. Skip the
    // room requirement and let the server name the tables.
    roomId = 'mtt';
  } else {
    roomId = getSelectedRoomId();
    if (!roomId || !selectedRoomMeta) {
      if (typeof window.showNoticeDialog === 'function') {
        await window.showNoticeDialog({
          title: 'Room Required',
          message: 'Select a preset room before joining.',
          confirmLabel: 'Understood',
        });
      }
      return;
    }
  }

  const npcCount = parseInt(document.getElementById('npcCount').value, 10);
  const smallBlind = parseInt(document.getElementById('smallBlind').value, 10);
  const startChips = parseInt(document.getElementById('startChips').value, 10);
  const playerAvatar = document.getElementById('playerAvatar').value || '🧑';
  localStorage.setItem('finaltable_player_avatar', playerAvatar);
  const storedSessionToken = localStorage.getItem(SESSION_STORAGE_PREFIX + roomId);
  if (storedSessionToken) sessionToken = storedSessionToken;
  if (_selectedGameMode !== 'practice') rememberLobbyDraftConfig();

  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
  if (_visibilityHandler) {
    document.removeEventListener('visibilitychange', _visibilityHandler);
    _visibilityHandler = null;
  }

  socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 30000,
  });

  let _joinData = null;
  const topInfo = document.getElementById('topInfo');
  if (topInfo) topInfo.textContent = 'Connecting...';

  _visibilityHandler = () => {
    if (document.visibilityState === 'visible' && socket) {
      if (!socket.connected) {
        addLog('📱 Reconnecting...');
        socket.connect();
      } else if (_joinData) {
        socket.emit('requestState');
      }
    }
  };
  document.addEventListener('visibilitychange', _visibilityHandler);

  _heartbeatTimer = setInterval(() => {
    if (socket && socket.connected) socket.emit('heartbeat');
  }, 15000);

  socket.on('connect', () => {
    const effectiveMode =
      _selectedGameMode === 'practice'
        ? 'practice'
        : selectedRoomMeta && selectedRoomMeta.kind !== 'new'
          ? selectedRoomMeta.gameMode
          : _selectedGameMode;
    const effectiveSmallBlind =
      selectedRoomMeta && selectedRoomMeta.kind !== 'new' ? selectedRoomMeta.smallBlind : smallBlind;
    const effectiveStartChips =
      selectedRoomMeta && selectedRoomMeta.kind !== 'new' ? selectedRoomMeta.startChips : startChips;
    const effectiveNpcCount =
      selectedRoomMeta && selectedRoomMeta.kind !== 'new' ? selectedRoomMeta.npcCount : npcCount;

    const joinPayload = {
      roomId,
      playerName,
      npcCount: effectiveNpcCount,
      smallBlind: effectiveSmallBlind,
      bigBlind: effectiveSmallBlind * 2,
      startChips: effectiveStartChips,
      playerAvatar,
      gameMode: effectiveMode,
      sessionToken: sessionToken,
    };
    _joinData = joinPayload;
    // A multi-table tournament reuses this whole connect path -- the socket,
    // the gameState handler and the table renderer are all identical -- and
    // only differs in what it asks the server for.
    if (window.__pendingTournament) {
      const cfg = window.__pendingTournament;
      window.__pendingTournament = null;
      socket.emit('createTournament', {
        ...cfg,
        playerName,
        playerAvatar,
      });
    } else {
      socket.emit('joinRoom', joinPayload);
    }
  });

  socket.on('disconnect', () => {
    addLog('⚠️ Disconnected, reconnecting...');
  });

  socket.on('reconnect', () => {
    addLog('✅ Reconnected');
  });

  socket.on('joinedRoom', (data) => {
    myId = data.playerId;
    sessionToken = data.sessionToken || null;
    if (sessionToken) localStorage.setItem(SESSION_STORAGE_PREFIX + data.roomId, sessionToken);
    if (data.actualMode && data.actualMode !== _selectedGameMode) {
      const labels = { cash: 'Cash Game', tournament: 'Tournament', practice: 'Practice' };
      _selectedGameMode = data.actualMode;
      setTimeout(
        () => addLog(`ℹ️ This room is in ${labels[data.actualMode] || data.actualMode} mode`),
        500
      );
    }
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('gameScreen').classList.add('active');
    updateGameState(data.state);
  });

  socket.on('nameChanged', (data) => {
    addLog(`✅ Name changed to: ${data.name}`);
  });

  socket.on('gameState', (state) => {
    const oldPhase = gameState ? gameState.phase : null;
    updateGameState(state);
    if (state.isMyTurn && oldPhase !== null) SFX.play('turn');
  });

  socket.on('gameMessage', (msg) => {
    addLog(msg);
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

  socket.on('exitedGame', () => {
    if (tournamentTimer) {
      clearInterval(tournamentTimer);
      tournamentTimer = null;
    }
    gameState = null;
    myId = null;
    sessionToken = null;
    localStorage.removeItem(SESSION_STORAGE_PREFIX + roomId);
    if (_heartbeatTimer) {
      clearInterval(_heartbeatTimer);
      _heartbeatTimer = null;
    }
    if (_visibilityHandler) {
      document.removeEventListener('visibilitychange', _visibilityHandler);
      _visibilityHandler = null;
    }
    socket.disconnect();
    socket = null;
    _currentEquity = null;
    _currentEquityContextKey = null;
    document.getElementById('pauseOverlay').classList.add('hidden');
    document.getElementById('speedPauseGroup').classList.add('hidden');
    document.getElementById('eqSide').classList.add('hidden');
    const chatArea = document.getElementById('npcChatArea');
    if (chatArea) chatArea.textContent = '';
    restoreLobbyUI();
  });

  socket.on('npcList', (profiles) => {
    renderNPCPanel(profiles);
  });

  socket.on('tournamentLevelUp', (data) => {
    SFX.play('turn');
    addLog(`⬆️ Blinds up! Level ${data.level + 1}: ${data.blinds.sb}/${data.blinds.bb}`);
  });

  socket.on('tournamentEnd', (result) => {
    if (tournamentTimer) {
      clearInterval(tournamentTimer);
      tournamentTimer = null;
    }
    SFX.play('win');
    renderTournamentResult(result);
    document.getElementById('tournamentModal').classList.remove('hidden');
  });

  socket.on('handReplay', (hand) => {
    if (hand) renderReplayDetail(hand);
  });

  socket.on('gameSaved', () => {
    addLog('💾 Game saved, continue next time you enter this room');
    loadRoomList();
  });

  socket.on('saveDeleted', (data) => {
    addLog('🗑️ Save "' + data.roomId + '" deleted');
  });

  socket.on('error', (data) => {
    addLog('⚠️ ' + data.message);
    if (!document.getElementById('npcPanel').classList.contains('hidden')) {
      socket.emit('getNPCList');
    }
  });

  socket.on('chatMessage', (data) => {
    if (!data || !data.sender || !data.message) return;
    const area = document.getElementById('npcChatArea');
    if (!area) return;
    const bubble = document.createElement('div');
    bubble.className = 'npc-chat-bubble';
    const lines = data.message.split('\n');
    const zh = lines[0] || '';
    const en = lines[1] || '';
    bubble.appendChild(createTextElement('span', 'chat-sender', data.sender));
    bubble.appendChild(document.createTextNode(zh));
    if (en) bubble.appendChild(createTextElement('span', 'chat-en', en));
    area.appendChild(bubble);
    while (area.children.length > 4) area.removeChild(area.firstChild);
    setTimeout(() => {
      bubble.classList.add('fading');
    }, 6000);
    setTimeout(() => {
      if (bubble.parentNode) bubble.remove();
    }, 7000);
  });

  socket.on('autoEquity', (data) => {
    if (!gameState || gameState.gameMode !== 'practice') return;
    _currentEquity = data;
    updateEquityUI(data);
    setTimeout(() => updateEquityUI(data), 200);
    setTimeout(() => updateEquityUI(data), 600);
  });

  socket.on('equityResult', (result) => {
    if (result.error) {
      addLog('⚠️ ' + result.error);
      return;
    }
    showEquityDisplay(result);
    if (result.cost > 0) {
      showFeeFloat(result.cost);
      _eqPaidCount++;
      if (_eqPaidCount >= 5 && !_dalioShown) {
        _dalioShown = true;
        setTimeout(() => showDalioEasterEgg(), 1500);
      }
    }
    if (gameState) {
      const me = gameState.players && gameState.players.find((player) => player.id === myId);
      if (me && result.cost > 0) {
        me.chips = Math.max(0, me.chips - result.cost);
      }
      gameState.equityState = {
        freeLeft: result.freeLeft !== undefined ? result.freeLeft : gameState.equityState.freeLeft,
        priceLevel:
          result.priceLevel !== undefined
            ? result.priceLevel
            : (gameState.equityState || {}).priceLevel || 0,
        unusedStreak: 0,
      };
      if (result.nextPrice !== undefined) gameState.equityPrice = result.nextPrice;
      updateEquityButton();
    }
  });

  document.addEventListener('click', () => SFX.init(), { once: true });
}

function restoreLobbyUI() {
  const roomId = document.getElementById('roomId');
  const shouldClearStaleRoom = _selectedGameMode === 'practice' || !getSelectedRoomMeta();
  const topInfo = document.getElementById('topInfo');
  const modeBadge = document.getElementById('modeBadge');
  const gameLog = document.getElementById('gameLog');
  const logLast = document.getElementById('logLast');
  const logBody = document.getElementById('logBody');
  const tournamentBanner = document.getElementById('tournamentBanner');

  document.getElementById('gameScreen').classList.remove('active');
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('settingsStep').classList.add('active');
  document.getElementById('modeSelectStep').classList.remove('hidden-step');
  document.getElementById('modeSelectStep').classList.add('active');
  if (topInfo) topInfo.textContent = 'Waiting...';
  if (modeBadge) {
    modeBadge.className = 'mode-badge';
    modeBadge.textContent = '';
  }
  if (gameLog) {
    gameLog.classList.add('collapsed');
    gameLog.classList.remove('expanded');
  }
  if (logLast) logLast.textContent = 'Waiting...';
  if (logBody) logBody.textContent = '';
  if (tournamentBanner) tournamentBanner.classList.add('hidden');
  document.body.classList.remove('log-expanded');

  if (shouldClearStaleRoom) {
    if (roomId) roomId.value = '';
    document.querySelectorAll('.room-card.selected').forEach((card) => card.classList.remove('selected'));
  }

  selectMode(_selectedGameMode || 'cash');
  loadRoomList();
}

function init() {
  const dialogModal = document.getElementById('appDialogModal');
  const dialogTitle = document.getElementById('appDialogTitle');
  const dialogBody = document.getElementById('appDialogBody');
  const dialogHint = document.getElementById('appDialogHint');
  const dialogInput = document.getElementById('appDialogInput');
  const dialogCancel = document.getElementById('btnAppDialogCancel');
  const dialogConfirm = document.getElementById('btnAppDialogConfirm');
  let activeDialogResolver = null;
  let activeDialogKind = 'confirm';

  function resolveAppDialog(result) {
    const resolver = activeDialogResolver;
    activeDialogResolver = null;
    activeDialogKind = 'confirm';
    if (dialogModal) dialogModal.classList.add('hidden');
    if (dialogInput) {
      dialogInput.classList.add('hidden');
      dialogInput.value = '';
      dialogInput.removeAttribute('maxlength');
    }
    if (dialogHint) {
      dialogHint.classList.add('hidden');
      dialogHint.textContent = '';
    }
    if (resolver) resolver(result);
  }

  function closeAppDialogAsCancel() {
    if (!activeDialogResolver) return false;
    const fallback = activeDialogKind === 'prompt' ? null : false;
    resolveAppDialog(fallback);
    return true;
  }

  function openAppDialog(config = {}) {
    const {
      kind = 'confirm',
      title = 'Confirm',
      message = '',
      hint = '',
      confirmLabel = 'Confirm',
      cancelLabel = 'Cancel',
      defaultValue = '',
      placeholder = '',
      maxLength = 32,
      showCancel = kind !== 'notice',
    } = config;
    if (!dialogModal || !dialogTitle || !dialogBody || !dialogConfirm) {
      if (kind === 'prompt') return Promise.resolve(defaultValue || null);
      return Promise.resolve(kind === 'notice');
    }
    if (activeDialogResolver) closeAppDialogAsCancel();
    activeDialogKind = kind;
    dialogTitle.textContent = title;
    dialogBody.textContent = message;
    dialogConfirm.textContent = confirmLabel;
    if (dialogCancel) {
      dialogCancel.textContent = cancelLabel;
      dialogCancel.classList.toggle('hidden', !showCancel);
    }
    if (hint) {
      dialogHint.textContent = hint;
      dialogHint.classList.remove('hidden');
    } else if (dialogHint) {
      dialogHint.classList.add('hidden');
      dialogHint.textContent = '';
    }
    if (kind === 'prompt' && dialogInput) {
      dialogInput.classList.remove('hidden');
      dialogInput.value = defaultValue;
      dialogInput.placeholder = placeholder;
      dialogInput.maxLength = String(maxLength);
    } else if (dialogInput) {
      dialogInput.classList.add('hidden');
      dialogInput.value = '';
    }
    dialogModal.classList.remove('hidden');
    return new Promise((resolve) => {
      activeDialogResolver = resolve;
      const focusTarget = kind === 'prompt' && dialogInput ? dialogInput : dialogConfirm;
      requestAnimationFrame(() => focusTarget?.focus());
    });
  }

  window.showConfirmDialog = (config) => openAppDialog({ ...config, kind: 'confirm' });
  window.showNoticeDialog = (config) =>
    openAppDialog({
      ...config,
      kind: 'notice',
      showCancel: false,
      confirmLabel: config?.confirmLabel || 'Understood',
    });
  window.showTextPromptDialog = (config) => openAppDialog({ ...config, kind: 'prompt' });

  function closeMenu() {
    const menu = document.getElementById('menuDropdown');
    if (menu) menu.classList.remove('open');
  }

  function closeReplayPanel() {
    document.getElementById('replayPanel').classList.add('hidden');
    document.getElementById('replayDetail').classList.add('hidden');
    document.getElementById('replayHandList').classList.remove('hidden');
  }

  function closeOverlayById(id) {
    const el = document.getElementById(id);
    if (!el) return false;
    if (el.classList.contains('hidden')) return false;
    if (id === 'appDialogModal') return closeAppDialogAsCancel();
    if (id === 'replayPanel') {
      closeReplayPanel();
    } else {
      el.classList.add('hidden');
    }
    return true;
  }

  async function confirmStartWithReadyCheck() {
    if (!gameState || !isReadyCheckEnabled() || gameState.isHost !== true) return true;
    const summary = getReadySummary();
    if (summary.allReady) return true;
    return window.showConfirmDialog({
      title: 'Start Without Everyone Ready?',
      message: `Ready: ${summary.readyHumans}/${summary.totalHumans}.`,
      hint: `Waiting on: ${summary.unreadyNames.join(', ')}`,
      confirmLabel: 'Start Anyway',
      cancelLabel: 'Keep Waiting',
    });
  }

  document.querySelectorAll('.mode-link[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => selectMode(btn.dataset.mode));
  });
  document.getElementById('btnTakeASeat').addEventListener('click', takeASeat);
  document.getElementById('btnStartGame').addEventListener('click', async () => {
    if (typeof hasResumeInteractionGuard === 'function' && hasResumeInteractionGuard()) return;
    const force = await confirmStartWithReadyCheck();
    if (force || !isReadyCheckEnabled() || gameState.isHost !== true) {
      socket.emit('startGame', { force });
    }
  });
  document.getElementById('btnToggleReady').addEventListener('click', toggleReady);
  document.getElementById('btnNextRoundAction').addEventListener('click', () => {
    document.getElementById('resultModal').classList.add('hidden');
    socket.emit('nextRound');
  });
  document.getElementById('btnResultNextHand').addEventListener('click', async () => {
    if (!socket || !gameState) return;
    if (gameState.gameOver) {
      if (gameState.isHost) {
        if (typeof hasResumeInteractionGuard === 'function' && hasResumeInteractionGuard()) return;
        const confirmed = await window.showConfirmDialog({
          title:
            gameState.gameMode === 'practice'
              ? 'Start a Fresh Practice Table?'
              : 'Start a New Table?',
          message:
            gameState.gameMode === 'practice'
              ? 'This resets all stacks and starts a fresh practice run.'
              : 'This resets all stacks and starts a fresh table.',
          confirmLabel: 'Play Again',
          cancelLabel: 'Cancel',
        });
        if (!confirmed) return;
        document.getElementById('resultModal').classList.add('hidden');
        socket.emit('restartGame');
      } else {
        const me = gameState.players.find((p) => p.id === myId && !p.isNPC);
        if (!me) return;
        socket.emit('setReady', { ready: !me.isReady });
      }
      return;
    }
    document.getElementById('resultModal').classList.add('hidden');
    if (gameState.isHost) socket.emit('nextRound');
  });
  document.getElementById('btnResultExit').addEventListener('click', () => {
    document.getElementById('resultModal').classList.add('hidden');
    if (socket) socket.emit('exitGame');
  });
  const resultAddNpc = document.getElementById('btnResultAddNpc');
  if (resultAddNpc) {
    resultAddNpc.addEventListener('click', () => {
      if (socket && gameState && gameState.isHost && gameState.gameOver) socket.emit('addNPC');
    });
  }
  const resultRemoveNpc = document.getElementById('btnResultRemoveNpc');
  if (resultRemoveNpc) {
    resultRemoveNpc.addEventListener('click', () => {
      if (socket && gameState && gameState.isHost && gameState.gameOver) socket.emit('removeNPC');
    });
  }
  document.getElementById('btnFold').addEventListener('click', () => sendAction('fold'));
  document.getElementById('btnCheck').addEventListener('click', () => sendAction('check'));
  document.getElementById('btnCall').addEventListener('click', () => sendAction('call'));
  document.getElementById('btnRaise').addEventListener('click', () => {
    const amount = parseInt(document.getElementById('raiseInput').value) || 0;
    sendAction('raise', amount);
  });
  document.getElementById('btnAllIn').addEventListener('click', () => sendAction('allin'));
  document.getElementById('presetGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('.preset-btn');
    if (!btn || btn.disabled) return;
    applyRaisePreset(parseInt(btn.dataset.to, 10) || 0);
  });
  document.getElementById('btnRequestTime').addEventListener('click', () => {
    if (socket) socket.emit('requestTime');
  });
  document.querySelectorAll('.speed-btn[data-speed]').forEach((btn) => {
    btn.addEventListener('click', () => setGameSpeed(parseInt(btn.dataset.speed, 10)));
  });
  document.getElementById('btnPause').addEventListener('click', togglePause);
  document.getElementById('btnPauseResume').addEventListener('click', togglePause);
  document.getElementById('menuToggle').addEventListener('click', toggleMenu);
  document.getElementById('btnRename').addEventListener('click', changeName);
  document.getElementById('btnNPCPanel').addEventListener('click', () => {
    closeMenu();
    socket.emit('getNPCList');
    document.getElementById('npcPanel').classList.remove('hidden');
  });
  document.getElementById('btnCloseNPCPanel').addEventListener('click', () => {
    document.getElementById('npcPanel').classList.add('hidden');
  });
  document.getElementById('btnRestart').addEventListener('click', async () => {
    closeMenu();
    const confirmed = await window.showConfirmDialog({
      title: 'Restart Table?',
      message: 'All stacks will reset to the room starting stack.',
      confirmLabel: 'Restart',
      cancelLabel: 'Cancel',
    });
    if (confirmed) {
      socket.emit('restartGame');
    }
  });
  document.getElementById('btnSave').addEventListener('click', () => {
    closeMenu();
    socket.emit('saveGame');
  });
  document.getElementById('btnDeleteSave').addEventListener('click', async () => {
    closeMenu();
    if (!gameState) return;
    const confirmed = await window.showConfirmDialog({
      title: 'Delete Saved Room?',
      message: `Remove the saved state for "${gameState.id}".`,
      hint: 'This cannot be undone.',
      confirmLabel: 'Delete Save',
      cancelLabel: 'Cancel',
    });
    if (confirmed) {
      socket.emit('deleteSave', { roomId: gameState.id });
    }
  });
  document.getElementById('btnExit').addEventListener('click', async () => {
    if (!gameState) {
      socket.emit('exitGame');
      return;
    }

    const me = gameState.players.find((p) => p.id === myId);
    const otherHumans = gameState.players.filter((p) => !p.isNPC && p.id !== myId);

    if (me && me.chips > 0 && otherHumans.length > 0) {
      const names = otherHumans.map((p) => p.name).join('、');
      const choice = await window.showTextPromptDialog({
        title: 'Leave Table',
        message: `You still have ${me.chips} chips.`,
        hint: `Enter a player name to gift your stack before leaving, or leave this blank to exit. Online: ${names}`,
        confirmLabel: 'Leave Table',
        cancelLabel: 'Stay Seated',
        placeholder: 'Player name',
        defaultValue: '',
        maxLength: 12,
      });
      if (choice === null) return; // cancelled
      if (choice.trim() && otherHumans.some((p) => p.name === choice.trim())) {
        socket.emit('giftChips', { targetName: choice.trim() });
        socket.once('giftDone', () => socket.emit('exitGame'));
        return;
      }
      if (choice.trim()) {
        await window.showNoticeDialog({
          title: 'Player Not Found',
          message: `No active human player matches "${choice.trim()}".`,
          confirmLabel: 'Understood',
        });
        return;
      }
    }
    socket.emit('exitGame');
  });
  document.getElementById('btnLeaderboard').addEventListener('click', () => {
    closeMenu();
    // The Stats tab, in the docked panel or the phone drawer.
    if (window.SidePanel) {
      SidePanel.reveal('stats');
      return;
    }
    renderLeaderboard();
    document.getElementById('lbPanel').classList.remove('hidden');
  });
  document.getElementById('btnCloseLeaderboard').addEventListener('click', () => {
    document.getElementById('lbPanel').classList.add('hidden');
  });
  document.getElementById('btnReplay').addEventListener('click', () => {
    closeMenu();
    if (window.SidePanel) {
      SidePanel.reveal('history');
      return;
    }
    renderReplayList();
    document.getElementById('replayPanel').classList.remove('hidden');
  });
  document.getElementById('btnAutoPlay').addEventListener('click', toggleAutoPlay);
  document.getElementById('btnCloseReplay').addEventListener('click', () => {
    closeReplayPanel();
  });
  document.getElementById('btnHint').addEventListener('click', () => {
    closeMenu();
    document.getElementById('hintModal').classList.remove('hidden');
  });
  document.getElementById('btnCloseTournamentModal').addEventListener('click', () => {
    document.getElementById('tournamentModal').classList.add('hidden');
  });
  document.getElementById('btnCloseHintModal').addEventListener('click', () => {
    document.getElementById('hintModal').classList.add('hidden');
  });
  document.getElementById('btnStartTournament').addEventListener('click', async () => {
    if (!socket) return;
    const force = await confirmStartWithReadyCheck();
    if (!force && isReadyCheckEnabled() && gameState.isHost === true) return;
    const dur = await window.showTextPromptDialog({
      title: 'Tournament Setup',
      message: 'Set the blind level duration in seconds.',
      hint: '180 seconds = 3 minutes.',
      confirmLabel: 'Start Tournament',
      cancelLabel: 'Cancel',
      placeholder: '180',
      defaultValue: '180',
      maxLength: 4,
    });
    if (dur === null) return;
    const levelDuration = parseInt(dur, 10) || 180;
    socket.emit('startTournament', { levelDuration: Math.max(30, levelDuration), force });
  });
  document.getElementById('eqSide').addEventListener('click', onEqSideClick);
  document.getElementById('eqSideBtn').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onEqSideClick();
    }
  });
  document.getElementById('btnCloseEqRules').addEventListener('click', closeEqRules);
  document.getElementById('btnCancelEqConfirm').addEventListener('click', cancelEqConfirm);
  document.getElementById('btnConfirmEqPurchase').addEventListener('click', confirmEqPurchase);
  document.getElementById('btnCloseDalioModal').addEventListener('click', closeDalioModal);

  const slider = document.getElementById('raiseSlider');
  const raiseInput = document.getElementById('raiseInput');
  const raiseNeedPay = document.getElementById('raiseNeedPay');

  function formatRaiseSummary(raiseToVal, meBet) {
    const needPay = Math.max(0, raiseToVal - meBet);
    return `to ${raiseToVal} · +${needPay}`;
  }

  function updateNeedPay() {
    if (!gameState) return;
    const me = gameState.players.find((p) => p.id === myId);
    if (!me) return;
    const min = parseInt(slider.min, 10) || 0;
    const max = parseInt(slider.max, 10) || min;
    const rawValue = parseInt(raiseInput.value, 10);
    const clampedValue = Math.max(min, Math.min(max, Number.isFinite(rawValue) ? rawValue : min));
    raiseInput.value = clampedValue;
    slider.value = clampedValue;
    slider.setAttribute('aria-valuenow', clampedValue);
    raiseNeedPay.textContent = formatRaiseSummary(clampedValue, me.bet);
  }

  slider.addEventListener('input', () => {
    slider.dataset.userAdjusted = 'true';
    raiseInput.value = slider.value;
    slider.setAttribute('aria-valuenow', slider.value);
    updateNeedPay();
  });
  raiseInput.addEventListener('input', () => {
    slider.dataset.userAdjusted = 'true';
    slider.value = raiseInput.value;
    slider.setAttribute('aria-valuenow', raiseInput.value);
    updateNeedPay();
  });

  setInterval(() => {
    if (typeof updateTurnTimerBars === 'function') updateTurnTimerBars();
  }, 250);
  const PLAYER_NAME_STORAGE_KEY = 'finaltable_player_name';
  const PLAYER_AVATAR_STORAGE_KEY = 'finaltable_player_avatar';

  function normalizePlayerNameInput(value, maxLength = 16) {
    const cleaned = String(value || '')
      .normalize('NFKC')
      .replace(/[\u0000-\u001f\u007f<>]/g, '')
      .replace(/[^\p{L}\p{N} ._'-]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    const truncated = [...cleaned].slice(0, maxLength).join('').trim();
    return /[\p{L}\p{N}]/u.test(truncated) ? truncated : '';
  }

  // Avatar picker: keep the set readable and easy to tap.
  const avatars = [
    '🧑',
    '😎',
    '🤠',
    '🥷',
    '🧙‍♂️',
    '🤴',
    '👩',
    '👸',
    '🧙‍♀️',
    '👩‍🚀',
    '🐱',
    '🐶',
    '🦊',
    '🦁',
    '🐯',
    '🐺',
    '🦅',
    '🐸',
  ];
  const picker = document.getElementById('avatarPicker');
  const storedAvatar = localStorage.getItem(PLAYER_AVATAR_STORAGE_KEY);
  const initialAvatar = avatars.includes(storedAvatar) ? storedAvatar : avatars[0];
  document.getElementById('playerAvatar').value = initialAvatar;
  avatars.forEach((emoji) => {
    const btn = document.createElement('div');
    btn.className = 'avatar-option' + (emoji === initialAvatar ? ' selected' : '');
    btn.textContent = emoji;
    btn.addEventListener('click', () => {
      picker.querySelectorAll('.avatar-option').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      document.getElementById('playerAvatar').value = emoji;
      localStorage.setItem(PLAYER_AVATAR_STORAGE_KEY, emoji);
    });
    picker.appendChild(btn);
  });

  const playerNameInput = document.getElementById('playerName');
  const storedPlayerName = normalizePlayerNameInput(localStorage.getItem(PLAYER_NAME_STORAGE_KEY));
  playerNameInput.value = storedPlayerName;

  // Enter key on name input
  playerNameInput.addEventListener('input', (e) => {
    const nextValue = normalizePlayerNameInput(e.target.value);
    if (e.target.value !== nextValue) e.target.value = nextValue;
    if (e.target.value) e.target.classList.remove('input-invalid');
  });
  playerNameInput.addEventListener('blur', (e) => {
    e.target.value = normalizePlayerNameInput(e.target.value);
    if (e.target.value) localStorage.setItem(PLAYER_NAME_STORAGE_KEY, e.target.value);
    else localStorage.removeItem(PLAYER_NAME_STORAGE_KEY);
  });
  playerNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.target.value = normalizePlayerNameInput(e.target.value);
      if (e.target.value) localStorage.setItem(PLAYER_NAME_STORAGE_KEY, e.target.value);
      const firstRoom = document.querySelector('.room-card');
      if (firstRoom) firstRoom.click();
    }
  });

  function refreshRoomListIfVisible() {
    const loginScreen = document.getElementById('loginScreen');
    if (!loginScreen || loginScreen.classList.contains('hidden')) return;
    if (document.visibilityState === 'hidden') return;
    loadRoomList();
  }

  loadRoomList();
  setInterval(refreshRoomListIfVisible, 5000);

  dialogCancel?.addEventListener('click', () => {
    closeAppDialogAsCancel();
  });
  dialogConfirm?.addEventListener('click', () => {
    if (!activeDialogResolver) return;
    const result = activeDialogKind === 'prompt' && dialogInput ? dialogInput.value : true;
    resolveAppDialog(result);
  });
  dialogInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      dialogConfirm?.click();
    }
  });

  // ── Keyboard navigation for action buttons ──
  document.addEventListener('keydown', (e) => {
    if (!gameState || !gameState.isMyTurn) return;
    const me = gameState.players.find((p) => p.id === myId);
    if (me && me.autoPlay) return;
    // Don't intercept when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    switch (e.key) {
      case 'f':
      case 'F':
        sendAction('fold');
        break;
      case 'k':
      case 'K': // check
        if (gameState.canCheck) sendAction('check');
        break;
      case 'c':
      case 'C': // call
        if (!gameState.canCheck) sendAction('call');
        break;
      case 'r':
      case 'R': // raise
        const raiseVal = parseInt(document.getElementById('raiseInput').value);
        if (raiseVal > 0) sendAction('raise', raiseVal);
        break;
      case 'a':
      case 'A':
        sendAction('allin');
        break;
    }
  });

  // ── Focus trap for modal dialogs ──
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const modals = document.querySelectorAll('[role="dialog"]:not(.hidden)');
    if (modals.length === 0) return;
    const modal = modals[modals.length - 1]; // topmost modal
    const focusable = modal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
    // If focus is outside modal, pull it in
    if (!modal.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    }
  });

  // Close modals with Escape
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('menuDropdown').classList.contains('open')) {
      closeMenu();
      return;
    }
    const modals = [
      'npcPanel',
      'lbPanel',
      'replayPanel',
      'tournamentModal',
      'hintModal',
      'resultModal',
      'appDialogModal',
      'eqRulesModal',
      'eqConfirmModal',
      'dalioModal',
    ];
    for (const id of modals) {
      if (closeOverlayById(id)) return;
    }
    // Nothing modal was open: a phone's panel drawer is next in line.
    if (window.SidePanel) SidePanel.close();
  });

  [
    'npcPanel',
    'lbPanel',
    'replayPanel',
    'tournamentModal',
    'hintModal',
    'resultModal',
    'appDialogModal',
  ].forEach((id) => {
    const overlay = document.getElementById(id);
    if (!overlay) return;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeOverlayById(id);
    });
  });

  ['eqRulesModal', 'eqConfirmModal', 'dalioModal'].forEach((id) => {
    const overlay = document.getElementById(id);
    if (!overlay) return;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeOverlayById(id);
    });
  });
}

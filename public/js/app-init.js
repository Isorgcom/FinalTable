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

  // The result modal is the game-over view; in a tournament the standings
  // live in the Info tab, so its buttons only close it or leave.
  document.getElementById('btnResultNextHand').addEventListener('click', () => {
    document.getElementById('resultModal').classList.add('hidden');
  });
  document.getElementById('btnResultExit').addEventListener('click', () => {
    document.getElementById('resultModal').classList.add('hidden');
    if (window.Lobby) Lobby.leave();
  });
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
  document.getElementById('menuToggle').addEventListener('click', toggleMenu);
  // Leaving is the lobby's business: unregister before the start, leave the
  // stack under auto-play once running.
  document.getElementById('btnExit').addEventListener('click', () => {
    closeMenu();
    if (window.Lobby) Lobby.leave();
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
  document.getElementById('btnCloseHintModal').addEventListener('click', () => {
    document.getElementById('hintModal').classList.add('hidden');
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
      'lbPanel',
      'replayPanel',
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
    'lbPanel',
    'replayPanel',
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

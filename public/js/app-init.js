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
      masked = false,
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
      // A password asked for at a poker table is asked for in front of the
      // table, so it is not put on the screen in plain sight.
      dialogInput.type = masked ? 'password' : 'text';
    } else if (dialogInput) {
      dialogInput.classList.add('hidden');
      dialogInput.value = '';
      dialogInput.type = 'text';
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

  // Folding when checking is free throws the hand away for nothing: there is no
  // price to escape and no information to protect, so it is never what somebody
  // meant to do. Every other fold goes straight through — being asked to
  // confirm an ordinary fold, on a clock, would be worse than the mistake.
  async function foldWithGuard() {
    const free = !!(gameState && gameState.isMyTurn && gameState.canCheck);
    if (!free) return sendAction('fold');
    if (typeof window.showConfirmDialog !== 'function') return sendAction('fold');
    const ok = await window.showConfirmDialog({
      title: 'Fold for nothing?',
      message: 'Checking costs you nothing here. Folding gives the hand up.',
      confirmLabel: 'Fold anyway',
      cancelLabel: 'Go back',
    });
    if (!ok) return;
    // The table does not wait for an answer, so the turn may have moved on or
    // the price may have changed while the question was up. Fold only if
    // folding still means what it meant when it was asked.
    if (!gameState || !gameState.isMyTurn || !gameState.canCheck) return;
    sendAction('fold');
  }

  // Right-click a chair to be shown in it, and the table turns so you are.
  //
  // Nothing about this reaches the server: it rotates which physical chair the
  // viewer is drawn in, and everyone else follows clockwise from there, so the
  // order of play on screen is unchanged. A touch device has no right-click,
  // and iPadOS Safari will not fire contextmenu on a plain div, so a long
  // press opens the same menu.
  function wireSeatMenu() {
    const seats = document.getElementById('playerSeats');
    const menu = document.getElementById('seatMenu');
    const here = document.getElementById('seatMenuHere');
    const pick = document.getElementById('seatMenuPick');
    const list = document.getElementById('seatMenuList');
    const reset = document.getElementById('seatMenuReset');
    if (!seats || !menu || !here || !pick || !list || !reset) return;
    let pendingSlot = null;
    let pressTimer = null;

    function closeSub() {
      list.classList.add('hidden');
      pick.setAttribute('aria-expanded', 'false');
    }

    function hide() {
      menu.classList.add('hidden');
      closeSub();
      pendingSlot = null;
    }

    function applySlot(slot) {
      if (window.Store) Store.set(VIEWER_SLOT_KEY, slot === null ? null : String(slot));
      hide();
      if (typeof renderPlayersIncremental === 'function' && gameState) {
        // Every plate moves, so the skeleton is rebuilt rather than updated.
        _builtIdentityKey = '';
        renderPlayersIncremental();
      }
    }

    // The chairs this table has, by the name of the place they sit in. Built
    // when the menu opens: the table can change size under it.
    function fillChairList() {
      list.textContent = '';
      const count =
        gameState && typeof seatCapacity === 'function'
          ? seatCapacity(gameState.players ? gameState.players.length : 0)
          : 0;
      const names = typeof seatSlotNames === 'function' ? seatSlotNames(count) : [];
      const current = typeof viewerSlot === 'function' ? viewerSlot(names.length) : 0;
      names.forEach((name, slot) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'seat-menu-item seat-menu-chair' + (slot === current ? ' is-current' : '');
        item.dataset.slot = String(slot);
        item.setAttribute('role', 'menuitem');
        item.textContent = slot === current ? `${name} \u00b7 here now` : name;
        item.addEventListener('click', () => applySlot(slot));
        list.appendChild(item);
      });
    }

    function openAt(seat, clientX, clientY) {
      const slot = parseInt(seat.dataset.slot, 10);
      if (!Number.isFinite(slot)) return;
      pendingSlot = slot;
      closeSub();
      const stage = document.getElementById('tableStage');
      const box = stage ? stage.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
      menu.classList.remove('hidden');
      reset.classList.toggle('hidden', !(window.Store && Store.get(VIEWER_SLOT_KEY)));
      // Placed after it is shown, so the size measured is the real one, then
      // pulled back inside the stage if it would hang off an edge.
      const m = menu.getBoundingClientRect();
      const x = Math.max(0, Math.min(clientX - box.left, box.width - m.width));
      const y = Math.max(0, Math.min(clientY - box.top, box.height - m.height));
      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;
    }

    seats.addEventListener('contextmenu', (e) => {
      const seat = e.target.closest('.player-seat');
      if (!seat) return;
      e.preventDefault();
      openAt(seat, e.clientX, e.clientY);
    });

    // Long press, for the devices with no second mouse button.
    seats.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      const seat = e.target.closest('.player-seat');
      if (!seat) return;
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => openAt(seat, e.clientX, e.clientY), 500);
    });
    const cancelPress = () => clearTimeout(pressTimer);
    seats.addEventListener('pointerup', cancelPress);
    seats.addEventListener('pointermove', cancelPress);
    seats.addEventListener('pointercancel', cancelPress);

    pick.addEventListener('click', () => {
      if (!list.classList.contains('hidden')) return closeSub();
      fillChairList();
      list.classList.remove('hidden');
      pick.setAttribute('aria-expanded', 'true');
      // Out to the right unless the stage runs out first.
      const stage = document.getElementById('tableStage');
      list.classList.remove('flip-left');
      if (stage) {
        const edge = stage.getBoundingClientRect().right;
        if (list.getBoundingClientRect().right > edge) list.classList.add('flip-left');
      }
    });

    here.addEventListener('click', () => applySlot(pendingSlot));
    reset.addEventListener('click', () => applySlot(null));
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target)) hide();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hide();
    });
    window.addEventListener('resize', hide);
  }

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
  document.getElementById('btnFold').addEventListener('click', () => foldWithGuard());
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
  // stack sitting out once running.
  document.getElementById('btnExit').addEventListener('click', () => {
    closeMenu();
    if (window.Lobby) Lobby.leave();
  });
  wireSeatMenu();

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
  // ── Operator controls ──────────────────────────────────────────────────
  //
  // Hidden unless the server says it has an admin password configured, and the
  // cancel item stays hidden until this socket has actually authenticated. The
  // page holds no password and no privilege: every check is on the server, and
  // showing the item early would only reveal a control that refuses.
  window.Admin = (() => {
    let available = false;
    let authed = false;
    const btnAdmin = () => document.getElementById('btnAdmin');
    const btnCancel = () => document.getElementById('btnAdminCancel');
    function paint() {
      const a = btnAdmin();
      const c = btnCancel();
      if (a) a.classList.toggle('hidden', !available || authed);
      if (c) c.classList.toggle('hidden', !authed);
    }
    return {
      onIdentified(ident) {
        available = !!(ident && ident.adminAvailable);
        paint();
      },
      onStatus(st) {
        if (!st) return;
        available = st.available !== false;
        authed = !!st.ok;
        paint();
        if (st.ok) {
          window.showNoticeDialog &&
            window.showNoticeDialog({ title: 'Admin', message: 'Operator controls unlocked.' });
          return;
        }
        if (st.lockedOut) {
          window.showNoticeDialog &&
            window.showNoticeDialog({
              title: 'Admin',
              message: 'Too many attempts on this connection. Reload to try again.',
            });
          return;
        }
        if (st.available === false) return;
        window.showNoticeDialog &&
          window.showNoticeDialog({
            title: 'Admin',
            message:
              typeof st.attemptsLeft === 'number'
                ? `Wrong password. ${st.attemptsLeft} attempt(s) left.`
                : 'Wrong password.',
          });
      },
      isAuthed: () => authed,
    };
  })();

  document.getElementById('btnAdmin').addEventListener('click', async () => {
    closeMenu();
    if (!window.showTextPromptDialog) return;
    const password = await window.showTextPromptDialog({
      title: 'Operator login',
      message: 'Password for the admin controls.',
      hint: 'Sent over this connection as typed; the server is plain HTTP on your network.',
      confirmLabel: 'Unlock',
      placeholder: 'password',
      maxLength: 128,
      masked: true,
    });
    if (password && socket) socket.emit('adminLogin', { password });
  });

  document.getElementById('btnAdminCancel').addEventListener('click', async () => {
    closeMenu();
    let ok = true;
    if (typeof window.showConfirmDialog === 'function') {
      ok = await window.showConfirmDialog({
        title: 'Cancel this tournament?',
        message: 'It ends now and everyone still in it is sent back to the lobby.',
        confirmLabel: 'Cancel it',
        cancelLabel: 'Keep it',
      });
    }
    if (ok && socket) socket.emit('adminCancelTournament');
  });

  document.getElementById('btnAutoPlay').addEventListener('click', () => setSitOut(true));
  document.getElementById('btnSitIn').addEventListener('click', () => setSitOut(false));
  // Delegated, like the raise presets: the buttons are relabelled and hidden on
  // every push, so binding each one would rebind on every push too.
  document.getElementById('preActionRow').addEventListener('click', (e) => {
    const btn = e.target.closest('.preaction-btn');
    if (btn) armPreAction(btn.dataset.kind);
  });
  document.getElementById('btnSitOutNextHand').addEventListener('click', () => {
    setSitOutNextHand(!(gameState && gameState.mySitOutNextHand));
  });
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
        foldWithGuard();
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
    const modals = ['lbPanel', 'replayPanel', 'hintModal', 'resultModal', 'appDialogModal'];
    for (const id of modals) {
      if (closeOverlayById(id)) return;
    }
    // Nothing modal was open: a phone's panel drawer is next in line.
    if (window.SidePanel) SidePanel.close();
  });

  ['lbPanel', 'replayPanel', 'hintModal', 'resultModal', 'appDialogModal'].forEach((id) => {
    const overlay = document.getElementById(id);
    if (!overlay) return;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeOverlayById(id);
    });
  });
}

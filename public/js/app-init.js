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
  // meant to do. The fold button is switched off while a check is free rather
  // than asking afterwards whether that was really the intention - a question
  // on a clock is worse than the mistake it guards against. This keeps the
  // keyboard honest with the button it stands for.
  function fold() {
    if (gameState && gameState.isMyTurn && gameState.canCheck) return;
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

  // Every button on the felt flashes when it is pressed. One delegated
  // listener rather than a handler per button: the bar's contents change with
  // the street, and a control added later should not have to remember to ask
  // for this. pointerdown, not click, because fold and check end the turn and
  // take the bar with them on the same frame.
  function wireButtonPress() {
    const flash = (e) => {
      const btn = e.target.closest('.action-btn, .preset-btn, .preaction-btn');
      if (!btn || btn.disabled) return;
      btn.classList.remove('is-pressed');
      // Reading offsetWidth restarts the animation on a button pressed twice
      // in a row; without it the class is already there and nothing replays.
      void btn.offsetWidth;
      btn.classList.add('is-pressed');
      btn.addEventListener('animationend', () => btn.classList.remove('is-pressed'), {
        once: true,
      });
    };
    for (const id of ['actionsPanel', 'preActionPanel']) {
      const panel = document.getElementById(id);
      if (panel) panel.addEventListener('pointerdown', flash);
    }
  }

  // Two controls, one switch: the speaker in the felt's corner and the item in
  // the menu. The menu item says what pressing it will do rather than what the
  // state is - "sound off" on a silent table reads as a label rather than a
  // button - and the speaker says the state instead, because a drawing can.
  function wireMuteToggle() {
    const btn = document.getElementById('btnMute');
    const felt = document.getElementById('btnFeltMute');
    if (!btn && !felt) return;
    // One painter for both. window.syncMuteLabel below is a slot rather than a
    // list, so a second control cannot register alongside the first; it does
    // not need to, because this closure already knows about both.
    const label = () => {
      const muted = SFX.isMuted();
      if (btn) {
        btn.textContent = muted ? 'unmute sound' : 'mute sound';
        btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
      }
      if (felt) {
        felt.setAttribute('aria-pressed', muted ? 'true' : 'false');
        const says = muted ? 'Unmute the table' : 'Mute the table';
        felt.setAttribute('aria-label', says);
        felt.setAttribute('title', says);
      }
    };
    label();
    // Mute can also change without anyone pressing either of them, when the
    // setting arrives from the identity on another device. Both have to follow
    // it, or the menu offers to mute a table that is already silent and the
    // speaker is drawn with waves it is not making.
    window.syncMuteLabel = label;
    const toggle = () => {
      SFX.setMuted(!SFX.isMuted());
      label();
      closeMenu();
    };
    if (btn) btn.addEventListener('click', toggle);
    if (felt) felt.addEventListener('click', toggle);
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
  document.getElementById('btnFold').addEventListener('click', () => fold());
  document.getElementById('btnCheck').addEventListener('click', () => sendAction('check'));
  document.getElementById('btnCall').addEventListener('click', () => sendAction('call'));
  // On a phone the bar has room for three decisions and no more, so raise is
  // two taps: the first opens the sizing, the second sends it. Anywhere the
  // sizing is already on screen it stays one tap, as it always was.
  document.getElementById('btnRaise').addEventListener('click', () => {
    const panel = document.getElementById('actionsPanel');
    if (panel.classList.contains('is-compact') && !panel.classList.contains('is-sizing')) {
      panel.classList.add('is-sizing');
      if (typeof updateActionsPanel === 'function') updateActionsPanel();
      return;
    }
    const amount = parseInt(document.getElementById('raiseInput').value) || 0;
    sendAction('raise', amount);
  });
  document.getElementById('btnRaiseBack').addEventListener('click', () => {
    const panel = document.getElementById('actionsPanel');
    panel.classList.remove('is-sizing');
    if (typeof updateActionsPanel === 'function') updateActionsPanel();
  });
  // Which shape the bar is in. A phone held upright has no room for the row
  // the desktop lays out; landscape already had its own rules and keeps them.
  const compact = window.matchMedia('(max-width: 768px) and (orientation: portrait)');
  const paintCompact = () => {
    const panel = document.getElementById('actionsPanel');
    if (!panel) return;
    panel.classList.toggle('is-compact', compact.matches);
    if (!compact.matches) panel.classList.remove('is-sizing');
    if (typeof updateActionsPanel === 'function') updateActionsPanel();
  };
  compact.addEventListener('change', paintCompact);
  paintCompact();
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
  // stack sitting out once running. Two ways in and one function - the door in
  // the corner of the bar is the quick way, the menu item is the one people
  // already know and it sits next to forfeit, which is the comparison that
  // makes forfeit legible. Wired together so they cannot drift apart.
  const backToLobby = () => {
    closeMenu();
    if (window.Lobby) Lobby.leave();
  };
  for (const id of ['btnToLobby', 'btnExit']) {
    document.getElementById(id).addEventListener('click', backToLobby);
  }
  // The other way out, for somebody who is not coming back: the seat goes
  // instead of staying to blind down. Asked for once, because nothing undoes it.
  document.getElementById('btnForfeit').addEventListener('click', () => {
    closeMenu();
    if (window.Lobby) Lobby.forfeit();
  });
  wireSeatMenu();
  wireMuteToggle();
  wireButtonPress();

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
  // ── Admin controls ──────────────────────────────────────────────────
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
          // The lobby's Admin page unlocks the same way and then opens
          // itself; a notice on top of that would be one dialog too many.
          if (window.__adminPending) return;
          window.showNoticeDialog &&
            window.showNoticeDialog({ title: 'Admin', message: 'Admin controls unlocked.' });
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
      // The socket carried the unlock and the socket has gone. Nothing is
      // re-sent - the password is not kept anywhere - so this is a real
      // sign-out and the corner menu offers the way back in again.
      onDisconnected() {
        if (!authed) return;
        authed = false;
        paint();
        if (window.Lobby) Lobby.onAdminLocked('dropped');
      },
      isAuthed: () => authed,
    };
  })();

  document.getElementById('btnAdmin').addEventListener('click', async () => {
    closeMenu();
    if (!window.showTextPromptDialog) return;
    const password = await window.showTextPromptDialog({
      title: 'Admin login',
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
  // Both of them, or neither. One at a time is tapped on the card itself.
  document.getElementById('btnShowBoth').addEventListener('click', () => showMyCards([0, 1]));
  document.getElementById('btnShowNo').addEventListener('click', () => declineShowMyCards());
  // Tapping your own hole card turns that one over, which is the whole point
  // of being allowed to show one. Delegated from the seat container, which
  // already carries the long-press for the seat menu: a tap that lands on a
  // card is this and never that, so the menu's handlers stand down for it.
  document.getElementById('playerSeats').addEventListener('click', (e) => {
    if (!gameState || !gameState.myShow) return;
    const card = e.target.closest('.card, .card-back');
    if (!card) return;
    const seat = card.closest('.player-seat');
    if (!seat || seat.dataset.playerId !== myId) return;
    const cards = [...card.parentElement.children].filter(
      (n) => n.classList.contains('card') || n.classList.contains('card-back')
    );
    const idx = cards.indexOf(card);
    if (idx === 0 || idx === 1) showMyCards([idx]);
  });
  document.getElementById('btnCloseReplay').addEventListener('click', () => {
    closeReplayPanel();
  });
  document.getElementById('btnHint').addEventListener('click', () => {
    closeMenu();
    document.getElementById('hintModal').classList.remove('hidden');
  });
  document.getElementById('btnCards').addEventListener('click', () => {
    closeMenu();
    // card-look.js owns the dialog, the way side-panel.js owns its tabs: what
    // is chosen in there lands on <body> and on the server, not here.
    if (window.CardLook) CardLook.open();
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
    // Dragging off a preset puts its light out; landing back on one lights it.
    if (typeof markPickedPreset === 'function') markPickedPreset();
    // And the button is the confirm on a phone, so it follows the drag too.
    if (typeof syncRaiseLabel === 'function') syncRaiseLabel();
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
    if (typeof updateTurnClocks === 'function') updateTurnClocks();
    // The action bubbles expire on wall-clock time, and a table waiting on one
    // seat pushes no state to re-evaluate them against.
    if (typeof expireActionBadges === 'function') expireActionBadges();
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
        fold();
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

  // Every modal that Escape closes and that closes on a click outside it. One
  // list, because the two used to be written out separately and adding a
  // dialog to one of them and not the other is the obvious way to get it
  // half wired.
  const MODALS = [
    'lbPanel',
    'replayPanel',
    'hintModal',
    'cardsModal',
    'resultModal',
    'appDialogModal',
  ];

  // Close modals with Escape
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('menuDropdown').classList.contains('open')) {
      closeMenu();
      return;
    }
    if (window.Lobby && Lobby.lobbyMenuOpen()) {
      Lobby.closeLobbyMenu();
      return;
    }
    for (const id of MODALS) {
      if (closeOverlayById(id)) return;
    }
    // Nothing modal was open: a phone's panel drawer is next in line.
    if (window.SidePanel) SidePanel.close();
  });

  MODALS.forEach((id) => {
    const overlay = document.getElementById(id);
    if (!overlay) return;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeOverlayById(id);
    });
  });
}

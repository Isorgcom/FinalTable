function sendAction(action, amount) {
  if (!socket) return;
  socket.emit('action', { action, amount });
}

function setAnimationDelay(el, delaySeconds) {
  el.style.setProperty('--deal-delay', `${delaySeconds}s`);
}

function updateGameState(state) {
  const oldRound = gameState ? gameState.roundCount : -1;
  const oldCommunityLen = gameState ? gameState.communityCards.length : 0;
  const hadGameOver = !!(gameState && gameState.gameOver);
  const previousMe = gameState && myId ? gameState.players.find((p) => p.id === myId) : null;
  gameState = state;

  // Detect new round → force full rebuild + clear equity
  if (state.roundCount !== oldRound) {
    prevCommunityCount = 0;
    _builtRound = -1; // force player seat rebuild
    _dealAnimationRound = state.roundCount;
    _currentEquity = null; // v11: clear equity on new round
    const eqDetail = document.getElementById('eqSideDetail');
    if (eqDetail) eqDetail.classList.add('hidden');
  }
  if ((hadGameOver && !state.gameOver) || state.roundCount < oldRound) {
    document.getElementById('resultModal').classList.add('hidden');
  }
  const nextMe = state && myId ? state.players.find((p) => p.id === myId) : null;
  if (previousMe && nextMe) {
    if (previousMe.isConnected !== false && nextMe.isConnected === false) {
      addLog('⚠️ Connection lost · auto-play may take over this seat');
    } else if (previousMe.isConnected === false && nextMe.isConnected !== false) {
      addLog(
        nextMe.autoPlay
          ? '✅ Reconnected · auto-play is still active, tap resume when ready'
          : '✅ Reconnected · control restored'
      );
    }
    if (!previousMe.isSpectator && nextMe.isSpectator) {
      addLog('👀 Spectating until the next hand');
    } else if (previousMe.isSpectator && !nextMe.isSpectator) {
      addLog('🪑 Back in the game');
    }
  }

  renderTable(oldCommunityLen);
  updateActionsPanel();
  updateTopBar();
  updateTournamentBanner();
  updateModeUI(); // v11
  updateEquityButton(); // v11
  const resultModal = document.getElementById('resultModal');
  if (resultModal && !resultModal.classList.contains('hidden') && (state.gameOver || state.phase === 'showdown')) {
    showResult({ refreshOnly: true });
  }
}

function renderTable(oldCommunityLen) {
  if (!gameState) return;

  // ── Community cards ──
  // Always rebuild, but only animate NEW cards
  const cc = document.getElementById('communityCards');
  const curCount = gameState.communityCards.length;
  const prevCount = oldCommunityLen !== undefined ? oldCommunityLen : prevCommunityCount;

  cc.textContent = '';
  if (gameState.isRunning || gameState.phase === 'showdown') {
    for (let i = 0; i < 5; i++) {
      if (i < curCount) {
        const isNew = i >= prevCount;
        const cardEl = createCardElement(
          gameState.communityCards[i],
          isNew ? 'dealing-community' : ''
        );
        if (isNew) setAnimationDelay(cardEl, (i - prevCount) * 0.12);
        cc.appendChild(cardEl);
      } else {
        const ph = document.createElement('div');
        ph.className = 'card-back card-placeholder';
        cc.appendChild(ph);
      }
    }
  }
  prevCommunityCount = curCount;

  // ── Pot ──
  document.getElementById('potDisplay').querySelector('.pot-amount').textContent =
    gameState.isRunning ? `${gameState.pot}` : '';

  // ── Players: INCREMENTAL ──
  renderPlayersIncremental();

  // ── Round overlay ──
  const overlay = document.getElementById('roundOverlay');
  const isTournament = gameState.tournament && gameState.tournament.isActive;
  if (!gameState.isRunning && gameState.phase !== 'showdown') {
    const modeSelect = document.getElementById('modeSelectBtns');
    const nextBtn = document.getElementById('btnNextRoundAction');

    if (gameState.roundCount === 0 && !isTournament) {
      overlay.classList.remove('hidden');
      modeSelect.classList.remove('hidden');
      nextBtn.classList.add('hidden');
    } else {
      overlay.classList.add('hidden');
    }
  } else {
    overlay.classList.add('hidden');
  }
}

// Track what's been built to avoid unnecessary DOM rebuilds
let _builtRound = -1;
let _builtPlayerCount = -1;
let _builtPhase = '';
let _builtHostName = '';
let _builtIdentityKey = '';
let _dealAnimationRound = -1;

function getPlayerIdentityKey(players) {
  return players
    .map((p) => {
      const profile = p.npcProfile || {};
      return [
        p.id,
        p.name,
        p.avatar || '',
        p.isNPC ? 'npc' : 'human',
        profile.nameEn || '',
        profile.title || '',
        profile.titleEn || '',
        profile.avatar || '',
        profile.isWestern ? 'western' : '',
        p.isReady ? 'ready' : '',
        p.autoPlay ? 'auto' : '',
        p.isConnected === false ? 'offline' : 'online',
        p.isSpectator ? 'spectator' : '',
      ].join(':');
    })
    .join('|');
}

function renderPlayersIncremental() {
  const container = document.getElementById('playerSeats');
  const playerCount = gameState.players.length;
  const identityKey = getPlayerIdentityKey(gameState.players);
  const needsFullRebuild =
    _builtRound !== gameState.roundCount ||
    _builtPlayerCount !== playerCount ||
    _builtHostName !== (gameState.hostName || '') ||
    _builtIdentityKey !== identityKey ||
    (_builtPhase === 'showdown' && gameState.phase !== 'showdown') ||
    (_builtPhase !== 'showdown' && gameState.phase === 'showdown') ||
    container.children.length === 0;

  if (needsFullRebuild) {
    _builtRound = gameState.roundCount;
    _builtPlayerCount = playerCount;
    _builtPhase = gameState.phase;
    _builtHostName = gameState.hostName || '';
    _builtIdentityKey = identityKey;
    renderPlayersFull(container);
    return;
  }

  _builtPhase = gameState.phase;
  // ── Fast path: only update dynamic data in-place ──
  const myIndex = gameState.players.findIndex((p) => p.id === myId);
  const ordered = [];
  for (let i = 0; i < playerCount; i++) {
    const idx = (myIndex + i) % playerCount;
    ordered.push({ ...gameState.players[idx], originalIndex: idx });
  }
  const seatPositions = getSeatPositions(ordered.length);

  ordered.forEach((player, seatIdx) => {
    const seat = container.children[seatIdx];
    if (!seat) return;

    // Update fold/active classes
    seat.classList.toggle('folded', !!player.folded);
    seat.classList.toggle('auto-play', !!player.autoPlay);
    seat.classList.toggle('offline', player.isConnected === false);
    seat.classList.toggle('spectating', !!player.isSpectator);
    seat.classList.toggle(
      'active-turn',
      player.originalIndex === gameState.currentPlayerIndex && gameState.isRunning
    );

    // Update chips text
    const chipsEl = seat.querySelector('.player-chips');
    if (chipsEl) chipsEl.textContent = player.chips;

    // Update totalBet (already ) display
    let totalBetEl = seat.querySelector('.player-totalbet');
    if (gameState.isRunning && player.totalBet > 0) {
      if (!totalBetEl) {
        totalBetEl = document.createElement('div');
        totalBetEl.className = 'player-totalbet';
        const info = seat.querySelector('.player-info');
        if (info) info.appendChild(totalBetEl);
      }
      totalBetEl.textContent = 'in ' + player.totalBet;
    } else if (totalBetEl) {
      totalBetEl.remove();
    }

    // Update all-in indicator
    let allInEl = seat.querySelector('.allin-indicator');
    if (player.allIn && !allInEl) {
      allInEl = document.createElement('div');
      allInEl.className = 'allin-indicator';
      allInEl.textContent = 'ALL IN';
      const info = seat.querySelector('.player-info');
      if (info) info.appendChild(allInEl);
    } else if (!player.allIn && allInEl) {
      allInEl.remove();
    }

    // Update action badge
    const oldBadge = seat.querySelector('.player-action-badge');
    if (oldBadge) oldBadge.remove();

    if (player.lastAction && Date.now() - player.lastAction.time < 3000) {
      const ACTION_LABELS = {
        fold: 'fold',
        check: 'check',
        call: 'call',
        raise: 'raise',
        allin: 'ALL IN',
      };
      const ACTION_CSS = {
        fold: 'action-fold',
        check: 'action-check',
        call: 'action-call',
        raise: 'action-raise',
        allin: 'action-allin',
      };
      const badge = document.createElement('div');
      badge.className = 'player-action-badge ' + (ACTION_CSS[player.lastAction.action] || '');
      let label = ACTION_LABELS[player.lastAction.action] || player.lastAction.action;
      if (player.lastAction.amount > 0 && player.lastAction.action !== 'fold')
        label += ' ' + player.lastAction.amount;
      badge.textContent = label;
      badge.title = label;
      const info = seat.querySelector('.player-info');
      if (info) {
        info.appendChild(badge);
      }
    }

    // Update bet badge (inside player-info)
    const info = seat.querySelector('.player-info');
    let betBadge = info ? info.querySelector('.player-bet-badge') : null;
    if (player.bet > 0) {
      if (!betBadge) {
        betBadge = document.createElement('div');
        betBadge.className = 'player-bet-badge';
        if (info) info.appendChild(betBadge);
      }
      betBadge.textContent = `bet ${player.bet}`;
    } else if (betBadge) {
      betBadge.remove();
    }
  });

  updateTurnTimerBars(ordered);
}

function createTextElement(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

function getPlayerDisplayName(player) {
  if (!player) return '';
  if (player.isNPC && player.npcProfile && player.npcProfile.isWestern) {
    return player.npcProfile.nameEn || player.name;
  }
  return player.name;
}

function appendNpcTooltip(info, player, pos) {
  const p = player.npcProfile;
  if (!p || !p.bio) return;
  const isWestern = p.isWestern;
  const topPct = parseFloat(pos.top);
  const tooltip = document.createElement('div');
  tooltip.className = topPct < 50 ? 'npc-tooltip tooltip-below' : 'npc-tooltip';

  if (isWestern) {
    tooltip.appendChild(
      createTextElement(
        'div',
        'npc-tooltip-title',
        `${p.titleEn || p.title} · ${p.nameEn || player.name}`
      )
    );
    tooltip.appendChild(createTextElement('div', 'npc-tooltip-origin', p.originEn || p.origin));
    tooltip.appendChild(createTextElement('div', 'npc-tooltip-bio', p.bioEn || p.bio));
  } else {
    tooltip.appendChild(
      createTextElement('div', 'npc-tooltip-title', `${p.title} · ${player.name}`)
    );
    tooltip.appendChild(
      createTextElement(
        'div',
        'npc-tooltip-title npc-tooltip-title-secondary',
        `${p.titleEn || ''} · ${p.nameEn || ''}`
      )
    );
    tooltip.appendChild(
      createTextElement('div', 'npc-tooltip-origin', `${p.origin} · ${p.originEn || ''}`)
    );
    tooltip.appendChild(createTextElement('div', 'npc-tooltip-bio', p.bio));
    tooltip.appendChild(
      createTextElement('div', 'npc-tooltip-bio npc-tooltip-bio-secondary', p.bioEn || '')
    );
  }

  info.appendChild(tooltip);
}

function appendPlayerIdentity(info, player, pos) {
  if (player.isNPC && player.npcProfile) {
    const p = player.npcProfile;
    const avatar = createTextElement('span', 'npc-avatar', p.avatar || '');
    info.appendChild(avatar);
    info.appendChild(
      createTextElement(
        'div',
        'npc-badge',
        p.isWestern ? p.titleEn || p.title : p.titleEn || p.title
      )
    );
    appendNpcTooltip(info, player, pos);
  } else {
    info.appendChild(createTextElement('span', 'npc-avatar human-avatar', player.avatar || '🧑'));
  }

  if (player.isNPC && player.npcProfile && player.npcProfile.isWestern) {
    info.appendChild(
      createTextElement('div', 'player-name', player.npcProfile.nameEn || player.name)
    );
    return;
  }

  const name = createTextElement('div', 'player-name', player.name);
  if (gameState.hostName === player.name && !player.isNPC) {
    const hostBadge = createTextElement('span', 'player-host-badge', 'host');
    hostBadge.title = 'Room host';
    name.appendChild(hostBadge);
  }
  if (
    !player.isNPC &&
    player.autoPlay
  ) {
    const autoBadge = createTextElement('span', 'player-auto-badge', 'auto');
    autoBadge.title = 'Computer is playing this seat';
    name.appendChild(autoBadge);
  }
  if (!player.isNPC && player.isSpectator) {
    const spectatorBadge = createTextElement('span', 'player-spectator-badge', 'watch');
    spectatorBadge.title = 'Spectating this hand';
    name.appendChild(spectatorBadge);
  }
  if (!player.isNPC && player.isConnected === false) {
    const offlineBadge = createTextElement('span', 'player-offline-badge', 'offline');
    offlineBadge.title = 'Disconnected';
    name.appendChild(offlineBadge);
  }
  if (
    !player.isNPC &&
    player.isReady &&
    gameState &&
    !gameState.isRunning &&
    gameState.roundCount === 0 &&
    gameState.gameMode !== 'practice'
  ) {
    const readyBadge = createTextElement('span', 'player-ready-badge', 'ready');
    readyBadge.title = 'Ready to start';
    name.appendChild(readyBadge);
  }
  info.appendChild(name);

  if (player.isNPC && player.npcProfile && player.npcProfile.nameEn) {
    info.appendChild(createTextElement('div', 'player-name-en', player.npcProfile.nameEn));
  }
}

function renderPlayersFull(container) {
  container.textContent = '';
  const ordered = getOrderedPlayersForView();

  const seatPositions = getSeatPositions(ordered.length);
  const animateDeal =
    _dealAnimationRound === gameState.roundCount &&
    gameState.phase === 'preflop' &&
    gameState.communityCards.length === 0;

  ordered.forEach((player, seatIdx) => {
    if (seatIdx >= seatPositions.length) return;
    const pos = seatPositions[seatIdx];
    const seat = document.createElement('div');
    seat.className = 'player-seat';
    if (player.folded) seat.classList.add('folded');
    if (player.autoPlay) seat.classList.add('auto-play');
    if (player.isConnected === false) seat.classList.add('offline');
    if (player.isSpectator) seat.classList.add('spectating');
    if (player.originalIndex === gameState.currentPlayerIndex && gameState.isRunning) {
      seat.classList.add('active-turn');
    }

    seat.style.left = pos.left;
    seat.style.top = pos.top;
    seat.style.transform = pos.transform;

    // Hole cards
    const holeCardsDiv = document.createElement('div');
    holeCardsDiv.className = 'player-hole-cards';
    if (player.holeCards && player.holeCards.length === 2) {
      const anim = animateDeal ? 'dealing' : '';
      const c1 = createCardElement(player.holeCards[0], anim);
      const c2 = createCardElement(player.holeCards[1], anim);
      if (anim) {
        setAnimationDelay(c1, seatIdx * 0.08);
        setAnimationDelay(c2, seatIdx * 0.08 + 0.15);
      }
      holeCardsDiv.appendChild(c1);
      holeCardsDiv.appendChild(c2);
    } else if (gameState.isRunning && !player.folded) {
      const anim = animateDeal ? ' dealing' : '';
      const b1 = document.createElement('div');
      b1.className = 'card-back' + anim;
      const b2 = document.createElement('div');
      b2.className = 'card-back' + anim;
      if (anim) {
        setAnimationDelay(b1, seatIdx * 0.08);
        setAnimationDelay(b2, seatIdx * 0.08 + 0.15);
      }
      holeCardsDiv.appendChild(b1);
      holeCardsDiv.appendChild(b2);
    }
    seat.appendChild(holeCardsDiv);

    // Player info box
    const info = document.createElement('div');
    info.className = 'player-info';

    appendPlayerIdentity(info, player, pos);
    info.appendChild(createTextElement('div', 'player-chips', player.chips));
    if (gameState && gameState.isRunning && player.totalBet > 0) {
      info.appendChild(createTextElement('div', 'player-totalbet', `in ${player.totalBet}`));
    }
    if (player.allIn) {
      info.appendChild(createTextElement('div', 'allin-indicator', 'ALL IN'));
    }

    // Action badge
    if (player.lastAction && Date.now() - player.lastAction.time < 3000) {
      const ACTION_LABELS = {
        fold: 'fold',
        check: 'check',
        call: 'call',
        raise: 'raise',
        allin: 'ALL IN',
      };
      const ACTION_CSS = {
        fold: 'action-fold',
        check: 'action-check',
        call: 'action-call',
        raise: 'action-raise',
        allin: 'action-allin',
      };
      const badge = document.createElement('div');
      badge.className = 'player-action-badge ' + (ACTION_CSS[player.lastAction.action] || '');
      let label = ACTION_LABELS[player.lastAction.action] || player.lastAction.action;
      if (player.lastAction.amount > 0 && player.lastAction.action !== 'fold')
        label += ' ' + player.lastAction.amount;
      badge.textContent = label;
      badge.title = label;
      info.appendChild(badge);
    }

    // D/SB/BB chips
    if (player.originalIndex === gameState.dealerIndex) {
      const dc = document.createElement('div');
      dc.className = 'dealer-chip';
      dc.textContent = 'D';
      info.appendChild(dc);
    }
    if (gameState.sbIndex !== undefined && player.originalIndex === gameState.sbIndex) {
      const sc = document.createElement('div');
      sc.className = 'sb-chip';
      sc.textContent = 'SB';
      info.appendChild(sc);
    }
    if (gameState.bbIndex !== undefined && player.originalIndex === gameState.bbIndex) {
      const bc = document.createElement('div');
      bc.className = 'bb-chip';
      bc.textContent = 'BB';
      info.appendChild(bc);
    }

    // Bet badge (inside player-info)
    if (player.bet > 0) {
      const badge = document.createElement('div');
      badge.className = 'player-bet-badge';
      badge.textContent = `bet ${player.bet}`;
      info.appendChild(badge);
    }

    seat.appendChild(info);

    container.appendChild(seat);
  });

  if (animateDeal) _dealAnimationRound = -1;
  updateTurnTimerBars(ordered);
}

function getOrderedPlayersForView() {
  if (!gameState || !Array.isArray(gameState.players) || gameState.players.length === 0) return [];
  const myIndex = gameState.players.findIndex((p) => p.id === myId);
  if (myIndex < 0) {
    return gameState.players.map((player, index) => ({ ...player, originalIndex: index }));
  }
  const ordered = [];
  for (let i = 0; i < gameState.players.length; i++) {
    const idx = (myIndex + i) % gameState.players.length;
    ordered.push({ ...gameState.players[idx], originalIndex: idx });
  }
  return ordered;
}

function createCardElement(card, animClass) {
  const el = document.createElement('div');
  const color = SUIT_COLORS[card.suit];
  const ariaName = `${RANK_NAMES[card.rank] || card.rank} of ${SUIT_NAMES[card.suit] || card.suit}`;
  el.className = `card ${color}` + (animClass ? ' ' + animClass : '');
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', ariaName);

  const front = document.createElement('div');
  front.className = 'card-front';

  const suitSym = SUIT_SYMBOLS[card.suit];
  const corner = document.createElement('div');
  corner.className = 'card-corner';
  corner.append(document.createTextNode(card.rank), document.createElement('br'), suitSym);
  const rank = createTextElement('div', 'card-rank', card.rank);
  const suit = createTextElement('div', 'card-suit', suitSym);
  const cornerBr = document.createElement('div');
  cornerBr.className = 'card-corner-br';
  cornerBr.append(document.createTextNode(card.rank), document.createElement('br'), suitSym);
  front.append(corner, rank, suit, cornerBr);
  el.appendChild(front);
  return el;
}

function updateActionsPanel() {
  const panel = document.getElementById('actionsPanel');
  if (!gameState || !gameState.isMyTurn) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');

  const me = gameState.players.find((p) => p.id === myId);
  if (!me || me.autoPlay) {
    panel.classList.add('hidden');
    return;
  }

  const toCall = gameState.currentBet - me.bet;
  const minRaise = gameState.currentBet + gameState.minRaise;

  // Show/hide check vs call
  document.getElementById('btnCheck').style.display = toCall === 0 ? '' : 'none';
  document.getElementById('btnCall').style.display = toCall > 0 ? '' : 'none';
  if (toCall > 0) {
    const callCost = Math.min(toCall, me.chips);
    if (callCost >= me.chips) {
      document.getElementById('btnCall').textContent = `all-in call ${callCost}`;
    } else {
      document.getElementById('btnCall').textContent = `call ${callCost}`;
    }
  }

  // Hide raise/allin when no opponents can respond (all are all-in or folded)
  const canRaise = gameState.canRaise !== false;
  document.querySelector('.raise-slider-group').style.display = canRaise ? '' : 'none';
  document.getElementById('btnRaise').style.display = canRaise ? '' : 'none';
  document.getElementById('btnAllIn').style.display = canRaise ? '' : 'none';

  // Update raise slider
  if (canRaise) {
    const slider = document.getElementById('raiseSlider');
    const maxRaiseTo = me.chips + me.bet; // most many can add to

    if (minRaise > maxRaiseTo) {
      // Chips below min raise threshold: can only call or all-in, hide raise
      document.querySelector('.raise-slider-group').style.display = 'none';
      document.getElementById('btnRaise').style.display = 'none';
    } else {
      const raiseInput = document.getElementById('raiseInput');
      const currentValue = parseInt(raiseInput.value, 10);
      const turnKey = [
        gameState.roundCount,
        gameState.phase,
        gameState.currentPlayerIndex,
        me.id,
        minRaise,
        maxRaiseTo,
        gameState.currentBet,
        me.bet,
      ].join(':');
      const preserveCurrent =
        slider.dataset.turnKey === turnKey &&
        slider.dataset.userAdjusted === 'true' &&
        Number.isFinite(currentValue);
      const raiseTo = preserveCurrent
        ? Math.max(minRaise, Math.min(maxRaiseTo, currentValue))
        : minRaise;
      slider.min = minRaise;
      slider.max = maxRaiseTo;
      slider.value = raiseTo;
      slider.dataset.turnKey = turnKey;
      if (!preserveCurrent) slider.dataset.userAdjusted = 'false';
      slider.setAttribute('aria-valuemin', minRaise);
      slider.setAttribute('aria-valuemax', maxRaiseTo);
      slider.setAttribute('aria-valuenow', raiseTo);
      raiseInput.value = raiseTo;
      const npEl = document.getElementById('raiseNeedPay');
      if (npEl) npEl.textContent = `to ${raiseTo} · +${Math.max(0, raiseTo - me.bet)}`;
    }
  }
}

function updateTurnTimerBars(orderedPlayers) {
  const container = document.getElementById('playerSeats');
  if (!container || !gameState) return;
  const ordered = orderedPlayers || getOrderedPlayersForView();
  const currentSeat = ordered.find(
    (player) =>
      player.originalIndex === gameState.currentPlayerIndex &&
      !player.folded &&
      !player.allIn
  );
  const remainingMs =
    gameState.turnExpiresAt && gameState.turnDurationMs
      ? Math.max(0, gameState.turnExpiresAt - Date.now())
      : 0;
  const ratio =
    gameState.turnExpiresAt && gameState.turnDurationMs
      ? Math.max(0, Math.min(1, remainingMs / gameState.turnDurationMs))
      : 0;
  const secondsLeft = Math.max(1, Math.ceil(remainingMs / 1000));

  Array.from(container.children).forEach((seat, seatIdx) => {
    let timer = seat.querySelector('.player-turn-timer');
    const shouldShow =
      !!currentSeat &&
      ordered[seatIdx] &&
      ordered[seatIdx].originalIndex === currentSeat.originalIndex &&
      gameState.gameMode !== 'cash' &&
      gameState.isRunning &&
      gameState.turnExpiresAt;
    if (!shouldShow) {
      if (timer) timer.remove();
      return;
    }
    if (!timer) {
      timer = document.createElement('div');
      timer.className = 'player-turn-timer';
      const icon = document.createElement('span');
      icon.className = 'player-turn-timer-icon';
      icon.textContent = '⌛';
      const text = document.createElement('span');
      text.className = 'player-turn-timer-text';
      timer.append(icon, text);
      seat.appendChild(timer);
    }
    timer.classList.toggle('is-critical', ratio <= 0.35);
    timer.style.setProperty('--timer-ratio', `${Math.max(0, ratio)}`);
    timer.title = `${secondsLeft}s left`;
    timer.setAttribute('aria-label', `${secondsLeft} seconds left to act`);
    const text = timer.querySelector('.player-turn-timer-text');
    if (text) text.textContent = `${secondsLeft}s`;
  });
}

function updateTopBar() {
  if (!gameState) return;
  const phaseNames = {
    waiting: 'Waiting',
    preflop: 'Preflop',
    flop: 'Flop',
    turn: 'Turn',
    river: 'River',
    showdown: 'Showdown',
  };
  const me = gameState.players.find((p) => p.id === myId);
  const topInfo = document.getElementById('topInfo');
  if (!topInfo) return;

  let text = '';
  if (me && me.isConnected === false) {
    text = me.autoPlay ? 'Disconnected · Auto-play active' : 'Disconnected';
  } else if (me && me.isSpectator && !gameState.gameOver) {
    text =
      me.chips > 0
        ? 'Spectating · joins next hand'
        : gameState.tournament && gameState.tournament.isActive
          ? 'Spectating · eliminated from tournament'
          : 'Spectating';
  } else if (!gameState.isRunning && gameState.roundCount === 0) {
    if (gameState.gameMode === 'practice') {
      text = 'Practice table ready';
    } else {
      const humanPlayers = gameState.players.filter((p) => !p.isNPC);
      if (humanPlayers.length < 2) {
        const needed = 2 - humanPlayers.length;
        text = `Waiting for ${needed} more player${needed === 1 ? '' : 's'}`;
      } else if (typeof isReadyCheckEnabled === 'function' && isReadyCheckEnabled()) {
        const summary = getReadySummary();
        text = `${summary.readyHumans}/${summary.totalHumans} guests ready`;
      } else {
        text = 'Waiting to deal';
      }
      if (gameState.hostName) text += ` · Host ${gameState.hostName}`;
    }
  } else {
    // Showdown deliberately has no special case: it reads as
    // "Round N · Showdown · chips" like every other phase. The old
    // "Hand complete" wording announced a pause that does not exist, since the
    // server deals the next hand on its own timer.
    text =
      `Round ${gameState.roundCount} · ${phaseNames[gameState.phase] || gameState.phase}` +
      (me ? ` · ${me.chips}` : '');
  }

  if (me && me.autoPlay) text += ' · Auto';

  topInfo.textContent = text;
}

function showResult(options = {}) {
  const { refreshOnly = false } = options;
  const modal = document.getElementById('resultModal');
  const details = document.getElementById('resultDetails');
  const title = document.getElementById('resultTitle');
  const rematchTools = document.getElementById('resultRematchTools');

  if (!gameState) return;

  // No "Hand Complete" popup between hands.
  //
  // It interrupted the table after every single hand while doing nothing: the
  // server has no 'nextRound' handler, so the button's socket.emit('nextRound')
  // was a no-op, and the next hand is dealt by the server's own _autoTimer
  // regardless of whether anyone clicked. Everything the popup listed (winner,
  // split pots, unmatched chips returned) is already emitted to the message log
  // by engine.js, so nothing is lost by dropping it.
  //
  // The modal is still the game-over UI, where its buttons genuinely do
  // something (Play Again, Exit Table, ready toggle), so only that case shows.
  if (!gameState.gameOver) {
    modal.classList.add('hidden');
    return;
  }

  // v11: clear equity
  _currentEquity = null;
  updateEquityUI(null);

  // Check if human player won this hand
  const me = gameState.players.find((p) => p.id === myId);

  details.textContent = '';

  // War report highlights
  if (gameState.warReport && gameState.warReport.highlights) {
    const report = document.createElement('div');
    report.className = 'war-report-details';
    for (const h of gameState.warReport.highlights) {
      report.appendChild(createTextElement('div', 'wr-highlight', h));
    }
    details.appendChild(report);
    const separator = document.createElement('hr');
    separator.className = 'result-separator';
    details.appendChild(separator);
  }

  const refundEntries = Array.isArray(gameState.lastRoundRefunds) ? gameState.lastRoundRefunds : [];
  const myRefund = refundEntries.find((entry) => entry.playerId === myId);
  if (myRefund) {
    details.appendChild(
      createTextElement(
        'div',
        'result-refund result-refund-me',
        `Returned ${myRefund.amount} unmatched chips`
      )
    );
  } else if (refundEntries.length > 0) {
    refundEntries.forEach((entry) => {
      const refundPlayer = gameState.players.find((player) => player.id === entry.playerId);
      const refundName = getPlayerDisplayName(refundPlayer) || entry.playerName;
      details.appendChild(
        createTextElement(
          'div',
          'result-refund',
          `${refundName} had ${entry.amount} unmatched chips returned`
        )
      );
    });
  }

  const sorted = [...gameState.players].sort((a, b) => b.chips - a.chips);
  for (const p of sorted) {
    const isMe = p.id === myId;
    details.appendChild(
      createTextElement(
        'div',
        isMe ? 'winner-line' : '',
        `${getPlayerDisplayName(p)}: ${p.chips} chips (${p.wins} wins)`
      )
    );
  }

  // Server tells us exactly who won — no message parsing needed
  const iWon = gameState.lastRoundWinnerIds && gameState.lastRoundWinnerIds.includes(myId);
  const gameOver = gameState.gameOver;
  const gameOverWinner = gameOver
    ? gameState.players.find((player) => player.id === gameOver.winnerId)
    : null;

  if (gameOver) {
    const winnerName = getPlayerDisplayName(gameOverWinner) || gameOver.winnerName || 'Winner';
    title.textContent = iWon ? 'You cleared the table!' : `${winnerName} cleared the table`;
    title.classList.add('result-title-winner');
    details.appendChild(document.createElement('hr')).className = 'result-separator';
    const rematchGuests = gameState.players.filter((player) => !player.isNPC && player.name !== gameState.hostName);
    const readyGuests = rematchGuests.filter((player) => player.isReady);
    details.appendChild(
      createTextElement(
        'div',
        'result-refund',
        'The table is finished. Choose Play Again to reset all chips, or Exit Table to leave.'
      )
    );
    if (rematchGuests.length > 0) {
      const waitingGuests = rematchGuests.filter((player) => !player.isReady);
      details.appendChild(
        createTextElement(
          'div',
          'result-refund',
          `Rematch readiness: ${readyGuests.length}/${rematchGuests.length} guests ready`
        )
      );
      if (readyGuests.length > 0) {
        details.appendChild(
          createTextElement(
            'div',
            'result-refund',
            `Ready: ${readyGuests.map((player) => getPlayerDisplayName(player)).join(', ')}`
          )
        );
      }
      if (waitingGuests.length > 0) {
        details.appendChild(
          createTextElement(
            'div',
            'result-refund',
            `Waiting: ${waitingGuests.map((player) => getPlayerDisplayName(player)).join(', ')}`
          )
        );
      }
    }
    if (rematchTools) rematchTools.classList.toggle('hidden', !gameState.isHost);
    if (iWon && !refreshOnly) launchConfetti();
  } else if (iWon) {
    title.textContent = 'You won!';
    title.classList.add('result-title-winner');
    // Confetti celebration
    if (!refreshOnly) launchConfetti();
    if (rematchTools) rematchTools.classList.add('hidden');
  } else {
    // Only reachable at game over now that the between-hands popup is gone.
    title.textContent = 'Table over';
    title.classList.remove('result-title-winner');
    if (rematchTools) rematchTools.classList.add('hidden');
  }

  const latestHand =
    gameState.recentHands && gameState.recentHands.length > 0
      ? gameState.recentHands[gameState.recentHands.length - 1]
      : null;
  if (latestHand && Array.isArray(latestHand.winners) && latestHand.winners.length > 0) {
    const winSummary = latestHand.winners
      .map((winner) => `${winner.playerName} won with ${winner.handName || 'the pot'}`)
      .join(' · ');
    details.appendChild(createTextElement('div', 'result-victory-line', winSummary));
  }

  modal.classList.remove('hidden');
}

// Confetti celebration effect for human winners
function launchConfetti() {
  const container = document.createElement('div');
  container.className = 'confetti-layer';
  document.body.appendChild(container);

  const colors = ['#c9a84c', '#e8e0d0', '#5c3d1a', '#4a7a5a', '#8a7e6a', '#f5f0e8'];
  const emojis = ['✨', '♠', '♦', '♣', '♥'];

  for (let i = 0; i < 60; i++) {
    const piece = document.createElement('div');
    const isEmoji = Math.random() < 0.2;
    piece.className = isEmoji ? 'confetti-piece confetti-piece-emoji' : 'confetti-piece';
    piece.style.setProperty('--confetti-left', `${Math.random() * 100}%`);
    piece.style.setProperty('--confetti-delay', `${Math.random() * 0.8}s`);
    piece.style.setProperty('--confetti-duration', `${2 + Math.random() * 2}s`);
    piece.style.setProperty('--confetti-drift', `${-50 + Math.random() * 100}px`);
    if (isEmoji) {
      piece.textContent = emojis[Math.floor(Math.random() * emojis.length)];
      piece.style.setProperty('--confetti-size', `${16 + Math.random() * 16}px`);
    } else {
      const color = colors[Math.floor(Math.random() * colors.length)];
      piece.style.setProperty('--confetti-width', `${6 + Math.random() * 6}px`);
      piece.style.setProperty('--confetti-height', `${4 + Math.random() * 8}px`);
      piece.style.setProperty('--confetti-color', color);
      piece.style.setProperty('--confetti-rotation', `${Math.random() * 360}deg`);
    }
    container.appendChild(piece);
  }

  setTimeout(() => container.remove(), 4000);
}

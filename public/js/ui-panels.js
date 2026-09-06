function normalizeRuntimeLogMessage(msg) {
  if (!gameState || !Array.isArray(gameState.players) || !msg) return msg;
  const replacements = gameState.players
    .filter((player) => player.isNPC && player.npcProfile && player.npcProfile.isWestern)
    .map((player) => ({
      from: player.name,
      to: player.npcProfile.nameEn || player.name,
    }))
    .filter((entry) => entry.from && entry.to && entry.from !== entry.to)
    .sort((a, b) => b.from.length - a.from.length);

  let normalized = msg;
  for (const entry of replacements) {
    normalized = normalized.replaceAll(entry.from, entry.to);
  }
  return normalized;
}

// The dealer log lives in the side panel's Chat tab; the ticker over the
// felt repeats the last line for when the panel is out of view.
function addLog(msg) {
  const body = document.getElementById('panelChatBody');
  const last = document.getElementById('logLast');
  if (!body || !last) return;
  const displayMsg = normalizeRuntimeLogMessage(msg);
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  if (
    displayMsg.includes('wins') ||
    displayMsg.includes('splits pot') ||
    displayMsg.includes('🏆') ||
    displayMsg.includes('🤝')
  )
    entry.classList.add('highlight');
  if (displayMsg.includes('↩') || displayMsg.includes('returned')) entry.classList.add('muted');
  if (displayMsg.includes('💬')) entry.classList.add('npc-chat');
  entry.textContent = displayMsg;
  body.appendChild(entry);
  body.scrollTop = body.scrollHeight;

  // The ticker shows the last line; CSS clamps it to a few lines.
  last.textContent = displayMsg.replace(/💬\s*/, '');
  if (window.SidePanel) SidePanel.notify('chat');

  // Keep only last 50
  while (body.children.length > 50) body.removeChild(body.firstChild);
}

const STYLE_NAMES = {
  aggressive: 'Aggressive',
  tight: 'Tight',
  maniac: 'Maniac',
  tricky: 'Tricky',
  rock: 'Rock',
  balanced: 'Balanced',
  passive: 'Passive',
};

function getReplayPlayerDisplayName(player) {
  if (!player) return '';
  if (player.isNPC && player.npcProfile && player.npcProfile.isWestern) {
    return player.npcProfile.nameEn || player.name;
  }
  return player.name;
}

function getReplayNameByPlayerId(hand, playerId, fallbackName) {
  if (!hand || !Array.isArray(hand.players)) return fallbackName || '';
  const player = hand.players.find((entry) => entry.id === playerId);
  return getReplayPlayerDisplayName(player) || fallbackName || '';
}

function getReplayWinnerText(hand, winner) {
  const winnerName = getReplayNameByPlayerId(hand, winner.playerId, winner.playerName);
  return winner.handName ? `${winnerName} (${winner.handName})` : winnerName;
}

function renderNPCPanel(profiles) {
  const grid = document.getElementById('npcGrid');
  const currentNPCs = gameState ? gameState.players.filter((p) => p.isNPC).map((p) => p.name) : [];
  const isRunning = gameState && gameState.isRunning;
  const canManageNPCs = gameState && gameState.isHost && !isRunning;

  grid.textContent = '';
  for (const p of profiles) {
    const atTable = currentNPCs.includes(p.name);
    const isW = p.isWestern;
    const card = document.createElement('div');
    card.className = 'npc-card' + (atTable ? ' at-table' : '');

    const header = document.createElement('div');
    header.className = 'npc-card-header';
    header.appendChild(createTextElement('span', 'npc-card-avatar', p.avatar || ''));

    const nameBlock = document.createElement('div');
    if (isW) {
      nameBlock.appendChild(createTextElement('div', 'npc-card-name', p.nameEn || p.name));
      nameBlock.appendChild(createTextElement('div', 'npc-card-title', p.titleEn || p.title));
    } else {
      nameBlock.appendChild(createTextElement('div', 'npc-card-name', p.name));
      nameBlock.appendChild(
        createTextElement('div', 'npc-card-title npc-card-title-muted', p.nameEn || '')
      );
      nameBlock.appendChild(createTextElement('div', 'npc-card-title', p.titleEn || p.title));
    }
    header.appendChild(nameBlock);
    card.appendChild(header);
    card.appendChild(
      createTextElement(
        'div',
        'npc-card-origin',
        isW ? p.originEn || p.origin : `${p.origin} · ${p.originEn || ''}`
      )
    );
    if (isW) {
      card.appendChild(createTextElement('div', 'npc-card-bio', p.bioEn || p.bio));
    } else {
      card.appendChild(createTextElement('div', 'npc-card-bio', p.bio));
      card.appendChild(
        createTextElement('div', 'npc-card-bio npc-card-bio-secondary', p.bioEn || '')
      );
    }
    card.appendChild(createTextElement('span', 'npc-card-style', STYLE_NAMES[p.style] || p.style));

    if (!canManageNPCs) {
      card.appendChild(
        createTextElement('span', 'npc-card-status', isRunning ? 'in game' : 'host only')
      );
    } else {
      const npcBtn = document.createElement('button');
      npcBtn.className = atTable ? 'npc-card-btn remove' : 'npc-card-btn add';
      npcBtn.dataset.npcAction = atTable ? 'remove' : 'add';
      npcBtn.dataset.npcName = p.name;
      npcBtn.textContent = atTable ? 'remove' : 'join';
      npcBtn.addEventListener('click', () => {
        const action = npcBtn.dataset.npcAction;
        const name = npcBtn.dataset.npcName;
        if (action === 'add') addNPC(name);
        else removeNPC(name);
      });
      card.appendChild(npcBtn);
    }
    grid.appendChild(card);
  }
}

function addNPC(name) {
  if (socket) {
    socket.emit('addNPC', { npcName: name });
    setTimeout(() => socket.emit('getNPCList'), 300);
  }
}
function removeNPC(name) {
  if (socket) {
    socket.emit('removeNPC', { npcName: name });
    setTimeout(() => socket.emit('getNPCList'), 300);
  }
}

// ============================================================
//  TOURNAMENT BANNER
// ============================================================
function updateTournamentBanner() {
  const banner = document.getElementById('tournamentBanner');
  if (!gameState || !gameState.tournament || !gameState.tournament.isActive) {
    banner.classList.add('hidden');
    if (tournamentTimer) {
      clearInterval(tournamentTimer);
      tournamentTimer = null;
    }
    return;
  }
  banner.classList.remove('hidden');
  const t = gameState.tournament;
  document.getElementById('tbLevel').textContent = t.currentLevel + 1;
  document.getElementById('tbBlinds').textContent = t.blinds.sb + '/' + t.blinds.bb;
  document.getElementById('tbAlive').textContent =
    gameState.players.filter((p) => p.chips > 0).length + '/' + t.startingPlayers;

  // Live countdown timer
  if (tournamentTimer) clearInterval(tournamentTimer);
  let remaining = t.timeUntilNextLevel;
  const timerEl = document.getElementById('tbTimer');
  timerEl.textContent = Math.floor(remaining / 60) + ':' + String(remaining % 60).padStart(2, '0');
  tournamentTimer = setInterval(() => {
    remaining--;
    if (remaining < 0) remaining = 0;
    timerEl.textContent =
      Math.floor(remaining / 60) + ':' + String(remaining % 60).padStart(2, '0');
  }, 1000);
}

// ============================================================
//  LEADERBOARD
// ============================================================
function renderLeaderboard() {
  const body = document.getElementById('lbBody');
  body.textContent = '';
  const appendEmptyRow = (text) => {
    const row = document.createElement('tr');
    const cell = createTextElement('td', 'table-empty', text);
    cell.colSpan = 6;
    row.appendChild(cell);
    body.appendChild(row);
  };

  if (!gameState || !gameState.leaderboard) {
    appendEmptyRow('No data yet');
    return;
  }
  const lb = gameState.leaderboard;
  if (lb.length === 0) {
    appendEmptyRow('No data yet — play some hands');
    return;
  }

  lb.forEach((s, i) => {
    const wr = s.handsPlayed > 0 ? ((s.handsWon / s.handsPlayed) * 100).toFixed(0) + '%' : '-';
    const isMe = gameState.players.some((p) => p.name === s.name && p.id === myId);
    const row = document.createElement('tr');
    if (isMe) row.className = 'lb-me';
    [i + 1, s.name, s.handsWon, s.handsPlayed, wr, s.biggestPot].forEach((value) => {
      row.appendChild(createTextElement('td', '', value));
    });
    body.appendChild(row);
  });
}

// ============================================================
//  HAND REPLAY
// ============================================================
const PHASE_NAMES = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River' };

function renderReplayList() {
  const list = document.getElementById('replayHandList');
  const detail = document.getElementById('replayDetail');
  list.classList.remove('hidden');
  detail.classList.add('hidden');
  list.textContent = '';
  if (!gameState || !gameState.recentHands || gameState.recentHands.length === 0) {
    list.appendChild(createTextElement('div', 'panel-empty', 'No hand history yet'));
    return;
  }
  gameState.recentHands
    .slice()
    .reverse()
    .forEach((h) => {
      const winnerNames = h.winners.map((w) => getReplayWinnerText(h, w)).join(', ');
      const btn = createTextElement(
        'button',
        'replay-hand-btn',
        `Hand ${h.handNum} | Pot ${h.pot} | Winner: ${winnerNames}`
      );
      btn.dataset.handNum = h.handNum;
      btn.addEventListener('click', () => loadReplay(h.handNum));
      list.appendChild(btn);
    });
}

function loadReplay(handNum) {
  if (socket) {
    socket.emit('getReplay', { handNum });
    return;
  }
  if (!gameState || !gameState.recentHands) return;
  const hand = gameState.recentHands.find((h) => h.handNum === handNum);
  if (hand) {
    document.getElementById('replayHandList').classList.add('hidden');
    renderReplayDetail(hand);
  }
}

function renderReplayDetail(hand) {
  const detailDiv = document.getElementById('replayDetail');
  detailDiv.classList.remove('hidden');
  const replayTitle = document.getElementById('replayTitle');
  const phaseLabel = PHASE_NAMES[hand.phase] || hand.phase || 'hand complete';
  replayTitle.textContent = '';
  const backBtn = document.createElement('button');
  backBtn.className = 'replay-back-btn';
  backBtn.textContent = '← back';
  backBtn.addEventListener('click', renderReplayList);
  replayTitle.append(
    backBtn,
    document.createTextNode(
      `Hand ${hand.handNum} · Pot ${hand.pot} · Blinds ${hand.smallBlind}/${hand.bigBlind} · Ended on ${phaseLabel}`
    )
  );
  const replayWinnerSummary = document.getElementById('replayWinnerSummary');
  if (replayWinnerSummary) {
    replayWinnerSummary.textContent =
      hand.winners.length > 0
        ? `Winner: ${hand.winners.map((winner) => getReplayWinnerText(hand, winner)).join(', ')}`
        : 'Winner: none';
  }

  // Player hole cards
  const cardsDiv = document.getElementById('replayPlayerCards');
  cardsDiv.textContent = '';
  for (const p of hand.players) {
    const cards = hand.holeCards[p.id];
    if (!cards) continue;
    const isWinner = hand.winners.some((w) => w.playerId === p.id);
    const winningEntry = hand.winners.find((w) => w.playerId === p.id);
    const winLabel = winningEntry && winningEntry.handName ? ` · ${winningEntry.handName}` : '';
    const div = document.createElement('div');
    div.className = 'replay-player-hand';
    div.appendChild(
      createTextElement(
        'div',
        `rp-name${isWinner ? ' winner' : ''}`,
        `${getReplayPlayerDisplayName(p)}${isWinner ? ` 🏆${winLabel}` : ''}`
      )
    );
    const handCards = document.createElement('div');
    handCards.className = 'rp-cards';
    cards.forEach((card) => handCards.appendChild(createReplayCardElement(card)));
    div.appendChild(handCards);
    cardsDiv.appendChild(div);
  }

  // Community cards
  const commDiv = document.getElementById('replayCommunity');
  commDiv.textContent = '';
  for (let i = 0; i < 5; i++) {
    const card = hand.communityCards[i];
    if (card) {
      commDiv.appendChild(createReplayCardElement(card));
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'card-back replay-card replay-card-placeholder';
      commDiv.appendChild(placeholder);
    }
  }
  if (hand.communityCards.length < 5) {
    commDiv.appendChild(
      createTextElement(
        'div',
        'replay-community-note',
        `This hand ended on the ${phaseLabel.toLowerCase()}, so the remaining board cards were never dealt.`
      )
    );
  }

  // Actions
  const actDiv = document.getElementById('replayActions');
  const ACTION_NAMES = {
    fold: 'fold',
    check: 'check',
    call: 'call',
    raise: 'raise',
    allin: 'all-in',
  };
  actDiv.textContent = '';
  hand.actions.forEach((a) => {
    const phaseName = PHASE_NAMES[a.phase] || a.phase;
    const actionName = ACTION_NAMES[a.action] || a.action;
    const amountStr = a.amount > 0 ? ` ${a.amount}` : '';
    const actorName = getReplayNameByPlayerId(hand, a.playerId, a.playerName);
    actDiv.appendChild(
      createTextElement(
        'div',
        'replay-action',
        `[${phaseName}] ${actorName} ${actionName}${amountStr}`
      )
    );
  });
}

function createReplayCardElement(card) {
  const suitSym = SUIT_SYMBOLS[card.suit];
  const color = card.suit === 'hearts' || card.suit === 'diamonds' ? 'red' : 'black';
  const cardEl = document.createElement('div');
  cardEl.className = `card replay-card ${color}`;
  const front = document.createElement('div');
  front.className = 'card-front';
  front.append(
    createTextElement('div', 'card-rank', card.rank),
    createTextElement('div', 'card-suit', suitSym)
  );
  cardEl.appendChild(front);
  return cardEl;
}

// ============================================================
//  TOURNAMENT RESULT
// ============================================================
function renderTournamentResult(result) {
  const div = document.getElementById('tournamentResult');
  div.textContent = '';
  const dur = Math.floor(result.duration / 1000);
  const durMin = Math.floor(dur / 60);
  const durSec = dur % 60;

  div.appendChild(
    createTextElement(
      'div',
      'tournament-summary',
      `${durMin}m ${durSec}s | ${result.totalHands} hands | Final Level ${result.finalLevel + 1}`
    )
  );
  const placeClasses = { 1: 'tr-1st', 2: 'tr-2nd', 3: 'tr-3rd' };
  for (const e of result.eliminations) {
    const cls = placeClasses[e.place] || '';
    const row = createTextElement('div', `tr-place ${cls}`.trim(), `#${e.place}`);
    row.appendChild(createTextElement('span', '', e.name));
    div.appendChild(row);
  }
}

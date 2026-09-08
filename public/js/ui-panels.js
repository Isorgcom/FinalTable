// The dealer log lives in the side panel's Chat tab; the ticker over the
// felt repeats the last line for when the panel is out of view.
function addLog(msg, meta) {
  const body = document.getElementById('panelChatBody');
  const last = document.getElementById('logLast');
  if (!body || !last) return;
  const displayMsg = msg;
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  if (meta && meta.kind) entry.dataset.kind = meta.kind;
  if (
    displayMsg.includes('wins') ||
    displayMsg.includes('splits pot') ||
    displayMsg.includes('🏆') ||
    displayMsg.includes('🤝')
  )
    entry.classList.add('highlight');
  if (displayMsg.includes('↩') || displayMsg.includes('returned')) entry.classList.add('muted');
  entry.textContent = displayMsg;
  body.appendChild(entry);
  body.scrollTop = body.scrollHeight;

  // The ticker shows the last line; CSS clamps it to a few lines.
  last.textContent = displayMsg.replace(/💬\s*/, '');
  if (window.SidePanel) SidePanel.notify('chat');

  // Keep only last 50
  while (body.children.length > 50) body.removeChild(body.firstChild);
}

function getReplayPlayerDisplayName(player) {
  return player ? player.name : '';
}

function getReplayNameByPlayerId(hand, playerId, fallbackName) {
  if (!hand || !Array.isArray(hand.players)) return fallbackName || '';
  const player = hand.players.find((entry) => entry.id === playerId);
  return getReplayPlayerDisplayName(player) || fallbackName || '';
}

// What each winner actually took. Two names with no numbers beside them read
// as one pot split between them, which is what a side pot is not: an all-in
// player wins the main pot and somebody else wins the money bet past them, and
// leaving the amounts out makes a correct result look like a wrong one.
function getReplayWinnerText(hand, winner) {
  const winnerName = getReplayNameByPlayerId(hand, winner.playerId, winner.playerName);
  const label = winner.handName ? `${winnerName} (${winner.handName})` : winnerName;
  return Number.isFinite(winner.amount) ? `${label} ${fmtNum(winner.amount)}` : label;
}

// More than one winner and different amounts means separate pots, not a shared
// one. Said plainly rather than left for the reader to work out from the
// numbers.
function replayWinnerHeading(hand) {
  const winners = hand.winners || [];
  if (winners.length < 2) return 'Winner';
  const amounts = winners.map((w) => w.amount).filter((a) => Number.isFinite(a));
  const shared = amounts.length === winners.length && new Set(amounts).size === 1;
  return shared ? 'Split pot' : 'Winners, from separate pots';
}

// ============================================================
//  BLIND CLOCK (tournament banner + Info tab)
// ============================================================
// One interval drives both the banner over the felt and the Info tab's
// countdown, so the two can never disagree by a second.
let _blindClockRemaining = 0;

function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function paintBlindClock() {
  const text = formatClock(_blindClockRemaining);
  const timerEl = document.getElementById('tbTimer');
  if (timerEl) timerEl.textContent = text;
  const infoEl = document.getElementById('infoNextLevel');
  if (infoEl) infoEl.textContent = text;
}

function updateBlindClock() {
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

  // Live countdown, re-seeded from the server on every state update.
  if (tournamentTimer) clearInterval(tournamentTimer);
  _blindClockRemaining = t.timeUntilNextLevel;
  paintBlindClock();
  tournamentTimer = setInterval(() => {
    _blindClockRemaining = Math.max(0, _blindClockRemaining - 1);
    paintBlindClock();
  }, 1000);
}

// ============================================================
//  INFO TAB
// ============================================================
const INFO_MODE_LABELS = { cash: 'Cash Game', tournament: 'Tournament', practice: 'Practice' };

function infoSection(title) {
  const section = document.createElement('div');
  section.className = 'info-section';
  section.appendChild(createTextElement('div', 'info-section-title', title));
  return section;
}

// rows: [label, value, optional id for a value something else keeps live]
function infoGrid(rows) {
  const grid = document.createElement('div');
  grid.className = 'mtt-grid';
  rows.forEach(([label, value, id]) => {
    const cell = document.createElement('div');
    cell.className = 'mtt-cell';
    cell.appendChild(createTextElement('span', 'mtt-label', label));
    const v = createTextElement('span', 'mtt-value', value);
    if (id) v.id = id;
    v.title = String(value);
    cell.appendChild(v);
    grid.appendChild(cell);
  });
  return grid;
}

function fmtNum(n) {
  return typeof n === 'number' ? n.toLocaleString() : '-';
}

function renderInfoTab() {
  const body = document.getElementById('panelInfoBody');
  if (!body) return;
  body.textContent = '';
  const field = window.mttField || null;
  const finished = window.mttFinished || null;
  if (!gameState && !field) {
    body.appendChild(createTextElement('div', 'panel-empty', 'Take a seat to see the table'));
    return;
  }

  if (gameState) {
    const me = gameState.players.find((p) => p.id === myId);
    const t = gameState.tournament && gameState.tournament.isActive ? gameState.tournament : null;
    const alive = gameState.players.filter((p) => p.chips > 0).length;
    let room = gameState.id;
    if (field) room = field.myTable ? `Table ${field.myTable}` : 'Tournament';
    else if (gameState.gameMode === 'practice') room = 'Practice table';

    const table = infoSection('Table');
    table.appendChild(
      infoGrid([
        ['Room', room],
        [
          'Mode',
          field ? 'Multi-table' : INFO_MODE_LABELS[gameState.gameMode] || gameState.gameMode || '-',
        ],
        ['Host', gameState.hostName || '-'],
        ['Hand', gameState.roundCount ? `#${gameState.roundCount}` : '-'],
        ['Players', `${alive} / ${gameState.players.length}`],
      ])
    );
    body.appendChild(table);

    const bb = gameState.bigBlind || 0;
    const rows = [['Blinds', `${gameState.smallBlind} / ${gameState.bigBlind}`]];
    if (me && bb)
      rows.push(['Your stack', `${fmtNum(me.chips)} · ${(me.chips / bb).toFixed(1)} bb`]);
    if (t) {
      rows.push(['Level', String(t.currentLevel + 1)]);
      rows.push(['Next level', formatClock(_blindClockRemaining), 'infoNextLevel']);
      // A multi-table field shares one clock across tables; its head count
      // belongs to the Field section, not this table's roster.
      if (!field) rows.push(['Alive', `${alive} / ${t.startingPlayers}`]);
    } else if (field) {
      rows.push(['Level', String(field.level)]);
      rows.push(['Next level', formatClock(field.nextLevelIn)]);
    }
    const blinds = infoSection('Blinds');
    blinds.appendChild(infoGrid(rows));
    body.appendChild(blinds);
  }

  if (finished) {
    const section = infoSection('Final standings');
    section.appendChild(
      createTextElement(
        'div',
        'mtt-money in-money',
        finished.winner ? `${finished.winner} wins` : 'Tournament over'
      )
    );
    const ladder = document.createElement('div');
    ladder.className = 'mtt-ladder';
    (finished.results || []).slice(0, 10).forEach((r) => {
      const line = document.createElement('div');
      line.className = 'mtt-rung' + (r.inTheMoney ? ' paid' : '');
      line.appendChild(createTextElement('span', 'mtt-place', `#${r.place}`));
      line.appendChild(createTextElement('span', 'mtt-name', r.name));
      line.appendChild(createTextElement('span', 'mtt-prize', r.prize ? fmtNum(r.prize) : ''));
      ladder.appendChild(line);
    });
    section.appendChild(ladder);
    body.appendChild(section);
    return;
  }

  if (field) {
    const section = infoSection('Field');
    section.appendChild(
      infoGrid([
        ['Left', `${field.remaining} / ${field.entrants}`],
        ['Your rank', field.myRank ? `#${field.myRank}` : '-'],
        ['Average', fmtNum(field.averageStack)],
        [
          'Chip leader',
          field.chipLeader ? `${field.chipLeader.name} ${fmtNum(field.chipLeader.chips)}` : '-',
        ],
        ['Tables', `${field.tablesLeft}${field.myTable ? ` · you: ${field.myTable}` : ''}`],
      ])
    );
    // Money status reads differently on the bubble, which is the one moment a
    // player most wants to know exactly where they are.
    if (field.paidPlaces) {
      const money = document.createElement('div');
      money.className = 'mtt-money';
      if (field.inTheMoney) {
        money.classList.add('in-money');
        money.textContent = `In the money · ${field.paidPlaces} paid`;
      } else if (field.onBubble) {
        money.classList.add('on-bubble');
        money.textContent = `Bubble · ${field.remaining} left, ${field.paidPlaces} paid · hand for hand`;
      } else {
        money.textContent = `${field.paidPlaces} paid · ${field.remaining - field.paidPlaces} from the money`;
      }
      section.appendChild(money);
    }
    if (field.prizePool > 0) {
      const ladder = document.createElement('div');
      ladder.className = 'mtt-ladder';
      for (const row of field.payouts) {
        const line = document.createElement('div');
        // Highlight the rung the player would currently finish on.
        line.className = 'mtt-rung' + (field.myRank === row.place ? ' mine' : '');
        line.appendChild(createTextElement('span', 'mtt-place', `#${row.place}`));
        line.appendChild(createTextElement('span', 'mtt-prize', fmtNum(row.amount)));
        ladder.appendChild(line);
      }
      section.appendChild(ladder);
    }
    body.appendChild(section);
  }
}

// ============================================================
//  STATS TAB
// ============================================================
function renderStatsTab() {
  const body = document.getElementById('panelStatsBody');
  if (!body) return;
  body.textContent = '';

  const board = infoSection('Leaderboard');
  const table = document.createElement('table');
  table.className = 'lb-table';
  const thead = document.createElement('thead');
  const head = document.createElement('tr');
  ['#', 'Player', 'Wins', 'Hands', 'Rate', 'Max Pot'].forEach((label) =>
    head.appendChild(createTextElement('th', '', label))
  );
  thead.appendChild(head);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);
  renderLeaderboard(tbody);
  board.appendChild(table);
  body.appendChild(board);

  // The server keeps ten hands, so this is a ten-hand window, not a lifetime rate.
  const hands =
    gameState && Array.isArray(gameState.recentHands)
      ? gameState.recentHands.filter((h) => (h.players || []).some((p) => p.id === myId))
      : [];
  const recent = infoSection('Your last 10 hands');
  if (!hands.length) {
    recent.appendChild(createTextElement('div', 'panel-empty', 'No hands yet'));
  } else {
    const mine = (h) =>
      (h.actions || []).filter((a) => a.playerId === myId && a.phase === 'preflop');
    const vpip = hands.filter((h) =>
      mine(h).some((a) => ['call', 'raise', 'allin'].includes(a.action))
    ).length;
    const pfr = hands.filter((h) =>
      mine(h).some((a) => ['raise', 'allin'].includes(a.action))
    ).length;
    const won = hands.filter((h) => (h.winners || []).some((w) => w.playerId === myId));
    const biggest = won.reduce((m, h) => Math.max(m, h.pot || 0), 0);
    const pct = (n) => `${n} · ${Math.round((n / hands.length) * 100)}%`;
    recent.appendChild(
      infoGrid([
        ['Hands', String(hands.length)],
        ['Won', pct(won.length)],
        ['Chips in preflop', pct(vpip)],
        ['Raised preflop', pct(pfr)],
        ['Biggest pot won', biggest ? fmtNum(biggest) : '-'],
      ])
    );
  }
  body.appendChild(recent);
}

// ============================================================
//  HISTORY TAB
// ============================================================
function renderHistoryTab() {
  const body = document.getElementById('panelHistoryBody');
  if (!body) return;
  renderReplayHandList(body, (handNum) => {
    // The detail view is the existing replay modal, opened straight on the hand.
    const list = document.getElementById('replayHandList');
    const detail = document.getElementById('replayDetail');
    if (list) list.classList.add('hidden');
    if (detail) detail.classList.add('hidden');
    document.getElementById('replayPanel').classList.remove('hidden');
    loadReplay(handNum);
  });
}

// ============================================================
//  LEADERBOARD
// ============================================================
function renderLeaderboard(target) {
  const body = target || document.getElementById('lbBody');
  if (!body) return;
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

// The modal's list view. The History tab renders the same list into its own
// container with its own pick handler.
function renderReplayList() {
  const list = document.getElementById('replayHandList');
  const detail = document.getElementById('replayDetail');
  list.classList.remove('hidden');
  detail.classList.add('hidden');
  renderReplayHandList(list, loadReplay);
}

function renderReplayHandList(list, onPick) {
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
      btn.addEventListener('click', () => onPick(h.handNum));
      list.appendChild(btn);
    });
}

// The last ten hands arrive with every state push, each already filtered to the
// cards this viewer is allowed to see, so a replay is a lookup rather than a
// request. It used to emit 'getReplay' and return, waiting for a 'handReplay'
// that nothing ever sent: there was no handler for the question on the server
// and no sender for the answer, so picking a hand did nothing at all, and the
// working lookup below the early return was unreachable.
function loadReplay(handNum) {
  if (!gameState || !gameState.recentHands) return;
  const hand = gameState.recentHands.find((h) => h.handNum === handNum);
  if (!hand) return;
  document.getElementById('replayHandList').classList.add('hidden');
  renderReplayDetail(hand);
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
        ? `${replayWinnerHeading(hand)}: ${hand.winners
            .map((winner) => getReplayWinnerText(hand, winner))
            .join(', ')}`
        : 'Winner: none';
  }

  // Player hole cards
  const cardsDiv = document.getElementById('replayPlayerCards');
  cardsDiv.textContent = '';
  for (const p of hand.players) {
    // A seat with no cards here did not show them: the server sends the
    // viewer's own holding plus whatever was turned over at showdown, and
    // nothing else.
    const cards = hand.holeCards[p.id];
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
    if (cards) {
      cards.forEach((card) => handCards.appendChild(createReplayCardElement(card)));
    } else {
      // Listed without cards rather than dropped from the replay: a table
      // that folded round would otherwise read as a table that was never
      // dealt, and the seat's actions are still in the hand below.
      handCards.appendChild(createTextElement('div', 'rp-muck', 'mucked'));
    }
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
// The side panel draws these on demand (side-panel.js loads first).
if (window.SidePanel) {
  SidePanel.register('info', renderInfoTab);
  SidePanel.register('stats', renderStatsTab);
  SidePanel.register('history', renderHistoryTab);
}

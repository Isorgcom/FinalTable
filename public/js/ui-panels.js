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
  // Stay where the reader put the pane. Snapping to the bottom on every line
  // was harmless while this was a log nobody read; now that people talk in it,
  // scrolling back to catch up would be undone by the next fold.
  const pinned = body.scrollHeight - body.scrollTop - body.clientHeight <= LOG_NEAR_BOTTOM_PX;
  body.appendChild(entry);
  if (pinned) body.scrollTop = body.scrollHeight;

  // The ticker shows the last line; CSS clamps it to a few lines.
  last.textContent = displayMsg.replace(/💬\s*/, '');
  if (window.SidePanel) SidePanel.notify('chat');

  trimLog(body);
}

// Deep enough that a backlog of chat is not wiped by the next two hands, which
// is what 50 did once dealer narration and conversation shared the pane.
const LOG_MAX_ROWS = 200;
const LOG_NEAR_BOTTOM_PX = 48;

function trimLog(body) {
  while (body.children.length > LOG_MAX_ROWS) body.removeChild(body.firstChild);
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
  // "Level 6 · 75/150 · ante 150"; on a break, "Break · back at 100/200".
  // The number counts levels of play, which is what the structure shows.
  const levelNumber = t.levelNumber || t.currentLevel + 1;
  const blindsText =
    t.blinds.sb + '/' + t.blinds.bb + (t.blinds.ante ? ' · ante ' + t.blinds.ante : '');
  // The field summary is pushed every tick, so it knows a pause first.
  const paused = !!(t.paused || (window.mttField && window.mttField.paused));
  document.getElementById('tbLevelLabel').textContent = paused
    ? 'Paused · '
    : t.onBreak
      ? 'Break · '
      : 'Level ' + levelNumber + ' · ';
  document.getElementById('tbBlinds').textContent = t.onBreak
    ? 'back at ' + blindsText
    : blindsText;
  // Nothing follows the final level, so nothing to count down to.
  document.getElementById('tbNext').classList.toggle('hidden', !!t.finalLevel);
  banner.classList.toggle('on-break', !!t.onBreak && !paused);
  banner.classList.toggle('on-pause', paused);
  // How many are left in the tournament, which is not how many are left at this
  // table. gameState.players is this table only, so pairing its count with the
  // field's starting number read as a field count and was not one: two players
  // arriving from a table that broke made the field appear to grow from 6/201
  // to 8/201. The field summary knows the real number; the table count is only
  // a fallback for a table with no tournament around it.
  const summary = window.mttField;
  const aliveHere = gameState.players.filter((p) => p.chips > 0).length;
  const aliveField = summary && Number.isFinite(summary.remaining) ? summary.remaining : null;
  document.getElementById('tbAlive').textContent =
    (aliveField === null ? aliveHere : aliveField) + '/' + t.startingPlayers;

  // The bubble, on the felt rather than only in a panel nobody has open. It is
  // the one moment where the right way to play changes — every table is held
  // hand for hand and one more bust-out ends somebody's tournament with
  // nothing — so it is worth saying loudly and worth taking away again the
  // moment it stops being true.
  const bubble = document.getElementById('tbBubble');
  const banner2 = document.getElementById('tournamentBanner');
  const onBubble = !!(summary && summary.onBubble);
  if (bubble) {
    bubble.classList.toggle('hidden', !onBubble);
    if (onBubble) {
      const left = summary.remaining;
      const paid = summary.paidPlaces;
      bubble.textContent = `ON THE BUBBLE · ${left} left, ${paid} paid · hand for hand`;
    }
  }
  if (banner2) banner2.classList.toggle('on-bubble', onBubble);

  // Live countdown, re-seeded from the server on every state update. The
  // field summary arrives every tick, so its figure is the fresher one when
  // there is one; paused, the clock stands still and so does this.
  if (tournamentTimer) clearInterval(tournamentTimer);
  const fromField = summary && summary.isRunning && Number.isFinite(summary.nextLevelIn);
  _blindClockRemaining = fromField ? summary.nextLevelIn : t.timeUntilNextLevel;
  paintBlindClock();
  if (paused) return;
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

// The door of an invite-only game, for a host who is already at the table:
// the waiting room is gone once the cards are out, and this is where they
// look. Drawn into its own block, beside the body the tick rebuilds, and only
// when who is waiting has changed, so a Let-in button is never replaced under
// the cursor by a redraw that changed nothing.
let _infoPendingSig = null;
function renderInfoPending() {
  const block = document.getElementById('panelInfoPending');
  if (!block) return;
  const field = window.mttField || null;
  const rows = field && field.isHost && Array.isArray(field.pending) ? field.pending : [];
  const sig = rows.map((r) => `${r.uid}:${r.connected ? 1 : 0}:${r.name}`).join('|');
  if (sig === _infoPendingSig) return;
  _infoPendingSig = sig;
  block.textContent = '';
  block.classList.toggle('hidden', rows.length === 0);
  if (!rows.length || !window.Lobby || typeof Lobby.pendingRow !== 'function') return;
  block.appendChild(createTextElement('div', 'info-section-title', 'Waiting to be let in'));
  rows.forEach((row) => block.appendChild(Lobby.pendingRow(row)));
}

// The host's controls over a running game, at the table: pause and resume,
// a level back or forward, a minute on or off the clock, and every other
// seated player with Move and Remove. Its own block beside the body, redrawn
// only when what it shows has changed, for the same reason the door is. The
// server checks every one of these again; the block is only how they are
// asked for.
let _infoHostSig = null;
function renderInfoHost() {
  const block = document.getElementById('panelInfoHost');
  if (!block) return;
  const field = window.mttField || null;
  const show = !!(field && field.isHost && field.status === 'running' && !window.mttFinished);
  const roster = show && Array.isArray(field.roster) ? field.roster : [];
  const seated = roster.filter((r) => r.table && r.chips > 0 && !r.isHost);
  const sig = show
    ? [
        field.paused ? 'p' : 'r',
        field.level,
        field.onBreak ? 'b' : '',
        field.finalLevel ? 'f' : '',
        field.tableSize,
        seated.map((r) => `${r.uid}:${r.table}:${r.chips}:${r.name}`).join('|'),
        roster
          .filter((r) => r.table)
          .map((r) => r.table)
          .join(','),
      ].join('/')
    : '';
  if (sig === _infoHostSig) return;
  _infoHostSig = sig;
  block.textContent = '';
  block.classList.toggle('hidden', !show);
  if (!show) return;
  block.appendChild(createTextElement('div', 'info-section-title', 'Host'));

  const send = (event, payload) => {
    if (socket && socket.connected) socket.emit(event, payload);
  };
  const button = (label, onClick, { disabled = false, danger = false } = {}) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = danger ? 'host-btn host-btn-danger' : 'host-btn';
    b.textContent = label;
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    return b;
  };

  const controls = document.createElement('div');
  controls.className = 'host-controls';
  controls.appendChild(
    button(field.paused ? 'Resume' : 'Pause', () =>
      send(field.paused ? 'resumeTournament' : 'pauseTournament')
    )
  );
  controls.appendChild(
    button('◀ Level', () => send('stepLevel', { delta: -1 }), {
      disabled: field.level <= 1 && !field.onBreak,
    })
  );
  controls.appendChild(
    button('Level ▶', () => send('stepLevel', { delta: 1 }), { disabled: !!field.finalLevel })
  );
  controls.appendChild(
    button('−1 min', () => send('adjustClock', { seconds: -60 }), {
      disabled: !!field.finalLevel,
    })
  );
  controls.appendChild(
    button('+1 min', () => send('adjustClock', { seconds: 60 }), { disabled: !!field.finalLevel })
  );
  block.appendChild(controls);

  // Seats per table, so the destinations offered are the ones with room.
  const counts = new Map();
  for (const r of roster) if (r.table) counts.set(r.table, (counts.get(r.table) || 0) + 1);
  const tables = [...counts.keys()].sort((a, b) => a - b);

  const list = document.createElement('div');
  list.className = 'host-players';
  for (const r of seated) {
    const line = document.createElement('div');
    line.className = 'wr-row';
    line.appendChild(createTextElement('span', 'wr-avatar', r.avatar || (r.isBot ? '🤖' : '🙂')));
    line.appendChild(createTextElement('span', 'wr-name', r.name));
    line.appendChild(createTextElement('span', 'host-seat', `T${r.table} · ${fmtNum(r.chips)}`));
    const others = tables.filter((t) => t !== r.table && (counts.get(t) || 0) < field.tableSize);
    if (others.length) {
      const select = document.createElement('select');
      select.className = 'host-move';
      select.setAttribute('aria-label', `Move ${r.name} to a table`);
      const first = document.createElement('option');
      first.value = '';
      first.textContent = 'Move to…';
      select.appendChild(first);
      for (const t of others) {
        const opt = document.createElement('option');
        opt.value = String(t);
        opt.textContent = `Table ${t} (${counts.get(t) || 0})`;
        select.appendChild(opt);
      }
      select.addEventListener('change', () => {
        if (!select.value) return;
        send('movePlayer', { uid: r.uid, table: Number(select.value) });
        select.value = '';
      });
      line.appendChild(select);
    }
    line.appendChild(
      button(
        'Remove',
        async () => {
          let ok = true;
          if (typeof window.showConfirmDialog === 'function') {
            ok = await window.showConfirmDialog({
              title: `Remove ${r.name} from the game?`,
              message:
                'Their chips leave play and they finish where they stand. They cannot come back in.',
              confirmLabel: 'Remove',
              cancelLabel: 'Keep',
            });
          }
          if (ok) send('removePlayer', { uid: r.uid });
        },
        { danger: true }
      )
    );
    list.appendChild(line);
  }
  if (!seated.length) {
    list.appendChild(createTextElement('div', 'host-empty', 'Nobody else is seated.'));
  }
  block.appendChild(list);
}

// Whoever is watching, from the rail or after busting: the table they are
// at, and the others to switch to. A sibling block like the host's, redrawn
// only when the tables or the choice change.
let _infoWatchSig = null;
function renderInfoWatch() {
  const block = document.getElementById('panelInfoWatch');
  if (!block) return;
  const field = window.mttField || null;
  const you = field && field.you;
  const show = !!(
    you &&
    (you.watching || you.eliminated) &&
    field.status === 'running' &&
    !window.mttFinished
  );
  const roster = show && Array.isArray(field.roster) ? field.roster : [];
  const counts = new Map();
  for (const r of roster) {
    if (r.table && r.chips > 0) counts.set(r.table, (counts.get(r.table) || 0) + 1);
  }
  const tables = [...counts.keys()].sort((a, b) => a - b);
  const sig = show
    ? `${you.watchingTable}/${tables.map((t) => `${t}:${counts.get(t)}`).join(',')}`
    : '';
  if (sig === _infoWatchSig) return;
  _infoWatchSig = sig;
  block.textContent = '';
  block.classList.toggle('hidden', !show);
  if (!show) return;
  block.appendChild(createTextElement('div', 'info-section-title', 'Watching'));
  const row = document.createElement('div');
  row.className = 'host-controls';
  for (const t of tables) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'host-btn' + (t === you.watchingTable ? ' current' : '');
    b.textContent = `Table ${t} · ${counts.get(t)}`;
    b.disabled = t === you.watchingTable;
    b.addEventListener('click', () => {
      if (socket && socket.connected) socket.emit('watchTable', { table: t });
    });
    row.appendChild(b);
  }
  block.appendChild(row);
}

// The people in the game get the link that brings a watcher. Drawn once: it
// never changes for the life of the game.
let _infoRailSig = null;
function renderInfoRail() {
  const block = document.getElementById('panelInfoRail');
  if (!block) return;
  const field = window.mttField || null;
  const you = field && field.you;
  const show = !!(you && (you.registered || you.left) && field.rail);
  const sig = show ? field.rail : '';
  if (sig === _infoRailSig) return;
  _infoRailSig = sig;
  block.textContent = '';
  block.classList.toggle('hidden', !show);
  if (!show) return;
  const line = document.createElement('div');
  line.className = 'info-rail';
  line.appendChild(createTextElement('span', 'info-rail-label', 'Rail link'));
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'host-btn';
  b.textContent = 'Copy rail link';
  b.addEventListener('click', () => {
    if (window.Lobby && typeof Lobby.copyRail === 'function') Lobby.copyRail(b);
  });
  line.appendChild(b);
  block.appendChild(line);
}

function renderInfoTab() {
  renderInfoHost();
  renderInfoWatch();
  renderInfoRail();
  renderInfoPending();
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
    if (field) {
      // A seat's table, or the one a watcher is looking at.
      const watched = field.you && field.you.watchingTable;
      room = field.myTable ? `Table ${field.myTable}` : watched ? `Table ${watched}` : 'Tournament';
    } else if (gameState.gameMode === 'practice') room = 'Practice table';

    const tableRows = [
      ['Room', room],
      [
        'Mode',
        field ? 'Multi-table' : INFO_MODE_LABELS[gameState.gameMode] || gameState.gameMode || '-',
      ],
      ['Host', gameState.hostName || '-'],
      ['Hand', gameState.roundCount ? `#${gameState.roundCount}` : '-'],
      ['Players', `${alive} / ${gameState.players.length}`],
    ];
    if (field && field.watchers > 0) tableRows.push(['Rail', `${field.watchers} watching`]);
    const table = infoSection('Table');
    table.appendChild(infoGrid(tableRows));
    body.appendChild(table);

    const bb = gameState.bigBlind || 0;
    const rows = [
      [
        'Blinds',
        `${gameState.smallBlind} / ${gameState.bigBlind}` +
          (gameState.ante ? ` · ante ${gameState.ante}` : ''),
      ],
    ];
    if (me && bb)
      rows.push(['Your stack', `${fmtNum(me.chips)} · ${(me.chips / bb).toFixed(1)} bb`]);
    if (t) {
      rows.push(['Level', t.onBreak ? 'Break' : String(t.levelNumber || t.currentLevel + 1)]);
      rows.push(['Next level', formatClock(_blindClockRemaining), 'infoNextLevel']);
      // A multi-table field shares one clock across tables; its head count
      // belongs to the Field section, not this table's roster.
      if (!field) rows.push(['Alive', `${alive} / ${t.startingPlayers}`]);
    } else if (field) {
      rows.push(['Level', field.onBreak ? 'Break' : String(field.level)]);
      rows.push(['Next level', formatClock(field.nextLevelIn)]);
    }
    const blinds = infoSection('Blinds');
    blinds.appendChild(infoGrid(rows));
    body.appendChild(blinds);

    // The whole ladder, with where the clock is on it. The lobby keeps the
    // structure from the full tournament state and knows how to draw it.
    const structure =
      window.Lobby && typeof Lobby.structure === 'function' ? Lobby.structure() : null;
    if (structure && Array.isArray(structure.levels) && structure.levels.length) {
      const section = infoSection(`Structure · ${structure.name}`);
      const list = document.createElement('div');
      list.className = 'structure-list';
      const where = t
        ? { number: t.levelNumber || t.currentLevel + 1, onBreak: !!t.onBreak }
        : field && field.isRunning
          ? { number: field.level, onBreak: !!field.onBreak }
          : null;
      Lobby.structureRows(structure.levels, where).forEach((row) => list.appendChild(row));
      section.appendChild(list);
      body.appendChild(section);
    }
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
      `Hand ${hand.handNum} · Pot ${hand.pot} · Blinds ${hand.smallBlind}/${hand.bigBlind}` +
        (hand.ante ? ` ante ${hand.ante}` : '') +
        ` · Ended on ${phaseLabel}`
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

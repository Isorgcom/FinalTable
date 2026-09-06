// tournament-field.js - the field panel for multi-table tournaments.
//
// Self-contained: it builds its own DOM, attaches its own socket listeners, and
// touches nothing the single-table game owns. It reuses the existing connect
// path and table renderer, so what it adds is the information a player cannot
// get from their own table: how many are left across the field, where they
// stand in it, and what the money looks like.

(function () {
  'use strict';

  let field = null;
  let bound = false;
  let started = false;
  let wantsStart = false;
  // Whether the Info tab has been brought forward for this tournament.
  let announced = false;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function panel() {
    let p = document.getElementById('mttPanel');
    if (p) return p;
    p = el('div', 'mtt-panel hidden');
    p.id = 'mttPanel';
    p.innerHTML = '';

    const head = el('div', 'mtt-head');
    head.appendChild(el('span', 'mtt-title', 'Tournament'));
    const level = el('span', 'mtt-level', '');
    level.id = 'mttLevel';
    head.appendChild(level);
    p.appendChild(head);

    const grid = el('div', 'mtt-grid');
    [
      ['mttRemaining', 'Left'],
      ['mttRank', 'Your rank'],
      ['mttStack', 'Your stack'],
      ['mttAvg', 'Average'],
      ['mttLeader', 'Chip leader'],
      ['mttTables', 'Tables'],
    ].forEach(([id, label]) => {
      const cell = el('div', 'mtt-cell');
      cell.appendChild(el('span', 'mtt-label', label));
      const v = el('span', 'mtt-value', '-');
      v.id = id;
      cell.appendChild(v);
      grid.appendChild(cell);
    });
    p.appendChild(grid);

    const money = el('div', 'mtt-money');
    money.id = 'mttMoney';
    p.appendChild(money);

    const ladder = el('div', 'mtt-ladder');
    ladder.id = 'mttLadder';
    p.appendChild(ladder);

    document.body.appendChild(p);
    return p;
  }

  function fmt(n) {
    return typeof n === 'number' ? n.toLocaleString() : '-';
  }

  function render() {
    if (!field) return;
    // The side panel's Info tab is the field's home; the floating panel below
    // remains for screens where the side panel is not docked.
    window.mttField = field;
    if (window.SidePanel) {
      if (!announced && field.isRunning) {
        announced = true;
        SidePanel.select('info');
      } else {
        SidePanel.refresh('info');
      }
    }
    const p = panel();
    p.classList.remove('hidden');

    const setText = (id, value) => {
      const node = document.getElementById(id);
      if (node) node.textContent = value;
    };

    setText('mttLevel', `Level ${field.level} · ${field.blinds.sb}/${field.blinds.bb}`);
    setText('mttRemaining', `${field.remaining} / ${field.entrants}`);
    setText('mttRank', field.myRank ? `#${field.myRank}` : '-');
    setText('mttStack', fmt(field.myChips));
    setText('mttAvg', fmt(field.averageStack));
    setText(
      'mttLeader',
      field.chipLeader ? `${field.chipLeader.name} ${fmt(field.chipLeader.chips)}` : '-'
    );
    setText('mttTables', `${field.tablesLeft}${field.myTable ? ` · you: ${field.myTable}` : ''}`);

    // Money status reads differently on the bubble, which is the one moment a
    // player most wants to know exactly where they are.
    const money = document.getElementById('mttMoney');
    if (money) {
      money.className = 'mtt-money';
      if (!field.paidPlaces) {
        money.textContent = '';
      } else if (field.inTheMoney) {
        money.classList.add('in-money');
        money.textContent = `In the money · ${field.paidPlaces} paid`;
      } else if (field.onBubble) {
        money.classList.add('on-bubble');
        money.textContent = `Bubble · ${field.remaining} left, ${field.paidPlaces} paid · hand for hand`;
      } else {
        money.textContent = `${field.paidPlaces} paid · ${field.remaining - field.paidPlaces} from the money`;
      }
    }

    const ladder = document.getElementById('mttLadder');
    if (ladder) {
      ladder.textContent = '';
      if (field.prizePool > 0) {
        for (const row of field.payouts) {
          const line = el('div', 'mtt-rung');
          // Highlight the rung the player would currently finish on.
          if (field.myRank === row.place) line.classList.add('mine');
          line.appendChild(el('span', 'mtt-place', `#${row.place}`));
          line.appendChild(el('span', 'mtt-prize', fmt(row.amount)));
          ladder.appendChild(line);
        }
      }
    }
  }

  // The lobby-to-table switch normally rides on the `joined` reply to
  // joinRoom, which a tournament never sends: the director creates the tables,
  // so there is no room join to answer. Do it here instead.
  function enterTable() {
    const login = document.getElementById('loginScreen');
    const game = document.getElementById('gameScreen');
    if (login) login.classList.add('hidden');
    if (game) game.classList.add('active');
  }

  function showMove(move) {
    let banner = document.getElementById('mttMoveBanner');
    if (!banner) {
      banner = el('div', 'mtt-move');
      banner.id = 'mttMoveBanner';
      document.body.appendChild(banner);
    }
    banner.textContent = `Moving to table ${move.toTable}`;
    banner.classList.add('show');
    clearTimeout(banner._t);
    banner._t = setTimeout(() => banner.classList.remove('show'), 3200);
  }

  function showFinished(payload) {
    window.mttFinished = payload;
    if (window.SidePanel) SidePanel.reveal('info');
    const p = panel();
    p.classList.remove('hidden');
    const ladder = document.getElementById('mttLadder');
    if (!ladder) return;
    ladder.textContent = '';
    const results = (payload.results || []).slice(0, 10);
    for (const r of results) {
      const line = el('div', 'mtt-rung' + (r.inTheMoney ? ' paid' : ''));
      line.appendChild(el('span', 'mtt-place', `#${r.place}`));
      line.appendChild(el('span', 'mtt-name', r.name));
      line.appendChild(el('span', 'mtt-prize', r.prize ? fmt(r.prize) : ''));
      ladder.appendChild(line);
    }
    const money = document.getElementById('mttMoney');
    if (money) {
      money.className = 'mtt-money in-money';
      money.textContent = payload.winner ? `${payload.winner} wins` : 'Tournament over';
    }
  }

  // The socket is created lazily by the existing connect path, so poll briefly
  // for it rather than requiring a load-order guarantee between scripts.
  function bind() {
    if (bound || typeof socket === 'undefined' || !socket) return;
    bound = true;
    socket.on('tournamentField', (state) => {
      // A reconnect issues a new socket id; keep the UI's idea of "you" in step.
      if (socket && socket.id && myId !== socket.id && state && state.isRunning) {
        myId = socket.id;
      }
      field = state;
      enterTable();
      render();
    });
    socket.on('tableMoved', (move) => {
      showMove(move);
      if (typeof addLog === 'function') addLog(`🔀 Moved to table ${move.toTable}`);
    });
    socket.on('tournamentFinished', (payload) => showFinished(payload));
    socket.on('tournamentJoined', (info) => {
      if (info && info.host) wantsStart = true;
      announced = false;
      window.mttField = null;
      window.mttFinished = null;
      // The table UI identifies "you" by myId, which normally arrives on the
      // `joined` reply to joinRoom. A tournament never sends that, so myId
      // stayed null: the client could not find itself among the players, never
      // enabled the action buttons, and the seat sat there until the idle
      // timeout acted for the player. The server seats a tournament entrant
      // under their socket id, so that is the value to use.
      if (typeof socket !== 'undefined' && socket && socket.id) {
        myId = socket.id;
      }
      enterTable();
    });
  }

  // Fast poll: the server answers createTournament in milliseconds, so a slow
  // poll binds the listeners after tournamentJoined has already been delivered.
  setInterval(bind, 40);

  // Entry point. Sets the pending config the connect path looks for, then runs
  // the normal join flow so the socket, gameState handler and table renderer
  // are all the ones the single-table game already uses.
  window.startMultiTableTournament = function (opts) {
    window.__pendingTournament = {
      name: (opts && opts.name) || 'Game Night',
      tableSize: (opts && opts.tableSize) || 9,
      botCount: (opts && opts.botCount) != null ? opts.botCount : 17,
      buyIn: (opts && opts.buyIn) || 0,
      startChips: (opts && opts.startChips) || 5000,
      levelDuration: (opts && opts.levelDuration) || 300,
    };
    started = false;
    wantsStart = true; // creating implies hosting, so do not wait to be told
    if (typeof joinGame === 'function') joinGame();

    // Start the field once the socket is up. Driven by a retry rather than by
    // catching tournamentJoined: that reply lands in milliseconds and can beat
    // the listener into place, leaving a tournament created but never started.
    let tries = 0;
    const starter = setInterval(() => {
      if (started || ++tries > 100) {
        clearInterval(starter);
        return;
      }
      if (wantsStart && typeof socket !== 'undefined' && socket && socket.connected) {
        started = true;
        socket.emit('startTournament');
        socket.emit('requestTournamentField');
        clearInterval(starter);
      }
    }, 100);
  };
})();

// tournament-field.js - what the table shows about the field around it.
//
// The Info tab draws from window.mttField (the latest tournamentState); the
// move banner and the final standings live here. Everything about joining,
// waiting and leaving is in lobby.js.

(function () {
  'use strict';

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function render(state) {
    window.mttField = state || null;
    if (window.SidePanel) SidePanel.refresh('info');
    // The felt's banner reads the same summary, and the bubble can turn on or
    // off on a push that carries no game state with it.
    if (typeof updateBlindClock === 'function') updateBlindClock();
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
    window.mttFinished = payload || null;
    if (window.SidePanel) SidePanel.reveal('info');
  }

  function bind(socket) {
    socket.on('tableMoved', (move) => {
      showMove(move);
      if (typeof addLog === 'function') addLog(`🔀 Moved to table ${move.toTable}`);
    });
    socket.on('tournamentFinished', (payload) => showFinished(payload));
  }

  window.TournamentField = { bind, render, showMove, showFinished };
})();

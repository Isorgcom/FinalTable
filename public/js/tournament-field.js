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

  // 1st, 2nd, 3rd, and the teens that break the pattern.
  function ordinal(n) {
    const teen = n % 100;
    if (teen >= 11 && teen <= 13) return `${n}th`;
    return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
  }

  // The end of a tournament is the moment the whole thing was played for, and
  // it used to pass with one line in the chat and a side panel tab quietly
  // revealed. Everyone who busts is told where they came; the winner - the one
  // person still sitting at a table - was told nothing at all.
  function announceFinish(payload) {
    if (!payload || typeof window.showNoticeDialog !== 'function') return;
    const results = Array.isArray(payload.results) ? payload.results : [];
    const entrants = results.length;
    const you = payload.you || null;
    const won = !!you && you.place === 1;

    const prize = you && you.prize ? ` You take ${you.prize.toLocaleString()}.` : '';
    const standing = !you
      ? `${entrants} entrants.`
      : won
        ? `First of ${entrants}.`
        : `You finished ${ordinal(you.place)} of ${entrants}.`;
    // The podium, so this reads as a result and not as a notification.
    const podium = results
      .slice(0, 3)
      .map((r) => `${ordinal(r.place)} ${r.name}`)
      .join('  ·  ');

    if (won && window.SFX) SFX.play('win');
    window.showNoticeDialog({
      title: won ? '🏆 You won the tournament' : `${payload.winner || 'Nobody'} won`,
      message: `${standing}${prize}`,
      hint: podium,
      confirmLabel: won ? 'Nice' : 'Close',
    });
  }

  function showFinished(payload) {
    window.mttFinished = payload || null;
    if (window.SidePanel) SidePanel.reveal('info');
    announceFinish(payload);
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

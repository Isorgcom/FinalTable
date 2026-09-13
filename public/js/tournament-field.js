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

  // Conceding is offered to whoever has something to concede: a seat in a
  // game still running. Not the rail, not somebody already out, not a table
  // whose tournament has finished.
  function paintForfeit(state) {
    const btn = document.getElementById('btnForfeit');
    if (!btn) return;
    const you = state && state.you;
    const show = !!(
      state &&
      state.status === 'running' &&
      !window.mttFinished &&
      you &&
      you.seated
    );
    btn.classList.toggle('hidden', !show);
  }

  // The add-on is an offer on a clock: it opens when the break starts and it
  // is gone when the break ends, and there is nothing to prompt it later the
  // way a bust-out prompts the way back in. A player with the Chat tab open -
  // which is the tab the panel opens on - would watch the whole window go by
  // without being told it was there. So it asks, once, and the Info tab and
  // the lobby card keep it for anybody who says no and changes their mind.
  let addOnAsked = false;
  async function offerAddOn(state) {
    const you = state && state.you;
    const open = !!(
      state &&
      state.status === 'running' &&
      !window.mttFinished &&
      you &&
      you.canAddOn
    );
    if (!open) {
      // Taken, or the break is over: the next one that opens asks again.
      addOnAsked = false;
      return;
    }
    if (addOnAsked) return;
    // Never over a live hand. The clock opens the add-on the moment the break
    // starts, which is often in the middle of the hand the table is still
    // finishing, and a dialog across somebody's decision is no way to ask.
    // The hand ending pushes state again and it asks then, with the felt
    // clear and the whole break to answer in.
    if (typeof gameState !== 'undefined' && gameState && gameState.isRunning) return;
    // Latched before the await, so the pushes that arrive while the dialog is
    // up do not stack a second one behind it.
    addOnAsked = true;
    if (typeof window.showConfirmDialog !== 'function') return;
    const cost = state.buyIn ? ` for another buy-in of ${state.buyIn.toLocaleString()}` : '';
    const ok = await window.showConfirmDialog({
      title: 'The add-on is open',
      message:
        `A starting stack more on top of what you have${cost}, once, ` + 'until the break ends.',
      confirmLabel: 'Take it',
      cancelLabel: 'No thanks',
    });
    if (ok && window.Lobby && typeof Lobby.takeAddOn === 'function') Lobby.takeAddOn();
  }

  function render(state) {
    window.mttField = state || null;
    paintForfeit(state);
    offerAddOn(state);
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

    if (won && typeof SFX !== 'undefined') SFX.play('win');
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

  // offerAddOn is exported because the thing it waits on is the table, not the
  // field: the hand ending arrives as a gameState push, and that is the moment
  // to ask.
  window.TournamentField = { bind, render, showMove, showFinished, offerAddOn };
})();

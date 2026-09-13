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

  // The add-on is an offer on a clock: it opens when the break starts and it is
  // gone when the break ends, and nothing prompts it later the way a bust-out
  // prompts the way back in. A player with the Chat tab open - which is the tab
  // the panel opens on - would watch the whole window go by without being told
  // it was there.
  //
  // So it asks on the felt. The order matters and it is the order a table has:
  // the pot finishes travelling to whoever won it, the felt clears, the break
  // clock comes up, and only then, after a beat, does the question slide in
  // under it. The clock is what says how long there is to answer, so putting
  // the question over it was asking and hiding the deadline in one move.
  //
  // The break plate is what the wait hangs on. It already holds the felt for
  // four seconds so the last hand can be read, which is longer than the chips
  // take to land, so by the time it is up the table has finished being watched.
  const ADD_ON_SETTLE_MS = 1500;
  let addOnAnswered = false;
  let addOnTimer = null;

  function addOnPanel() {
    return document.getElementById('addOnOffer');
  }

  function hideAddOn() {
    if (addOnTimer) {
      clearTimeout(addOnTimer);
      addOnTimer = null;
    }
    const panel = addOnPanel();
    if (panel) panel.classList.remove('show');
  }

  function showAddOn(state) {
    const panel = addOnPanel();
    if (!panel) return;
    const note = document.getElementById('addOnOfferNote');
    if (note) {
      // One line. It shares the floor with the seats and the reaction strip,
      // and the Info tab holds the long version for anyone who wants it.
      const more = state && state.startChips ? `${fmtNum(state.startChips)} more` : 'A stack more';
      const cost = state && state.buyIn ? ` for a buy-in of ${fmtNum(state.buyIn)}` : '';
      note.textContent = `${more}${cost}`;
    }
    panel.classList.add('show');
  }

  // Called from two places because either can be the later one: the break plate
  // landing, and a push that opens the offer when the plate is already up.
  function offerAddOn(state) {
    const field = state || window.mttField;
    const you = field && field.you;
    const open = !!(
      field &&
      field.status === 'running' &&
      !window.mttFinished &&
      you &&
      you.canAddOn
    );
    if (!open) {
      // Taken, or the break is over. Whatever is on screen goes with it, and
      // the next break that opens one asks again.
      addOnAnswered = false;
      hideAddOn();
      return;
    }
    if (addOnAnswered || addOnTimer) return;
    const panel = addOnPanel();
    if (panel && panel.classList.contains('show')) return;
    // Only once the felt actually says On break. Before that the table is
    // still finishing its hand in front of everybody.
    const stage = document.getElementById('tableStage');
    if (!stage || !stage.classList.contains('on-break')) return;
    addOnTimer = setTimeout(function () {
      addOnTimer = null;
      // The break can end while the beat is running.
      const now = window.mttField && window.mttField.you;
      if (!now || !now.canAddOn || addOnAnswered) return;
      showAddOn(window.mttField);
    }, ADD_ON_SETTLE_MS);
  }

  function wireAddOn() {
    const take = document.getElementById('btnAddOnTake');
    const no = document.getElementById('btnAddOnNo');
    if (take) {
      take.addEventListener('click', function () {
        addOnAnswered = true;
        hideAddOn();
        if (window.Lobby && typeof Lobby.takeAddOn === 'function') Lobby.takeAddOn();
      });
    }
    if (no) {
      no.addEventListener('click', function () {
        // Not asked again this break. The Info tab and the lobby card still
        // hold it for anybody who changes their mind.
        addOnAnswered = true;
        hideAddOn();
      });
    }
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

  // offerAddOn is exported because the thing it waits on is the felt, not the
  // field: the break plate coming up is what says the table has finished being
  // watched, and that is painted elsewhere.
  window.TournamentField = { bind, render, showMove, showFinished, offerAddOn };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireAddOn);
  } else {
    wireAddOn();
  }
})();

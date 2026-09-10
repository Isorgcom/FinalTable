// reactions.js - the strip of emoji under the table, and what a tap sends.
//
// The set comes from the server (serverInfo.reactions), so the strip draws
// exactly what the server will accept and draws nothing when the surface is
// off. It lives inside the pre-action panel, which already knows when a seat
// is present, not on turn and not sitting out: that is when there is
// somebody else's action to react to, and the panel's own rules keep the
// strip off the rail and off a seat that is meant to be acting.
//
// What comes back is drawn by table-render.js over the chair it belongs to.
(function () {
  'use strict';

  let list = null;
  let canSend = false;

  function el(id) {
    return document.getElementById(id);
  }

  function build() {
    const row = el('reactionRow');
    if (!row) return;
    row.textContent = '';
    if (!Array.isArray(list) || !list.length) {
      row.classList.add('hidden');
      return;
    }
    list.forEach(function (emoji) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'reaction-btn';
      btn.textContent = emoji;
      btn.setAttribute('aria-label', 'React ' + emoji);
      btn.dataset.emoji = emoji;
      row.appendChild(btn);
    });
    row.classList.remove('hidden');
    paint();
  }

  function paint() {
    const row = el('reactionRow');
    if (!row) return;
    row.querySelectorAll('.reaction-btn').forEach(function (btn) {
      btn.disabled = !canSend;
    });
  }

  function send(emoji) {
    if (!canSend || !emoji) return;
    // Bare `socket`: a top-level `let` in app-state.js, never on window.
    if (typeof socket !== 'undefined' && socket && socket.connected) {
      socket.emit('reaction', { emoji: emoji });
    }
  }

  function init() {
    const row = el('reactionRow');
    if (!row) return;
    // Delegated, so the buttons can be rebuilt when the set arrives.
    row.addEventListener('click', function (e) {
      const btn = e.target.closest('.reaction-btn');
      if (!btn || btn.disabled) return;
      send(btn.dataset.emoji);
    });
    build();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.Reactions = {
    // From serverInfo: the set, or null when the server has no reactions.
    configure: function (reactions) {
      list = Array.isArray(reactions) ? reactions.slice() : null;
      build();
    },
    // The same permission as chat: seated, in the tournament, not muted.
    setCanSend: function (value) {
      canSend = !!value;
      paint();
    },
    list: function () {
      return list ? list.slice() : null;
    },
  };
})();

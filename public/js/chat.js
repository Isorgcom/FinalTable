// chat.js - the composer and the message rows, for both places chat appears.
//
// There are two surfaces and one set of rules: the waiting room before the
// cards are out, and the table's side panel once you are seated. The server
// decides which room a message belongs to, so this file never names one - it
// sends text and renders what comes back.
(function () {
  'use strict';

  // Anything at or below the highest sequence seen for a room is something we
  // have already drawn. This is not belt and braces: socket.io is configured
  // with connectionStateRecovery, so a client that drops for a moment is
  // replayed the messages it missed AND then sent a backlog on rebind. Without
  // a watermark every reconnect would double up.
  const seenTo = new Map(); // room -> highest seq rendered

  let currentRoom = null;
  let canSend = false;
  let closedReason = '';

  function el(id) {
    return document.getElementById(id);
  }

  function myUid() {
    return window.__identity ? window.__identity.uid : null;
  }

  // One row, two spans, both textContent. The server deliberately does not
  // escape anything - "<3" has to survive - so this is where it stops being
  // markup, and it must stay textContent.
  function buildRow(message) {
    const row = document.createElement('div');
    row.className = 'log-entry chat-line';
    row.dataset.kind = 'chat';
    if (message.uid && message.uid === myUid()) row.classList.add('mine');
    const who = document.createElement('span');
    who.className = 'chat-who';
    who.textContent = message.name || 'Player';
    const text = document.createElement('span');
    text.className = 'chat-text';
    text.textContent = message.text;
    row.append(who, text);
    return row;
  }

  // Appends to a scroller, keeping the view where the reader put it. Snapping
  // to the bottom unconditionally is fine for a dealer log nobody reads and
  // wrong the moment people are talking: it drags you back down mid-sentence
  // every time somebody folds.
  const NEAR_BOTTOM_PX = 48;
  function appendTo(body, node, cap) {
    if (!body) return;
    const pinned = body.scrollHeight - body.scrollTop - body.clientHeight <= NEAR_BOTTOM_PX;
    body.appendChild(node);
    while (cap && body.children.length > cap) body.removeChild(body.firstChild);
    if (pinned) body.scrollTop = body.scrollHeight;
  }

  function separator(label) {
    const row = document.createElement('div');
    row.className = 'log-entry chat-sep';
    row.textContent = label;
    return row;
  }

  // Where a message goes depends on which screen is up, not on the message.
  // The test is whether the table is showing, not whether the waiting room is
  // hidden: entering a table layers the game screen over the lobby without
  // touching the lobby's own view classes, so the waiting room is still
  // technically unhidden underneath it.
  function surface() {
    const game = el('gameScreen');
    const atTable = game && game.classList.contains('active');
    return atTable
      ? { body: el('panelChatBody'), cap: null, note: el('chatNote'), input: el('chatInput') }
      : { body: el('wrChatLog'), cap: 60, note: el('wrChatNote'), input: el('wrChatInput') };
  }

  function render(message, opts) {
    const where = surface();
    if (!where.body) return;
    const seen = seenTo.get(message.room);
    if (typeof message.seq === 'number' && typeof seen === 'number' && message.seq <= seen) return;
    if (typeof message.seq === 'number') {
      seenTo.set(message.room, Math.max(seen || 0, message.seq));
    }
    appendTo(where.body, buildRow(message), where.cap);
    const last = el('logLast');
    if (last && where.body.id === 'panelChatBody') {
      last.textContent = message.name + ': ' + message.text;
    }
    // A dot for your own message is noise, and so is one for a backlog you
    // asked for by arriving.
    if (!opts || !opts.quiet) {
      if (window.SidePanel && message.uid !== myUid()) window.SidePanel.notify('chat');
    }
  }

  function renderHistory(payload) {
    if (!payload || !Array.isArray(payload.messages)) return;
    currentRoom = payload.room || null;
    setCanSend(!!payload.canSend);
    const fresh = payload.messages.filter((m) => {
      const seen = seenTo.get(m.room);
      return !(typeof m.seq === 'number' && typeof seen === 'number' && m.seq <= seen);
    });
    if (!fresh.length) return;
    const where = surface();
    if (where.body) appendTo(where.body, separator('earlier'), where.cap);
    fresh.forEach((m) => render(m, { quiet: true }));
  }

  function setCanSend(value, reason) {
    canSend = !!value;
    if (reason !== undefined) closedReason = reason;
    paint();
  }

  function paint() {
    [
      { form: 'chatForm', input: 'chatInput', send: 'chatSend', note: 'chatNote' },
      { form: 'wrChatForm', input: 'wrChatInput', send: 'wrChatSend', note: 'wrChatNote' },
    ].forEach((ids) => {
      const input = el(ids.input);
      const send = el(ids.send);
      const note = el(ids.note);
      if (input) input.disabled = !canSend;
      if (send) send.disabled = !canSend;
      if (note) {
        note.textContent = canSend ? '' : closedReason || '';
        note.classList.toggle('hidden', canSend || !closedReason);
      }
    });
    const composer = el('panelComposer');
    // Shown whenever there is a table to be at, disabled rather than hidden
    // when you may not talk: a box that vanishes reads as a bug, and there is
    // nowhere to explain itself.
    if (composer) composer.classList.toggle('hidden', !currentRoom);
  }

  function send(input) {
    if (!input || input.disabled) return;
    const text = input.value.trim();
    if (!text) return;
    // Bare `socket`, not `window.socket`: it is a top-level `let` in
    // app-state.js, which is script-scoped and never a property of window.
    if (typeof socket !== 'undefined' && socket && socket.connected) {
      socket.emit('chat', { text: text });
    }
    input.value = '';
    input.focus();
  }

  function wire(formId, inputId) {
    const form = el(formId);
    const input = el(inputId);
    if (!form || !input) return;
    // A form, not a keydown handler: Enter-to-send comes free, the on-screen
    // keyboard gets a Send key from enterkeyhint, and an IME's Enter (which
    // accepts a candidate rather than finishing a sentence) does not fire it.
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      send(input);
    });
    // Escape while typing gives up the box, and must not also close the drawer
    // out from under the person using it. First press blurs, second closes.
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        input.blur();
      }
    });
    // The drawer is fixed to the viewport, so on a phone the freshly-opened
    // keyboard can sit over the newest lines.
    input.addEventListener('focus', function () {
      requestAnimationFrame(function () {
        const where = surface();
        if (where.body) where.body.scrollTop = where.body.scrollHeight;
      });
    });
  }

  // Leaving a tournament: the next one starts from nothing. Without this a
  // rejoin renders no backlog at all, because every message in it is below a
  // watermark left over from last time.
  function reset() {
    seenTo.clear();
    currentRoom = null;
    canSend = false;
    closedReason = '';
    const wrLog = el('wrChatLog');
    if (wrLog) wrLog.textContent = '';
    paint();
  }

  function init() {
    wire('chatForm', 'chatInput');
    wire('wrChatForm', 'wrChatInput');
    paint();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.TableChat = {
    render: render,
    renderHistory: renderHistory,
    setCanSend: setCanSend,
    reset: reset,
    denied: function (reason) {
      const where = surface();
      if (!where.note) return;
      where.note.textContent = reason;
      where.note.classList.remove('hidden');
      setTimeout(function () {
        if (where.note.textContent === reason && canSend) where.note.classList.add('hidden');
      }, 4000);
    },
    room: function () {
      return currentRoom;
    },
  };
})();

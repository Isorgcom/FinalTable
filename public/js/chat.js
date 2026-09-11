// chat.js - the composer and the message rows, for both places chat appears.
//
// There are two surfaces and one set of rules: the waiting room before the
// cards are out, and the table's side panel once you are seated. The server
// decides which room a message belongs to, so this file never names one - it
// sends text and renders what comes back.
//
// The host is the one exception, and only because the server says so: a
// chatField payload, sent to the host alone, lists every table's room and its
// backlog. From it this file builds a strip over the log (All, then one pill
// per table) and puts a `to` on what the host sends. Everyone else's chat is
// the same as it ever was.
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

  // The host's field, from chatField: which tables there are and which is
  // theirs. `view` is the pill in force: 'all' or 't<N>'. Null for everyone
  // who is not the host, and for the host before the deal.
  let field = null;
  let view = null;
  // An announcement reaches the host once per table room. One row for it,
  // whatever the view, keyed on the group every copy shares.
  const drawnGroups = new Set();

  function el(id) {
    return document.getElementById(id);
  }

  function myUid() {
    return window.__identity ? window.__identity.uid : null;
  }

  function isAnnouncement(message) {
    return message.scope === 'all';
  }

  // The room a row is filed under for the view filter. An announcement is
  // 'all', so it shows in every view; anything else is its own room.
  function roomKeyFor(message) {
    return isAnnouncement(message) ? 'all' : message.room || '';
  }

  // Hide a row the current pill does not cover. Class-driven rather than a
  // rebuild, because the dealer log shares this scroller and must stay put.
  function applyViewTo(row) {
    if (!field || !view || view === 'all') {
      row.classList.remove('off');
      return;
    }
    const key = row.dataset.room || '';
    row.classList.toggle('off', key !== 'all' && !key.endsWith(':' + view));
  }

  function applyView() {
    const body = el('panelChatBody');
    if (!body) return;
    body.querySelectorAll('.chat-line').forEach(applyViewTo);
    if (body.scrollHeight) body.scrollTop = body.scrollHeight;
  }

  // One row, spans, all textContent. The server deliberately does not
  // escape anything - "<3" has to survive - so this is where it stops being
  // markup, and it must stay textContent.
  function buildRow(message) {
    const row = document.createElement('div');
    row.className = 'log-entry chat-line';
    row.dataset.kind = 'chat';
    row.dataset.room = roomKeyFor(message);
    if (message.uid && message.uid === myUid()) row.classList.add('mine');
    if (message.host) row.classList.add('host');
    // Where it was said, for a reader who holds more than one room. Only the
    // host has a field, so only the host ever sees a chip.
    if (field && typeof message.table === 'number' && !isAnnouncement(message)) {
      if (message.table !== field.mine) {
        const chip = document.createElement('span');
        chip.className = 'chat-table-chip';
        chip.textContent = 'T' + message.table;
        row.appendChild(chip);
      }
    }
    const who = document.createElement('span');
    who.className = 'chat-who';
    who.textContent = message.name || 'Player';
    row.appendChild(who);
    if (message.host) {
      const badge = document.createElement('span');
      badge.className = 'chat-badge';
      badge.textContent = 'host';
      row.appendChild(badge);
    }
    // From the rail, or from a seat that busted: talking, not playing.
    if (message.rail) {
      row.classList.add('rail');
      const badge = document.createElement('span');
      badge.className = 'chat-badge rail';
      badge.textContent = 'rail';
      row.appendChild(badge);
    }
    const text = document.createElement('span');
    text.className = 'chat-text';
    text.textContent = message.text;
    row.appendChild(text);
    if (isAnnouncement(message)) {
      const scope = document.createElement('span');
      scope.className = 'chat-scope';
      scope.textContent = 'to all tables';
      row.appendChild(scope);
    }
    applyViewTo(row);
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
    // Every copy of an announcement moves its room's watermark; one is drawn.
    if (message.group) {
      if (drawnGroups.has(message.group)) return;
      drawnGroups.add(message.group);
    }
    appendTo(where.body, buildRow(message), where.cap);
    const last = el('logLast');
    if (last && where.body.id === 'panelChatBody') {
      last.textContent = message.name + ': ' + message.text;
      if (!(opts && opts.quiet)) {
        if (isAnnouncement(message)) {
          // Over the felt rather than over a chair: the host may not be at
          // this table, and a break call is not something to miss.
          if (typeof showHostNote === 'function') showHostNote(message.name, message.text);
        } else if (typeof showSeatBubble === 'function') {
          // Over the head of whoever said it, so a line is noticed without
          // looking away from the felt. Not for a backlog: replaying six
          // bubbles at once on arrival would cover the table with things
          // nobody just said.
          showSeatBubble(message.uid, message.text);
        }
      }
    }
    // A dot for your own message is noise, and so is one for a backlog you
    // asked for by arriving.
    if (!opts || !opts.quiet) {
      if (window.SidePanel && message.uid !== myUid()) window.SidePanel.notify('chat');
    }
  }

  function unseen(m) {
    const seen = seenTo.get(m.room);
    return !(typeof m.seq === 'number' && typeof seen === 'number' && m.seq <= seen);
  }

  function renderHistory(payload) {
    if (!payload || !Array.isArray(payload.messages)) return;
    currentRoom = payload.room || null;
    setCanSend(!!payload.canSend);
    const fresh = payload.messages.filter(unseen);
    if (!fresh.length) return;
    const where = surface();
    if (where.body) appendTo(where.body, separator('earlier'), where.cap);
    fresh.forEach((m) => render(m, { quiet: true }));
  }

  // ── The host's strip ────────────────────────────────────────────────────

  function viewFor(table) {
    return 't' + table;
  }

  function currentTable() {
    if (!view || view === 'all') return null;
    return parseInt(view.slice(1), 10);
  }

  function placeholderFor() {
    const input = el('chatInput');
    if (!input) return;
    if (!field || !view) {
      input.placeholder = 'Message your table';
    } else if (view === 'all') {
      input.placeholder = 'Announce to every table';
    } else if (currentTable() === field.mine) {
      input.placeholder = 'Message your table';
    } else {
      input.placeholder = 'Message table ' + currentTable();
    }
  }

  function paintStrip() {
    const strip = el('chatTables');
    if (!strip) return;
    strip.textContent = '';
    const show = !!(field && field.rooms.length >= 2);
    strip.classList.toggle('hidden', !show);
    if (show) {
      const pills = [{ key: 'all', label: 'All' }].concat(
        field.rooms.map((r) => ({ key: viewFor(r.table), label: 'Table ' + r.table }))
      );
      pills.forEach((p) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.view = p.key;
        btn.textContent = p.label;
        btn.classList.toggle('active', p.key === view);
        btn.setAttribute('aria-pressed', p.key === view ? 'true' : 'false');
        strip.appendChild(btn);
      });
    }
    placeholderFor();
    applyView();
  }

  function setView(next) {
    if (!field) return;
    if (next !== 'all' && !field.rooms.some((r) => viewFor(r.table) === next)) return;
    if (view === next) return;
    view = next;
    paintStrip();
  }

  // The host's field, or the end of it: rooms null means the title has
  // passed to somebody else and this panel is an ordinary seat's again.
  function renderField(payload) {
    if (!payload || !Array.isArray(payload.rooms)) {
      field = null;
      view = null;
      paintStrip();
      return;
    }
    field = {
      mine: typeof payload.mine === 'number' ? payload.mine : null,
      rooms: payload.rooms.map((r) => ({ room: r.room, table: r.table })),
    };
    // Keep the pill in force if its table is still there; otherwise the
    // host's own table, or All when the host has no seat.
    const stillThere = view === 'all' || field.rooms.some((r) => viewFor(r.table) === view);
    if (!view || !stillThere) view = field.mine !== null ? viewFor(field.mine) : 'all';
    paintStrip();
    // Every room's backlog under the same watermark as the host's own, which
    // chatHistory has usually just drawn: only the other tables are new.
    const fresh = [];
    payload.rooms.forEach((r) => {
      if (Array.isArray(r.messages)) fresh.push(...r.messages.filter(unseen));
    });
    if (!fresh.length) return;
    fresh.sort((a, b) => (a.seq || 0) - (b.seq || 0));
    const where = surface();
    if (where.body) appendTo(where.body, separator('earlier'), where.cap);
    fresh.forEach((m) => render(m, { quiet: true }));
  }

  // ── The composer ────────────────────────────────────────────────────────

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
    // The strip may throw exactly when the composer may send: same room, same
    // mute, same seat. One permission, painted in two places.
    if (window.Reactions) Reactions.setCanSend(canSend);
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
    const payload = { text: text };
    // Only the host has a field, and only the table's composer has a strip;
    // the waiting room sends a bare line.
    if (field && view && input.id === 'chatInput') {
      payload.to = view === 'all' ? 'all' : currentTable();
    }
    // Bare `socket`, not `window.socket`: it is a top-level `let` in
    // app-state.js, which is script-scoped and never a property of window.
    if (typeof socket !== 'undefined' && socket && socket.connected) {
      socket.emit('chat', payload);
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
    drawnGroups.clear();
    currentRoom = null;
    canSend = false;
    closedReason = '';
    field = null;
    view = null;
    const wrLog = el('wrChatLog');
    if (wrLog) wrLog.textContent = '';
    paintStrip();
    paint();
  }

  function init() {
    wire('chatForm', 'chatInput');
    wire('wrChatForm', 'wrChatInput');
    const strip = el('chatTables');
    if (strip) {
      // Delegated: the pills are rebuilt whenever the field changes.
      strip.addEventListener('click', function (e) {
        const btn = e.target.closest('button[data-view]');
        if (btn) setView(btn.dataset.view);
      });
    }
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
    renderField: renderField,
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
    view: function () {
      return view;
    },
  };
})();

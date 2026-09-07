// lobby.js - the tournament lobby: who you are, what is on, and the waiting
// room for the one you are in.
//
// Identity: a name and avatar, plus a token the server hands back; the token
// is what lets you rejoin. Tournaments: a list from the server, a create
// form, and a waiting room with the roster and the host's controls. The
// same code routes a rejoin: the server answers `identify` with `resume`
// when this identity has a live registration and follows with
// tournamentJoined, which lands in the waiting room or on the table.

(function () {
  'use strict';

  const TOKEN_KEY = 'finaltable_identity_token';
  const NAME_KEY = 'finaltable_player_name';
  const LAST_KEY = 'finaltable_last_tournament';

  let identity = null;
  let list = [];
  let current = null; // latest tournamentState for our tournament
  let currentId = null;
  let pendingJoinCode = null;
  let pendingCreate = null;
  let pendingLastCheck = null; // a tournament we were in before this page load
  let view = 'home';

  const $ = (id) => document.getElementById(id);
  const store = {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch (_err) {
        return null;
      }
    },
    set(key, value) {
      try {
        if (value === null || value === undefined) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch (_err) {
        /* private mode */
      }
    },
  };

  function nameValue() {
    return sanitizeLobbyPlayerName($('playerName').value);
  }
  function avatarValue() {
    return $('playerAvatar').value || '🧑';
  }
  function needName() {
    const input = $('playerName');
    input.classList.add('input-invalid');
    input.focus();
    return false;
  }

  // ── Identity ─────────────────────────────────────────────────────────────

  // Emitted on every connect. Without a name and without a token there is
  // nothing to say yet; the list still arrives, and the first name blur or
  // submit identifies.
  function identify() {
    if (!socket) return false;
    const name = nameValue();
    const token = store.get(TOKEN_KEY);
    if (!name && !token) return false;
    if (name) store.set(NAME_KEY, name);
    socket.emit('identify', { token, name, avatar: avatarValue() });
    return true;
  }

  function onIdentified(ident) {
    identity = ident;
    window.__identity = ident;
    store.set(TOKEN_KEY, ident.token);
    if (ident.name && !nameValue()) $('playerName').value = ident.name;
    $('identityStatus').textContent = `Playing as ${ident.name}`;
    setConnection(true);
    if (ident.resume) {
      store.set(LAST_KEY, null);
      return; // the server rebinds and sends tournamentJoined
    }
    // We were in a tournament before this page load and it did not resume:
    // it finished, was cancelled, or the server restarted. The list says which.
    if (!window.__tournamentActive && store.get(LAST_KEY)) {
      pendingLastCheck = store.get(LAST_KEY);
      store.set(LAST_KEY, null);
    }
    if (pendingCreate) {
      const payload = pendingCreate;
      pendingCreate = null;
      socket.emit('createTournament', payload);
      return;
    }
    if (pendingJoinCode) {
      const code = pendingJoinCode;
      pendingJoinCode = null;
      socket.emit('joinTournament', { code });
      return;
    }
    // Reconnected while on a table that no longer holds us.
    if (window.__tournamentActive) {
      returnToLobby('Your tournament ended while you were away.');
      return;
    }
    socket.emit('listTournaments');
  }

  function onSessionReplaced() {
    returnToLobby('You opened FinalTable somewhere else; this tab was signed out of the table.');
  }

  function setConnection(ok) {
    const banner = $('connStatus');
    if (banner) banner.classList.toggle('hidden', ok);
  }

  // ── Tournament events ────────────────────────────────────────────────────

  function onList(items) {
    list = Array.isArray(items) ? items : [];
    renderList();
    if (pendingLastCheck) {
      const id = pendingLastCheck;
      pendingLastCheck = null;
      if (!list.some((t) => t.id === id) && typeof window.showNoticeDialog === 'function') {
        window.showNoticeDialog({
          title: 'Lobby',
          message:
            'The tournament you were in is over: it finished, was cancelled, or the server restarted while it was running.',
          confirmLabel: 'OK',
        });
      }
    }
  }

  function onJoined(info) {
    currentId = info.id;
    myId = info.you && info.you.playerId ? info.you.playerId : socket.id;
    window.__tournamentActive = true;
    window.__currentTournamentId = info.id;
    store.set(LAST_KEY, info.id);
    if (info.status === 'registering') showView('waiting');
    else enterTable();
  }

  function onState(state) {
    if (!state || state.id !== currentId) return;
    current = state;
    if (window.TournamentField) TournamentField.render(state);
    if (state.status !== 'registering' && !tableShowing()) enterTable();
    if (view === 'waiting') renderWaiting();
  }

  function onLeft(data) {
    if (data && data.id !== currentId) return;
    returnToLobby(
      data && data.reason === 'left'
        ? 'You left the table. Your stack plays on under auto-play; join by code to take it back.'
        : null
    );
  }

  function onCancelled(data) {
    if (!data || data.id !== currentId) {
      if (socket && socket.connected) socket.emit('listTournaments');
      return;
    }
    returnToLobby(`"${data.name}" was cancelled: ${data.reason}.`);
  }

  function onEliminated(data) {
    if (!data) return;
    const prize = data.prize ? ` and won ${data.prize.toLocaleString()}` : '';
    const note = data.lateRegOpen ? ' Late registration is still open, so this may move.' : '';
    if (typeof window.showNoticeDialog === 'function') {
      window.showNoticeDialog({
        title: `You finished #${data.place} of ${data.entrants}`,
        message: `You are out${prize}.${note} You can keep watching the table.`,
        confirmLabel: 'Watch',
      });
    }
  }

  function onError(message) {
    if (tableShowing()) return;
    if (typeof window.showNoticeDialog === 'function') {
      window.showNoticeDialog({ title: 'Lobby', message, confirmLabel: 'OK' });
    }
  }

  // ── Views ────────────────────────────────────────────────────────────────

  function tableShowing() {
    return $('gameScreen').classList.contains('active');
  }

  function showView(name) {
    view = name;
    ['home', 'create', 'waiting'].forEach((v) => {
      const node = $('lobby' + v.charAt(0).toUpperCase() + v.slice(1));
      if (node) node.classList.toggle('hidden', v !== name);
    });
    if (name === 'waiting') renderWaiting();
    if (name === 'home') renderList();
  }

  function enterTable() {
    $('loginScreen').classList.add('hidden');
    $('gameScreen').classList.add('active');
    window.__tournamentActive = true;
  }

  function returnToLobby(notice) {
    current = null;
    currentId = null;
    window.__currentTournamentId = null;
    window.__tournamentActive = false;
    window.mttField = null;
    window.mttFinished = null;
    gameState = null;
    myId = null;
    if (tournamentTimer) {
      clearInterval(tournamentTimer);
      tournamentTimer = null;
    }
    const log = $('panelChatBody');
    if (log) log.textContent = '';
    const ticker = $('logLast');
    if (ticker) ticker.textContent = 'Waiting...';
    const chat = $('npcChatArea');
    if (chat) chat.textContent = '';
    ['tournamentBanner', 'resultModal'].forEach((id) => {
      const node = $(id);
      if (node) node.classList.add('hidden');
    });
    const topInfo = $('topInfo');
    if (topInfo) topInfo.textContent = 'Waiting...';
    if (window.SidePanel) SidePanel.refresh('info');
    $('gameScreen').classList.remove('active');
    $('loginScreen').classList.remove('hidden');
    showView('home');
    if (socket && socket.connected) socket.emit('listTournaments');
    if (notice && typeof window.showNoticeDialog === 'function') {
      window.showNoticeDialog({ title: 'Lobby', message: notice, confirmLabel: 'OK' });
    }
  }

  // ── The list ─────────────────────────────────────────────────────────────

  function fmtChips(n) {
    return typeof n === 'number' ? n.toLocaleString() : '-';
  }

  function fmtCountdown(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  function fmtLevel(seconds) {
    return seconds % 60 === 0 ? `${seconds / 60}-min levels` : `${seconds}s levels`;
  }

  function statusLine(t) {
    if (t.status === 'registering') {
      const wait = t.startsAt - Date.now();
      return wait > 0 ? `Starts in ${fmtCountdown(wait)}` : 'Starting…';
    }
    if (t.status === 'running') {
      return `Level ${t.level} · ${t.remaining} left` + (t.lateRegOpen ? ' · late reg open' : '');
    }
    return t.winner ? `Won by ${t.winner}` : 'Finished';
  }

  function tournamentCard(t) {
    const card = document.createElement('div');
    card.className = `t-card t-card-${t.status}`;
    card.dataset.code = t.code;

    const head = document.createElement('div');
    head.className = 't-card-head';
    const name = document.createElement('div');
    name.className = 't-card-name';
    name.textContent = t.name;
    const tag = document.createElement('span');
    tag.className = `room-status-tag room-status-tag-${t.status}`;
    tag.textContent = t.status;
    head.append(name, tag);

    const status = document.createElement('div');
    status.className = 't-card-status';
    status.dataset.startsAt = t.startsAt;
    status.dataset.status = t.status;
    status.textContent = statusLine(t);

    const meta = document.createElement('div');
    meta.className = 't-card-meta';
    const players = `${t.entrants.total} player${t.entrants.total === 1 ? '' : 's'}`;
    const parts = [
      t.hostName ? `Host ${t.hostName}` : null,
      players,
      `${t.tableSize}-max`,
      fmtChips(t.startChips),
      fmtLevel(t.levelDuration),
      t.lateRegLevels ? `late reg through L${t.lateRegLevels}` : 'no late reg',
      t.buyIn ? `buy-in ${fmtChips(t.buyIn)}` : null,
    ].filter(Boolean);
    meta.textContent = parts.join(' · ');

    const btn = document.createElement('button');
    btn.className = 't-card-btn';
    btn.type = 'button';
    const mine = t.you && t.you.registered;
    if (mine) {
      btn.textContent = t.status === 'registering' ? 'Open' : 'Rejoin';
    } else if (t.status === 'registering') {
      btn.textContent = 'Join';
    } else if (t.status === 'running' && t.lateRegOpen) {
      btn.textContent = 'Join late';
    } else if (t.status === 'running') {
      btn.textContent = 'Late reg closed';
      btn.disabled = true;
    } else {
      btn.textContent = 'Results';
      btn.disabled = true;
    }
    btn.addEventListener('click', () => joinCode(t.code));

    card.append(head, status, meta, btn);
    return card;
  }

  function renderList() {
    const buckets = { yours: [], registering: [], running: [], finished: [] };
    for (const t of list) {
      if (t.you && t.you.registered) buckets.yours.push(t);
      else if (buckets[t.status]) buckets[t.status].push(t);
    }
    let any = false;
    for (const [key, items] of Object.entries(buckets)) {
      const cap = key.charAt(0).toUpperCase() + key.slice(1);
      const section = $('section' + cap);
      const holder = $('list' + cap);
      if (!section || !holder) continue;
      holder.textContent = '';
      items.forEach((t) => holder.appendChild(tournamentCard(t)));
      section.classList.toggle('hidden', items.length === 0);
      if (items.length) any = true;
    }
    const empty = $('lobbyEmpty');
    if (empty) empty.classList.toggle('hidden', any);
  }

  // ── Create ───────────────────────────────────────────────────────────────

  function toLocalInput(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
  }

  function setQuick(minutes) {
    const when = Date.now() + minutes * 60 * 1000;
    $('tStartAt').value = toLocalInput(when);
    $('tStartAt').dataset.quick = String(minutes);
    document.querySelectorAll('#tStartQuick button').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.min) === minutes);
    });
  }

  function openCreate() {
    if (!$('tName').value) $('tName').value = 'Game Night';
    setQuick(10);
    document.querySelectorAll('#tStartQuick button').forEach((b) => b.classList.remove('active'));
    showView('create');
    $('tName').focus();
  }

  function submitCreate() {
    if (!nameValue()) return needName();
    const quick = $('tStartAt').dataset.quick;
    let startsAt = Date.parse($('tStartAt').value);
    if (quick === '0') startsAt = Date.now();
    if (!Number.isFinite(startsAt)) startsAt = Date.now();
    const payload = {
      name: $('tName').value.trim() || 'Game Night',
      startsAt,
      tableSize: parseInt($('tTableSize').value, 10),
      startChips: parseInt($('tStartChips').value, 10),
      levelDuration: parseInt($('tLevelDuration').value, 10),
      lateRegLevels: parseInt($('tLateRegLevels').value, 10),
      buyIn: Math.max(0, Math.min(10000, parseInt($('tBuyIn').value, 10) || 0)),
    };
    if (identity && socket && socket.connected) {
      socket.emit('createTournament', payload);
    } else {
      pendingCreate = payload;
      identify();
    }
    return true;
  }

  function joinCode(code) {
    const clean = String(code || '')
      .trim()
      .toUpperCase();
    if (!clean) return false;
    if (!nameValue()) {
      pendingJoinCode = clean;
      return needName();
    }
    if (identity && socket && socket.connected) {
      socket.emit('joinTournament', { code: clean });
    } else {
      pendingJoinCode = clean;
      identify();
    }
    return true;
  }

  // ── Waiting room ─────────────────────────────────────────────────────────

  function renderRosterRow(row) {
    const line = document.createElement('div');
    line.className = 'wr-row';
    const dot = document.createElement('span');
    dot.className = 'wr-dot' + (row.connected ? ' on' : '');
    dot.title = row.connected ? 'Connected' : 'Not connected';
    const avatar = document.createElement('span');
    avatar.className = 'wr-avatar';
    avatar.textContent = row.avatar || '🧑';
    const name = document.createElement('span');
    name.className = 'wr-name';
    name.textContent = row.name;
    line.append(dot, avatar, name);
    if (row.isHost) {
      const badge = document.createElement('span');
      badge.className = 'wr-badge';
      badge.textContent = 'host';
      line.appendChild(badge);
    }
    if (row.place) {
      const badge = document.createElement('span');
      badge.className = 'wr-badge';
      badge.textContent = `#${row.place}`;
      line.appendChild(badge);
    }
    return line;
  }

  function renderWaiting() {
    const t = current;
    if (!t) return;
    $('wrName').textContent = t.name;
    $('wrCode').textContent = t.code;
    $('wrStatus').textContent = waitingStatus(t);
    const roster = $('wrRoster');
    roster.textContent = '';
    (t.roster || []).forEach((row) => roster.appendChild(renderRosterRow(row)));
    const s = t.settings || {};
    const parts = [
      `${s.tableSize}-max tables`,
      `${fmtChips(s.startChips)} starting stack`,
      fmtLevel(s.levelDuration),
      s.lateRegLevels
        ? `late registration through level ${s.lateRegLevels}`
        : 'no late registration',
      s.buyIn ? `buy-in ${fmtChips(s.buyIn)} · prize pool ${fmtChips(t.prizePool)}` : null,
    ].filter(Boolean);
    const settings = $('wrSettings');
    settings.textContent = '';
    settings.appendChild(document.createTextNode(parts.join(' · ')));
    if (t.payouts && t.payouts.length && t.prizePool > 0) {
      const ladder = document.createElement('div');
      ladder.className = 'wr-ladder';
      ladder.textContent =
        'Pays ' + t.payouts.map((p) => `#${p.place} ${fmtChips(p.amount)}`).join(' · ');
      settings.appendChild(ladder);
    }
    const host = $('wrHostControls');
    host.classList.toggle('hidden', !(t.isHost && t.status === 'registering'));
    $('btnStartNow').disabled = (t.entrants || 0) < 2;
    $('btnUnregister').classList.toggle('hidden', t.status !== 'registering');
    $('btnLeaveTournament').classList.toggle('hidden', t.status === 'registering');
    $('btnEnterTable').classList.toggle('hidden', t.status === 'registering');
  }

  function waitingStatus(t) {
    if (t.status === 'registering') {
      const wait = t.startsAt - Date.now();
      if (wait > 0) return `Starts in ${fmtCountdown(wait)}`;
      return t.waitingReason || 'Starting…';
    }
    if (t.status === 'running') {
      return `Running · level ${t.level}` + (t.lateRegOpen ? ' · late registration open' : '');
    }
    return t.winner ? `Finished · won by ${t.winner}` : 'Finished';
  }

  function tickCountdowns() {
    if (view === 'waiting' && current) $('wrStatus').textContent = waitingStatus(current);
    document.querySelectorAll('.t-card-status[data-status="registering"]').forEach((node) => {
      const wait = Number(node.dataset.startsAt) - Date.now();
      node.textContent = wait > 0 ? `Starts in ${fmtCountdown(wait)}` : 'Starting…';
    });
  }

  function copyLink() {
    if (!current) return;
    const url = `${location.origin}${location.pathname}?t=${current.code}`;
    const done = () => {
      $('btnCopyLink').textContent = 'Copied';
      setTimeout(() => ($('btnCopyLink').textContent = 'Copy link'), 1500);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url).then(done, () => fallbackCopy(url, done));
    } else {
      fallbackCopy(url, done);
    }
  }

  function fallbackCopy(text, done) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      done();
    } catch (_err) {
      /* nothing to do */
    }
    area.remove();
  }

  // Leave whatever we are in: unregister before the start, leave (with the
  // stack under auto-play) once running.
  async function leave() {
    if (!socket || !currentId) return;
    if (current && current.status === 'registering') {
      socket.emit('unregisterTournament');
      return;
    }
    let ok = true;
    if (typeof window.showConfirmDialog === 'function') {
      ok = await window.showConfirmDialog({
        title: 'Leave the tournament?',
        message: 'Your stack stays in play under auto-play. You can rejoin from the lobby.',
        confirmLabel: 'Leave',
        cancelLabel: 'Stay',
      });
    }
    if (ok) socket.emit('leaveTournament');
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  function init() {
    $('btnCreateTournament').addEventListener('click', openCreate);
    $('btnCreateCancel').addEventListener('click', () => showView('home'));
    $('btnCreateSubmit').addEventListener('click', submitCreate);
    $('joinCodeForm').addEventListener('submit', (e) => {
      e.preventDefault();
      if (joinCode($('joinCodeInput').value)) $('joinCodeInput').value = '';
    });
    document.querySelectorAll('#tStartQuick button').forEach((b) => {
      b.addEventListener('click', () => setQuick(Number(b.dataset.min)));
    });
    $('tStartAt').addEventListener('input', () => {
      delete $('tStartAt').dataset.quick;
      document.querySelectorAll('#tStartQuick button').forEach((b) => b.classList.remove('active'));
    });
    $('btnStartNow').addEventListener('click', () => socket && socket.emit('startTournamentNow'));
    $('btnCancelTournament').addEventListener('click', async () => {
      let ok = true;
      if (typeof window.showConfirmDialog === 'function') {
        ok = await window.showConfirmDialog({
          title: 'Cancel the tournament?',
          message: 'Everyone registered is sent back to the lobby.',
          confirmLabel: 'Cancel it',
          cancelLabel: 'Keep it',
        });
      }
      if (ok && socket) socket.emit('cancelTournament');
    });
    $('btnUnregister').addEventListener('click', leave);
    $('btnLeaveTournament').addEventListener('click', leave);
    $('btnEnterTable').addEventListener('click', enterTable);
    $('btnCopyLink').addEventListener('click', copyLink);

    // Name and avatar edits re-identify (the server updates the identity).
    let renameTimer = null;
    const reidentify = () => {
      clearTimeout(renameTimer);
      renameTimer = setTimeout(() => {
        if (identity && nameValue()) identify();
      }, 400);
    };
    $('playerName').addEventListener('blur', () => {
      if (!identity && nameValue()) identify();
      else reidentify();
    });
    $('playerName').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.target.blur();
      }
    });
    $('avatarPicker').addEventListener('click', reidentify);

    const params = new URLSearchParams(location.search);
    const fromLink = params.get('t');
    if (fromLink) {
      pendingJoinCode = fromLink.trim().toUpperCase();
      $('joinCodeInput').value = pendingJoinCode;
    }
    const savedName = store.get(NAME_KEY);
    if (savedName && !$('playerName').value) $('playerName').value = savedName;

    setInterval(tickCountdowns, 1000);
    ensureSocket();
    if (fromLink && !nameValue()) needName();
  }

  window.Lobby = {
    identify,
    onIdentified,
    onSessionReplaced,
    onList,
    onJoined,
    onState,
    onLeft,
    onCancelled,
    onEliminated,
    onError,
    setConnection,
    enterTable,
    returnToLobby,
    leave,
    joinCode,
    showView,
    current: () => current,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

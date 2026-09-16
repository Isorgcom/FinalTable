// lobby.js - the tournament lobby: who you are, what is on, and the waiting
// room for the one you are in.
//
// Identity: a name and avatar, plus a token the server hands back; the token
// is what lets you rejoin. Tournaments: a list from the server, a create
// form, and a waiting room with the roster and the host's controls. The
// same code routes a rejoin: the server answers `identify` with `resume`
// when this identity has a live registration and follows with
// tournamentJoined, which lands in the waiting room or on the table.
//
// GameNight sign-in, when the server offers it (serverInfo): the button sends
// the browser to GameNight with a random state; GameNight sends it back to
// this page with a signed token in the URL fragment, which is handed to the
// server once over the socket. The device token that comes back is stored
// like a guest's, with the provider beside it, so every later connect is an
// ordinary token identify and GameNight is not consulted again.

(function () {
  'use strict';

  const TOKEN_KEY = 'finaltable_identity_token';
  const NAME_KEY = 'finaltable_player_name';
  // A line to show after a reload this page asked for. Signing a device out
  // reloads it, and a dialog raised the instant before that goes with it: the
  // player would be signed out with nothing said about why.
  const NOTICE_KEY = 'finaltable_pending_notice';
  const LAST_KEY = 'finaltable_last_tournament';
  const PROVIDER_KEY = 'finaltable_identity_provider';
  const SSO_STATE_KEY = 'finaltable_gn_state'; // sessionStorage: one round trip

  let identity = null;
  let serverInfo = null;
  let pendingGnToken = null; // the token from the fragment, until it is sent
  let list = [];
  let current = null; // latest tournamentState for our tournament
  let currentId = null;
  // A join waiting on a name: `{ code }` from the box or a link, `{ tournamentId }` from a card.
  let pendingJoin = null;
  let pendingWatch = null; // a rail link, or a Watch button, waiting on a name
  let watching = false; // on the rail of the game we are in, not at a seat
  let pendingCreate = null;
  let pendingLastCheck = null; // a tournament we were in before this page load
  let pendingRequest = null; // asked to join an invite-only game, not yet answered
  const seenPending = new Set(); // uids the host has already been told about
  let view = 'home';

  const $ = (id) => document.getElementById(id);
  // The lobby's own copy, and browser-only on purpose. What it keeps is this
  // device's business - the token that proves who you are, the sign-in state,
  // the last game you were in - none of which should travel to another device.
  // A setting that ought to follow the player goes through window.Store in
  // app-state.js, which tells the server as well.
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

  // ── A page the server has moved past ─────────────────────────────────────
  //
  // index.html carries the build it was served with; serverInfo carries the
  // build the server serves now. They differ when a tab has outlived a
  // deploy, which on a phone can be days: old scripts against a new server
  // answer new events with silence. In the lobby the page reloads itself; at
  // a table it says so and reloads once the table is left.

  const RELOADED_KEY = 'ft.reloadedFor';
  let staleAssets = false;

  function pageAssetVersion() {
    const meta = document.querySelector('meta[name="finaltable-asset-version"]');
    const v = meta ? meta.getAttribute('content') || '' : '';
    // The raw template token means the page was served without a version.
    return v.indexOf('__') === 0 ? '' : v;
  }

  function sessionGet(key) {
    try {
      return sessionStorage.getItem(key);
    } catch (_err) {
      return null;
    }
  }

  function sessionSet(key, value) {
    try {
      sessionStorage.setItem(key, value);
    } catch (_err) {
      /* private mode */
    }
  }

  function reloadForUpdate(serverVersion) {
    sessionSet(RELOADED_KEY, serverVersion || sessionGet(RELOADED_KEY) || '');
    location.reload();
  }

  function noticeStaleAssets(serverVersion) {
    const mine = pageAssetVersion();
    if (!serverVersion || !mine || serverVersion === mine) {
      staleAssets = false;
      $('updateStatus').classList.add('hidden');
      return;
    }
    // Once per server build: a proxy handing back a cached index would
    // otherwise have the page reloading forever. After that, the banner.
    if (!tableShowing() && sessionGet(RELOADED_KEY) !== serverVersion) {
      reloadForUpdate(serverVersion);
      return;
    }
    staleAssets = true;
    $('updateStatus').classList.remove('hidden');
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
    if (pendingGnToken) {
      const gnToken = pendingGnToken;
      pendingGnToken = null;
      socket.emit('identify', { gnToken, avatar: avatarValue() });
      return true;
    }
    const token = store.get(TOKEN_KEY);
    if (store.get(PROVIDER_KEY) === 'gamenight') {
      if (!token) return false;
      // No name: it is GameNight's, and sending one would let a stale token
      // turn into a guest of the same name on the server.
      socket.emit('identify', { token, provider: 'gamenight', avatar: avatarValue() });
      return true;
    }
    const name = nameValue();
    if (!name && !token) return false;
    if (name) store.set(NAME_KEY, name);
    socket.emit('identify', { token, name, avatar: avatarValue() });
    return true;
  }

  // ── The lobby's menu ─────────────────────────────────────────────────────
  //
  // Same idiom as the table's (app-state.js): a class on the dropdown, closed
  // by an outside click and by Escape. Every item closes it before acting.

  function lobbyMenuOpen() {
    return $('lobbyMenuDropdown').classList.contains('open');
  }

  function closeLobbyMenu() {
    $('lobbyMenuDropdown').classList.remove('open');
    $('lobbyMenuToggle').setAttribute('aria-expanded', 'false');
  }

  function toggleLobbyMenu() {
    const open = $('lobbyMenuDropdown').classList.toggle('open');
    $('lobbyMenuToggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function isGameNight() {
    return !!(identity && identity.provider === 'gamenight');
  }

  function renderIdentityRow() {
    const row = $('ssoRow');
    if (!row) return;
    const offered = !!(serverInfo && serverInfo.gamenight);
    const linked = isGameNight();
    // Signed in, the row's only contents - the button and its hint - are both
    // beside the point, and signing out lives in the menu. So the row goes.
    row.classList.toggle('hidden', linked || !offered);
    $('btnGameNight').classList.toggle('hidden', linked || !offered);
    $('ssoHint').classList.toggle('hidden', linked);
    $('btnGameNightSignOut').classList.toggle('hidden', !linked);
    // A guest is one browser and would see a list of one. The list is here for
    // an account whose devices are more than this one.
    $('btnSessions').classList.toggle('hidden', !linked);
    // Unlike the devices list, this one is for a guest too: they have played
    // the games whether or not they have an account to hang them on.
    $('btnMyGames').classList.toggle('hidden', !identity);
    $('playerName').readOnly = linked;
    $('playerName').classList.remove('input-invalid');
  }

  function onServerInfo(info) {
    serverInfo = info || null;
    window.__serverInfo = serverInfo;
    renderIdentityRow();
    $('btnLobbyAdmin').classList.toggle('hidden', !(serverInfo && serverInfo.adminAvailable));
    const version = serverInfo && serverInfo.version;
    $('lobbyMenuVersion').textContent = version ? `FinalTable v${version}` : 'FinalTable';
    if (window.Reactions) Reactions.configure(serverInfo ? serverInfo.reactions : null);
    // serverInfo only ever arrives over a live connection.
    setConnection(true);
    noticeStaleAssets(serverInfo ? serverInfo.assetVersion : '');
  }

  function onIdentified(ident) {
    identity = ident;
    window.__identity = ident;
    store.set(TOKEN_KEY, ident.token);
    if (ident.provider === 'gamenight') {
      store.set(PROVIDER_KEY, 'gamenight');
      $('playerName').value = ident.name;
      store.set(NAME_KEY, ident.name);
      $('identityStatus').textContent = `Signed in with GameNight as ${ident.name}`;
    } else {
      store.set(PROVIDER_KEY, null);
      if (ident.name && !nameValue()) $('playerName').value = ident.name;
      $('identityStatus').textContent = `Playing as ${ident.name}`;
    }
    renderIdentityRow();
    setConnection(true);
    if (ident.resume) {
      store.set(LAST_KEY, null);
      return; // the server rebinds and sends tournamentJoined
    }
    if (ident.pending) {
      return; // still at the door; tournamentPending has already drawn it
    }
    // We were at the door before this connect and the request did not come
    // back: the grace ran out, or the server restarted.
    if (view === 'pending') {
      returnToLobby('Your request to join lapsed while you were away.');
      return;
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
    if (pendingJoin) {
      const payload = pendingJoin;
      pendingJoin = null;
      socket.emit('joinTournament', payload);
      return;
    }
    if (pendingWatch) {
      const payload = pendingWatch;
      pendingWatch = null;
      socket.emit('watchTournament', payload);
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

  // ── Admin page ────────────────────────────────────────────────────────
  //
  // Server settings an admin changes from the browser, behind the same
  // password as the table's admin controls. The page holds no privilege: the
  // unlock is per socket and every request is checked on the server.

  let adminPending = false; // opening the page once the unlock answers
  let pairing = null;
  let adminGames = null; // every game on the server, once asked for
  let adminLogRows = null; // what the server has done, a page at a time
  let adminLogMore = false;
  let _drawnLogSig = null;
  let _drawnGamesSig = null;
  // Why the admin page is locked, when it is. Admin.isAuthed() is the truth of
  // whether it is; this is only what to say about it.
  let adminLockReason = null;
  // Whether the reader has paged back into older rows. They are reading, and
  // pulling the page out from under them to add a line at the top is worse
  // than the line arriving late.
  let adminLogPaged = false;
  // The games this player has played that are still kept. Null until asked for.
  let myGames = null;

  // ── The Admin page's tabs ───────────────────────────────────────────────
  //
  // One page at a time, so a fourth and fifth thing can join without making
  // the page a longer scroll. Adding one is an entry here, a button in the
  // strip and a section beside the others; nothing else has to know.
  //
  // Its own small controller rather than SidePanel's: that module is bound to
  // #sidePanel throughout, half of it is drawer and rail plumbing that only
  // means something over a felt, and its tab list is mirrored on the server
  // as a synced *player* preference. An admin's tab is neither. The look is
  // shared - the buttons are .side-tab - which is where the duplication would
  // actually have cost something.
  const ADMIN_PAGES = [
    { name: 'games', cap: 'Games', onShow: () => askForAdminGames() },
    { name: 'gamenight', cap: 'GameNight', onShow: null },
    { name: 'password', cap: 'Password', onShow: () => setPwStatus('') },
    { name: 'log', cap: 'Log', onShow: () => askForAdminLog({ fresh: true }) },
  ];
  // Session only, and back to Games every time the page opens. Deliberately
  // not window.Store: that is the player-preference store, which now travels
  // to the server, and this is not a player's setting.
  let adminTab = 'games';

  function adminTabButtons() {
    return document.querySelectorAll('#lobbyAdmin .admin-tabs .side-tab');
  }

  function selectAdminTab(name) {
    const page = ADMIN_PAGES.find((x) => x.name === name);
    if (!page) return;
    adminTab = name;
    adminTabButtons().forEach((tab) => {
      const on = tab.dataset.adminTab === name;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      // Roving tabindex: one stop for the whole strip, arrows move within it.
      tab.tabIndex = on ? 0 : -1;
    });
    for (const p of ADMIN_PAGES) {
      const node = $('adminPage' + p.cap);
      if (node) node.classList.toggle('hidden', p.name !== name);
    }
    if (page.onShow) page.onShow();
  }

  // The same roving handler the side panel uses, and the same choice with it:
  // an arrow selects rather than only moving focus, so the page follows.
  function onAdminTabKey(e) {
    const list = [...adminTabButtons()];
    const idx = list.indexOf(document.activeElement);
    if (idx < 0 || !list.length) return;
    let next = -1;
    if (e.key === 'ArrowRight') next = (idx + 1) % list.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + list.length) % list.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    if (next < 0) return;
    e.preventDefault();
    selectAdminTab(list[next].dataset.adminTab);
    list[next].focus();
  }

  function unlocked() {
    return !!(socket && socket.connected && window.Admin && Admin.isAuthed());
  }

  function askForAdminGames() {
    if (unlocked()) socket.emit('adminListTournaments');
  }

  // The Log, a page at a time. `fresh` starts again from the newest, which is
  // what opening the tab means; otherwise it asks for what is older than the
  // oldest row already shown.
  // `fresh` starts again from the newest, which is what opening the tab means.
  // `quiet` is the same ask without blanking the list first: the page follows
  // the newest rows on a timer, and a flash of "Loading..." every few seconds
  // would be worse than not following them at all.
  function askForAdminLog({ fresh = false, quiet = false } = {}) {
    if (!unlocked()) return;
    if (fresh) {
      if (!quiet) {
        adminLogRows = null;
        adminLogMore = false;
        _drawnLogSig = null;
        renderAdminLog();
      }
      adminLogPaged = false;
      socket.emit('adminLog', {});
      return;
    }
    const oldest =
      adminLogRows && adminLogRows.length ? adminLogRows[adminLogRows.length - 1].id : null;
    if (oldest) adminLogPaged = true;
    socket.emit('adminLog', oldest ? { before: oldest } : {});
  }

  function onAdminLogRows(data) {
    const page = data && Array.isArray(data.rows) ? data.rows : [];
    // The server says which page this is. The newest replaces what is held;
    // an older one is added under it. Told rather than guessed, so a refresh
    // landing while a "Show older" is in flight cannot be taken for it.
    const newest = !data || data.before === null || data.before === undefined;
    adminLogRows = newest ? page : (adminLogRows || []).concat(page);
    adminLogMore = !!(data && data.more);
    renderAdminLog();
  }

  // What one row says, in the words the server used. A game is the only one
  // with anything to lay out; the rest are a line each.
  function adminLogRow(row) {
    const el = document.createElement('div');
    el.className = `admin-log-row admin-log-${row.kind}`;

    const when = document.createElement('span');
    when.className = 'admin-log-when';
    when.textContent = fmtWhen(row.at);

    const what = document.createElement('span');
    what.className = 'admin-log-what';
    if (row.kind === 'game') {
      const bits = [
        row.name || 'A game',
        row.ended === 'finished' && row.winner ? `won by ${row.winner}` : row.ended,
        row.entrants ? `${row.entrants} entrant${row.entrants === 1 ? '' : 's'}` : null,
        row.level ? `to level ${row.level}` : null,
      ].filter(Boolean);
      what.textContent = bits.join(' · ');
    } else if (row.kind === 'signin') {
      what.textContent = `${row.name || 'Somebody'} signed in${
        row.provider && row.provider !== 'guest' ? ` with ${row.provider}` : ''
      }${row.isNew ? ', new here' : ''}`;
    } else {
      what.textContent = [row.message, row.detail].filter(Boolean).join(' — ');
    }

    const tag = document.createElement('span');
    tag.className = `admin-log-tag admin-log-tag-${row.level === 'error' || row.level === 'warn' ? row.level : row.kind}`;
    tag.textContent = row.kind === 'server' ? row.level || 'info' : row.kind;

    el.append(tag, what, when);
    return el;
  }

  // Rebuilt under a signature, as the games list is: a refresh that changes
  // nothing leaves the page where the reader left it.
  function renderAdminLog() {
    const holder = $('adminLogList');
    const status = $('adminLogStatus');
    const more = $('btnAdminLogMore');
    if (!holder || !status) return;
    if (adminLogRows === null) {
      status.textContent = 'Loading…';
      holder.textContent = '';
      if (more) more.classList.add('hidden');
      return;
    }
    const sig = adminLogRows.map((r) => r.id).join(',') + ':' + adminLogMore;
    if (sig === _drawnLogSig) return;
    _drawnLogSig = sig;
    holder.textContent = '';
    const n = adminLogRows.length;
    status.textContent = n ? `${n} entr${n === 1 ? 'y' : 'ies'}` : '';
    if (!n) {
      const empty = document.createElement('div');
      empty.className = 'admin-games-empty';
      empty.textContent = 'Nothing yet. This fills as the server runs.';
      holder.appendChild(empty);
    } else {
      adminLogRows.forEach((row) => holder.appendChild(adminLogRow(row)));
    }
    if (more) more.classList.toggle('hidden', !adminLogMore);
  }

  async function openAdmin() {
    closeLobbyMenu();
    // Already here and unlocking again after a drop: stay on the page being
    // read rather than starting over at Games.
    const reopening = view === 'admin';
    if (window.Admin && Admin.isAuthed()) {
      setPwStatus('');
      adminLockReason = null;
      showView('admin');
      paintAdminLock();
      renderAdminGames();
      // Back to the first page each time, and selecting it asks for the list.
      selectAdminTab(reopening ? adminTab : 'games');
      // Asked for whatever tab is showing: the pairing decides whether the
      // sign-in button exists at all, which is not only this page's business.
      if (socket) socket.emit('adminGetGameNight');
      return;
    }
    if (typeof window.showTextPromptDialog !== 'function' || !socket) return;
    const password = await window.showTextPromptDialog({
      title: 'Admin login',
      message: 'Password for the admin controls.',
      hint: 'Sent over this connection as typed; the server is plain HTTP on your network.',
      confirmLabel: 'Unlock',
      placeholder: 'password',
      maxLength: 128,
      masked: true,
    });
    if (!password) return;
    adminPending = true;
    window.__adminPending = true;
    socket.emit('adminLogin', { password });
  }

  function onAdminStatus(st) {
    // A password changed elsewhere signs every other admin session out. The
    // page has to say so for the same reason a drop does.
    if (st && !st.ok && st.signedOut) onAdminLocked('password');
    if (st && st.ok) {
      adminLockReason = null;
      paintAdminLock();
    }
    if (!adminPending) return;
    adminPending = false;
    window.__adminPending = false;
    if (st && st.ok) openAdmin();
  }

  // The unlock is gone. Said here, on the page, because every admin request is
  // answered with silence when a socket is not unlocked - which is right
  // against somebody probing the server, and unreadable from inside the page.
  function onAdminLocked(reason) {
    adminLockReason = reason || 'dropped';
    paintAdminLock();
  }

  const LOCK_WORDS = {
    dropped: 'The connection dropped, so the admin controls locked again.',
    password: 'The admin password was changed, so this session was signed out.',
  };

  function paintAdminLock() {
    const banner = $('adminLocked');
    const text = $('adminLockedText');
    if (!banner) return;
    const locked = !(window.Admin && Admin.isAuthed());
    banner.classList.toggle('hidden', !locked);
    if (locked && text) text.textContent = LOCK_WORDS[adminLockReason] || LOCK_WORDS.dropped;
  }

  function setPairingStatus(text, kind) {
    const el = $('adminGnStatus');
    el.textContent = text || '';
    el.classList.toggle('ok', kind === 'ok');
    el.classList.toggle('err', kind === 'err');
  }

  function fmtWhen(ms) {
    if (!ms) return 'from the environment';
    try {
      return new Date(ms).toLocaleString();
    } catch (_err) {
      return String(ms);
    }
  }

  function renderPairing() {
    const p = pairing;
    const detail = $('adminGnDetail');
    detail.textContent = '';
    if (p && p.paired) {
      const lines = [
        `issuer   ${p.issuer}`,
        `slug     ${p.audience}`,
        `key id   ${p.kid}`,
        `fetched  ${fmtWhen(p.fetchedAt)}`,
      ];
      if (p.url && p.issuer && p.url !== p.issuer) {
        lines.push(
          `note     GameNight calls itself ${p.issuer}; you entered ${p.url}. Its Site URL setting decides the issuer.`
        );
      }
      lines.forEach((line) => {
        const row = document.createElement('div');
        row.textContent = line;
        detail.appendChild(row);
      });
      if (!$('adminGnUrl').value) $('adminGnUrl').value = p.url || p.issuer;
      $('adminGnAudience').value = p.audience || 'finaltable';
      $('btnAdminPair').textContent = 'Pair again';
    } else {
      $('btnAdminPair').textContent = 'Pair';
    }
    detail.classList.toggle('hidden', !(p && p.paired));
    $('btnAdminRefresh').classList.toggle('hidden', !(p && p.paired));
    $('btnAdminUnpair').classList.toggle('hidden', !(p && p.paired));
  }

  // ── The admin's list of games ─────────────────────────────────────────

  function onAdminTournaments(data) {
    adminGames = data && Array.isArray(data.list) ? data.list : [];
    renderAdminGames();
  }

  // What a running game is doing, in the words a person would use. Mirrors
  // director.activity(); a status the card cannot name falls through to the
  // status line that was already there.
  const ACTIVITY_WORDS = {
    dealing: 'Dealing',
    idle: 'Between hands',
    paused: 'Paused by the host',
    break: 'On a break',
    holding: 'Holding for an empty room',
    'waiting-seat': 'Waiting for a seat',
    'waiting-balance': 'Waiting while the field rebalances',
  };

  // A hand takes seconds and the beat between hands is a second or two, so a
  // minute and a half of nothing is the first honest sign a game has stopped
  // moving. Below that the card says nothing about it rather than making a
  // normal pause look like a problem.
  const QUIET_MS = 90000;

  // How often the Games and Log pages ask again while one is open.
  const ADMIN_POLL_MS = 3000;

  function activityLine(t) {
    const word = ACTIVITY_WORDS[t.activity];
    if (!word) return '';
    const parts = [word];
    if (t.hands) parts.push(`${t.hands} hand${t.hands === 1 ? '' : 's'}`);
    if (t.lastHandAt && Date.now() - t.lastHandAt > QUIET_MS) {
      parts.push(`last hand ${sessionAge(t.lastHandAt)}`);
    }
    return parts.join(' · ');
  }

  // The field's shape on one line: which table, whether it is dealing, and how
  // many are sitting at it. One table of one beside two of two is a game
  // nobody can deal at, and this says so without opening any of them.
  function tablesRow(rows) {
    const row = document.createElement('div');
    row.className = 'admin-tables';
    const label = document.createElement('span');
    label.className = 'admin-tables-label';
    label.textContent = 'tables';
    row.appendChild(label);
    rows.forEach((table) => {
      const pip = document.createElement('span');
      pip.className =
        'admin-table-pip' + (table.broken ? ' broken' : table.running ? ' dealing' : '');
      pip.textContent = table.broken
        ? `${table.n} ✕`
        : `${table.n} ${table.running ? '▶' : '·'} ${table.players}`;
      pip.title = table.broken
        ? `Table ${table.n} is broken`
        : `Table ${table.n}: ${table.players} seated, ${table.running ? 'dealing' : 'idle'}`;
      row.appendChild(pip);
    });
    return row;
  }

  function adminCard(t) {
    const card = document.createElement('div');
    card.className = `t-card t-card-${t.status}`;
    card.dataset.id = t.id;

    const head = document.createElement('div');
    head.className = 't-card-head';
    const name = document.createElement('div');
    name.className = 't-card-name';
    name.textContent = t.name;
    const tag = document.createElement('span');
    tag.className = `room-status-tag room-status-tag-${t.status}`;
    tag.textContent = t.status;
    // Every card says how it is listed, public included: that is what the
    // admin is here to see.
    const vis = document.createElement('span');
    vis.className = 't-card-vis';
    vis.textContent = t.visibility === 'invite' ? 'invite-only' : t.visibility || 'private';
    head.append(name, tag, vis);

    const code = document.createElement('div');
    code.className = 'admin-code';
    code.textContent = t.code || '';

    const status = document.createElement('div');
    status.className = 't-card-status';
    status.textContent = statusLine(t);

    // What it is doing right now, which is the question "running" does not
    // answer. Only a running game has one.
    const activity = activityLine(t);
    const doing = document.createElement('div');
    doing.className = 'admin-activity admin-activity-' + (t.activity || 'none');
    doing.textContent = activity;

    const meta = document.createElement('div');
    meta.className = 't-card-meta';
    const total = t.entrants ? t.entrants.total : 0;
    const humans = t.entrants ? t.entrants.humans : 0;
    const parts = [
      t.hostName ? `Host ${t.hostName}` : null,
      `${t.connected}/${humans} connected`,
      `${total} entrant${total === 1 ? '' : 's'}`,
      t.status === 'running' ? `${t.tables} table${t.tables === 1 ? '' : 's'}` : null,
      t.pending ? `${t.pending} at the door` : null,
      // A game holding for an empty room is the one an admin might want to
      // end by hand rather than wait out, so the card says since when.
      t.held ? `holding since ${fmtWhen(t.heldSince)}` : null,
      `${t.tableSize}-max`,
      fmtChips(t.startChips),
      t.startedAt ? `started ${fmtWhen(t.startedAt)}` : `created ${fmtWhen(t.createdAt)}`,
    ].filter(Boolean);
    meta.textContent = parts.join(' · ');

    card.append(head, code, status);
    if (activity) card.appendChild(doing);
    if (t.tableRows && t.tableRows.length) card.appendChild(tablesRow(t.tableRows));
    card.appendChild(meta);
    if (t.status !== 'finished') {
      const actions = document.createElement('div');
      actions.className = 'admin-card-actions';
      const end = document.createElement('button');
      end.type = 'button';
      end.className = 'btn-danger';
      end.textContent = 'End game';
      end.addEventListener('click', () => endGameAsAdmin(t));
      actions.appendChild(end);
      card.appendChild(actions);
    }
    return card;
  }

  async function endGameAsAdmin(t) {
    let ok = true;
    if (typeof window.showConfirmDialog === 'function') {
      ok = await window.showConfirmDialog({
        title: `End "${t.name}"?`,
        message: 'Everyone in it is sent back to the lobby.',
        confirmLabel: 'End it',
        cancelLabel: 'Keep it',
      });
    }
    if (!ok || !socket) return;
    socket.emit('adminCancelTournament', { id: t.id });
  }

  // Rebuilt under a signature, as the lobby list is, so a refresh that
  // changes nothing leaves the button under the cursor alone.
  function renderAdminGames() {
    const holder = $('adminGamesList');
    const status = $('adminGamesStatus');
    if (adminGames === null) {
      status.textContent = 'Loading…';
      return;
    }
    const sig = JSON.stringify(
      adminGames.map((t) => [
        t.id,
        t.status,
        t.connected,
        t.entrants,
        t.pending,
        t.level,
        t.remaining,
        t.tables,
        t.lateRegOpen,
        t.activity,
        t.hands,
        // Bucketed to the minute: the card says "last hand 4 minutes ago", so
        // it has to redraw when that number changes and not on every poll.
        t.lastHandAt ? Math.floor((Date.now() - t.lastHandAt) / 60000) : null,
        t.tableRows,
      ])
    );
    if (sig === _drawnGamesSig) return;
    _drawnGamesSig = sig;
    holder.textContent = '';
    const n = adminGames.length;
    status.textContent = n ? `${n} game${n === 1 ? '' : 's'}` : '';
    if (!n) {
      const empty = document.createElement('div');
      empty.className = 'admin-games-empty';
      empty.textContent = 'No games right now.';
      holder.appendChild(empty);
      return;
    }
    adminGames.forEach((t) => holder.appendChild(adminCard(t)));
  }

  function onAdminGameNight(data) {
    if (!data) return;
    pairing = data;
    if (data.ok === false) {
      setPairingStatus(data.error || 'That did not work.', 'err');
    } else if (data.ok === true) {
      setPairingStatus(
        data.paired ? `Paired with ${data.issuer}. The sign-in button is live.` : 'Unpaired.',
        'ok'
      );
    } else {
      setPairingStatus(
        data.paired ? `Paired with ${data.issuer}.` : 'Not paired. Players sign in as guests only.'
      );
    }
    renderPairing();
    setPairingBusy(false);
  }

  function setPwStatus(text, kind) {
    const el = $('adminPwStatus');
    el.textContent = text || '';
    el.classList.toggle('ok', kind === 'ok');
    el.classList.toggle('err', kind === 'err');
  }

  function setAdminPassword() {
    if (!socket) return;
    const current = $('adminPwCurrent').value;
    const next = $('adminPwNext').value;
    const confirm = $('adminPwConfirm').value;
    if (!current) {
      setPwStatus('Enter the current password.', 'err');
      $('adminPwCurrent').focus();
      return;
    }
    if (next !== confirm) {
      setPwStatus('The two new passwords do not match.', 'err');
      $('adminPwConfirm').focus();
      return;
    }
    $('btnAdminSetPassword').disabled = true;
    setPwStatus('Changing…');
    socket.emit('adminSetPassword', { current, next });
  }

  function onAdminPasswordResult(data) {
    $('btnAdminSetPassword').disabled = false;
    if (data && data.ok) {
      ['adminPwCurrent', 'adminPwNext', 'adminPwConfirm'].forEach((id) => ($(id).value = ''));
      setPwStatus('Password changed. Any other admin session has been signed out.', 'ok');
      return;
    }
    setPwStatus((data && data.error) || 'That did not work.', 'err');
  }

  function setPairingBusy(busy) {
    ['btnAdminPair', 'btnAdminRefresh', 'btnAdminUnpair'].forEach((id) => ($(id).disabled = busy));
  }

  function pairGameNight() {
    if (!socket) return;
    const url = $('adminGnUrl').value.trim();
    const audience = $('adminGnAudience').value.trim() || 'finaltable';
    if (!/^https?:\/\/[^/\s?#]+/i.test(url)) {
      setPairingStatus('Enter the GameNight address as http(s)://host', 'err');
      $('adminGnUrl').focus();
      return;
    }
    setPairingBusy(true);
    setPairingStatus('Asking GameNight for its signing key…');
    socket.emit('adminPairGameNight', { url, audience });
  }

  function refreshGameNightKey() {
    if (!socket) return;
    setPairingBusy(true);
    setPairingStatus('Fetching the current key…');
    socket.emit('adminRefreshGameNight');
  }

  async function unpairGameNight() {
    if (!socket) return;
    let ok = true;
    if (typeof window.showConfirmDialog === 'function') {
      ok = await window.showConfirmDialog({
        title: 'Unpair from GameNight?',
        message:
          'The sign-in button goes away. Players already signed in keep their seats until they sign out.',
        confirmLabel: 'Unpair',
        cancelLabel: 'Keep it',
      });
    }
    if (!ok) return;
    setPairingBusy(true);
    socket.emit('adminUnpairGameNight');
  }

  // ── GameNight sign-in ────────────────────────────────────────────────────

  function randomState() {
    const bytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  const session = {
    get(key) {
      try {
        return sessionStorage.getItem(key);
      } catch (_err) {
        return null;
      }
    },
    set(key, value) {
      try {
        if (value === null || value === undefined) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, value);
      } catch (_err) {
        /* private mode */
      }
    },
  };

  function startGameNightLogin() {
    if (!serverInfo || !serverInfo.gamenight) return;
    const state = randomState();
    // The state guards the return leg; the join code rides with it so a link
    // that led here still lands at its table after the round trip.
    session.set(
      SSO_STATE_KEY,
      JSON.stringify({ state, code: pendingJoin && pendingJoin.code ? pendingJoin.code : null })
    );
    const url =
      serverInfo.gamenight.connectUrl +
      '?app=' +
      encodeURIComponent(serverInfo.gamenight.audience) +
      '&return=' +
      encodeURIComponent(location.origin + location.pathname) +
      '&state=' +
      state;
    location.assign(url);
  }

  // The return leg: GameNight sends the browser back with the token in the
  // fragment, which never reaches the server's log. Read it, scrub it from
  // the address bar, and hold it for the first identify.
  function consumeReturnHash() {
    const hash = location.hash || '';
    if (!/^#gn_(token|error)=/.test(hash)) return;
    const params = new URLSearchParams(hash.slice(1));
    history.replaceState(null, '', location.pathname + location.search);
    let stash = null;
    try {
      stash = JSON.parse(session.get(SSO_STATE_KEY) || 'null');
    } catch (_err) {
      stash = null;
    }
    session.set(SSO_STATE_KEY, null);
    if (params.get('gn_error')) return;
    const token = params.get('gn_token');
    if (!token || !stash || !stash.state || stash.state !== params.get('state')) {
      notice('Sign-in could not be verified. Try again from the Sign in with GameNight button.');
      return;
    }
    pendingGnToken = token;
    if (stash.code && !pendingJoin) pendingJoin = { code: stash.code };
  }

  function signOutOfGameNight() {
    closeLobbyMenu();
    // Told to the server first. Clearing the browser used to be the whole of
    // signing out, which left the token good here for another thirty days and
    // the device still on your own list of devices.
    if (socket && socket.connected) socket.emit('signOut');
    store.set(TOKEN_KEY, null);
    store.set(NAME_KEY, null);
    store.set(PROVIDER_KEY, null);
    location.reload();
  }

  // ── Your devices ─────────────────────────────────────────────────────────
  //
  // Where this account is signed in, and the way to sign one of them out from
  // another. The rows carry an id minted beside each device token, never the
  // token: this page holds one credential and has no business holding the
  // rest of them.

  let sessionRows = null;

  function openSessions() {
    closeLobbyMenu();
    sessionRows = null;
    showView('sessions');
    renderSessions();
    askForSessions();
  }

  function openMyGames() {
    closeLobbyMenu();
    myGames = null;
    showView('games');
    renderMyGames();
    askForMyGames();
  }

  function askForMyGames() {
    if (socket && socket.connected) socket.emit('listMyGames');
  }

  function onMyGames(data) {
    myGames = data && Array.isArray(data.games) ? data.games : [];
    renderMyGames();
  }

  function renderMyGames() {
    const list = $('myGamesList');
    const status = $('myGamesStatus');
    if (!list || !status) return;
    list.textContent = '';
    if (myGames === null) {
      status.textContent = 'Loading…';
      return;
    }
    if (!myGames.length) {
      status.textContent = '';
      const empty = document.createElement('div');
      empty.className = 'session-empty';
      empty.textContent = 'Nothing kept yet. A game you play is written down as it goes.';
      list.appendChild(empty);
      return;
    }
    const n = myGames.length;
    status.textContent = `${n} game${n === 1 ? '' : 's'}`;
    myGames.forEach((game) => list.appendChild(myGameRow(game)));
  }

  function myGameRow(game) {
    const row = document.createElement('div');
    row.className = 'session-row';

    const text = document.createElement('div');
    text.className = 'session-what';
    const name = document.createElement('div');
    name.className = 'session-name';
    name.textContent = game.name || 'A game';
    const when = document.createElement('div');
    when.className = 'session-when';
    when.textContent = [
      game.hands ? `${game.hands} hand${game.hands === 1 ? '' : 's'}` : null,
      game.endedAt ? fmtWhen(game.endedAt) : null,
    ]
      .filter(Boolean)
      .join(' · ');
    text.append(name, when);

    const actions = document.createElement('div');
    actions.className = 'session-actions';
    for (const [label, kind] of [
      ['Transcript', 'text'],
      ['Data', 'json'],
    ]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-secondary';
      btn.textContent = label;
      btn.addEventListener('click', () =>
        askForHandHistory(kind, { id: game.id, noteId: 'myGamesStatus' })
      );
      actions.appendChild(btn);
    }

    row.append(text, actions);
    return row;
  }

  function askForSessions() {
    if (socket && socket.connected) socket.emit('listSessions');
  }

  function onSessions(list) {
    sessionRows = Array.isArray(list) ? list : [];
    if (view === 'sessions') renderSessions();
  }

  // The device was signed out from somewhere else, or from here. Either way
  // this browser is holding a token that no longer means anything, so it is
  // dropped rather than left to fail on the next reconnect.
  function onSessionEnded(data) {
    // The same three keys signing out clears, because this is signing out:
    // the name came from the account, and leaving it in the box would greet
    // whoever picks the device up next as somebody they are not.
    store.set(TOKEN_KEY, null);
    store.set(NAME_KEY, null);
    store.set(PROVIDER_KEY, null);
    identity = null;
    window.__identity = null;
    const mine = !!(data && data.mine);
    store.set(
      NOTICE_KEY,
      mine
        ? 'Signed out on this device.'
        : 'This device was signed out from somewhere else you are signed in.'
    );
    location.reload();
  }

  function sessionAge(ms) {
    if (!ms) return 'never';
    const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (secs < 90) return 'just now';
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    return `${Math.round(hours / 24)} days ago`;
  }

  function renderSessions() {
    const list = $('sessionsList');
    const status = $('sessionsStatus');
    if (!list) return;
    list.textContent = '';
    if (sessionRows === null) {
      status.textContent = 'Looking…';
      return;
    }
    status.textContent = '';
    if (!sessionRows.length) {
      const empty = document.createElement('div');
      empty.className = 'session-empty';
      empty.textContent = 'Nowhere, which should not be possible from here.';
      list.appendChild(empty);
      return;
    }
    for (const row of sessionRows) {
      const item = document.createElement('div');
      item.className = 'session-row' + (row.current ? ' is-current' : '');

      const what = document.createElement('div');
      what.className = 'session-what';
      const name = document.createElement('div');
      name.className = 'session-name';
      name.textContent = row.label || 'A browser';
      what.appendChild(name);
      if (row.current) {
        const here = document.createElement('div');
        here.className = 'session-here';
        here.textContent = 'This device';
        what.appendChild(here);
      }
      const when = document.createElement('div');
      when.className = 'session-when';
      when.textContent = `Last here ${sessionAge(row.lastSeenAt)}`;
      what.appendChild(when);
      item.appendChild(what);

      const out = document.createElement('button');
      out.type = 'button';
      out.className = 'btn-secondary';
      out.textContent = row.current ? 'Sign out here' : 'Sign out';
      out.addEventListener('click', () => endSession(row));
      item.appendChild(out);

      list.appendChild(item);
    }
  }

  async function endSession(row) {
    if (!row || !row.id) return;
    // Signing out the device in your hand is the one that cannot be undone
    // from this screen, so it is asked about rather than done.
    if (row.current && typeof window.showConfirmDialog === 'function') {
      const ok = await window.showConfirmDialog({
        title: 'Sign out this device?',
        message: 'You go back to the lobby as a guest here. Your other devices stay signed in.',
        confirmLabel: 'Sign out',
        cancelLabel: 'Stay signed in',
      });
      if (!ok) return;
    }
    if (socket && socket.connected) socket.emit('endSession', { id: row.id });
  }

  const FAIL_TEXT = {
    expired: 'That sign-in took too long. Try again.',
    signed_out: 'Your GameNight sign-in has expired here. Sign in again.',
    not_configured: 'This server does not accept GameNight sign-in.',
  };

  function onIdentifyFailed(data) {
    const reason = data && data.reason ? data.reason : '';
    identity = null;
    window.__identity = null;
    store.set(TOKEN_KEY, null);
    store.set(PROVIDER_KEY, null);
    $('identityStatus').textContent = '';
    renderIdentityRow();
    notice(FAIL_TEXT[reason] || 'GameNight sign-in failed. Try again.');
  }

  // The dialog helpers are defined by app-init.js, which app.js runs after
  // every deferred script has loaded; this module's own init runs before
  // that. A notice raised during init waits a tick for them.
  function notice(message, tries = 0) {
    if (typeof window.showNoticeDialog === 'function') {
      window.showNoticeDialog({ title: 'Lobby', message, confirmLabel: 'OK' });
    } else if (tries < 20) {
      setTimeout(() => notice(message, tries + 1), 50);
    }
  }

  function setConnection(ok) {
    const banner = $('connStatus');
    if (banner) banner.classList.toggle('hidden', ok);
  }

  // ── Tournament events ────────────────────────────────────────────────────

  function onList(items) {
    list = Array.isArray(items) ? items : [];
    renderList();
    // The registry pushes the list on every create, join, start, finish and
    // cancel, so the admin's view follows it without a broadcast of its own.
    // Only while the Games page is the one showing: there is no point asking
    // for a list to redraw behind a tab nobody is looking at.
    if (view === 'admin' && adminTab === 'games') askForAdminGames();
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
    watching = !!info.watching;
    document.body.classList.toggle('watching', watching);
    window.__tournamentActive = true;
    window.__currentTournamentId = info.id;
    store.set(LAST_KEY, info.id);
    if (info.status === 'registering') showView('waiting');
    else enterTable();
  }

  // Asked to join an invite-only game. Not in it: no LAST_KEY, no
  // __tournamentActive. currentId is set so a cancel or a decline for this
  // game is recognised as ours.
  function onPending(info) {
    if (!info || !info.id) return;
    pendingRequest = info;
    currentId = info.id;
    window.__currentTournamentId = info.id;
    $('pdName').textContent = info.name || '';
    $('pdStatus').textContent = `Waiting for ${info.hostName || 'the host'} to let you in`;
    showView('pending');
  }

  const DECLINE_TEXT = {
    declined: 'The host did not let you in.',
    closed: 'Registration closed before the host let you in.',
    taken: 'Someone with your name is already in that tournament.',
    lapsed: 'Your request to join lapsed.',
  };

  function onDeclined(data) {
    if (!data || data.id !== currentId) return;
    const text =
      data.reason === 'cancelled'
        ? `"${data.name}" was cancelled before you were let in.`
        : DECLINE_TEXT[data.reason] || 'Your request to join ended.';
    returnToLobby(text);
  }

  function onState(state) {
    if (!state || state.id !== currentId) return;
    current = state;
    // The ladder rides only in the full state; a tick's push carries its
    // summary. Kept from the last full one so the room can draw it.
    if (state.structure && Array.isArray(state.structure.levels)) {
      currentStructure = {
        id: state.id,
        name: state.structure.name,
        levels: state.structure.levels,
      };
    }
    // Somebody new at the door while the host is at the table: the Info tab
    // is where the admit controls are, so light it up.
    if (state.isHost && Array.isArray(state.pending)) {
      let fresh = false;
      for (const row of state.pending) {
        if (!seenPending.has(row.uid)) {
          seenPending.add(row.uid);
          fresh = true;
        }
      }
      if (fresh && tableShowing() && window.SidePanel) SidePanel.notify('info');
    }
    if (window.TournamentField) TournamentField.render(state);
    if (state.status !== 'registering' && !tableShowing()) enterTable();
    if (view === 'waiting') renderWaiting();
  }

  // A notice is for news. Leaving is not news to the person who just pressed
  // Leave in a dialog that said the stack would sit out and they could rejoin -
  // and the game is on the lobby behind it with a Rejoin button, which is the
  // same fact where it can be acted on. Being removed is the other way round:
  // the host confirmed that one, so this is the only word the player gets.
  function onLeft(data) {
    if (data && data.id !== currentId) return;
    const reason = data ? data.reason : null;
    returnToLobby(reason === 'removed' ? 'The host removed you from the game.' : null);
  }

  function onCancelled(data) {
    if (!data || data.id !== currentId) {
      if (socket && socket.connected) socket.emit('listTournaments');
      return;
    }
    returnToLobby(`"${data.name}" was cancelled: ${data.reason}.`);
  }

  async function onEliminated(data) {
    if (!data) return;
    const prize = data.prize ? ` and won ${data.prize.toLocaleString()}` : '';
    const note = data.lateRegOpen ? ' Late registration is still open, so this may move.' : '';
    const title = `You finished #${data.place} of ${data.entrants}`;
    // The window is open: the same dialog offers the way back in. Re-enter
    // asks the server, which is the judge of whether it is still open.
    if (data.canReenter && typeof window.showConfirmDialog === 'function') {
      const cost = data.buyIn ? ` for a buy-in of ${fmtChips(data.buyIn)}` : '';
      const ok = await window.showConfirmDialog({
        title,
        message: `You are out${prize}.${note} Re-enter${cost}? Open through level ${data.reentryLevels}.`,
        confirmLabel: 'Re-enter',
        cancelLabel: 'Watch',
      });
      if (ok) reenter();
      return;
    }
    if (typeof window.showNoticeDialog === 'function') {
      window.showNoticeDialog({
        title,
        message: `You are out${prize}.${note} You can keep watching the table.`,
        confirmLabel: 'Watch',
      });
    }
  }

  // A fresh stack for another buy-in, while the window is open. The server
  // answers with the seat on the next push, or a notice saying why not.
  // tournamentId is passed by the lobby card, where this socket is not bound
  // to any game; from the table it is left off and the socket says which.
  function reenter(tournamentId) {
    if (!socket || !socket.connected) return;
    socket.emit('reenterTournament', tournamentId ? { tournamentId } : {});
  }

  function takeAddOn(tournamentId) {
    if (!socket || !socket.connected) return;
    socket.emit('takeAddOn', tournamentId ? { tournamentId } : {});
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
    ['home', 'create', 'waiting', 'pending', 'admin', 'sessions', 'games'].forEach((v) => {
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
    currentStructure = null;
    currentId = null;
    watching = false;
    document.body.classList.remove('watching');
    pendingRequest = null;
    seenPending.clear();
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
    for (const id of ['panelChatBody', 'panelLogBody']) {
      const pane = $(id);
      if (pane) pane.textContent = '';
    }
    const ticker = $('logLast');
    if (ticker) ticker.textContent = 'Waiting...';
    // The chat watermark goes with the log it was counting. Without this a
    // player who leaves and rejoins the same tournament is sent a backlog
    // whose every line is below the watermark left over from last time, and
    // renders nothing at all.
    if (window.TableChat) TableChat.reset();
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
    // The table was what held the reload back.
    if (staleAssets) {
      reloadForUpdate();
      return;
    }
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
      return (
        `Level ${t.level} · ${t.remaining} left` +
        (t.awayHeld ? ' · holding for you' : t.paused ? ' · paused' : '') +
        (t.lateRegOpen ? ' · late reg open' : '')
      );
    }
    return t.winner ? `Won by ${t.winner}` : 'Finished';
  }

  function tournamentCard(t) {
    const card = document.createElement('div');
    card.className = `t-card t-card-${t.status}`;
    card.dataset.id = t.id;

    const head = document.createElement('div');
    head.className = 't-card-head';
    const name = document.createElement('div');
    name.className = 't-card-name';
    name.textContent = t.name;
    const tag = document.createElement('span');
    tag.className = `room-status-tag room-status-tag-${t.status}`;
    tag.textContent = t.status;
    head.append(name, tag);
    // A stranger never sees an unlisted card, so this is for its own people:
    // a reminder of what the host made.
    if (t.visibility && t.visibility !== 'public') {
      const vis = document.createElement('span');
      vis.className = 't-card-vis';
      vis.textContent = t.visibility === 'invite' ? 'invite-only' : 'private';
      head.appendChild(vis);
    }

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
      t.structure || null,
      fmtLevel(t.levelDuration),
      t.lateRegLevels ? `late reg through L${t.lateRegLevels}` : 'no late reg',
      t.reentryLevels ? `re-entry through L${t.reentryLevels}` : null,
      t.addOn ? 'add-on' : null,
      t.buyIn ? `buy-in ${fmtChips(t.buyIn)}` : null,
    ].filter(Boolean);
    meta.textContent = parts.join(' · ');

    const btn = document.createElement('button');
    btn.className = 't-card-btn t-card-go';
    btn.type = 'button';
    // A tournament you left is still yours: your stack is at the table, and
    // the way back must not be the late-registration button, which closes.
    const mine = t.you && (t.you.registered || t.you.left);
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
    btn.addEventListener('click', () => requestJoin({ tournamentId: t.id }));

    // Anyone may watch a listed game while it runs: a second button beside
    // the way in, and it never takes a seat.
    const buttons = [btn];
    // A stack walked away from is still posting blinds with nobody behind it.
    // The way to stop that sits beside the way back to it.
    if (mine && t.you.left && t.status === 'running' && !t.you.eliminated) {
      const give = document.createElement('button');
      give.className = 't-card-btn t-card-forfeit';
      give.type = 'button';
      give.textContent = 'Forfeit';
      give.addEventListener('click', () => forfeit(t.id));
      buttons.push(give);
    }
    // A bust-out with the window still open, and the break's extra stack. Both
    // live in the Info tab at the table; a player in the lobby has no table,
    // and being in the lobby is not a decision about either one.
    if (t.you && t.you.canReenter) {
      const back = document.createElement('button');
      back.className = 't-card-btn t-card-reenter';
      back.type = 'button';
      back.textContent = 'Re-enter';
      back.addEventListener('click', () => reenterFromCard(t));
      buttons.push(back);
    }
    if (t.you && t.you.canAddOn) {
      const more = document.createElement('button');
      more.className = 't-card-btn t-card-addon';
      more.type = 'button';
      more.textContent = 'Add-on';
      more.addEventListener('click', () => addOnFromCard(t));
      buttons.push(more);
    }
    // The way to stop it, for whoever is entitled to. Every other host control
    // is at the table, which somebody who busted and came back to the lobby no
    // longer has - and the host title has usually moved on by then too.
    if (t.you && t.you.canEnd && t.status === 'running') {
      const end = document.createElement('button');
      end.className = 't-card-btn t-card-end';
      end.type = 'button';
      end.textContent = 'End';
      end.addEventListener('click', () => endTournament(t.id, t.name));
      buttons.push(end);
    }
    if (!mine && t.status === 'running') {
      const watch = document.createElement('button');
      watch.className = 't-card-btn t-card-watch';
      watch.type = 'button';
      watch.textContent = 'Watch';
      watch.addEventListener('click', () => requestWatch({ tournamentId: t.id }));
      buttons.push(watch);
    }

    // The card's grid keeps one cell for buttons, and there can be several,
    // so they go in a column of their own. Placing each at the cell stacked
    // them on top of one another instead.
    const actions = document.createElement('div');
    actions.className = 't-card-actions';
    actions.append(...buttons);
    card.append(head, status, meta, actions);
    return card;
  }

  // Rebuilding the list throws away every node in it, so a redraw that changes
  // nothing still takes the button under the cursor away and puts a new one
  // there. Skip the redraw when the list is the same as the one already drawn.
  let _drawnListSig = null;
  function renderList() {
    const sig = JSON.stringify(
      list.map((t) => [
        t.id,
        t.status,
        t.players,
        t.entrants,
        t.level,
        t.paused,
        t.startsAt,
        t.you,
        t.visibility,
        t.entries,
      ])
    );
    if (sig === _drawnListSig) return;
    _drawnListSig = sig;
    const buckets = { yours: [], registering: [], running: [], finished: [] };
    for (const t of list) {
      if (t.you && (t.you.registered || t.you.left)) buckets.yours.push(t);
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

  const VISIBILITY_HINT = {
    public: 'Listed in the lobby; anyone can join.',
    private: 'Unlisted; join by code or link.',
    invite: 'Unlisted; the link lets people ask, and you let them in.',
  };

  function setVisibility(vis) {
    document.querySelectorAll('#tVisibility button').forEach((b) => {
      b.classList.toggle('active', b.dataset.vis === vis);
    });
    $('tVisibilityHint').textContent = VISIBILITY_HINT[vis] || '';
  }

  function currentVisibility() {
    const active = document.querySelector('#tVisibility button.active');
    return active ? active.dataset.vis : 'private';
  }

  // ── Blind structure ──────────────────────────────────────────────────────
  // The presets come from the server once, the first time the form opens.
  // The editor's rows are the client's until Create, when the server clamps
  // them and runs what survives; a preset left alone goes up as its key.
  let presets = null;
  let presetsLoading = null;
  let levelsDraft = null; // the editor's rows, once it has been opened
  let structureEdited = false; // a hand edit makes the structure Custom
  let currentStructure = null; // the ladder of the game we are in, from the full state

  function loadPresets() {
    if (presets) return Promise.resolve(presets);
    if (presetsLoading) return presetsLoading;
    presetsLoading = fetch('/api/blind-structures')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        presets = data && Array.isArray(data.presets) ? data.presets : null;
        if (presets) refreshStructureHint();
        return presets;
      })
      .catch(() => null)
      .finally(() => {
        presetsLoading = null;
      });
    return presetsLoading;
  }

  function presetDef(key) {
    return presets ? presets.find((p) => p.key === key) || null : null;
  }

  function currentStructureKey() {
    const active = document.querySelector('#tStructure button.active');
    return active ? active.dataset.structure : 'standard';
  }

  function levelLengthSeconds() {
    return parseInt($('tLevelDuration').value, 10) || 300;
  }

  // A preset as rows, laid out the way the server lays it out: every row the
  // chosen level length, breaks included, antes from the level it says.
  function materializeRows(def, duration) {
    const rows = [];
    def.ladder.forEach(([sb, bb], i) => {
      const n = i + 1;
      rows.push({
        sb,
        bb,
        ante: def.anteFrom > 0 && n >= def.anteFrom ? bb : 0,
        duration,
        break: false,
      });
      if (def.breakAfter.includes(n) && n < def.ladder.length) {
        rows.push({ sb: 0, bb: 0, ante: 0, duration, break: true });
      }
    });
    return rows;
  }

  // Level numbers count levels of play; a break has none of its own.
  function summarizeRows(rows) {
    let n = 0;
    let anteFrom = 0;
    const breaks = [];
    for (const row of rows) {
      if (row.break) {
        if (n > 0 && !breaks.includes(n)) breaks.push(n);
        continue;
      }
      n++;
      if (!anteFrom && row.ante > 0) anteFrom = n;
    }
    return { levelCount: n, anteFrom, breaks };
  }

  // "18 levels · antes from level 6 · breaks after levels 6 and 12"
  function structureLine(s) {
    const parts = [`${s.levelCount} level${s.levelCount === 1 ? '' : 's'}`];
    parts.push(s.anteFrom ? `antes from level ${s.anteFrom}` : 'no antes');
    const breaks = Array.isArray(s.breaks) ? s.breaks : [];
    if (breaks.length === 1) parts.push(`a break after level ${breaks[0]}`);
    else if (breaks.length > 1) parts.push(`breaks after levels ${breaks.join(' and ')}`);
    return parts.join(' · ');
  }

  function fmtLength(seconds) {
    return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`;
  }

  function refreshStructureHint() {
    const hint = $('tStructureHint');
    const def = presetDef(currentStructureKey());
    if (structureEdited && levelsDraft) {
      const from = def ? def.name : 'a preset';
      hint.textContent = `Custom, edited from ${from} · ${structureLine(summarizeRows(levelsDraft))}`;
      refreshAddOnRow(levelsDraft);
      return;
    }
    if (!def) {
      hint.textContent = '';
      refreshAddOnRow(null);
      return;
    }
    const rows = materializeRows(def, levelLengthSeconds());
    hint.textContent = `${def.hint} ${structureLine(summarizeRows(rows))}`;
    refreshAddOnRow(rows);
  }

  // The add-on is offered at the first break, so a structure without one
  // cannot offer it: the row goes grey and says why. Until the presets have
  // arrived the rows are unknown, and the server clamps anyway.
  function refreshAddOnRow(rows) {
    const box = $('tAddOn');
    const note = $('tAddOnNote');
    if (!box || !note) return;
    const hasBreak = !rows || rows.some((r) => r.break);
    box.disabled = !hasBreak;
    box.closest('.check-row').classList.toggle('disabled', !hasBreak);
    note.textContent = hasBreak
      ? 'a starting stack for another buy-in'
      : 'needs a break in the structure';
  }

  function setStructure(key) {
    document.querySelectorAll('#tStructure button').forEach((b) => {
      b.classList.toggle('active', b.dataset.structure === key);
    });
    regenerateLevels();
  }

  // The preset or the level length changed: the grid is that preset again,
  // edits and all. GameNight's generator does the same, and says so.
  function regenerateLevels() {
    structureEdited = false;
    const def = presetDef(currentStructureKey());
    levelsDraft = def ? materializeRows(def, levelLengthSeconds()) : null;
    refreshStructureHint();
    if (!$('tLevels').classList.contains('hidden')) renderLevels();
  }

  function resetLevelsEditor() {
    $('tLevels').classList.add('hidden');
    $('btnEditLevels').textContent = 'Edit levels';
    $('btnEditLevels').setAttribute('aria-expanded', 'false');
    levelsDraft = null;
    structureEdited = false;
  }

  function toggleLevelsEditor() {
    const box = $('tLevels');
    const open = box.classList.contains('hidden');
    if (open && !levelsDraft) {
      const def = presetDef(currentStructureKey());
      if (!def) return; // no presets from the server: the key still goes up
      levelsDraft = materializeRows(def, levelLengthSeconds());
    }
    box.classList.toggle('hidden', !open);
    $('btnEditLevels').setAttribute('aria-expanded', String(open));
    $('btnEditLevels').textContent = open ? 'Hide levels' : 'Edit levels';
    if (open) renderLevels();
  }

  // The classic ladder, 1 / 1.5 / 2 / 2.5 / 3 / 4 / 5 / 6 / 8 per decade: the
  // rule nextLevel in blind-structures.js applies, here as well so adding a
  // level needs no round trip.
  const LADDER = [];
  for (let mag = 10; mag <= 10000000; mag *= 10) {
    for (const b of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8]) {
      const v = Math.round(b * mag);
      if (!LADDER.includes(v)) LADDER.push(v);
    }
  }
  LADDER.sort((a, b) => a - b);

  // A level to add after `rows`: the next rung up from the last level of
  // play, big blind double, the same length; it inherits whether that level
  // antes, never its amount.
  function nextLevel(rows, isBreak) {
    let ref = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!rows[i].break) {
        ref = rows[i];
        break;
      }
    }
    const duration = ref ? ref.duration : levelLengthSeconds();
    if (isBreak) return { sb: 0, bb: 0, ante: 0, duration, break: true };
    const target = (ref ? ref.sb || 10 : 10) * 1.5;
    const sb = ref ? LADDER.find((r) => r >= target - 0.001) || Math.round(target) : 10;
    return { sb, bb: sb * 2, ante: ref && ref.ante > 0 ? sb * 2 : 0, duration, break: false };
  }

  function numberInput(value, col, min) {
    const input = document.createElement('input');
    input.type = 'number';
    input.inputMode = 'decimal';
    input.min = String(min);
    input.dataset.col = col;
    input.value = String(value);
    input.setAttribute('aria-label', col);
    return input;
  }

  function renderLevels() {
    const body = $('tLevelsBody');
    body.textContent = '';
    if (!levelsDraft) return;
    let n = 0;
    levelsDraft.forEach((row, i) => {
      const tr = document.createElement('tr');
      tr.dataset.index = String(i);
      if (row.break) tr.classList.add('is-break');
      else n++;
      const num = document.createElement('td');
      num.className = 'num';
      num.textContent = row.break ? 'break' : String(n);
      tr.appendChild(num);
      for (const col of ['sb', 'bb', 'ante']) {
        const td = document.createElement('td');
        const input = numberInput(row.break ? '' : row[col], col, 0);
        input.disabled = row.break;
        td.appendChild(input);
        tr.appendChild(td);
      }
      const len = document.createElement('td');
      const minutes = numberInput(Math.round((row.duration / 60) * 100) / 100, 'minutes', 0.5);
      minutes.step = '0.5';
      len.appendChild(minutes);
      tr.appendChild(len);
      const brk = document.createElement('td');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.dataset.col = 'break';
      check.checked = row.break;
      check.setAttribute('aria-label', 'Break');
      brk.appendChild(check);
      tr.appendChild(brk);
      const rm = document.createElement('td');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'row-remove';
      btn.textContent = '×';
      btn.setAttribute('aria-label', 'Remove level');
      btn.dataset.remove = String(i);
      rm.appendChild(btn);
      tr.appendChild(rm);
      body.appendChild(tr);
    });
  }

  // Every edit lands in the draft at once, so the hint and the payload read
  // the grid as it stands. Numbers on input; the break box on change.
  function onLevelsEdit(e) {
    const el = e.target;
    const col = el.dataset ? el.dataset.col : null;
    if (!col || !levelsDraft) return;
    if ((col === 'break') !== (e.type === 'change')) return;
    const tr = el.closest('tr');
    const index = tr ? Number(tr.dataset.index) : -1;
    const row = levelsDraft[index];
    if (!row) return;
    structureEdited = true;
    if (col === 'break') {
      row.break = el.checked;
      if (row.break) {
        row.sb = 0;
        row.bb = 0;
        row.ante = 0;
      } else if (!row.sb) {
        Object.assign(row, nextLevel(levelsDraft.slice(0, index), false), {
          duration: row.duration,
        });
      }
      renderLevels();
      refreshStructureHint();
      return;
    }
    const v = parseFloat(el.value);
    if (col === 'minutes') {
      if (Number.isFinite(v) && v > 0) row.duration = Math.round(v * 60);
    } else {
      row[col] = Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
    }
    refreshStructureHint();
  }

  function onLevelsClick(e) {
    const btn = e.target.closest('button[data-remove]');
    if (!btn || !levelsDraft) return;
    levelsDraft.splice(Number(btn.dataset.remove), 1);
    structureEdited = true;
    renderLevels();
    refreshStructureHint();
  }

  function addLevel(isBreak) {
    if (!levelsDraft) return;
    levelsDraft.push(nextLevel(levelsDraft, isBreak));
    structureEdited = true;
    renderLevels();
    refreshStructureHint();
    const rows = $('tLevelsBody').querySelectorAll('tr');
    const last = rows[rows.length - 1];
    const first = last && last.querySelector('input:not(:disabled)');
    if (first) first.focus();
  }

  // What goes up with Create: the preset's key, or the host's own rows.
  function structurePayload() {
    if (structureEdited && levelsDraft) {
      return { name: 'Custom', levels: levelsDraft.map((r) => ({ ...r })) };
    }
    return currentStructureKey();
  }

  // The ladder as lines, for the waiting room and the Info tab. `current`
  // marks a row: `{ number, onBreak }` from the field, or null before start.
  function structureRows(levels, current) {
    const rows = [];
    let n = 0;
    (levels || []).forEach((row) => {
      if (!row.break) n++;
      const line = document.createElement('div');
      line.className = 'structure-row' + (row.break ? ' is-break' : '');
      const isCurrent =
        !!current && n === current.number && (row.break ? !!current.onBreak : !current.onBreak);
      if (isCurrent) line.classList.add('current');
      const num = document.createElement('span');
      num.className = 's-num';
      num.textContent = row.break ? '' : `L${n}`;
      const blinds = document.createElement('span');
      blinds.className = 's-blinds';
      blinds.textContent = row.break ? 'Break' : `${row.sb}/${row.bb}`;
      const ante = document.createElement('span');
      ante.className = 's-ante';
      ante.textContent = row.ante ? `ante ${row.ante}` : '';
      const len = document.createElement('span');
      len.className = 's-len';
      len.textContent = fmtLength(row.duration);
      line.append(num, blinds, ante, len);
      rows.push(line);
    });
    return rows;
  }

  function renderStructure(t) {
    const box = $('wrStructure');
    const s = currentStructure && currentStructure.id === t.id ? currentStructure : null;
    box.classList.toggle('hidden', !s);
    if (!s) return;
    const list = $('wrStructureList');
    list.textContent = '';
    const current = t.status === 'running' ? { number: t.level, onBreak: !!t.onBreak } : null;
    structureRows(s.levels, current).forEach((row) => list.appendChild(row));
  }

  function openCreate() {
    if (!$('tName').value) $('tName').value = 'Game Night';
    setVisibility('private');
    resetLevelsEditor();
    setStructure('standard');
    loadPresets();
    setQuick(10);
    document.querySelectorAll('#tStartQuick button').forEach((b) => b.classList.remove('active'));
    showView('create');
    $('tName').focus();
  }

  function submitCreate() {
    if (!nameValue() && !isGameNight()) return needName();
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
      reentryLevels: parseInt($('tReentryLevels').value, 10),
      addOn: $('tAddOn').checked && !$('tAddOn').disabled,
      buyIn: Math.max(0, Math.min(10000, parseInt($('tBuyIn').value, 10) || 0)),
      bots: $('tBots').checked ? parseInt($('tBotCount').value, 10) || 5 : 0,
      visibility: currentVisibility(),
      structure: structurePayload(),
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
    return requestJoin({ code: clean });
  }

  // The list never carries a code - it is public - so a card joins by id.
  function requestJoin(payload) {
    if (!nameValue() && !isGameNight() && !pendingGnToken) {
      pendingJoin = payload;
      return needName();
    }
    if (identity && socket && socket.connected) {
      socket.emit('joinTournament', payload);
    } else {
      pendingJoin = payload;
      identify();
    }
    return true;
  }

  // The rail: a name is needed here too, since a watcher talks.
  function requestWatch(payload) {
    if (!nameValue() && !isGameNight() && !pendingGnToken) {
      pendingWatch = payload;
      return needName();
    }
    if (identity && socket && socket.connected) {
      socket.emit('watchTournament', payload);
    } else {
      pendingWatch = payload;
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
    if (row.isBot) {
      const badge = document.createElement('span');
      badge.className = 'wr-badge';
      badge.textContent = 'bot';
      line.appendChild(badge);
    }
    if (row.provider === 'gamenight') {
      const badge = document.createElement('span');
      badge.className = 'wr-badge wr-badge-gn';
      badge.textContent = 'GameNight';
      badge.title = 'Signed in with a GameNight account';
      line.appendChild(badge);
    }
    // The host's moderation, and only the host's: the server checks this again
    // and this button is merely how it gets asked.
    if (current && current.isHost && !row.isHost && !row.isBot) {
      const mute = document.createElement('button');
      mute.type = 'button';
      mute.className = 'wr-mute' + (row.muted ? ' on' : '');
      mute.textContent = row.muted ? 'Unmute' : 'Mute';
      mute.title = row.muted ? `Let ${row.name} chat again` : `Stop ${row.name} chatting`;
      mute.addEventListener('click', () => {
        if (socket && socket.connected) {
          socket.emit('muteChat', { uid: row.uid, muted: !row.muted });
        }
      });
      line.appendChild(mute);
    }
    if (row.place) {
      const badge = document.createElement('span');
      badge.className = 'wr-badge';
      badge.textContent = `#${row.place}`;
      line.appendChild(badge);
    }
    return line;
  }

  const VISIBILITY_LINE = {
    public: 'listed in the lobby',
    private: 'private, join by code or link',
    invite: 'invite-only, the host lets people in',
  };

  function renderPendingRow(row) {
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
    if (row.provider === 'gamenight') {
      const badge = document.createElement('span');
      badge.className = 'wr-badge wr-badge-gn';
      badge.textContent = 'GameNight';
      line.appendChild(badge);
    }
    // The server checks the host again; these are merely how it gets asked.
    const admit = document.createElement('button');
    admit.type = 'button';
    admit.className = 'wr-admit';
    admit.textContent = 'Let in';
    admit.addEventListener('click', () => {
      if (socket && socket.connected) socket.emit('admitPlayer', { uid: row.uid });
    });
    const decline = document.createElement('button');
    decline.type = 'button';
    decline.className = 'wr-decline';
    decline.textContent = 'Turn away';
    decline.addEventListener('click', () => {
      if (socket && socket.connected) socket.emit('declinePlayer', { uid: row.uid });
    });
    line.append(admit, decline);
    return line;
  }

  function renderPendingList(t) {
    const block = $('wrPending');
    const list = $('wrPendingList');
    const rows = t.isHost && Array.isArray(t.pending) ? t.pending : [];
    block.classList.toggle('hidden', rows.length === 0);
    list.textContent = '';
    rows.forEach((row) => list.appendChild(renderPendingRow(row)));
  }

  function renderWaiting() {
    const t = current;
    if (!t) return;
    $('wrName').textContent = t.name;
    // A watcher is never shown the join code; the rail code is theirs to share.
    $('wrCodeLabel').textContent = watching ? 'Rail' : 'Code';
    $('wrCode').textContent = watching ? t.rail || '' : t.code || '';
    $('btnCopyRail').classList.toggle('hidden', watching || !t.rail);
    $('wrStatus').textContent = waitingStatus(t);
    const roster = $('wrRoster');
    roster.textContent = '';
    (t.roster || []).forEach((row) => roster.appendChild(renderRosterRow(row)));
    renderPendingList(t);
    const s = t.settings || {};
    const hint = $('wrCodeHint');
    const invite = s.visibility === 'invite';
    hint.textContent = invite ? 'Anyone with this link asks to join; you let them in below.' : '';
    hint.classList.toggle('hidden', !(invite && t.isHost));
    const parts = [
      VISIBILITY_LINE[s.visibility] || null,
      `${s.tableSize}-max tables`,
      `${fmtChips(s.startChips)} starting stack`,
      s.structure && s.structure.name
        ? `${s.structure.name} · ${structureLine(s.structure)}`
        : null,
      fmtLevel(s.levelDuration),
      s.lateRegLevels
        ? `late registration through level ${s.lateRegLevels}`
        : 'no late registration',
      s.reentryLevels ? `re-entry through level ${s.reentryLevels}` : 'no re-entry',
      s.addOn ? 'add-on at the first break' : null,
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
    renderStructure(t);
    const host = $('wrHostControls');
    host.classList.toggle('hidden', !(t.isHost && t.status === 'registering'));
    $('btnStartNow').disabled = (t.entrants || 0) < 2;
    $('btnUnregister').classList.toggle('hidden', t.status !== 'registering' || watching);
    $('btnLeaveTournament').textContent = watching ? 'Stop watching' : 'Leave';
    $('btnLeaveTournament').classList.toggle('hidden', t.status === 'registering' && !watching);
    $('btnEnterTable').classList.toggle('hidden', t.status === 'registering');
  }

  function waitingStatus(t) {
    const prefix = watching ? 'Watching · ' : '';
    if (t.status === 'registering') {
      const wait = t.startsAt - Date.now();
      if (wait > 0) return `${prefix}Starts in ${fmtCountdown(wait)}`;
      return prefix + (t.waitingReason || 'Starting…');
    }
    if (t.status === 'running') {
      return (
        `${prefix}Running · level ${t.level}` +
        (t.awayHeld ? ' · holding until somebody is back' : t.paused ? ' · paused' : '') +
        (t.lateRegOpen ? ' · late registration open' : '')
      );
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

  function railUrl() {
    return current && current.rail
      ? `${location.origin}${location.pathname}?w=${current.rail}`
      : '';
  }

  // The link that brings a watcher. Anyone in the game may hand it out, and
  // so may a watcher: it is a way to look, never a way in.
  function copyRail(button = $('btnCopyRail')) {
    const url = railUrl();
    if (!url || !button) return;
    const label = button.textContent;
    const done = () => {
      button.textContent = 'Copied';
      setTimeout(() => (button.textContent = label), 1500);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url).then(done, () => fallbackCopy(url, done));
    } else {
      fallbackCopy(url, done);
    }
  }

  function copyLink() {
    if (!current) return;
    // A watcher's Copy link is the rail link: the join code is not theirs.
    const url = watching ? railUrl() : `${location.origin}${location.pathname}?t=${current.code}`;
    if (!url) return;
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
  // stack sitting out) once running.
  async function leave() {
    if (!socket || !currentId) return;
    if (watching) {
      socket.emit('stopWatching');
      return;
    }
    if (current && current.status === 'registering') {
      socket.emit('unregisterTournament');
      return;
    }
    let ok = true;
    if (typeof window.showConfirmDialog === 'function') {
      ok = await window.showConfirmDialog({
        title: 'Leave the tournament?',
        message: 'Your stack stays at the table, sitting out. You can rejoin from the lobby.',
        confirmLabel: 'Leave',
        cancelLabel: 'Stay',
      });
    }
    if (ok) socket.emit('leaveTournament');
  }

  // The seat given up rather than left behind. Leaving parks the stack and it
  // blinds down for as long as the game runs; this takes it off the table and
  // writes the finishing place down. Asked for once, because the way back in
  // closes with it - a forfeit that could be re-entered would be a button for
  // turning a short stack into a fresh one.
  async function forfeit(tournamentId) {
    const id = tournamentId || currentId;
    if (!socket || !id) return;
    let ok = true;
    if (typeof window.showConfirmDialog === 'function') {
      ok = await window.showConfirmDialog({
        title: 'Forfeit the tournament?',
        message:
          'Your chips leave play and you finish where you stand now, paid if that place pays. ' +
          'You can watch the rest, but you cannot come back in, and re-entry will not open to you.',
        confirmLabel: 'Forfeit',
        cancelLabel: 'Keep playing',
      });
    }
    if (ok) socket.emit('forfeitTournament', { tournamentId: id });
  }

  // Calling the whole game off. The host has this at the table in the Info
  // tab; this is the same thing from the lobby, for a host who is not at one -
  // busted out, or simply looking at the list.
  async function endTournament(tournamentId, name) {
    const id = tournamentId || currentId;
    if (!socket || !id) return;
    let ok = true;
    if (typeof window.showConfirmDialog === 'function') {
      ok = await window.showConfirmDialog({
        title: name ? `End "${name}"?` : 'End this tournament?',
        message:
          'It stops now, with no winner and no payouts, and everyone still in it is sent back ' +
          'to the lobby. There is no way to restart it.',
        confirmLabel: 'End it',
        cancelLabel: 'Keep it',
      });
    }
    if (ok) socket.emit('cancelTournament', { tournamentId: id });
  }

  // The two self-service offers, from the lobby. Both are at the table too, in
  // the Info tab; these are the same offers reaching a player who is not at
  // one - busted and back in the lobby with the window still open, or out of
  // the room when the break started.
  async function reenterFromCard(t) {
    const cost = t.buyIn ? ` for a buy-in of ${fmtChips(t.buyIn)}` : '';
    let ok = true;
    if (typeof window.showConfirmDialog === 'function') {
      ok = await window.showConfirmDialog({
        title: 'Buy back in?',
        message:
          `A fresh starting stack${cost}, at the table with the fewest players, from its next ` +
          'deal. Your bust-out is struck from the standings.',
        confirmLabel: 'Re-enter',
        cancelLabel: 'Stay out',
      });
    }
    if (ok) reenter(t.id);
  }

  async function addOnFromCard(t) {
    const cost = t.buyIn ? ` for another buy-in of ${fmtChips(t.buyIn)}` : '';
    let ok = true;
    if (typeof window.showConfirmDialog === 'function') {
      ok = await window.showConfirmDialog({
        title: 'Take the add-on?',
        message: `A starting stack more on top of what you have${cost}, once, before the break ends.`,
        confirmLabel: 'Take it',
        cancelLabel: 'No thanks',
      });
    }
    if (ok) takeAddOn(t.id);
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  function init() {
    $('btnCreateTournament').addEventListener('click', openCreate);
    $('btnCreateCancel').addEventListener('click', () => showView('home'));
    $('updateStatus').addEventListener('click', () => reloadForUpdate());
    $('btnCreateSubmit').addEventListener('click', submitCreate);
    $('joinCodeForm').addEventListener('submit', (e) => {
      e.preventDefault();
      if (joinCode($('joinCodeInput').value)) $('joinCodeInput').value = '';
    });
    document.querySelectorAll('#tStartQuick button').forEach((b) => {
      b.addEventListener('click', () => setQuick(Number(b.dataset.min)));
    });
    document.querySelectorAll('#tVisibility button').forEach((b) => {
      b.addEventListener('click', () => setVisibility(b.dataset.vis));
    });
    document.querySelectorAll('#tStructure button').forEach((b) => {
      b.addEventListener('click', () => setStructure(b.dataset.structure));
    });
    $('tLevelDuration').addEventListener('change', regenerateLevels);
    $('btnEditLevels').addEventListener('click', toggleLevelsEditor);
    $('btnAddLevel').addEventListener('click', () => addLevel(false));
    $('btnAddBreak').addEventListener('click', () => addLevel(true));
    $('tLevelsBody').addEventListener('input', onLevelsEdit);
    $('tLevelsBody').addEventListener('change', onLevelsEdit);
    $('tLevelsBody').addEventListener('click', onLevelsClick);
    $('btnCancelRequest').addEventListener('click', () => {
      if (socket && socket.connected) socket.emit('cancelRequest');
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
    $('btnCopyRail').addEventListener('click', () => copyRail());
    $('btnGameNight').addEventListener('click', startGameNightLogin);
    $('btnGameNightSignOut').addEventListener('click', signOutOfGameNight);
    $('btnSessions').addEventListener('click', openSessions);
    $('btnMyGames').addEventListener('click', openMyGames);
    $('btnMyGamesRefresh').addEventListener('click', askForMyGames);
    $('btnMyGamesBack').addEventListener('click', () => showView('home'));
    // Whatever the page that reloaded this one had to say.
    const waiting = store.get(NOTICE_KEY);
    if (waiting) {
      store.set(NOTICE_KEY, null);
      notice(waiting);
    }
    $('btnSessionsRefresh').addEventListener('click', askForSessions);
    $('btnSessionsBack').addEventListener('click', () => showView('home'));
    $('lobbyMenuToggle').addEventListener('click', toggleLobbyMenu);
    // Anywhere else closes it, the way the table's does.
    document.addEventListener('click', (e) => {
      if (!lobbyMenuOpen()) return;
      if ($('lobbyMenuShell').contains(e.target)) return;
      closeLobbyMenu();
    });
    $('btnLobbyAdmin').addEventListener('click', openAdmin);
    $('btnAdminUnlock').addEventListener('click', openAdmin);
    $('btnAdminPair').addEventListener('click', pairGameNight);
    $('btnAdminRefresh').addEventListener('click', refreshGameNightKey);
    $('btnAdminUnpair').addEventListener('click', unpairGameNight);
    $('btnAdminBack').addEventListener('click', () => showView('home'));
    $('btnAdminGamesRefresh').addEventListener('click', askForAdminGames);
    $('btnAdminLogRefresh').addEventListener('click', () => askForAdminLog({ fresh: true }));
    $('btnAdminLogMore').addEventListener('click', () => askForAdminLog());
    adminTabButtons().forEach((tab) =>
      tab.addEventListener('click', () => selectAdminTab(tab.dataset.adminTab))
    );
    const adminStrip = document.querySelector('#lobbyAdmin .admin-tabs');
    if (adminStrip) adminStrip.addEventListener('keydown', onAdminTabKey);
    $('btnAdminSetPassword').addEventListener('click', setAdminPassword);
    $('adminPwConfirm').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        setAdminPassword();
      }
    });
    $('adminGnUrl').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        pairGameNight();
      }
    });

    // Name and avatar edits re-identify (the server updates the identity).
    let renameTimer = null;
    const reidentify = () => {
      clearTimeout(renameTimer);
      renameTimer = setTimeout(() => {
        if (identity && (isGameNight() || nameValue())) identify();
      }, 400);
    };
    $('playerName').addEventListener('blur', () => {
      if (isGameNight()) return;
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
      const code = fromLink.trim().toUpperCase();
      pendingJoin = { code };
      $('joinCodeInput').value = code;
    }
    // A rail link arms a watch the way a join link arms a join.
    const railLink = params.get('w');
    if (railLink && !fromLink) pendingWatch = { rail: railLink.trim().toUpperCase() };
    const savedName = store.get(NAME_KEY);
    if (savedName && !$('playerName').value) $('playerName').value = savedName;
    consumeReturnHash();

    setInterval(tickCountdowns, 1000);
    // The Games page is a live view: "Dealing" and "last hand 4 minutes ago"
    // are worth nothing if they only move when somebody creates or cancels a
    // game, which is all the registry's list push covers. Only while that page
    // is the one showing - there is nothing to ask for behind a closed tab.
    setInterval(() => {
      if (view !== 'admin') return;
      if (adminTab === 'games') askForAdminGames();
      // The Log follows the newest page only, and only while the reader has
      // not paged back into older rows.
      else if (adminTab === 'log' && !adminLogPaged) askForAdminLog({ fresh: true, quiet: true });
    }, ADMIN_POLL_MS);
    ensureSocket();
    if ((fromLink || railLink) && !nameValue() && !pendingGnToken) needName();
  }

  window.Lobby = {
    identify,
    lobbyMenuOpen,
    closeLobbyMenu,
    onServerInfo,
    onAdminStatus,
    onAdminLocked,
    onAdminGameNight,
    onAdminTournaments,
    onAdminLogRows,
    onAdminPasswordResult,
    onIdentified,
    onIdentifyFailed,
    onSessionReplaced,
    onSessions,
    onMyGames,
    onSessionEnded,
    onList,
    onJoined,
    onPending,
    onDeclined,
    pendingRow: renderPendingRow,
    onState,
    onLeft,
    onCancelled,
    onEliminated,
    forfeit,
    endTournament,
    reenter,
    takeAddOn,
    onError,
    setConnection,
    enterTable,
    returnToLobby,
    leave,
    joinCode,
    showView,
    current: () => current,
    structure: () => currentStructure,
    structureRows,
    watching: () => watching,
    copyRail,
    railUrl,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

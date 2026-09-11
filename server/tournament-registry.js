// tournament-registry.js - the life of a tournament, from creation to teardown.
//
// Everything about a tournament that is not the poker itself lives here:
// who registered, who is connected, when it starts, who hosts, what happens
// when the last human drops, and when a finished one is forgotten. The
// director owns the tables and the chips; the socket handlers are a thin
// shim over this module; and everything here is keyed by identity uid.
//
// Time is one sweep on a short interval rather than a timeout per entry. A
// sweep survives clock jumps, restores trivially after a restart (an overdue
// entry simply starts on the first pass), and the reaper and host transfer
// need the same loop anyway. `now` and `timers` are injectable for tests.

const { TournamentDirector } = require('../director');
const { createChatRooms } = require('./chat-rooms');
const reactions = require('./reactions');

// Who may see a tournament and who may walk in. Chosen once at creation.
const VISIBILITIES = ['public', 'private', 'invite'];
// How many people may wait on one invite-only game at once. A bound rather
// than a rule: nobody runs a home game with fifty at the door.
const MAX_PENDING = 50;
const random = require('../random');

const TICK_MS = 1200;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const START_CHIPS = [1000, 2000, 5000, 10000];
// Seats the server plays, for filling a table to try something out. Named for
// what they are: a donkey calls too much and raises for no reason, which is the
// whole behaviour. Five, because that plus a host is a table worth looking at.
const DEMO_BOT_NAMES = ['Burro', 'Jenny', 'Moke', 'Neddy', 'Hinny'];
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function createTournamentRegistry(deps = {}) {
  const {
    io,
    identity,
    sanitizeName = (v, max = 16) =>
      String(v || '')
        .trim()
        .slice(0, max),
    normalizeNameKey = (v) =>
      String(v || '')
        .trim()
        .toLowerCase(),
    maxTournaments = 8,
    tableOptions = {},
    handPauseMs = 0,
    // Every connected socket, for the personalised tournament list. Injectable
    // so the registry tests can drive it without a real socket.io server.
    connectedSockets = () => (io && io.sockets ? io.sockets.sockets.values() : []),
    // One socket by id, for admitting somebody who asked to join: their
    // request holds the id, and binding wants the socket. Injectable for the
    // same reason as connectedSockets.
    socketById = (id) => (io && io.sockets ? io.sockets.sockets.get(id) || null : null),
    // How long a request to join an invite-only game outlives its socket. A
    // phone that locks for ten seconds should not lose its place at the door.
    pendingGraceMs = 60 * 1000,
    finishedTtlMs = 10 * 60 * 1000,
    abandonGraceMs = 2 * 60 * 1000,
    hostTransferGraceMs = 2 * 60 * 1000,
    overdueAbandonMs = 30 * 60 * 1000,
    sweepMs = 1000,
    now = () => Date.now(),
    store = null,
    // Chat. Disabled means the events are not registered at all and no buffer
    // is ever allocated, rather than a box that is hidden client-side.
    chatEnabled = true,
    chatStore = null,
    chatHistory = 100,
    chatMaxLength = 200,
    chatRatePerWindow = 4,
    chatRateWindowMs = 10 * 1000,
    // Reactions ride chat's rooms and chat's mute, with a limit of their own.
    reactionsEnabled = true,
    reactionRatePerWindow = reactions.DEFAULT_RATE,
    reactionRateWindowMs = reactions.DEFAULT_WINDOW_MS,
  } = deps;
  const timers = deps.timers || {
    setInterval: (...a) => setInterval(...a),
    clearInterval: (...a) => clearInterval(...a),
    setTimeout: (...a) => setTimeout(...a),
    clearTimeout: (...a) => clearTimeout(...a),
  };

  // id -> entry
  // How many times a stored field may be seated again without a hand
  // completing before it is left alone. Three is enough to ride out a restart
  // that had nothing to do with the field, and few enough that a field which
  // kills the process stops doing so within a few seconds.
  const MAX_RESTORE_ATTEMPTS = 3;

  // How long a restored field has to keep the process alive before it counts as
  // viable. The first version of this guard cleared the counter as soon as a
  // hand finished, which sounds like the same thing and is not: a field big
  // enough to exhaust the heap still deals hundreds of hands across twenty odd
  // tables before it does, so the counter reset every boot and the loop it was
  // meant to break ran nine times unimpeded. Surviving is the signal, not
  // playing.
  const RESTORE_STABLE_MS = 2 * 60 * 1000;

  // How long a burst of lobby-list changes is gathered up before one push goes
  // out. Short enough that the list still feels live, long enough that two
  // hundred people joining is one redraw and not two hundred.
  const LIST_COALESCE_MS = 250;

  // id -> entry
  const tournaments = new Map();
  const chat = createChatRooms({
    historyLimit: chatHistory,
    maxLength: chatMaxLength,
    ratePerWindow: chatRatePerWindow,
    rateWindowMs: chatRateWindowMs,
    now,
  });
  let sweepTimer = null;
  let sweeps = 0;
  let persistTimer = null;

  // ── Persistence ──────────────────────────────────────────────────────────
  // Registering tournaments are written on every change (debounced); once one
  // starts it drops out of the file, because a running one cannot be rebuilt.

  function serialize(entry) {
    return {
      id: entry.id,
      code: entry.code,
      name: entry.name,
      createdAt: entry.createdAt,
      startsAt: entry.startsAt,
      hostUid: entry.hostUid,
      settings: { ...entry.settings },
      entrants: entry.director.entrants.map((e) => ({
        uid: e.uid,
        name: e.name,
        avatar: e.avatar || null,
        provider: e.provider || 'guest',
        isBot: !!e.isBot,
      })),
      registrations: [...entry.registrations.entries()].map(([uid, r]) => ({
        uid,
        joinedAt: r.joinedAt,
      })),
      mutedUids: [...entry.mutedUids],
      status: entry.status,
      // How many times this field has been seated again without getting a hand
      // out. See the guard in restore().
      restoreCount: entry.restoreCount || 0,
      // Written down so the next restart holds it too, rather than reading it
      // back as a tournament that is merely waiting for its start time.
      held: !!entry.held,
      // A running tournament carries the field as it stood between hands, so a
      // restart seats everyone again instead of the tournament ceasing to
      // exist. Registrations alone are enough for one that has not dealt. A
      // held field is carried untouched: those chips are the record of what
      // happened, and keeping them is the whole point of holding it.
      field: entry.status === 'running' ? entry.director.snapshot() : entry.heldField || null,
    };
  }

  function flush() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    // Chat has a debounce of its own, and flush means everything is on disk
    // now - a shutdown that wrote the field but not the last thing anyone said
    // would be a strange thing to have built on purpose.
    if (chatStore) chatStore.flush();
    if (!store) return;
    const list = [...tournaments.values()]
      .filter((e) => e.status === 'registering' || e.status === 'running')
      .map(serialize);
    try {
      store.save(list);
    } catch (_err) {
      /* the next change tries again */
    }
  }

  function persist() {
    if (!store || persistTimer) return;
    persistTimer = setTimeout(flush, 250);
    if (persistTimer.unref) persistTimer.unref();
  }

  // ── Small helpers ────────────────────────────────────────────────────────

  function makeCode() {
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = '';
      for (let i = 0; i < 5; i++) code += CODE_ALPHABET[random.randomInt(CODE_ALPHABET.length)];
      if (![...tournaments.values()].some((t) => t.code === code)) return code;
    }
    return random.randomId('').slice(0, 5).toUpperCase();
  }

  function byCode(code) {
    const key = String(code || '')
      .trim()
      .toUpperCase();
    return [...tournaments.values()].find((t) => t.code === key) || null;
  }

  function connectedHumans(entry) {
    return [...entry.registrations.values()].filter((r) => r.socketId).length;
  }

  function hostName(entry) {
    const who = identity.get(entry.hostUid);
    return who ? who.name : null;
  }

  function emitTo(entry, uid, event, payload) {
    const reg = entry.registrations.get(uid);
    if (reg && reg.socketId) io.to(reg.socketId).emit(event, payload);
  }

  function emitAll(entry, event, payload) {
    for (const reg of entry.registrations.values()) {
      if (reg.socketId) io.to(reg.socketId).emit(event, payload);
    }
  }

  // The list is personalised: a card has to know whether this tournament is
  // already yours, so it can offer Open or Rejoin instead of a Join button
  // that late registration will close. io.emit cannot do that, so the rows are
  // built per socket. A home game has a handful of them.
  // The lobby list is rebuilt from scratch by every client that receives it, so
  // a burst of joins used to mean a burst of full redraws: two hundred people
  // arriving redrew the list two hundred times, and the buttons in it flickered
  // and would not take a click because they were being replaced underneath the
  // cursor. Bursts are coalesced into one push.
  let listTimer = null;
  function emitList() {
    if (listTimer) return;
    listTimer = timers.setTimeout(() => {
      listTimer = null;
      emitListNow();
    }, LIST_COALESCE_MS);
    if (listTimer && listTimer.unref) listTimer.unref();
  }

  function emitListNow() {
    // Every card except the "you" corner is the same for everyone, so it is
    // built once for the whole broadcast rather than once per socket. With two
    // hundred people connected the difference is two hundred summaries against
    // forty thousand.
    const shared = [...tournaments.values()].map((entry) => ({ entry, card: summarize(entry) }));
    for (const socket of connectedSockets()) {
      socket.emit('tournamentList', listFor(socket.data && socket.data.uid, shared));
    }
  }

  // Everyone connected gets the state from their own point of view. The
  // legacy `tournamentField` event carries the same payload until the client
  // has moved to `tournamentState`.
  // A cheap stand-in for "has the roster changed", over the fields that can:
  // stacks, seats, finishing places, sitting out, and who is connected.
  function rosterSignature(roster) {
    let sig = '';
    for (const r of roster) {
      sig += `${r.uid}:${r.chips}:${r.table}:${r.place}:${r.autoPlay ? 1 : 0}:${r.connected ? 1 : 0}:${r.muted ? 1 : 0}|`;
    }
    return sig;
  }

  function emitState(entry) {
    // The field summary is built once for the whole broadcast; only the "you"
    // corner is per viewer.
    const shared = sharedState(entry);
    const ids = [];
    for (const [uid, reg] of entry.registrations) {
      if (!reg.socketId) continue;
      ids.push(reg.socketId);
      io.to(reg.socketId).emit(
        'tournamentState',
        stateFor(entry, uid, shared, { includeRoster: false })
      );
    }
    if (!ids.length) return;

    // The roster is one list, the same for everyone, and at two hundred players
    // it is 96% of what a state push weighs. Sending it inside each personal
    // payload meant serialising the same 25 KB once per recipient, every tick,
    // for as long as the tournament ran. It goes out as a single broadcast
    // instead — encoded once for the whole set of sockets — and only when it
    // has actually changed.
    const sig = rosterSignature(shared.roster);
    if (sig === entry._rosterSig) return;
    entry._rosterSig = sig;
    io.to(ids).emit('tournamentRoster', { id: entry.id, roster: shared.roster });
  }

  function requireHost(entry, uid) {
    return !!uid && uid === entry.hostUid;
  }

  // ── Views ────────────────────────────────────────────────────────────────

  function summarize(entry) {
    const d = entry.director;
    const humans = entry.registrations.size;
    const total = d.entrants.length;
    // No `code` here. The card goes to everyone connected and to anyone who
    // asks GET /api/tournaments, and the code is the way in. A player who is
    // in gets it from tournamentState; a card joins by id.
    return {
      id: entry.id,
      name: entry.name,
      status: entry.status,
      createdAt: entry.createdAt,
      startsAt: entry.startsAt,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      hostName: hostName(entry),
      visibility: entry.settings.visibility,
      entrants: { humans, total },
      tableSize: d.tableSize,
      startChips: d.startChips,
      levelDuration: d.tournament.levelDuration,
      lateRegLevels: d.lateRegLevels,
      lateRegOpen: d.lateRegOpen(),
      level: d.tournament.currentLevel + 1,
      remaining: entry.status === 'registering' ? total : d.playersRemaining(),
      buyIn: d.buyIn,
      prizePool: d.prizePool(),
      winner: d.finished ? d.finished.winner : null,
      // Kept for the pre-lobby client's list shape.
      running: entry.status === 'running',
      finished: entry.status === 'finished',
    };
  }

  // What GET /api/tournaments serves: the games their hosts chose to list.
  function publicList() {
    return [...tournaments.values()].filter(isPublic).map(summarize);
  }

  // What the Operator page shows: every game the server holds, listed or not,
  // with its code. Only ever answered to a socket that has unlocked the
  // operator controls (tournament-handlers.js); nothing here reaches a player.
  const OPERATOR_ORDER = { running: 0, registering: 1, finished: 2 };
  function operatorRank(entry) {
    return entry.status in OPERATOR_ORDER ? OPERATOR_ORDER[entry.status] : 3;
  }
  function operatorList() {
    return [...tournaments.values()]
      .sort((a, b) => operatorRank(a) - operatorRank(b) || a.createdAt - b.createdAt)
      .map((entry) => ({
        ...summarize(entry),
        code: entry.code,
        connected: connectedHumans(entry),
        pending: entry.pending.size,
        tables: entry.director.tables.length,
      }));
  }

  // A private or invite-only game is on the list for its own people only, so
  // Open and Rejoin still work for them and a stranger never learns it exists.
  // registrations.has covers a player who left, whose stack is still in play.
  function listFor(uid, shared = null) {
    const rows = (
      shared || [...tournaments.values()].map((entry) => ({ entry, card: summarize(entry) }))
    ).filter(({ entry }) => isPublic(entry) || (!!uid && entry.registrations.has(uid)));
    return rows.map(({ entry, card }) => ({
      ...card,
      you: {
        registered: entry.registrations.has(uid) && !entry.registrations.get(uid).left,
        // Left the table but the stack is still in play: the card offers a way
        // back, and it must not depend on late registration being open.
        left: !!(entry.registrations.has(uid) && entry.registrations.get(uid).left),
        eliminated: entry.watching.has(uid),
      },
    }));
  }

  // Everything in a tournament state that is the same whoever is looking.
  function sharedState(entry) {
    const d = entry.director;
    const field = d.fieldShared();
    const roster = d.roster(field.seats).map((row) => {
      const r = entry.registrations.get(row.uid);
      return {
        ...row,
        isHost: row.uid === entry.hostUid,
        // A demo seat has no socket to lose, so it is always here.
        connected: row.isBot || !!(r && r.socketId),
        muted: entry.mutedUids.has(row.uid),
      };
    });
    const placeByUid = new Map();
    for (const e of d.tournament.eliminations) if (e.uid) placeByUid.set(e.uid, e.place);
    return { field, roster, placeByUid, hostName: hostName(entry) };
  }

  function stateFor(entry, uid, shared = sharedState(entry), { includeRoster = true } = {}) {
    const d = entry.director;
    const reg = entry.registrations.get(uid) || null;
    const seat = shared.field.seats.get(uid) || null;
    const place = shared.placeByUid.has(uid) ? { place: shared.placeByUid.get(uid) } : null;
    const roster = shared.roster;
    return {
      ...d.fieldSummary(uid, shared.field),
      id: entry.id,
      code: entry.code,
      name: entry.name,
      status: entry.status,
      startsAt: entry.startsAt,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      waitingReason: entry.waitingReason,
      host: { uid: entry.hostUid, name: shared.hostName },
      isHost: requireHost(entry, uid),
      settings: { ...entry.settings },
      ...(includeRoster ? { roster } : {}),
      // Who is waiting at the door. The host's business and nobody else's, so
      // it rides the personal push rather than the shared roster broadcast.
      ...(requireHost(entry, uid) ? { pending: pendingRows(entry) } : {}),
      you: {
        uid,
        playerId: seat ? seat.player.id : reg && reg.socketId ? reg.socketId : null,
        registered: !!reg && !reg.left,
        left: !!(reg && reg.left),
        seated: !!seat,
        eliminated: entry.watching.has(uid),
        place: place ? place.place : null,
        watchingTable: entry.watching.has(uid)
          ? (d.tables.find((t) => t.id === entry.watching.get(uid)) || {}).tableNumber || null
          : null,
      },
    };
  }

  // ── Tables ───────────────────────────────────────────────────────────────

  // Seated humans get their table's state; so does anyone watching that table
  // after busting. An unseated viewer already yields a spectator view from
  // getStateForPlayer (no hole cards, no turn).
  function recipientsFor(entry, table) {
    const out = [];
    for (const p of table.players) {
      const reg = entry.registrations.get(p.uid);
      if (reg && reg.socketId) out.push({ socketId: reg.socketId, playerId: p.id });
    }
    for (const [uid, tableId] of entry.watching) {
      if (tableId !== table.id) continue;
      const reg = entry.registrations.get(uid);
      if (reg && reg.socketId) out.push({ socketId: reg.socketId, playerId: reg.socketId });
    }
    return out;
  }

  function wireTable(entry, table) {
    table.hostPlayerId = entry.hostUid;
    table.onUpdate = (g) => {
      // The hand history goes out on the first push after it changes and is
      // left off every push in between. It is the great bulk of a state
      // payload and a hand's worth of it is identical for the whole street,
      // so sending it per action was rebuilding and restringifying the same
      // ten hands for every seat on every bet.
      //
      // Tracked per recipient rather than per table, because a socket that
      // arrives mid-hand has nothing cached and must be sent the history on
      // its first push. A table-wide flag cannot see that: the arriving client
      // would take whichever routine push happened to reach it first and sit
      // there with no history until the hand ended.
      const version = g.handHistory ? g.handHistory.version : 0;
      if (g._historyVersionSent !== version) {
        g._historyVersionSent = version;
        g._historySentTo = new Set();
      }
      for (const r of recipientsFor(entry, g)) {
        const includeHistory = !g._historySentTo.has(r.socketId);
        if (includeHistory) g._historySentTo.add(r.socketId);
        io.to(r.socketId).emit('gameState', g.getStateForPlayer(r.playerId, { includeHistory }));
      }
    };
    table.onMessage = (msg, meta) => {
      for (const r of recipientsFor(entry, table)) {
        io.to(r.socketId).emit('gameMessage', msg, meta || null);
      }
    };
  }

  // ── Chat ─────────────────────────────────────────────────────────────────
  // The room a message belongs to is resolved from the sender, never taken
  // from them, so there is nothing to spoof. See server/chat-rooms.js.

  function tableForRoom(entry, room) {
    const prefix = `${entry.id}:t`;
    if (!room || !room.startsWith(prefix)) return null;
    const number = parseInt(room.slice(prefix.length), 10);
    return entry.director.tables.find((t) => t.tableNumber === number) || null;
  }

  // One array, one emit. A chat line is byte-identical for everyone who gets
  // it, and socket.io encodes per emit, so a per-socket loop here would be the
  // thing that cost this server 5 MB a tick before it was found. A Set because
  // an eliminated player is briefly both a seat and a watcher.
  function chatRecipients(entry, room) {
    const ids = new Set();
    if (room === chat.lobbyRoom(entry.id)) {
      for (const reg of entry.registrations.values()) if (reg.socketId) ids.add(reg.socketId);
      return [...ids];
    }
    const table = tableForRoom(entry, room);
    if (!table) return [];
    for (const r of recipientsFor(entry, table)) ids.add(r.socketId);
    return [...ids];
  }

  function persistChat(entry) {
    if (chatStore) chatStore.record(entry.id, chat.snapshot(entry.id));
  }

  // Sent whenever a client attaches to a room: a fresh join, a reconnect, a
  // reload, or the balancer moving them to a table mid-conversation. One path
  // for all four, so none of them can be the one that was forgotten.
  function sendChatHistory(entry, uid, socketId = null) {
    if (!chatEnabled) return;
    const reg = entry.registrations.get(uid);
    const target = socketId || (reg && reg.socketId);
    if (!target) return;
    const room = chat.roomFor(entry, uid);
    if (!room) return;
    io.to(target).emit('chatHistory', {
      room,
      canSend: chat.canPost(entry, uid).ok,
      messages: chat.history(room),
    });
  }

  function postChat(entry, uid, text, socket) {
    if (!chatEnabled) return { error: 'Chat is switched off' };
    const allowed = chat.canPost(entry, uid);
    if (!allowed.ok) return { error: allowed.reason };
    if (!socket.data.chatBucket) socket.data.chatBucket = {};
    if (!chat.takeToken(socket.data.chatBucket)) {
      return { error: 'Slow down a moment' };
    }
    const room = chat.roomFor(entry, uid);
    if (!room) return { error: 'You are not at a table yet' };
    // The name is looked up, never taken from the payload: otherwise anyone
    // can sign a message with somebody else's name.
    const who = identity.get(uid);
    const message = chat.post(room, { uid, name: who ? who.name : 'Player', text });
    if (!message) return { error: 'Nothing to send' };
    const ids = chatRecipients(entry, room);
    if (ids.length) io.to(ids).emit('chatMessage', message);
    persistChat(entry);
    return { message };
  }

  // Same room, same mute, same people as a chat line, and none of its
  // permanence: nothing is appended, nothing is written, nobody arriving
  // later is shown it. The name is looked up rather than taken from the
  // payload, as for chat.
  function postReaction(entry, uid, emoji, socket) {
    if (!reactionsEnabled) return { error: 'Reactions are switched off' };
    if (!reactions.isReaction(emoji)) return { error: 'Not one of the reactions' };
    const allowed = chat.canPost(entry, uid);
    if (!allowed.ok) return { error: allowed.reason };
    if (!socket.data.reactionBucket) socket.data.reactionBucket = {};
    const ok = reactions.takeToken(socket.data.reactionBucket, {
      limit: reactionRatePerWindow,
      windowMs: reactionRateWindowMs,
      at: now(),
    });
    if (!ok) return { error: 'Slow down a moment' };
    const room = chat.roomFor(entry, uid);
    if (!room) return { error: 'You are not at a table yet' };
    const who = identity.get(uid);
    const reaction = { room, uid, name: who ? who.name : 'Player', emoji, at: now() };
    const ids = chatRecipients(entry, room);
    if (ids.length) io.to(ids).emit('reaction', reaction);
    return { reaction };
  }

  function setChatMute(entry, hostUid, targetUid, muted) {
    if (!requireHost(entry, hostUid)) return { error: 'Only the host can do that' };
    if (!targetUid || !entry.registrations.has(targetUid)) {
      return { error: 'They are not in this tournament' };
    }
    if (targetUid === entry.hostUid) return { error: 'You cannot mute the host' };
    if (muted) entry.mutedUids.add(targetUid);
    else entry.mutedUids.delete(targetUid);
    persist();
    emitTo(entry, targetUid, 'chatMuted', { muted });
    emitState(entry);
    return { ok: true, muted };
  }

  // A watcher whose table emptied moves to the biggest table left.
  function repointWatchers(entry) {
    const d = entry.director;
    for (const [uid, tableId] of entry.watching) {
      const table = d.tables.find((t) => t.id === tableId);
      if (table && table.players.length > 0) continue;
      const biggest = [...d.tables]
        .filter((t) => t.players.length > 0)
        .sort((a, b) => b.players.length - a.players.length)[0];
      if (biggest) entry.watching.set(uid, biggest.id);
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  function clampSettings(payload = {}) {
    const int = (v, fallback) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : fallback;
    };
    const t = now();
    let startsAt = int(payload.startsAt, t);
    if (startsAt < t - 60 * 1000 || startsAt > t + WEEK_MS) startsAt = t;
    const startChips = int(payload.startChips, 5000);
    return {
      startsAt,
      settings: {
        tableSize: Math.max(2, Math.min(8, int(payload.tableSize, 8))),
        startChips: START_CHIPS.includes(startChips) ? startChips : 5000,
        levelDuration: Math.max(30, Math.min(3600, int(payload.levelDuration, 300))),
        lateRegLevels: Math.max(0, Math.min(8, int(payload.lateRegLevels, 3))),
        buyIn: Math.max(0, Math.min(10000, int(payload.buyIn, 0))),
        // Private unless the host says otherwise: on a server anyone can
        // reach, a game a stranger can sit at should be a choice, not the
        // default. A file written before this setting existed reads as
        // private for the same reason.
        visibility: VISIBILITIES.includes(payload.visibility) ? payload.visibility : 'private',
      },
    };
  }

  function isPublic(entry) {
    return entry.settings.visibility === 'public';
  }

  function create(uid, payload = {}, socket) {
    const who = identity.get(uid);
    if (!who) return { error: 'Identify first' };
    if (findByUid(uid, { includeLeft: true })) return { error: 'You are already in a tournament' };
    if (tournaments.size >= maxTournaments) return { error: 'Too many tournaments running' };
    withdrawAll(uid);

    const name = sanitizeName(payload.name || 'Tournament', 24) || 'Tournament';
    const { startsAt, settings } = clampSettings(payload);
    const entry = buildEntry({ name, startsAt, hostUid: uid, settings });
    entry.director.register({
      id: socket ? socket.id : null,
      uid,
      name: who.name,
      avatar: who.avatar,
      provider: who.provider || 'guest',
    });
    entry.registrations.set(uid, {
      socketId: null,
      disconnectedAt: null,
      joinedAt: now(),
      left: false,
    });
    // Demo seats, if asked for. They are entrants and nothing else: no
    // registration row, so connectedHumans does not count them and a field of
    // bots whose only human has gone still gets reaped like any other.
    if (payload.bots) {
      DEMO_BOT_NAMES.forEach((botName, i) => {
        const botUid = `bot:${entry.id}:${i + 1}`;
        entry.director.register({
          id: botUid,
          uid: botUid,
          name: botName,
          avatar: '🫏',
          isBot: true,
        });
      });
    }

    tournaments.set(entry.id, entry);
    if (socket) bind(entry, uid, socket);
    persist();
    emitList();
    return { entry };
  }

  // The entry and its director, with every callback wired. Shared by create()
  // and restore().
  function buildEntry({ id = null, code = null, name, startsAt, hostUid, settings, createdAt }) {
    const entry = {
      id,
      code: code || makeCode(),
      name,
      status: 'registering',
      createdAt: createdAt || now(),
      startsAt,
      startedAt: null,
      finishedAt: null,
      hostUid,
      settings,
      director: null,
      registrations: new Map(),
      watching: new Map(),
      timer: null,
      waitingReason: null,
      noHumansSince: null,
      // Set by the restore guard: the field would not stay up, so it is kept
      // as it stood rather than seated, and heldField is what it stood as.
      held: false,
      heldField: null,
      // Host moderation. Small enough to ride along in the tournament file, so
      // a mute survives a restart the way the field it was aimed at does.
      mutedUids: new Set(),
      // People asking to join an invite-only game, waiting on the host:
      // uid -> { socketId, askedAt, disconnectedAt }. Not an entrant, not a
      // registration, not written to the file. A restart empties the queue
      // and the asker's client falls back to the lobby.
      pending: new Map(),
    };
    const director = new TournamentDirector({
      id: id || undefined,
      tableSize: settings.tableSize,
      startChips: settings.startChips,
      buyIn: settings.buyIn,
      levelDuration: settings.levelDuration,
      lateRegLevels: settings.lateRegLevels,
      handPauseMs,
      gameOptions: { gameMode: 'tournament', ...tableOptions },
      onTableCreated: (table) => wireTable(entry, table),
      onTableBroken: (table) => chat.dropRoom(chat.tableRoom(entry.id, table.tableNumber)),
      onMessage: (msg) => emitAll(entry, 'gameMessage', msg),
      onPlayerMoved: (move) => {
        emitTo(entry, move.uid, 'tableMoved', move);
        // They have landed among different people mid-conversation, so send
        // the new table's recent chat the same way a reload would get it.
        sendChatHistory(entry, move.uid);
      },
      // The field has settled after a hand: write it down.
      onSnapshot: () => {
        // Long enough on its feet to call the field viable, so the restore
        // attempt counter goes back to zero.
        if (entry.restoreCount && now() - (entry.restoredAt || 0) > RESTORE_STABLE_MS) {
          entry.restoreCount = 0;
        }
        persist();
      },
      onFieldUpdate: () => {
        repointWatchers(entry);
        emitState(entry);
      },
      onPlayerEliminated: ({ uid: outUid, place, tableId }) => {
        entry.watching.set(outUid, tableId);
        const prize = director.payouts().find((p) => p.place === place);
        emitTo(entry, outUid, 'tournamentEliminated', {
          place,
          entrants: director.entrants.length,
          prize: prize ? prize.amount : 0,
          inTheMoney: !!prize,
          lateRegOpen: director.lateRegOpen(),
        });
      },
      onFinished: (result) => {
        entry.status = 'finished';
        entry.finishedAt = now();
        if (entry.timer) {
          timers.clearInterval(entry.timer);
          entry.timer = null;
        }
        const results = director.finalResults();
        for (const [regUid, reg] of entry.registrations) {
          if (!reg.socketId) continue;
          const mine = results.find((r) => r.name === (identity.get(regUid) || {}).name) || null;
          io.to(reg.socketId).emit('tournamentFinished', {
            ...result,
            results,
            you: mine ? { place: mine.place, prize: mine.prize } : null,
          });
        }
        emitState(entry);
        emitList();
      },
    });
    entry.id = director.id;
    entry.director = director;
    return entry;
  }

  function join(uid, { code, tournamentId } = {}, socket) {
    const who = identity.get(uid);
    if (!who) return { error: 'Identify first' };
    const fromCode = code ? byCode(code) : null;
    const entry = fromCode || tournaments.get(tournamentId) || null;
    if (!entry) return { error: 'Tournament not found' };

    const existing = entry.registrations.get(uid);
    if (existing) {
      // Back for more: a player rejoins their own seat. bind() takes it off
      // sit-out, the same as any other return.
      existing.left = false;
      if (socket) bind(entry, uid, socket, { resumed: true });
      emitState(entry);
      emitList();
      return { entry };
    }
    // A private or invite-only card never reaches a stranger, so an id arriving
    // without the code is a guess. It gets the answer a wrong code gets, and
    // nothing that says the game exists.
    if (!fromCode && !isPublic(entry)) return { error: 'Tournament not found' };
    if (findByUid(uid, { includeLeft: true })) return { error: 'You are already in a tournament' };
    if (entry.status === 'finished') return { error: 'That tournament is over' };
    if (entry.status === 'running' && !entry.director.lateRegOpen()) {
      return { error: 'Late registration is closed' };
    }
    const key = normalizeNameKey(who.name);
    if (entry.director.entrants.some((e) => normalizeNameKey(e.name) === key)) {
      return { error: 'Name already taken in this tournament' };
    }
    withdrawAll(uid, entry);
    if (entry.settings.visibility === 'invite') return ask(entry, uid, socket);
    return enter(entry, uid, who, socket);
  }

  // The way in, once every check has passed: as an entrant, as a registration,
  // bound to the socket if there is one. Shared by a code join and by the host
  // admitting somebody who asked.
  function enter(entry, uid, who, socket) {
    const entrant = {
      id: socket ? socket.id : null,
      uid,
      name: who.name,
      avatar: who.avatar,
      provider: who.provider || 'guest',
    };
    if (entry.status === 'registering') {
      entry.director.register(entrant);
    } else if (entry.director.lateRegOpen()) {
      try {
        entry.director.registerLate(entrant);
      } catch (err) {
        return { error: err.message };
      }
    } else {
      return { error: 'Late registration is closed' };
    }
    entry.registrations.set(uid, {
      socketId: null,
      disconnectedAt: null,
      joinedAt: now(),
      left: false,
    });
    if (socket) bind(entry, uid, socket);
    persist();
    emitState(entry);
    emitList();
    return { entry };
  }

  // ── Asking to join ───────────────────────────────────────────────────────
  //
  // An invite-only game has a door. Somebody with the code knocks, waits, and
  // is let in or not by the host. While they wait they are none of the things
  // a member is: not an entrant, not a registration, not in the chat room,
  // not counted toward anything. Their request lives in entry.pending and
  // nowhere else.

  function pendingInfo(entry, { resumed = false } = {}) {
    return {
      id: entry.id,
      name: entry.name,
      hostName: hostName(entry),
      status: entry.status,
      resumed,
    };
  }

  // The queue as the host sees it. Names looked up, never stored: the same
  // rule as chat, so nobody can knock under somebody else's name.
  function pendingRows(entry) {
    return [...entry.pending].map(([uid, row]) => {
      const who = identity.get(uid);
      return {
        uid,
        name: who ? who.name : 'Player',
        avatar: who ? who.avatar : null,
        provider: who ? who.provider || 'guest' : 'guest',
        askedAt: row.askedAt,
        connected: !!row.socketId,
      };
    });
  }

  function ask(entry, uid, socket) {
    if (entry.pending.has(uid)) {
      // A second tab, a double tap, a reconnect that came in by the link:
      // the same request, on the newest socket.
      if (socket) bindPending(entry, uid, socket, { resumed: true });
      return { entry, pending: true };
    }
    if (entry.pending.size >= MAX_PENDING) {
      return { error: 'Too many people are waiting on this tournament' };
    }
    entry.pending.set(uid, { socketId: null, askedAt: now(), disconnectedAt: null });
    if (socket) bindPending(entry, uid, socket);
    emitState(entry);
    return { entry, pending: true };
  }

  // Two fields on the socket rather than one keyed on socket.data.uid: a
  // GameNight sign-in mid-wait changes the uid, and a disconnect that looked
  // the row up by the new one would leave it holding a dead socket forever.
  function bindPending(entry, uid, socket, { resumed = false } = {}) {
    const row = entry.pending.get(uid);
    if (!row) return false;
    row.socketId = socket.id;
    row.disconnectedAt = null;
    socket.data.pendingTournamentId = entry.id;
    socket.data.pendingUid = uid;
    socket.emit('tournamentPending', pendingInfo(entry, { resumed }));
    if (resumed) emitState(entry);
    return true;
  }

  // The socket went; the request stays, for a while. The sweep lapses it.
  function unbindPending(entry, uid, socket) {
    const row = entry.pending.get(uid);
    if (!row || row.socketId !== socket.id) return;
    row.socketId = null;
    row.disconnectedAt = now();
    emitState(entry);
  }

  function clearPendingFields(socketId) {
    const s = socketId ? socketById(socketId) : null;
    if (s && s.data) {
      s.data.pendingTournamentId = null;
      s.data.pendingUid = null;
    }
  }

  // Every end the asker did not choose: declined, closed, taken, cancelled,
  // or lapsed after the grace. The reason is a short code the client turns
  // into a sentence.
  function endRequest(entry, uid, reason, { quiet = false } = {}) {
    const row = entry.pending.get(uid);
    if (!row) return false;
    entry.pending.delete(uid);
    if (row.socketId) {
      io.to(row.socketId).emit('tournamentDeclined', { id: entry.id, name: entry.name, reason });
      clearPendingFields(row.socketId);
    }
    if (!quiet) emitState(entry);
    return true;
  }

  function flushPending(entry, reason) {
    if (!entry.pending.size) return;
    for (const uid of [...entry.pending.keys()]) endRequest(entry, uid, reason, { quiet: true });
    emitState(entry);
  }

  // The asker gives up.
  function withdraw(entry, uid, socket) {
    if (!entry.pending.has(uid)) return { error: 'You are not waiting on this tournament' };
    entry.pending.delete(uid);
    if (socket) {
      socket.data.pendingTournamentId = null;
      socket.data.pendingUid = null;
      socket.emit('leftTournament', { id: entry.id, reason: 'withdrawn' });
    }
    emitState(entry);
    return { entry };
  }

  // A request left behind somewhere else, when its owner creates or joins a
  // game. Bookkeeping, not a message: the asker is the one moving on.
  function withdrawAll(uid, except = null) {
    for (const entry of tournaments.values()) {
      if (entry === except || !entry.pending.has(uid)) continue;
      const row = entry.pending.get(uid);
      entry.pending.delete(uid);
      clearPendingFields(row.socketId);
      emitState(entry);
    }
  }

  function findPendingByUid(uid) {
    if (!uid) return null;
    for (const entry of tournaments.values()) {
      if (entry.status !== 'finished' && entry.pending.has(uid)) return entry;
    }
    return null;
  }

  function admit(entry, hostUid, targetUid) {
    if (!requireHost(entry, hostUid)) return { error: 'Only the host can do that' };
    const row = entry.pending.get(targetUid);
    if (!row) return { error: 'They are not waiting on this tournament' };
    const who = identity.get(targetUid);
    if (!who) {
      endRequest(entry, targetUid, 'declined');
      return { error: 'They are no longer here' };
    }
    const open =
      entry.status === 'registering' ||
      (entry.status === 'running' && entry.director.lateRegOpen());
    if (!open) {
      endRequest(entry, targetUid, 'closed');
      return { error: 'Registration has closed' };
    }
    // Checked again here: a name that was free when they knocked may have been
    // taken by somebody the host let in first.
    const key = normalizeNameKey(who.name);
    if (entry.director.entrants.some((e) => normalizeNameKey(e.name) === key)) {
      endRequest(entry, targetUid, 'taken');
      return { error: 'Name already taken in this tournament' };
    }
    const socket = row.socketId ? socketById(row.socketId) : null;
    entry.pending.delete(targetUid);
    clearPendingFields(row.socketId);
    // A socket that is briefly gone is fine: the registration is created
    // unbound and findByUid binds them on their next identify.
    const result = enter(entry, targetUid, who, socket);
    if (result.error) {
      if (socket) {
        socket.emit('tournamentDeclined', { id: entry.id, name: entry.name, reason: 'closed' });
      }
      emitState(entry);
    }
    return result;
  }

  function decline(entry, hostUid, targetUid) {
    if (!requireHost(entry, hostUid)) return { error: 'Only the host can do that' };
    if (!entry.pending.has(targetUid)) return { error: 'They are not waiting on this tournament' };
    endRequest(entry, targetUid, 'declined');
    return { ok: true };
  }

  // A seat sits out when its player drops, leaves or lets the clock run out.
  // None of those are a decision to sit out, so being back at the keyboard
  // undoes them: the seat plays again without anyone having to notice a badge
  // and press a button. A seat the player deliberately sat out stays sitting
  // out, because that one *was* the decision.
  //
  // If it is their turn when they land, the clock has to be handed back too:
  // the pending sit-out timer will see a non-automated seat and bail without
  // acting, leaving the turn with nothing driving it.
  function resumeSeat(seat) {
    const { table, player } = seat;
    if (!player.autoPlay || player.sitOutReason === 'requested') return false;
    player.autoPlay = false;
    player.sitOutReason = null;
    table.emitMessage(`${player.name} is back at the table`, { kind: 'system' });
    const idx = table.players.findIndex((p) => p.id === player.id);
    if (table.isRunning && idx === table.currentPlayerIndex) table.beginCurrentTurn();
    else table.emitUpdate();
    return true;
  }

  // Bind a socket to its registration. On a rejoin the seated player's id is
  // rebound to the new socket, exactly as the room layer does on reconnect,
  // so every socket-id-keyed path in the engine and the client keeps working.
  function bind(entry, uid, socket, { resumed = false } = {}) {
    const reg = entry.registrations.get(uid);
    if (!reg) return false;
    reg.socketId = socket.id;
    reg.disconnectedAt = null;
    reg.left = false;
    entry.noHumansSince = null;
    socket.data.tournamentId = entry.id;
    socket.data.tournamentUid = uid;
    const entrant = entry.director.entrants.find((e) => e.uid === uid);
    if (entrant) entrant.id = socket.id;
    const seat = entry.director.playerByUid(uid);
    if (seat) {
      seat.player.id = socket.id;
      seat.player.isConnected = true;
      seat.player.disconnectedAt = null;
      resumeSeat(seat);
    }
    socket.emit('tournamentJoined', {
      id: entry.id,
      code: entry.code,
      uid,
      host: requireHost(entry, uid),
      name: entry.name,
      status: entry.status,
      you: { uid, playerId: socket.id },
      resumed,
    });
    const state = stateFor(entry, uid);
    socket.emit('tournamentState', state);
    socket.emit('tournamentField', state);
    // A client arriving or coming back holds no roster, so the next broadcast
    // has to carry one whether or not it has changed since the last.
    entry._rosterSig = null;
    if (seat) seat.table.emitUpdate();
    else if (entry.watching.has(uid)) {
      const table = entry.director.tables.find((t) => t.id === entry.watching.get(uid));
      if (table) socket.emit('gameState', table.getStateForPlayer(socket.id));
    }
    sendChatHistory(entry, uid, socket.id);
    if (resumed) emitState(entry);
    return true;
  }

  // The socket went away. The registration stays; the sweep decides later
  // whether anyone is coming back. Lifted from the room layer's disconnect.
  function unbind(entry, uid, socket) {
    const reg = entry.registrations.get(uid);
    if (!reg || reg.socketId !== socket.id) return;
    reg.socketId = null;
    reg.disconnectedAt = now();
    const seat = entry.director.playerByUid(uid);
    if (seat) {
      const { table, player } = seat;
      player.isConnected = false;
      player.disconnectedAt = now();
      let refreshed = false;
      if (table.isRunning && !player.folded && !player.allIn) {
        if (!player.autoPlay) {
          player.autoPlay = true;
          player.sitOutReason = 'disconnect';
          player.isReady = false;
          table.emitMessage(`${player.name} is sitting out after a dropped connection`, {
            kind: 'system',
          });
        }
        const idx = table.players.findIndex((p) => p.id === player.id);
        if (idx === table.currentPlayerIndex && table.isAutomatedPlayer(player)) {
          table.beginCurrentTurn();
          refreshed = true;
        }
      }
      if (!refreshed) table.emitUpdate();
    }
    if (connectedHumans(entry) === 0) entry.noHumansSince = now();
    emitState(entry);
  }

  function unregister(entry, uid, socket) {
    if (entry.status !== 'registering') return { error: 'The tournament has started' };
    const reg = entry.registrations.get(uid);
    if (!reg) return { error: 'You are not registered' };
    entry.director.unregister(uid);
    entry.registrations.delete(uid);
    if (socket) {
      socket.data.tournamentId = null;
      socket.data.tournamentUid = null;
      socket.emit('leftTournament', { id: entry.id, reason: 'unregistered' });
    }
    if (entry.registrations.size === 0) {
      remove(entry, 'empty');
      return { entry };
    }
    if (uid === entry.hostUid) transferHost(entry, { force: true });
    persist();
    emitState(entry);
    emitList();
    return { entry };
  }

  // Leaving a running tournament: the stack cannot leave, so the seat stays
  // sitting out and the registration is marked as left. Auto-return will
  // not pull them back in; joining by code rebinds their own seat.
  function leave(entry, uid, socket) {
    if (entry.status === 'registering') return unregister(entry, uid, socket);
    const reg = entry.registrations.get(uid);
    if (!reg) return { error: 'You are not registered' };
    if (socket && reg.socketId === socket.id) unbind(entry, uid, socket);
    reg.left = true;
    const seat = entry.director.playerByUid(uid);
    if (seat) {
      // Walking out settles anything the seat had queued: a line armed for a
      // turn they will not be here for, and a sit-out they have overtaken.
      seat.player.preAction = null;
      seat.player.sitOutNextHand = false;
    }
    if (seat && !seat.player.autoPlay) {
      seat.player.autoPlay = true;
      seat.player.sitOutReason = 'left';
      seat.table.emitMessage(`${seat.player.name} left the table and is sitting out`, {
        kind: 'system',
      });
      seat.table.emitUpdate();
    }
    if (socket) {
      socket.data.tournamentId = null;
      socket.data.tournamentUid = null;
      socket.emit('leftTournament', { id: entry.id, reason: 'left' });
    }
    emitState(entry);
    return { entry };
  }

  function startNow(entry, uid) {
    if (!requireHost(entry, uid)) return { error: 'Only the host can start the tournament' };
    if (entry.status !== 'registering') return { error: 'Already started' };
    if (entry.director.entrants.length < 2) return { error: 'Need at least 2 entrants' };
    // Starting a held tournament is the host deciding to play it out from the
    // beginning rather than keep a field that would not seat. A decision,
    // rather than something that happens to it while nobody is looking.
    entry.held = false;
    entry.heldField = null;
    start(entry);
    return { entry };
  }

  // Cancel without the host check. The host of a running tournament may be a
  // seat that has long since busted or dropped, so an operator needs a way in
  // that does not depend on who happens to hold that role. Authorisation is the
  // caller's business and is done at the socket, not here.
  function forceCancel(entry, reason = 'cancelled by the operator') {
    if (!entry || entry.status === 'finished') return { error: 'Already finished' };
    cancelEntry(entry, reason);
    return { entry };
  }

  function cancel(entry, uid) {
    if (!requireHost(entry, uid)) return { error: 'Only the host can cancel the tournament' };
    if (entry.status === 'finished') return { error: 'Already finished' };
    cancelEntry(entry, 'cancelled by the host');
    return { entry };
  }

  // Everything start() does except the draw: the field is already seated from
  // a snapshot, so only the clock and the tick need starting.
  function resume(entry) {
    entry.status = 'running';
    entry.startedAt = entry.startedAt || now();
    entry.waitingReason = null;
    entry.timer = timers.setInterval(() => {
      try {
        entry.director.tick();
        emitState(entry);
      } catch (err) {
        emitAll(entry, 'gameMessage', `Tournament halted: ${err.message}`);
        remove(entry, 'halted');
      }
    }, TICK_MS);
    if (entry.timer && entry.timer.unref) entry.timer.unref();
  }

  function start(entry) {
    entry.director.start();
    entry.status = 'running';
    entry.startedAt = now();
    entry.waitingReason = null;
    entry.timer = timers.setInterval(() => {
      try {
        entry.director.tick();
        emitState(entry);
      } catch (err) {
        emitAll(entry, 'gameMessage', `Tournament halted: ${err.message}`);
        remove(entry, 'halted');
      }
    }, TICK_MS);
    if (entry.timer && entry.timer.unref) entry.timer.unref();
    persist();
    emitState(entry);
    emitList();
  }

  function cancelEntry(entry, reason) {
    emitAll(entry, 'tournamentCancelled', { id: entry.id, name: entry.name, reason });
    remove(entry, reason);
  }

  function remove(entry) {
    // Every way a tournament goes comes through here, so this is where
    // whoever was still waiting to be let in is told there is nothing to
    // wait for.
    flushPending(entry, 'cancelled');
    if (entry.timer) {
      timers.clearInterval(entry.timer);
      entry.timer = null;
    }
    entry.director.stop();
    chat.dropTournament(entry.id);
    if (chatStore) chatStore.remove(entry.id);
    tournaments.delete(entry.id);
    persist();
    emitList();
  }

  // Host goes to the earliest-registered connected human when the host has
  // been gone past the grace, or at once when the host leaves. Compared by
  // uid, never by name.
  function transferHost(entry, { force = false } = {}) {
    const current = entry.registrations.get(entry.hostUid);
    if (!force && current && current.socketId && !current.left) return false;
    if (!force && current && !current.left) {
      const gone = now() - (current.disconnectedAt || now());
      if (gone < hostTransferGraceMs) return false;
    }
    const next = [...entry.registrations.entries()]
      .filter(([uid, r]) => uid !== entry.hostUid && !r.left && r.socketId)
      .sort((a, b) => a[1].joinedAt - b[1].joinedAt)[0];
    if (!next) return false;
    entry.hostUid = next[0];
    for (const table of entry.director.tables) table.hostPlayerId = entry.hostUid;
    const who = identity.get(entry.hostUid);
    entry.director._say(`${who ? who.name : 'Someone'} is now the host`);
    persist();
    emitState(entry);
    emitList();
    // Whoever is waiting at the door is waiting on a different person now.
    for (const row of entry.pending.values()) {
      if (row.socketId) {
        io.to(row.socketId).emit('tournamentPending', pendingInfo(entry, { resumed: true }));
      }
    }
    return true;
  }

  function findByUid(uid, { includeLeft = false } = {}) {
    if (!uid) return null;
    for (const entry of tournaments.values()) {
      if (entry.status === 'finished') continue;
      const reg = entry.registrations.get(uid);
      if (reg && (includeLeft || !reg.left)) return entry;
    }
    return null;
  }

  // ── The sweep ────────────────────────────────────────────────────────────

  function sweep() {
    const t = now();
    for (const entry of [...tournaments.values()]) {
      if (entry.pending.size) {
        const open =
          entry.status === 'registering' ||
          (entry.status === 'running' && entry.director.lateRegOpen());
        if (!open) {
          flushPending(entry, 'closed');
        } else {
          for (const [uid, row] of [...entry.pending]) {
            if (row.disconnectedAt !== null && t - row.disconnectedAt > pendingGraceMs) {
              endRequest(entry, uid, 'lapsed');
            }
          }
        }
      }
      if (entry.status === 'registering') {
        if (entry.registrations.size === 0) {
          remove(entry, 'empty');
          continue;
        }
        // A held field sits in `registering` with its start time long past, so
        // this used to deal it one tick after the guard held it - a fresh
        // table at level one, written over the chips being kept - and the
        // overdue branch below would throw the same thing away half an hour
        // later. It waits for the host instead, for as long as that takes.
        if (entry.held) {
          transferHost(entry);
          continue;
        }
        if (t >= entry.startsAt) {
          if (entry.director.entrants.length >= 2) {
            start(entry);
          } else if (t - entry.startsAt > overdueAbandonMs) {
            cancelEntry(entry, 'nobody else came');
          } else if (!entry.waitingReason) {
            entry.waitingReason = 'Waiting for one more entrant';
            emitState(entry);
          }
        }
        transferHost(entry);
      } else if (entry.status === 'running') {
        transferHost(entry);
        if (
          connectedHumans(entry) === 0 &&
          entry.noHumansSince !== null &&
          t - entry.noHumansSince > abandonGraceMs
        ) {
          remove(entry, 'abandoned');
        }
      } else if (entry.status === 'finished') {
        if (t - entry.finishedAt > finishedTtlMs) remove(entry, 'expired');
      }
    }
    sweeps++;
    if (sweeps % Math.max(1, Math.round(60000 / sweepMs)) === 0 && identity.expireIdle) {
      identity.expireIdle();
    }
  }

  function startSweep() {
    if (sweepTimer) return;
    sweepTimer = timers.setInterval(sweep, sweepMs);
    if (sweepTimer && sweepTimer.unref) sweepTimer.unref();
  }

  function stop() {
    if (listTimer) {
      timers.clearTimeout(listTimer);
      listTimer = null;
    }
    flush();
    if (sweepTimer) {
      timers.clearInterval(sweepTimer);
      sweepTimer = null;
    }
    for (const entry of tournaments.values()) {
      if (entry.timer) timers.clearInterval(entry.timer);
      entry.timer = null;
      entry.director.stop();
    }
  }

  // Rebuild registering tournaments from the store at boot. Everyone comes
  // back unbound: they identify and are rebound. The first sweep starts
  // anything that is overdue.
  function restore() {
    if (!store) return 0;
    let restored = 0;
    for (const saved of store.load()) {
      if (!saved || !saved.id || tournaments.has(saved.id)) continue;
      const { settings } = clampSettings({ ...saved.settings, startsAt: saved.startsAt });
      // A tournament that was already dealing keeps the table size it was dealt
      // with. Re-clamping it here would hand a running field a smaller ceiling
      // than the tables it already has: seats past the new limit can be shed
      // but never refilled, and the break arithmetic in _breakIfPossible would
      // be counting capacity that does not exist.
      const savedSize = parseInt(saved.settings && saved.settings.tableSize, 10);
      if (saved.status === 'running' && Number.isFinite(savedSize) && savedSize >= 2) {
        settings.tableSize = savedSize;
      }
      const entry = buildEntry({
        id: saved.id,
        code: saved.code,
        name: saved.name,
        startsAt: Number(saved.startsAt) || now(),
        hostUid: saved.hostUid,
        settings,
        createdAt: saved.createdAt,
      });
      for (const e of saved.entrants || []) {
        // A file written before the bots were removed carries them; skip those
        // rows rather than choking on a tournament that is otherwise fine.
        if (e.isNPC) continue;
        entry.director.register({
          // A demo seat is played by the server, so it keeps an id of its own;
          // a person's seat waits for the socket they come back on.
          id: e.isBot ? e.uid : null,
          uid: e.uid,
          name: e.name,
          avatar: e.avatar || null,
          provider: e.provider || 'guest',
          isBot: !!e.isBot,
        });
      }
      for (const r of saved.registrations || []) {
        if (!r || !r.uid) continue;
        entry.registrations.set(r.uid, {
          socketId: null,
          disconnectedAt: null,
          joinedAt: r.joinedAt || entry.createdAt,
          left: false,
        });
      }
      if (entry.registrations.size === 0) continue;
      if (!entry.registrations.has(entry.hostUid)) {
        entry.hostUid = [...entry.registrations.keys()][0];
      }
      for (const uid of saved.mutedUids || []) entry.mutedUids.add(uid);
      // Chat comes back before, and regardless of, whether the field is seated
      // again. The rooms are keyed by a string and need no table object to
      // exist - and a field held by the restore guard below is precisely the
      // one somebody is trying to work out what happened to, so its chat is
      // the last thing that should vanish.
      if (chatStore) chat.hydrate(chatStore.load(saved.id));
      // A tournament that was mid-play when the process went down is seated
      // again from the field it recorded between hands. Every seat comes back
      // sitting out and is taken over by its player when they reconnect.
      // A field big enough to bring the process down is restored on boot and
      // brings it down again, and the restart policy makes that a loop the box
      // never gets out of. So a field that has been seated this many times
      // without managing to finish a single hand is left in the file but not
      // dealt: the tournament survives as its registrations, and somebody can
      // decide what to do with it.
      entry.restoreCount = (Number(saved.restoreCount) || 0) + 1;
      entry.restoredAt = now();
      const wasDealt = !!saved.field && (saved.status === 'running' || saved.held);
      if (wasDealt && (saved.held || entry.restoreCount > MAX_RESTORE_ATTEMPTS)) {
        entry.held = true;
        entry.heldField = saved.field;
        entry.waitingReason = 'This tournament could not be restarted; the field is held.';
      } else if (wasDealt) {
        try {
          if (entry.director.restoreFrom(saved.field)) {
            for (const table of entry.director.tables) wireTable(entry, table);
            resume(entry);
          }
        } catch (_err) {
          // A field that will not seat is not worth taking the whole
          // tournament down for; it falls back to its registrations.
        }
      }
      // Nobody is connected to a field that has just been seated, and the
      // clock the sweep abandons on is only ever started by a disconnect. So
      // it starts here: a field nobody returns to within the grace is cleared
      // the same as one everybody walked out of, instead of dealing to empty
      // seats until the process next goes down. Seats that fold every hand
      // never bust each other, so it would never finish on its own.
      if (entry.status === 'running') entry.noHumansSince = entry.restoredAt;
      tournaments.set(entry.id, entry);
      restored++;
    }
    if (restored) emitList();
    // Chat files whose tournament did not come back - it finished, or was
    // reaped while the process was down - have nothing left to belong to.
    if (chatStore) {
      for (const id of chatStore.listIds()) {
        if (!tournaments.has(id)) chatStore.remove(id);
      }
    }
    return restored;
  }

  startSweep();

  return {
    tournaments,
    create,
    join,
    bind,
    unbind,
    unregister,
    leave,
    startNow,
    cancel,
    forceCancel,
    stateFor,
    listFor,
    publicList,
    operatorList,
    findByUid,
    findPendingByUid,
    byCode,
    requireHost,
    admit,
    decline,
    withdraw,
    bindPending,
    unbindPending,
    postChat,
    postReaction,
    setChatMute,
    sendChatHistory,
    chat,
    chatEnabled,
    reactionsEnabled,
    reactions: reactionsEnabled ? reactions.REACTIONS.slice() : null,
    sweep,
    restore,
    flush,
    stop,
  };
}

module.exports = { createTournamentRegistry, TICK_MS };

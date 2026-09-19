// tournament-handlers.js - socket events for multi-table tournaments.
//
// A thin shim: every event resolves the socket's identity and tournament,
// then hands off to server/tournament-registry.js, which owns the lifecycle.
// Deliberately separate from socket-handlers.js: the single-table room code
// remains for its tests and is not touched by any of this.
//
// Table state reaches players by socket id (io.to(player.id)), not by
// socket.io room, so a player moved between tables simply starts receiving
// state from the new table. There is no room membership to migrate.

const { createTournamentRegistry } = require('./tournament-registry');
const { sameString } = require('./password');

// How many wrong passwords a single socket may offer before it stops being
// asked. Low, because there is nothing to guess at but one string, and a
// self-hosted box has no other brake on a client hammering an event.
// How often one socket may ask for a page of the log. Generous for a person
// reading and paging, mean against anything else.
const ADMIN_LOG_LIMIT = 30;
// The export is the largest thing one socket can ask the server to build, and
// a person clicking a download button does it once or twice. Well above that
// and well below anything that would cost.
const EXPORT_LIMIT = 6;
const EXPORT_WINDOW_MS = 60 * 1000;
const ADMIN_LOG_WINDOW_MS = 10 * 1000;
// Test messages from the Admin page. A person presses this once or twice while
// setting mail up; a loop is somebody making the server open connections to a
// host of their choosing.
const MAIL_TEST_LIMIT = 3;
const MAIL_TEST_WINDOW_MS = 60 * 1000;
// Signing in, signing up and asking for a reset, per socket. A person does
// each of these once or twice; a loop is somebody working through a list of
// passwords or making the server send mail to strangers.
const ACCOUNT_LIMIT = 8;
const ACCOUNT_WINDOW_MS = 60 * 1000;
const ACCOUNT_FAIL_DELAY_MS = 400;

// How often one socket may store a preference. Generous against a person
// pressing things and mean against a loop, because every save can put the
// whole identities file on the disk.
const PREF_SAVE_LIMIT = 12;
const PREF_SAVE_WINDOW_MS = 10 * 1000;

function registerTournamentHandlers(deps) {
  const { io, identity } = deps;
  const registry = createTournamentRegistry(deps);
  // The GameNight sign-in bridge. Read live on every use: the admin can
  // pair, refresh or unpair while the server runs. Unpaired, a GameNight
  // token is simply not a way in.
  const sso = deps.sso || { get: () => null, status: () => ({ paired: false }) };
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  // What the server has done, for the Admin page's Log. Absent in tests that
  // do not ask for it, so every call is guarded the way the logger dep is.
  const adminLog = deps.adminLog || null;
  // An account of this server's own, and the mail that verifies it. Both
  // absent on a server that has neither, where the lobby offers guests only.
  const accounts = deps.accounts || null;
  const mailer = deps.mailer || { available: () => false, why: () => null };
  // The word that claims this server while it has no administrator. Empty is
  // no claim: the event does not exist and the lobby never offers it. The
  // length rule is server.js's, applied before this is handed over.
  const claimToken = typeof deps.claimToken === 'string' ? deps.claimToken : '';
  // One claim at a time. The token check is instant but the password hash is
  // not, and two right answers racing through it would both find no
  // administrator. Server-wide, not per socket, for the same reason.
  let claiming = false;
  const settingsStore = deps.settingsStore || null;
  const serverSettings = deps.serverSettings || { status: () => ({}), apply: () => {} };
  const mail = deps.mail || {
    status: () => ({ mode: 'off', available: false }),
    apply: () => {},
    asTyped: () => ({}),
    redact: (t) => t,
    get: () => ({}),
  };

  const version = typeof deps.version === 'string' ? deps.version : '';
  // The build of index.html and its scripts this server hands out. A page
  // compares it with the one it was served with; a phone that kept a tab
  // alive across a deploy is otherwise old code talking to a new server.
  const assetVersion = typeof deps.assetVersion === 'string' ? deps.assetVersion : '';

  function serverInfo() {
    const live = sso.get();
    return {
      version,
      assetVersion,
      // Whether this server can make an account at all: it needs somewhere for
      // a link to point and a way to send one. The sign-in screen offers the
      // way to make one, or says why it cannot.
      accounts: !!accounts && mailer.available(),
      // Nobody administers this server yet, so the first account made here
      // will. Said out loud on the way in, because a server that has been
      // reachable for five minutes with this true has handed itself to
      // whoever got there first.
      unclaimed: identity.adminCount() === 0,
      // And whether the lobby should offer to claim it: no administrator, and
      // a token in the environment to claim it with. Never the token.
      claim: !!claimToken && identity.adminCount() === 0,
      // The set the strip draws, or null when the surface does not exist.
      reactions: registry.reactions,
      gamenight: live
        ? { connectUrl: live.config.connectUrl, audience: live.config.audience }
        : null,
    };
  }

  // The browser's own description of itself, used once to name a device on the
  // sessions list and never stored as it arrives. Truncated because a header
  // is whatever the client says it is.
  function userAgentOf(socket) {
    const headers = (socket && socket.handshake && socket.handshake.headers) || {};
    return String(headers['user-agent'] || '').slice(0, 400);
  }

  // Every socket this identity has open on this server. Signing a device out
  // has to reach the tab holding it, which may not be the one that pressed.
  // Found by the digest of the token, because that is what the identity store
  // deals in now. A socket holds the token itself, so each is hashed to
  // compare - there are a handful of sockets and this runs when somebody signs
  // a device out.
  function socketsForTokenHash(tokenHash) {
    const found = [];
    if (!tokenHash) return found;
    // The registry takes an injectable version of this for its tests; here the
    // real server is always the one asking.
    const live =
      typeof deps.connectedSockets === 'function'
        ? deps.connectedSockets()
        : io && io.sockets
          ? io.sockets.sockets.values()
          : [];
    for (const s of live) {
      if (s && s.data && s.data.token && identity.hashToken(s.data.token) === tokenHash) {
        found.push(s);
      }
    }
    return found;
  }

  // Every socket one person has open. What signing somebody out everywhere,
  // disabling them and deleting them all need: a token already in a browser
  // keeps working until the browser is told otherwise.
  function socketsForUid(uid) {
    const found = [];
    if (!uid) return found;
    const live =
      typeof deps.connectedSockets === 'function'
        ? deps.connectedSockets()
        : io && io.sockets
          ? io.sockets.sockets.values()
          : [];
    for (const s of live) {
      if (s && s.data && s.data.uid === uid) found.push(s);
    }
    return found;
  }

  // Enough of an address to recognise, not enough to be one. What the test
  // button echoes back: an administrator knows their own address and does not
  // need to be shown it, and the answer goes into a page anybody standing
  // behind them can read.
  function maskAddress(address) {
    const at = String(address || '').indexOf('@');
    if (at < 1) return '';
    return `${address[0]}***${address.slice(at)}`;
  }

  function fail(socket, error) {
    socket.emit('error', { message: error });
  }

  function notice(socket, message) {
    socket.emit('tournamentNotice', { message });
  }

  function entryFor(socket) {
    return registry.tournaments.get(socket.data.tournamentId) || null;
  }

  function seatFor(socket) {
    const entry = entryFor(socket);
    if (!entry) return null;
    return entry.director.playerByUid(socket.data.tournamentUid);
  }

  io.on('connection', (socket) => {
    // Cleared before anything else, because socket.io's connection recovery
    // restores socket.data wholesale for two minutes after a drop - which
    // would carry an administrator's grant straight through having it taken
    // away. identify() settles it again a moment from now, from the role on
    // the account, which is the only thing entitled to decide it.
    socket.data.isAdmin = false;
    // socket.io recovered this connection (same id, same data) after a short
    // drop: rebind the seat the disconnect handler released.
    if (socket.recovered && socket.data.tournamentId && socket.data.tournamentUid) {
      const entry = entryFor(socket);
      if (entry) registry.bind(entry, socket.data.tournamentUid, socket, { resumed: true });
    }
    // The same for somebody who was waiting at the door of an invite-only game.
    if (socket.recovered && socket.data.pendingTournamentId && socket.data.pendingUid) {
      const waiting = registry.tournaments.get(socket.data.pendingTournamentId);
      if (waiting) registry.bindPending(waiting, socket.data.pendingUid, socket, { resumed: true });
    }
    // What this server offers, before the client has said who it is: whether
    // there is an admin surface, and whether a GameNight sign-in exists and
    // where it goes. Never the password, never the key.
    socket.emit('serverInfo', serverInfo());

    // The list is not sent yet, and is not answered for until somebody has
    // said who they are. Every player has an account now, so the games running
    // here - their names, their hosts, how many are in them - are for the
    // people who can sit down at one rather than for anybody who loads the
    // page.
    socket.on('listTournaments', () => {
      if (!socket.data.uid) return;
      socket.emit('tournamentList', registry.listFor(socket.data.uid));
    });

    // First thing on every connect, reconnects included. Establishes who the
    // socket is and, when that person has a live registration, rebinds it.
    //
    // Two ways to say it, and both of them are a token. A player just back
    // from GameNight sends the signed one from the URL, once. Everybody else
    // sends the device token they were given when they signed in. A token this
    // server does not know is told so and shown the way in; there is nothing
    // here that turns a name into somebody.
    socket.on('identify', (payload = {}) => {
      let ident = null;
      if (typeof payload.gnToken === 'string') {
        const live = sso.get();
        if (!live) {
          return socket.emit('identifyFailed', { provider: 'gamenight', reason: 'not_configured' });
        }
        const result = live.verifier.verify(payload.gnToken);
        if (!result.ok) {
          log({
            level: 'warn',
            event: 'gamenight_token_rejected',
            message: 'GameNight sign-in token rejected',
            data: { reason: result.reason, socketId: socket.id },
          });
          return socket.emit('identifyFailed', { provider: 'gamenight', reason: result.reason });
        }
        ident = identity.identifyFromGameNight({
          sub: result.claims.sub,
          name: result.claims.name,
          avatar: payload.avatar,
          userAgent: userAgentOf(socket),
        });
        if (!ident)
          return socket.emit('identifyFailed', { provider: 'gamenight', reason: 'malformed' });
        if (ident.error) {
          return socket.emit('identifyFailed', { provider: 'gamenight', reason: ident.error });
        }
        log({
          level: 'info',
          event: 'gamenight_sign_in',
          message: 'Player signed in with GameNight',
          data: { uid: ident.uid, isNew: ident.isNew },
        });
      } else {
        // A token, and nothing else. There is no name here to be identified by
        // any more: a browser this server does not recognise is one with
        // nothing to sign in as, and the answer is the sign-in screen rather
        // than a seat.
        ident = identity.identify({ token: payload.token, avatar: payload.avatar });
        const provider = payload.provider === 'gamenight' ? 'gamenight' : 'local';
        if (!ident || ident.error) {
          const reason =
            ident && ident.error === 'disabled'
              ? 'disabled'
              : provider === 'gamenight'
                ? 'signed_out'
                : 'no-account';
          return socket.emit('identifyFailed', { provider, reason });
        }
        if (provider === 'gamenight' && ident.provider !== 'gamenight') {
          return socket.emit('identifyFailed', { provider: 'gamenight', reason: 'signed_out' });
        }
      }
      socket.data.uid = ident.uid;
      // Where the admin surface comes from now: the role on the account that
      // just identified. Settled here and nowhere else, so every guard below
      // is one line and there is one place to get it wrong.
      socket.data.isAdmin = identity.isAdmin(ident.uid);
      // Kept so this socket can be found when the device it belongs to is
      // signed out from somewhere else, and so the sessions list can say
      // which row is the one asking.
      socket.data.token = ident.token;
      const entry = registry.findByUid(ident.uid);
      let resume = null;
      let pending = null;
      if (entry) {
        registry.bind(entry, ident.uid, socket, { resumed: true });
        resume = { id: entry.id, code: entry.code, name: entry.name, status: entry.status };
      } else {
        // Not in a game, but perhaps waiting to be let into one.
        const waiting = registry.findPendingByUid(ident.uid);
        if (waiting) {
          registry.bindPending(waiting, ident.uid, socket, { resumed: true });
          pending = { id: waiting.id, name: waiting.name };
        } else {
          // Or on the rail of one.
          const railing = registry.findWatcherByUid(ident.uid);
          if (railing) {
            registry.bindWatcher(railing, ident.uid, socket, { resumed: true });
            resume = { id: railing.id, name: railing.name, status: railing.status, watching: true };
          }
        }
      }
      // Every way in, not only GameNight's: a guest identifying and a device
      // token coming back logged nothing at all before. Never the token.
      if (adminLog) {
        adminLog.recordSignIn({
          uid: ident.uid,
          name: ident.name,
          provider: ident.provider,
          isNew: ident.isNew,
        });
      }
      // Whether this person runs the server, which is what decides whether the
      // menu offers the Admin page. A fact about them rather than about the
      // server, so it could not be said before now.
      socket.emit('identified', { ...ident, resume, pending, isAdmin: !!socket.data.isAdmin });
      // The list this socket got on connect was built before it had a uid, so
      // none of its cards knew they were this player's. Send it again.
      socket.emit('tournamentList', registry.listFor(ident.uid));
    });

    // A preference the player just changed, to be kept against their identity
    // rather than their browser. The client writes it locally first and sends
    // this after, so the table never waits on the round trip; nothing here is
    // answered unless the record actually moved.
    //
    // Rate limited because this is a client asking the server to write a file
    // that holds every identity it has ever seen. A person changing a tab or
    // a chair does it a handful of times a minute; the cap is far above that
    // and far below what would matter.
    socket.on('savePreferences', (payload = {}) => {
      if (!socket.data.uid) return;
      const at = Date.now();
      const seen = socket.data.prefSaves || [];
      const recent = seen.filter((t) => at - t < PREF_SAVE_WINDOW_MS);
      if (recent.length >= PREF_SAVE_LIMIT) {
        socket.data.prefSaves = recent;
        return;
      }
      recent.push(at);
      socket.data.prefSaves = recent;
      const prefs = identity.setPrefs(socket.data.uid, payload);
      // Sent back so a second device sees what this one settled on when it
      // next identifies, and so a value this server refused does not sit in
      // the client believing it was kept.
      if (prefs) socket.emit('preferences', prefs);
    });

    // A player's own hands, to keep. Everything in it is what they could
    // already see at the table - their own holding, the board, every action,
    // and whatever was turned face up - because it is built with the same
    // redaction the replay panel has always used, applied to the whole game
    // rather than to a ten-hand window. Answered to anybody registered in the
    // game, seated or not: busting out is exactly when you want it.
    function exportAllowed() {
      if (!socket.data.uid) return false;
      const at = Date.now();
      const recent = (socket.data.historyAsks || []).filter((t) => at - t < EXPORT_WINDOW_MS);
      if (recent.length >= EXPORT_LIMIT) {
        socket.data.historyAsks = recent;
        return false;
      }
      recent.push(at);
      socket.data.historyAsks = recent;
      return true;
    }

    // With an id, a game that has been kept; without one, the game being
    // played now. A game somebody did not play in is refused rather than
    // redacted down to nothing: the two are different answers and only one of
    // them is honest.
    socket.on('exportHandHistory', async (payload = {}) => {
      if (!exportAllowed()) return;
      const id = payload && payload.id ? String(payload.id) : null;
      // A game that has been kept is read when it is asked for; the one being
      // played is in memory already.
      const game = id
        ? await registry.pastGameFor(socket.data.uid, id)
        : registry.handHistoryFor(socket.data.uid);
      socket.emit('handHistoryExport', game || { hands: [] });
    });

    // The games this player has played that are still kept. Names games,
    // never who else was in them.
    socket.on('listMyGames', async () => {
      if (!exportAllowed()) return;
      socket.emit('myGames', { games: await registry.pastGamesFor(socket.data.uid) });
    });

    // ── An account of this server's own ─────────────────────────────────
    //
    // Signing up, signing in, forgetting it and changing it. Every one of them
    // rate limited, and none of them ever saying whether a name has an account
    // - the answer to a wrong password and to a name nobody has taken is the
    // same sentence, because the difference between them is a list of who
    // plays here.
    //
    // Nothing here logs an address. It is the most sensitive thing this
    // server holds and it lives in one file.

    // The brake alone: one window per socket, shared by everything that takes
    // a name and a password or sends a mail. Signing in needs only this - an
    // account that exists works whether or not the server can send mail today.
    function accountRate() {
      if (!accounts) return false;
      const at = Date.now();
      const recent = (socket.data.accountAsks || []).filter((t) => at - t < ACCOUNT_WINDOW_MS);
      if (recent.length >= ACCOUNT_LIMIT) {
        socket.data.accountAsks = recent;
        return false;
      }
      recent.push(at);
      socket.data.accountAsks = recent;
      return true;
    }

    // The brake, for the things that send a mail: a sign-up and a reset are
    // nothing without one. Mail first, so a refused ask costs no slot.
    function accountAllowed() {
      return mailer.available() && accountRate();
    }

    // The tail of signing in, shared by the two doors that end there. An
    // identity for the account, or the sentence to show instead.
    function establishSession(who, payload = {}) {
      const ident = identity.signInAs({
        uid: who.uid,
        name: who.name,
        avatar: payload.avatar,
        userAgent: userAgentOf(socket),
      });
      if (!ident) return { error: 'That did not work.' };
      // The third door disabling has to close. The other two are inside the
      // identity store, on the paths that take a token; this one is here,
      // because signing in with a name and a password never touches them.
      if (ident.error === 'disabled') {
        return { error: 'That account has been suspended on this server.' };
      }
      return { ident };
    }

    // The name comes back with it: the client shows who it just became, and
    // it may not be quite what was typed - the account's own capitalisation
    // wins over whatever was in the box.
    function answerSignedIn(ident, extra = {}) {
      socket.emit('accountResult', {
        ok: true,
        signedIn: true,
        token: ident.token,
        name: ident.name,
        ...extra,
      });
    }

    socket.on('signUp', async (payload = {}) => {
      if (!accountAllowed()) return;
      // No identity needed, and usually none to have: signing up is how
      // somebody becomes anybody here. A socket that already has one is
      // somebody signed in claiming a second name, and keeps their uid.
      const started = await accounts.startSignUp({
        uid: socket.data.uid || null,
        name: payload.name,
        email: payload.email,
        password: payload.password,
      });
      if (started.error) return socket.emit('accountResult', { ok: false, error: started.error });
      log({
        level: 'info',
        event: 'account_signup_started',
        message: 'Account sign-up started',
        data: { uid: socket.data.uid, name: started.name },
      });
      Promise.resolve(
        mailer.sendVerification({ to: started.email, name: started.name, token: started.token })
      ).then((sent) => {
        socket.emit('accountResult', {
          ok: true,
          pending: true,
          message: sent
            ? 'Check your mail and open the link. It lasts a day, and the name is held for you until then.'
            : 'The mail could not be sent. Whoever runs this server can let you in from the Admin page - your name and password are kept for a day.',
        });
      });
    });

    // Answers with a device token and nothing else. The client then identifies
    // with it exactly as it does on any other load, so rejoining a game in
    // progress, the rail and everything else take the one path they always
    // took rather than a second copy of it here.
    socket.on('signIn', async (payload = {}) => {
      if (!accountRate()) return;
      const who = await accounts.signIn(payload.name, payload.password);
      if (!who) {
        return setTimeout(() => {
          socket.emit('accountResult', {
            ok: false,
            error: 'That name and password do not go together.',
          });
        }, ACCOUNT_FAIL_DELAY_MS);
      }
      const { ident, error } = establishSession(who, payload);
      if (error) return socket.emit('accountResult', { ok: false, error });
      log({
        level: 'info',
        event: 'account_sign_in',
        message: 'Player signed in with an account',
        data: { uid: ident.uid },
      });
      answerSignedIn(ident);
    });

    // Claiming the server: the first account on a box that has no
    // administrator, made by whoever holds the token in its environment. No
    // mail is involved, which is the point - the page where mail is set is
    // behind this door. The guard is "no administrator", not "born empty":
    // an upgraded server whose people predate the role is claimable too, and
    // the role is set here rather than left to the first-account rule.
    //
    // Silence when the event does not exist, as every admin event answers a
    // player. A wrong token is answered, after the same delay a wrong
    // password gets, and written down: it is somebody guessing at a public
    // page, and the rate window is the brake.
    socket.on('claimServer', async (payload = {}) => {
      if (!accounts || !claimToken) return;
      if (identity.adminCount() > 0) {
        return socket.emit('accountResult', {
          ok: false,
          error: 'This server has an administrator already.',
        });
      }
      if (!accountRate()) return;
      if (!sameString(String(payload.token || ''), claimToken)) {
        log({
          level: 'warn',
          event: 'claim_refused',
          message: 'Somebody offered the wrong claim token',
          data: { detail: 'The token did not match CLAIM_TOKEN in .env', name: payload.name },
        });
        return setTimeout(() => {
          socket.emit('accountResult', {
            ok: false,
            error:
              'That is not the claim token. It is CLAIM_TOKEN in the .env beside the compose file.',
          });
        }, ACCOUNT_FAIL_DELAY_MS);
      }
      if (claiming) {
        return socket.emit('accountResult', {
          ok: false,
          error: 'Somebody is claiming this server right now. Try again in a moment.',
        });
      }
      claiming = true;
      try {
        const made = await accounts.createWithPassword({
          uid: socket.data.uid || null,
          name: payload.name,
          email: payload.email,
          password: payload.password,
        });
        if (made.error) return socket.emit('accountResult', { ok: false, error: made.error });
        // The hash took a moment; somebody may have come through another
        // door meanwhile.
        if (identity.adminCount() > 0) {
          accounts.remove(made.uid);
          return socket.emit('accountResult', {
            ok: false,
            error: 'This server has an administrator already.',
          });
        }
        const { ident, error } = establishSession(made, payload);
        if (error) {
          // The same as the branch above: an account that never became a
          // session is not left holding the name.
          accounts.remove(made.uid);
          return socket.emit('accountResult', { ok: false, error });
        }
        // On a server that loaded empty the store granted this already, and
        // said so; on one that loaded people, this is the grant.
        identity.setRole(ident.uid, 'admin');
        log({
          level: 'info',
          event: 'server_claimed',
          message: 'The server was claimed from the lobby',
          data: { uid: ident.uid, name: ident.name },
        });
        if (adminLog) {
          adminLog.recordServer({
            level: 'info',
            event: 'server_claimed',
            message: `${ident.name} claimed this server from the lobby`,
          });
        }
        answerSignedIn(ident, { claimed: true });
        // Every open lobby stops offering the claim.
        announceServerInfo();
      } finally {
        claiming = false;
      }
    });

    socket.on('requestPasswordReset', (payload = {}) => {
      if (!accountAllowed()) return;
      const asked = accounts.startReset(payload.name);
      const answer = () =>
        socket.emit('accountResult', {
          ok: true,
          message: 'If that name has an account, a link is on its way. It works once, for an hour.',
        });
      if (!asked) return answer();
      Promise.resolve(
        mailer.sendReset({ to: asked.email, name: asked.name, token: asked.token })
      ).then(answer);
    });

    socket.on('changeAccountPassword', async (payload = {}) => {
      if (!accountRate() || !socket.data.uid) return;
      const problem = await accounts.changePassword(socket.data.uid, payload.current, payload.next);
      socket.emit('accountResult', {
        ok: !problem,
        error: problem || null,
        message: problem ? null : 'Password changed. Every device you are signed in on stays so.',
      });
    });

    // The devices this identity is signed in on. Answered only to the identity
    // itself, and never carrying a token: a row is named by an id minted
    // alongside it, so a page that leaked could not sign anybody in anywhere.
    socket.on('listSessions', () => {
      if (!socket.data.uid) return;
      socket.emit('sessions', identity.sessions(socket.data.uid, socket.data.token));
    });

    // Signing one out. The id authorises nothing on its own; the uid on this
    // socket is what says whose devices these are.
    socket.on('endSession', (payload = {}) => {
      if (!socket.data.uid) return;
      const id = typeof payload.id === 'string' ? payload.id : '';
      const uid = socket.data.uid;
      const dropped = identity.endSession(uid, id);
      if (!dropped) return socket.emit('sessions', identity.sessions(uid, socket.data.token));
      // Whoever was holding that token is told, wherever they are. Their own
      // socket included, when somebody signs out the device in their hand.
      for (const other of socketsForTokenHash(dropped)) {
        other.data.uid = null;
        other.data.token = null;
        other.emit('sessionEnded', { mine: other.id === socket.id });
      }
      // `dropped` is the digest of the token that went; this socket holds the
      // token itself. Compared as digests, because the store never hands one
      // of those back.
      if (dropped !== identity.hashToken(socket.data.token)) {
        socket.emit('sessions', identity.sessions(uid, socket.data.token));
      }
    });

    // Signing this browser out. It used to clear the browser and leave the
    // token good on the server for another thirty days, which meant a device
    // you had signed out of was still on your own list of devices.
    socket.on('signOut', () => {
      const token = socket.data.token;
      if (!token) return;
      identity.revokeToken(token);
      socket.data.uid = null;
      socket.data.token = null;
    });

    socket.on('createTournament', (payload = {}) => {
      const { error } = registry.create(socket.data.uid, payload, socket);
      if (error) fail(socket, error);
    });

    socket.on('joinTournament', (payload = {}) => {
      const { error } = registry.join(socket.data.uid, payload, socket);
      if (error) fail(socket, error);
    });

    function startNow() {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.startNow(entry, socket.data.uid);
      if (error) fail(socket, error);
    }
    socket.on('startTournamentNow', startNow);
    socket.on('startTournament', startNow); // pre-lobby client

    // Like the forfeit, this names the game when it has to: a host who busted
    // and went back to the lobby has no socket bound to it any more, and the
    // control they had at the table went with the table. registry.cancel is
    // the one that decides whether this uid may, as it always was.
    socket.on('cancelTournament', (payload = {}) => {
      const id = payload && payload.tournamentId ? String(payload.tournamentId) : '';
      const entry = (id && registry.tournaments.get(id)) || entryFor(socket);
      if (!entry) return;
      const { error } = registry.cancel(entry, socket.data.uid);
      if (error) fail(socket, error);
    });

    // The door of an invite-only game. The asker can withdraw; the host lets
    // people in or turns them away. Refusals go back on `error`, like the
    // rest of the host's controls.
    socket.on('cancelRequest', () => {
      const waiting = registry.tournaments.get(socket.data.pendingTournamentId);
      if (!waiting) return;
      registry.withdraw(waiting, socket.data.pendingUid, socket);
    });

    // The rail: watch a game by its rail code, or by id when it is public.
    socket.on('watchTournament', (payload = {}) => {
      const { error } = registry.watch(
        socket.data.uid,
        { rail: payload.rail, tournamentId: payload.tournamentId },
        socket
      );
      if (error) fail(socket, error);
    });

    socket.on('watchTable', (payload = {}) => {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.watchTable(entry, socket.data.tournamentUid, payload.table);
      if (error) fail(socket, error);
    });

    socket.on('stopWatching', () => {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.unwatch(entry, socket.data.tournamentUid, socket);
      if (error) fail(socket, error);
    });

    // Re-entry after busting and the add-on at the first break. A refusal
    // here is an answer to a button the player pressed, so it goes out as a
    // notice they will see; `error` is only a log line once at the table.
    // Both of these are asked for from the table and from the lobby. A player
    // who busted and walked out has nothing on this socket pointing at the
    // game any more, so the card names it, and the identity does the rest.
    socket.on('reenterTournament', (payload = {}) => {
      const id = payload && payload.tournamentId ? String(payload.tournamentId) : '';
      const entry = (id && registry.tournaments.get(id)) || entryFor(socket);
      if (!entry) return;
      const { error } = registry.reenter(entry, socket.data.uid, socket);
      if (error) notice(socket, error);
    });

    socket.on('takeAddOn', (payload = {}) => {
      const id = payload && payload.tournamentId ? String(payload.tournamentId) : '';
      const entry = (id && registry.tournaments.get(id)) || entryFor(socket);
      if (!entry) return;
      const { error } = registry.takeAddOn(entry, socket.data.uid, socket);
      if (error) notice(socket, error);
    });

    socket.on('admitPlayer', (payload = {}) => {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.admit(entry, socket.data.tournamentUid, String(payload.uid || ''));
      if (error) fail(socket, error);
    });

    socket.on('declinePlayer', (payload = {}) => {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.decline(
        entry,
        socket.data.tournamentUid,
        String(payload.uid || '')
      );
      if (error) fail(socket, error);
    });

    // The host's controls over a running game. Authorised in the registry;
    // refusals go back on `error` like the door's.
    socket.on('pauseTournament', () => {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.pause(entry, socket.data.tournamentUid);
      if (error) fail(socket, error);
    });

    socket.on('resumeTournament', () => {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.resume(entry, socket.data.tournamentUid);
      if (error) fail(socket, error);
    });

    socket.on('stepLevel', (payload = {}) => {
      const entry = entryFor(socket);
      const delta = Number(payload.delta);
      if (!entry || !delta) return;
      const { error } = registry.stepLevel(entry, socket.data.tournamentUid, delta);
      if (error) fail(socket, error);
    });

    socket.on('adjustClock', (payload = {}) => {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.adjustClock(entry, socket.data.tournamentUid, payload.seconds);
      if (error) fail(socket, error);
    });

    socket.on('removePlayer', (payload = {}) => {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.removePlayer(
        entry,
        socket.data.tournamentUid,
        String(payload.uid || '')
      );
      if (error) fail(socket, error);
    });

    socket.on('movePlayer', (payload = {}) => {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.movePlayer(
        entry,
        socket.data.tournamentUid,
        String(payload.uid || ''),
        parseInt(payload.table, 10)
      );
      if (error) fail(socket, error);
    });

    socket.on('unregisterTournament', () => {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.unregister(entry, socket.data.uid, socket);
      if (error) fail(socket, error);
    });

    function leave() {
      const entry = entryFor(socket);
      if (!entry) return;
      const { error } = registry.leave(entry, socket.data.uid, socket);
      if (error) fail(socket, error);
    }
    socket.on('leaveTournament', leave);
    socket.on('exitGame', leave); // the table's menu says "exit"

    // Conceding works from the table and from the lobby both. A player who
    // already walked out is exactly the one whose stack is blinding down with
    // nobody behind it, so the card that offers Rejoin can offer this instead,
    // and it names the game rather than relying on a socket bound to it.
    socket.on('forfeitTournament', (payload = {}) => {
      const id = payload.tournamentId ? String(payload.tournamentId) : '';
      const entry = (id && registry.tournaments.get(id)) || entryFor(socket);
      if (!entry) return;
      const { error } = registry.forfeit(entry, socket.data.uid, socket);
      if (error) notice(socket, error);
    });

    function sendState() {
      const entry = entryFor(socket);
      if (!entry) return;
      const state = registry.stateFor(entry, socket.data.tournamentUid);
      socket.emit('tournamentState', state);
      socket.emit('tournamentField', state); // pre-lobby client
    }
    socket.on('requestTournamentState', sendState);
    socket.on('requestTournamentField', sendState);

    // The mobile resume path: mark us present again and resend everything.
    socket.on('requestState', () => {
      const entry = entryFor(socket);
      if (!entry) return;
      if (!registry.bind(entry, socket.data.tournamentUid, socket, { resumed: true })) {
        registry.bindWatcher(entry, socket.data.tournamentUid, socket, { resumed: true });
      }
    });

    // Actions are routed by uid, never by a cached table: a player's table
    // changes when the field is balanced and their socket id changes on
    // reconnect, so the seat has to be looked up fresh every time.
    function routeAction(payload = {}) {
      const VALID = ['fold', 'check', 'call', 'raise', 'allin'];
      if (!VALID.includes(payload.action)) return;
      const amount = payload.amount;
      if (amount !== undefined && (typeof amount !== 'number' || amount < 0 || !isFinite(amount))) {
        return;
      }
      const seat = seatFor(socket);
      if (!seat) return;
      seat.table.handleAction(seat.player.id, payload.action, amount);
    }
    // The table UI emits 'action' whatever kind of table it is showing; the
    // single-table listener ignores tournament sockets (no room of that id).
    socket.on('action', routeAction);
    socket.on('tournamentAction', routeAction);

    // Turning a card over after taking a pot nobody contested. The engine is
    // the judge of whether the offer still stands and whose it is; this only
    // finds the seat, which is looked up fresh because a player's table moves
    // when the field is balanced.
    socket.on('showCards', (payload = {}) => {
      const seat = seatFor(socket);
      if (!seat) return;
      const raw = payload && payload.cards;
      const cards = (Array.isArray(raw) ? raw : [raw]).map((n) => parseInt(n, 10));
      if (!cards.length || cards.some((n) => n !== 0 && n !== 1)) return;
      seat.table.showHoleCards(seat.player.id, cards);
    });

    socket.on('declineShow', () => {
      const seat = seatFor(socket);
      if (!seat) return;
      seat.table.declineShow(seat.player.id);
    });

    socket.on('requestTime', () => {
      const seat = seatFor(socket);
      if (!seat) return;
      seat.table.requestTimeExtension(seat.player.id);
    });

    socket.on('setAutoPlay', (payload = {}) => {
      const seat = seatFor(socket);
      if (!seat) return;
      const { table, player } = seat;
      const enabled = payload.enabled !== false;
      if (player.autoPlay === enabled) return;
      player.autoPlay = enabled;
      // Asked for, so it survives a reconnect: resumeSeat() leaves this one
      // alone where it undoes a drop, a timeout or a walk-out.
      player.sitOutReason = enabled ? 'requested' : null;
      player.isReady = false;
      // Sitting out now settles anything that was waiting on later: an armed
      // line, and a sit-out that was queued for the next deal.
      if (enabled) {
        player.preAction = null;
        player.sitOutNextHand = false;
      }
      table.emitMessage(`${player.name} ${enabled ? 'is sitting out' : 'is back at the table'}`, {
        kind: 'system',
      });
      const idx = table.players.findIndex((p) => p.id === player.id);
      if (enabled && table.isRunning && idx === table.currentPlayerIndex) table.beginCurrentTurn();
      else table.emitUpdate();
    });

    // Arming a line for a turn that has not opened yet. It lives on the engine's
    // player record rather than in the page, so it survives a reload, a phone
    // locking itself and a dropped connection — which is most of why it is
    // worth having. Nothing about it is public, so the echo goes to this socket
    // alone rather than out to the table.
    socket.on('armPreAction', (payload = {}) => {
      const KINDS = ['checkfold', 'check', 'call', 'callany'];
      const kind = payload.kind == null ? null : payload.kind;
      if (kind !== null && !KINDS.includes(kind)) return;
      // A price-locked call carries the price it was armed at, and the engine
      // refuses to play it at any other. Integers, because chips are.
      let atBet = null;
      let atToCall = null;
      if (kind === 'call') {
        if (!Number.isInteger(payload.atBet) || payload.atBet < 0) return;
        if (!Number.isInteger(payload.atToCall) || payload.atToCall < 0) return;
        atBet = payload.atBet;
        atToCall = payload.atToCall;
      }
      const seat = seatFor(socket);
      if (!seat) return;
      const { table, player } = seat;
      if (player.autoPlay) return;
      // Arming is for a turn you do not have yet. With the action bar up the bar
      // is the way to act, and accepting both is how a click races the beat.
      const idx = table.players.findIndex((p) => p.id === player.id);
      if (table.isRunning && idx === table.currentPlayerIndex) return;
      const before = player.preAction;
      // No-op guard, as on setAutoPlay above: a state payload carries the last
      // ten hands, so an unguarded echo turns arm-spam into an amplifier.
      if (
        (before ? before.kind : null) === kind &&
        (before ? before.atBet : null) === atBet &&
        (before ? before.atToCall : null) === atToCall
      ) {
        return;
      }
      player.preAction = kind === null ? null : { kind, atBet, atToCall };
      socket.emit('gameState', table.getStateForPlayer(player.id, { includeHistory: false }));
    });

    // The deferred sit-out. Unlike setAutoPlay it leaves the hand in progress
    // alone; startRound consumes it. Strictly === true, where setAutoPlay reads
    // !== false: a malformed payload must not cost somebody a hand of blinds.
    socket.on('setSitOutNextHand', (payload = {}) => {
      const enabled = payload.enabled === true;
      const seat = seatFor(socket);
      if (!seat) return;
      const { table, player } = seat;
      if (!!player.sitOutNextHand === enabled) return;
      player.sitOutNextHand = enabled;
      socket.emit('gameState', table.getStateForPlayer(player.id, { includeHistory: false }));
    });

    // ── Admin controls ────────────────────────────────────────────────
    //
    // There is no unlock here any more, and no password to send: the admin
    // surface belongs to an account, and socket.data.isAdmin was settled at
    // identify from the role on that account. Every handler below keeps the
    // same one-line guard it always had.
    //
    // What that bought, besides one fewer secret: it survives a reconnect, it
    // cannot be guessed, it is per person rather than per server, and taking
    // it away from somebody reaches the browser they are holding.

    // End a tournament that is already running. The host control for this only
    // exists in the waiting room, and the host of a running field may be a seat
    // that busted an hour ago, so without this there is no way to stop one
    // short of shell access.
    socket.on('adminCancelTournament', (payload = {}) => {
      if (!socket.data.isAdmin) return;
      const entry =
        (payload.id && registry.tournaments.get(payload.id)) || entryFor(socket) || null;
      if (!entry) return fail(socket, 'No tournament to cancel');
      const result = registry.forceCancel(entry, 'cancelled by the admin');
      if (result.error) return fail(socket, result.error);
    });

    // What the server has done. The same unlock as everything else here, and a
    // rate limit as well: this one reads a file of its own and an admin paging
    // through it is a handful of asks, not a loop.
    socket.on('adminLog', (payload = {}) => {
      if (!socket.data.isAdmin) return;
      if (!adminLog) return socket.emit('adminLogRows', { rows: [], more: false });
      const at = Date.now();
      const recent = (socket.data.adminLogAsks || []).filter((t) => at - t < ADMIN_LOG_WINDOW_MS);
      if (recent.length >= ADMIN_LOG_LIMIT) {
        socket.data.adminLogAsks = recent;
        return;
      }
      recent.push(at);
      socket.data.adminLogAsks = recent;
      const before = Number(payload.before);
      const from = Number.isFinite(before) ? before : null;
      socket.emit('adminLogRows', {
        ...adminLog.list({ limit: payload.limit, before: from }),
        // Which page this is, echoed back. The newest page replaces what the
        // reader has; an older one is added to it, and a refresh that arrives
        // while a "show older" is in flight must not be mistaken for it.
        before: from,
      });
    });

    // Every game on the server, listed or not, with its code: the Admin
    // page's list. Answered only to a socket that has unlocked the controls,
    // like the pairing below; anyone else gets silence.
    socket.on('adminListTournaments', () => {
      if (!socket.data.isAdmin) return;
      socket.emit('adminTournaments', { list: registry.adminList() });
    });

    // The GameNight pairing, from the Admin page. All four answer on
    // adminGameNight, and a change is announced to every socket as a fresh
    // serverInfo so the button appears or goes without a reload. Nobody who
    // is not an administrator gets an answer at all.
    function sendPairing(extra = {}) {
      socket.emit('adminGameNight', { ...sso.status(), ...extra });
    }
    // Nothing about this is pairing-specific: the mail settings need the same
    // call, because whether an account can be made is in serverInfo too.
    function announceServerInfo() {
      io.emit('serverInfo', serverInfo());
    }
    // ── The people who play here ──────────────────────────────────────
    //
    // The list is the identity map, which is in memory already, so none of
    // this is a query. Searched, filtered and paged on the server all the
    // same: the page polls every three seconds, and a server with a thousand
    // players should not send a thousand rows to show twenty-five.
    //
    // Every write answers adminUserResult and then a fresh list, so the page
    // never has to guess what it now looks like.

    // Who is waiting on a link, for the same page. The address is masked
    // here, the way the mail test echoes one back: enough to recognise, not
    // enough to be one, in a list that is polled.
    function pendingRows() {
      if (!accounts) return [];
      return accounts.pendingList().map((row) => ({
        name: row.name,
        email: maskAddress(row.email),
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      }));
    }

    function usersPayload(query) {
      return { ...identity.list(query || {}), pending: pendingRows() };
    }

    function usersResult(error, extra = {}) {
      socket.emit('adminUserResult', { ok: !error, error: error || null, ...extra });
      if (!error) socket.emit('adminUsers', usersPayload(socket.data.adminUserQuery));
    }

    // Somebody the administrator is acting on. Answers the record, or the
    // sentence to show them instead.
    function subjectFor(uid) {
      const who = identity.get(uid);
      if (!who) return { error: 'There is nobody here by that name.' };
      return { who };
    }

    socket.on('adminListUsers', (payload = {}) => {
      if (!socket.data.isAdmin) return;
      const query = {
        q: String(payload.q || '').slice(0, 64),
        filter: ['admin', 'disabled'].includes(payload.filter) ? payload.filter : 'all',
        limit: payload.limit,
        offset: payload.offset,
      };
      // Kept so a write can answer with the page they were looking at rather
      // than the first one.
      socket.data.adminUserQuery = query;
      socket.emit('adminUsers', usersPayload(query));
    });

    // Somebody whose link never arrived, let in by an administrator. They
    // sign in with the name and password they chose at sign-up; nothing is
    // sent and nobody is told a secret.
    socket.on('adminAdmitUser', (payload = {}) => {
      if (!socket.data.isAdmin) return;
      if (!accounts) return usersResult('This server keeps no accounts.');
      const admitted = accounts.admit(String(payload.name || ''));
      if (admitted.error) return usersResult(admitted.error);
      // A person as well as an account, so the page that just let them in can
      // see them. No devices: they have not signed in yet.
      identity.create({ uid: admitted.uid, name: admitted.name });
      if (adminLog) {
        adminLog.recordServer({
          level: 'info',
          event: 'admin_admitted',
          message: `An administrator let ${admitted.name} in without the link`,
        });
      }
      usersResult(null, { admitted: admitted.name });
    });

    // One person, with the things the list deliberately leaves out. The
    // address is the reason this is its own event: it is the most sensitive
    // thing the server holds about somebody, the list is polled, and a page
    // that put every address in every poll would be a mailing list waiting to
    // leak. Looking at one is written down.
    socket.on('adminGetUser', async (payload = {}) => {
      if (!socket.data.isAdmin) return;
      const uid = String(payload.uid || '');
      const found = subjectFor(uid);
      if (found.error) return socket.emit('adminUser', { error: found.error });
      const account = accounts ? accounts.byUid(uid) : null;
      const row = identity.list({ q: '', limit: 50 }).rows.find((r) => r.uid === uid) || null;
      let games = 0;
      try {
        games = (await registry.pastGamesFor(uid)).length;
      } catch (_err) {
        games = 0;
      }
      if (account && account.email && adminLog) {
        adminLog.recordServer({
          level: 'info',
          event: 'admin_read_address',
          message: `An administrator looked at ${found.who.name}'s address`,
        });
      }
      socket.emit('adminUser', {
        user: {
          ...(row || {}),
          uid,
          name: found.who.name,
          provider: found.who.provider,
          email: account ? account.email : null,
          verifiedAt: account ? account.verifiedAt : null,
          hasAccount: !!account,
          games,
          sessions: identity.sessions(uid).map((d) => ({ ...d, current: undefined })),
          online: socketsForUid(uid).length,
        },
      });
    });

    // An account an administrator made, for somebody to take over. No
    // password is set here: a reset link goes out, and choosing one from that
    // link is what makes it usable - so the administrator never knows it,
    // which is the only sensible way to hand one over.
    socket.on('adminCreateUser', (payload = {}) => {
      if (!socket.data.isAdmin) return;
      if (!accounts) return usersResult('This server keeps no accounts.');
      if (!mailer.available()) {
        return usersResult('This server cannot send the mail that hands an account over.');
      }
      const made = accounts.createVerified({ name: payload.name, email: payload.email });
      if (made.error) return usersResult(made.error);
      // A person as well as an account, so the page that just made them can
      // see them. They have no devices, which is what somebody who has never
      // signed in looks like.
      identity.create({ uid: made.uid, name: made.name });
      const asked = accounts.startReset(made.name);
      if (asked) {
        Promise.resolve(
          mailer.sendReset({ to: asked.email, name: asked.name, token: asked.token })
        ).catch(() => {});
      }
      if (adminLog) {
        adminLog.recordServer({
          level: 'info',
          event: 'admin_made_account',
          message: `An administrator made an account for ${made.name}`,
        });
      }
      usersResult(null, { made: made.name });
    });

    socket.on('adminSetUserRole', (payload = {}) => {
      if (!socket.data.isAdmin) return;
      const uid = String(payload.uid || '');
      const found = subjectFor(uid);
      if (found.error) return usersResult(found.error);
      const admin = payload.role === 'admin';
      // Standing down is allowed; leaving the server with nobody to run it is
      // not. The same question guards demote, disable and delete.
      if (!admin && identity.wouldOrphan(uid)) {
        return usersResult('Somebody has to administer this server.');
      }
      if (admin && identity.isDisabled(uid)) {
        return usersResult('That account is suspended. Let them back in first.');
      }
      identity.setRole(uid, admin ? 'admin' : 'player');
      // Whoever it was needs to hear it, including on the tab they are
      // reading the Admin page in.
      for (const other of socketsForUid(uid)) {
        other.data.isAdmin = admin;
        if (!admin) other.emit('adminStatus', { ok: false, revoked: true });
      }
      if (adminLog) {
        adminLog.recordServer({
          level: 'info',
          event: admin ? 'admin_granted' : 'admin_revoked',
          message: `${found.who.name} ${admin ? 'is now' : 'is no longer'} an administrator`,
        });
      }
      usersResult(null);
    });

    socket.on('adminSetUserDisabled', (payload = {}) => {
      if (!socket.data.isAdmin) return;
      const uid = String(payload.uid || '');
      const found = subjectFor(uid);
      if (found.error) return usersResult(found.error);
      const off = payload.disabled !== false;
      if (off && uid === socket.data.uid) return usersResult('You cannot suspend yourself.');
      if (off && identity.wouldOrphan(uid)) {
        return usersResult('Somebody has to administer this server.');
      }
      identity.setDisabled(uid, off ? Date.now() : null);
      if (off) endEveryDevice(uid);
      if (adminLog) {
        adminLog.recordServer({
          level: 'info',
          event: off ? 'admin_suspended' : 'admin_unsuspended',
          message: `${found.who.name} ${off ? 'was suspended' : 'was let back in'}`,
        });
      }
      usersResult(null);
    });

    socket.on('adminSignOutUser', (payload = {}) => {
      if (!socket.data.isAdmin) return;
      const uid = String(payload.uid || '');
      const found = subjectFor(uid);
      if (found.error) return usersResult(found.error);
      endEveryDevice(uid);
      usersResult(null);
    });

    // Somebody forgot theirs. A link rather than a password the administrator
    // chooses and then knows.
    socket.on('adminResetUserPassword', (payload = {}) => {
      if (!socket.data.isAdmin) return;
      const uid = String(payload.uid || '');
      const found = subjectFor(uid);
      if (found.error) return usersResult(found.error);
      if (found.who.provider === 'gamenight') {
        return usersResult('That password is GameNight’s. It is reset there.');
      }
      if (!accounts || !mailer.available()) {
        return usersResult('This server cannot send mail.');
      }
      const asked = accounts.startReset(found.who.name);
      if (!asked) return usersResult('That account has nothing to reset.');
      Promise.resolve(
        mailer.sendReset({ to: asked.email, name: asked.name, token: asked.token })
      ).catch(() => {});
      usersResult(null, { sent: found.who.name });
    });

    socket.on('adminDeleteUser', (payload = {}) => {
      if (!socket.data.isAdmin) return;
      const uid = String(payload.uid || '');
      const found = subjectFor(uid);
      if (found.error) return usersResult(found.error);
      if (uid === socket.data.uid) return usersResult('You cannot delete yourself.');
      if (identity.wouldOrphan(uid)) return usersResult('Somebody has to administer this server.');
      // A GameNight account is not this server's to delete: the uid comes
      // from their id there, so the next sign-in would put it straight back -
      // and it would come back without the suspension, which is worse than
      // not deleting it at all.
      if (found.who.provider === 'gamenight') {
        return usersResult('A GameNight account comes back on its next sign-in. Suspend it.');
      }
      endEveryDevice(uid);
      if (accounts) accounts.remove(uid);
      identity.remove(uid);
      if (adminLog) {
        adminLog.recordServer({
          level: 'info',
          event: 'admin_deleted_account',
          message: `An administrator deleted the account ${found.who.name}`,
        });
      }
      usersResult(null);
    });

    // Every token that person is holding, and every browser told. Used by
    // signing out, by suspending and by deleting.
    function endEveryDevice(uid) {
      identity.revokeAll(uid);
      for (const other of socketsForUid(uid)) {
        other.data.uid = null;
        other.data.token = null;
        other.data.isAdmin = false;
        other.emit('sessionEnded', { mine: false });
      }
    }

    // ── Where this server sends from ──────────────────────────────────
    //
    // Three events, the same shape as the pairing's four. The password is
    // never in an answer: status() leaves it out, and the test button's error
    // is run through the redactor first, because an SMTP server quotes what it
    // was given more often than anybody expects and this one reaches a browser
    // and the admin Log.
    function sendMail(extra = {}) {
      socket.emit('adminMail', { ...mail.status(), ...extra });
    }

    socket.on('adminGetMail', () => {
      if (!socket.data.isAdmin) return;
      sendMail();
    });

    socket.on('adminSetMail', async (payload = {}) => {
      if (!socket.data.isAdmin) return;
      mail.apply(payload);
      // Waited for, unlike every other setting. A pairing that failed to write
      // is re-fetchable and an obviously stale one; a password that failed to
      // write is a mail server that works until the next restart and then
      // quietly does not, with "Saved" on the screen either way.
      try {
        if (settingsStore && settingsStore.saved) await settingsStore.saved();
      } catch (err) {
        return sendMail({
          ok: false,
          error: `Saved here, but not written down: ${(err && err.message) || 'the database said no'}`,
        });
      }
      announceServerInfo();
      if (adminLog) {
        adminLog.recordServer({
          level: 'info',
          event: 'admin_set_mail',
          message: 'An administrator set where this server sends from',
        });
      }
      sendMail({ ok: true });
    });

    // The form as typed, rather than what is saved - otherwise setting a mail
    // server up is still guess, save, restart, guess. Sends only to the
    // administrator's own address, which is what stops the button being a
    // small open relay.
    socket.on('adminTestMail', async (payload = {}) => {
      if (!socket.data.isAdmin) return;
      const at = Date.now();
      const recent = (socket.data.mailTests || []).filter((t) => at - t < MAIL_TEST_WINDOW_MS);
      if (recent.length >= MAIL_TEST_LIMIT) {
        socket.data.mailTests = recent;
        // Answered rather than ignored: silence on a button somebody just
        // pressed reads as a broken page.
        return sendMail({ ok: false, error: 'That is enough for one minute.' });
      }
      recent.push(at);
      socket.data.mailTests = recent;
      if (socket.data.mailTestBusy) return;

      const who = identity.get(socket.data.uid);
      const account = accounts ? accounts.byUid(socket.data.uid) : null;
      const to = account && account.email ? account.email : null;
      if (!to) {
        return sendMail({
          ok: false,
          error:
            who && who.provider === 'gamenight'
              ? 'Your account is a GameNight one, so this server has no address for you.'
              : 'There is no address on your account to send it to.',
        });
      }

      socket.data.mailTestBusy = true;
      const trying = mail.asTyped(payload);
      const settled = mail.get();
      try {
        // Tried on the live mailer, then put back however it was. The window
        // is the length of one connection and this is the admin page, so a
        // message going out in the middle of it goes through the settings
        // being tested - which is what was asked for.
        mail.apply(trying, { persist: false });
        const checked = await mailer.verify();
        if (!checked.ok) {
          return sendMail({ ok: false, error: mail.redact(checked.error) });
        }
        const sent = payload.send === false ? { ok: true } : await mailer.sendTest({ to });
        if (!sent.ok) return sendMail({ ok: false, error: mail.redact(sent.error) });
        sendMail({ ok: true, sentTo: maskAddress(to), logged: !!sent.logged });
      } catch (err) {
        sendMail({ ok: false, error: mail.redact((err && err.message) || 'That did not work.') });
      } finally {
        mail.apply(settled, { persist: false, source: settled.source });
        socket.data.mailTestBusy = false;
      }
    });

    // ── The knobs ─────────────────────────────────────────────────────
    //
    // Two events. Every row carries when it takes effect, so the page can say
    // so rather than implying they are all immediate - which they are not, and
    // the difference between "now" and "the next game" is the difference
    // between a control that works and one that looks broken.
    function sendServerSettings(extra = {}) {
      socket.emit('adminServer', { ...serverSettings.status(), ...extra });
    }

    socket.on('adminGetServer', () => {
      if (!socket.data.isAdmin) return;
      sendServerSettings();
    });

    socket.on('adminSetServer', (payload = {}) => {
      if (!socket.data.isAdmin) return;
      serverSettings.apply(payload);
      // Whether reactions exist is in serverInfo, so the strip appears and
      // vanishes in every open browser rather than on the next reload.
      announceServerInfo();
      if (adminLog) {
        adminLog.recordServer({
          level: 'info',
          event: 'admin_set_server',
          message: 'An administrator changed the server settings',
        });
      }
      sendServerSettings({ ok: true });
    });

    socket.on('adminGetGameNight', () => {
      if (!socket.data.isAdmin) return;
      sendPairing();
    });
    socket.on('adminPairGameNight', async (payload = {}) => {
      if (!socket.data.isAdmin) return;
      try {
        await sso.pair(payload.url, payload.audience);
        announceServerInfo();
        sendPairing({ ok: true });
      } catch (err) {
        sendPairing({ ok: false, error: err.message });
      }
    });
    socket.on('adminRefreshGameNight', async () => {
      if (!socket.data.isAdmin) return;
      try {
        await sso.refresh();
        announceServerInfo();
        sendPairing({ ok: true });
      } catch (err) {
        sendPairing({ ok: false, error: err.message });
      }
    });
    socket.on('adminUnpairGameNight', () => {
      if (!socket.data.isAdmin) return;
      sso.unpair();
      announceServerInfo();
      sendPairing({ ok: true });
    });

    // Chat. Deliberately its own event rather than a kind of gameMessage: the
    // client picks sound effects and the result modal off substrings of a
    // gameMessage, so somebody typing "all-in" would play the all-in sound for
    // the whole table and "wins" would pop the winner screen.
    socket.on('chat', (payload = {}) => {
      if (!registry.chatEnabled) return;
      if (typeof payload.text !== 'string') return;
      const entry = entryFor(socket);
      if (!entry) return;
      // Where the host wants it: a table number or 'all'. Anything else is
      // dropped here, and the registry ignores it from anyone but the host.
      const to =
        payload.to === 'all'
          ? 'all'
          : Number.isInteger(payload.to) && payload.to > 0
            ? payload.to
            : undefined;
      const result = registry.postChat(entry, socket.data.tournamentUid, payload.text, socket, {
        to,
      });
      // A refusal goes back on its own event, not through fail(): the client
      // routes 'error' to a lobby dialog, and a rate limit is not a dialog.
      if (result.error) socket.emit('chatDenied', { reason: result.error });
    });

    // A reaction: one of a fixed set, thrown at the room. Refusals ride
    // chatDenied, because the reasons are chat's reasons and the note under
    // the composer is where a player already looks for them.
    socket.on('reaction', (payload = {}) => {
      if (!registry.reactionsEnabled) return;
      const entry = entryFor(socket);
      if (!entry) return;
      const result = registry.postReaction(entry, socket.data.tournamentUid, payload.emoji, socket);
      if (result.error) socket.emit('chatDenied', { reason: result.error });
    });

    socket.on('muteChat', (payload = {}) => {
      if (!registry.chatEnabled) return;
      const entry = entryFor(socket);
      if (!entry) return;
      const result = registry.setChatMute(
        entry,
        socket.data.tournamentUid,
        String(payload.uid || ''),
        payload.muted === true
      );
      if (result.error) return fail(socket, result.error);
    });

    socket.on('disconnect', () => {
      const waiting = registry.tournaments.get(socket.data.pendingTournamentId);
      if (waiting) registry.unbindPending(waiting, socket.data.pendingUid, socket);
      const entry = entryFor(socket);
      if (!entry) return;
      registry.unbind(entry, socket.data.tournamentUid, socket);
      registry.unbindWatcher(entry, socket.data.tournamentUid, socket);
    });
  });

  return {
    registry,
    tournaments: registry.tournaments,
    publicList: registry.publicList,
    listFor: registry.listFor,
  };
}

module.exports = { registerTournamentHandlers };

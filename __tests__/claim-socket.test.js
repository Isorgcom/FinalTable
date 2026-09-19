// __tests__/claim-socket.test.js - claiming a server from the lobby.
//
// A fresh server has no administrator and, more often than not, no mail yet.
// The claim is the door that needs neither: a token in the environment, and
// whoever opens the lobby with it makes the first account, which runs the
// server. Everything here is about that door - when it is offered, who it
// answers, and that it shuts behind the first person through.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: Client } = require('socket.io-client');
const { accountFor } = require('./helpers/account');

jest.setTimeout(20000);

const TOKEN = 'a-long-enough-claim-token';

// One server per describe, booted the way admin-disabled.test.js boots: no
// mail, no GameNight. The boot events are captured by subscribing before the
// server module loads, because claim_open and friends are said in startServer
// and claim_token_short before it.
function serverSuite(name, env, body) {
  describe(name, () => {
    const originalEnv = { ...process.env };
    const sockets = [];
    const events = [];
    const ctx = { events, sockets };
    let tempDir;

    beforeAll(async () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-claim-'));
      process.env.SAVE_DIR = tempDir;
      process.env.HOST = '127.0.0.1';
      delete process.env.ADMIN_PASSWORD;
      delete process.env.ADMIN_PROMOTE;
      delete process.env.PUBLIC_URL;
      delete process.env.SMTP_URL;
      delete process.env.MAIL_TRANSPORT;
      delete process.env.GAMENIGHT_URL;
      delete process.env.GAMENIGHT_PUBLIC_KEY;
      delete process.env.CLAIM_TOKEN;
      Object.assign(process.env, env);
      jest.resetModules();
      ctx.off = require('../server/logger').onEntry((entry) => events.push(entry));
      ctx.server = require('../server');
      await ctx.server.startServer({ port: 0, host: '127.0.0.1', unrefServer: true });
      ctx.baseUrl = `http://127.0.0.1:${ctx.server.server.address().port}`;
    });

    afterAll(async () => {
      if (ctx.off) ctx.off();
      while (sockets.length) sockets.pop().close();
      ctx.server.registry.stop();
      await new Promise((r) => ctx.server.io.close(r));
      if (ctx.server.server.listening) await new Promise((r) => ctx.server.server.close(r));
      fs.rmSync(tempDir, { recursive: true, force: true });
      process.env = originalEnv;
    });

    // serverInfo is pushed the moment the socket is up, so the listener has
    // to be on before connect - and kept on, because the claim landing
    // re-sends it to everybody.
    ctx.connect = () =>
      new Promise((res) => {
        const s = Client(ctx.baseUrl, {
          forceNew: true,
          reconnection: false,
          transports: ['websocket'],
        });
        sockets.push(s);
        s.infos = [];
        s.on('serverInfo', (info) => s.infos.push(info));
        s.once('connect', () => res(s));
      });

    ctx.firstInfo = async (s) => {
      for (let i = 0; i < 100 && !s.infos.length; i++) await new Promise((r) => setTimeout(r, 10));
      return s.infos[0];
    };

    ctx.ask = (s, event, payload, answer) =>
      new Promise((res) => {
        s.once(answer, res);
        s.emit(event, payload);
      });

    ctx.silence = async (s, event, payload, answer = 'accountResult') => {
      let answered = false;
      const on = () => (answered = true);
      s.on(answer, on);
      s.emit(event, payload);
      await new Promise((r) => setTimeout(r, 600));
      s.off(answer, on);
      return !answered;
    };

    ctx.seen = (event) => events.filter((e) => e.event === event);

    body(ctx);
  });
}

serverSuite(
  'a fresh server with a claim token',
  { CLAIM_TOKEN: TOKEN, DB_NAME: 'claim-fresh' },
  (ctx) => {
    test('the lobby is offered the claim, and the log says so instead of no_way_in', async () => {
      const s = await ctx.connect();
      const info = await ctx.firstInfo(s);
      expect(info.claim).toBe(true);
      expect(info.unclaimed).toBe(true);
      expect(info.accounts).toBe(false);
      expect(info).not.toHaveProperty('token');
      expect(ctx.seen('claim_open')).toHaveLength(1);
      expect(ctx.seen('no_way_in')).toHaveLength(0);
      expect(ctx.seen('claim_token_short')).toHaveLength(0);
    });

    test('the wrong token is answered after a pause, written down, and claims nothing', async () => {
      const s = await ctx.connect();
      const at = Date.now();
      const answer = await ctx.ask(
        s,
        'claimServer',
        { name: 'Guesser', email: 'g@example.com', password: 'a good password', token: 'nope' },
        'accountResult'
      );
      expect(answer.ok).toBe(false);
      expect(answer.error).toMatch(/not the claim token/);
      expect(Date.now() - at).toBeGreaterThanOrEqual(350);
      expect(ctx.server.identity.adminCount()).toBe(0);
      const refused = ctx.seen('claim_refused');
      expect(refused).toHaveLength(1);
      expect(JSON.stringify(refused[0])).not.toContain(TOKEN);
    });

    test('a bad password is refused before anything is made', async () => {
      const s = await ctx.connect();
      const answer = await ctx.ask(
        s,
        'claimServer',
        { name: 'Owner', email: 'o@example.com', password: 'short', token: TOKEN },
        'accountResult'
      );
      expect(answer.ok).toBe(false);
      expect(answer.error).toMatch(/at least 8/);
      expect(ctx.server.accounts.ownerOf('Owner')).toBeNull();
    });

    test('the right token makes the first account, which runs the server', async () => {
      const watcher = await ctx.connect();
      await ctx.firstInfo(watcher);
      const s = await ctx.connect();
      const answer = await ctx.ask(
        s,
        'claimServer',
        { name: 'Owner', email: 'o@example.com', password: 'a good password', token: TOKEN },
        'accountResult'
      );
      expect(answer).toMatchObject({ ok: true, signedIn: true, claimed: true, name: 'Owner' });
      expect(answer.token).toBeTruthy();
      // The token identifies exactly as any device token does.
      const ident = await ctx.ask(s, 'identify', { token: answer.token }, 'identified');
      expect(ident.isAdmin).toBe(true);
      expect(ctx.server.identity.adminCount()).toBe(1);
      expect(ctx.seen('admin_claimed')).toHaveLength(1);
      expect(ctx.seen('server_claimed')).toHaveLength(1);
      // Every open lobby stops offering the claim, without a reload.
      for (let i = 0; i < 100 && watcher.infos.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const latest = watcher.infos[watcher.infos.length - 1];
      expect(latest.claim).toBe(false);
      expect(latest.unclaimed).toBe(false);
    });

    test('the door is shut behind them', async () => {
      const s = await ctx.connect();
      const answer = await ctx.ask(
        s,
        'claimServer',
        { name: 'Second', email: 's@example.com', password: 'a good password', token: TOKEN },
        'accountResult'
      );
      expect(answer.ok).toBe(false);
      expect(answer.error).toMatch(/administrator already/);
      expect(ctx.server.identity.adminCount()).toBe(1);
    });

    // The whole point of claiming before mail exists: the owner can come back.
    test('the owner signs in again with no mail on the server', async () => {
      const s = await ctx.connect();
      const answer = await ctx.ask(
        s,
        'signIn',
        { name: 'owner', password: 'a good password' },
        'accountResult'
      );
      expect(answer).toMatchObject({ ok: true, signedIn: true, name: 'Owner' });
    });
  }
);

serverSuite(
  'a claim token too short to use',
  { CLAIM_TOKEN: 'short', DB_NAME: 'claim-short' },
  (ctx) => {
    test('is refused at boot, and the lobby is not offered it', async () => {
      expect(ctx.seen('claim_token_short')).toHaveLength(1);
      expect(ctx.seen('claim_open')).toHaveLength(0);
      // Which leaves this server with no way in, and it says so.
      expect(ctx.seen('no_way_in')).toHaveLength(1);
      expect(ctx.seen('no_way_in')[0].detail).toMatch(/CLAIM_TOKEN/);
      const s = await ctx.connect();
      expect((await ctx.firstInfo(s)).claim).toBe(false);
      expect(
        await ctx.silence(s, 'claimServer', {
          name: 'Owner',
          email: 'o@example.com',
          password: 'a good password',
          token: 'short',
        })
      ).toBe(true);
    });
  }
);

serverSuite(
  'a server that has an administrator',
  { CLAIM_TOKEN: TOKEN, DB_NAME: 'claim-fresh' },
  (ctx) => {
    // Same database as the first suite, so Owner is already here.
    test('ignores the token and says so once', async () => {
      expect(ctx.server.identity.adminCount()).toBe(1);
      expect(ctx.seen('claim_token_stale')).toHaveLength(1);
      expect(ctx.seen('claim_open')).toHaveLength(0);
      const s = await ctx.connect();
      expect((await ctx.firstInfo(s)).claim).toBe(false);
    });
  }
);

serverSuite(
  'a server that loaded people but no administrator',
  { CLAIM_TOKEN: TOKEN, DB_NAME: 'claim-upgraded' },
  (ctx) => {
    // The first-account rule is for a server that loaded empty. One that came
    // up with identities predating the role promotes nobody on its own, and
    // that is exactly the server the claim has to be able to open.
    test('is claimable, and the claim sets the role itself', async () => {
      const { identity } = ctx.server;
      // Somebody from before, made to look like they loaded with the server.
      const old = accountFor(ctx.server, 'Old');
      identity.setRole(old.uid, 'player');
      await identity.flush();
      await identity.load();
      expect(identity.size).toBe(1);
      expect(identity.adminCount()).toBe(0);

      const s = await ctx.connect();
      const answer = await ctx.ask(
        s,
        'claimServer',
        { name: 'Owner', email: 'o@example.com', password: 'a good password', token: TOKEN },
        'accountResult'
      );
      expect(answer).toMatchObject({ ok: true, signedIn: true, claimed: true });
      const ident = await ctx.ask(s, 'identify', { token: answer.token }, 'identified');
      expect(ident.isAdmin).toBe(true);
      expect(identity.adminCount()).toBe(1);
      expect(identity.isAdmin(old.uid)).toBe(false);
    });
  }
);

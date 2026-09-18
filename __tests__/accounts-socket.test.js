// accounts-socket.test.js - a name on this server that is yours, end to end.
//
// The mail transport is the log, which is what it is for: the whole flow runs
// without a mail server, and the link is read back out of the entry the way a
// person would read it out of their inbox.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: Client } = require('socket.io-client');

jest.setTimeout(30000);

describe('an account of this server’s own', () => {
  const originalEnv = { ...process.env };
  const sockets = [];
  const mails = [];
  let baseUrl, serverModule, tempDir, offSink;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-accounts-'));
    process.env.SAVE_DIR = tempDir;
    process.env.HOST = '127.0.0.1';
    process.env.HTTP_RATE_LIMIT = '1000';
    process.env.MAIL_TRANSPORT = 'log';
    jest.resetModules();
    serverModule = require('../server');
    await serverModule.startServer({ port: 0, host: '127.0.0.1', unrefServer: true });
    baseUrl = `http://127.0.0.1:${serverModule.server.address().port}`;
    // PUBLIC_URL has to be the address the server actually came up on, which
    // is only known now, so the mailer is pointed at it here.
    serverModule.mailer.setBaseUrl(baseUrl);
    // Required here rather than at the top of the file: jest.resetModules()
    // above gave the server a logger module of its own, and a sink on the
    // copy this file loaded first would never hear a thing.
    offSink = require('../server/logger').onEntry((entry) => {
      if (entry.event === 'mail_logged') mails.push(entry);
    });
  });

  afterAll(async () => {
    if (offSink) offSink();
    while (sockets.length) sockets.pop().close();
    serverModule.registry.stop();
    await new Promise((r) => serverModule.io.close(r));
    if (serverModule.server.listening) await new Promise((r) => serverModule.server.close(r));
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  function connect() {
    return new Promise((res) => {
      const s = Client(baseUrl, { forceNew: true, reconnection: false, transports: ['websocket'] });
      sockets.push(s);
      s.once('connect', () => res(s));
    });
  }

  function ask(s, event, payload, answer) {
    return new Promise((res) => {
      s.once(answer, res);
      s.emit(event, payload);
    });
  }

  const identify = (s, payload) => ask(s, 'identify', payload, 'identified');

  // The link out of the last message sent, the way somebody reads it out of
  // their mail.
  function lastLink() {
    const text = mails.length ? mails[mails.length - 1].text : '';
    const found = String(text).match(/https?:\/\/\S+/);
    return found ? found[0] : null;
  }

  test('sign up, prove the address, and sign in from another browser', async () => {
    const first = await connect();
    await identify(first, { name: 'Ann' });

    const started = await ask(
      first,
      'signUp',
      { name: 'Ann', email: 'ann@example.com', password: 'correct horse' },
      'accountResult'
    );
    expect(started).toMatchObject({ ok: true, pending: true });
    expect(started.message).toMatch(/Check your mail/);

    // Held, not owned: somebody else cannot take the name while it waits. Not
    // a generic error either - typing the name you play under is how somebody
    // with an account arrives, so it is its own answer and the lobby says it
    // beside the password box.
    const other = await connect();
    const refused = await ask(other, 'identify', { name: 'Ann' }, 'identifyFailed');
    expect(refused).toEqual({ provider: 'local', reason: 'name-taken' });

    const link = lastLink();
    expect(link).toMatch(/\/verify\?token=/);
    const page = await fetch(link);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Ann is yours');

    // A different browser entirely, with no token of its own.
    const elsewhere = await connect();
    const bad = await ask(
      elsewhere,
      'signIn',
      { name: 'Ann', password: 'not the password' },
      'accountResult'
    );
    expect(bad.ok).toBe(false);
    // The same sentence a name with no account gets, so the answer never says
    // which names exist.
    const nobody = await ask(
      elsewhere,
      'signIn',
      { name: 'Nobody', password: 'not the password' },
      'accountResult'
    );
    expect(nobody.error).toBe(bad.error);

    const signedIn = await ask(
      elsewhere,
      'signIn',
      { name: 'Ann', password: 'correct horse' },
      'accountResult'
    );
    expect(signedIn).toMatchObject({ ok: true, signedIn: true, name: 'Ann' });
    const ident = await identify(elsewhere, { token: signedIn.token, name: 'Ann' });
    expect(ident.provider).toBe('local');
    expect(ident.name).toBe('Ann');
  });

  test('forgetting it says the same thing whether or not the name exists', async () => {
    const s = await connect();
    const real = await ask(s, 'requestPasswordReset', { name: 'Ann' }, 'accountResult');
    const fake = await ask(s, 'requestPasswordReset', { name: 'Nobody' }, 'accountResult');
    expect(real).toEqual(fake);

    // The link sets a new one, once.
    const link = lastLink();
    expect(link).toMatch(/\/reset\?token=/);
    const form = await fetch(link);
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('A new password for Ann');

    const token = new URL(link).searchParams.get('token');
    const body = new URLSearchParams({
      token,
      password: 'a brand new one',
      confirm: 'a brand new one',
    });
    const done = await fetch(`${baseUrl}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect(done.status).toBe(200);

    const again = await fetch(`${baseUrl}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, password: 'and another', confirm: 'and another' }),
    });
    expect(again.status).toBe(400);

    const s2 = await connect();
    const signedIn = await ask(
      s2,
      'signIn',
      { name: 'Ann', password: 'a brand new one' },
      'accountResult'
    );
    expect(signedIn.ok).toBe(true);
  });

  // The address is the most sensitive thing this server holds. It belongs in
  // one file and nowhere else.
  test('the address is in the accounts table and nowhere else', async () => {
    await serverModule.accounts.flush();
    await serverModule.identity.flush();
    if (serverModule.adminLog) serverModule.adminLog.flush();

    // It is where it belongs.
    const stored = await serverModule.db.accounts.all();
    expect(JSON.stringify(stored)).toContain('ann@example.com');

    // And in no file this server writes, which is now every file it writes.
    const seen = [];
    for (const name of fs.readdirSync(tempDir)) {
      const full = path.join(tempDir, name);
      if (!fs.statSync(full).isFile()) continue;
      if (fs.readFileSync(full, 'utf8').includes('ann@example.com')) seen.push(name);
    }
    expect(seen).toEqual([]);

    // Nor in anything a player is sent.
    const s = await connect();
    const ident = await identify(s, { name: 'Onlooker' });
    expect(JSON.stringify(ident)).not.toContain('ann@example.com');
    const sessions = await ask(s, 'listSessions', {}, 'sessions');
    expect(JSON.stringify(sessions)).not.toContain('ann@example.com');
  });
});

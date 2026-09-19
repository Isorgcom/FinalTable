// __tests__/mail-admin.test.js - setting where this server sends from, over
// the socket, the way the Admin page does it.
//
// The one that earns its keep is the last: a real SMTP conversation, against a
// socket server that speaks just enough of the protocol to capture the login.
// A mistake about TLS or about escaping is invisible to every other test here,
// and that one would catch it.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { io: Client } = require('socket.io-client');
const { accountFor } = require('./helpers/account');

jest.setTimeout(20000);

const SECRET = 'correct-horse-battery';

describe('setting up mail from the Admin page', () => {
  const originalEnv = { ...process.env };
  const sockets = [];
  let baseUrl, serverModule, tempDir;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mail-'));
    process.env.SAVE_DIR = tempDir;
    process.env.DB_NAME = 'mail-admin';
    process.env.HOST = '127.0.0.1';
    // Nothing configured: this is a server somebody is about to set up.
    delete process.env.PUBLIC_URL;
    delete process.env.SMTP_URL;
    delete process.env.MAIL_TRANSPORT;
    delete process.env.MAIL_FROM;
    delete process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_PROMOTE;
    delete process.env.GAMENIGHT_URL;
    delete process.env.GAMENIGHT_PUBLIC_KEY;
    jest.resetModules();
    serverModule = require('../server');
    await serverModule.startServer({ port: 0, host: '127.0.0.1', unrefServer: true });
    baseUrl = `http://127.0.0.1:${serverModule.server.address().port}`;
    // Claim the server before anything else. On a fresh one the first account
    // through the door administers it, so without this the "somebody who is
    // not an administrator" below would be one.
    accountFor(serverModule, 'TheFirst', { role: 'admin' });
  });

  afterAll(async () => {
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
      const info = new Promise((r) => s.once('serverInfo', r));
      s.once('connect', () => res({ s, info }));
    });
  }

  function ask(s, event, payload, answer = 'adminMail') {
    return new Promise((res) => {
      s.once(answer, res);
      s.emit(event, payload);
    });
  }

  let bosses = 0;
  async function admin() {
    const { s } = await connect();
    const who = accountFor(serverModule, `MailBoss${bosses++}`, { role: 'admin' });
    await ask(s, 'identify', { token: who.token }, 'identified');
    return { s, who };
  }

  const settings = (over = {}) => ({
    mode: 'log',
    publicUrl: 'https://table.example',
    from: 'FinalTable <no-reply@table.example>',
    ...over,
  });

  test('the mail events say nothing to somebody who is not an administrator', async () => {
    const { s } = await connect();
    await ask(s, 'identify', { token: accountFor(serverModule, 'Ordinary').token }, 'identified');
    let answered = false;
    s.on('adminMail', () => (answered = true));
    s.emit('adminGetMail');
    s.emit('adminSetMail', settings());
    s.emit('adminTestMail', {});
    await new Promise((r) => setTimeout(r, 300));
    expect(answered).toBe(false);
    expect(serverModule.settingsStore.get('mail')).toBeNull();
  });

  // A server nobody can sign up to, told where to send, in front of somebody
  // who is already looking at the sign-in screen.
  test('saving mail reaches every browser, not only the one that saved it', async () => {
    const { s } = await admin();
    expect((await ask(s, 'adminGetMail', {})).mode).toBe('off');

    const { s: bystander, info } = await connect();
    expect((await info).accounts).toBe(false);
    const heard = new Promise((r) => bystander.once('serverInfo', r));

    expect(await ask(s, 'adminSetMail', settings())).toMatchObject({ ok: true, mode: 'log' });
    // The sign-in screen reads this, and stops saying the server cannot make
    // an account without anybody reloading anything.
    expect((await heard).accounts).toBe(true);
  });

  test('what was written down is what the next boot will read', async () => {
    const { s } = await admin();
    await ask(s, 'adminSetMail', settings({ mode: 'smtp', host: 'smtp.example.com', port: 465 }));
    await serverModule.settingsStore.saved();
    const stored = serverModule.settingsStore.get('mail');
    expect(stored).toMatchObject({ mode: 'smtp', host: 'smtp.example.com', source: 'gui' });
  });

  // The decision, pinned: the password is in the database, because it has to
  // be replayed to the mail host. Nobody should "fix" that by hashing it.
  test('the password is stored, and never leaves the server', async () => {
    const { s } = await admin();
    const seen = [];
    for (const socket of sockets) {
      socket.on('adminMail', (d) => seen.push(d));
      socket.on('serverInfo', (d) => seen.push(d));
    }
    const answer = await ask(s, 'adminSetMail', settings({ mode: 'smtp', pass: SECRET }));
    seen.push(answer);
    await serverModule.settingsStore.saved();

    expect(serverModule.settingsStore.get('mail').pass).toBe(SECRET);
    expect(answer.passSet).toBe(true);
    expect(Object.keys(answer)).not.toContain('pass');
    expect(JSON.stringify(seen)).not.toContain(SECRET);

    // And an empty box afterwards keeps it rather than wiping it.
    await ask(s, 'adminSetMail', { user: 'somebody-else' });
    expect(serverModule.settingsStore.get('mail').pass).toBe(SECRET);
  });

  test('a mail server that is not there says so, in its own words', async () => {
    const { s } = await admin();
    const answer = await ask(
      s,
      'adminTestMail',
      settings({ mode: 'smtp', host: '127.0.0.1', port: 1 })
    );
    expect(answer.ok).toBe(false);
    expect(answer.error).toMatch(/ECONNREFUSED|connect|refused/i);
    // And it did not save the settings it was only trying.
    expect(serverModule.mail.status().host).not.toBe('127.0.0.1');
  });

  test('a test message goes to the administrator, and the address is not spelt out', async () => {
    const { s } = await admin();
    await ask(s, 'adminSetMail', settings());
    const answer = await ask(s, 'adminTestMail', settings());
    expect(answer.ok).toBe(true);
    expect(answer.sentTo).toMatch(/^.\*\*\*@/);
  });

  test('pressing it over and over is answered rather than ignored', async () => {
    const { s } = await admin();
    let last = null;
    for (let i = 0; i < 4; i++) last = await ask(s, 'adminTestMail', settings());
    expect(last).toMatchObject({ ok: false });
    expect(last.error).toMatch(/enough for one minute/i);
  });

  // The one that would catch a mistake about TLS or about escaping: a real
  // SMTP conversation, with the login read off the wire.
  test('the settings reach the mail server as given', async () => {
    const heard = { user: null, pass: null, to: null };
    const smtp = net.createServer((socket) => {
      let expectingAuth = false;
      socket.write('220 test.example ESMTP\r\n');
      socket.on('data', (chunk) => {
        for (const line of String(chunk).split('\r\n').filter(Boolean)) {
          if (expectingAuth) {
            expectingAuth = false;
            const [, user, pass] = Buffer.from(line, 'base64').toString('utf8').split('\0');
            heard.user = user;
            heard.pass = pass;
            socket.write('235 authenticated\r\n');
          } else if (/^EHLO|^HELO/i.test(line)) {
            socket.write('250-test.example\r\n250 AUTH PLAIN LOGIN\r\n');
          } else if (/^AUTH PLAIN$/i.test(line)) {
            expectingAuth = true;
            socket.write('334 \r\n');
          } else if (/^AUTH PLAIN /i.test(line)) {
            const [, , payload] = line.split(' ');
            const [, user, pass] = Buffer.from(payload, 'base64').toString('utf8').split('\0');
            heard.user = user;
            heard.pass = pass;
            socket.write('235 authenticated\r\n');
          } else if (/^MAIL FROM/i.test(line)) {
            socket.write('250 ok\r\n');
          } else if (/^RCPT TO/i.test(line)) {
            heard.to = line;
            socket.write('250 ok\r\n');
          } else if (/^DATA$/i.test(line)) {
            socket.write('354 go ahead\r\n');
          } else if (line === '.') {
            socket.write('250 queued\r\n');
          } else if (/^QUIT/i.test(line)) {
            socket.write('221 bye\r\n');
            socket.end();
          }
        }
      });
    });
    await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
    const port = smtp.address().port;

    try {
      const { s, who } = await admin();
      // A password with every character a URL would have needed escaping.
      const awkward = 'p@ss:/#word';
      const answer = await ask(
        s,
        'adminTestMail',
        settings({
          mode: 'smtp',
          host: '127.0.0.1',
          port,
          // STARTTLS off: this sink speaks plain text.
          secure: false,
          user: 'postie@table.example',
          pass: awkward,
        })
      );
      expect(answer).toMatchObject({ ok: true });
      expect(heard.user).toBe('postie@table.example');
      // Intact, which a URL could not have managed without escaping first.
      expect(heard.pass).toBe(awkward);
      expect(heard.to).toContain(who.name.toLowerCase().slice(0, 1));
    } finally {
      await new Promise((r) => smtp.close(r));
    }
  });
});

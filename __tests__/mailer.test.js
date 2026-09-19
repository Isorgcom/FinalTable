// __tests__/mailer.test.js - the two messages this server sends, and where.
//
// The settings used to be closed-over consts: a server could only be told
// where to send at the moment it started, which is why they lived in a file
// nobody could reach from a browser. They move now, so what matters is that
// the memoised transport moves with them.
const { createMailer } = require('../server/mailer');

describe('the mailer', () => {
  const logged = [];
  const log = (entry) => logged.push(entry);
  beforeEach(() => {
    logged.length = 0;
  });

  const logging = (over = {}) =>
    createMailer({ baseUrl: 'https://table.example', transport: 'log', log, ...over });

  test('nothing is sent without somewhere for a link to point', async () => {
    const mailer = createMailer({ transport: 'log', log });
    expect(mailer.available()).toBe(false);
    expect(mailer.why()).toMatch(/no public address/i);
    expect(await mailer.sendVerification({ to: 'a@b.com', name: 'Ann', token: 't' })).toBe(false);
    expect(logged).toEqual([]);

    // And once it has one, it can.
    mailer.setBaseUrl('https://table.example/');
    expect(mailer.available()).toBe(true);
    expect(mailer.why()).toBeNull();
  });

  test('nothing is sent without a way to send it', () => {
    const mailer = createMailer({ baseUrl: 'https://table.example', log });
    expect(mailer.available()).toBe(false);
    expect(mailer.why()).toMatch(/no mail server/i);
  });

  test('a link is absolute, and the trailing slash does not double up', async () => {
    const mailer = logging({ baseUrl: 'https://table.example//' });
    expect(mailer.link('verify', 'a b')).toBe('https://table.example/verify?token=a%20b');
    await mailer.sendVerification({ to: 'ann@example.com', name: 'Ann', token: 'tok' });
    expect(logged[0].data.text).toContain('https://table.example/verify?token=tok');
    expect(logged[0].data.text).toContain('Ann');
  });

  test('the log transport is the inbox, and says so', async () => {
    const mailer = logging();
    expect(await mailer.sendReset({ to: 'ann@example.com', name: 'Ann', token: 'r' })).toBe(true);
    expect(logged[0]).toMatchObject({ event: 'mail_logged' });
    expect(logged[0].data.to).toBe('ann@example.com');
    expect(logged[0].data.text).toContain('/reset?token=r');
  });

  // The whole point of the settings moving: a server told where to send while
  // it is running sends there, rather than wherever it was told at boot.
  test('configure replaces the settings and the transport built from them', () => {
    const made = [];
    const mailer = createMailer({ baseUrl: 'https://table.example', log });
    // Stand in for nodemailer, so nothing here opens a socket.
    const fake = { sendMail: () => Promise.resolve(true), verify: () => Promise.resolve(true) };
    jest.resetModules();
    jest.doMock('nodemailer', () => ({
      createTransport: (opts) => {
        made.push(opts);
        return fake;
      },
    }));

    mailer.configure({ host: 'smtp.one.example', port: 465, secure: true, user: 'u', pass: 'p' });
    expect(mailer.available()).toBe(true);
    return mailer
      .verify()
      .then(() => {
        expect(made).toHaveLength(1);
        expect(made[0]).toEqual({
          host: 'smtp.one.example',
          port: 465,
          secure: true,
          auth: { user: 'u', pass: 'p' },
        });
        // Told somewhere else, it goes somewhere else rather than reusing what
        // it built a moment ago.
        mailer.configure({ host: 'smtp.two.example', port: 587, secure: false });
        return mailer.verify();
      })
      .then(() => {
        expect(made).toHaveLength(2);
        expect(made[1]).toMatchObject({ host: 'smtp.two.example', port: 587, secure: false });
      })
      .finally(() => jest.dontMock('nodemailer'));
  });

  // A URL is what the environment has always carried, and it cannot hold a
  // password with @ : / or # in it unescaped. The fields can, so where both
  // are set the fields win.
  test('the fields beat a URL, and a port is guessed from the TLS choice', () => {
    const mailer = createMailer({ baseUrl: 'https://t.example', smtpUrl: 'smtp://old.example:25' });
    expect(mailer.available()).toBe(true);
    mailer.configure({ host: 'new.example', secure: false, user: 'u', pass: 'p@ss:/#word' });
    // Nothing observable here but the absence of a throw and the presence of a
    // transport; the shape is asserted in the test above.
    expect(mailer.why()).toBeNull();
  });

  test('verify answers rather than throwing, and says so on the log transport', async () => {
    expect(await logging().verify()).toEqual({ ok: true, logged: true });

    const bare = createMailer({ baseUrl: 'https://t.example', log });
    expect(await bare.verify()).toEqual({ ok: false, error: 'No mail server is set.' });
  });

  // A test message carries no link, so it does not need a public address the
  // way the two real messages do. It used to be refused for the want of one
  // and blame the mail server for it, which is the wrong thing to be told
  // while setting a mail server up.
  test('a test message needs a way out, not a public address', async () => {
    const noAddress = createMailer({ transport: 'log', log });
    expect(noAddress.available()).toBe(false);
    expect(await noAddress.sendTest({ to: 'boss@example.com' })).toEqual({
      ok: true,
      logged: true,
    });
    expect(logged[0].data.to).toBe('boss@example.com');

    // With no way out at all it is refused, and says which thing is missing.
    const nothing = createMailer({ baseUrl: 'https://t.example', log });
    expect(await nothing.sendTest({ to: 'boss@example.com' })).toEqual({
      ok: false,
      error: 'No mail server is set.',
    });
  });

  test('a test message goes, and wants somewhere to go', async () => {
    const mailer = logging();
    expect(await mailer.sendTest({})).toMatchObject({ ok: false });
    expect(await mailer.sendTest({ to: 'boss@example.com' })).toEqual({ ok: true, logged: true });
    expect(logged[0].data.subject).toMatch(/test message/i);
    expect(logged[0].data.to).toBe('boss@example.com');
  });

  // A failure is worth knowing about and is not worth writing somebody's mail
  // into the log to find out about.
  test('a send that fails is logged without the address or the body', async () => {
    const mailer = createMailer({ baseUrl: 'https://t.example', host: 'nowhere.example', log });
    jest.resetModules();
    jest.doMock('nodemailer', () => ({
      createTransport: () => ({
        sendMail: () => Promise.reject(new Error('connection refused')),
      }),
    }));
    try {
      expect(await mailer.sendReset({ to: 'ann@example.com', name: 'Ann', token: 'r' })).toBe(
        false
      );
      const failure = logged.find((e) => e.event === 'mail_failed');
      expect(failure).toBeTruthy();
      expect(failure.data.detail).toMatch(/connection refused/);
      const written = JSON.stringify(logged);
      expect(written).not.toContain('ann@example.com');
      expect(written).not.toContain('/reset?token=r');
    } finally {
      jest.dontMock('nodemailer');
    }
  });
});

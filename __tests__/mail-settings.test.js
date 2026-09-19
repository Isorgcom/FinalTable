// __tests__/mail-settings.test.js - where this server sends from.
//
// Two things are worth more than the rest here. The password must never come
// back out through status(), because that answer goes to a browser; and a
// save must reach the live mailer, not only the record, or the page says
// "saved" and the server keeps sending wherever it was told at boot.
const { createMailRuntime } = require('../server/mail-settings');
const { createSettingsStore } = require('../server/settings-store');
const { createMemoryDatabase } = require('../server/db');
const { createMailer } = require('../server/mailer');
const { mailFromEnv } = require('../server/config');

const SECRET = 'correct-horse-battery';

describe('the mail settings', () => {
  let db;
  let store;
  let mailer;
  let n = 0;

  beforeEach(() => {
    db = createMemoryDatabase({ database: `mail-${n++}` });
    db.reset();
    store = createSettingsStore({ db });
    mailer = createMailer({});
  });

  const make = (over = {}) => createMailRuntime({ settingsStore: store, mailer, ...over });

  const smtp = (over = {}) => ({
    mode: 'smtp',
    publicUrl: 'https://table.example',
    from: 'FinalTable <no-reply@table.example>',
    host: 'smtp.example.com',
    port: 465,
    secure: true,
    user: 'postie',
    pass: SECRET,
    ...over,
  });

  test('nothing is set until something sets it', () => {
    const mail = make();
    mail.init();
    expect(mail.status()).toMatchObject({ mode: 'off', passSet: false, available: false });
    expect(mailer.available()).toBe(false);
  });

  // The whole point of the page: a save reaches the mailer, not just the row.
  test('a save reaches the live mailer', () => {
    const mail = make();
    mail.init();
    mail.apply(smtp());
    expect(mailer.available()).toBe(true);
    expect(mailer.why()).toBeNull();
    expect(mail.status()).toMatchObject({
      mode: 'smtp',
      host: 'smtp.example.com',
      available: true,
    });
  });

  test('the password never comes back out', () => {
    const mail = make();
    mail.init();
    mail.apply(smtp());
    const answer = mail.status();
    expect(Object.keys(answer)).not.toContain('pass');
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    // What the page gets instead: that there is one, and when it was set.
    expect(answer.passSet).toBe(true);
    expect(answer.passSetAt).toEqual(expect.any(Number));
  });

  // The page cannot show the stored password, so it sends an empty box when
  // nothing about it changed. An empty box must not wipe it.
  test('an empty password box keeps the stored one, and clearing is its own flag', () => {
    const mail = make();
    mail.init();
    mail.apply(smtp());
    const setAt = mail.status().passSetAt;

    mail.apply({ user: 'somebody-else' });
    expect(mail.status()).toMatchObject({ user: 'somebody-else', passSet: true, passSetAt: setAt });
    expect(mail.get().pass).toBe(SECRET);

    mail.apply({ pass: 'a new one' });
    expect(mail.get().pass).toBe('a new one');

    mail.apply({ clearPass: true });
    expect(mail.status()).toMatchObject({ passSet: false, passSetAt: null });
    expect(mail.get().pass).toBe('');
  });

  // A record switched from the environment's URL to the page's fields would
  // otherwise keep the URL behind it, and the mailer falls back to one the
  // moment a host is cleared.
  test('switching to the fields leaves no URL behind', () => {
    const withUrl = createMailer({ smtpUrl: 'smtp://from-the-env.example:25' });
    const mail = createMailRuntime({ settingsStore: store, mailer: withUrl });
    mail.init();
    mail.apply(smtp({ mode: 'off', host: '' }));
    // Off means off, rather than falling back to whatever the environment said.
    expect(withUrl.available()).toBe(false);
  });

  test('the saved record beats the environment, and is what a restart reads', async () => {
    const seeded = make({ envSeed: { mode: 'log', publicUrl: 'https://seeded.example' } });
    seeded.init();
    expect(seeded.status()).toMatchObject({ mode: 'log', source: 'env' });
    // The seed is written down, so the next boot reads it as a saved record.
    expect(store.get('mail')).toMatchObject({ mode: 'log', source: 'env' });

    seeded.apply(smtp());
    await store.saved();

    const reopened = createSettingsStore({ db });
    await reopened.load();
    const back = createMailRuntime({
      settingsStore: reopened,
      mailer: createMailer({}),
      // Still set, and still not consulted.
      envSeed: { mode: 'log', publicUrl: 'https://seeded.example' },
    });
    back.init();
    expect(back.status()).toMatchObject({ mode: 'smtp', host: 'smtp.example.com', source: 'gui' });
    // Including the password, which is the decision: it is stored as given,
    // because it has to be replayed to the mail host.
    expect(back.get().pass).toBe(SECRET);
  });

  test('the test button tries the form as typed, without saving it', () => {
    const mail = make();
    mail.init();
    mail.apply(smtp());
    const typed = mail.asTyped({ host: 'somewhere-else.example', port: 587 });
    expect(typed).toMatchObject({ host: 'somewhere-else.example', port: 587, pass: SECRET });
    // And the saved record has not moved.
    expect(mail.status().host).toBe('smtp.example.com');
  });

  // An SMTP server quotes what it was given more often than anybody expects,
  // and the answer reaches a browser and the admin Log.
  test('the password is taken out of anything the mail server says back', () => {
    const mail = make();
    mail.init();
    mail.apply(smtp());
    expect(mail.redact(`535 rejected the password ${SECRET} for postie`)).toBe(
      '535 rejected the password *** for postie'
    );
    expect(mail.redact('')).toBe('');
  });

  test('a mode nobody recognises is off rather than something worse', () => {
    const mail = make();
    mail.init();
    mail.apply(smtp({ mode: 'whatever' }));
    expect(mail.status().mode).toBe('off');
    expect(mailer.available()).toBe(false);
  });

  // The seed, which is the only thing the environment is still for.
  describe('reading the environment', () => {
    const originalEnv = { ...process.env };
    afterEach(() => {
      process.env = { ...originalEnv };
    });

    test('nothing set is nothing to seed', () => {
      delete process.env.PUBLIC_URL;
      delete process.env.SMTP_URL;
      delete process.env.MAIL_TRANSPORT;
      expect(mailFromEnv()).toBeNull();
    });

    test('a URL is unpicked into the fields, and unescaped on the way', () => {
      process.env.PUBLIC_URL = 'https://table.example/';
      process.env.SMTP_URL = 'smtps://user%40x.com:p%40ss%3Aword@smtp.example.com:465';
      expect(mailFromEnv()).toMatchObject({
        mode: 'smtp',
        publicUrl: 'https://table.example',
        host: 'smtp.example.com',
        port: 465,
        secure: true,
        user: 'user@x.com',
        pass: 'p@ss:word',
        source: 'env',
      });
    });

    test('smtp:// is the other port, and the other answer about TLS', () => {
      process.env.SMTP_URL = 'smtp://relay.example';
      expect(mailFromEnv()).toMatchObject({ secure: false, port: 587, host: 'relay.example' });
    });

    // A half-configured GameNight can stop a boot safely, because mail is the
    // other way in. Mail has no other way in.
    test('a URL that will not parse warns and does not stop the boot', () => {
      const said = [];
      process.env.PUBLIC_URL = 'https://table.example';
      process.env.SMTP_URL = 'not a url at all';
      const seed = mailFromEnv((detail) => said.push(detail));
      expect(seed).toMatchObject({ mode: 'off', publicUrl: 'https://table.example' });
      expect(said).toHaveLength(1);
    });

    test('the log transport seeds the log mode', () => {
      process.env.PUBLIC_URL = 'https://table.example';
      process.env.MAIL_TRANSPORT = 'log';
      expect(mailFromEnv()).toMatchObject({ mode: 'log' });
    });
  });
});

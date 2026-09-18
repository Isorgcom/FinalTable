// __tests__/admin-users.test.js - the Users page, over the socket.
//
// The guards are the point. Everything here can be done to somebody, and two
// of the answers - the last administrator, and yourself - are the ones that
// would leave a server nobody can run or an administrator who has locked
// themselves out.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: Client } = require('socket.io-client');
const { accountFor } = require('./helpers/account');

jest.setTimeout(20000);

describe('the Users page', () => {
  const originalEnv = { ...process.env };
  const sockets = [];
  let baseUrl, serverModule, tempDir;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-users-'));
    process.env.SAVE_DIR = tempDir;
    process.env.DB_NAME = 'users-test';
    process.env.HOST = '127.0.0.1';
    // Mail, so accounts can be made and handed over.
    process.env.PUBLIC_URL = 'http://127.0.0.1:2026';
    process.env.MAIL_TRANSPORT = 'log';
    delete process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_PROMOTE;
    jest.resetModules();
    serverModule = require('../server');
    await serverModule.startServer({ port: 0, host: '127.0.0.1', unrefServer: true });
    baseUrl = `http://127.0.0.1:${serverModule.server.address().port}`;
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
      s.once('connect', () => res(s));
    });
  }

  function ask(s, event, payload, answer) {
    return new Promise((res) => {
      s.once(answer, res);
      s.emit(event, payload);
    });
  }

  const identify = (s, name, opts) =>
    ask(s, 'identify', { token: accountFor(serverModule, name, opts).token }, 'identified');

  // An administrator, and somebody for them to act on.
  let n = 0;
  async function pair() {
    const who = `u${n++}`;
    const boss = await connect();
    boss.__uid = (await identify(boss, `Boss${who}`, { role: 'admin' })).uid;
    const them = await connect();
    const theirs = await identify(them, `Player${who}`);
    return { boss, them, theirs, who };
  }

  test('the list answers an administrator and nobody else', async () => {
    const { boss, them } = await pair();

    const listed = await ask(boss, 'adminListUsers', {}, 'adminUsers');
    expect(listed.rows.length).toBeGreaterThan(1);
    expect(listed.rows[0]).toMatchObject({
      uid: expect.any(String),
      name: expect.any(String),
      provider: 'local',
      role: expect.any(String),
      disabled: false,
    });
    // Never the address, which is the one thing the list deliberately leaves
    // out: this page polls.
    expect(JSON.stringify(listed)).not.toContain('@');

    let answered = false;
    them.on('adminUsers', () => (answered = true));
    them.emit('adminListUsers', {});
    await new Promise((r) => setTimeout(r, 250));
    expect(answered).toBe(false);
  });

  test('searching and filtering happen on the server', async () => {
    const { boss, who } = await pair();
    const found = await ask(boss, 'adminListUsers', { q: `player${who}` }, 'adminUsers');
    expect(found.rows.map((r) => r.name)).toEqual([`Player${who}`]);
    const admins = await ask(boss, 'adminListUsers', { filter: 'admin' }, 'adminUsers');
    expect(admins.rows.every((r) => r.role === 'admin')).toBe(true);
  });

  // The address is why this is its own event rather than a column.
  test('one account shows its address, and the Log says who looked', async () => {
    const { boss, theirs, who } = await pair();
    const answer = await ask(boss, 'adminGetUser', { uid: theirs.uid }, 'adminUser');
    expect(answer.user).toMatchObject({ uid: theirs.uid, name: `Player${who}`, hasAccount: true });
    expect(answer.user.email).toMatch(/@/);

    const log = await ask(boss, 'adminLog', {}, 'adminLogRows');
    expect(JSON.stringify(log.rows)).toContain('looked at');
    // And the row does not carry the address it is about.
    expect(JSON.stringify(log.rows)).not.toContain(answer.user.email);

    expect((await ask(boss, 'adminGetUser', { uid: 'u_nobody' }, 'adminUser')).error).toMatch(
      /nobody here/
    );
  });

  test('an administrator makes an account, and a link goes out rather than a password', async () => {
    const { boss } = await pair();
    const made = await ask(
      boss,
      'adminCreateUser',
      { name: 'Handover', email: 'handover@example.com' },
      'adminUserResult'
    );
    expect(made).toMatchObject({ ok: true, made: 'Handover' });
    // Made, verified, and impossible to sign in to until the link is used.
    expect(serverModule.accounts.ownerOf('Handover')).toBeTruthy();
    expect(await serverModule.accounts.signIn('Handover', '')).toBeNull();

    // And the name is somebody's now.
    const again = await ask(
      boss,
      'adminCreateUser',
      { name: 'handover', email: 'other@example.com' },
      'adminUserResult'
    );
    expect(again.error).toMatch(/taken/);
  });

  // An account made this way has no password, and must survive a restart
  // rather than being dropped as a row with nothing in it.
  test('an account waiting to be taken over comes back after a restart', async () => {
    const { boss } = await pair();
    await ask(
      boss,
      'adminCreateUser',
      { name: 'Patient', email: 'patient@example.com' },
      'adminUserResult'
    );
    await serverModule.accounts.flush();

    const { createAccounts } = require('../server/accounts');
    const back = createAccounts({ db: serverModule.db });
    await back.load();
    expect(back.ownerOf('Patient')).toBeTruthy();
  });

  test('promoting and standing down, and never the last one', async () => {
    const { boss, theirs } = await pair();
    const bossUid = boss.__uid;

    expect(
      await ask(boss, 'adminSetUserRole', { uid: theirs.uid, role: 'admin' }, 'adminUserResult')
    ).toMatchObject({ ok: true });
    expect(serverModule.identity.isAdmin(theirs.uid)).toBe(true);

    // Standing down is allowed while somebody else is there.
    expect(
      await ask(boss, 'adminSetUserRole', { uid: theirs.uid, role: 'player' }, 'adminUserResult')
    ).toMatchObject({ ok: true });
    expect(serverModule.identity.isAdmin(theirs.uid)).toBe(false);

    // And when this one is the only administrator left, it cannot be taken
    // away - not by somebody else, and not by themselves.
    const others = serverModule.identity
      .list({ filter: 'admin', limit: 50 })
      .rows.filter((r) => r.uid !== bossUid);
    for (const row of others) serverModule.identity.setRole(row.uid, 'player');

    const refused = await ask(
      boss,
      'adminSetUserRole',
      { uid: bossUid, role: 'player' },
      'adminUserResult'
    );
    expect(refused.error).toMatch(/has to administer/);
    expect(serverModule.identity.isAdmin(bossUid)).toBe(true);
    // Put the others back for whatever runs next.
    for (const row of others) serverModule.identity.setRole(row.uid, 'admin');
  });

  // Taking it away has to reach the browser they are holding, or they keep it
  // until they next reload.
  test('a demotion reaches the socket it was taken from', async () => {
    const { boss, them, theirs } = await pair();
    await ask(boss, 'adminSetUserRole', { uid: theirs.uid, role: 'admin' }, 'adminUserResult');
    const told = new Promise((r) => them.once('adminStatus', r));
    await ask(boss, 'adminSetUserRole', { uid: theirs.uid, role: 'player' }, 'adminUserResult');
    expect(await told).toMatchObject({ ok: false, revoked: true });

    // And the surface is gone with it, not merely hidden.
    let answered = false;
    them.on('adminUsers', () => (answered = true));
    them.emit('adminListUsers', {});
    await new Promise((r) => setTimeout(r, 250));
    expect(answered).toBe(false);
  });

  test('suspending signs every device out and shuts all three doors', async () => {
    const { boss, them, theirs } = await pair();
    const ended = new Promise((r) => them.once('sessionEnded', r));
    expect(
      await ask(
        boss,
        'adminSetUserDisabled',
        { uid: theirs.uid, disabled: true },
        'adminUserResult'
      )
    ).toMatchObject({ ok: true });
    await ended;

    expect(serverModule.identity.isDisabled(theirs.uid)).toBe(true);

    // The token they were holding is dead, because suspending signs every
    // device out before anything else - so that browser is nobody rather than
    // somebody suspended.
    const back = await connect();
    expect(await ask(back, 'identify', { token: theirs.token }, 'identifyFailed')).toMatchObject({
      reason: 'no-account',
    });
    // And the door they would come back through is the one that says why.
    expect(serverModule.identity.signInAs({ uid: theirs.uid, name: 'whoever' })).toEqual({
      error: 'disabled',
    });

    // Let back in, and they are a player again.
    expect(
      await ask(
        boss,
        'adminSetUserDisabled',
        { uid: theirs.uid, disabled: false },
        'adminUserResult'
      )
    ).toMatchObject({ ok: true });
    expect(serverModule.identity.isDisabled(theirs.uid)).toBe(false);
  });

  test('nobody suspends or deletes themselves', async () => {
    const { boss } = await pair();
    const me = serverModule.identity.list({ filter: 'admin' }).rows[0].uid;
    expect(
      (await ask(boss, 'adminSetUserDisabled', { uid: me, disabled: true }, 'adminUserResult'))
        .error
    ).toMatch(/cannot suspend yourself/);
    expect((await ask(boss, 'adminDeleteUser', { uid: me }, 'adminUserResult')).error).toMatch(
      /cannot delete yourself/
    );
  });

  test('signing somebody out ends every device and leaves the account', async () => {
    const { boss, them, theirs } = await pair();
    const ended = new Promise((r) => them.once('sessionEnded', r));
    expect(
      await ask(boss, 'adminSignOutUser', { uid: theirs.uid }, 'adminUserResult')
    ).toMatchObject({ ok: true });
    await ended;
    expect(serverModule.identity.sessions(theirs.uid)).toEqual([]);
    // Still somebody, and still theirs to sign back in to.
    expect(serverModule.identity.get(theirs.uid)).toBeTruthy();
  });

  test('deleting takes the account and leaves the games they played', async () => {
    const { boss, theirs, who } = await pair();
    expect(
      await ask(boss, 'adminDeleteUser', { uid: theirs.uid }, 'adminUserResult')
    ).toMatchObject({ ok: true });
    expect(serverModule.identity.get(theirs.uid)).toBeNull();
    expect(serverModule.accounts.ownerOf(`Player${who}`)).toBeNull();
    // The name is free again.
    expect(serverModule.identity.nameHolder(`player${who}`, 'u_anybody')).toBe(false);
  });

  // A GameNight uid comes from their id there, so deleting one is forgetting
  // them until their next sign-in - and it would take the suspension with it.
  test('a GameNight account is suspended rather than deleted', async () => {
    const { boss } = await pair();
    const gn = serverModule.identity.identifyFromGameNight({ sub: '4242', name: 'Borrowed' });
    expect((await ask(boss, 'adminDeleteUser', { uid: gn.uid }, 'adminUserResult')).error).toMatch(
      /comes back/
    );
    expect(
      (await ask(boss, 'adminResetUserPassword', { uid: gn.uid }, 'adminUserResult')).error
    ).toMatch(/GameNight/);
    // Suspending one does work, which is the answer the refusal points at.
    expect(
      await ask(boss, 'adminSetUserDisabled', { uid: gn.uid, disabled: true }, 'adminUserResult')
    ).toMatchObject({ ok: true });
  });

  test('a reset link is sent rather than a password chosen for them', async () => {
    const { boss, theirs } = await pair();
    expect(
      await ask(boss, 'adminResetUserPassword', { uid: theirs.uid }, 'adminUserResult')
    ).toMatchObject({ ok: true });
  });

  test('every write is refused to somebody who is not an administrator', async () => {
    const { them, theirs } = await pair();
    let answered = false;
    them.on('adminUserResult', () => (answered = true));
    them.emit('adminCreateUser', { name: 'Sneaky', email: 's@example.com' });
    them.emit('adminSetUserRole', { uid: theirs.uid, role: 'admin' });
    them.emit('adminSetUserDisabled', { uid: theirs.uid, disabled: true });
    them.emit('adminSignOutUser', { uid: theirs.uid });
    them.emit('adminResetUserPassword', { uid: theirs.uid });
    them.emit('adminDeleteUser', { uid: theirs.uid });
    await new Promise((r) => setTimeout(r, 300));
    expect(answered).toBe(false);
    expect(serverModule.identity.isAdmin(theirs.uid)).toBe(false);
    expect(serverModule.identity.isDisabled(theirs.uid)).toBe(false);
    expect(serverModule.accounts.ownerOf('Sneaky')).toBeNull();
  });
});

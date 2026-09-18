// db-migrate.test.js - the files this server used to keep, read in once.
//
// The test that matters is the one about tokens: the file kept them as
// themselves and the database keeps a digest, and nobody may be signed out by
// that. A browser still sends the token it has; the store hashes it to look it
// up; the same person is still signed in.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrateFromFiles } = require('../server/db/migrate');
const { createMemoryDatabase } = require('../server/db');
const { createIdentityStore } = require('../server/identity');
const { createAccounts } = require('../server/accounts');
const { createSettingsStore } = require('../server/settings-store');
const { hashPassword } = require('../server/password');

describe('importing what the files held', () => {
  let dir;
  let db;
  let n = 0;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-migrate-'));
    db = createMemoryDatabase({ database: `migrate-${n++}` });
    db.reset();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  const run = () => migrateFromFiles({ db, saveDir: dir });

  test('nothing to import is not an error', async () => {
    expect(await run()).toEqual({});
  });

  // The whole point. The token in the file is the one the browser still has.
  test('a device token becomes a digest, and its browser stays signed in', async () => {
    write('identities.json', {
      version: 2,
      identities: [
        {
          uid: 'u_ann',
          name: 'Ann',
          avatar: '🦊',
          provider: 'guest',
          createdAt: 1000,
          lastSeenAt: 2000,
          prefs: { seat: 3 },
          tokens: [
            {
              token: 'the-real-token',
              id: 'abc123',
              label: 'Safari on iPhone',
              createdAt: 1000,
              lastSeenAt: 2000,
            },
          ],
        },
      ],
    });
    expect(await run()).toMatchObject({ identities: 1, devices: 1 });

    // The token itself is gone from everything that was written.
    const written = JSON.stringify(await db.identities.all());
    expect(`token: ${written.includes('the-real-token') ? 'leaked' : 'absent'}`).toBe(
      'token: absent'
    );

    // And the browser holding it is still signed in.
    const store = createIdentityStore({ db });
    await store.load();
    expect(store.verify('the-real-token')).toMatchObject({ uid: 'u_ann', name: 'Ann' });
    expect(store.verify('the-real-token').prefs).toEqual({ seat: 3 });
    const row = store.sessions('u_ann', 'the-real-token')[0];
    expect(row).toMatchObject({ id: 'abc123', label: 'Safari on iPhone', current: true });
  });

  // Version 1 kept one token per record, on the record itself.
  test('a version 1 file is read too', async () => {
    write('identities.json', {
      version: 1,
      identities: [
        { uid: 'u_old', name: 'Old', avatar: '🧑', token: 'oldtok', createdAt: 1, lastSeenAt: 1 },
      ],
    });
    expect(await run()).toMatchObject({ identities: 1, devices: 1 });
    const store = createIdentityStore({ db });
    await store.load();
    expect(store.verify('oldtok')).toMatchObject({ uid: 'u_old', name: 'Old', provider: 'guest' });
    // A device with no name or id in the file gets both, or it is a row
    // nobody could ever sign out.
    const row = store.sessions('u_old')[0];
    expect(row.label).toBe('A browser');
    expect(row.id).toMatch(/^[0-9a-f]{16}$/);
  });

  test('an identity with no device is nobody, as it always was', async () => {
    write('identities.json', {
      version: 2,
      identities: [{ uid: 'u_empty', name: 'Ghost', tokens: [] }],
    });
    expect(await run()).toMatchObject({ identities: 0 });
    expect(await db.identities.count()).toBe(0);
  });

  test('settings and accounts come across', async () => {
    write('settings.json', { version: 1, settings: { gamenight: { issuer: 'x' }, other: 2 } });
    write('accounts.json', {
      version: 1,
      accounts: [
        {
          uid: 'u_ann',
          key: 'ann',
          name: 'Ann',
          email: 'ann@example.com',
          password: hashPassword('correct horse'),
          createdAt: 1,
          verifiedAt: 2,
        },
      ],
      pending: [],
      resets: [],
    });
    expect(await run()).toMatchObject({ settings: 2, accounts: 1 });

    const settings = createSettingsStore({ db });
    await settings.load();
    expect(settings.get('gamenight')).toEqual({ issuer: 'x' });

    const accounts = createAccounts({ db });
    await accounts.load();
    expect(accounts.ownerOf('Ann')).toBe('u_ann');
    expect(accounts.signIn('Ann', 'correct horse')).toMatchObject({ uid: 'u_ann' });
  });

  // Never deleted: the first run of this against real data is the run where
  // having the old copy still matters.
  test('an imported file is set aside rather than removed', async () => {
    write('settings.json', { version: 1, settings: { a: 1 } });
    await run();
    expect(fs.existsSync(path.join(dir, 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'settings.json.imported'))).toBe(true);
  });

  test('a second boot imports nothing, even with the file put back', async () => {
    write('settings.json', { version: 1, settings: { a: 1 } });
    await run();
    write('settings.json', { version: 1, settings: { a: 99, b: 2 } });
    expect(await run()).toEqual({});
    const settings = createSettingsStore({ db });
    await settings.load();
    expect(settings.get('a')).toBe(1);
    expect(settings.get('b')).toBeNull();
  });

  // Per kind rather than all or nothing: a server that imported its
  // identities last week and is meeting accounts for the first time today
  // imports only those.
  test('each kind is judged on its own', async () => {
    write('settings.json', { version: 1, settings: { a: 1 } });
    await run();
    write('accounts.json', {
      version: 1,
      accounts: [
        {
          uid: 'u_b',
          key: 'bob',
          name: 'Bob',
          email: 'b@e.com',
          password: hashPassword('a good password'),
          createdAt: 1,
        },
      ],
    });
    expect(await run()).toMatchObject({ accounts: 1 });
  });

  test('a corrupt file is skipped and left where it is', async () => {
    fs.writeFileSync(path.join(dir, 'identities.json'), '{not json');
    expect(await run()).toEqual({});
    expect(fs.existsSync(path.join(dir, 'identities.json'))).toBe(true);
    expect(await db.identities.count()).toBe(0);
  });
});

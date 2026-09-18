// __tests__/admin-credential.test.js - the admin password: where it comes
// from, what it takes to change it, and what is on disk afterwards.
const { createAdminCredential, MIN_LENGTH } = require('../server/admin-credential');
const { createSettingsStore } = require('../server/settings-store');
const { createMemoryDatabase } = require('../server/db');

describe('admin password', () => {
  let db;
  let store;
  // Named, and emptied: a memory database is shared by name so that a server
  // restarting into the same one finds it there, which means two databases in
  // one test have to say they are two.
  beforeEach(() => {
    db = createMemoryDatabase({ database: 'admin-credential' });
    db.reset();
    store = createSettingsStore({ db });
  });

  // What is actually written down, read back the way the store will read it
  // on the next boot. The write is not waited on by set(), so a tick first.
  const saved = async () => {
    await Promise.resolve();
    const rows = await db.settings.all();
    const row = rows.find((r) => r.k === 'adminPassword');
    return { settings: { adminPassword: row ? row.v : null } };
  };

  test('no password anywhere means no admin surface', async () => {
    const cred = createAdminCredential({ settingsStore: store });
    expect(cred.isEnabled()).toBe(false);
    expect(await cred.verify('')).toBe(false);
    expect(await cred.verify('anything')).toBe(false);
    expect(cred.status()).toMatchObject({ enabled: false, source: null });
    // With no way in, there is no way to set one either.
    expect(await cred.change('', 'a-good-password')).toMatch(/no admin password/i);
  });

  test('an empty or whitespace environment password is not a password', async () => {
    for (const value of ['', '   ', undefined]) {
      const cred = createAdminCredential({ settingsStore: store, envPassword: value });
      expect(cred.isEnabled()).toBe(false);
      expect(await cred.verify('')).toBe(false);
      expect(await cred.verify('   ')).toBe(false);
    }
  });

  test('the environment supplies the first one', async () => {
    const cred = createAdminCredential({ settingsStore: store, envPassword: 'from-the-env' });
    expect(cred.isEnabled()).toBe(true);
    expect(await cred.verify('from-the-env')).toBe(true);
    expect(await cred.verify('from-the-emv')).toBe(false);
    expect(cred.status()).toMatchObject({ source: 'env', updatedAt: null });
  });

  test('changing it needs the current one, and a new one worth having', async () => {
    const cred = createAdminCredential({ settingsStore: store, envPassword: 'first-password' });
    expect(await cred.change('wrong', 'a-good-password')).toMatch(/not the current password/i);
    expect(await cred.change('first-password', 'short')).toMatch(
      new RegExp(`at least ${MIN_LENGTH} characters`)
    );
    expect(await cred.change('first-password', '')).toMatch(/enter a new password/i);
    expect(await cred.change('first-password', 'x'.repeat(200))).toMatch(/at most/i);
    expect(await cred.change('first-password', 'first-password')).toMatch(/already the password/i);
    // None of that should have changed anything.
    expect(await cred.verify('first-password')).toBe(true);
    expect(store.get('adminPassword')).toBeNull();
  });

  test('a change is stored hashed, and beats the environment from then on', async () => {
    const cred = createAdminCredential({ settingsStore: store, envPassword: 'first-password' });
    expect(await cred.change('first-password', 'second-password')).toBeNull();
    expect(await cred.verify('second-password')).toBe(true);
    expect(await cred.verify('first-password')).toBe(false);
    expect(cred.status()).toMatchObject({ source: 'saved' });
    expect(cred.status().updatedAt).toEqual(expect.any(Number));

    const record = (await saved()).settings.adminPassword;
    expect(record).toMatchObject({ algo: 'scrypt' });
    expect(record.salt).toEqual(expect.any(String));
    expect(JSON.stringify(record)).not.toContain('second-password');

    // A new process reads what was stored, not the environment.
    const reopened = createSettingsStore({ db });
    await reopened.load();
    const next = createAdminCredential({
      settingsStore: reopened,
      envPassword: 'first-password',
    });
    expect(await next.verify('second-password')).toBe(true);
    expect(await next.verify('first-password')).toBe(false);
  });

  test('two servers with the same password do not share a hash', async () => {
    const a = createAdminCredential({ settingsStore: store, envPassword: 'seed-password' });
    await a.change('seed-password', 'same-password');
    const otherDb = createMemoryDatabase({ database: 'admin-credential-other' });
    otherDb.reset();
    {
      const b = createAdminCredential({
        settingsStore: createSettingsStore({ db: otherDb }),
        envPassword: 'seed-password',
      });
      await b.change('seed-password', 'same-password');
      const one = (await saved()).settings.adminPassword;
      await Promise.resolve();
      const two = (await otherDb.settings.all()).find((r) => r.k === 'adminPassword').v;
      expect(one.salt).not.toBe(two.salt);
      expect(one.hash).not.toBe(two.hash);
    }
  });

  test('removing the stored record falls back to the environment', async () => {
    const cred = createAdminCredential({ settingsStore: store, envPassword: 'first-password' });
    await cred.change('first-password', 'second-password');
    store.set('adminPassword', null);
    await Promise.resolve();
    const reopened = createSettingsStore({ db });
    await reopened.load();
    const recovered = createAdminCredential({
      settingsStore: reopened,
      envPassword: 'first-password',
    });
    expect(await recovered.verify('first-password')).toBe(true);
    expect(recovered.status()).toMatchObject({ source: 'env' });
  });

  test('a corrupt stored record is ignored rather than locking everybody out', async () => {
    store.set('adminPassword', { algo: 'nonsense', hash: 'x' });
    const cred = createAdminCredential({
      settingsStore: store,
      envPassword: 'first-password',
    });
    expect(await cred.verify('first-password')).toBe(true);
    expect(cred.status()).toMatchObject({ source: 'env' });
  });

  test('without a settings store it still works, just not across a restart', async () => {
    const cred = createAdminCredential({ envPassword: 'first-password' });
    expect(await cred.change('first-password', 'second-password')).toBeNull();
    expect(await cred.verify('second-password')).toBe(true);
  });
});

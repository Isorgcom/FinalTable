// __tests__/admin-credential.test.js - the operator password: where it comes
// from, what it takes to change it, and what is on disk afterwards.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAdminCredential, MIN_LENGTH } = require('../server/admin-credential');
const { createSettingsStore } = require('../server/settings-store');

describe('operator password', () => {
  let dir;
  let store;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-admincred-'));
    store = createSettingsStore({ saveDir: dir });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const saved = () => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));

  test('no password anywhere means no operator surface', () => {
    const cred = createAdminCredential({ settingsStore: store });
    expect(cred.isEnabled()).toBe(false);
    expect(cred.verify('')).toBe(false);
    expect(cred.verify('anything')).toBe(false);
    expect(cred.status()).toMatchObject({ enabled: false, source: null });
    // With no way in, there is no way to set one either.
    expect(cred.change('', 'a-good-password')).toMatch(/no operator password/i);
  });

  test('an empty or whitespace environment password is not a password', () => {
    for (const value of ['', '   ', undefined]) {
      const cred = createAdminCredential({ settingsStore: store, envPassword: value });
      expect(cred.isEnabled()).toBe(false);
      expect(cred.verify('')).toBe(false);
      expect(cred.verify('   ')).toBe(false);
    }
  });

  test('the environment supplies the first one', () => {
    const cred = createAdminCredential({ settingsStore: store, envPassword: 'from-the-env' });
    expect(cred.isEnabled()).toBe(true);
    expect(cred.verify('from-the-env')).toBe(true);
    expect(cred.verify('from-the-emv')).toBe(false);
    expect(cred.status()).toMatchObject({ source: 'env', updatedAt: null });
  });

  test('changing it needs the current one, and a new one worth having', () => {
    const cred = createAdminCredential({ settingsStore: store, envPassword: 'first-password' });
    expect(cred.change('wrong', 'a-good-password')).toMatch(/not the current password/i);
    expect(cred.change('first-password', 'short')).toMatch(
      new RegExp(`at least ${MIN_LENGTH} characters`)
    );
    expect(cred.change('first-password', '')).toMatch(/enter a new password/i);
    expect(cred.change('first-password', 'x'.repeat(200))).toMatch(/at most/i);
    expect(cred.change('first-password', 'first-password')).toMatch(/already the password/i);
    // None of that should have changed anything.
    expect(cred.verify('first-password')).toBe(true);
    expect(fs.existsSync(path.join(dir, 'settings.json'))).toBe(false);
  });

  test('a change is stored hashed, and beats the environment from then on', () => {
    const cred = createAdminCredential({ settingsStore: store, envPassword: 'first-password' });
    expect(cred.change('first-password', 'second-password')).toBeNull();
    expect(cred.verify('second-password')).toBe(true);
    expect(cred.verify('first-password')).toBe(false);
    expect(cred.status()).toMatchObject({ source: 'saved' });
    expect(cred.status().updatedAt).toEqual(expect.any(Number));

    const record = saved().settings.adminPassword;
    expect(record).toMatchObject({ algo: 'scrypt' });
    expect(record.salt).toEqual(expect.any(String));
    expect(JSON.stringify(record)).not.toContain('second-password');

    // A new process reads the file, not the environment.
    const next = createAdminCredential({
      settingsStore: createSettingsStore({ saveDir: dir }),
      envPassword: 'first-password',
    });
    expect(next.verify('second-password')).toBe(true);
    expect(next.verify('first-password')).toBe(false);
  });

  test('two servers with the same password do not share a hash', () => {
    const a = createAdminCredential({ settingsStore: store, envPassword: 'seed-password' });
    a.change('seed-password', 'same-password');
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-admincred2-'));
    try {
      const b = createAdminCredential({
        settingsStore: createSettingsStore({ saveDir: otherDir }),
        envPassword: 'seed-password',
      });
      b.change('seed-password', 'same-password');
      const one = saved().settings.adminPassword;
      const two = JSON.parse(fs.readFileSync(path.join(otherDir, 'settings.json'), 'utf8')).settings
        .adminPassword;
      expect(one.salt).not.toBe(two.salt);
      expect(one.hash).not.toBe(two.hash);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test('removing the stored record falls back to the environment', () => {
    const cred = createAdminCredential({ settingsStore: store, envPassword: 'first-password' });
    cred.change('first-password', 'second-password');
    store.set('adminPassword', null);
    const recovered = createAdminCredential({
      settingsStore: createSettingsStore({ saveDir: dir }),
      envPassword: 'first-password',
    });
    expect(recovered.verify('first-password')).toBe(true);
    expect(recovered.status()).toMatchObject({ source: 'env' });
  });

  test('a corrupt stored record is ignored rather than locking everybody out', () => {
    store.set('adminPassword', { algo: 'nonsense', hash: 'x' });
    const cred = createAdminCredential({
      settingsStore: createSettingsStore({ saveDir: dir }),
      envPassword: 'first-password',
    });
    expect(cred.verify('first-password')).toBe(true);
    expect(cred.status()).toMatchObject({ source: 'env' });
  });

  test('without a settings store it still works, just not across a restart', () => {
    const cred = createAdminCredential({ envPassword: 'first-password' });
    expect(cred.change('first-password', 'second-password')).toBeNull();
    expect(cred.verify('second-password')).toBe(true);
  });
});

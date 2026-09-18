// accounts.test.js - a name on this server that is yours.
//
// The three rules about names are the whole of it: an account owns its name, a
// name can be claimed when nobody else holds it, and a sign-up holds a name
// while it is pending without owning it.
const { createAccounts, normalizeEmail } = require('../server/accounts');
const { createMemoryDatabase } = require('../server/db');

describe('accounts', () => {
  let db;
  const make = (extra = {}) =>
    createAccounts({
      db,
      nameKey: (v) =>
        String(v || '')
          .trim()
          .toLocaleLowerCase(),
      ...extra,
    });

  beforeEach(() => {
    db = createMemoryDatabase({ database: 'accounts-test' });
    db.reset();
  });

  const signUp = (store, over = {}) =>
    store.startSignUp({
      uid: 'u_ann',
      name: 'Ann',
      email: 'ann@example.com',
      password: 'correct horse',
      ...over,
    });

  test('a sign-up holds the name and does not own it', () => {
    const store = make();
    const started = signUp(store);
    expect(started.token).toBeTruthy();
    expect(store.ownerOf('Ann')).toBeNull();
    expect(store.isHeld('Ann')).toBe(true);
    // Somebody else cannot start one on the same name while it is held.
    expect(signUp(store, { uid: 'u_bob' }).error).toMatch(/already signing up/);

    const done = store.completeSignUp(started.token);
    expect(done).toEqual({ uid: 'u_ann', name: 'Ann' });
    expect(store.ownerOf('ANN')).toBe('u_ann');
  });

  // The rule that stops a mistyped address locking a name away for ever.
  test('a hold expires and gives the name back', () => {
    let clock = 1_000_000;
    const store = make({ verifyTtlMs: 1000, now: () => clock });
    const started = signUp(store);
    clock += 5000;
    expect(store.isHeld('Ann')).toBe(false);
    expect(store.completeSignUp(started.token).error).toMatch(/expired/);
    // And somebody else may have it now.
    expect(signUp(store, { uid: 'u_bob' }).token).toBeTruthy();
  });

  test('an owned name is refused to anybody else, and is still yours', () => {
    const store = make();
    store.completeSignUp(signUp(store).token);
    expect(signUp(store, { uid: 'u_bob' }).error).toMatch(/taken/);
    // Your own name is not taken from you: a second sign-up replaces the
    // password you were setting.
    expect(signUp(store).token).toBeTruthy();
  });

  // The accounts file cannot know who is at a table; the identity store is
  // asked.
  test('a name somebody else is playing under cannot be claimed', () => {
    const store = make({ nameInUse: (key, uid) => key === 'ann' && uid !== 'u_ann' });
    expect(signUp(store, { uid: 'u_bob', name: 'Ann' }).error).toMatch(/Pick another/);
    expect(signUp(store).token).toBeTruthy();
  });

  test('a bad password or a bad address is refused before anything is held', () => {
    const store = make();
    expect(signUp(store, { password: 'short' }).error).toMatch(/at least/);
    expect(signUp(store, { email: 'not-an-address' }).error).toMatch(/email address/);
    expect(store.isHeld('Ann')).toBe(false);
  });

  test('signing in answers the same way to a wrong password and an absent name', () => {
    const store = make();
    store.completeSignUp(signUp(store).token);
    expect(store.signIn('Ann', 'correct horse')).toEqual({ uid: 'u_ann', name: 'Ann' });
    expect(store.signIn('Ann', 'wrong')).toBeNull();
    expect(store.signIn('Nobody', 'correct horse')).toBeNull();
  });

  test('a reset link works once, and not after it has expired', () => {
    let clock = 1_000_000;
    const store = make({ resetTtlMs: 1000, now: () => clock });
    store.completeSignUp(signUp(store).token);

    expect(store.startReset('Nobody')).toBeNull();
    const asked = store.startReset('ann');
    expect(asked.email).toBe('ann@example.com');
    // The page can be drawn without spending the link.
    expect(store.resetSubject(asked.token)).toEqual({ uid: 'u_ann', name: 'Ann' });
    expect(store.completeReset(asked.token, 'a new password')).toEqual({
      uid: 'u_ann',
      name: 'Ann',
    });
    expect(store.signIn('Ann', 'a new password')).toBeTruthy();
    // Once.
    expect(store.completeReset(asked.token, 'another one').error).toMatch(/not one of ours/);

    const second = store.startReset('Ann');
    clock += 5000;
    expect(store.resetSubject(second.token)).toBeNull();
    expect(store.completeReset(second.token, 'too late now').error).toMatch(/expired/);
  });

  // A failed attempt spends the link too: one that survives is one somebody
  // can keep trying.
  test('a reset link is spent even by a password it refuses', () => {
    const store = make();
    store.completeSignUp(signUp(store).token);
    const asked = store.startReset('Ann');
    expect(store.completeReset(asked.token, 'short').error).toMatch(/at least/);
    expect(store.completeReset(asked.token, 'a good long one').error).toMatch(/not one of ours/);
  });

  test('changing a password wants the old one', () => {
    const store = make();
    store.completeSignUp(signUp(store).token);
    expect(store.changePassword('u_ann', 'wrong', 'a new password')).toMatch(/current password/);
    expect(store.changePassword('u_ann', 'correct horse', 'short')).toMatch(/at least/);
    expect(store.changePassword('u_ann', 'correct horse', 'a new password')).toBeNull();
    expect(store.signIn('Ann', 'a new password')).toBeTruthy();
  });

  // What is stored is what a stolen copy of the database would give somebody.
  test('neither a password nor a live link is ever written down', async () => {
    const store = make();
    const started = signUp(store);
    store.completeSignUp(started.token);
    const asked = store.startReset('Ann');
    await store.flush();

    const raw = JSON.stringify(await db.accounts.all());
    for (const secret of ['correct horse', started.token, asked.token]) {
      expect(`${secret}: ${raw.includes(secret) ? 'leaked' : 'absent'}`).toBe(`${secret}: absent`);
    }
    // The address is there, because that is the one thing it is for.
    expect(raw).toContain('ann@example.com');
  });

  test('an account comes back after a restart', async () => {
    const store = make();
    store.completeSignUp(signUp(store).token);
    await store.flush();

    const back = make();
    expect(await back.load()).toBe(1);
    expect(back.size).toBe(1);
    expect(back.ownerOf('Ann')).toBe('u_ann');
    expect(back.signIn('Ann', 'correct horse')).toBeTruthy();
  });

  test('a store with nowhere to write still works, just not across a restart', async () => {
    const store = createAccounts({});
    const started = store.startSignUp({
      uid: 'u_ann',
      name: 'Ann',
      email: 'ann@example.com',
      password: 'correct horse',
    });
    expect(store.completeSignUp(started.token)).toMatchObject({ uid: 'u_ann' });
    expect(store.signIn('Ann', 'correct horse')).toBeTruthy();
    await store.flush();
  });

  test('addresses are taken as they are, within reason', () => {
    expect(normalizeEmail('  Ann@Example.COM ')).toBe('ann@example.com');
    expect(normalizeEmail('ann@localhost')).toBeNull();
    expect(normalizeEmail('@example.com')).toBeNull();
    expect(normalizeEmail('ann@')).toBeNull();
    expect(normalizeEmail('two words@example.com')).toBeNull();
    expect(normalizeEmail('')).toBeNull();
  });
});

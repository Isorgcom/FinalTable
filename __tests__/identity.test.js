// __tests__/identity.test.js - the identity store: tokens, uids, persistence
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createIdentityStore } = require('../server/identity');

describe('identity store', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finaltable-identity-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('identify mints a token that is not the uid and reidentifies the same uid', () => {
    const store = createIdentityStore();
    const first = store.identify({ name: 'Bryce', avatar: '🦊' });
    expect(first.isNew).toBe(true);
    expect(first.uid).toMatch(/^u_/);
    expect(first.token).not.toBe(first.uid);
    expect(first.token.length).toBeGreaterThanOrEqual(24);
    const again = store.identify({ token: first.token, name: 'Bryce', avatar: '🦊' });
    expect(again.isNew).toBe(false);
    expect(again.uid).toBe(first.uid);
    expect(again.token).toBe(first.token);
  });

  test('an unknown token mints a fresh identity; a new one needs a name', () => {
    const store = createIdentityStore();
    expect(store.identify({ token: 'nope', name: '' })).toBeNull();
    const fresh = store.identify({ token: 'nope', name: 'Ann' });
    expect(fresh.isNew).toBe(true);
    expect(fresh.token).not.toBe('nope');
  });

  test('verify, get and rename agree', () => {
    const store = createIdentityStore();
    const me = store.identify({ name: 'Bryce', avatar: '🦊' });
    expect(store.verify(me.token)).toMatchObject({ uid: me.uid, name: 'Bryce', avatar: '🦊' });
    expect(store.verify('unknown')).toBeNull();
    expect(store.get(me.uid)).toEqual({ uid: me.uid, name: 'Bryce', avatar: '🦊' });
    store.rename(me.uid, { name: 'B', avatar: '🐸' });
    expect(store.get(me.uid)).toEqual({ uid: me.uid, name: 'B', avatar: '🐸' });
    // Re-identifying with an empty name keeps the stored one.
    expect(store.identify({ token: me.token, name: '' }).name).toBe('B');
  });

  test('idle identities expire', () => {
    let clock = 1000;
    const store = createIdentityStore({ ttlMs: 500, now: () => clock });
    const a = store.identify({ name: 'A' });
    clock += 300;
    const b = store.identify({ name: 'B' });
    clock += 300;
    expect(store.expireIdle()).toBe(1);
    expect(store.verify(a.token)).toBeNull();
    expect(store.verify(b.token)).not.toBeNull();
  });

  test('identities persist to the save dir and survive a new store', () => {
    const store = createIdentityStore({ saveDir: dir });
    const me = store.identify({ name: 'Bryce', avatar: '🦊' });
    store.flush();
    const reopened = createIdentityStore({ saveDir: dir });
    expect(reopened.size).toBe(1);
    expect(reopened.verify(me.token)).toMatchObject({ uid: me.uid, name: 'Bryce' });
  });

  test('a corrupt file starts the store empty', () => {
    fs.writeFileSync(path.join(dir, 'identities.json'), '{not json');
    const store = createIdentityStore({ saveDir: dir });
    expect(store.size).toBe(0);
  });
});

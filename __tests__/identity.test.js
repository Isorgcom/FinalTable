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
    expect(store.get(me.uid)).toEqual({
      uid: me.uid,
      name: 'Bryce',
      avatar: '🦊',
      provider: 'guest',
    });
    store.rename(me.uid, { name: 'B', avatar: '🐸' });
    expect(store.get(me.uid)).toEqual({ uid: me.uid, name: 'B', avatar: '🐸', provider: 'guest' });
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

  // Reading the file back rather than reaching for internals: what matters is
  // whether the disk was touched, not how the store decided to touch it.
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const identFile = () => path.join(dir, 'identities.json');
  const readIdentities = () => JSON.parse(fs.readFileSync(identFile(), 'utf8')).identities;

  test('a reconnect does not write; a mint and a rename do', async () => {
    // A material flush is near-instant here so the test can watch for it; the
    // touch tier is parked far out of reach so a touch cannot masquerade as one.
    const store = createIdentityStore({ saveDir: dir, flushDebounceMs: 5, touchFlushMs: 60000 });
    const me = store.identify({ name: 'Bryce', avatar: '🦊' });
    await settle(40);
    expect(readIdentities()).toHaveLength(1);

    // The ordinary reconnect: same token, same name, same avatar. This is the
    // hot path - it runs on every connect - and it must not reach the disk.
    fs.rmSync(identFile());
    store.identify({ token: me.token, name: 'Bryce', avatar: '🦊' });
    await settle(40);
    expect(fs.existsSync(identFile())).toBe(false);

    // A name that actually moves is a different matter.
    store.identify({ token: me.token, name: 'Bee', avatar: '🦊' });
    await settle(40);
    expect(readIdentities()[0]).toMatchObject({ name: 'Bee' });
  });

  test('a touched lastSeenAt still reaches the disk on the slow tier', async () => {
    const store = createIdentityStore({ saveDir: dir, flushDebounceMs: 5, touchFlushMs: 10 });
    const me = store.identify({ name: 'Ann' });
    await settle(40);
    const before = readIdentities()[0].lastSeenAt;
    store.verify(me.token);
    await settle(60);
    expect(readIdentities()[0].lastSeenAt).toBeGreaterThanOrEqual(before);
    expect(readIdentities()).toHaveLength(1);
  });

  test('overlapping writes leave one whole file and no tmp litter', async () => {
    const store = createIdentityStore({ saveDir: dir, flushDebounceMs: 1, touchFlushMs: 1 });
    for (let i = 0; i < 40; i++) store.identify({ name: `P${i}` });
    await settle(120);
    expect(readIdentities()).toHaveLength(40);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  test('flush is synchronous, so shutdown can rely on it', () => {
    const store = createIdentityStore({ saveDir: dir, flushDebounceMs: 60000 });
    store.identify({ name: 'Zed' });
    expect(fs.existsSync(identFile())).toBe(false);
    store.flush();
    // No await: the file is on disk by the time flush returns.
    expect(readIdentities()).toHaveLength(1);
  });

  // ── GameNight identities ──────────────────────────────────────────────────

  test('a GameNight sign-in is one identity with a device token per browser', () => {
    const store = createIdentityStore();
    const phone = store.identifyFromGameNight({ sub: '42', name: 'bryce' });
    expect(phone.isNew).toBe(true);
    expect(phone.uid).toBe('gn_42');
    expect(phone.provider).toBe('gamenight');
    const ipad = store.identifyFromGameNight({ sub: '42', name: 'bryce' });
    expect(ipad.isNew).toBe(false);
    expect(ipad.uid).toBe('gn_42');
    expect(ipad.token).not.toBe(phone.token);
    // Both browsers stay signed in.
    expect(store.verify(phone.token)).toMatchObject({ uid: 'gn_42' });
    expect(store.verify(ipad.token)).toMatchObject({ uid: 'gn_42' });
    expect(store.size).toBe(1);
  });

  test("the name is GameNight's: refreshed on sign-in, never taken from the browser", () => {
    const store = createIdentityStore();
    const me = store.identifyFromGameNight({ sub: '7', name: 'oldname', avatar: '🦊' });
    // A reconnect sending some other name changes nothing but the avatar.
    const again = store.identify({ token: me.token, name: 'impostor', avatar: '🐸' });
    expect(again).toMatchObject({
      uid: 'gn_7',
      name: 'oldname',
      avatar: '🐸',
      provider: 'gamenight',
    });
    expect(store.rename('gn_7', { name: 'impostor' })).toMatchObject({ name: 'oldname' });
    // The account was renamed on GameNight; the next sign-in carries it.
    store.identifyFromGameNight({ sub: '7', name: 'newname' });
    expect(store.get('gn_7')).toMatchObject({ name: 'newname' });
  });

  test('a stale GameNight token with no name mints nothing', () => {
    const store = createIdentityStore();
    expect(store.identify({ token: 'gone', avatar: '🦊' })).toBeNull();
    expect(store.size).toBe(0);
  });

  test('identifyFromGameNight refuses a missing subject or an empty name', () => {
    const store = createIdentityStore();
    expect(store.identifyFromGameNight({ name: 'x' })).toBeNull();
    expect(store.identifyFromGameNight({ sub: '1', name: '' })).toBeNull();
  });

  test('a GameNight identity outlives one expired device and goes with the last', () => {
    let clock = 1000;
    const store = createIdentityStore({ ttlMs: 500, now: () => clock });
    const a = store.identifyFromGameNight({ sub: '9', name: 'nine' });
    clock += 300;
    const b = store.identifyFromGameNight({ sub: '9', name: 'nine' });
    clock += 300;
    expect(store.expireIdle()).toBe(0);
    expect(store.verify(a.token)).toBeNull();
    expect(store.verify(b.token)).not.toBeNull();
    clock += 600;
    expect(store.expireIdle()).toBe(1);
    expect(store.get('gn_9')).toBeNull();
  });

  test('provider and GameNight id persist, and a version 1 file still loads', () => {
    const store = createIdentityStore({ saveDir: dir });
    const gn = store.identifyFromGameNight({ sub: '3', name: 'three' });
    const guest = store.identify({ name: 'Ann' });
    store.flush();
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'identities.json'), 'utf8'));
    expect(raw.version).toBe(2);
    const reopened = createIdentityStore({ saveDir: dir });
    expect(reopened.verify(gn.token)).toMatchObject({ uid: 'gn_3', provider: 'gamenight' });
    expect(reopened.verify(guest.token)).toMatchObject({ uid: guest.uid, provider: 'guest' });

    fs.writeFileSync(
      path.join(dir, 'identities.json'),
      JSON.stringify({
        version: 1,
        identities: [
          { token: 'oldtok', uid: 'u_old', name: 'Old', avatar: '🧑', createdAt: 1, lastSeenAt: 1 },
        ],
      })
    );
    const legacy = createIdentityStore({ saveDir: dir });
    expect(legacy.verify('oldtok')).toMatchObject({ uid: 'u_old', name: 'Old', provider: 'guest' });
  });
});

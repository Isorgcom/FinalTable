// __tests__/identity.test.js - the identity store: tokens, uids, persistence
const { createIdentityStore } = require('../server/identity');
const { createMemoryDatabase } = require('../server/db');

describe('identity store', () => {
  // A database is shared by name, so that a server restarting into the same
  // one finds it there. A test that wants an empty one says which.
  const freshDb = (name) => {
    const db = createMemoryDatabase({ database: `identity-${name}` });
    db.reset();
    return db;
  };

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

  test('identities are written down and survive a new store', async () => {
    const db = freshDb('persist');
    const store = createIdentityStore({ db });
    const me = store.identify({ name: 'Bryce', avatar: '🦊' });
    await store.flush();

    const reopened = createIdentityStore({ db });
    expect(await reopened.load()).toBe(1);
    expect(reopened.size).toBe(1);
    expect(reopened.verify(me.token)).toMatchObject({ uid: me.uid, name: 'Bryce' });
  });

  // The token is a bearer thing: whoever holds it is signed in. So what is
  // written down is a digest of it, and a copy of the database is not a set of
  // live sessions.
  test('the token itself is never written down', async () => {
    const db = freshDb('digests');
    const store = createIdentityStore({ db });
    const me = store.identify({ name: 'Bryce' });
    await store.flush();

    const written = JSON.stringify(await db.identities.all());
    expect(`token: ${written.includes(me.token) ? 'leaked' : 'absent'}`).toBe('token: absent');
    // And the digest that is there is enough to sign the same browser back in.
    const reopened = createIdentityStore({ db });
    await reopened.load();
    expect(reopened.verify(me.token)).toMatchObject({ uid: me.uid });
  });

  test('a store with nowhere to write still works, just not across a restart', async () => {
    const store = createIdentityStore();
    const me = store.identify({ name: 'Nowhere' });
    expect(store.verify(me.token)).toMatchObject({ uid: me.uid });
    await store.flush();
    expect(store.size).toBe(1);
  });

  // Reading back what was stored rather than reaching for internals: what
  // matters is whether anything was written, not how the store decided to.
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  test('a reconnect does not write; a mint and a rename do', async () => {
    // A material flush is near-instant here so the test can watch for it; the
    // touch tier is parked far out of reach so a touch cannot masquerade as one.
    const db = freshDb('writes');
    let writes = 0;
    const counted = { ...db, identities: { ...db.identities } };
    counted.identities.put = (row) => {
      writes++;
      return db.identities.put(row);
    };
    const store = createIdentityStore({ db: counted, flushDebounceMs: 5, touchFlushMs: 60000 });
    const me = store.identify({ name: 'Bryce', avatar: '🦊' });
    await settle(40);
    expect(writes).toBe(1);

    // The ordinary reconnect: same token, same name, same avatar. This is the
    // hot path - it runs on every connect - and it must not be written.
    store.identify({ token: me.token, name: 'Bryce', avatar: '🦊' });
    await settle(40);
    expect(writes).toBe(1);

    // A name that actually moves is a different matter.
    store.identify({ token: me.token, name: 'Bee', avatar: '🦊' });
    await settle(40);
    expect(writes).toBe(2);
    expect((await db.identities.all())[0]).toMatchObject({ name: 'Bee' });
  });

  test('a touched lastSeenAt still reaches the store on the slow tier', async () => {
    const db = freshDb('touch');
    const store = createIdentityStore({ db, flushDebounceMs: 5, touchFlushMs: 10 });
    const me = store.identify({ name: 'Ann' });
    await settle(40);
    const before = (await db.identities.all())[0].lastSeenAt;
    store.verify(me.token);
    await settle(60);
    const rows = await db.identities.all();
    expect(rows[0].lastSeenAt).toBeGreaterThanOrEqual(before);
    expect(rows).toHaveLength(1);
  });

  test('a burst of writes settles with everybody in it', async () => {
    const db = freshDb('burst');
    const store = createIdentityStore({ db, flushDebounceMs: 1, touchFlushMs: 1 });
    for (let i = 0; i < 40; i++) store.identify({ name: `P${i}` });
    await settle(150);
    expect(await db.identities.all()).toHaveLength(40);
  });

  test('flush resolves when everything is written, so shutdown can wait on it', async () => {
    const db = freshDb('flush');
    const store = createIdentityStore({ db, flushDebounceMs: 60000 });
    store.identify({ name: 'Zed' });
    expect(await db.identities.all()).toHaveLength(0);
    await store.flush();
    expect(await db.identities.all()).toHaveLength(1);
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

  test('provider and GameNight id survive a restart', async () => {
    const db = freshDb('provider');
    const store = createIdentityStore({ db });
    const gn = store.identifyFromGameNight({ sub: '3', name: 'three' });
    const guest = store.identify({ name: 'Ann' });
    await store.flush();

    const reopened = createIdentityStore({ db });
    await reopened.load();
    expect(reopened.verify(gn.token)).toMatchObject({ uid: 'gn_3', provider: 'gamenight' });
    expect(reopened.verify(guest.token)).toMatchObject({ uid: guest.uid, provider: 'guest' });
  });

  // Preferences belong to the person, so they hang off the identity and not
  // off the browser. A closed set with a validator each, because this is the
  // one place a client can ask the server to write something it keeps.
  test('preferences are kept against the identity, and only the ones named', () => {
    const store = createIdentityStore();
    const me = store.identify({ name: 'Bryce' });
    expect(me.prefs).toEqual({});

    expect(store.setPrefs(me.uid, { muted: true, seat: 3, panelTab: 'stats' })).toEqual({
      muted: true,
      seat: 3,
      panelTab: 'stats',
    });
    // A patch, so one setting moves and the others stay.
    expect(store.setPrefs(me.uid, { seat: 0 })).toEqual({
      muted: true,
      seat: 0,
      panelTab: 'stats',
    });
    // And the owner is handed them back when they identify again.
    expect(store.identify({ token: me.token }).prefs).toEqual({
      muted: true,
      seat: 0,
      panelTab: 'stats',
    });

    // Anything not named is dropped, and so is a named one of the wrong shape.
    expect(store.setPrefs(me.uid, { colour: 'green', muted: 'yes', seat: 99 })).toBeNull();
    expect(store.setPrefs(me.uid, { seat: 7, nonsense: { big: 'x'.repeat(5000) } })).toEqual({
      muted: true,
      seat: 7,
      panelTab: 'stats',
    });
    // A tab the panel does not have is not worth storing for years.
    expect(store.setPrefs(me.uid, { panelTab: 'sound' })).toBeNull();
    // Clearing the chair is a value, not an absence.
    expect(store.setPrefs(me.uid, { seat: null }).seat).toBeNull();
    // Nobody there to have a preference.
    expect(store.setPrefs('u_nobody', { muted: true })).toBeNull();
    expect(store.setPrefs(me.uid, {})).toBeNull();
  });

  // How the cards look is three more of the same thing, and the reason they
  // are a closed vocabulary rather than free text is that a value coming back
  // off the disk in a year has to be one the client can still draw.
  test('the card settings are kept, and only the ones the client can draw', () => {
    const store = createIdentityStore();
    const me = store.identify({ name: 'Bryce' });
    const chosen = { cardBack: 'ivory', deck: 'four', cardFace: 'large' };

    expect(store.setPrefs(me.uid, chosen)).toEqual(chosen);
    expect(store.identify({ token: me.token }).prefs).toEqual(chosen);

    // A back nobody ever drew, a deck of no colours at all, and a face that
    // is not one of the two. None of them move what was already settled.
    expect(store.setPrefs(me.uid, { cardBack: 'tartan' })).toBeNull();
    expect(store.setPrefs(me.uid, { deck: 'three' })).toBeNull();
    expect(store.setPrefs(me.uid, { cardFace: 'huge' })).toBeNull();
    expect(store.verify(me.token).prefs).toEqual(chosen);
  });

  // A preference nobody else should see. get() feeds every roster on the
  // server, and it carries the name and the avatar on purpose.
  test('preferences go to their owner, not into the roster', () => {
    const store = createIdentityStore();
    const me = store.identify({ name: 'Bryce' });
    store.setPrefs(me.uid, { muted: true, seat: 2 });
    expect(store.get(me.uid).prefs).toBeUndefined();
    expect(store.verify(me.token).prefs).toEqual({ muted: true, seat: 2 });
  });

  test('preferences survive a restart', async () => {
    const db = freshDb('prefs');
    const store = createIdentityStore({ db });
    const me = store.identify({ name: 'Bryce' });
    store.setPrefs(me.uid, { muted: true, seat: 5, panelTab: 'history' });
    await store.flush();

    const reopened = createIdentityStore({ db });
    await reopened.load();
    expect(reopened.verify(me.token).prefs).toEqual({
      muted: true,
      seat: 5,
      panelTab: 'history',
    });
  });

  test('an identity stored with no preferences comes back with none', async () => {
    const db = freshDb('noprefs');
    const store = createIdentityStore({ db });
    const me = store.identify({ name: 'Old' });
    await store.flush();
    // As a record written before there were any preferences would look.
    const row = (await db.identities.all())[0];
    delete row.prefs;
    await db.identities.put(row);

    const older = createIdentityStore({ db });
    await older.load();
    expect(older.verify(me.token).prefs).toEqual({});
  });

  // The devices an account is signed in on. A row is named by an id minted
  // beside the token, never by the token: the page asking is holding one
  // credential and has no business being handed the rest of them.
  const UA_IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
  const UA_MAC =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

  test('sessions name each device without ever carrying its token', () => {
    const store = createIdentityStore();
    const phone = store.identifyFromGameNight({ sub: '7', name: 'Bryce', userAgent: UA_IPHONE });
    const mac = store.identifyFromGameNight({ sub: '7', name: 'Bryce', userAgent: UA_MAC });
    expect(mac.uid).toBe(phone.uid);

    const rows = store.sessions(phone.uid, mac.token);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.label).sort()).toEqual(['Chrome on Mac', 'Safari on iPhone']);
    expect(rows.filter((r) => r.current)).toHaveLength(1);
    expect(rows.find((r) => r.current).label).toBe('Chrome on Mac');
    // No token, anywhere, under any name.
    const asText = JSON.stringify(rows);
    expect(asText).not.toContain(phone.token);
    expect(asText).not.toContain(mac.token);
    for (const row of rows) expect(row.id).toMatch(/^[0-9a-f]{16}$/);

    // Nobody else's devices, and nothing for an identity that is not there.
    expect(store.sessions('u_nobody')).toEqual([]);
  });

  test('a device is signed out by its id, and only from its own identity', () => {
    const store = createIdentityStore();
    const phone = store.identifyFromGameNight({ sub: '8', name: 'Bryce', userAgent: UA_IPHONE });
    const mac = store.identifyFromGameNight({ sub: '8', name: 'Bryce', userAgent: UA_MAC });
    const stranger = store.identify({ name: 'Someone else' });

    const phoneRow = store.sessions(phone.uid).find((r) => r.label === 'Safari on iPhone');
    // The id is not a secret; the uid is what authorises the sign-out.
    expect(store.endSession(stranger.uid, phoneRow.id)).toBeNull();
    expect(store.verify(phone.token)).toMatchObject({ uid: phone.uid });

    // What comes back is the digest of the token that went, never the token.
    expect(store.endSession(phone.uid, phoneRow.id)).toBe(store.hashToken(phone.token));
    expect(store.verify(phone.token)).toBeNull();
    expect(store.verify(mac.token)).toMatchObject({ uid: mac.uid });
    expect(store.sessions(mac.uid)).toHaveLength(1);
    // Gone is gone.
    expect(store.endSession(mac.uid, phoneRow.id)).toBeNull();
  });

  test('signing out the last device leaves nobody behind', () => {
    const store = createIdentityStore();
    const me = store.identify({ name: 'Bryce', userAgent: UA_MAC });
    expect(store.revokeToken(me.token)).toBe(true);
    expect(store.verify(me.token)).toBeNull();
    expect(store.get(me.uid)).toBeNull();
    expect(store.revokeToken(me.token)).toBe(false);
    expect(store.revokeToken('never-was-a-token')).toBe(false);
  });

  test('a device keeps its name and its id across a restart', async () => {
    const db = freshDb('device');
    const store = createIdentityStore({ db });
    const me = store.identify({ name: 'Bryce', userAgent: UA_IPHONE });
    const before = store.sessions(me.uid, me.token);
    await store.flush();

    const reopened = createIdentityStore({ db });
    await reopened.load();
    const after = reopened.sessions(me.uid, me.token);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].label).toBe('Safari on iPhone');
    expect(after[0].current).toBe(true);
    // And it can still be signed out by the id the file remembered.
    expect(reopened.endSession(me.uid, after[0].id)).toBe(reopened.hashToken(me.token));

    // A device stored before any of this had a name or an id gets both on the
    // way in, rather than leaving a row nobody can sign out.
    const bare = freshDb('bare-device');
    await bare.identities.put({
      uid: 'u_older',
      name: 'Old',
      nameKey: 'old',
      avatar: '🧑',
      provider: 'guest',
      createdAt: 1,
      lastSeenAt: 1,
      devices: [{ tokenHash: 'f'.repeat(64), createdAt: 1, lastSeenAt: 1 }],
    });
    const older = createIdentityStore({ db: bare });
    await older.load();
    const row = older.sessions('u_older')[0];
    expect(row.label).toBe('A browser');
    expect(row.id).toMatch(/^[0-9a-f]{16}$/);
    expect(older.endSession('u_older', row.id)).toBe('f'.repeat(64));
  });
});

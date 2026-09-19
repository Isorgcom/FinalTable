// __tests__/identity.test.js - the identity store: tokens, uids, persistence
//
// Nothing mints an identity from a name any more. Somebody becomes somebody by
// signing in to an account, so that is how these tests make one: signInAs is
// what the accounts store calls once a name and a password have gone together,
// and the uid it is handed is the account's.
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

  // An account signing in, which is the only way anybody arrives now.
  const signIn = (store, name, extra = {}) =>
    store.signInAs({ uid: `u_${String(name).toLocaleLowerCase()}`, name, ...extra });

  test('signing in mints a token that is not the uid, and the token comes back', () => {
    const store = createIdentityStore();
    const first = signIn(store, 'Bryce', { avatar: '🦊' });
    expect(first.isNew).toBe(true);
    expect(first.uid).toBe('u_bryce');
    expect(first.token).not.toBe(first.uid);
    expect(first.token.length).toBeGreaterThanOrEqual(24);
    const again = store.identify({ token: first.token, avatar: '🦊' });
    expect(again.isNew).toBe(false);
    expect(again.uid).toBe(first.uid);
    expect(again.token).toBe(first.token);
  });

  // The whole of what changed. A name in a box used to be an identity; now it
  // is nothing at all, whatever shape it arrives in.
  test('a name identifies nobody, and an unknown token mints nothing', () => {
    const store = createIdentityStore();
    expect(store.identify({ name: 'Ann' })).toEqual({ error: 'no-account' });
    expect(store.identify({ token: 'nope', name: 'Ann' })).toEqual({ error: 'no-account' });
    expect(store.identify({})).toEqual({ error: 'no-account' });
    expect(store.size).toBe(0);
  });

  test('verify and get agree, and a rename needs the name to be free', () => {
    const store = createIdentityStore();
    const me = signIn(store, 'Bryce', { avatar: '🦊' });
    expect(store.verify(me.token)).toMatchObject({ uid: me.uid, name: 'Bryce', avatar: '🦊' });
    expect(store.verify('unknown')).toBeNull();
    expect(store.get(me.uid)).toEqual({
      uid: me.uid,
      name: 'Bryce',
      avatar: '🦊',
      provider: 'local',
    });

    expect(store.rename(me.uid, 'B')).toBeNull();
    expect(store.get(me.uid)).toMatchObject({ uid: me.uid, name: 'B' });
    // Somebody else's name is not available.
    signIn(store, 'Ann');
    expect(store.rename(me.uid, 'Ann')).toMatch(/taken/);
    expect(store.rename(me.uid, '')).toMatch(/Pick a name/);
    expect(store.rename('u_nobody', 'Whoever')).toMatch(/nobody/);
    // The name it already has, in different letters, is still allowed.
    expect(store.rename(me.uid, 'b')).toBeNull();
    expect(store.get(me.uid).name).toBe('b');
  });

  // A device that has not been used for a month stops being signed in. The
  // person does not: they have an account, and it is still theirs.
  test('an idle device is signed out and its owner is not', () => {
    let clock = 1000;
    const store = createIdentityStore({ ttlMs: 500, now: () => clock });
    const a = signIn(store, 'A');
    clock += 300;
    const b = signIn(store, 'B');
    clock += 300;
    expect(store.expireDevices()).toBe(1);
    expect(store.verify(a.token)).toBeNull();
    expect(store.verify(b.token)).not.toBeNull();
    // Both of them are still people.
    expect(store.get('u_a')).toMatchObject({ name: 'A' });
    expect(store.size).toBe(2);
  });

  // An account with nothing signed in to it is what signing out everywhere
  // leaves, and it has to survive a restart or the account is deleted by its
  // owner tidying up.
  test('an account with no devices left is still somebody, across a restart', async () => {
    const db = freshDb('deviceless');
    const store = createIdentityStore({ db });
    const me = signIn(store, 'Ann');
    store.revokeAll(me.uid);
    expect(store.get(me.uid)).toMatchObject({ name: 'Ann' });
    await store.flush();

    const reopened = createIdentityStore({ db });
    expect(await reopened.load()).toBe(1);
    expect(reopened.get(me.uid)).toMatchObject({ name: 'Ann' });
    expect(reopened.sessions(me.uid)).toEqual([]);
    // And signing in again on a new browser finds the same person.
    expect(signIn(reopened, 'Ann').uid).toBe(me.uid);
  });

  test('identities are written down and survive a new store', async () => {
    const db = freshDb('persist');
    const store = createIdentityStore({ db });
    const me = signIn(store, 'Bryce', { avatar: '🦊' });
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
    const me = signIn(store, 'Bryce');
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
    const me = signIn(store, 'Nowhere');
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
    const me = signIn(store, 'Bryce', { avatar: '🦊' });
    await settle(40);
    expect(writes).toBe(1);

    // The ordinary reconnect: same token, same avatar. This is the hot path -
    // it runs on every connect - and it must not be written.
    store.identify({ token: me.token, avatar: '🦊' });
    await settle(40);
    expect(writes).toBe(1);

    // A rename is a different matter.
    store.rename(me.uid, 'Bee');
    await settle(40);
    expect(writes).toBe(2);
    expect((await db.identities.all())[0]).toMatchObject({ name: 'Bee' });
  });

  test('a touched lastSeenAt still reaches the store on the slow tier', async () => {
    const db = freshDb('touch');
    const store = createIdentityStore({ db, flushDebounceMs: 5, touchFlushMs: 10 });
    const me = signIn(store, 'Ann');
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
    for (let i = 0; i < 40; i++) signIn(store, `P${i}`);
    await settle(150);
    expect(await db.identities.all()).toHaveLength(40);
  });

  test('flush resolves when everything is written, so shutdown can wait on it', async () => {
    const db = freshDb('flush');
    const store = createIdentityStore({ db, flushDebounceMs: 60000 });
    signIn(store, 'Zed');
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
    // A reconnect changes nothing but the avatar - and could not change the
    // name if it tried, because identify no longer reads one.
    const again = store.identify({ token: me.token, name: 'impostor', avatar: '🐸' });
    expect(again).toMatchObject({
      uid: 'gn_7',
      name: 'oldname',
      avatar: '🐸',
      provider: 'gamenight',
    });
    expect(store.rename('gn_7', 'impostor')).toMatch(/comes from GameNight/);
    // The account was renamed on GameNight; the next sign-in carries it.
    store.identifyFromGameNight({ sub: '7', name: 'newname' });
    expect(store.get('gn_7')).toMatchObject({ name: 'newname' });
  });

  // A sign-up holds a name while it waits for its link. That hold is an
  // unproven claim on an address nobody has confirmed, and the commonest case
  // by far is the same person - who started a sign-up here and then signed in
  // with GameNight instead. It must not cost them their own name.
  test('a name only being held gives way to a GameNight one, and is given up', () => {
    const released = [];
    const held = new Map([['bryce', 'u_halfway']]);
    const store = createIdentityStore({
      // Held by a sign-up, owned by nobody.
      nameOwner: (name) => held.get(String(name).toLocaleLowerCase()) || null,
      nameOwnedBy: () => null,
      releaseName: (name) => {
        released.push(name);
        held.delete(String(name).toLocaleLowerCase());
        return 'u_halfway';
      },
    });

    const gn = store.identifyFromGameNight({ sub: '12', name: 'Bryce' });
    expect(gn.name).toBe('Bryce');
    expect(gn.nameAdjusted).toBeNull();
    // Given up rather than left to lapse: the account it belonged to must not
    // still be creatable on a name that is now somebody else's.
    expect(released).toEqual(['Bryce']);
  });

  // An account that owns its name is a different matter: that claim was
  // proved, and the arrival yields to it.
  test('a name an account owns still beats a GameNight one', () => {
    const store = createIdentityStore({
      nameOwner: (name) => (String(name).toLocaleLowerCase() === 'bryce' ? 'u_owner' : null),
      nameOwnedBy: (name) => (String(name).toLocaleLowerCase() === 'bryce' ? 'u_owner' : null),
      releaseName: () => {
        throw new Error('an owned name is not a hold to give up');
      },
    });
    const gn = store.identifyFromGameNight({ sub: '13', name: 'Bryce' });
    expect(gn.name).toBe('Bryce 2');
    expect(gn.nameAdjusted).toBe('Bryce');
  });

  // A GameNight name was chosen somewhere else, by somebody who cannot see
  // this server's list. Turning them away for it would mean an account that
  // simply cannot play here, so they wear a number instead and are told.
  test('a GameNight name somebody here already has is worn with a number', () => {
    const store = createIdentityStore();
    signIn(store, 'Bryce');
    const gn = store.identifyFromGameNight({ sub: '11', name: 'Bryce' });
    expect(gn.name).toBe('Bryce 2');
    expect(gn.nameAdjusted).toBe('Bryce');
    // Still one person per name.
    expect(store.get('u_bryce').name).toBe('Bryce');

    // And the moment the name is free, the next sign-in takes it back.
    store.remove('u_bryce');
    const back = store.identifyFromGameNight({ sub: '11', name: 'Bryce' });
    expect(back.name).toBe('Bryce');
    expect(back.nameAdjusted).toBeNull();
  });

  test('a stale GameNight token mints nothing', () => {
    const store = createIdentityStore();
    expect(store.identify({ token: 'gone', avatar: '🦊' })).toEqual({ error: 'no-account' });
    expect(store.size).toBe(0);
  });

  test('identifyFromGameNight refuses a missing subject or an empty name', () => {
    const store = createIdentityStore();
    expect(store.identifyFromGameNight({ name: 'x' })).toBeNull();
    expect(store.identifyFromGameNight({ sub: '1', name: '' })).toBeNull();
  });

  test('a GameNight identity outlives every one of its devices', () => {
    let clock = 1000;
    const store = createIdentityStore({ ttlMs: 500, now: () => clock });
    const a = store.identifyFromGameNight({ sub: '9', name: 'nine' });
    clock += 300;
    const b = store.identifyFromGameNight({ sub: '9', name: 'nine' });
    clock += 300;
    expect(store.expireDevices()).toBe(1);
    expect(store.verify(a.token)).toBeNull();
    expect(store.verify(b.token)).not.toBeNull();
    clock += 600;
    expect(store.expireDevices()).toBe(1);
    // Signed out of everywhere, and still a person with a name of their own.
    expect(store.get('gn_9')).toMatchObject({ name: 'nine' });
  });

  test('provider and GameNight id survive a restart', async () => {
    const db = freshDb('provider');
    const store = createIdentityStore({ db });
    const gn = store.identifyFromGameNight({ sub: '3', name: 'three' });
    const local = signIn(store, 'Ann');
    await store.flush();

    const reopened = createIdentityStore({ db });
    await reopened.load();
    expect(reopened.verify(gn.token)).toMatchObject({ uid: 'gn_3', provider: 'gamenight' });
    expect(reopened.verify(local.token)).toMatchObject({ uid: local.uid, provider: 'local' });
  });

  // Preferences belong to the person, so they hang off the identity and not
  // off the browser. A closed set with a validator each, because this is the
  // one place a client can ask the server to write something it keeps.
  test('preferences are kept against the identity, and only the ones named', () => {
    const store = createIdentityStore();
    const me = signIn(store, 'Bryce');
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
    const me = signIn(store, 'Bryce');
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
    const me = signIn(store, 'Bryce');
    store.setPrefs(me.uid, { muted: true, seat: 2 });
    expect(store.get(me.uid).prefs).toBeUndefined();
    expect(store.verify(me.token).prefs).toEqual({ muted: true, seat: 2 });
  });

  test('preferences survive a restart', async () => {
    const db = freshDb('prefs');
    const store = createIdentityStore({ db });
    const me = signIn(store, 'Bryce');
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
    const me = signIn(store, 'Old');
    await store.flush();
    // As a record written before there were any preferences would look.
    const row = (await db.identities.all())[0];
    delete row.prefs;
    await db.identities.put(row);

    const older = createIdentityStore({ db });
    await older.load();
    expect(older.verify(me.token).prefs).toEqual({});
  });

  // ── Who runs the server, and who may not play ────────────────────────────

  test('a role is remembered, and the last administrator is protected', async () => {
    const db = freshDb('roles');
    const store = createIdentityStore({ db });
    // The first account on a server nobody runs gets the keys; everybody
    // after is an ordinary player.
    const ann = signIn(store, 'Ann');
    const bob = signIn(store, 'Bob');
    expect(store.isAdmin(ann.uid)).toBe(true);
    expect(store.isAdmin(bob.uid)).toBe(false);
    expect(store.adminCount()).toBe(1);
    // The only one there is, so taking it away would leave nobody.
    expect(store.wouldOrphan(ann.uid)).toBe(true);
    expect(store.wouldOrphan(bob.uid)).toBe(false);

    store.setRole(bob.uid, 'admin');
    expect(store.adminCount()).toBe(2);
    // Named in the environment, which is the way back into a server whose
    // administrator is lost.
    expect(store.promoteByName('nobody at all')).toBeNull();
    expect(store.wouldOrphan(ann.uid)).toBe(false);
    // Standing down is allowed while somebody else is there.
    store.setRole(ann.uid, 'player');
    expect(store.isAdmin(ann.uid)).toBe(false);
    expect(store.wouldOrphan(bob.uid)).toBe(true);

    await store.flush();
    const reopened = createIdentityStore({ db });
    await reopened.load();
    expect(reopened.isAdmin(bob.uid)).toBe(true);
    expect(reopened.isAdmin(ann.uid)).toBe(false);
    expect(reopened.adminCount()).toBe(1);
  });

  // A server with nobody running it is a server nobody can run, and there is
  // no password to fall back on. Whichever door the first person comes
  // through, they get the keys.
  test('the first account here is the administrator, whichever door it came through', () => {
    const local = createIdentityStore();
    expect(signIn(local, 'First').uid).toBe('u_first');
    expect(local.isAdmin('u_first')).toBe(true);
    expect(local.isAdmin(signIn(local, 'Second').uid)).toBe(false);

    const viaGameNight = createIdentityStore();
    const gn = viaGameNight.identifyFromGameNight({ sub: '1', name: 'Member' });
    expect(viaGameNight.isAdmin(gn.uid)).toBe(true);
  });

  // An existing server upgrading into this has people already, and handing it
  // to whoever signs in next would be arbitrary. Nobody is promoted on load;
  // the environment names one instead.
  test('a database that already holds people promotes nobody on load', async () => {
    const db = freshDb('unclaimed');
    {
      const store = createIdentityStore({ db });
      signIn(store, 'Ann');
      signIn(store, 'Bob');
      // As an upgrading database looks: people, and nobody marked.
      store.setRole('u_ann', 'player');
      await store.flush();
    }
    const reopened = createIdentityStore({ db });
    expect(await reopened.load()).toBe(2);
    expect(reopened.adminCount()).toBe(0);

    // And not to the next person through the door either: an upgraded server
    // handing itself to whoever signs up first is handing itself to a
    // stranger.
    const newcomer = signIn(reopened, 'Newcomer');
    expect(reopened.isAdmin(newcomer.uid)).toBe(false);
    expect(reopened.adminCount()).toBe(0);

    // Named in the environment, applied at boot, is the way in.
    expect(reopened.promoteByName('BOB')).toBe('u_bob');
    expect(reopened.isAdmin('u_bob')).toBe(true);
    expect(reopened.promoteByName('nobody here')).toBeNull();
  });

  // The other half of the same rule: a server that loaded nothing is fresh,
  // and the first person through its door does get the keys.
  test('a server that loaded an empty database still hands over the first account', async () => {
    const db = freshDb('fresh-load');
    const store = createIdentityStore({ db });
    expect(await store.load()).toBe(0);
    expect(store.isAdmin(signIn(store, 'Pioneer').uid)).toBe(true);
  });

  test('a disabled account cannot get in by any door', async () => {
    const db = freshDb('disabled');
    const store = createIdentityStore({ db });
    const ann = signIn(store, 'Ann');
    const gn = store.identifyFromGameNight({ sub: '5', name: 'Five' });

    store.setDisabled(ann.uid, 1000);
    store.setDisabled('gn_5', 1000);
    expect(store.isDisabled(ann.uid)).toBe(true);
    // The token they are holding.
    expect(store.identify({ token: ann.token })).toEqual({ error: 'disabled' });
    expect(store.identify({ token: gn.token })).toEqual({ error: 'disabled' });
    // A fresh sign-in, with the password.
    expect(signIn(store, 'Ann')).toEqual({ error: 'disabled' });
    // And a fresh GameNight token.
    expect(store.identifyFromGameNight({ sub: '5', name: 'Five' })).toEqual({ error: 'disabled' });

    await store.flush();
    const reopened = createIdentityStore({ db });
    await reopened.load();
    expect(reopened.isDisabled(ann.uid)).toBe(true);
    // Lifted, and they are back.
    reopened.setDisabled(ann.uid, null);
    expect(reopened.isDisabled(ann.uid)).toBe(false);
    expect(reopened.identify({ token: ann.token })).toMatchObject({ uid: ann.uid });
  });

  test('signing somebody out everywhere ends every device and keeps the person', () => {
    const store = createIdentityStore();
    const me = signIn(store, 'Ann', { userAgent: UA_MAC });
    const second = signIn(store, 'Ann', { userAgent: UA_IPHONE });
    expect(store.sessions(me.uid)).toHaveLength(2);

    const dropped = store.revokeAll(me.uid);
    expect(dropped).toHaveLength(2);
    expect(dropped).toContain(store.hashToken(me.token));
    expect(store.verify(me.token)).toBeNull();
    expect(store.verify(second.token)).toBeNull();
    expect(store.get(me.uid)).toMatchObject({ name: 'Ann' });
    expect(store.revokeAll('u_nobody')).toEqual([]);
  });

  test('removing somebody takes their name and their devices with them', () => {
    const store = createIdentityStore();
    const me = signIn(store, 'Ann');
    store.setRole(me.uid, 'admin');
    expect(store.remove(me.uid)).toBe(true);
    expect(store.get(me.uid)).toBeNull();
    expect(store.verify(me.token)).toBeNull();
    expect(store.adminCount()).toBe(0);
    // And the name is free for somebody else.
    expect(store.nameHolder('ann', 'u_other')).toBe(false);
    expect(store.remove(me.uid)).toBe(false);
  });

  test('the list is searched, filtered and paged where the rows are', () => {
    let clock = 1000;
    const store = createIdentityStore({ now: () => clock });
    for (const name of ['Ann', 'Bob', 'Carol', 'Dave']) {
      clock += 1000;
      signIn(store, name);
    }
    // Ann came first and so runs the server; Bob is the one this test wants
    // marked, so Ann stands down.
    store.setRole('u_ann', 'player');
    store.setRole('u_bob', 'admin');
    store.setDisabled('u_carol', clock);

    const all = store.list();
    expect(all.total).toBe(4);
    // Newest visit first.
    expect(all.rows.map((r) => r.name)).toEqual(['Dave', 'Carol', 'Bob', 'Ann']);
    expect(all.rows[2]).toMatchObject({ role: 'admin', provider: 'local', devices: 1 });
    expect(all.rows[1]).toMatchObject({ disabled: true });

    expect(store.list({ q: 'ar' }).rows.map((r) => r.name)).toEqual(['Carol']);
    expect(store.list({ filter: 'admin' }).rows.map((r) => r.name)).toEqual(['Bob']);
    expect(store.list({ filter: 'disabled' }).rows.map((r) => r.name)).toEqual(['Carol']);

    const page = store.list({ limit: 2, offset: 2 });
    expect(page).toMatchObject({ total: 4, offset: 2, limit: 2 });
    expect(page.rows.map((r) => r.name)).toEqual(['Bob', 'Ann']);
    // A page is capped however much is asked for.
    expect(store.list({ limit: 5000 }).limit).toBe(50);
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
    const stranger = signIn(store, 'Stranger');

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

  test('signing out the last device leaves the account behind', () => {
    const store = createIdentityStore();
    const me = signIn(store, 'Bryce', { userAgent: UA_MAC });
    expect(store.revokeToken(me.token)).toBe(true);
    expect(store.verify(me.token)).toBeNull();
    // The browser is signed out. The person is not deleted by it.
    expect(store.get(me.uid)).toMatchObject({ name: 'Bryce' });
    expect(store.revokeToken(me.token)).toBe(false);
    expect(store.revokeToken('never-was-a-token')).toBe(false);
  });

  test('a device keeps its name and its id across a restart', async () => {
    const db = freshDb('device');
    const store = createIdentityStore({ db });
    const me = signIn(store, 'Bryce', { userAgent: UA_IPHONE });
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
      provider: 'local',
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

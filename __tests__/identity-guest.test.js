// __tests__/identity-guest.test.js - the one door that mints from a name:
// createGuest, for an invite link whose host let the link do the letting-in.
const { createIdentityStore } = require('../server/identity');

describe('createGuest', () => {
  const signIn = (store, name) =>
    store.signInAs({ uid: `u_${String(name).toLocaleLowerCase()}`, name });

  test('is refused on a server nobody runs yet, and never becomes the administrator', () => {
    const store = createIdentityStore();
    expect(store.createGuest({ name: 'Walkin' })).toEqual({
      error: 'This server has no administrator yet.',
    });
    expect(store.size).toBe(0);
    const host = signIn(store, 'Host');
    expect(store.isAdmin(host.uid)).toBe(true);
    const guest = store.createGuest({ name: 'Walkin' });
    expect(guest.error).toBeUndefined();
    expect(store.isAdmin(guest.uid)).toBe(false);
  });

  test('mints a token that identifies the same person, under the name given', () => {
    const store = createIdentityStore();
    signIn(store, 'Host');
    const guest = store.createGuest({ name: '  Walkin  ', userAgent: 'Mozilla/5.0 (iPhone)' });
    expect(guest.isNew).toBe(true);
    expect(guest.uid).toMatch(/^g_[a-f0-9]{12}$/);
    expect(guest.name).toBe('Walkin');
    expect(guest.provider).toBe('local');
    expect(guest.token).not.toBe(guest.uid);
    const back = store.identify({ token: guest.token });
    expect(back.uid).toBe(guest.uid);
    expect(back.isNew).toBe(false);
    expect(store.get(guest.uid).name).toBe('Walkin');
  });

  test('holds the name: a second guest, and an account, cannot take it', () => {
    const store = createIdentityStore();
    const host = signIn(store, 'Host');
    const guest = store.createGuest({ name: 'Walkin' });
    expect(store.createGuest({ name: 'walkin' })).toEqual({
      error: 'That name is taken on this server.',
    });
    expect(store.createGuest({ name: 'Host' })).toEqual({
      error: 'That name is taken on this server.',
    });
    // What the accounts store asks before it lets a sign-up claim a name.
    expect(store.nameHeldBy('Walkin', host.uid)).toBe(guest.uid);
    expect(store.createGuest({ name: '   ' })).toEqual({ error: 'Pick a name first.' });
  });
});

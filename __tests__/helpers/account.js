// __tests__/helpers/account.js - somebody with an account, for a socket test.
//
// Identifying used to be a name in a payload, so a test that needed a player
// sent one. It is a device token now, and a device token comes from signing in
// to an account - so this makes the account and signs in, against the running
// server's own stores rather than through a back door. createVerified is the
// same call the Users page makes, and signInAs is the same one the signIn
// handler makes once a password has gone through.
//
// No mail and no scrypt: an account made this way has no password, which is
// exactly what an account an administrator created and has not handed over yet
// looks like.

let made = 0;

// The identity, including a fresh device token. Called twice with one name,
// it answers with the same person on a second device - which is what it looks
// like when somebody opens their laptop as well as their phone.
function accountFor(serverModule, name, { avatar = '🦊', role = null } = {}) {
  const { accounts, identity } = serverModule;
  let uid = accounts.ownerOf(name);
  if (!uid) {
    const account = accounts.createVerified({
      name,
      email: `p${made++}@example.com`,
    });
    if (account.error) throw new Error(`could not make an account for ${name}: ${account.error}`);
    uid = account.uid;
  }
  const ident = identity.signInAs({ uid, name, avatar });
  if (!ident || ident.error) {
    throw new Error(`could not sign in as ${name}: ${(ident && ident.error) || 'no identity'}`);
  }
  if (role) identity.setRole(ident.uid, role);
  return ident;
}

// The token on its own, which is all most callers want.
function tokenFor(serverModule, name, options) {
  return accountFor(serverModule, name, options).token;
}

module.exports = { accountFor, tokenFor };

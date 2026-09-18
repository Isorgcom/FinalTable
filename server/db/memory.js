// memory.js - the same database, in a Map, for the tests.
//
// Every store here keeps its working set in memory and writes behind it, so
// what the tests actually need is somewhere for the writes to go and something
// to read back at boot. That is this: the same methods the MariaDB driver has,
// over Maps, with no connection and no schema.
//
// It is what lets six hundred tests stay hermetic and finish in under a
// minute. The SQL is covered once, properly, by the integration suite that
// runs against a real database - rather than six hundred times, slowly.
//
// Rows are cloned in and out. A test that mutates what it read must not be
// able to change what is stored, because the real driver could not either.

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// Kept beside the process rather than inside the module, so a database
// outlives a server that restarts into the same one - which is what a test
// that resets its modules and boots again is simulating. Two names are two
// databases, as they would be.
function tablesFor(name) {
  const held = globalThis.__finaltableMemoryDb || (globalThis.__finaltableMemoryDb = new Map());
  if (!held.has(name)) {
    held.set(name, {
      settings: new Map(), // k -> { k, v, updated_at }
      identities: new Map(), // uid -> record (devices nested)
      accounts: new Map(), // uid -> account
      pending: new Map(), // name_key -> row
      resets: new Map(), // token_hash -> row
    });
  }
  return held.get(name);
}

function createMemoryDatabase(options = {}) {
  const { database = 'finaltable' } = options;
  const { settings, identities, accounts, pending, resets } = tablesFor(database);

  return {
    driver: 'memory',
    // For a test that wants a database nobody has used.
    reset() {
      for (const table of [settings, identities, accounts, pending, resets]) table.clear();
    },
    async connect() {
      return this;
    },
    async close() {},
    async apply() {},
    async ping() {
      return true;
    },

    settings: {
      async all() {
        return [...settings.values()].map(clone);
      },
      async put(k, v) {
        settings.set(k, { k, v: clone(v), updated_at: Date.now() });
      },
      async remove(k) {
        settings.delete(k);
      },
    },

    identities: {
      async all() {
        return [...identities.values()].map(clone);
      },
      async put(record) {
        if (!record || !record.uid) return;
        identities.set(record.uid, clone(record));
      },
      async remove(uid) {
        identities.delete(uid);
      },
      async count() {
        return identities.size;
      },
    },

    accounts: {
      async all() {
        return {
          accounts: [...accounts.values()].map(clone),
          pending: [...pending.values()].map(clone),
          resets: [...resets.values()].map(clone),
        };
      },
      async put(account) {
        if (!account || !account.uid) return;
        // The unique name the real schema enforces, enforced here too, or a
        // test would pass against this and fail against MariaDB.
        for (const [uid, row] of accounts) {
          if (row.key === account.key && uid !== account.uid) {
            throw new Error('duplicate account name');
          }
        }
        accounts.set(account.uid, clone(account));
      },
      async remove(uid) {
        accounts.delete(uid);
      },
      async putPending(row) {
        if (!row || !row.key) return;
        pending.set(row.key, clone(row));
      },
      async removePending(key) {
        pending.delete(key);
      },
      async putReset(row) {
        if (!row || !row.tokenHash) return;
        resets.set(row.tokenHash, clone(row));
      },
      async removeReset(tokenHash) {
        resets.delete(tokenHash);
      },
      async count() {
        return accounts.size;
      },
    },
  };
}

module.exports = { createMemoryDatabase };

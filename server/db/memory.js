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
      tournaments: new Map(), // id -> { id, status, data }
      chat: new Map(), // tournament_id -> data
      games: new Map(), // id -> { meta, hands, uids }
      adminLog: new Map(), // id -> row
      migrations: new Map(), // name -> applied_at
    });
  }
  return held.get(name);
}

function createMemoryDatabase(options = {}) {
  const { database = 'finaltable' } = options;
  const {
    settings,
    identities,
    accounts,
    pending,
    resets,
    tournaments,
    chat,
    games,
    adminLog,
    migrations,
  } = tablesFor(database);

  return {
    driver: 'memory',
    // For a test that wants a database nobody has used.
    reset() {
      const tables = [
        settings,
        identities,
        accounts,
        pending,
        resets,
        tournaments,
        chat,
        games,
        adminLog,
        migrations,
      ];
      for (const table of tables) table.clear();
    },
    async connect() {
      return this;
    },
    async close() {},
    async apply() {},
    async ping() {
      return true;
    },

    // The ledger. A step's SQL is the real driver's business - there is no
    // schema here to alter - but which steps have run is not, or a test would
    // apply the same one on every boot.
    migrations: {
      async applied() {
        return [...migrations.keys()];
      },
      async record(name) {
        if (name) migrations.set(name, Date.now());
      },
      async exec() {},
      async clashingNames() {
        return [];
      },
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
        // The unique name the real schema carries, enforced here too, or a
        // test would pass against this and fail against MariaDB.
        for (const [uid, row] of identities) {
          if (uid !== record.uid && row.nameKey && row.nameKey === record.nameKey) {
            throw new Error('duplicate identity name');
          }
        }
        identities.set(record.uid, clone(record));
      },
      async remove(uid) {
        identities.delete(uid);
      },
      async count() {
        return identities.size;
      },
    },

    tournaments: {
      async all() {
        return [...tournaments.values()].map(clone);
      },
      // The whole list, as the registry keeps it: anything not in it is gone.
      async replaceAll(list) {
        tournaments.clear();
        for (const row of list || []) {
          if (!row || !row.id) continue;
          tournaments.set(row.id, clone(row));
        }
      },
      async remove(id) {
        tournaments.delete(id);
      },
    },

    chat: {
      async all() {
        return [...chat.entries()].map(([id, data]) => ({ id, data: clone(data) }));
      },
      async put(id, data) {
        if (!id) return;
        chat.set(id, clone(data));
      },
      async remove(id) {
        chat.delete(id);
      },
    },

    games: {
      async put(meta, hands, uids) {
        if (!meta || !meta.id) return;
        games.set(meta.id, {
          meta: clone(meta),
          hands: clone(hands) || [],
          uids: [...new Set(uids || [])],
        });
      },
      async get(id) {
        const row = games.get(id);
        return row ? { meta: clone(row.meta), hands: clone(row.hands) } : null;
      },
      // Only the columns, never the hands: a list of games is not a reason to
      // read every hand on the server.
      async listFor(uid) {
        return [...games.values()]
          .filter((row) => row.uids.includes(uid))
          .map((row) => clone(row.meta))
          .sort(
            (a, b) =>
              (b.endedAt || b.touchedAt || 0) - (a.endedAt || a.touchedAt || 0) ||
              (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
          );
      },
      async played(uid, id) {
        const row = games.get(id);
        return !!row && row.uids.includes(uid);
      },
      async ids() {
        return [...games.keys()];
      },
      async count() {
        return games.size;
      },
      async remove(id) {
        games.delete(id);
      },
      // The two bounds, as one pass. Returns how many went.
      async prune({ olderThan = null, keepNewest = null } = {}) {
        let dropped = 0;
        const when = (row) => row.meta.endedAt || row.meta.touchedAt || 0;
        if (Number.isFinite(olderThan)) {
          for (const [id, row] of [...games]) {
            if (when(row) < olderThan) {
              games.delete(id);
              dropped++;
            }
          }
        }
        if (Number.isFinite(keepNewest)) {
          const order = [...games.entries()].sort(
            (a, b) => when(b[1]) - when(a[1]) || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0)
          );
          for (const [id] of order.slice(keepNewest)) {
            games.delete(id);
            dropped++;
          }
        }
        return dropped;
      },
    },

    adminLog: {
      // Newest first, which is the only order anybody reads it in.
      async recent(limit) {
        return [...adminLog.values()]
          .sort((a, b) => b.at - a.at || b.id - a.id)
          .slice(0, limit)
          .map(clone);
      },
      async add(rows) {
        for (const row of rows || []) {
          if (!row || row.id === undefined) continue;
          adminLog.set(row.id, clone(row));
        }
      },
      async prune({ olderThan = null, keepNewest = null } = {}) {
        let dropped = 0;
        if (Number.isFinite(olderThan)) {
          for (const [id, row] of [...adminLog]) {
            if (row.at < olderThan) {
              adminLog.delete(id);
              dropped++;
            }
          }
        }
        if (Number.isFinite(keepNewest)) {
          const order = [...adminLog.entries()].sort((a, b) => b[1].at - a[1].at || b[0] - a[0]);
          for (const [id] of order.slice(keepNewest)) {
            adminLog.delete(id);
            dropped++;
          }
        }
        return dropped;
      },
      async count() {
        return adminLog.size;
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

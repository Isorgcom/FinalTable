// db/index.js - which database, and getting it ready.
//
// Two drivers behind one set of methods: MariaDB for a server, and a Map for
// the tests. Which one is chosen by whether a connection is configured, so a
// test needs no environment and a server needs no flag.

const { createMariaDatabase } = require('./mariadb');
const { createMemoryDatabase } = require('./memory');

function createDatabase(options = {}) {
  const { url = '', host = '', database = '', memory = false, ...rest } = options;
  if (memory || (!url && !host)) return createMemoryDatabase({ database: database || undefined });
  return createMariaDatabase({ url, host, database, ...rest });
}

// Connect, then make the tables. Both before the server listens: a browser
// that reaches a server with no schema gets errors instead of a lobby.
async function openDatabase(options = {}) {
  const db = createDatabase(options);
  await db.connect();
  await db.apply();
  return db;
}

module.exports = { createDatabase, openDatabase, createMemoryDatabase, createMariaDatabase };

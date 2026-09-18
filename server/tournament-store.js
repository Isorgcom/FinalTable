// tournament-store.js - the games this server is running, kept.
//
// A registering tournament is its registrations, its bots and its settings; a
// running one carries the field it recorded between hands as well. Both are
// documents rather than columns: a snapshot taken between hands and read back
// whole, with nothing ever asking a question of its insides except the code
// that seats it again.
//
// Loaded once before the server listens, because restoring a field is
// synchronous and has to happen with everything already in hand. Written whole
// whenever the list changes, which is what the registry has always handed
// over: anything not in the list has been cancelled, finished or swept.

function createTournamentStore({ db = null, log = () => {} } = {}) {
  let rows = [];

  // Before the server listens. What comes back is also kept, so restore() can
  // stay the synchronous thing it is.
  async function load() {
    rows = [];
    if (!db) return rows;
    try {
      rows = (await db.tournaments.all()).map((row) => row.data).filter(Boolean);
    } catch (err) {
      // A tournament that cannot be read is a game that has to be set up
      // again, which is a bad morning rather than a broken server.
      log({
        level: 'error',
        event: 'tournaments_load_failed',
        message: 'Could not read the games back',
        data: { detail: err && err.message },
      });
      rows = [];
    }
    return rows;
  }

  // What load() found, for a restore that runs after it.
  function saved() {
    return rows;
  }

  function save(tournaments) {
    rows = Array.isArray(tournaments) ? tournaments : [];
    if (!db) return Promise.resolve();
    return db.tournaments
      .replaceAll(rows.map((t) => ({ id: t.id, status: t.status, data: t })))
      .catch((err) => {
        log({
          level: 'warn',
          event: 'tournaments_write_failed',
          message: 'Could not write the games',
          data: { detail: err && err.message },
        });
      });
  }

  return { load, saved, save };
}

module.exports = { createTournamentStore };

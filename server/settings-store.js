// settings-store.js - admin settings that survive a restart.
//
// What the admin sets from the browser rather than from the environment: the
// GameNight pairing, and the admin password once it has been changed from the
// page. An environment variable is read once as the seed for a setting the
// store does not hold yet; after that the store wins, so a change made in the
// GUI is not undone by the next restart.
//
// Held in memory and written behind, which is what lets get() stay synchronous
// now that the writes go to a database. It used to read the file on every
// get - correct, and a read of the disk for every question anybody asked.

function createSettingsStore({ db = null, log = () => {} } = {}) {
  const settings = new Map();

  // Before the server listens. Nothing asks a setting before then, and
  // everything asks after.
  async function load() {
    settings.clear();
    if (!db) return 0;
    for (const row of await db.settings.all()) settings.set(row.k, row.v);
    return settings.size;
  }

  function get(key) {
    return settings.has(key) ? settings.get(key) : null;
  }

  function all() {
    return Object.fromEntries(settings);
  }

  // The write is not waited on: a setting is in memory the moment it is set,
  // and a database that refuses it is worth a line in the log rather than an
  // error thrown at whoever pressed the button.
  function set(key, value) {
    const gone = value === null || value === undefined;
    if (gone) settings.delete(key);
    else settings.set(key, value);
    if (db) {
      Promise.resolve(gone ? db.settings.remove(key) : db.settings.put(key, value)).catch((err) => {
        log({
          level: 'warn',
          event: 'settings_write_failed',
          message: 'Could not write a setting',
          data: { key, detail: err && err.message },
        });
      });
    }
    return all();
  }

  return {
    load,
    get,
    set,
    all,
    get size() {
      return settings.size;
    },
  };
}

module.exports = { createSettingsStore };

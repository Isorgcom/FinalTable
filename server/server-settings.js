// server-settings.js - the handful of knobs an admin can turn without a shell.
//
// Same shape as the mail settings and the GameNight pairing beside them: one
// record in the settings table, the environment seeding a first boot, the
// saved record winning from then on.
//
// What is here and what is not is the whole design. Every one of these stops
// being "a value this server was built with" and becomes "a value that can
// change under a running game", so the list is short on purpose and each row
// says when it takes effect rather than pretending they are all alike:
//
//   now        read on a path that runs per request, so a change is immediate
//              and cannot make two tournaments disagree about the rules
//   next game  handed to a table when the game is made and kept by it
//
// Two that an admin might expect and will not find. Chat cannot be switched on
// from here because the store it writes to is not built when chat is off, so
// turning it on would give a chat box with nothing behind it - and a control
// that works in one direction is worse than one that is honest about being an
// environment setting. How many hands a running game keeps is the same: at
// zero the whole store is never made.

const ROWS = {
  maxTournaments: { when: 'now', min: 1, max: 100 },
  reactionsEnabled: { when: 'now', bool: true },
  handHistoryTtlMs: { when: 'now', min: 0, max: 31536000000 },
  handHistoryMaxGames: { when: 'now', min: 1, max: 10000 },
  handPauseMs: { when: 'next game', min: 0, max: 60000 },
  streetPauseMs: { when: 'next game', min: 0, max: 15000 },
};

function createServerSettings(options = {}) {
  const { settingsStore = null, defaults = {}, log = () => {} } = options;

  // What it tells, bound after the fact: the registry is built with the
  // handlers, and the handlers need this. init() is not called until both
  // exist, which is the same ordering rule the pairing and the mail settings
  // keep - nothing reads a setting before openStores().
  let registry = options.registry || null;
  let historyStore = options.historyStore || null;

  function bind(next = {}) {
    if (next.registry) registry = next.registry;
    if (next.historyStore) historyStore = next.historyStore;
  }

  const current = {};
  for (const key of Object.keys(ROWS)) current[key] = defaults[key];

  function clean(next = {}) {
    const out = {};
    for (const [key, rule] of Object.entries(ROWS)) {
      if (next[key] === undefined) continue;
      if (rule.bool) {
        out[key] = !!next[key];
        continue;
      }
      const value = Number(next[key]);
      if (!Number.isFinite(value)) continue;
      out[key] = Math.max(rule.min, Math.min(rule.max, Math.round(value)));
    }
    return out;
  }

  // The single mutation point, and the only place anything is told.
  function apply(next = {}, { persist = true } = {}) {
    Object.assign(current, clean(next));
    if (registry && registry.setLimits) registry.setLimits(current);
    if (historyStore && historyStore.setLimits) {
      historyStore.setLimits({
        ttlMs: current.handHistoryTtlMs,
        maxGames: current.handHistoryMaxGames,
      });
    }
    if (persist && settingsStore) settingsStore.set('server', current);
    log({
      level: 'info',
      event: 'server_settings_changed',
      message: 'The server settings were changed',
      data: { ...current },
    });
    return current;
  }

  // The saved record if there is one. There is no seeding to do: the values
  // the environment gave are already what the registry was built with, and
  // writing them down would only make a first boot look like a change.
  function init() {
    const saved = settingsStore ? settingsStore.get('server') : null;
    if (saved) apply(saved, { persist: false });
    return current;
  }

  function status() {
    return {
      ...current,
      when: Object.fromEntries(Object.entries(ROWS).map(([key, rule]) => [key, rule.when])),
    };
  }

  return { init, bind, apply, status, get: () => current };
}

module.exports = { createServerSettings, ROWS };

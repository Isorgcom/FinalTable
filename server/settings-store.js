// settings-store.js - operator settings that survive a restart.
//
// What the operator sets from the browser rather than from the environment:
// today, the GameNight pairing. One small JSON file beside the saves, whole
// file written atomically on every change, the same shape as the other
// stores. An environment variable is read once as the seed for a setting the
// file does not hold yet; after that the file wins, so a change made in the
// GUI is not undone by the next restart.

const fs = require('fs');
const path = require('path');

const FILE_VERSION = 1;

function createSettingsStore({ saveDir = null } = {}) {
  const file = saveDir ? path.join(saveDir, 'settings.json') : null;

  function load() {
    if (!file || !fs.existsSync(file)) return {};
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return data && typeof data === 'object' && data.settings && typeof data.settings === 'object'
        ? data.settings
        : {};
    } catch (_err) {
      return {}; // a corrupt file starts empty; the operator sets things again
    }
  }

  function save(settings) {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, settings }, null, 2));
    fs.renameSync(tmp, file);
  }

  // Read-modify-write of one key, so two settings never clobber each other.
  function set(key, value) {
    const settings = load();
    if (value === null || value === undefined) delete settings[key];
    else settings[key] = value;
    save(settings);
    return settings;
  }

  function get(key) {
    const settings = load();
    return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : null;
  }

  return { load, save, get, set, file };
}

module.exports = { createSettingsStore };

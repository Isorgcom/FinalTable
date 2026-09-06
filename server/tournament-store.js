// tournament-store.js - registrations that survive a restart.
//
// Only tournaments that have not started are written: their registrations,
// bots and settings are all the state there is. A running tournament is not
// restorable (a hand in progress cannot be rebuilt), and finished standings
// are pushed to every client at the finish.

const fs = require('fs');
const path = require('path');

function createTournamentStore({ saveDir = null } = {}) {
  const file = saveDir ? path.join(saveDir, 'tournaments.json') : null;

  function load() {
    if (!file || !fs.existsSync(file)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(data.tournaments) ? data.tournaments : [];
    } catch (_err) {
      return []; // a corrupt file starts empty; registrations are cheap to redo
    }
  }

  function save(tournaments) {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, tournaments }));
    fs.renameSync(tmp, file);
  }

  return { load, save, file };
}

module.exports = { createTournamentStore };

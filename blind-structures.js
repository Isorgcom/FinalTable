// blind-structures.js - what the blinds do over a tournament.
//
// A structure is an ordered list of levels. A level is a small blind, a big
// blind, an ante, how long it lasts, and whether it is a break; a break is a
// level with no blinds. The shape follows GameNight's blind editor (a level
// there is small_blind, big_blind, ante, duration_minutes, is_break) so a
// structure can one day come across from there with a one-line mapping.
//
// The ante is a big-blind ante: one player, the big blind, posts an ante
// equal to the big blind straight into the pot, and nobody else antes. That
// is how tournaments run it now, and it is one posting per hand rather than
// eight.
//
// Three presets for a host to pick from, the clamp that makes a hand-edited
// structure safe to run, and the rung rule the editor uses to add a level.

const MAX_LEVELS = 60;
const MAX_CHIPS = 1000000;
const MIN_DURATION = 30; // seconds; the registry's floor for a level length
const MAX_DURATION = 3600;
const DEFAULT_DURATION = 300;
const NAME_MAX = 24;

// Every preset starts at 10/20, so level one looks exactly as it always has.
const PRESETS = [
  {
    key: 'turbo',
    name: 'Turbo',
    hint: 'Steep and short.',
    ladder: [
      [10, 20],
      [20, 40],
      [30, 60],
      [50, 100],
      [75, 150],
      [100, 200],
      [150, 300],
      [200, 400],
      [300, 600],
      [500, 1000],
      [750, 1500],
      [1000, 2000],
      [1500, 3000],
      [2000, 4000],
      [3000, 6000],
    ],
    anteFrom: 4,
    breakAfter: [],
  },
  {
    key: 'standard',
    name: 'Standard',
    hint: 'The usual night.',
    ladder: [
      [10, 20],
      [15, 30],
      [25, 50],
      [40, 80],
      [50, 100],
      [75, 150],
      [100, 200],
      [150, 300],
      [200, 400],
      [300, 600],
      [400, 800],
      [500, 1000],
      [600, 1200],
      [800, 1600],
      [1000, 2000],
      [1500, 3000],
      [2000, 4000],
      [3000, 6000],
    ],
    anteFrom: 6,
    breakAfter: [6, 12],
  },
  {
    key: 'deep',
    name: 'Deep',
    hint: 'A slow climb, a long night.',
    ladder: [
      [10, 20],
      [15, 30],
      [20, 40],
      [25, 50],
      [30, 60],
      [40, 80],
      [50, 100],
      [60, 120],
      [80, 160],
      [100, 200],
      [125, 250],
      [150, 300],
      [200, 400],
      [250, 500],
      [300, 600],
      [400, 800],
      [500, 1000],
      [600, 1200],
      [800, 1600],
      [1000, 2000],
      [1250, 2500],
      [1500, 3000],
      [2000, 4000],
      [3000, 6000],
    ],
    anteFrom: 9,
    breakAfter: [8, 16],
  },
];

const DEFAULT_KEY = 'standard';

function preset(key) {
  return PRESETS.find((p) => p.key === String(key || '').toLowerCase()) || null;
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampDuration(value, fallback) {
  return clampInt(value, MIN_DURATION, MAX_DURATION, fallback);
}

function breakRow(duration) {
  return { sb: 0, bb: 0, ante: 0, duration, break: true };
}

// A preset as rows, every row lasting the level length the host chose,
// breaks included.
function materialize(key, levelDuration) {
  const def = preset(key) || preset(DEFAULT_KEY);
  const duration = clampDuration(levelDuration, DEFAULT_DURATION);
  const levels = [];
  def.ladder.forEach(([sb, bb], i) => {
    const n = i + 1;
    levels.push({
      sb,
      bb,
      ante: def.anteFrom > 0 && n >= def.anteFrom ? bb : 0,
      duration,
      break: false,
    });
    if (def.breakAfter.includes(n) && n < def.ladder.length) levels.push(breakRow(duration));
  });
  return { name: def.name, levels };
}

function cleanName(value) {
  const name = String(value || '')
    .split('')
    .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
  return name || 'Custom';
}

// Whatever a client sent, as something the clock can run. A preset key gives
// that preset; an object with levels is clamped row by row, in the spirit of
// GameNight's editor: bounds, not opinions. Blinds need not rise, the big
// blind need not be double, and the only rule is that there is a level to
// play. Idempotent, so a saved structure can be run through it again on
// restore without a running field's blinds moving.
function clampStructure(input, levelDuration) {
  const duration = clampDuration(levelDuration, DEFAULT_DURATION);
  if (typeof input === 'string') return materialize(input, duration);
  if (!input || typeof input !== 'object' || !Array.isArray(input.levels)) {
    return materialize(DEFAULT_KEY, duration);
  }
  const rows = [];
  for (const raw of input.levels.slice(0, MAX_LEVELS)) {
    if (!raw || typeof raw !== 'object') continue;
    const length = clampDuration(raw.duration, duration);
    if (raw.break) {
      rows.push(breakRow(length));
      continue;
    }
    const sb = clampInt(raw.sb, 0, MAX_CHIPS, 0);
    if (sb < 1) continue;
    let bb = clampInt(raw.bb, 0, MAX_CHIPS, 0);
    if (bb < sb) bb = Math.min(MAX_CHIPS, sb * 2);
    const ante = clampInt(raw.ante, 0, MAX_CHIPS, 0);
    rows.push({ sb, bb, ante, duration: length, break: false });
  }
  // A break is a pause between two levels of play: none before the first,
  // none after the last, and two in a row is one.
  const levels = [];
  for (const row of rows) {
    if (row.break && (levels.length === 0 || levels[levels.length - 1].break)) continue;
    levels.push(row);
  }
  while (levels.length && levels[levels.length - 1].break) levels.pop();
  if (!levels.length) return materialize(DEFAULT_KEY, duration);
  return { name: cleanName(input.name), levels };
}

// The classic ladder: 1 / 1.5 / 2 / 2.5 / 3 / 4 / 5 / 6 / 8 per decade, from
// 10 up. GameNight's runs 1 / 1.5 / 2 / 3 / 4 / 6 / 8 from 25; the extra
// rungs are what a 10/20 start needs to pass through 25/50 and 50/100.
const LADDER = [];
for (let mag = 10; mag <= 10000000; mag *= 10) {
  for (const b of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8]) {
    const v = Math.round(b * mag);
    if (!LADDER.includes(v)) LADDER.push(v);
  }
}
LADDER.sort((a, b) => a - b);

function ladderNext(v, factor = 1.5) {
  const target = v * factor;
  for (const rung of LADDER) if (rung >= target - 0.001) return rung;
  return Math.round(target);
}

// A level to insert at `at`: the next rung up from the nearest level of play
// above it, big blind double, the same length. It inherits whether that
// level antes, never its amount: a copied ante would sit a rung below its
// own big blind. Mirrored in public/js/lobby.js for the editor, which adds a
// level without asking the server.
function nextLevel(levels, at = levels.length) {
  let ref = null;
  for (let i = Math.min(at, levels.length) - 1; i >= 0; i--) {
    if (!levels[i].break) {
      ref = levels[i];
      break;
    }
  }
  const sb = ref ? ladderNext(ref.sb || 10) : 10;
  const bb = sb * 2;
  return {
    sb,
    bb,
    ante: ref && ref.ante > 0 ? bb : 0,
    duration: ref ? ref.duration : DEFAULT_DURATION,
    break: false,
  };
}

// The short form: what a card or a settings line says about a structure.
// Level numbers count levels of play; a break has no number of its own.
function summary(structure) {
  const levels = structure && Array.isArray(structure.levels) ? structure.levels : [];
  let n = 0;
  let anteFrom = 0;
  const breaks = [];
  for (const row of levels) {
    if (row.break) {
      if (n > 0 && !breaks.includes(n)) breaks.push(n);
      continue;
    }
    n++;
    if (!anteFrom && row.ante > 0) anteFrom = n;
  }
  return { name: structure ? structure.name : 'Standard', levelCount: n, anteFrom, breaks };
}

module.exports = {
  PRESETS,
  DEFAULT_KEY,
  MAX_LEVELS,
  MIN_DURATION,
  MAX_DURATION,
  preset,
  materialize,
  clampStructure,
  nextLevel,
  ladderNext,
  summary,
};

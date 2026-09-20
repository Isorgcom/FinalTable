// api-games.js - what GameNight sends to make a game, read into what the
// registry takes.
//
// Two vocabularies, one payload. GameNight has names for these things already
// - its events carry `title` and `start_at`, its blind structures are rows of
// `small_blind`/`big_blind`/`duration_minutes`/`is_break`, its rosters are
// `invitees` with a `manager` - and this server has its own, which the create
// form sends. Both are accepted; GameNight's wins when both are given, since
// it is the explicit one. Nothing here clamps a number: that is
// clampSettings' and clampStructure's job, and doing it twice is a second
// copy of a rule.
//
// What is checked here is what those cannot know: that the roster is a
// roster, that exactly one person on it is the host, and that the start is
// not so far off that the registry would silently move it to now.

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ROSTER = 200;
// A GameNight user id, as the SSO token's `sub` carries it.
const USER_ID = /^\d{1,12}$/;

function has(v) {
  return v !== undefined && v !== null && v !== '';
}

function truthy(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

// GameNight's level rows into this server's. Minutes to seconds; a break is a
// row flagged as one. Anything else about a row is clampStructure's business.
function levelsFromGameNight(rows) {
  return rows.map((row) => {
    const r = row && typeof row === 'object' ? row : {};
    const minutes = Number(r.duration_minutes);
    const out = { sb: r.small_blind, bb: r.big_blind, ante: r.ante, break: truthy(r.is_break) };
    if (Number.isFinite(minutes)) out.duration = Math.round(minutes * 60);
    return out;
  });
}

function readCreateBody(body, { sanitizeName, now = () => Date.now() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'The body must be a JSON object.' };
  }
  const pick = (...keys) => {
    for (const key of keys) if (has(body[key])) return body[key];
    return undefined;
  };

  // Invite-only whatever was asked: the roster is the door.
  const payload = { visibility: 'invite' };

  const name = pick('title', 'name');
  if (name !== undefined) payload.name = String(name);

  // When. GameNight says it as ISO-8601; the form says it in milliseconds.
  // Past is fine - the registry starts it now - but a week out is the
  // registry's ceiling, and past it the clamp would move the start to now
  // and the sweep would write the game off half an hour later for nobody
  // else having come. Better refused than lost.
  const t = now();
  let startsAt;
  if (has(body.start_at)) {
    startsAt = Date.parse(String(body.start_at));
    if (!Number.isFinite(startsAt)) return { error: 'start_at is not a date.' };
  } else if (has(body.startsAt)) {
    startsAt = Number(body.startsAt);
    if (!Number.isFinite(startsAt)) return { error: 'startsAt is not a time in milliseconds.' };
  }
  if (startsAt !== undefined) {
    if (startsAt > t + WEEK_MS) {
      return { error: 'A game can be made up to seven days before it starts.' };
    }
    payload.startsAt = startsAt;
  }

  const tableSize = pick('seats_per_table', 'poker_seats', 'tableSize');
  if (tableSize !== undefined) payload.tableSize = tableSize;
  const startChips = pick('starting_chips', 'startChips');
  if (startChips !== undefined) payload.startChips = startChips;
  if (has(body.levelDuration)) payload.levelDuration = body.levelDuration;
  if (has(body.lateRegLevels)) payload.lateRegLevels = body.lateRegLevels;
  if (has(body.reentryLevels)) payload.reentryLevels = body.reentryLevels;
  const addOn = pick('addon_allowed', 'addOn');
  if (addOn !== undefined) payload.addOn = truthy(addOn);
  const buyIn = pick('buyin_amount', 'poker_buyin', 'buyIn');
  if (buyIn !== undefined) payload.buyIn = buyIn;
  if (has(body.bots)) payload.bots = body.bots;

  // The blinds: GameNight's rows, or a preset key, or this server's own
  // shape, which goes through untouched for clampStructure to judge.
  if (has(body.blind_levels)) {
    if (!Array.isArray(body.blind_levels)) {
      return { error: 'blind_levels must be an array of levels.' };
    }
    const structureName = pick('structure_name', 'blind_preset_name');
    payload.structure = {
      ...(structureName !== undefined ? { name: String(structureName) } : {}),
      levels: levelsFromGameNight(body.blind_levels),
    };
  } else if (has(body.structure)) {
    payload.structure = body.structure;
  }

  // The roster. Every row is a GameNight user by id and username - the two
  // things the sign-in token carries, so a seat made here is the seat they
  // land on - and exactly one of them is the manager, who hosts.
  const list = pick('invitees', 'roster');
  if (!Array.isArray(list) || list.length === 0) {
    return { error: 'A roster is needed: invitees, with one manager.' };
  }
  if (list.length > MAX_ROSTER) {
    return { error: `A roster holds at most ${MAX_ROSTER} people.` };
  }
  const roster = [];
  const seen = new Set();
  let hostId = null;
  for (const row of list) {
    if (!row || typeof row !== 'object') {
      return { error: 'Each roster row needs a user_id and a username.' };
    }
    const sub = String(has(row.user_id) ? row.user_id : has(row.id) ? row.id : '').trim();
    if (!USER_ID.test(sub)) {
      return { error: "A roster user_id must be GameNight's numeric user id." };
    }
    if (seen.has(sub)) return { error: `user_id ${sub} is on the roster twice.` };
    seen.add(sub);
    const wanted = has(row.username) ? row.username : row.name;
    const safeName = sanitizeName(wanted);
    if (!safeName) return { error: `A usable username is needed for user_id ${sub}.` };
    const host = truthy(row.manager) || truthy(row.host);
    if (host) {
      if (hostId) return { error: 'The roster names two managers; one of them hosts.' };
      hostId = sub;
    }
    roster.push({ sub, name: safeName, host });
  }
  if (!hostId) return { error: 'The roster needs one manager, who hosts the game.' };

  // The uids are the registry's guest list, known before the identities
  // exist because a GameNight uid is a function of the user id.
  payload.guests = roster.map((r) => `gn_${r.sub}`);
  return { payload, roster, hostId };
}

module.exports = { readCreateBody, levelsFromGameNight, WEEK_MS, MAX_ROSTER };

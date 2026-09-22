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

const { webhookAllowed, refusalFor } = require('./webhook-origins');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ROSTER = 200;
// A GameNight user id, as the SSO token's `sub` carries it.
const USER_ID = /^\d{1,12}$/;
// The secret a webhook is signed with, and the id GameNight wants echoed.
const MIN_SECRET = 16;
const MAX_SECRET = 256;
const MAX_EXTERNAL_ID = 64;

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

function readCreateBody(
  body,
  // webhookOrigins: the addresses a webhook may be sent to, or null for no
  // rule. server.js always passes a list (possibly empty, which refuses every
  // address); a caller that has not been taught about origins - the unit
  // tests - gets the old behaviour.
  { sanitizeName, now = () => Date.now(), webhookOrigins = null } = {}
) {
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

  // Where to report to, if anywhere. Not in the payload: the payload is what
  // a browser's create form sends too, and the registry takes this by a
  // separate hand that only the API route reaches for.
  const hook = pick('webhook');
  if (hook !== undefined && (typeof hook !== 'object' || Array.isArray(hook))) {
    return { error: 'webhook must be an object with a url and a secret.' };
  }
  const url = has(body.webhook_url) ? body.webhook_url : hook ? hook.url : undefined;
  const secret = has(body.webhook_secret) ? body.webhook_secret : hook ? hook.secret : undefined;
  let webhook = null;
  if (has(url) || has(secret)) {
    if (!has(url) || !has(secret)) return { error: 'A webhook needs both a url and a secret.' };
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch (_err) {
      parsed = null;
    }
    if (
      !parsed ||
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      String(url).length > 2048
    ) {
      return { error: 'The webhook url must be an http(s) address.' };
    }
    // And it must be somewhere this server expects to report to. See
    // webhook-origins.js for why the key alone is not enough.
    if (!webhookAllowed(url, webhookOrigins)) {
      return { error: refusalFor(webhookOrigins) };
    }
    if (typeof secret !== 'string' || secret.length < MIN_SECRET || secret.length > MAX_SECRET) {
      return { error: `The webhook secret must be at least ${MIN_SECRET} characters.` };
    }
    webhook = { url: String(url).trim(), secret, externalId: null };
  }
  const externalId = pick('external_id', 'event_id');
  if (externalId !== undefined) {
    const text = String(externalId);
    if (!text || text.length > MAX_EXTERNAL_ID) {
      return { error: `external_id must be a string of up to ${MAX_EXTERNAL_ID} characters.` };
    }
    if (webhook) webhook.externalId = text;
  }
  return { payload, roster, hostId, webhook };
}

module.exports = {
  readCreateBody,
  levelsFromGameNight,
  WEEK_MS,
  MAX_ROSTER,
  MIN_SECRET,
  MAX_EXTERNAL_ID,
  USER_ID,
};

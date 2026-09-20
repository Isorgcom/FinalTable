// __tests__/api-games.test.js - what GameNight sends to make a game here.
//
// The reader accepts two vocabularies and refuses only what the registry
// cannot judge for itself: the roster, its one manager, and a start so far
// off the registry would quietly move it to now.
const { readCreateBody, WEEK_MS } = require('../server/api-games');

const sanitizeName = (v) =>
  String(v || '')
    .replace(/[^\p{L}\p{N} ._'-]/gu, '')
    .trim()
    .slice(0, 16);

const read = (body, now = () => 1_000_000) => readCreateBody(body, { sanitizeName, now });

const roster = [
  { user_id: 7, username: 'Ann', manager: true },
  { user_id: 12, username: 'Bob' },
];

describe('reading a create request', () => {
  test("GameNight's own names are understood", () => {
    const out = read({
      title: 'Thursday',
      start_at: '1970-01-01T00:20:00Z',
      seats_per_table: 6,
      starting_chips: 10000,
      buyin_amount: 20,
      addon_allowed: 1,
      blind_levels: [
        { small_blind: 25, big_blind: 50, ante: 0, duration_minutes: 15, is_break: 0 },
        { small_blind: 0, big_blind: 0, ante: 0, duration_minutes: 10, is_break: 1 },
        { small_blind: 50, big_blind: 100, ante: 100, duration_minutes: 15, is_break: 0 },
      ],
      structure_name: 'Club',
      invitees: roster,
    });
    expect(out.error).toBeUndefined();
    expect(out.hostId).toBe('7');
    expect(out.roster).toEqual([
      { sub: '7', name: 'Ann', host: true },
      { sub: '12', name: 'Bob', host: false },
    ]);
    expect(out.payload).toMatchObject({
      name: 'Thursday',
      startsAt: 1_200_000,
      tableSize: 6,
      startChips: 10000,
      buyIn: 20,
      addOn: true,
      visibility: 'invite',
      guests: ['gn_7', 'gn_12'],
    });
    expect(out.payload.structure).toEqual({
      name: 'Club',
      levels: [
        { sb: 25, bb: 50, ante: 0, duration: 900, break: false },
        { sb: 0, bb: 0, ante: 0, duration: 600, break: true },
        { sb: 50, bb: 100, ante: 100, duration: 900, break: false },
      ],
    });
  });

  test("this server's own names are understood, and a preset goes through untouched", () => {
    const out = read({
      name: 'Home game',
      startsAt: 1_500_000,
      tableSize: 8,
      startChips: 5000,
      levelDuration: 600,
      lateRegLevels: 2,
      reentryLevels: 3,
      addOn: true,
      buyIn: 10,
      structure: 'turbo',
      bots: 3,
      visibility: 'public',
      roster: [{ id: 3, name: 'Cy', host: true }],
    });
    expect(out.error).toBeUndefined();
    expect(out.payload).toEqual({
      name: 'Home game',
      startsAt: 1_500_000,
      tableSize: 8,
      startChips: 5000,
      levelDuration: 600,
      lateRegLevels: 2,
      reentryLevels: 3,
      addOn: true,
      buyIn: 10,
      structure: 'turbo',
      bots: 3,
      visibility: 'invite',
      guests: ['gn_3'],
    });
  });

  test("GameNight's name wins when both are sent", () => {
    const out = read({ title: 'Theirs', name: 'Ours', invitees: roster });
    expect(out.payload.name).toBe('Theirs');
  });

  test('a start is refused past a week out and accepted in the past', () => {
    expect(read({ startsAt: 1_000_000 + WEEK_MS + 1, invitees: roster }).error).toMatch(
      /seven days/
    );
    expect(read({ start_at: 'yesterday-ish', invitees: roster }).error).toMatch(/not a date/);
    expect(read({ startsAt: 'soon', invitees: roster }).error).toMatch(/milliseconds/);
    expect(read({ startsAt: 5, invitees: roster }).payload.startsAt).toBe(5);
    expect(read({ invitees: roster }).payload.startsAt).toBeUndefined();
  });

  test('the roster is the one thing that must be right', () => {
    expect(read({}).error).toMatch(/roster/);
    expect(read({ invitees: [] }).error).toMatch(/roster/);
    expect(read({ invitees: 'Ann' }).error).toMatch(/roster/);
    expect(read({ invitees: [{ user_id: 7, username: 'Ann' }] }).error).toMatch(/one manager/);
    expect(
      read({
        invitees: [
          { user_id: 7, username: 'Ann', manager: true },
          { user_id: 8, username: 'Bo', manager: true },
        ],
      }).error
    ).toMatch(/two managers/);
    expect(
      read({ invitees: [{ user_id: 'seven', username: 'Ann', manager: true }] }).error
    ).toMatch(/numeric/);
    expect(read({ invitees: [{ username: 'Ann', manager: true }] }).error).toMatch(/numeric/);
    expect(
      read({
        invitees: [
          { user_id: 7, username: 'Ann', manager: true },
          { user_id: 7, username: 'Ann again' },
        ],
      }).error
    ).toMatch(/twice/);
    expect(read({ invitees: [{ user_id: 7, username: '###', manager: true }] }).error).toMatch(
      /usable username/
    );
    expect(read({ invitees: ['Ann'] }).error).toMatch(/user_id and a username/);
    const big = Array.from({ length: 201 }, (_, i) => ({ user_id: i + 1, username: `P${i}` }));
    big[0].manager = true;
    expect(read({ invitees: big }).error).toMatch(/at most 200/);
  });

  test('blind_levels must be a list; a bad body is refused before anything else', () => {
    expect(read({ blind_levels: 'turbo', invitees: roster }).error).toMatch(/array/);
    expect(read(null).error).toMatch(/JSON object/);
    expect(read([1, 2]).error).toMatch(/JSON object/);
  });
});

// ── Over HTTP, against a real server ──────────────────────────────────────
//
// Booted paired with a keypair minted here, so a roster member can arrive the
// way they would: through the sign-in bridge, with a token signed the way
// GameNight signs them.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: Client } = require('socket.io-client');
const { accountFor } = require('./helpers/account');

jest.setTimeout(20000);

const ISSUER = 'http://gamenight.test:8080';
const AUDIENCE = 'finaltable';
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

describe('GameNight making a game over the API', () => {
  const originalEnv = { ...process.env };
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sockets = [];
  let baseUrl, serverModule, tempDir;
  let seq = 0;

  function gnToken(sub, name) {
    const now = Math.floor(Date.now() / 1000);
    seq += 1;
    const claims = {
      iss: ISSUER,
      aud: AUDIENCE,
      sub: String(sub),
      iat: now,
      exp: now + 120,
      jti: `api-${String(seq).padStart(12, '0')}-abcdef`,
      name,
      tier: 'Free',
    };
    const input = `${b64url({ typ: 'JWT', alg: 'ES256' })}.${b64url(claims)}`;
    const sig = crypto.sign('sha256', Buffer.from(input), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    return `${input}.${sig.toString('base64url')}`;
  }

  async function boot() {
    jest.resetModules();
    serverModule = require('../server');
    await serverModule.startServer({ port: 0, host: '127.0.0.1', unrefServer: true });
    baseUrl = `http://127.0.0.1:${serverModule.server.address().port}`;
  }

  async function shutdown() {
    while (sockets.length) sockets.pop().close();
    await serverModule.flushStores();
    serverModule.registry.stop();
    await new Promise((r) => serverModule.io.close(r));
    if (serverModule.server.listening) await new Promise((r) => serverModule.server.close(r));
  }

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-api-games-'));
    process.env.SAVE_DIR = tempDir;
    process.env.DB_NAME = 'api-games';
    process.env.HOST = '127.0.0.1';
    process.env.HTTP_RATE_LIMIT = '1000';
    process.env.GAMENIGHT_URL = ISSUER;
    process.env.GAMENIGHT_PUBLIC_KEY = publicKey
      .export({ type: 'spki', format: 'pem' })
      .replace(/\n/g, '\\n');
    process.env.GAMENIGHT_AUDIENCE = AUDIENCE;
    // A public address, so the answer carries links.
    process.env.PUBLIC_URL = 'https://table.example';
    process.env.MAIL_TRANSPORT = 'log';
    delete process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_PROMOTE;
    delete process.env.CLAIM_TOKEN;
    await boot();
  });

  afterAll(async () => {
    await shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  function connect() {
    return new Promise((res) => {
      const s = Client(baseUrl, { forceNew: true, reconnection: false, transports: ['websocket'] });
      sockets.push(s);
      s.once('connect', () => res(s));
    });
  }

  function ask(s, event, payload, answer) {
    return new Promise((res) => {
      s.once(answer, res);
      s.emit(event, payload);
    });
  }

  // The first answer of either kind: what a join emits, or the error it fails
  // with.
  function joinOutcome(s, payload) {
    return new Promise((res) => {
      const done = (kind) => (data) => res({ kind, data });
      s.once('tournamentJoined', done('joined'));
      s.once('tournamentPending', done('pending'));
      s.once('error', done('error'));
      s.emit('joinTournament', payload);
    });
  }

  let admins = 0;
  async function adminSocket() {
    const s = await connect();
    await ask(
      s,
      'identify',
      { token: accountFor(serverModule, `Boss${admins++}`, { role: 'admin' }).token },
      'identified'
    );
    return s;
  }

  const post = (body, key) =>
    fetch(`${baseUrl}/api/games`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

  const get = (id, key) =>
    fetch(`${baseUrl}/api/games/${id}`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

  const roster = () => [
    { user_id: 7, username: 'Ann', manager: true },
    { user_id: 12, username: 'Bob' },
  ];

  let key = null;

  test('the key is made by an administrator, shown once, and never to a player', async () => {
    const player = await connect();
    let answered = false;
    player.on('adminApiKey', () => (answered = true));
    player.emit('adminGetApiKey');
    player.emit('adminMakeApiKey');
    await new Promise((r) => setTimeout(r, 200));
    expect(answered).toBe(false);

    const boss = await adminSocket();
    const before = await ask(boss, 'adminGetApiKey', {}, 'adminApiKey');
    expect(before).toMatchObject({ set: false, createdAt: null });
    expect(before).not.toHaveProperty('key');

    const made = await ask(boss, 'adminMakeApiKey', {}, 'adminApiKey');
    expect(made.ok).toBe(true);
    expect(made.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(made.set).toBe(true);
    key = made.key;

    const again = await ask(boss, 'adminGetApiKey', {}, 'adminApiKey');
    expect(again.set).toBe(true);
    expect(again).not.toHaveProperty('key');
    expect(again).not.toHaveProperty('digest');
  });

  test('without the key there is no way in, in the envelope', async () => {
    const none = await post({ invitees: roster() });
    expect(none.status).toBe(401);
    expect(none.body).toEqual({ ok: false, error: expect.stringMatching(/missing or wrong/) });
    const wrong = await post({ invitees: roster() }, 'not-the-key');
    expect(wrong.status).toBe(401);
    expect((await get('t_nothing', 'not-the-key')).status).toBe(401);
  });

  test('a body the reader refuses is a 400 with the sentence', async () => {
    expect(await post({ title: 'No roster' }, key)).toMatchObject({
      status: 400,
      body: { ok: false, error: expect.stringMatching(/roster/) },
    });
    expect(await post('{not json', key)).toMatchObject({
      status: 400,
      body: { ok: false, error: expect.stringMatching(/not JSON/) },
    });
    expect(await post({ invitees: roster(), start_at: '2099-01-01T00:00:00Z' }, key)).toMatchObject(
      { status: 400, body: { error: expect.stringMatching(/seven days/) } }
    );
    expect(serverModule.registry.tournaments.size).toBe(0);
  });

  let made = null;

  test("GameNight's vocabulary makes an invite-only game with a guest list", async () => {
    const r = await post(
      {
        title: 'Thursday',
        start_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        seats_per_table: 6,
        starting_chips: 10000,
        blind_levels: [
          { small_blind: 25, big_blind: 50, ante: 0, duration_minutes: 15, is_break: 0 },
          { small_blind: 50, big_blind: 100, ante: 0, duration_minutes: 15, is_break: 0 },
        ],
        structure_name: 'Club',
        invitees: roster(),
      },
      key
    );
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    made = r.body.data;
    expect(made.id).toMatch(/^t_/);
    expect(made.code).toMatch(/^[A-Z2-9]{5}$/);
    expect(made.rail).toMatch(/^[A-Z2-9]{5}$/);
    expect(made.rail).not.toBe(made.code);
    expect(made.links).toEqual({
      join: `https://table.example/?t=${made.code}`,
      rail: `https://table.example/?w=${made.rail}`,
    });
    expect(made).toMatchObject({
      name: 'Thursday',
      status: 'registering',
      visibility: 'invite',
      host: { uid: 'gn_7', name: 'Ann' },
      roster: [
        { uid: 'gn_7', name: 'Ann' },
        { uid: 'gn_12', name: 'Bob' },
      ],
      settings: { tableSize: 6, startChips: 10000, structure: 'Club' },
    });
    // The host is registered, nobody else is yet, and nobody is connected.
    expect(made.entrants).toEqual([
      expect.objectContaining({ uid: 'gn_7', name: 'Ann', isHost: true, connected: false }),
    ]);

    const entry = serverModule.registry.tournaments.get(made.id);
    expect(entry.settings.visibility).toBe('invite');
    expect(entry.hostUid).toBe('gn_7');
    expect([...entry.guests]).toEqual(['gn_7', 'gn_12']);

    // The roster exists here now, as GameNight people, and none of them runs
    // the server for having been made first.
    for (const uid of ['gn_7', 'gn_12']) {
      expect(serverModule.identity.get(uid)).toMatchObject({ uid, provider: 'gamenight' });
      expect(serverModule.identity.isAdmin(uid)).toBe(false);
    }
    expect(serverModule.identity.list({}).rows.find((u) => u.uid === 'gn_12')).toMatchObject({
      provider: 'gamenight',
    });
  });

  test('the same host cannot be given a second game', async () => {
    const r = await post({ invitees: roster() }, key);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/already in a game/);
  });

  test('a listed guest walks straight in; an unlisted one is told so', async () => {
    const bob = await connect();
    const asBob = await ask(bob, 'identify', { gnToken: gnToken(12, 'Bob') }, 'identified');
    expect(asBob.uid).toBe('gn_12');
    expect(asBob.isNew).toBe(false);
    const inside = await joinOutcome(bob, { code: made.code });
    expect(inside.kind).toBe('joined');
    expect(inside.data.host).toBe(false);

    const stranger = await connect();
    await ask(stranger, 'identify', { gnToken: gnToken(99, 'Zed') }, 'identified');
    const refused = await joinOutcome(stranger, { code: made.code });
    expect(refused.kind).toBe('error');
    expect(refused.data.message).toMatch(/not on this game's guest list/);
    // And by id alone, the game does not exist for them.
    const guessed = await joinOutcome(stranger, { tournamentId: made.id });
    expect(guessed.data.message).toMatch(/not found/);

    const read = await get(made.id, key);
    expect(read.status).toBe(200);
    expect(read.body.data.entrants.map((e) => e.uid).sort()).toEqual(['gn_12', 'gn_7']);
    expect(read.body.data.entrants.find((e) => e.uid === 'gn_12').connected).toBe(true);
  });

  test('the host arrives through the bridge and is the host', async () => {
    const ann = await connect();
    const joined = new Promise((res) => ann.once('tournamentJoined', res));
    const asAnn = await ask(ann, 'identify', { gnToken: gnToken(7, 'Ann') }, 'identified');
    expect(asAnn.resume).toMatchObject({ id: made.id, code: made.code });
    expect((await joined).host).toBe(true);
    const read = await get(made.id, key);
    expect(read.body.data.entrants.find((e) => e.uid === 'gn_7')).toMatchObject({
      isHost: true,
      connected: true,
    });
  });

  test('an unknown id is a 404', async () => {
    expect(await get('t_000000000', key)).toMatchObject({
      status: 404,
      body: { ok: false, error: expect.stringMatching(/No game/) },
    });
  });

  test('the guest list and the host survive a restart', async () => {
    await shutdown();
    await boot();
    const entry = serverModule.registry.tournaments.get(made.id);
    expect(entry).toBeTruthy();
    expect([...entry.guests]).toEqual(['gn_7', 'gn_12']);
    expect(entry.hostUid).toBe('gn_7');
    expect(entry.settings.visibility).toBe('invite');
    // The key came back too.
    const read = await get(made.id, key);
    expect(read.status).toBe(200);
    expect(read.body.data.roster).toHaveLength(2);
  });

  test('revoked, the key opens nothing', async () => {
    const boss = await adminSocket();
    const gone = await ask(boss, 'adminRevokeApiKey', {}, 'adminApiKey');
    expect(gone).toMatchObject({ ok: true, set: false });
    const r = await get(made.id, key);
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/no API key/);
  });
});

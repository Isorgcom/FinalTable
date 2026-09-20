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

  test('a webhook is both an address and a secret, or nothing', () => {
    const good = { url: 'https://gamenight.example/hooks', secret: 's'.repeat(16) };
    expect(read({ invitees: roster }).webhook).toBeNull();
    expect(read({ invitees: roster, webhook: good }).webhook).toEqual({
      ...good,
      externalId: null,
    });
    expect(
      read({
        invitees: roster,
        webhook_url: good.url,
        webhook_secret: good.secret,
        event_id: 'ev_812',
      }).webhook
    ).toEqual({ ...good, externalId: 'ev_812' });
    expect(read({ invitees: roster, webhook: good, external_id: 'x' }).webhook.externalId).toBe(
      'x'
    );
    // Nothing rides in the payload a browser could have sent.
    expect(read({ invitees: roster, webhook: good }).payload).not.toHaveProperty('webhook');

    expect(read({ invitees: roster, webhook: 'nope' }).error).toMatch(/object with a url/);
    expect(read({ invitees: roster, webhook_url: good.url }).error).toMatch(
      /both a url and a secret/
    );
    expect(read({ invitees: roster, webhook_secret: good.secret }).error).toMatch(/both/);
    expect(
      read({ invitees: roster, webhook: { url: 'ftp://x', secret: good.secret } }).error
    ).toMatch(/http\(s\)/);
    expect(
      read({ invitees: roster, webhook: { url: 'not a url', secret: good.secret } }).error
    ).toMatch(/http\(s\)/);
    expect(read({ invitees: roster, webhook: { url: good.url, secret: 'short' } }).error).toMatch(
      /at least 16/
    );
    expect(read({ invitees: roster, external_id: 'x'.repeat(65) }).error).toMatch(/up to 64/);
    expect(read({ invitees: roster, external_id: '' }).payload).toBeTruthy();
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

// ── What GameNight is told, over a real socket and a real receiver ────────
describe('GameNight being told how a game went', () => {
  const originalEnv = { ...process.env };
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sockets = [];
  let baseUrl, serverModule, tempDir, receiver;
  let seq = 100;
  const SECRET = 'a-webhook-secret-of-length';

  function gnToken(sub, name) {
    const now = Math.floor(Date.now() / 1000);
    seq += 1;
    const claims = {
      iss: ISSUER,
      aud: AUDIENCE,
      sub: String(sub),
      iat: now,
      exp: now + 120,
      jti: `hook-${String(seq).padStart(12, '0')}-abcdef`,
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

  // A stand-in GameNight endpoint: records every delivery, answers a queue of
  // statuses, and hands the next delivery to whoever is waiting for it.
  function makeReceiver() {
    const http = require('http');
    const got = [];
    const waiting = [];
    const statuses = [];
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          const hit = { headers: req.headers, body, json: JSON.parse(body) };
          got.push(hit);
          const status = statuses.length ? statuses.shift() : 200;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
          const w = waiting.shift();
          if (w) w(hit);
        });
      });
      server.listen(0, '127.0.0.1', () => {
        resolve({
          url: `http://127.0.0.1:${server.address().port}/hooks/finaltable`,
          got,
          statuses,
          next: () =>
            new Promise((res, rej) => {
              const timer = setTimeout(() => rej(new Error('no delivery in 10 s')), 10000);
              waiting.push((hit) => {
                clearTimeout(timer);
                res(hit);
              });
            }),
          close: () => new Promise((r) => server.close(r)),
        });
      });
    });
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-api-hooks-'));
    process.env.SAVE_DIR = tempDir;
    process.env.DB_NAME = 'api-games-hooks';
    process.env.HOST = '127.0.0.1';
    process.env.HTTP_RATE_LIMIT = '1000';
    process.env.TOURNAMENT_SWEEP_MS = '100';
    process.env.GAMENIGHT_URL = ISSUER;
    process.env.GAMENIGHT_PUBLIC_KEY = publicKey
      .export({ type: 'spki', format: 'pem' })
      .replace(/\n/g, '\\n');
    process.env.GAMENIGHT_AUDIENCE = AUDIENCE;
    process.env.PUBLIC_URL = 'https://table.example';
    process.env.MAIL_TRANSPORT = 'log';
    delete process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_PROMOTE;
    delete process.env.CLAIM_TOKEN;
    receiver = await makeReceiver();
    await boot();
  });

  afterAll(async () => {
    await shutdown();
    await receiver.close();
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

  let admins = 10;
  async function adminSocket() {
    const s = await connect();
    await ask(
      s,
      'identify',
      { token: accountFor(serverModule, `Hooker${admins++}`, { role: 'admin' }).token },
      'identified'
    );
    return s;
  }

  const post = (body, key) =>
    fetch(`${baseUrl}/api/games`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

  const get = (id, key) =>
    fetch(`${baseUrl}/api/games/${id}`, { headers: { authorization: `Bearer ${key}` } }).then(
      async (r) => ({ status: r.status, body: await r.json() })
    );

  // A game with two GameNight people in it and the clock started, held so
  // nothing plays itself out.
  async function runningGame(key, hostId, guestId, extra = {}) {
    const r = await post(
      {
        title: `Hooked ${hostId}`,
        startsAt: Date.now() - 1000,
        tableSize: 6,
        buyIn: 100,
        reentryLevels: 2,
        invitees: [
          { user_id: hostId, username: `Host${hostId}`, manager: true },
          { user_id: guestId, username: `Guest${guestId}` },
        ],
        webhook: { url: receiver.url, secret: SECRET },
        external_id: `ev_${hostId}`,
        ...extra,
      },
      key
    );
    expect(r.status).toBe(201);
    const guest = await connect();
    const asGuest = await ask(
      guest,
      'identify',
      { gnToken: gnToken(guestId, `Guest${guestId}`) },
      'identified'
    );
    await ask(guest, 'joinTournament', { code: r.body.data.code }, 'tournamentJoined');
    const entry = serverModule.registry.tournaments.get(r.body.data.id);
    if (!extra.startsAt || extra.startsAt <= Date.now()) {
      for (let i = 0; i < 50 && entry.status !== 'running'; i++) {
        await new Promise((res) => setTimeout(res, 100));
      }
      expect(entry.status).toBe('running');
      entry.director.holdField();
    }
    return { made: r.body.data, entry, guest, guestToken: asGuest.token };
  }

  const control = (id, verb, body, key) =>
    fetch(`${baseUrl}/api/games/${id}/${verb}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

  const signOut = (userId, key) =>
    fetch(`${baseUrl}/api/players/${userId}/sign-out`, {
      method: 'POST',
      headers: key ? { authorization: `Bearer ${key}` } : {},
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

  function bust(entry, uid) {
    const { table, player } = entry.director.playerByUid(uid);
    const keeper = table.players.find((p) => p.uid !== uid && p.chips > 0);
    keeper.chips += player.chips;
    player.chips = 0;
    entry.director.tournament.recordElimination(player.name, 1, uid);
    entry.director._handleRoundEnd(table, null);
  }

  // Wait for a delivery that may already have landed.
  async function arrived(gameId, event) {
    for (let i = 0; i < 100; i++) {
      const hit = receiver.got.find((h) => h.json.event === event && h.json.game.id === gameId);
      if (hit) return hit;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error(`${event} for ${gameId} never arrived`);
  }

  let key = null;

  test('the address is taken, answered without its secret, and refused when half given', async () => {
    const boss = await adminSocket();
    key = (await ask(boss, 'adminMakeApiKey', {}, 'adminApiKey')).key;
    const roster = [
      { user_id: 41, username: 'Ann', manager: true },
      { user_id: 42, username: 'Bob' },
    ];
    expect(await post({ invitees: roster, webhook_url: receiver.url }, key)).toMatchObject({
      status: 400,
      body: { error: expect.stringMatching(/both a url and a secret/) },
    });
    expect(
      await post({ invitees: roster, webhook: { url: 'ftp://x', secret: SECRET } }, key)
    ).toMatchObject({ status: 400, body: { error: expect.stringMatching(/http/) } });
    expect(
      await post({ invitees: roster, webhook: { url: receiver.url, secret: 'short' } }, key)
    ).toMatchObject({ status: 400, body: { error: expect.stringMatching(/16/) } });
    expect(
      await post(
        {
          invitees: roster,
          webhook: { url: receiver.url, secret: SECRET },
          external_id: 'x'.repeat(65),
        },
        key
      )
    ).toMatchObject({ status: 400, body: { error: expect.stringMatching(/64/) } });
    expect(serverModule.registry.tournaments.size).toBe(0);
  });

  test('a bust-out and the finish reach the receiver, signed and in order', async () => {
    const { made, entry } = await runningGame(key, 41, 42);
    expect(made.webhook).toEqual({
      url: receiver.url,
      externalId: 'ev_41',
      deliveries: { pending: 0, delivered: 0, abandoned: 0, lastError: null },
    });
    expect(JSON.stringify(made)).not.toContain(SECRET);

    // The clock starting was the first thing said, before anybody busted.
    const began = await arrived(made.id, 'tournament.started');
    expect(began.json).toMatchObject({
      game: { external_id: 'ev_41' },
      level: 1,
      on_break: false,
      entrants: 2,
      humans: 2,
      remaining: 2,
      prize_pool: 200,
      buy_in: 100,
    });

    const first = receiver.next();
    bust(entry, 'gn_42');
    const hit = await first;
    expect(hit.headers['x-finaltable-event']).toBe('player.eliminated');
    expect(hit.headers['user-agent']).toMatch(/^FinalTable\//);
    expect(hit.json).toMatchObject({
      event: 'player.eliminated',
      game: { id: made.id, name: 'Hooked 41', external_id: 'ev_41' },
      player: { uid: 'gn_42', user_id: '42', name: 'Guest42', is_bot: false },
      place: 2,
      final: false,
      how: 'busted',
      remaining: 1,
      entrants: 2,
    });
    expect(hit.headers['x-finaltable-delivery']).toBe(String(hit.json.delivery_id));
    const want = crypto
      .createHmac('sha256', SECRET)
      .update(`${hit.headers['x-finaltable-timestamp']}.${hit.body}`)
      .digest('hex');
    expect(hit.headers['x-finaltable-signature']).toBe(`sha256=${want}`);

    const second = receiver.next();
    entry.director._finish(null);
    const end = await second;
    expect(end.json).toMatchObject({
      event: 'tournament.completed',
      outcome: 'winner',
      winner: { uid: 'gn_41', user_id: '41', name: 'Host41' },
      entrants: 2,
      humans: 2,
      prize_pool: 200,
    });
    expect(end.json.standings.map((r) => [r.place, r.uid])).toEqual([
      [1, 'gn_41'],
      [2, 'gn_42'],
    ]);
    for (let i = 0; i < 50; i++) {
      const view = await get(made.id, key);
      if (view.body.data.webhook.deliveries.delivered === 3) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    expect((await get(made.id, key)).body.data.webhook.deliveries).toEqual({
      pending: 0,
      delivered: 3,
      abandoned: 0,
      lastError: null,
    });
  });

  let pendingId = null;

  test('a receiver that answers 500 leaves the delivery pending, and the Log says so', async () => {
    const { made, entry } = await runningGame(key, 51, 52);
    await arrived(made.id, 'tournament.started');
    receiver.statuses.push(500);
    const hit = receiver.next();
    bust(entry, 'gn_52');
    await hit;
    let deliveries = null;
    for (let i = 0; i < 50; i++) {
      deliveries = (await get(made.id, key)).body.data.webhook.deliveries;
      if (deliveries.lastError) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    // Two of them: busting one of two people finishes the game, and the
    // finish waits its turn behind the bust-out that could not be delivered.
    expect(deliveries).toEqual({
      pending: 2,
      delivered: 1,
      abandoned: 0,
      lastError: 'answered 500',
    });
    pendingId = made.id;

    const boss = await adminSocket();
    const rows = await ask(boss, 'adminLog', {}, 'adminLogRows');
    const text = JSON.stringify(rows);
    expect(text).toContain('webhook_failed');
    expect(text).toContain('player.eliminated for Hooked 51');
    expect(text).toContain('trying again in 1 minute');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('/hooks/finaltable');
  });

  test('what is owed survives a restart, after the game itself is gone', async () => {
    await shutdown();
    await boot();
    // A finished game is not kept across a restart; what is owed for it is.
    expect((await get(pendingId, key)).status).toBe(404);
    expect(serverModule.webhooks.status(pendingId)).toEqual({
      pending: 2,
      delivered: 1,
      abandoned: 0,
      lastError: 'answered 500',
    });
  });

  test('the clock is held and let go from GameNight, and the receiver hears both', async () => {
    const { made, entry } = await runningGame(key, 61, 62);
    await arrived(made.id, 'tournament.started');
    const held = await control(made.id, 'pause', null, key);
    expect(held.status).toBe(200);
    expect(held.body.data).toMatchObject({ paused: true, awayHeld: false });
    expect(typeof held.body.data.nextLevelIn).toBe('number');
    await arrived(made.id, 'tournament.paused');
    expect(await control(made.id, 'pause', null, key)).toMatchObject({
      status: 409,
      body: { ok: false, error: 'Already paused' },
    });
    const going = await control(made.id, 'resume', null, key);
    expect(going.status).toBe(200);
    expect(going.body.data.paused).toBe(false);
    await arrived(made.id, 'tournament.resumed');
    entry.director.holdField();
    expect(await control(made.id, 'resume', null, key)).toMatchObject({
      status: 409,
      body: { error: 'Not paused' },
    });
  });

  test("a move is refused in the director's words, and a player can be taken out of play", async () => {
    const { made, entry, guest } = await runningGame(key, 71, 72);
    await arrived(made.id, 'tournament.started');
    expect(await control(made.id, 'move', { user_id: 72, table: 2 }, key)).toMatchObject({
      status: 409,
      body: { error: 'There is no table 2' },
    });
    expect(await control(made.id, 'move', { user_id: 72, table: 0 }, key)).toMatchObject({
      status: 400,
      body: { error: 'table must be a table number.' },
    });
    expect(await control(made.id, 'move', { user_id: 'x', table: 1 }, key)).toMatchObject({
      status: 400,
      body: { error: expect.stringMatching(/numeric user id/) },
    });
    expect(await control(made.id, 'remove', { user_id: 71 }, key)).toMatchObject({
      status: 409,
      body: { error: 'The host cannot be removed; cancel the game instead' },
    });
    const left = new Promise((res) => guest.once('leftTournament', res));
    const gone = await control(made.id, 'remove', { user_id: 72 }, key);
    expect(gone.status).toBe(200);
    expect(gone.body.data.remove).toEqual({ removed: true, queued: false, place: 2 });
    expect((await left).reason).toBe('removed');
    const out = await arrived(made.id, 'player.eliminated');
    expect(out.json).toMatchObject({ player: { user_id: '72' }, how: 'removed', place: 2 });
    expect(entry.registrations.has('gn_72')).toBe(false);
  });

  test('a game is called off from GameNight, and says so', async () => {
    const { made } = await runningGame(key, 81, 82);
    await arrived(made.id, 'tournament.started');
    const off = await control(made.id, 'cancel', null, key);
    expect(off.status).toBe(200);
    expect(off.body.data).toMatchObject({
      id: made.id,
      status: 'cancelled',
      reason: 'cancelled by GameNight',
    });
    const told = await arrived(made.id, 'tournament.cancelled');
    expect(told.json).toMatchObject({ outcome: 'cancelled', reason: 'cancelled by GameNight' });
    expect((await get(made.id, key)).status).toBe(404);
    expect(await control(made.id, 'pause', null, key)).toMatchObject({ status: 404 });
    const boss = await adminSocket();
    const rows = await ask(boss, 'adminLog', {}, 'adminLogRows');
    expect(JSON.stringify(rows)).toContain('was cancelled by GameNight');
  });

  test('a game is started before its time from GameNight', async () => {
    const { made, entry } = await runningGame(key, 91, 92, { startsAt: Date.now() + 3600000 });
    expect(entry.status).toBe('registering');
    const began = await control(made.id, 'start', null, key);
    expect(began.status).toBe(200);
    expect(began.body.data.status).toBe('running');
    entry.director.holdField();
    await arrived(made.id, 'tournament.started');
    expect(await control(made.id, 'start', null, key)).toMatchObject({
      status: 409,
      body: { error: 'Already started' },
    });
  });

  test('a player is signed out everywhere from GameNight', async () => {
    const { guest, guestToken } = await runningGame(key, 101, 102);
    const ended = new Promise((res) => guest.once('sessionEnded', res));
    const r = await signOut(102, key);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ uid: 'gn_102', user_id: '102', name: 'Guest102', devices: 1 });
    expect((await ended).mine).toBe(false);
    expect(serverModule.identity.verify(guestToken)).toBeNull();
    expect(await signOut(999999, key)).toMatchObject({
      status: 404,
      body: { error: 'No GameNight player by that id here.' },
    });
    expect(await signOut('abc', key)).toMatchObject({ status: 400 });
  });

  test('none of it without the key', async () => {
    for (const verb of ['cancel', 'start', 'pause', 'resume']) {
      expect(await control('t_x', verb, null, null)).toMatchObject({
        status: 401,
        body: { ok: false },
      });
    }
    expect(await control('t_x', 'remove', { user_id: 1 }, null)).toMatchObject({ status: 401 });
    expect(await control('t_x', 'move', { user_id: 1, table: 1 }, null)).toMatchObject({
      status: 401,
    });
    expect(await signOut(1, null)).toMatchObject({ status: 401 });
  });
});

// __tests__/webhooks.test.js - the outbox, and how hard it tries.
//
// Three things matter more than the rest. A delivery is written down before
// it is sent, so a receiver never holds a delivery this server has no record
// of. The schedule is the schedule: a minute, five, thirty, two hours, six,
// twelve, and then it is given up on loudly. And the secret is in every row
// and in no log line.
const crypto = require('crypto');
const { createWebhooks, sign, BACKOFF_MS } = require('../server/webhooks');
const { createSettingsStore } = require('../server/settings-store');
const { createMemoryDatabase } = require('../server/db');

// Timers that never fire on their own: every sweep here is called by hand,
// and the abort timer is captured so a test can pull it.
function makeTimers() {
  const timers = {
    aborts: [],
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    setTimeout: (fn, ms) => {
      if (ms > 0) timers.aborts.push(fn);
      return { unref() {} };
    },
    clearTimeout: () => {},
  };
  return timers;
}

// A receiver that records what it was sent and answers a queue of statuses.
function makeFetch(statuses = []) {
  const calls = [];
  const fetchImpl = jest.fn(async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body, init });
    const status = statuses.length ? statuses.shift() : 200;
    if (status === 'hang') {
      return new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          rej(err);
        });
      });
    }
    if (status instanceof Error) throw status;
    return { ok: status >= 200 && status < 300, status };
  });
  return { fetchImpl, calls, statuses };
}

const SECRET = 'correct-horse-battery-staple';

describe('the webhook outbox', () => {
  let db;
  let t;
  let entries;
  let n = 0;
  const now = () => t;
  const log = (e) => entries.push(e);
  const entry = (over = {}) => ({
    id: 't_one',
    name: 'Thursday',
    webhook: { url: 'https://gamenight.test/hooks/finaltable', secret: SECRET, externalId: 'ev_1' },
    ...over,
  });

  beforeEach(() => {
    db = createMemoryDatabase({ database: `webhooks-${n++}` });
    db.reset();
    t = 1_000_000;
    entries = [];
  });

  const make = (over = {}) =>
    createWebhooks({ db, log, now, timers: makeTimers(), version: '9.9.9', sweepMs: 0, ...over });

  const seen = (event) => entries.filter((e) => e.event === event);

  test('a delivery is written down before it is sent, and sent with its signature', async () => {
    const { fetchImpl, calls } = makeFetch();
    let countedAtSend = null;
    fetchImpl.mockImplementationOnce(async (url, init) => {
      countedAtSend = await db.webhooks.count();
      calls.push({ url, headers: init.headers, body: init.body, init });
      return { ok: true, status: 200 };
    });
    const hooks = make({ fetchImpl });
    const id = hooks.enqueue({ entry: entry(), event: 'player.eliminated', payload: { place: 4 } });
    expect(id).toBe(1);
    // Not yet written, so not yet sent.
    await hooks.sweep();
    expect(calls).toHaveLength(0);
    await hooks.flush();
    await hooks.sweep();
    expect(calls).toHaveLength(1);
    expect(countedAtSend).toBe(1);

    const sent = calls[0];
    expect(sent.url).toBe('https://gamenight.test/hooks/finaltable');
    expect(sent.init.method).toBe('POST');
    expect(sent.init.redirect).toBe('manual');
    const body = JSON.parse(sent.body);
    expect(body).toEqual({
      event: 'player.eliminated',
      delivery_id: 1,
      sent_at: t,
      game: { id: 't_one', name: 'Thursday', external_id: 'ev_1' },
      place: 4,
    });
    expect(sent.headers['Content-Type']).toBe('application/json');
    expect(sent.headers['User-Agent']).toBe('FinalTable/9.9.9');
    expect(sent.headers['X-FinalTable-Event']).toBe('player.eliminated');
    expect(sent.headers['X-FinalTable-Delivery']).toBe('1');
    expect(sent.headers['X-FinalTable-Timestamp']).toBe(String(t));
    const want = crypto
      .createHmac('sha256', SECRET)
      .update(`${sent.headers['X-FinalTable-Timestamp']}.${sent.body}`)
      .digest('hex');
    expect(sent.headers['X-FinalTable-Signature']).toBe(`sha256=${want}`);
    expect(sign(SECRET, t, sent.body)).toBe(want);

    expect(hooks.status('t_one')).toEqual({
      pending: 0,
      delivered: 1,
      abandoned: 0,
      lastError: null,
    });
    expect(seen('webhook_delivered')).toHaveLength(1);
    // Written down as delivered.
    const stored = (await db.webhooks.all())[0];
    expect(stored.deliveredAt).toBe(t);
    expect(stored.secret).toBe(SECRET);
  });

  test('a failure follows the schedule, is said once, and is given up on the seventh time', async () => {
    const { fetchImpl, calls, statuses } = makeFetch([500, 500, 500, 500, 500, 500, 500, 500]);
    const hooks = make({ fetchImpl });
    hooks.enqueue({ entry: entry(), event: 'tournament.completed', payload: {} });
    await hooks.flush();
    await hooks.sweep();
    expect(calls).toHaveLength(1);
    expect(hooks.status('t_one')).toMatchObject({ pending: 1, lastError: 'answered 500' });
    const first = seen('webhook_failed');
    expect(first).toHaveLength(1);
    expect(first[0].level).toBe('warn');
    expect(first[0].data.detail).toBe(
      'tournament.completed for Thursday: answered 500; trying again in 1 minute'
    );
    // Not due yet: nothing goes.
    await hooks.sweep();
    expect(calls).toHaveLength(1);
    // Due at each step of the schedule, and no earlier.
    for (let i = 0; i < BACKOFF_MS.length; i++) {
      t += BACKOFF_MS[i] - 1;
      await hooks.sweep();
      expect(calls).toHaveLength(i + 1);
      t += 1;
      await hooks.sweep();
      expect(calls).toHaveLength(i + 2);
    }
    // Seven tries in all, the last one the end of it.
    expect(calls).toHaveLength(7);
    expect(hooks.status('t_one')).toMatchObject({ pending: 0, abandoned: 1 });
    const gaveUp = seen('webhook_abandoned');
    expect(gaveUp).toHaveLength(1);
    expect(gaveUp[0].level).toBe('error');
    expect(gaveUp[0].data.detail).toBe(
      'tournament.completed for Thursday after 7 tries: answered 500'
    );
    // The retries were the server's business: one warn, the rest info.
    expect(seen('webhook_failed').map((e) => e.level)).toEqual([
      'warn',
      'info',
      'info',
      'info',
      'info',
      'info',
    ]);
    t += 10 * 24 * 60 * 60 * 1000;
    await hooks.sweep();
    expect(calls).toHaveLength(7);
    expect(statuses).toHaveLength(1);
  });

  test("a game's rows go in order, and a row given up on releases the next", async () => {
    const { fetchImpl, calls } = makeFetch([500, 200, 200]);
    const hooks = make({ fetchImpl });
    hooks.enqueue({ entry: entry(), event: 'player.eliminated', payload: { place: 3 } });
    hooks.enqueue({ entry: entry(), event: 'tournament.completed', payload: {} });
    hooks.enqueue({
      entry: entry({ id: 't_two', name: 'Friday' }),
      event: 'player.eliminated',
      payload: {},
    });
    await hooks.flush();
    await hooks.sweep();
    // The first game's head failed; its second row waits; the other game went.
    expect(calls.map((c) => JSON.parse(c.body).game.id)).toEqual(['t_one', 't_two']);
    expect(hooks.status('t_one')).toMatchObject({ pending: 2 });
    t += BACKOFF_MS[0];
    await hooks.sweep();
    expect(calls.map((c) => JSON.parse(c.body).delivery_id)).toEqual([1, 3, 1]);
    await hooks.sweep();
    expect(calls.map((c) => JSON.parse(c.body).delivery_id)).toEqual([1, 3, 1, 2]);
    expect(hooks.status('t_one')).toEqual({
      pending: 0,
      delivered: 2,
      abandoned: 0,
      lastError: null,
    });
  });

  test('a redirect is a failure, and so is no answer in time', async () => {
    const { fetchImpl } = makeFetch([302, 'hang']);
    const timers = makeTimers();
    const hooks = make({ fetchImpl, timers, timeoutMs: 8000 });
    hooks.enqueue({ entry: entry(), event: 'player.eliminated', payload: {} });
    await hooks.flush();
    await hooks.sweep();
    expect(hooks.status('t_one').lastError).toBe('answered 302');
    t += BACKOFF_MS[0];
    const pass = hooks.sweep();
    // The abort timer is the one the sender set; pulling it is the timeout.
    timers.aborts[timers.aborts.length - 1]();
    await pass;
    expect(hooks.status('t_one').lastError).toBe('no answer in 8 s');
  });

  test('what is owed survives a restart, and the ids carry on', async () => {
    const { fetchImpl } = makeFetch([500]);
    const first = make({ fetchImpl });
    first.enqueue({ entry: entry(), event: 'player.eliminated', payload: { place: 2 } });
    await first.flush();
    await first.sweep();
    await first.stop();

    const receiver = makeFetch([200]);
    const second = make({ fetchImpl: receiver.fetchImpl });
    expect(await second.load()).toBe(1);
    expect(second.status('t_one')).toMatchObject({ pending: 1, lastError: 'answered 500' });
    t += BACKOFF_MS[0];
    await second.sweep();
    expect(receiver.calls).toHaveLength(1);
    expect(JSON.parse(receiver.calls[0].body)).toMatchObject({ delivery_id: 1, place: 2 });
    expect(second.enqueue({ entry: entry(), event: 'tournament.completed', payload: {} })).toBe(2);
  });

  test('an id is never handed out twice, even after the rows it came from are gone', async () => {
    // A store that survives the restart, the way the settings table does.
    const kept = new Map();
    const settingsStore = {
      get: (k) => (kept.has(k) ? kept.get(k) : null),
      set: (k, v) => kept.set(k, v),
    };

    const first = make({ fetchImpl: makeFetch([200, 200]).fetchImpl, settingsStore });
    await first.load();
    expect(first.enqueue({ entry: entry(), event: 'player.eliminated', payload: {} })).toBe(1);
    expect(first.enqueue({ entry: entry(), event: 'tournament.completed', payload: {} })).toBe(2);
    await first.flush();
    // One sweep sends one row per game: a game's second event waits for its
    // first, which is the ordering the ids are for.
    await first.sweep();
    await first.sweep();
    await first.stop();

    // A week later the prune takes both, so the table has nothing to count
    // from - which is where the ids used to start again at 1 and a receiver
    // deduping on delivery_id dropped a real event as a repeat.
    await db.webhooks.prune({ olderThan: Number.MAX_SAFE_INTEGER });
    expect(await db.webhooks.count()).toBe(0);

    const second = make({ fetchImpl: makeFetch([200]).fetchImpl, settingsStore });
    expect(await second.load()).toBe(0);
    const next = second.enqueue({ entry: entry(), event: 'player.eliminated', payload: {} });
    expect(next).toBeGreaterThan(2);

    // And the same again: the ceiling is written down, not merely held.
    await second.flush();
    await second.stop();
    await db.webhooks.prune({ olderThan: Number.MAX_SAFE_INTEGER });
    const third = make({ fetchImpl: makeFetch([200]).fetchImpl, settingsStore });
    await third.load();
    expect(
      third.enqueue({ entry: entry(), event: 'player.eliminated', payload: {} })
    ).toBeGreaterThan(next);
  });

  test('without a store to remember, the ids still climb within a run', async () => {
    const hooks = make({ fetchImpl: makeFetch([200, 200]).fetchImpl });
    await hooks.load();
    expect(hooks.enqueue({ entry: entry(), event: 'a', payload: {} })).toBe(1);
    expect(hooks.enqueue({ entry: entry(), event: 'b', payload: {} })).toBe(2);
  });

  test('delivered rows are kept a week and then let go', async () => {
    const { fetchImpl } = makeFetch([200, 200]);
    const hooks = make({ fetchImpl });
    hooks.enqueue({ entry: entry(), event: 'player.eliminated', payload: {} });
    await hooks.flush();
    await hooks.sweep();
    t += 8 * 24 * 60 * 60 * 1000;
    hooks.enqueue({ entry: entry(), event: 'tournament.completed', payload: {} });
    await hooks.flush();
    hooks.prune();
    await new Promise((r) => setImmediate(r));
    expect(hooks.status('t_one')).toMatchObject({ delivered: 0, pending: 1 });
    expect(await db.webhooks.count()).toBe(1);
  });

  test('with no database it still sends, and with no address it sends nothing', async () => {
    const { fetchImpl, calls } = makeFetch();
    const hooks = createWebhooks({ log, now, timers: makeTimers(), fetchImpl, sweepMs: 0 });
    expect(await hooks.load()).toBe(0);
    expect(hooks.enqueue({ entry: entry({ webhook: null }), event: 'x', payload: {} })).toBeNull();
    hooks.enqueue({ entry: entry(), event: 'player.eliminated', payload: {} });
    await hooks.sweep();
    expect(calls).toHaveLength(1);
    await hooks.flush();
    await hooks.stop();
  });

  test('a heartbeat is tried once, written nowhere, and counted nowhere', async () => {
    const { fetchImpl, calls } = makeFetch([200, 500]);
    const hooks = make({ fetchImpl });
    const id = hooks.enqueue({
      entry: entry(),
      event: 'tournament.heartbeat',
      payload: { status: 'running' },
      transient: true,
    });
    expect(id).toBe(1);
    expect(await db.webhooks.count()).toBe(0);
    // Sendable at once, with no write to wait for.
    await hooks.sweep();
    expect(calls).toHaveLength(1);
    const sent = calls[0];
    const body = JSON.parse(sent.body);
    expect(body).toMatchObject({
      event: 'tournament.heartbeat',
      delivery_id: null,
      status: 'running',
    });
    expect(sent.headers['X-FinalTable-Delivery']).toBe('heartbeat');
    expect(sent.headers['X-FinalTable-Signature']).toBe(
      `sha256=${sign(SECRET, Number(sent.headers['X-FinalTable-Timestamp']), sent.body)}`
    );
    expect(hooks.status('t_one')).toEqual({
      pending: 0,
      delivered: 0,
      abandoned: 0,
      lastError: null,
    });
    expect(await db.webhooks.count()).toBe(0);

    // One that is not answered is let go of quietly, and not tried again.
    hooks.enqueue({ entry: entry(), event: 'tournament.heartbeat', payload: {}, transient: true });
    await hooks.sweep();
    expect(calls).toHaveLength(2);
    expect(seen('webhook_failed')).toHaveLength(0);
    expect(seen('webhook_abandoned')).toHaveLength(0);
    expect(seen('webhook_heartbeat_failed')).toHaveLength(1);
    expect(seen('webhook_heartbeat_failed')[0].level).toBe('info');
    t += 24 * 60 * 60 * 1000;
    await hooks.sweep();
    expect(calls).toHaveLength(2);
    expect(hooks.status('t_one').lastError).toBeNull();

    // And not made at all while a real delivery is waiting its turn.
    hooks.enqueue({ entry: entry(), event: 'player.eliminated', payload: { place: 3 } });
    expect(
      hooks.enqueue({ entry: entry(), event: 'tournament.heartbeat', payload: {}, transient: true })
    ).toBeNull();
    await hooks.flush();
    await hooks.sweep();
    expect(calls).toHaveLength(3);
    expect(JSON.parse(calls[2].body).event).toBe('player.eliminated');
  });

  test('the secret is in every row and in no log line', async () => {
    const { fetchImpl } = makeFetch([500, new Error('connect ECONNREFUSED https://u:p@host/x')]);
    const hooks = make({ fetchImpl });
    hooks.enqueue({ entry: entry(), event: 'player.eliminated', payload: {} });
    await hooks.flush();
    await hooks.sweep();
    t += BACKOFF_MS[0];
    await hooks.sweep();
    const text = JSON.stringify(entries);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('u:p@');
    expect(text).not.toContain('gamenight.test');
    expect((await db.webhooks.all())[0].secret).toBe(SECRET);
    // A settings store beside it is untouched by any of this.
    expect(createSettingsStore({ db }).size).toBe(0);
  });
});

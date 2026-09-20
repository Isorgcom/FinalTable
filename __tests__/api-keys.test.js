// __tests__/api-keys.test.js - the key GameNight presents to make a game.
//
// Two things matter more than the rest. The digest must never come back out
// through status(), because that answer goes to a browser; and the raw key
// must be handed out exactly once, at the moment it is made.
const { createApiKeys } = require('../server/api-keys');
const { createSettingsStore } = require('../server/settings-store');
const { createMemoryDatabase } = require('../server/db');

describe('the API key', () => {
  let db;
  let store;
  let n = 0;

  beforeEach(() => {
    db = createMemoryDatabase({ database: `api-keys-${n++}` });
    db.reset();
    store = createSettingsStore({ db });
  });

  const make = (over = {}) => createApiKeys({ settingsStore: store, ...over });

  test('with no key set, nothing verifies and the status says so', () => {
    const keys = make();
    expect(keys.status()).toEqual({ set: false, createdAt: null, lastUsedAt: null });
    expect(keys.verify('anything')).toEqual({ ok: false, reason: 'unset' });
    expect(keys.verify('')).toEqual({ ok: false, reason: 'unset' });
  });

  test('a key is made once, verifies, and never appears in the status', () => {
    let clock = 1_000_000;
    const keys = make({ now: () => clock });
    const { key, replaced } = keys.make();
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(replaced).toBe(false);
    const status = keys.status();
    expect(status).toEqual({ set: true, createdAt: 1_000_000, lastUsedAt: null });
    expect(Object.keys(status)).not.toContain('digest');
    expect(JSON.stringify(store.get('api'))).not.toContain(key);
    expect(keys.verify(key)).toEqual({ ok: true });
    expect(keys.verify(key.slice(0, -1) + 'x')).toEqual({ ok: false, reason: 'mismatch' });
    expect(keys.verify('')).toEqual({ ok: false, reason: 'mismatch' });
    // Verified, so used - and written down once, not on every call.
    clock += 10;
    expect(keys.verify(key).ok).toBe(true);
    expect(keys.status().lastUsedAt).toBe(1_000_010);
  });

  test('making another replaces the first; revoking leaves none', () => {
    const keys = make();
    const first = keys.make().key;
    const second = keys.make();
    expect(second.replaced).toBe(true);
    expect(keys.verify(first).reason).toBe('mismatch');
    expect(keys.verify(second.key).ok).toBe(true);
    expect(keys.revoke()).toBe(true);
    expect(keys.status().set).toBe(false);
    expect(keys.verify(second.key).reason).toBe('unset');
    expect(keys.revoke()).toBe(false);
  });

  test('the record outlives the module: a second store reads it back', async () => {
    const key = make().make().key;
    await store.saved();
    const fresh = createSettingsStore({ db });
    await fresh.load();
    const again = createApiKeys({ settingsStore: fresh });
    expect(again.status().set).toBe(true);
    expect(again.verify(key).ok).toBe(true);
  });

  test('the guard answers 401 in the envelope and says why once', () => {
    const entries = [];
    const keys = make({ log: (e) => entries.push(e) });
    const res = () => {
      const out = { statusCode: 0, body: null };
      out.status = (code) => ((out.statusCode = code), out);
      out.json = (body) => ((out.body = body), out);
      return out;
    };
    const req = (header) => ({ get: () => header, ip: '10.0.0.7' });
    let next = 0;

    let r = res();
    keys.guard(req(''), r, () => next++);
    expect(r.statusCode).toBe(401);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toMatch(/no API key/);
    expect(next).toBe(0);

    const key = keys.make().key;
    r = res();
    keys.guard(req('Bearer nope'), r, () => next++);
    expect(r.statusCode).toBe(401);
    expect(r.body.error).toMatch(/missing or wrong/);
    expect(entries.filter((e) => e.event === 'api_refused')).toHaveLength(2);
    expect(JSON.stringify(entries)).not.toContain('nope');
    expect(entries[1].data.ip).toBe('10.0.0.7');

    r = res();
    keys.guard(req(`Bearer ${key}`), r, () => next++);
    expect(next).toBe(1);
    expect(r.statusCode).toBe(0);
  });
});

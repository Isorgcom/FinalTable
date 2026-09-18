// __tests__/chat-store.test.js - chat that outlives the process.
const { createChatStore } = require('../server/chat-store');
const { createMemoryDatabase } = require('../server/db');

describe('chat store', () => {
  let db;
  let n = 0;

  beforeEach(() => {
    db = createMemoryDatabase({ database: `chat-${n++}` });
    db.reset();
  });

  const rooms = (text) => ({ 't_1:t1': [{ id: 'c_1', seq: 1, text, uid: 'ann', name: 'Ann' }] });
  const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

  test('without a database every call is a no-op', async () => {
    const store = createChatStore({});
    expect(() => store.record('t_1', rooms('hi'))).not.toThrow();
    await expect(store.flush()).resolves.toBeUndefined();
    expect(() => store.remove('t_1')).not.toThrow();
    // Held in memory for as long as the process lives, which is all a server
    // with nowhere to write can offer.
    expect(store.load('t_1')).toBeNull();
  });

  test('a recorded snapshot comes back after a restart', async () => {
    const store = createChatStore({ db });
    store.record('t_1', rooms('before the restart'));
    await store.flush();

    const back = createChatStore({ db });
    await back.loadAll();
    expect(back.load('t_1')['t_1:t1'][0].text).toBe('before the restart');
  });

  test('the last snapshot wins, so what is kept cannot grow past the ring', async () => {
    const store = createChatStore({ db });
    for (let i = 0; i < 50; i++) store.record('t_1', rooms('message ' + i));
    await store.flush();

    const back = createChatStore({ db });
    await back.loadAll();
    const kept = back.load('t_1')['t_1:t1'];
    expect(kept).toHaveLength(1);
    expect(kept[0].text).toBe('message 49');
  });

  test('a burst of records collapses into one write, and none of it is lost', async () => {
    const store = createChatStore({ db, flushDebounceMs: 5 });
    for (let i = 0; i < 40; i++) store.record('t_' + (i % 4), rooms('m' + i));
    await settle(120);

    const reader = createChatStore({ db });
    await reader.loadAll();
    expect(reader.listIds().sort()).toEqual(['t_0', 't_1', 't_2', 't_3']);
    for (const id of reader.listIds()) expect(reader.load(id)).toBeTruthy();
  });

  test('chat nobody kept reads as absent rather than throwing', async () => {
    const store = createChatStore({ db });
    await store.loadAll();
    expect(store.load('never-existed')).toBeNull();
  });

  test('removing is idempotent, and listIds sees what is there', async () => {
    const store = createChatStore({ db });
    store.record('t_1', rooms('x'));
    store.record('t_2', rooms('y'));
    await store.flush();
    expect(store.listIds().sort()).toEqual(['t_1', 't_2']);
    store.remove('t_1');
    expect(store.listIds()).toEqual(['t_2']);
    expect(() => store.remove('t_1')).not.toThrow();
    expect(() => store.remove('never-existed')).not.toThrow();

    // And it is gone from what a restart would read, not just from here.
    await store.flush();
    const back = createChatStore({ db });
    await back.loadAll();
    expect(back.listIds()).toEqual(['t_2']);
  });

  test('a pending record is dropped when its tournament is removed', async () => {
    const store = createChatStore({ db, flushDebounceMs: 10000 });
    store.record('t_1', rooms('never wanted'));
    store.remove('t_1');
    await store.flush();
    expect(store.listIds()).toEqual([]);

    const back = createChatStore({ db });
    expect(await back.loadAll()).toBe(0);
  });

  // It used to be one file per tournament, named after the id, which is why
  // this test existed. There is no filename any more - the id is a value in a
  // placeholder - but an id that tries it should still be unremarkable.
  test('an id that used to be dangerous as a filename is just an id', async () => {
    const store = createChatStore({ db });
    store.record('../../escaped', rooms('nope'));
    await store.flush();

    const back = createChatStore({ db });
    await back.loadAll();
    expect(back.listIds()).toEqual(['../../escaped']);
    expect(back.load('../../escaped')).toBeTruthy();
  });
});

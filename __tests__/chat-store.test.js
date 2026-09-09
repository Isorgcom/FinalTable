// __tests__/chat-store.test.js - chat that outlives the process.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChatStore } = require('../server/chat-store');

describe('chat store', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-chat-store-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const rooms = (text) => ({ 't_1:t1': [{ id: 'c_1', seq: 1, text, uid: 'ann', name: 'Ann' }] });

  test('without a directory every call is a no-op', () => {
    const store = createChatStore({});
    expect(() => store.record('t_1', rooms('hi'))).not.toThrow();
    expect(() => store.flush()).not.toThrow();
    expect(() => store.remove('t_1')).not.toThrow();
    expect(store.load('t_1')).toBeNull();
    expect(store.listIds()).toEqual([]);
  });

  test('a recorded snapshot comes back', () => {
    const store = createChatStore({ saveDir: dir });
    store.record('t_1', rooms('before the restart'));
    store.flush();
    const back = createChatStore({ saveDir: dir }).load('t_1');
    expect(back['t_1:t1'][0].text).toBe('before the restart');
  });

  test('the last snapshot wins, so the file cannot grow past the ring', () => {
    const store = createChatStore({ saveDir: dir });
    for (let i = 0; i < 50; i++) store.record('t_1', rooms('message ' + i));
    store.flush();
    const back = createChatStore({ saveDir: dir }).load('t_1');
    expect(back['t_1:t1']).toHaveLength(1);
    expect(back['t_1:t1'][0].text).toBe('message 49');
  });

  test('a burst of records collapses into one write, and none of it is lost', async () => {
    const store = createChatStore({ saveDir: dir, flushDebounceMs: 5 });
    for (let i = 0; i < 40; i++) store.record('t_' + (i % 4), rooms('m' + i));
    await new Promise((r) => setTimeout(r, 120));
    const reader = createChatStore({ saveDir: dir });
    expect(reader.listIds().sort()).toEqual(['t_0', 't_1', 't_2', 't_3']);
    // Whichever write landed last for each id, it is a whole parseable file -
    // which is what a half-finished write would break.
    for (const id of reader.listIds()) expect(reader.load(id)).toBeTruthy();
  });

  test('a corrupt or missing file reads as absent rather than throwing', () => {
    const store = createChatStore({ saveDir: dir });
    expect(store.load('never-existed')).toBeNull();
    fs.mkdirSync(path.join(dir, 'chat'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'chat', 't_bad.json'), '{ not json');
    expect(store.load('t_bad')).toBeNull();
    fs.writeFileSync(path.join(dir, 'chat', 't_empty.json'), '{"version":1}');
    expect(store.load('t_empty')).toBeNull();
  });

  test('removing is idempotent, and listIds sees what is there', () => {
    const store = createChatStore({ saveDir: dir });
    store.record('t_1', rooms('x'));
    store.record('t_2', rooms('y'));
    store.flush();
    expect(store.listIds().sort()).toEqual(['t_1', 't_2']);
    store.remove('t_1');
    expect(store.listIds()).toEqual(['t_2']);
    expect(() => store.remove('t_1')).not.toThrow();
    expect(() => store.remove('never-existed')).not.toThrow();
  });

  test('a pending record is dropped when its tournament is removed', () => {
    const store = createChatStore({ saveDir: dir, flushDebounceMs: 10000 });
    store.record('t_1', rooms('never wanted'));
    store.remove('t_1');
    store.flush();
    expect(store.listIds()).toEqual([]);
  });

  test('an id that is not a plain filename cannot escape the directory', () => {
    const store = createChatStore({ saveDir: dir });
    store.record('../../escaped', rooms('nope'));
    store.flush();
    expect(fs.existsSync(path.join(dir, 'chat'))).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(['chat']);
    expect(store.listIds()).toEqual(['../../escaped']);
  });
});

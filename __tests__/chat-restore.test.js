// __tests__/chat-restore.test.js - chat across a restart.
//
// The registry suite runs without a chat store, so this is the only place the
// two halves meet: rooms keyed by table number in memory, a document in the
// database, and a second registry that has to find the first one's
// conversation under the same key.
const { createTournamentRegistry } = require('../server/tournament-registry');
const { createChatStore } = require('../server/chat-store');
const { createTournamentStore } = require('../server/tournament-store');
const { createMemoryDatabase } = require('../server/db');

function makeIo() {
  const sent = [];
  return {
    sent,
    emit: (event, payload) => sent.push({ to: '*', event, payload }),
    to: (target) => ({ emit: (event, payload) => sent.push({ to: target, event, payload }) }),
  };
}

const names = { h: 'Host', g: 'Guest' };
const identity = {
  get: (uid) => (names[uid] ? { uid, name: names[uid], avatar: '🙂' } : null),
  expireIdle: () => 0,
};

function makeSocket(id, uid) {
  return { id, data: uid ? { uid } : {}, emitted: [], emit: () => {} };
}

describe('chat across a restart', () => {
  let db;
  let n = 0;

  beforeEach(() => {
    db = createMemoryDatabase({ database: `chat-restore-${n++}` });
    db.reset();
  });

  // A registry with its stores already read, the way the server does it: both
  // are loaded before anything listens, so restore() can stay synchronous.
  async function boot(io) {
    const store = createTournamentStore({ db });
    const chatStore = createChatStore({ db });
    await store.load();
    await chatStore.loadAll();
    const reg = createTournamentRegistry({
      io,
      identity,
      sweepMs: 100000,
      store,
      chatStore,
      tableOptions: { actionTimeoutMs: 0 },
    });
    reg.stores = { store, chatStore };
    return reg;
  }

  test('what was said before the restart is there after it', async () => {
    const io = makeIo();
    const first = await boot(io);
    const host = makeSocket('sh', 'h');
    const { entry } = first.create('h', { name: 'Restarted', startsAt: Date.now() + 60000 }, host);
    first.join('g', { code: entry.code }, makeSocket('sg', 'g'));
    first.postChat(entry, 'h', 'see you after the reboot', host);
    const room = `${entry.id}:lobby`;
    expect(first.chat.history(room)).toHaveLength(1);
    // The chat store writes on its own debounce; the shutdown path drains it.
    await first.flush();
    first.stop();
    expect(await db.chat.all()).toHaveLength(1);

    // The process comes back.
    const second = await boot(makeIo());
    expect(second.restore()).toBe(1);
    const back = second.tournaments.get(entry.id);
    expect(back).toBeTruthy();
    expect(second.chat.history(room).map((m) => m.text)).toEqual(['see you after the reboot']);
    second.stop();
  });

  test('a message after the restart cannot look like one from before it', async () => {
    const first = await boot(makeIo());
    const host = makeSocket('sh', 'h');
    const { entry } = first.create('h', { name: 'Seqs', startsAt: Date.now() + 60000 }, host);
    const before = first.postChat(entry, 'h', 'one', host).message;
    await first.flush();
    first.stop();

    const second = await boot(makeIo());
    second.restore();
    const back = second.tournaments.get(entry.id);
    const after = second.postChat(back, 'h', 'two', makeSocket('sh2', 'h')).message;
    // A client that was connected across the restart still holds the old
    // watermark. Reusing a sequence number would make this new message look
    // like a replay and it would never be drawn.
    expect(after.seq).toBeGreaterThan(before.seq);
    second.stop();
  });

  test('chat whose tournament did not come back is swept up', async () => {
    const first = await boot(makeIo());
    const host = makeSocket('sh', 'h');
    const { entry } = first.create('h', { name: 'Orphan', startsAt: Date.now() + 60000 }, host);
    first.postChat(entry, 'h', 'nobody will read this', host);
    await first.flush();
    first.stop();

    // The tournament is forgotten, as it would be had it finished while the
    // process was down; its chat is left behind.
    await db.tournaments.replaceAll([]);
    expect(await db.chat.all()).toHaveLength(1);

    const second = await boot(makeIo());
    expect(second.restore()).toBe(0);
    await second.flush();
    expect(await db.chat.all()).toHaveLength(0);
    second.stop();
  });

  test('chat comes back even when the field is held by the restore guard', async () => {
    const io = makeIo();
    const first = await boot(io);
    const host = makeSocket('sh', 'h');
    const { entry } = first.create('h', { name: 'Held', startsAt: Date.now() + 60000 }, host);
    first.join('g', { code: entry.code }, makeSocket('sg', 'g'));
    first.postChat(entry, 'h', 'what happened here', host);
    const room = `${entry.id}:lobby`;
    await first.flush();
    first.stop();

    // Rewrite the record as a running field that has already exhausted its
    // restore attempts, which is the state where restoreFrom is never called.
    const rows = await db.tournaments.all();
    const saved = rows[0].data;
    saved.status = 'running';
    saved.field = { version: 1, tables: [] };
    saved.restoreCount = 99;
    await db.tournaments.replaceAll([{ id: saved.id, status: 'running', data: saved }]);

    const second = await boot(makeIo());
    expect(second.restore()).toBe(1);
    const back = second.tournaments.get(entry.id);
    expect(back.waitingReason).toMatch(/could not be restarted/);
    // The held field is precisely the one somebody is trying to work out, so
    // its chat is the last thing that should have gone missing.
    expect(second.chat.history(room).map((m) => m.text)).toEqual(['what happened here']);
    second.stop();
  });
});

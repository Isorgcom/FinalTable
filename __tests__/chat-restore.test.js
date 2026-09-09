// __tests__/chat-restore.test.js - chat across a restart.
//
// The registry suite runs without a chat store, so this is the only place the
// two halves meet: rooms keyed by table number in memory, a file on disk, and
// a second registry that has to find the first one's conversation under the
// same key.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTournamentRegistry } = require('../server/tournament-registry');
const { createChatStore } = require('../server/chat-store');
const { createTournamentStore } = require('../server/tournament-store');

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
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-chat-restore-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function registry(io) {
    return createTournamentRegistry({
      io,
      identity,
      sweepMs: 100000,
      store: createTournamentStore({ saveDir: dir }),
      chatStore: createChatStore({ saveDir: dir }),
      tableOptions: { actionTimeoutMs: 0 },
    });
  }

  test('what was said before the restart is there after it', () => {
    const io = makeIo();
    const first = registry(io);
    const host = makeSocket('sh', 'h');
    const { entry } = first.create('h', { name: 'Restarted', startsAt: Date.now() + 60000 }, host);
    first.join('g', { code: entry.code }, makeSocket('sg', 'g'));
    first.postChat(entry, 'h', 'see you after the reboot', host);
    const room = `${entry.id}:lobby`;
    expect(first.chat.history(room)).toHaveLength(1);
    first.flush();
    // The chat store writes on its own debounce; the shutdown path drains it.
    first.stop();
    const chatFiles = fs.readdirSync(path.join(dir, 'chat'));
    expect(chatFiles).toHaveLength(1);

    // The process comes back.
    const second = registry(makeIo());
    expect(second.restore()).toBe(1);
    const back = second.tournaments.get(entry.id);
    expect(back).toBeTruthy();
    expect(second.chat.history(room).map((m) => m.text)).toEqual(['see you after the reboot']);
    second.stop();
  });

  test('a message after the restart cannot look like one from before it', () => {
    const first = registry(makeIo());
    const host = makeSocket('sh', 'h');
    const { entry } = first.create('h', { name: 'Seqs', startsAt: Date.now() + 60000 }, host);
    const before = first.postChat(entry, 'h', 'one', host).message;
    first.flush();
    first.stop();

    const second = registry(makeIo());
    second.restore();
    const back = second.tournaments.get(entry.id);
    const after = second.postChat(back, 'h', 'two', makeSocket('sh2', 'h')).message;
    // A client that was connected across the restart still holds the old
    // watermark. Reusing a sequence number would make this new message look
    // like a replay and it would never be drawn.
    expect(after.seq).toBeGreaterThan(before.seq);
    second.stop();
  });

  test('a chat file whose tournament did not come back is swept up', () => {
    const first = registry(makeIo());
    const host = makeSocket('sh', 'h');
    const { entry } = first.create('h', { name: 'Orphan', startsAt: Date.now() + 60000 }, host);
    first.postChat(entry, 'h', 'nobody will read this', host);
    first.flush();
    first.stop();

    // The tournament file is emptied, as it would be had the tournament
    // finished while the process was down; the chat file is left behind.
    fs.writeFileSync(
      path.join(dir, 'tournaments.json'),
      JSON.stringify({ version: 1, tournaments: [] })
    );
    expect(fs.readdirSync(path.join(dir, 'chat'))).toHaveLength(1);

    const second = registry(makeIo());
    expect(second.restore()).toBe(0);
    expect(fs.readdirSync(path.join(dir, 'chat'))).toHaveLength(0);
    second.stop();
  });

  test('chat comes back even when the field is held by the restore guard', () => {
    const io = makeIo();
    const first = registry(io);
    const host = makeSocket('sh', 'h');
    const { entry } = first.create('h', { name: 'Held', startsAt: Date.now() + 60000 }, host);
    first.join('g', { code: entry.code }, makeSocket('sg', 'g'));
    first.postChat(entry, 'h', 'what happened here', host);
    const room = `${entry.id}:lobby`;
    first.flush();
    first.stop();

    // Rewrite the record as a running field that has already exhausted its
    // restore attempts, which is the state where restoreFrom is never called.
    const file = path.join(dir, 'tournaments.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.tournaments[0].status = 'running';
    saved.tournaments[0].field = { version: 1, tables: [] };
    saved.tournaments[0].restoreCount = 99;
    fs.writeFileSync(file, JSON.stringify(saved));

    const second = registry(makeIo());
    expect(second.restore()).toBe(1);
    const back = second.tournaments.get(entry.id);
    expect(back.waitingReason).toMatch(/could not be restarted/);
    // The held field is precisely the one somebody is trying to work out, so
    // its chat is the last thing that should have gone missing.
    expect(second.chat.history(room).map((m) => m.text)).toEqual(['what happened here']);
    second.stop();
  });
});

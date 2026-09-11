// __tests__/chat.test.js - the chat buffers, the sanitiser and the rules
// about who may say what. No sockets and no disk; the registry suite covers
// the wiring and chat-store.test.js covers the file.
const { createChatRooms, sanitizeChat } = require('../server/chat-rooms');

// Written as code points so no invisible character ever sits in this file
// pretending to be nothing.
const cp = (...codes) => String.fromCodePoint(...codes);
const ZWSP = cp(0x200b);
const ZWJ = cp(0x200d);
const RLO = cp(0x202e);
const BOM = cp(0xfeff);
const FAMILY = cp(0x1f468) + ZWJ + cp(0x1f469) + ZWJ + cp(0x1f467);

describe('sanitizeChat', () => {
  test('keeps what a sentence is made of', () => {
    expect(sanitizeChat('nice hand! 50% $100 <3')).toBe('nice hand! 50% $100 <3');
    expect(sanitizeChat(cp(0x1f44d))).toBe(cp(0x1f44d));
  });

  test('keeps the joiners that hold an emoji together', () => {
    // The obvious implementation strips U+200B-U+200F in one range, which
    // takes the zero-width joiner with it and turns one family into three
    // people. U+200C matters the same way in several Indic scripts.
    expect(sanitizeChat('gg ' + FAMILY)).toBe('gg ' + FAMILY);
  });

  test('strips what can only be there to hide something', () => {
    expect(sanitizeChat('a' + ZWSP + 'b')).toBe('ab');
    expect(sanitizeChat('ab' + RLO + 'cd')).toBe('abcd');
    expect(sanitizeChat(BOM + 'hello')).toBe('hello');
  });

  test('a pasted newline separates words rather than welding them', () => {
    expect(sanitizeChat('line one' + cp(10) + 'line two')).toBe('line one line two');
    expect(sanitizeChat('a' + cp(9) + cp(9) + 'b')).toBe('a b');
  });

  test('clamps a stack of combining marks', () => {
    // Forty acutes on one letter paints over every line under it.
    const zalgo = 'e' + cp(0x301).repeat(40);
    expect([...sanitizeChat(zalgo)].length).toBeLessThanOrEqual(3);
  });

  test('truncates by code point, so an emoji is never cut in half', () => {
    const out = sanitizeChat(cp(0x1f600).repeat(300), 10);
    expect([...out]).toHaveLength(10);
    // Sliced by UTF-16 unit this would end in a lone surrogate.
    expect(out.includes('�')).toBe(false);
    expect(out).toBe(cp(0x1f600).repeat(10));
  });

  test('rejects a message with nothing in it', () => {
    expect(sanitizeChat('   ')).toBe('');
    expect(sanitizeChat('  ...  ')).toBe('');
    expect(sanitizeChat(ZWSP + ZWSP)).toBe('');
    expect(sanitizeChat(null)).toBe('');
  });

  test('does not escape markup, because the client renders text not HTML', () => {
    // If this ever starts passing with entities in it, somebody has "hardened"
    // the server and every player is now reading &amp;lt;3 instead of <3.
    const raw = '<img src=x onerror=alert(1)>';
    expect(sanitizeChat(raw)).toBe(raw);
  });
});

describe('chat rooms', () => {
  const seatedEntry = (overrides = {}) => ({
    id: 't_1',
    status: 'running',
    registrations: new Map([
      ['ann', { socketId: 's1' }],
      ['bob', { socketId: 's2' }],
      ['gone', { socketId: 's3' }],
    ]),
    watching: new Map([['gone', 'tbl2']]),
    mutedUids: new Set(),
    director: {
      tables: [
        { id: 'tbl1', tableNumber: 1 },
        { id: 'tbl2', tableNumber: 2 },
      ],
      playerByUid: (uid) =>
        uid === 'ann'
          ? { table: { id: 'tbl1', tableNumber: 1 } }
          : uid === 'bob'
            ? { table: { id: 'tbl2', tableNumber: 2 } }
            : null,
    },
    ...overrides,
  });

  test('the ring keeps the last N and drops the oldest', () => {
    const chat = createChatRooms({ historyLimit: 3 });
    for (let i = 1; i <= 6; i++) chat.post('t_1:t1', { uid: 'ann', name: 'Ann', text: `m${i}` });
    const log = chat.history('t_1:t1');
    expect(log).toHaveLength(3);
    expect(log.map((m) => m.text)).toEqual(['m4', 'm5', 'm6']);
  });

  test('one room filling up leaves another alone', () => {
    const chat = createChatRooms({ historyLimit: 2 });
    chat.post('t_1:t1', { uid: 'ann', name: 'Ann', text: 'at one' });
    for (let i = 0; i < 5; i++) chat.post('t_1:t2', { uid: 'bob', name: 'Bob', text: 'x' });
    expect(chat.history('t_1:t1')).toHaveLength(1);
    expect(chat.history('t_1:t2')).toHaveLength(2);
    expect(chat.history('t_1:t9')).toEqual([]);
  });

  test('the room is resolved from the sender, so there is nothing to spoof', () => {
    const chat = createChatRooms();
    const entry = seatedEntry();
    expect(chat.roomFor(entry, 'ann')).toBe('t_1:t1');
    expect(chat.roomFor(entry, 'bob')).toBe('t_1:t2');
    // Busted and railing table 2: they read that room, and canPost stops them
    // writing to it.
    expect(chat.roomFor(entry, 'gone')).toBe('t_1:t2');
    expect(chat.roomFor(entry, 'nobody')).toBeNull();
  });

  test('before the cards are out everyone registered shares the waiting room', () => {
    const chat = createChatRooms();
    const entry = seatedEntry({ status: 'registering' });
    expect(chat.roomFor(entry, 'ann')).toBe('t_1:lobby');
    expect(chat.roomFor(entry, 'bob')).toBe('t_1:lobby');
    expect(chat.roomFor(entry, 'stranger')).toBeNull();
  });

  test('who may post: seated yes, busted no, muted no, stranger no', () => {
    const chat = createChatRooms();
    const entry = seatedEntry();
    expect(chat.canPost(entry, 'ann').ok).toBe(true);

    // Busted: reads the table they are watching, cannot write to it.
    const busted = chat.canPost(entry, 'gone');
    expect(busted.ok).toBe(false);
    expect(busted.reason).toMatch(/still in the tournament/);

    entry.mutedUids.add('ann');
    const muted = chat.canPost(entry, 'ann');
    expect(muted.ok).toBe(false);
    expect(muted.reason).toMatch(/muted/);

    expect(chat.canPost(entry, 'stranger').ok).toBe(false);
    expect(chat.canPost(null, 'ann').ok).toBe(false);
  });

  test('the host keeps the floor after busting; nobody else does', () => {
    const chat = createChatRooms();
    // 'gone' has no seat and is watching table 2.
    expect(chat.canPost(seatedEntry({ hostUid: 'gone' }), 'gone').ok).toBe(true);
    expect(chat.canPost(seatedEntry({ hostUid: 'ann' }), 'gone').ok).toBe(false);
    // The mute still wins, and so does the game being over.
    const muted = seatedEntry({ hostUid: 'gone' });
    muted.mutedUids.add('gone');
    expect(chat.canPost(muted, 'gone').ok).toBe(false);
    expect(chat.canPost(seatedEntry({ hostUid: 'gone', status: 'finished' }), 'gone').ok).toBe(
      false
    );
  });

  test('a line carries where and from whom it was said, and a plain one carries nothing extra', () => {
    const chat = createChatRooms();
    const aimed = chat.post('t_1:t2', {
      uid: 'h',
      name: 'Host',
      text: 'break in five',
      table: 2,
      host: true,
      scope: 'all',
      group: 'a_1',
    });
    expect(aimed).toMatchObject({ table: 2, host: true, scope: 'all', group: 'a_1' });
    const plain = chat.post('t_1:t2', { uid: 'g', name: 'Guest', text: 'gg' });
    expect(plain).not.toHaveProperty('host');
    expect(plain).not.toHaveProperty('scope');
    expect(plain).not.toHaveProperty('group');
    expect(plain).not.toHaveProperty('table');
  });

  test('a player who has left is gagged even though the seat remembers them', () => {
    const chat = createChatRooms();
    const entry = seatedEntry();
    entry.registrations.set('ann', { socketId: null, left: true });
    expect(chat.canPost(entry, 'ann').ok).toBe(false);
  });

  test('waiting-room chat needs a registration, not a seat', () => {
    const chat = createChatRooms();
    const entry = seatedEntry({ status: 'registering' });
    expect(chat.canPost(entry, 'ann').ok).toBe(true);
    expect(chat.canPost(entry, 'stranger').ok).toBe(false);
  });

  test('the rate limit admits a burst then refuses, and recovers', () => {
    let clock = 1000;
    const chat = createChatRooms({ ratePerWindow: 3, rateWindowMs: 10000, now: () => clock });
    const bucket = {};
    expect([1, 2, 3].map(() => chat.takeToken(bucket))).toEqual([true, true, true]);
    expect(chat.takeToken(bucket)).toBe(false);
    clock += 10001;
    expect(chat.takeToken(bucket)).toBe(true);
  });

  test('a message that sanitises away is never posted', () => {
    const chat = createChatRooms();
    expect(chat.post('t_1:t1', { uid: 'ann', name: 'Ann', text: '   ' })).toBeNull();
    expect(chat.history('t_1:t1')).toEqual([]);
  });

  test('sequence numbers rise, which is what lets a client skip a replay', () => {
    const chat = createChatRooms();
    const a = chat.post('t_1:t1', { uid: 'ann', name: 'Ann', text: 'one' });
    const b = chat.post('t_1:t2', { uid: 'bob', name: 'Bob', text: 'two' });
    const c = chat.post('t_1:t1', { uid: 'ann', name: 'Ann', text: 'three' });
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(c.seq).toBeGreaterThan(b.seq);
  });

  test('a snapshot round-trips and the counter resumes past it', () => {
    const chat = createChatRooms({ historyLimit: 5 });
    chat.post('t_1:t1', { uid: 'ann', name: 'Ann', text: 'before the restart' });
    chat.post('t_2:t1', { uid: 'bob', name: 'Bob', text: 'a different tournament' });
    const snap = chat.snapshot('t_1');
    expect(Object.keys(snap)).toEqual(['t_1:t1']);

    const after = createChatRooms({ historyLimit: 5 });
    after.hydrate(snap);
    expect(after.history('t_1:t1').map((m) => m.text)).toEqual(['before the restart']);
    // Reusing a sequence number would make the next message look like a
    // duplicate to any client that was connected before the restart.
    const next = after.post('t_1:t1', { uid: 'ann', name: 'Ann', text: 'after' });
    expect(next.seq).toBeGreaterThan(snap['t_1:t1'][0].seq);
  });

  test('dropping a room or a tournament frees it', () => {
    const chat = createChatRooms();
    chat.post('t_1:t1', { uid: 'ann', name: 'Ann', text: 'x' });
    chat.post('t_1:t2', { uid: 'bob', name: 'Bob', text: 'y' });
    chat.post('t_2:t1', { uid: 'bob', name: 'Bob', text: 'z' });
    chat.dropRoom('t_1:t1');
    expect(chat.history('t_1:t1')).toEqual([]);
    expect(chat.roomCount()).toBe(2);
    chat.dropTournament('t_1');
    expect(chat.roomCount()).toBe(1);
    expect(chat.history('t_2:t1')).toHaveLength(1);
  });
});

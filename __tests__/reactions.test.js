// __tests__/reactions.test.js - the fixed set, the limiter, and the rules a
// reaction shares with chat: same room, same mute, same people, and none of
// chat's permanence.
const { createTournamentRegistry } = require('../server/tournament-registry');
const { REACTIONS, isReaction, takeToken } = require('../server/reactions');

describe('the set and the limiter', () => {
  test('only the fixed set is a reaction', () => {
    for (const r of REACTIONS) expect(isReaction(r)).toBe(true);
    expect(isReaction('👍')).toBe(false);
    expect(isReaction('')).toBe(false);
    expect(isReaction(null)).toBe(false);
    expect(isReaction(REACTIONS[0] + REACTIONS[1])).toBe(false);
  });

  test('a fixed window, per bucket', () => {
    const bucket = {};
    let at = 1000;
    const take = () => takeToken(bucket, { limit: 3, windowMs: 1000, at });
    expect([take(), take(), take(), take()]).toEqual([true, true, true, false]);
    at += 999;
    expect(take()).toBe(false);
    at += 1;
    expect(take()).toBe(true);
  });
});

describe('reactions through the registry', () => {
  function makeIo() {
    const sent = [];
    return {
      sent,
      emit: (event, payload) => sent.push({ to: '*', event, payload }),
      to: (target) => ({ emit: (event, payload) => sent.push({ to: target, event, payload }) }),
    };
  }
  const names = { h: 'Host', g: 'Guest', x: 'Outsider' };
  const identity = {
    get: (uid) => (names[uid] ? { uid, name: names[uid], avatar: '🙂' } : null),
    expireIdle: () => 0,
  };
  const makeSocket = (id, uid) => ({ id, data: uid ? { uid } : {}, emit: () => {} });

  function registry(io, extra = {}) {
    return createTournamentRegistry({
      io,
      identity,
      sweepMs: 100000,
      tableOptions: { actionTimeoutMs: 0 },
      ...extra,
    });
  }

  function seated(io, extra) {
    const reg = registry(io, extra);
    const host = makeSocket('sh', 'h');
    const guest = makeSocket('sg', 'g');
    const { entry } = reg.create('h', { name: 'Reacts', startsAt: Date.now() + 60000 }, host);
    reg.join('g', { code: entry.code }, guest);
    io.sent.length = 0;
    return { reg, entry, host, guest };
  }

  test("one goes to everyone in the room, signed with the sender's real name", () => {
    const io = makeIo();
    const { reg, entry, host } = seated(io);
    const result = reg.postReaction(entry, 'h', REACTIONS[0], host);
    expect(result.error).toBeUndefined();
    expect(result.reaction).toMatchObject({ uid: 'h', name: 'Host', emoji: REACTIONS[0] });
    const out = io.sent.filter((m) => m.event === 'reaction');
    expect(out).toHaveLength(1);
    expect(out[0].to).toEqual(expect.arrayContaining(['sh', 'sg']));
    // And it is not a chat line: the room's history is untouched.
    expect(reg.chat.history(`${entry.id}:lobby`)).toHaveLength(0);
    reg.stop();
  });

  test('anything outside the set is refused before it reaches anyone', () => {
    const io = makeIo();
    const { reg, entry, host } = seated(io);
    for (const bad of ['👍', 'clap', '', undefined, 42]) {
      expect(reg.postReaction(entry, 'h', bad, host).error).toMatch(/not one of/i);
    }
    expect(io.sent.filter((m) => m.event === 'reaction')).toHaveLength(0);
    reg.stop();
  });

  test('the host mute silences reactions the same as chat', () => {
    const io = makeIo();
    const { reg, entry, host, guest } = seated(io);
    expect(reg.setChatMute(entry, 'h', 'g', true).ok).toBe(true);
    expect(reg.postReaction(entry, 'g', REACTIONS[1], guest).error).toMatch(/muted/i);
    expect(reg.setChatMute(entry, 'h', 'g', false).ok).toBe(true);
    expect(reg.postReaction(entry, 'g', REACTIONS[1], guest).error).toBeUndefined();
    reg.stop();
    void host;
  });

  test('somebody not in the tournament has no room to throw into', () => {
    const io = makeIo();
    const { reg, entry } = seated(io);
    const outsider = makeSocket('sx', 'x');
    expect(reg.postReaction(entry, 'x', REACTIONS[2], outsider).error).toMatch(/not in this/i);
    reg.stop();
  });

  test("the limit is per socket and tighter than chat's", () => {
    const io = makeIo();
    const { reg, entry, host, guest } = seated(io, {
      reactionRatePerWindow: 2,
      reactionRateWindowMs: 60000,
    });
    expect(reg.postReaction(entry, 'h', REACTIONS[0], host).error).toBeUndefined();
    expect(reg.postReaction(entry, 'h', REACTIONS[0], host).error).toBeUndefined();
    expect(reg.postReaction(entry, 'h', REACTIONS[0], host).error).toMatch(/slow down/i);
    // Another socket has a bucket of its own.
    expect(reg.postReaction(entry, 'g', REACTIONS[0], guest).error).toBeUndefined();
    reg.stop();
  });

  test('switched off, the surface does not exist', () => {
    const io = makeIo();
    const { reg, entry, host } = seated(io, { reactionsEnabled: false });
    expect(reg.reactionsEnabled).toBe(false);
    expect(reg.reactions).toBeNull();
    expect(reg.postReaction(entry, 'h', REACTIONS[0], host).error).toMatch(/switched off/i);
    expect(io.sent.filter((m) => m.event === 'reaction')).toHaveLength(0);
    reg.stop();
  });

  test('the set the registry advertises is the set it accepts, and a copy', () => {
    const io = makeIo();
    const reg = registry(io);
    expect(reg.reactions).toEqual(REACTIONS);
    reg.reactions.push('🧨');
    expect(REACTIONS).not.toContain('🧨');
    reg.stop();
  });
});

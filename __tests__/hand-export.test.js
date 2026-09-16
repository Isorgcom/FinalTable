// hand-export.test.js - who may see what, in a recorded hand.
//
// This is the rule that stands between a replay and handing every player the
// folding range of everybody else. It is written once and called from the
// engine (a viewer at a table) and the director (a whole game, exported), so
// it is worth testing on its own and hard.
const { seatIdsForUid, visibleCardsFor } = require('../hand-history');

const card = (rank, suit) => ({ rank, suit });

// One hand: you, somebody who showed both at the showdown, somebody who turned
// one card over after taking a pot nobody contested, and somebody who folded.
function hand() {
  return {
    handNum: 7,
    players: [
      { id: 's_me', uid: 'u_me', name: 'You', seatIndex: 0 },
      { id: 's_show', uid: 'u_show', name: 'Shower', seatIndex: 1 },
      { id: 's_half', uid: 'u_half', name: 'Halfer', seatIndex: 2 },
      { id: 's_fold', uid: 'u_fold', name: 'Folder', seatIndex: 3 },
    ],
    holeCards: {
      s_me: [card('A', 'spades'), card('K', 'diamonds')],
      s_show: [card('Q', 'hearts'), card('Q', 'clubs')],
      s_half: [card('7', 'spades'), card('2', 'clubs')],
      s_fold: [card('3', 'hearts'), card('4', 'hearts')],
    },
    shownPlayerIds: ['s_show', 's_half'],
    shownCards: { s_show: [0, 1], s_half: [0] },
  };
}

describe('what a viewer may see of a recorded hand', () => {
  test('a uid finds every seat it held, and no other', () => {
    const h = hand();
    expect([...seatIdsForUid(h, 'u_me')]).toEqual(['s_me']);
    expect([...seatIdsForUid(h, 'u_nobody')]).toEqual([]);
    expect([...seatIdsForUid(h, null)]).toEqual([]);
  });

  // The same person, two seats: a reconnect issues a new socket id and a move
  // to another table a new seat, so one hand can hold both.
  test('two seats for one identity are both theirs', () => {
    const h = hand();
    h.players.push({ id: 's_me2', uid: 'u_me', name: 'You', seatIndex: 4 });
    h.holeCards.s_me2 = [card('9', 'clubs'), card('9', 'spades')];
    const mine = seatIdsForUid(h, 'u_me');
    const seen = visibleCardsFor(h, mine);
    expect(Object.keys(seen).sort()).toContain('s_me2');
    expect(seen.s_me2).toHaveLength(2);
  });

  test('your own cards, the shown ones, and nothing else', () => {
    const h = hand();
    const seen = visibleCardsFor(h, seatIdsForUid(h, 'u_me'));
    // Yours in full.
    expect(seen.s_me).toEqual([card('A', 'spades'), card('K', 'diamonds')]);
    // Both of a showdown.
    expect(seen.s_show).toEqual([card('Q', 'hearts'), card('Q', 'clubs')]);
    // One turned over, one left down - a null, not a gap, so a reader draws a
    // back where the felt drew one.
    expect(seen.s_half).toEqual([card('7', 'spades'), null]);
    // And the seat that folded is absent entirely. There is nothing to say.
    expect('s_fold' in seen).toBe(false);
  });

  // Asserted against the bytes rather than the object, the way the admin log's
  // redaction is: this is what leaves the server.
  test('a folded holding is nowhere in what is written out', () => {
    const h = hand();
    const raw = JSON.stringify(visibleCardsFor(h, seatIdsForUid(h, 'u_me')));
    // The folder held 3♥ 4♥ and the half-shower kept a 2♣ down.
    for (const gone of ['"3"', '"4"', '"2"']) {
      expect(`${gone}: ${raw.includes(gone) ? 'leaked' : 'absent'}`).toBe(`${gone}: absent`);
    }
    expect(raw).toContain('"A"');
    expect(raw).toContain('"7"');
  });

  test('a viewer with no seat in the hand sees only what was shown', () => {
    const h = hand();
    const seen = visibleCardsFor(h, seatIdsForUid(h, 'u_nobody'));
    expect(Object.keys(seen).sort()).toEqual(['s_half', 's_show']);
    expect(seen.s_half).toEqual([card('7', 'spades'), null]);
  });

  test('a hand with nothing in it does not throw', () => {
    expect(visibleCardsFor(null, new Set())).toEqual({});
    expect(visibleCardsFor({}, ['s_me'])).toEqual({});
  });
});

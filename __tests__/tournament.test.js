// __tests__/tournament.test.js - the blind clock on its own: levels of
// different lengths, breaks, and the snapshot that carries the structure.
const { Tournament } = require('../tournament');

const SCHEDULE = [
  { sb: 10, bb: 20, ante: 0, duration: 60 },
  { sb: 20, bb: 40, ante: 0, duration: 120 },
  { break: true, duration: 30 },
  { sb: 30, bb: 60, ante: 60, duration: 60 },
];

const active = [];
function clock(options) {
  const t = new Tournament(options);
  active.push(t);
  return t;
}
afterEach(() => {
  for (const t of active) t.stop();
  active.length = 0;
});

// The clock reads elapsed time from its start; moving the start back is how
// a test gets to a later second without waiting for it.
function at(t, seconds) {
  t.startTime = Date.now() - seconds * 1000;
  t.checkLevelUp();
}

describe('the blind clock', () => {
  test('without a structure it runs Standard at its own level length', () => {
    const t = clock({ levelDuration: 99999 });
    expect(t.blindSchedule.length).toBeGreaterThan(13);
    expect(t.blindSchedule[0]).toEqual({ sb: 10, bb: 20, ante: 0, duration: 99999, break: false });
    expect(t.playLevelCount()).toBe(18);
    expect(t.getCurrentBlinds()).toEqual({ sb: 10, bb: 20, ante: 0 });
  });

  test('levels of different lengths change at their own seconds', () => {
    const t = clock({ blindSchedule: SCHEDULE });
    const ups = [];
    t.onLevelUp = (level, blinds) => ups.push([level, blinds]);
    t.start(6);
    at(t, 59);
    expect(t.currentLevel).toBe(0);
    expect(t.getTimeUntilNextLevel()).toBe(1);
    at(t, 61);
    expect(t.currentLevel).toBe(1);
    expect(ups).toEqual([[1, { sb: 20, bb: 40, ante: 0 }]]);
    expect(t.getTimeUntilNextLevel()).toBe(119);
    at(t, 181);
    expect(t.currentLevel).toBe(2);
    expect(t.onBreak()).toBe(true);
    at(t, 211);
    expect(t.currentLevel).toBe(3);
    expect(t.onBreak()).toBe(false);
    expect(ups.map(([level]) => level)).toEqual([1, 2, 3]);
  });

  test('on a break the blinds are the ones play resumes at, and the number is the level before', () => {
    const t = clock({ blindSchedule: SCHEDULE });
    t.start(6);
    at(t, 181);
    expect(t.onBreak()).toBe(true);
    expect(t.getCurrentBlinds()).toEqual({ sb: 30, bb: 60, ante: 60 });
    expect(t.levelNumber()).toBe(2);
    expect(t.getTimeUntilNextLevel()).toBe(29);
    at(t, 211);
    expect(t.levelNumber()).toBe(3);
    expect(t.getCurrentBlinds()).toEqual({ sb: 30, bb: 60, ante: 60 });
  });

  test('the final level holds and counts down to nothing', () => {
    const t = clock({ blindSchedule: SCHEDULE });
    t.start(6);
    at(t, 100000);
    expect(t.currentLevel).toBe(3);
    expect(t.isFinalLevel()).toBe(true);
    expect(t.getTimeUntilNextLevel()).toBe(0);
    expect(t.getState()).toMatchObject({
      levelNumber: 3,
      levelCount: 3,
      onBreak: false,
      finalLevel: true,
      blinds: { sb: 30, bb: 60, ante: 60 },
      timeUntilNextLevel: 0,
    });
    expect(t.getResults().finalLevel).toBe(3);
  });

  test('a snapshot carries the structure and a resume prefers it', () => {
    const t = clock({ blindSchedule: SCHEDULE });
    t.start(6);
    at(t, 181);
    const snap = t.snapshotClock();
    expect(snap.schedule).toHaveLength(4);
    expect(snap.schedule[2]).toEqual({ sb: 0, bb: 0, ante: 0, duration: 30, break: true });
    expect(snap.currentLevel).toBe(2);

    const revived = clock({ levelDuration: 300 }); // Standard, which the snapshot overrides
    revived.resumeFrom(snap);
    expect(revived.blindSchedule).toEqual(t.blindSchedule);
    expect(revived.currentLevel).toBe(2);
    expect(revived.onBreak()).toBe(true);
    expect(revived.getCurrentBlinds()).toEqual({ sb: 30, bb: 60, ante: 60 });

    // A snapshot from before structures existed has no schedule: the clock
    // keeps the one it was built with.
    const old = clock({ levelDuration: 300 });
    old.resumeFrom({ currentLevel: 1, elapsedMs: 400000, levelDuration: 300 });
    expect(old.blindSchedule[0]).toMatchObject({ sb: 10, bb: 20, duration: 300 });
    expect(old.currentLevel).toBe(1);
  });

  test('a row without a length takes the clock level length', () => {
    const t = clock({
      levelDuration: 45,
      blindSchedule: [
        { sb: 5, bb: 10 },
        { sb: 10, bb: 20 },
      ],
    });
    expect(t.blindSchedule.map((r) => r.duration)).toEqual([45, 45]);
    expect(t.blindSchedule[0]).toEqual({ sb: 5, bb: 10, ante: 0, duration: 45, break: false });
  });
});

describe('the host and the clock', () => {
  // Wall-clock time passing while paused: both stamps move back together, as
  // if the pause had been standing for that long.
  function pausedFor(t, seconds) {
    t.pausedAt -= seconds * 1000;
    t.startTime -= seconds * 1000;
  }

  test('pause stops the clock and resume picks it up where it stopped', () => {
    const t = clock({ blindSchedule: SCHEDULE });
    t.start(6);
    at(t, 30);
    expect(t.getTimeUntilNextLevel()).toBe(30);
    expect(t.pause()).toBe(true);
    expect(t.isPaused()).toBe(true);
    pausedFor(t, 100);
    t.checkLevelUp();
    expect(t.currentLevel).toBe(0);
    expect(t.getTimeUntilNextLevel()).toBe(30);
    expect(t.getState().paused).toBe(true);
    expect(t.pause()).toBe(false);
    expect(t.resume()).toBe(true);
    expect(t.isPaused()).toBe(false);
    expect(t.getTimeUntilNextLevel()).toBe(30);
    expect(t.resume()).toBe(false);
  });

  test('a level can be set by hand, forwards or back, and the tick agrees', () => {
    const t = clock({ blindSchedule: SCHEDULE });
    const ups = [];
    t.onLevelUp = (level, blinds, info) => ups.push([level, blinds.bb, info]);
    t.start(6);
    at(t, 30);
    expect(t.goToLevel(3)).toBe(3);
    expect(t.currentLevel).toBe(3);
    expect(t.levelNumber()).toBe(3);
    expect(t.getTimeUntilNextLevel()).toBe(0);
    expect(ups).toEqual([[3, 60, { manual: true, back: false }]]);
    t.checkLevelUp();
    expect(t.currentLevel).toBe(3);
    expect(t.goToLevel(1)).toBe(1);
    expect(t.getTimeUntilNextLevel()).toBe(120);
    expect(ups[1]).toEqual([1, 40, { manual: true, back: true }]);
    t.checkLevelUp();
    expect(t.currentLevel).toBe(1);
    expect(t.goToLevel(-5)).toBe(0);
    expect(t.goToLevel(99)).toBe(3);
  });

  test('seconds go on and off the level in play, never past the moment it is at', () => {
    const t = clock({ blindSchedule: SCHEDULE });
    t.start(6);
    at(t, 70); // ten seconds into the second level, which lasts 120
    expect(t.getTimeUntilNextLevel()).toBe(110);
    expect(t.shiftClock(60)).toBe(170);
    expect(t.blindSchedule[1].duration).toBe(180);
    expect(t.shiftClock(-60)).toBe(110);
    expect(t.shiftClock(-60)).toBe(50);
    // Cut to before now: the level ends at once, and the tick moves on.
    expect(t.shiftClock(-60)).toBeLessThanOrEqual(1);
    expect(t.blindSchedule[1].duration).toBeLessThanOrEqual(11);
    at(t, 75);
    expect(t.currentLevel).toBe(2);
    expect(t.onBreak()).toBe(true);
  });

  test('a snapshot taken paused comes back paused, with the time left', () => {
    const t = clock({ blindSchedule: SCHEDULE });
    t.start(6);
    at(t, 30);
    t.pause();
    const snap = t.snapshotClock();
    expect(snap.paused).toBe(true);
    expect(Math.round(snap.elapsedMs / 1000)).toBe(30);
    const revived = clock({ levelDuration: 300 });
    revived.resumeFrom(snap);
    expect(revived.isPaused()).toBe(true);
    expect(revived.getTimeUntilNextLevel()).toBe(30);
    expect(revived.resume()).toBe(true);
    expect(revived.getTimeUntilNextLevel()).toBe(30);

    t.resume();
    const running = clock({ levelDuration: 300 });
    running.resumeFrom(t.snapshotClock());
    expect(running.isPaused()).toBe(false);
  });
});

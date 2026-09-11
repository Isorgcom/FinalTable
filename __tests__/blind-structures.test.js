// __tests__/blind-structures.test.js - the presets, the clamp and the rung rule
const {
  PRESETS,
  MAX_LEVELS,
  materialize,
  clampStructure,
  nextLevel,
  ladderNext,
  summary,
} = require('../blind-structures');

describe('presets', () => {
  test('each preset lays out its ladder with antes and breaks where it says', () => {
    for (const def of PRESETS) {
      const s = materialize(def.key, 240);
      expect(s.name).toBe(def.name);
      const play = s.levels.filter((r) => !r.break);
      expect(play).toHaveLength(def.ladder.length);
      play.forEach((row, i) => {
        expect([row.sb, row.bb]).toEqual(def.ladder[i]);
        expect(row.ante).toBe(i + 1 >= def.anteFrom ? row.bb : 0);
        expect(row.duration).toBe(240);
      });
      const breaks = s.levels.filter((r) => r.break);
      expect(breaks).toHaveLength(def.breakAfter.length);
      for (const b of breaks)
        expect(b).toEqual({ sb: 0, bb: 0, ante: 0, duration: 240, break: true });
      expect(summary(s)).toEqual({
        name: def.name,
        levelCount: def.ladder.length,
        anteFrom: def.anteFrom,
        breaks: def.breakAfter,
      });
      expect(s.levels[s.levels.length - 1].break).toBe(false);
      expect(s.levels[0]).toMatchObject({ sb: 10, bb: 20, ante: 0 });
    }
  });

  test('an unknown key and a bad level length fall back to Standard at five minutes', () => {
    const s = materialize('nope', 'soon');
    expect(s.name).toBe('Standard');
    expect(s.levels[0].duration).toBe(300);
  });
});

describe('clampStructure', () => {
  test('a preset key is that preset; junk is Standard', () => {
    expect(clampStructure('turbo', 120).name).toBe('Turbo');
    expect(clampStructure('TURBO', 120).levels[0].duration).toBe(120);
    expect(clampStructure(null, 300).name).toBe('Standard');
    expect(clampStructure({ levels: 'nope' }, 300).name).toBe('Standard');
    expect(clampStructure({ levels: [] }, 300).name).toBe('Standard');
    expect(clampStructure({ levels: [{ break: true }, { sb: 0 }] }, 300).name).toBe('Standard');
  });

  test('is idempotent, for a preset and for a hand-built structure', () => {
    for (const def of PRESETS) {
      const once = clampStructure(def.key, 180);
      expect(clampStructure(once, 999)).toEqual(once);
    }
    const custom = clampStructure(
      {
        name: 'Sunday',
        levels: [
          { sb: 25, bb: 50, ante: 0, duration: 60 },
          { break: true, duration: 90 },
          { sb: 50, bb: 100, ante: 100, duration: 60 },
        ],
      },
      300
    );
    expect(clampStructure(custom, 300)).toEqual(custom);
  });

  test('clamps every field and drops what cannot be played', () => {
    const s = clampStructure(
      {
        name: '  A very long name that runs past the limit  ',
        levels: [
          { break: true }, // leading break: dropped
          { sb: 'x', bb: 20 }, // no small blind: dropped
          { sb: 10, bb: 5, ante: -3, duration: 5 }, // bb below sb, ante negative, too short
          { break: true, duration: 999999 },
          { break: true }, // second break in a row: dropped
          { sb: 20, bb: 40, ante: 40, duration: 120 },
          { break: true }, // trailing break: dropped
        ],
      },
      300
    );
    expect(s.name).toBe('A very long name that ru');
    expect(s.levels).toEqual([
      { sb: 10, bb: 20, ante: 0, duration: 30, break: false },
      { sb: 0, bb: 0, ante: 0, duration: 3600, break: true },
      { sb: 20, bb: 40, ante: 40, duration: 120, break: false },
    ]);
  });

  test('a row without a length takes the level length, and names are cleaned', () => {
    const bell = String.fromCharCode(7);
    const s = clampStructure({ name: `x${bell}y`, levels: [{ sb: 10, bb: 20 }] }, 240);
    expect(s.levels[0].duration).toBe(240);
    expect(s.name).toBe('xy');
    expect(clampStructure({ levels: [{ sb: 10, bb: 20 }] }, 240).name).toBe('Custom');
  });

  test('caps the number of levels', () => {
    const levels = Array.from({ length: 200 }, (_, i) => ({ sb: 10 + i, bb: 20 + 2 * i }));
    expect(clampStructure({ levels }, 300).levels).toHaveLength(MAX_LEVELS);
  });
});

describe('the rung rule', () => {
  test('climbs the classic ladder at one and a half', () => {
    const climb = [10];
    for (let i = 0; i < 10; i++) climb.push(ladderNext(climb[climb.length - 1]));
    expect(climb).toEqual([10, 15, 25, 40, 60, 100, 150, 250, 400, 600, 1000]);
  });

  test('a new level continues from the last level of play, inheriting only whether it antes', () => {
    const rows = [
      { sb: 100, bb: 200, ante: 200, duration: 180, break: false },
      { sb: 0, bb: 0, ante: 0, duration: 180, break: true },
    ];
    expect(nextLevel(rows)).toEqual({ sb: 150, bb: 300, ante: 300, duration: 180, break: false });
    expect(nextLevel([{ sb: 100, bb: 200, ante: 0, duration: 60, break: false }])).toEqual({
      sb: 150,
      bb: 300,
      ante: 0,
      duration: 60,
      break: false,
    });
    expect(nextLevel([])).toEqual({ sb: 10, bb: 20, ante: 0, duration: 300, break: false });
  });
});

describe('summary', () => {
  test('counts levels of play, the first ante and where the breaks fall', () => {
    const s = {
      name: 'Mine',
      levels: [
        { sb: 10, bb: 20, ante: 0, duration: 60, break: false },
        { sb: 15, bb: 30, ante: 0, duration: 60, break: false },
        { sb: 0, bb: 0, ante: 0, duration: 60, break: true },
        { sb: 25, bb: 50, ante: 50, duration: 60, break: false },
      ],
    };
    expect(summary(s)).toEqual({ name: 'Mine', levelCount: 3, anteFrom: 3, breaks: [2] });
    expect(summary(null)).toEqual({ name: 'Standard', levelCount: 0, anteFrom: 0, breaks: [] });
  });
});

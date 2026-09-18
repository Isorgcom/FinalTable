// db-migrations.test.js - the shape changes, run once each.
//
// There are no steps yet. The ledger ships before the first thing that rides
// it, so what is tested here is the mechanism: that a step runs, that it runs
// once, that a failure is not recorded as a success, and that the SQL half is
// the real driver's business and the memory driver ignores it.
const { runMigrations } = require('../server/db/migrations');
const { createMemoryDatabase } = require('../server/db');

describe('the migration ledger', () => {
  let db;
  let n = 0;

  beforeEach(() => {
    db = createMemoryDatabase({ database: `migrations-${n++}` });
    db.reset();
  });

  test('nothing to do is not an error', async () => {
    expect(await runMigrations({ db })).toEqual([]);
    expect(await runMigrations({})).toEqual([]);
  });

  test('a step runs, and is not run again', async () => {
    let runs = 0;
    const steps = [{ name: '001-a-step', run: () => void runs++ }];

    expect(await runMigrations({ db, steps })).toEqual(['001-a-step']);
    expect(runs).toBe(1);

    // The second boot, and every boot after it.
    expect(await runMigrations({ db, steps })).toEqual([]);
    expect(runs).toBe(1);
    expect(await db.migrations.applied()).toEqual(['001-a-step']);
  });

  test('steps run in order, and a later one added afterwards runs on its own', async () => {
    const order = [];
    const first = { name: '001-first', run: () => order.push('first') };
    const second = { name: '002-second', run: () => order.push('second') };

    await runMigrations({ db, steps: [first] });
    // What a server looks like when it pulls a release with a new step in it.
    expect(await runMigrations({ db, steps: [first, second] })).toEqual(['002-second']);
    expect(order).toEqual(['first', 'second']);
  });

  // A step that threw half way through has done some of its work and none of
  // its recording. It must be met again rather than skipped as finished.
  test('a step that throws is not written down as done', async () => {
    let attempts = 0;
    const steps = [
      {
        name: '001-fails-once',
        run: () => {
          attempts++;
          if (attempts === 1) throw new Error('the database said no');
        },
      },
    ];

    await expect(runMigrations({ db, steps })).rejects.toThrow('the database said no');
    expect(await db.migrations.applied()).toEqual([]);

    // The next boot meets it again, and this time it works.
    expect(await runMigrations({ db, steps })).toEqual(['001-fails-once']);
    expect(attempts).toBe(2);
  });

  // A step stops at the first failure rather than carrying on past it: the one
  // after it may be the one that needs the column the failed one was adding.
  test('a failure stops the ones behind it', async () => {
    let reached = false;
    const steps = [
      {
        name: '001-fails',
        run: () => {
          throw new Error('no');
        },
      },
      { name: '002-after', run: () => void (reached = true) },
    ];
    await expect(runMigrations({ db, steps })).rejects.toThrow('no');
    expect(reached).toBe(false);
    expect(await db.migrations.applied()).toEqual([]);
  });

  test('the memory driver takes the name and leaves the SQL alone', async () => {
    const steps = [
      { name: '001-sql-only', sql: ['ALTER TABLE identities ADD COLUMN IF NOT EXISTS role INT'] },
    ];
    // No schema here to alter, so the statement goes nowhere - but the step is
    // still recorded, or it would be applied again on every boot.
    expect(await runMigrations({ db, steps })).toEqual(['001-sql-only']);
    expect(await db.migrations.applied()).toEqual(['001-sql-only']);
  });

  test('what ran is said out loud, and a boot with nothing to do says nothing', async () => {
    const said = [];
    const log = (entry) => said.push(entry);
    await runMigrations({ db, log, steps: [{ name: '001-a-step', run: () => {} }] });
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ event: 'migrations_applied' });
    expect(said[0].data.steps).toBe('001-a-step');

    said.length = 0;
    await runMigrations({ db, log, steps: [{ name: '001-a-step', run: () => {} }] });
    expect(said).toEqual([]);
  });

  test('a step with no name is skipped rather than recorded as an empty one', async () => {
    expect(await runMigrations({ db, steps: [null, {}, { run: () => {} }] })).toEqual([]);
    expect(await db.migrations.applied()).toEqual([]);
  });
});

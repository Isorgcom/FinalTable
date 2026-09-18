// migrations.js - the shape changes, run once each.
//
// schema.js makes the tables and never touches them again. That is the right
// rule for CREATE TABLE IF NOT EXISTS - it is how a fresh database becomes a
// working one and an existing one stays untouched - but it has no answer for
// the day a table somebody's account is already in needs another column. This
// is that answer.
//
// A step is a name and some work. The name is recorded when the work succeeds,
// and a step whose name is already in the ledger is skipped, so every boot
// after the first does nothing but one SELECT.
//
// Two ways to write the work, and the difference is which driver it is for:
//
//   sql: []   statements for the real database. The memory driver has no
//             schema to alter and ignores them.
//   run(db)   anything expressible through the entity methods both drivers
//             have, which is where a step that moves data rather than shape
//             belongs.
//
// A step must be safe to run against a database that already looks like the
// answer, because the ledger is not the only thing that can be true: a fresh
// database gets the finished shape straight from schema.js and then meets
// every step in this list for the first time. So: ADD COLUMN IF NOT EXISTS,
// never ADD COLUMN.
//
// Steps are never edited once they have shipped. A step that turned out to be
// wrong is followed by another one that puts it right, because the first one
// has already run on somebody's server and its name is already in their
// ledger.

// In order. Nothing here yet: the ledger ships before the first thing that
// rides it, so that a step going wrong is a step going wrong rather than the
// mechanism going wrong underneath it.
const STEPS = [];

async function runMigrations(options = {}) {
  const { db = null, log = () => {}, steps = STEPS } = options;
  if (!db || !db.migrations) return [];

  const done = new Set(await db.migrations.applied());
  const ran = [];
  for (const step of steps) {
    if (!step || !step.name || done.has(step.name)) continue;
    if (Array.isArray(step.sql) && step.sql.length) await db.migrations.exec(step.sql);
    if (typeof step.run === 'function') await step.run(db);
    // Recorded only once the work is done: a step that threw half way through
    // must be met again on the next boot rather than skipped as finished.
    await db.migrations.record(step.name);
    ran.push(step.name);
  }

  if (ran.length) {
    log({
      level: 'info',
      event: 'migrations_applied',
      message: 'The database changed shape',
      data: { steps: ran.join(', '), count: ran.length },
    });
  }
  return ran;
}

module.exports = { runMigrations, STEPS };

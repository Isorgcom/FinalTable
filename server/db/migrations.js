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

// In order, and never edited once shipped.
const STEPS = [
  // Everybody has an account, so an identity is a person rather than a browser
  // and there are two more things worth knowing about one: whether they run
  // this server, and whether they are allowed on it at all. Both belong here
  // rather than on the account, because a GameNight player has no account row.
  {
    name: '001-identities-role-and-disabled',
    sql: [
      "ALTER TABLE identities ADD COLUMN IF NOT EXISTS role VARCHAR(16) NOT NULL DEFAULT 'player'",
      'ALTER TABLE identities ADD COLUMN IF NOT EXISTS disabled_at BIGINT NULL',
      'ALTER TABLE identities ADD INDEX IF NOT EXISTS idx_identities_role (role)',
    ],
  },

  // The guests, who can no longer sign in to anything. Their devices go with
  // them on the foreign key. This is the one step here that deletes somebody's
  // row, and it is only deleting rows that stopped meaning anything the moment
  // the name box did.
  {
    name: '002-guests-go',
    sql: ["DELETE FROM identities WHERE provider = 'guest'"],
  },

  // And now that one name is one person, the backstop. Deliberately after the
  // purge, because the purge is what makes it true - and deliberately not a
  // blind ALTER: if two rows somehow still share a name, adding a unique index
  // would resolve it by throwing away one of them, or by failing every boot
  // from here on. Better to refuse, say which names, and let somebody decide.
  {
    name: '003-one-name-one-person',
    async run(db) {
      if (db.driver !== 'mariadb') return;
      const clash = await db.migrations.clashingNames();
      if (clash.length) {
        throw new Error(
          `Two identities share a name, so the unique index cannot be added: ${clash.join(', ')}. ` +
            'Rename or remove one of each pair and start the server again.'
        );
      }
      await db.migrations.exec([
        'ALTER TABLE identities ADD UNIQUE INDEX IF NOT EXISTS uq_identities_name_key (name_key)',
        'ALTER TABLE identities DROP INDEX IF EXISTS idx_identities_name_key',
      ]);
    },
  },
];

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

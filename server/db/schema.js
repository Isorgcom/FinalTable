// schema.js - the tables, and the order they have to be made in.
//
// Applied on every boot with CREATE TABLE IF NOT EXISTS, which is how a fresh
// database becomes a working one and an existing database stays untouched.
// Nothing here drops or alters anything: a change to a table that already
// holds somebody's account is a migration of its own, written when it is
// needed and never as a side effect of starting the server.
//
// utf8mb4 throughout, because an avatar is an emoji and a name may be one too.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (
     k           VARCHAR(64)  NOT NULL PRIMARY KEY,
     v           JSON         NOT NULL,
     updated_at  BIGINT       NOT NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Who somebody is. The name is not unique here - two guests may share one,
  // and it is the accounts table that makes a name somebody's.
  `CREATE TABLE IF NOT EXISTS identities (
     uid          VARCHAR(64)  NOT NULL PRIMARY KEY,
     name         VARCHAR(64)  NOT NULL,
     name_key     VARCHAR(64)  NOT NULL,
     avatar       VARCHAR(16)  NOT NULL DEFAULT '🧑',
     provider     VARCHAR(16)  NOT NULL DEFAULT 'guest',
     gn_user_id   VARCHAR(64)  NULL,
     created_at   BIGINT       NOT NULL,
     last_seen_at BIGINT       NOT NULL,
     prefs        JSON         NULL,
     KEY idx_identities_name_key (name_key),
     KEY idx_identities_last_seen (last_seen_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // One row per browser somebody is signed in on. The token itself is not
  // here: what is kept is its digest, so a copy of this table is not a set of
  // live sessions. `id` is the public name a row goes by on the devices list.
  `CREATE TABLE IF NOT EXISTS devices (
     token_hash   CHAR(64)     NOT NULL PRIMARY KEY,
     uid          VARCHAR(64)  NOT NULL,
     id           CHAR(16)     NOT NULL,
     label        VARCHAR(64)  NOT NULL,
     created_at   BIGINT       NOT NULL,
     last_seen_at BIGINT       NOT NULL,
     KEY idx_devices_uid (uid),
     KEY idx_devices_last_seen (last_seen_at),
     CONSTRAINT fk_devices_identity FOREIGN KEY (uid)
       REFERENCES identities (uid) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // A name on this server that is somebody's. The rule the accounts module
  // enforces in code is a constraint here: one account to a name, decided by
  // the database rather than by remembering to check.
  `CREATE TABLE IF NOT EXISTS accounts (
     uid         VARCHAR(64)  NOT NULL PRIMARY KEY,
     name_key    VARCHAR(64)  NOT NULL,
     name        VARCHAR(64)  NOT NULL,
     email       VARCHAR(254) NOT NULL,
     password    JSON         NOT NULL,
     created_at  BIGINT       NOT NULL,
     verified_at BIGINT       NULL,
     UNIQUE KEY uq_accounts_name (name_key)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // A sign-up waiting for its link. It holds the name - one row to a name, so
  // two people cannot both be verifying it - and lapses.
  `CREATE TABLE IF NOT EXISTS account_pending (
     name_key   VARCHAR(64)  NOT NULL PRIMARY KEY,
     uid        VARCHAR(64)  NOT NULL,
     name       VARCHAR(64)  NOT NULL,
     email      VARCHAR(254) NOT NULL,
     password   JSON         NOT NULL,
     token_hash CHAR(64)     NOT NULL,
     created_at BIGINT       NOT NULL,
     expires_at BIGINT       NOT NULL,
     KEY idx_pending_expires (expires_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS account_resets (
     token_hash CHAR(64)     NOT NULL PRIMARY KEY,
     uid        VARCHAR(64)  NOT NULL,
     created_at BIGINT       NOT NULL,
     expires_at BIGINT       NOT NULL,
     KEY idx_resets_expires (expires_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // A game in progress, or one waiting to start: its registrations, its
  // settings and the field it recorded between hands. A document rather than
  // columns, because that is honestly what it is - a snapshot taken between
  // hands and read back whole - and nothing ever asks a question of its
  // insides except the code that seats it again.
  `CREATE TABLE IF NOT EXISTS tournaments (
     id         VARCHAR(64) NOT NULL PRIMARY KEY,
     status     VARCHAR(16) NOT NULL,
     updated_at BIGINT      NOT NULL,
     data       JSON        NOT NULL,
     KEY idx_tournaments_status (status)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Everything said at one game's tables, as the ring buffers hold it. Also a
  // document, and for the same reason.
  `CREATE TABLE IF NOT EXISTS chat (
     tournament_id VARCHAR(64) NOT NULL PRIMARY KEY,
     updated_at    BIGINT      NOT NULL,
     data          JSON        NOT NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

module.exports = { SCHEMA };

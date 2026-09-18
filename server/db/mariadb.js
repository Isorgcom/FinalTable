// mariadb.js - the real one.
//
// A pool, the schema applied at boot, and one method per thing a store needs
// to write or read back. The stores keep their working set in memory and their
// synchronous API; this is where their writes land and what they load from
// when the process starts.
//
// Everything goes through placeholders. Nothing here builds SQL out of a
// value, ever.

const mysql = require('mysql2/promise');
const { SCHEMA } = require('./schema');

const CONNECT_RETRIES = 30;
const CONNECT_WAIT_MS = 1000;

function createMariaDatabase(options = {}) {
  const {
    url = '',
    host = '127.0.0.1',
    port = 3306,
    user = 'finaltable',
    password = '',
    database = 'finaltable',
    connectionLimit = 8,
    log = () => {},
    wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = options;

  let pool = null;

  function config() {
    if (url) return url;
    return {
      host,
      port,
      user,
      password,
      database,
      connectionLimit,
      charset: 'utf8mb4',
      // Dates and bigints as they were written: an epoch is a number here and
      // must not come back as a string or a Date.
      supportBigNumbers: true,
      bigNumberStrings: false,
      dateStrings: true,
    };
  }

  // A database in its own container is not up when the server is, however
  // carefully compose is written. Waiting is the difference between a first
  // boot that works and one that needs a second try.
  async function connect() {
    pool = mysql.createPool(config());
    let last = null;
    for (let attempt = 1; attempt <= CONNECT_RETRIES; attempt++) {
      try {
        const conn = await pool.getConnection();
        conn.release();
        if (attempt > 1) {
          log({
            level: 'info',
            event: 'db_connected',
            message: 'Database reached',
            data: { attempt },
          });
        }
        return;
      } catch (err) {
        last = err;
        if (attempt === 1) {
          log({
            level: 'info',
            event: 'db_waiting',
            message: 'Waiting for the database',
            data: { detail: err.code || err.message },
          });
        }
        await wait(CONNECT_WAIT_MS);
      }
    }
    throw new Error(`Could not reach the database: ${last && last.message}`);
  }

  async function apply() {
    for (const statement of SCHEMA) await pool.query(statement);
  }

  async function close() {
    if (pool) await pool.end();
    pool = null;
  }

  async function ping() {
    const conn = await pool.getConnection();
    conn.release();
    return true;
  }

  const json = (value) => (value === undefined || value === null ? null : JSON.stringify(value));
  // mysql2 hands a JSON column back parsed already on some versions and as a
  // string on others. Both are read the same way rather than assuming one.
  const unjson = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch (_err) {
      return null;
    }
  };
  const num = (value) => (value === null || value === undefined ? null : Number(value));

  return {
    driver: 'mariadb',
    connect,
    apply,
    close,
    ping,

    settings: {
      async all() {
        const [rows] = await pool.query('SELECT k, v, updated_at FROM settings');
        return rows.map((r) => ({ k: r.k, v: unjson(r.v), updated_at: num(r.updated_at) }));
      },
      async put(k, v) {
        await pool.query(
          'INSERT INTO settings (k, v, updated_at) VALUES (?, ?, ?) ' +
            'ON DUPLICATE KEY UPDATE v = VALUES(v), updated_at = VALUES(updated_at)',
          [k, json(v), Date.now()]
        );
      },
      async remove(k) {
        await pool.query('DELETE FROM settings WHERE k = ?', [k]);
      },
    },

    identities: {
      // One query for the people and one for their devices, stitched here: a
      // join would send every identity once per device it has.
      async all() {
        const [people] = await pool.query(
          'SELECT uid, name, name_key, avatar, provider, gn_user_id, created_at, ' +
            'last_seen_at, prefs FROM identities'
        );
        const [devices] = await pool.query(
          'SELECT token_hash, uid, id, label, created_at, last_seen_at FROM devices'
        );
        const byUid = new Map();
        for (const row of people) {
          byUid.set(row.uid, {
            uid: row.uid,
            name: row.name,
            nameKey: row.name_key,
            avatar: row.avatar,
            provider: row.provider,
            gnUserId: row.gn_user_id,
            createdAt: num(row.created_at),
            lastSeenAt: num(row.last_seen_at),
            prefs: unjson(row.prefs) || {},
            devices: [],
          });
        }
        for (const row of devices) {
          const person = byUid.get(row.uid);
          if (!person) continue;
          person.devices.push({
            tokenHash: row.token_hash,
            id: row.id,
            label: row.label,
            createdAt: num(row.created_at),
            lastSeenAt: num(row.last_seen_at),
          });
        }
        return [...byUid.values()];
      },

      // The identity and the whole of its device list, in one transaction: a
      // record half written is somebody signed out of a browser they are
      // looking at.
      async put(record) {
        if (!record || !record.uid) return;
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          await conn.query(
            'INSERT INTO identities (uid, name, name_key, avatar, provider, gn_user_id, ' +
              'created_at, last_seen_at, prefs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
              'ON DUPLICATE KEY UPDATE name = VALUES(name), name_key = VALUES(name_key), ' +
              'avatar = VALUES(avatar), provider = VALUES(provider), ' +
              'gn_user_id = VALUES(gn_user_id), last_seen_at = VALUES(last_seen_at), ' +
              'prefs = VALUES(prefs)',
            [
              record.uid,
              record.name || '',
              record.nameKey || '',
              record.avatar || '🧑',
              record.provider || 'guest',
              record.gnUserId || null,
              record.createdAt || Date.now(),
              record.lastSeenAt || Date.now(),
              json(record.prefs || {}),
            ]
          );
          const rows = Array.isArray(record.devices) ? record.devices : [];
          const keep = rows.map((d) => d.tokenHash).filter(Boolean);
          if (keep.length) {
            await conn.query(
              `DELETE FROM devices WHERE uid = ? AND token_hash NOT IN (${keep.map(() => '?').join(',')})`,
              [record.uid, ...keep]
            );
          } else {
            await conn.query('DELETE FROM devices WHERE uid = ?', [record.uid]);
          }
          for (const device of rows) {
            if (!device || !device.tokenHash) continue;
            await conn.query(
              'INSERT INTO devices (token_hash, uid, id, label, created_at, last_seen_at) ' +
                'VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE ' +
                'label = VALUES(label), last_seen_at = VALUES(last_seen_at)',
              [
                device.tokenHash,
                record.uid,
                device.id || '',
                device.label || 'A browser',
                device.createdAt || Date.now(),
                device.lastSeenAt || Date.now(),
              ]
            );
          }
          await conn.commit();
        } catch (err) {
          await conn.rollback();
          throw err;
        } finally {
          conn.release();
        }
      },

      async remove(uid) {
        // The devices go with it: the foreign key says so.
        await pool.query('DELETE FROM identities WHERE uid = ?', [uid]);
      },

      async count() {
        const [rows] = await pool.query('SELECT COUNT(*) AS n FROM identities');
        return Number(rows[0].n);
      },
    },

    tournaments: {
      async all() {
        const [rows] = await pool.query('SELECT id, status, data FROM tournaments');
        return rows.map((r) => ({ id: r.id, status: r.status, data: unjson(r.data) }));
      },

      // The registry keeps the whole list and hands it over whole: anything
      // not in it has been cancelled, finished or swept. Done in one
      // transaction, so a reader never sees a moment with half a field in it.
      async replaceAll(list) {
        const rows = (list || []).filter((row) => row && row.id);
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          const keep = rows.map((row) => row.id);
          if (keep.length) {
            await conn.query(
              `DELETE FROM tournaments WHERE id NOT IN (${keep.map(() => '?').join(',')})`,
              keep
            );
          } else {
            await conn.query('DELETE FROM tournaments');
          }
          const at = Date.now();
          for (const row of rows) {
            await conn.query(
              'INSERT INTO tournaments (id, status, updated_at, data) VALUES (?, ?, ?, ?) ' +
                'ON DUPLICATE KEY UPDATE status = VALUES(status), ' +
                'updated_at = VALUES(updated_at), data = VALUES(data)',
              [row.id, row.status || 'registering', at, json(row.data)]
            );
          }
          await conn.commit();
        } catch (err) {
          await conn.rollback();
          throw err;
        } finally {
          conn.release();
        }
      },

      async remove(id) {
        await pool.query('DELETE FROM tournaments WHERE id = ?', [id]);
      },
    },

    chat: {
      async all() {
        const [rows] = await pool.query('SELECT tournament_id, data FROM chat');
        return rows.map((r) => ({ id: r.tournament_id, data: unjson(r.data) }));
      },
      async put(id, data) {
        await pool.query(
          'INSERT INTO chat (tournament_id, updated_at, data) VALUES (?, ?, ?) ' +
            'ON DUPLICATE KEY UPDATE updated_at = VALUES(updated_at), data = VALUES(data)',
          [id, Date.now(), json(data)]
        );
      },
      async remove(id) {
        await pool.query('DELETE FROM chat WHERE tournament_id = ?', [id]);
      },
    },

    games: {
      // The game and everybody who played in it, together: a row without its
      // players is a game nobody can be given.
      async put(meta, hands, uids) {
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          await conn.query(
            'INSERT INTO games (id, name, started_at, ended_at, touched_at, hands, data) ' +
              'VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), ' +
              'started_at = VALUES(started_at), ended_at = VALUES(ended_at), ' +
              'touched_at = VALUES(touched_at), hands = VALUES(hands), data = VALUES(data)',
            [
              meta.id,
              meta.name || null,
              num(meta.startedAt),
              num(meta.endedAt),
              meta.touchedAt || Date.now(),
              Array.isArray(hands) ? hands.length : 0,
              JSON.stringify(hands || []),
            ]
          );
          const list = [...new Set((uids || []).filter(Boolean))];
          await conn.query('DELETE FROM game_players WHERE game_id = ?', [meta.id]);
          for (const uid of list) {
            await conn.query('INSERT INTO game_players (game_id, uid) VALUES (?, ?)', [
              meta.id,
              uid,
            ]);
          }
          await conn.commit();
        } catch (err) {
          await conn.rollback();
          throw err;
        } finally {
          conn.release();
        }
      },

      async get(id) {
        const [rows] = await pool.query(
          'SELECT id, name, started_at, ended_at, touched_at, hands, data FROM games WHERE id = ?',
          [id]
        );
        if (!rows.length) return null;
        const r = rows[0];
        let hands = [];
        try {
          hands = JSON.parse(r.data);
        } catch (_err) {
          hands = [];
        }
        return {
          meta: {
            id: r.id,
            name: r.name,
            startedAt: num(r.started_at),
            endedAt: num(r.ended_at),
            touchedAt: num(r.touched_at),
            hands: Number(r.hands),
          },
          hands: Array.isArray(hands) ? hands : [],
        };
      },

      // The join that this table exists for. Never selects `data`: a list of
      // games is not a reason to read every hand on the server.
      async listFor(uid) {
        const [rows] = await pool.query(
          'SELECT g.id, g.name, g.started_at, g.ended_at, g.touched_at, g.hands ' +
            'FROM games g JOIN game_players p ON p.game_id = g.id WHERE p.uid = ? ' +
            'ORDER BY COALESCE(g.ended_at, g.touched_at) DESC, g.id DESC',
          [uid]
        );
        return rows.map((r) => ({
          id: r.id,
          name: r.name,
          startedAt: num(r.started_at),
          endedAt: num(r.ended_at),
          touchedAt: num(r.touched_at),
          hands: Number(r.hands),
        }));
      },

      async played(uid, id) {
        const [rows] = await pool.query(
          'SELECT 1 FROM game_players WHERE uid = ? AND game_id = ? LIMIT 1',
          [uid, id]
        );
        return rows.length > 0;
      },

      async ids() {
        const [rows] = await pool.query('SELECT id FROM games');
        return rows.map((r) => r.id);
      },

      async count() {
        const [rows] = await pool.query('SELECT COUNT(*) AS n FROM games');
        return Number(rows[0].n);
      },

      async remove(id) {
        await pool.query('DELETE FROM games WHERE id = ?', [id]);
      },

      // Both bounds as queries rather than as a pass over everything held in
      // memory, which is the reason this table is worth having.
      async prune({ olderThan = null, keepNewest = null } = {}) {
        let dropped = 0;
        if (Number.isFinite(olderThan)) {
          const [res] = await pool.query(
            'DELETE FROM games WHERE COALESCE(ended_at, touched_at) < ?',
            [olderThan]
          );
          dropped += res.affectedRows || 0;
        }
        if (Number.isFinite(keepNewest)) {
          const [rows] = await pool.query(
            'SELECT id FROM games ORDER BY COALESCE(ended_at, touched_at) DESC, id DESC ' +
              'LIMIT ?, 18446744073709551615',
            [keepNewest]
          );
          for (const r of rows) {
            await pool.query('DELETE FROM games WHERE id = ?', [r.id]);
            dropped++;
          }
        }
        return dropped;
      },
    },

    adminLog: {
      async recent(limit) {
        const [rows] = await pool.query(
          'SELECT id, at, kind, data FROM admin_log ORDER BY at DESC, id DESC LIMIT ?',
          [limit]
        );
        return rows.map((r) => ({
          id: Number(r.id),
          at: num(r.at),
          kind: r.kind,
          ...(unjson(r.data) || {}),
        }));
      },

      async add(rows) {
        const list = (rows || []).filter((row) => row && row.id !== undefined);
        if (!list.length) return;
        for (const row of list) {
          const { id, at, kind, ...rest } = row;
          await pool.query(
            'INSERT INTO admin_log (id, at, kind, data) VALUES (?, ?, ?, ?) ' +
              'ON DUPLICATE KEY UPDATE data = VALUES(data)',
            [id, at, kind || 'server', json(rest)]
          );
        }
      },

      async prune({ olderThan = null, keepNewest = null } = {}) {
        let dropped = 0;
        if (Number.isFinite(olderThan)) {
          const [res] = await pool.query('DELETE FROM admin_log WHERE at < ?', [olderThan]);
          dropped += res.affectedRows || 0;
        }
        if (Number.isFinite(keepNewest)) {
          const [rows] = await pool.query(
            'SELECT id FROM admin_log ORDER BY at DESC, id DESC LIMIT ?, 18446744073709551615',
            [keepNewest]
          );
          for (const r of rows) {
            await pool.query('DELETE FROM admin_log WHERE id = ?', [r.id]);
            dropped++;
          }
        }
        return dropped;
      },

      async count() {
        const [rows] = await pool.query('SELECT COUNT(*) AS n FROM admin_log');
        return Number(rows[0].n);
      },
    },

    accounts: {
      async all() {
        const [accountRows] = await pool.query(
          'SELECT uid, name_key, name, email, password, created_at, verified_at FROM accounts'
        );
        const [pendingRows] = await pool.query(
          'SELECT name_key, uid, name, email, password, token_hash, created_at, expires_at ' +
            'FROM account_pending'
        );
        const [resetRows] = await pool.query(
          'SELECT token_hash, uid, created_at, expires_at FROM account_resets'
        );
        return {
          accounts: accountRows.map((r) => ({
            uid: r.uid,
            key: r.name_key,
            name: r.name,
            email: r.email,
            password: unjson(r.password),
            createdAt: num(r.created_at),
            verifiedAt: num(r.verified_at),
          })),
          pending: pendingRows.map((r) => ({
            key: r.name_key,
            uid: r.uid,
            name: r.name,
            email: r.email,
            password: unjson(r.password),
            tokenHash: r.token_hash,
            createdAt: num(r.created_at),
            expiresAt: num(r.expires_at),
          })),
          resets: resetRows.map((r) => ({
            tokenHash: r.token_hash,
            uid: r.uid,
            createdAt: num(r.created_at),
            expiresAt: num(r.expires_at),
          })),
        };
      },

      // Update first, insert only if there was nothing to update. Deliberately
      // not an ON DUPLICATE KEY UPDATE: the duplicate key that matters here is
      // the unique name, and ON DUPLICATE would quietly rewrite the row that
      // already holds it - which is a second person taking somebody's account
      // rather than being refused. Both of these statements are checked
      // against the unique index, so the answer to a name already taken is an
      // error, which is what it should be.
      async put(account) {
        const values = [
          account.key,
          account.name,
          account.email,
          json(account.password),
          account.verifiedAt || null,
        ];
        const [updated] = await pool.query(
          'UPDATE accounts SET name_key = ?, name = ?, email = ?, password = ?, ' +
            'verified_at = ? WHERE uid = ?',
          [...values, account.uid]
        );
        if (updated.affectedRows > 0) return;
        await pool.query(
          'INSERT INTO accounts (uid, name_key, name, email, password, created_at, ' +
            'verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [
            account.uid,
            account.key,
            account.name,
            account.email,
            json(account.password),
            account.createdAt || Date.now(),
            account.verifiedAt || null,
          ]
        );
      },
      async remove(uid) {
        await pool.query('DELETE FROM accounts WHERE uid = ?', [uid]);
      },
      // A pending sign-up is a hold rather than ownership, and replacing your
      // own is the ordinary way to change the password you are setting. Who
      // may hold a name is decided by the accounts module before it gets here.
      async putPending(row) {
        await pool.query(
          'INSERT INTO account_pending (name_key, uid, name, email, password, token_hash, ' +
            'created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
            'ON DUPLICATE KEY UPDATE uid = VALUES(uid), name = VALUES(name), ' +
            'email = VALUES(email), password = VALUES(password), ' +
            'token_hash = VALUES(token_hash), created_at = VALUES(created_at), ' +
            'expires_at = VALUES(expires_at)',
          [
            row.key,
            row.uid,
            row.name,
            row.email,
            json(row.password),
            row.tokenHash,
            row.createdAt,
            row.expiresAt,
          ]
        );
      },
      async removePending(key) {
        await pool.query('DELETE FROM account_pending WHERE name_key = ?', [key]);
      },
      async putReset(row) {
        await pool.query(
          'INSERT INTO account_resets (token_hash, uid, created_at, expires_at) ' +
            'VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE expires_at = VALUES(expires_at)',
          [row.tokenHash, row.uid, row.createdAt, row.expiresAt]
        );
      },
      async removeReset(tokenHash) {
        await pool.query('DELETE FROM account_resets WHERE token_hash = ?', [tokenHash]);
      },
      async count() {
        const [rows] = await pool.query('SELECT COUNT(*) AS n FROM accounts');
        return Number(rows[0].n);
      },
    },
  };
}

module.exports = { createMariaDatabase };

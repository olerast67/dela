import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

/**
 * Миграции применяются по порядку при старте; номер последней хранится в PRAGMA user_version.
 * Уже выпущенные миграции не меняются, только добавляются новые.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value BLOB NOT NULL
  ) STRICT;

  CREATE TABLE users (
    id         TEXT PRIMARY KEY,
    email      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    auth_salt  BLOB NOT NULL,
    auth_hash  BLOB NOT NULL,
    bundle     TEXT NOT NULL,
    is_admin   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE devices (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    revoked_at   INTEGER
  ) STRICT;
  CREATE INDEX devices_user ON devices(user_id);

  CREATE TABLE sessions (
    token_hash BLOB PRIMARY KEY,
    device_id  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX sessions_device ON sessions(device_id);

  CREATE TABLE invites (
    code_hash  BLOB PRIMARY KEY,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_by    TEXT REFERENCES users(id) ON DELETE SET NULL
  ) STRICT;

  CREATE TABLE spaces (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('personal', 'shared')),
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seq   INTEGER NOT NULL DEFAULT 0
  ) STRICT;

  CREATE TABLE members (
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role     TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    key_kind TEXT NOT NULL CHECK (key_kind IN ('wrapped', 'sealed')),
    key      TEXT NOT NULL,
    PRIMARY KEY (space_id, user_id)
  ) STRICT;
  CREATE INDEX members_user ON members(user_id);

  CREATE TABLE envelopes (
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    slot     TEXT NOT NULL,
    hlc      TEXT NOT NULL,
    payload  BLOB NOT NULL,
    seq      INTEGER NOT NULL,
    PRIMARY KEY (space_id, slot)
  ) STRICT, WITHOUT ROWID;
  CREATE UNIQUE INDEX envelopes_seq ON envelopes(space_id, seq);
  `,
  `
  ALTER TABLE users ADD COLUMN recovery_salt BLOB;
  ALTER TABLE users ADD COLUMN recovery_hash BLOB;
  `,
  `
  CREATE TABLE push_subscriptions (
    device_id  TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE push_schedule (
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    id        TEXT NOT NULL,
    fire_at   INTEGER NOT NULL,
    payload   TEXT NOT NULL,
    PRIMARY KEY (device_id, id)
  ) STRICT;
  CREATE INDEX push_schedule_fire ON push_schedule(fire_at);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  migrate(db, path);
  return db;
}

function migrate(db: Db, path: string): void {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (current > MIGRATIONS.length) {
    throw new Error(`database schema v${current} is newer than this server (v${MIGRATIONS.length})`);
  }
  if (current === MIGRATIONS.length) return;
  if (current > 0 && path !== ':memory:') {
    // Копия перед миграцией: если новая версия окажется плохой, можно откатиться.
    const backup = `${path}.before-v${MIGRATIONS.length}-${Date.now()}.bak`;
    db.prepare('VACUUM INTO ?').run(backup);
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/** Транзакция с блокировкой на запись с самого начала. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

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
  `
  ALTER TABLE users ADD COLUMN totp_secret TEXT;
  ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN totp_last INTEGER;
  `,
  `
  -- Версия ключа общего пространства: растёт при смене ключа после удаления участника.
  ALTER TABLE spaces ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1;
  `,
  `
  -- Файлы в комментариях: только шифротекст, ключ файла лежит в зашифрованной записи комментария.
  CREATE TABLE files (
    space_id   TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    id         TEXT NOT NULL,
    size       INTEGER NOT NULL,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    data       BLOB NOT NULL,
    PRIMARY KEY (space_id, id)
  ) STRICT;
  `,
  `
  -- Passkey: открытый ключ WebAuthn для входа и мастер-ключ, обёрнутый секретом PRF (сервер его открыть не может).
  CREATE TABLE passkeys (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    public_key     BLOB NOT NULL,
    counter        INTEGER NOT NULL,
    transports     TEXT NOT NULL,
    wrapped_master TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    last_used_at   INTEGER
  ) STRICT;
  CREATE INDEX passkeys_user ON passkeys(user_id);
  `,
  `
  -- Смена ключа общего пространства по шагам: конверты с новым ключом копятся здесь до commit.
  CREATE TABLE rotations (
    id          TEXT PRIMARY KEY,
    space_id    TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    key_version INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE rotation_envelopes (
    rotation_id TEXT NOT NULL REFERENCES rotations(id) ON DELETE CASCADE,
    slot        TEXT NOT NULL,
    hlc         TEXT NOT NULL,
    payload     BLOB NOT NULL,
    PRIMARY KEY (rotation_id, slot)
  ) STRICT, WITHOUT ROWID;
  `,
  `
  -- Отметка использования приглашения: used_by обнуляется при удалении аккаунта, used_at остаётся.
  ALTER TABLE invites ADD COLUMN used_at INTEGER;
  UPDATE invites SET used_at = created_at WHERE used_by IS NOT NULL;
  `,
  `
  -- Восстановление по ключу просит код TOTP, если владелец включил эту настройку.
  ALTER TABLE users ADD COLUMN recovery_totp INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Открытый ключ подписи комментариев (Ed25519). Секрет выводится на устройствах из мастер-ключа.
  ALTER TABLE users ADD COLUMN sign_key TEXT;
  `,
  `
  -- Телефон (kind = 'phone') принимает напоминания, которые положили в его расписание другие устройства аккаунта.
  ALTER TABLE push_subscriptions ADD COLUMN kind TEXT NOT NULL DEFAULT 'web';
  -- Минуты до срока, которые выбраны на этом устройстве: JSON-массив чисел.
  ALTER TABLE push_subscriptions ADD COLUMN offsets TEXT;
  `,
  `
  -- Большие файлы по частям: у них parts > 0, а data пустой. Пока загрузка не закончена, complete = 0,
  -- размер (весь шифротекст) уже занят в квоте; touched_at — время последней части, по нему брошенные загрузки удаляются.
  ALTER TABLE files ADD COLUMN parts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE files ADD COLUMN complete INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE files ADD COLUMN touched_at INTEGER;
  CREATE INDEX files_pending ON files(touched_at) WHERE complete = 0;
  CREATE TABLE file_parts (
    space_id TEXT NOT NULL,
    file_id  TEXT NOT NULL,
    idx      INTEGER NOT NULL,
    data     BLOB NOT NULL,
    PRIMARY KEY (space_id, file_id, idx),
    FOREIGN KEY (space_id, file_id) REFERENCES files(space_id, id) ON DELETE CASCADE
  ) STRICT;
  `,
  `
  -- Сколько байт шифротекста синхронизации лежит в пространстве: квота DELA_MAX_SYNC_MB_PER_SPACE.
  -- Счётчик ведут триггеры, поэтому он верен при любой записи, замене и удалении, в том числе при смене ключа.
  ALTER TABLE spaces ADD COLUMN sync_bytes INTEGER NOT NULL DEFAULT 0;
  UPDATE spaces SET sync_bytes = (SELECT coalesce(sum(length(payload)), 0) FROM envelopes WHERE envelopes.space_id = spaces.id);
  CREATE TRIGGER envelopes_bytes_insert AFTER INSERT ON envelopes BEGIN
    UPDATE spaces SET sync_bytes = sync_bytes + length(NEW.payload) WHERE id = NEW.space_id;
  END;
  CREATE TRIGGER envelopes_bytes_update AFTER UPDATE OF payload ON envelopes BEGIN
    UPDATE spaces SET sync_bytes = sync_bytes - length(OLD.payload) + length(NEW.payload) WHERE id = NEW.space_id;
  END;
  CREATE TRIGGER envelopes_bytes_delete AFTER DELETE ON envelopes BEGIN
    UPDATE spaces SET sync_bytes = sync_bytes - length(OLD.payload) WHERE id = OLD.space_id;
  END;
  -- Квота файлов на аккаунт (DELA_MAX_FILE_MB_PER_USER) считается по тому, кто загрузил.
  CREATE INDEX files_by_user ON files(created_by);
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

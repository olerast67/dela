import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, openDb } from '../src/db.ts';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('миграция файлов по частям', () => {
  it('старые файлы остаются целыми и законченными, перед миграцией делается копия базы', () => {
    dir = mkdtempSync(join(tmpdir(), 'dela-migrate-'));
    const path = join(dir, 'dela.sqlite');
    // База прошлой версии: схема без частей файлов и один старый файл.
    const first = openDb(path);
    // Миграция счётчика байт идёт после неё и тоже снимается.
    first.exec(`
      DROP TRIGGER envelopes_bytes_insert;
      DROP TRIGGER envelopes_bytes_update;
      DROP TRIGGER envelopes_bytes_delete;
      DROP INDEX files_by_user;
      ALTER TABLE spaces DROP COLUMN sync_bytes;
      DROP TABLE file_parts;
      DROP INDEX files_pending;
      ALTER TABLE files DROP COLUMN parts;
      ALTER TABLE files DROP COLUMN complete;
      ALTER TABLE files DROP COLUMN touched_at;
      PRAGMA user_version = ${SCHEMA_VERSION - 2};
    `);
    first.prepare("INSERT INTO users (id, email, auth_salt, auth_hash, bundle, created_at) VALUES ('u', 'a@x.yz', x'00', x'00', '{}', 1)").run();
    first.prepare("INSERT INTO spaces (id, kind, created_by, created_at) VALUES ('s', 'personal', 'u', 1)").run();
    first.prepare("INSERT INTO files (space_id, id, size, created_by, created_at, data) VALUES ('s', 'f', 3, 'u', 1, x'010203')").run();
    first.close();

    const db = openDb(path);
    expect(Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(SCHEMA_VERSION);
    expect(db.prepare("SELECT size, parts, complete, data FROM files WHERE id = 'f'").get()).toEqual({ size: 3, parts: 0, complete: 1, data: new Uint8Array([1, 2, 3]) });
    db.close();
    expect(readdirSync(dir).some((f) => f.startsWith(`dela.sqlite.before-v${SCHEMA_VERSION}-`))).toBe(true);
    // Копия открывается и хранит старую схему.
    const backup = readdirSync(dir).find((f) => f.endsWith('.bak'))!;
    const old = new DatabaseSync(join(dir, backup));
    expect(Number((old.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(SCHEMA_VERSION - 2);
    old.close();
  });

  it('счётчик байт синхронизации заполняется для уже лежащих конвертов', () => {
    dir = mkdtempSync(join(tmpdir(), 'dela-migrate-'));
    const path = join(dir, 'dela.sqlite');
    const first = openDb(path);
    first.exec(`
      DROP TRIGGER envelopes_bytes_insert;
      DROP TRIGGER envelopes_bytes_update;
      DROP TRIGGER envelopes_bytes_delete;
      DROP INDEX files_by_user;
      ALTER TABLE spaces DROP COLUMN sync_bytes;
      PRAGMA user_version = ${SCHEMA_VERSION - 1};
    `);
    first.prepare("INSERT INTO users (id, email, auth_salt, auth_hash, bundle, created_at) VALUES ('u', 'a@x.yz', x'00', x'00', '{}', 1)").run();
    first.prepare("INSERT INTO spaces (id, kind, created_by, created_at) VALUES ('s', 'personal', 'u', 1)").run();
    first.prepare("INSERT INTO envelopes (space_id, slot, hlc, payload, seq) VALUES ('s', 'a', 'h', x'0102030405', 1), ('s', 'b', 'h', x'0102', 2)").run();
    first.close();

    const db = openDb(path);
    expect(Number((db.prepare("SELECT sync_bytes AS n FROM spaces WHERE id = 's'").get() as { n: number }).n)).toBe(7);
    // Дальше счётчик ведут триггеры.
    db.prepare("UPDATE envelopes SET payload = x'01' WHERE slot = 'a'").run();
    db.prepare("DELETE FROM envelopes WHERE slot = 'b'").run();
    expect(Number((db.prepare("SELECT sync_bytes AS n FROM spaces WHERE id = 's'").get() as { n: number }).n)).toBe(1);
    db.close();
  });
});

import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { rotate, snapshot } from '../src/backup.ts';
import { openDb } from '../src/db.ts';

describe('резервные копии', () => {
  it('снимок открывается как база и содержит данные', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dela-backup-'));
    const db = openDb(join(dir, 'dela.sqlite'));
    db.prepare("INSERT INTO meta (key, value) VALUES ('x', x'79')").run();
    const path = snapshot(db, join(dir, 'backups'), new Date('2026-10-13T00:00:00Z'));
    expect(path.endsWith('dela-2026-10-13.sqlite')).toBe(true);
    const copy = new DatabaseSync(path, { readOnly: true });
    expect(copy.prepare("SELECT value FROM meta WHERE key = 'x'").get()).toEqual({ value: new Uint8Array([0x79]) });
    copy.close();
    db.close();
  });

  it('ротация оставляет последние снимки', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dela-rotate-'));
    for (const d of ['01', '02', '03', '04']) writeFileSync(join(dir, `dela-2026-10-${d}.sqlite`), '');
    writeFileSync(join(dir, 'other.txt'), '');
    expect(rotate(dir, 2)).toEqual(['dela-2026-10-01.sqlite', 'dela-2026-10-02.sqlite']);
    expect(readdirSync(dir).sort()).toEqual(['dela-2026-10-03.sqlite', 'dela-2026-10-04.sqlite', 'other.txt']);
    expect(existsSync(join(dir, 'other.txt'))).toBe(true);
  });
});

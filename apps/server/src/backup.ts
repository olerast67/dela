import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db.ts';

/** Снимок базы через VACUUM INTO: согласованная копия без остановки сервера. */
export function snapshot(db: Db, dir: string, now = new Date()): string {
  mkdirSync(dir, { recursive: true });
  const name = `dela-${now.toISOString().slice(0, 10)}.sqlite`;
  const path = join(dir, name);
  rmSync(path, { force: true });
  db.prepare('VACUUM INTO ?').run(path);
  return path;
}

/** Оставить keep последних снимков. */
export function rotate(dir: string, keep: number): string[] {
  const files = readdirSync(dir)
    .filter((f) => /^dela-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f))
    .sort();
  const removed = files.slice(0, Math.max(0, files.length - keep));
  for (const f of removed) rmSync(join(dir, f), { force: true });
  return removed;
}

/** Снимок раз в сутки и при запуске, если сегодняшнего ещё нет. */
export function scheduleBackups(db: Db, dir: string, keep: number): () => void {
  const run = () => {
    try {
      snapshot(db, dir);
      rotate(dir, keep);
    } catch (err) {
      console.error('backup failed', err);
    }
  };
  run();
  const timer = setInterval(run, 24 * 3600 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

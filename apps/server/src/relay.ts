import type { Envelope, PullResult, StoredEnvelope } from '#core';
import { tx, type Db } from './db.ts';

/**
 * Журнал конвертов в SQLite. Правила те же, что у эталона MemoryRelay в ядре;
 * совпадение проверяет дифференциальный тест.
 */
export class SqliteRelay {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Принять пачку конвертов пространства. Возвращает число принятых и последний seq. */
  push(spaceId: string, envelopes: readonly Envelope<string>[]): { accepted: number; seq: number } {
    const getExisting = this.db.prepare('SELECT hlc FROM envelopes WHERE space_id = ? AND slot = ?');
    const upsert = this.db.prepare(
      `INSERT INTO envelopes (space_id, slot, hlc, payload, seq) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (space_id, slot) DO UPDATE SET hlc = excluded.hlc, payload = excluded.payload, seq = excluded.seq`,
    );
    return tx(this.db, () => {
      const row = this.db.prepare('SELECT last_seq FROM spaces WHERE id = ?').get(spaceId) as
        | { last_seq: number }
        | undefined;
      if (!row) throw new Error(`unknown space: ${spaceId}`);
      let seq = Number(row.last_seq);
      let accepted = 0;
      for (const env of envelopes) {
        const existing = getExisting.get(spaceId, env.slot) as { hlc: string } | undefined;
        if (existing && existing.hlc >= env.hlc) continue;
        seq++;
        upsert.run(spaceId, env.slot, env.hlc, Buffer.from(env.payload, 'base64'), seq);
        accepted++;
      }
      if (accepted > 0) this.db.prepare('UPDATE spaces SET last_seq = ? WHERE id = ?').run(seq, spaceId);
      return { accepted, seq };
    });
  }

  pull(spaceId: string, since: number, limit: number): PullResult<string> {
    const rows = this.db
      .prepare(
        'SELECT seq, slot, hlc, payload FROM envelopes WHERE space_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      )
      .all(spaceId, since, limit + 1) as Array<{ seq: number; slot: string; hlc: string; payload: Uint8Array }>;
    const more = rows.length > limit;
    const envelopes: StoredEnvelope<string>[] = rows.slice(0, limit).map((r) => ({
      seq: Number(r.seq),
      slot: r.slot,
      hlc: r.hlc,
      payload: Buffer.from(r.payload).toString('base64'),
    }));
    const cursor = envelopes.length > 0 ? envelopes[envelopes.length - 1]!.seq : since;
    return { envelopes, cursor, more };
  }
}

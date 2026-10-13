/** Дифференциальный тест: журнал на SQLite ведёт себя так же, как эталон из ядра. */
import { describe, expect, it } from 'vitest';
import { MemoryRelay, formatTimestamp, type Envelope } from '#core';
import { openDb } from '../src/db.ts';
import { SqliteRelay } from '../src/relay.ts';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setup(): { relay: SqliteRelay; space: string } {
  const db = openDb(':memory:');
  db.prepare(
    "INSERT INTO users (id, email, auth_salt, auth_hash, bundle, created_at) VALUES ('u', 'u@x.y', x'00', x'00', '{}', 0)",
  ).run();
  const space = '00000000-0000-7000-8000-000000000001';
  db.prepare("INSERT INTO spaces (id, kind, created_by, created_at) VALUES (?, 'personal', 'u', 0)").run(space);
  return { relay: new SqliteRelay(db), space };
}

describe('SqliteRelay против MemoryRelay', () => {
  for (let seed = 1; seed <= 20; seed++) {
    it(`seed ${seed}`, () => {
      const rnd = mulberry32(seed);
      const mem = new MemoryRelay<string>();
      const { relay, space } = setup();
      const slots = Array.from({ length: 15 }, (_, i) => i.toString(16).padStart(32, '0'));
      let cursorMem = 0;
      let cursorSql = 0;
      for (let step = 0; step < 400; step++) {
        if (rnd() < 0.6) {
          const batch: Envelope<string>[] = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => ({
            slot: slots[Math.floor(rnd() * slots.length)]!,
            hlc: formatTimestamp({
              wall: Math.floor(rnd() * 50),
              counter: Math.floor(rnd() * 3),
              node: rnd() < 0.5 ? '000000000000000a' : '000000000000000b',
            }),
            payload: Buffer.from(`p${step}`).toString('base64'),
          }));
          // Одна метка всегда означает одну и ту же операцию.
          const fixed = batch.map((e) => ({ ...e, payload: Buffer.from(`${e.slot}${e.hlc}`).toString('base64') }));
          expect(relay.push(space, fixed).accepted).toBe(mem.push(fixed));
        } else {
          const limit = 1 + Math.floor(rnd() * 6);
          const a = mem.pull(cursorMem, limit);
          const b = relay.pull(space, cursorSql, limit);
          expect(b).toEqual(a);
          cursorMem = a.cursor;
          cursorSql = b.cursor;
        }
      }
      expect(relay.pull(space, 0, 10_000).envelopes.map((e) => [e.slot, e.hlc, e.payload]).sort()).toEqual(
        mem.dump().sort(),
      );
    });
  }

  it('неизвестное пространство', () => {
    const { relay } = setup();
    expect(() => relay.push('nope', [])).toThrow();
  });
});

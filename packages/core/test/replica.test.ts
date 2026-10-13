import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MemoryReplica, formatTimestamp, type Op } from '../src/index.ts';

const opArb: fc.Arbitrary<Op> = fc.record({
  table: fc.constantFrom('task', 'project'),
  record: fc.constantFrom('r1', 'r2', 'r3'),
  field: fc.constantFrom('title', 'due', 'order'),
  value: fc.oneof(fc.string(), fc.integer(), fc.constant(null), fc.boolean()),
  hlc: fc
    .record({
      wall: fc.integer({ min: 0, max: 50 }),
      counter: fc.integer({ min: 0, max: 3 }),
      node: fc.constantFrom('000000000000000a', '000000000000000b', '000000000000000c'),
    })
    .map(formatTimestamp),
});

/** Одна метка соответствует одной операции: убираем случайные дубли меток с разными значениями. */
function uniqueByHlc(ops: Op[]): Op[] {
  const seen = new Set<string>();
  return ops.filter((op) => (seen.has(op.hlc) ? false : (seen.add(op.hlc), true)));
}

describe('MemoryReplica', () => {
  it('результат не зависит от порядка применения и повторов', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 60 }).map(uniqueByHlc), fc.nat(), (ops, seed) => {
        const a = new MemoryReplica();
        for (const op of ops) a.apply(op);

        const shuffled = [...ops, ...ops];
        let s = seed;
        for (let i = shuffled.length - 1; i > 0; i--) {
          s = (s * 1103515245 + 12345) % 2 ** 31;
          const j = s % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
        }
        const b = new MemoryReplica();
        for (const op of shuffled) b.apply(op);

        expect(b.dump()).toEqual(a.dump());
      }),
    );
  });

  it('меняет поля независимо', () => {
    const r = new MemoryReplica();
    const t = (wall: number, node = '000000000000000a') => formatTimestamp({ wall, counter: 0, node });
    r.apply({ table: 'task', record: 'x', field: 'title', value: 'Купить хлеб', hlc: t(1) });
    r.apply({ table: 'task', record: 'x', field: 'due', value: '2026-10-14', hlc: t(2, '000000000000000b') });
    r.apply({ table: 'task', record: 'x', field: 'title', value: 'Старое', hlc: t(0, '000000000000000b') });
    expect(r.get('task', 'x')).toEqual({ title: 'Купить хлеб', due: '2026-10-14' });
    expect(r.all('task').size).toBe(1);
    expect(r.get('task', 'nope')).toBeUndefined();
  });
});

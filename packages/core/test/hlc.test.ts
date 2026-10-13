import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CounterOverflowError,
  HybridClock,
  MAX_COUNTER,
  exceedsDrift,
  formatTimestamp,
  isNodeId,
  newNodeId,
  parseTimestamp,
} from '../src/index.ts';

const NODE_A = '00000000000000aa';
const NODE_B = '00000000000000bb';

const timestampArb = fc.record({
  wall: fc.integer({ min: 0, max: 10 ** 15 - 1 }),
  counter: fc.integer({ min: 0, max: MAX_COUNTER }),
  node: fc.stringMatching(/^[0-9a-f]{16}$/),
});

function cmpTuple(a: { wall: number; counter: number; node: string }, b: typeof a): number {
  if (a.wall !== b.wall) return a.wall < b.wall ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.node !== b.node) return a.node < b.node ? -1 : 1;
  return 0;
}

describe('формат метки', () => {
  it('format и parse взаимно обратны', () => {
    fc.assert(
      fc.property(timestampArb, (t) => {
        expect(parseTimestamp(formatTimestamp(t))).toEqual(t);
      }),
    );
  });

  it('строковое сравнение совпадает с логическим порядком', () => {
    fc.assert(
      fc.property(timestampArb, timestampArb, (a, b) => {
        const sa = formatTimestamp(a);
        const sb = formatTimestamp(b);
        const byString = sa === sb ? 0 : sa < sb ? -1 : 1;
        expect(byString).toBe(cmpTuple(a, b));
      }),
    );
  });

  it('отклоняет испорченные метки', () => {
    expect(() => parseTimestamp('123')).toThrow(SyntaxError);
    expect(() => parseTimestamp('000001760000000-000A-00000000000000aa')).toThrow(SyntaxError);
    expect(() => formatTimestamp({ wall: -1, counter: 0, node: NODE_A })).toThrow(RangeError);
    expect(() => formatTimestamp({ wall: 1, counter: MAX_COUNTER + 1, node: NODE_A })).toThrow(RangeError);
    expect(() => formatTimestamp({ wall: 1, counter: 0, node: 'xyz' })).toThrow(RangeError);
  });

  it('newNodeId выдаёт корректные id', () => {
    for (let i = 0; i < 100; i++) expect(isNodeId(newNodeId())).toBe(true);
  });
});

describe('HybridClock', () => {
  it('метки строго растут, даже если время стоит или идёт назад', () => {
    let now = 1_000;
    const clock = new HybridClock(NODE_A, () => now);
    let prev = clock.tick();
    for (let i = 0; i < 1000; i++) {
      if (i % 7 === 0) now -= 50;
      if (i % 11 === 0) now += 3;
      const next = clock.tick();
      expect(next > prev).toBe(true);
      prev = next;
    }
  });

  it('после receive локальная метка больше полученной', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 ** 12 }),
        fc.integer({ min: -100_000, max: 100_000 }),
        fc.integer({ min: 0, max: 1000 }),
        (base, skew, remoteCounter) => {
          const local = new HybridClock(NODE_A, () => base);
          local.tick();
          const remote = formatTimestamp({ wall: Math.max(0, base + skew), counter: remoteCounter, node: NODE_B });
          local.receive(remote);
          expect(local.tick() > remote).toBe(true);
        },
      ),
    );
  });

  it('продолжает с сохранённой метки после перезапуска', () => {
    const now = () => 5_000;
    const first = new HybridClock(NODE_A, now);
    first.tick();
    const last = first.tick();
    const restarted = new HybridClock(NODE_A, () => 4_000, last);
    expect(restarted.tick() > last).toBe(true);
  });

  it('сообщает о переполнении счётчика', () => {
    const last = formatTimestamp({ wall: 10, counter: MAX_COUNTER, node: NODE_A });
    const clock = new HybridClock(NODE_A, () => 10, last);
    expect(() => clock.tick()).toThrow(CounterOverflowError);
  });

  it('отклоняет неверный id устройства', () => {
    expect(() => new HybridClock('not-a-node')).toThrow(RangeError);
  });
});

describe('exceedsDrift', () => {
  it('ловит метки из будущего', () => {
    const ts = formatTimestamp({ wall: 100_000, counter: 0, node: NODE_A });
    expect(exceedsDrift(ts, 30_000, 60_000)).toBe(true);
    expect(exceedsDrift(ts, 50_000, 60_000)).toBe(false);
    expect(exceedsDrift(ts, 200_000, 60_000)).toBe(false);
  });
});

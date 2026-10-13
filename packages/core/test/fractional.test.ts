import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareOrder, isOrderKey, keyBetween, keysBetween } from '../src/index.ts';

function expectStrictlySorted(keys: readonly string[]): void {
  for (let i = 1; i < keys.length; i++) expect(keys[i - 1]! < keys[i]!).toBe(true);
}

describe('keyBetween', () => {
  it('известные значения', () => {
    expect(keyBetween(null, null)).toBe('a0');
    expect(keyBetween('a0', null)).toBe('a1');
    expect(keyBetween(null, 'a0')).toBe('Zz');
    expect(keyBetween('a0', 'a1')).toBe('a0V');
    expect(keyBetween('az', null)).toBe('b00');
  });

  it('отклоняет неверный порядок и испорченные ключи', () => {
    expect(() => keyBetween('a1', 'a0')).toThrow();
    expect(() => keyBetween('a1', 'a1')).toThrow();
    expect(() => keyBetween('a00', null)).toThrow();
    expect(() => keyBetween('a!', null)).toThrow();
    expect(isOrderKey('a0')).toBe(true);
    expect(isOrderKey('a0V')).toBe(true);
    expect(isOrderKey('a0V0')).toBe(false);
  });

  it('случайные вставки сохраняют строгий порядок', () => {
    fc.assert(
      fc.property(fc.array(fc.nat(), { minLength: 1, maxLength: 300 }), (positions) => {
        const keys: string[] = [];
        for (const p of positions) {
          const i = p % (keys.length + 1);
          const key = keyBetween(keys[i - 1] ?? null, keys[i] ?? null);
          expect(isOrderKey(key)).toBe(true);
          keys.splice(i, 0, key);
        }
        expectStrictlySorted(keys);
      }),
    );
  });

  it('добавление в конец и в начало не раздувает ключи', () => {
    let last: string | null = null;
    let first: string | null = null;
    for (let i = 0; i < 10_000; i++) {
      last = keyBetween(last, null);
      first = keyBetween(null, first);
    }
    expect(last!.length).toBeLessThanOrEqual(5);
    expect(first!.length).toBeLessThanOrEqual(5);
  });

  it('вставка всё время в одно место: ключ растёт примерно на символ за 6 вставок', () => {
    // Худший случай: каждая вставка делит промежуток пополам, а символ base62 вмещает ~5.95 бита.
    let a = 'a0';
    const b = 'a1';
    for (let i = 0; i < 1000; i++) a = keyBetween(a, b);
    expect(a.length).toBeLessThan(1000 / 5 + 10);
  });
});

describe('keysBetween', () => {
  it('выдаёт n упорядоченных ключей внутри интервала', () => {
    for (const [a, b] of [
      [null, null],
      ['a0', null],
      [null, 'a0'],
      ['a0', 'a1'],
    ] as const) {
      for (const n of [0, 1, 2, 7, 50]) {
        const keys = keysBetween(a, b, n);
        expect(keys).toHaveLength(n);
        expectStrictlySorted([...(a ? [a] : []), ...keys, ...(b ? [b] : [])]);
      }
    }
  });
});

describe('compareOrder', () => {
  it('при равных ключах упорядочивает по id', () => {
    const items = [
      { order: 'a1', id: 'b' },
      { order: 'a1', id: 'a' },
      { order: 'a0', id: 'z' },
    ];
    expect(items.sort(compareOrder).map((x) => x.id)).toEqual(['z', 'a', 'b']);
  });
});

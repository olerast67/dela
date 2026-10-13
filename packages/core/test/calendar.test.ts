import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { layoutDay, monthGrid, moveDue, slotOf, snapMinute, weekDates, weekStart } from '../src/index.ts';

describe('календарь', () => {
  it('неделя с понедельника', () => {
    expect(weekStart('2026-10-13')).toBe('2026-10-12');
    expect(weekStart('2026-10-18')).toBe('2026-10-12');
    expect(weekStart('2026-10-19')).toBe('2026-10-19');
    expect(weekDates('2026-10-15')).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
  });

  it('сетка месяца: 42 дня, начинается с понедельника и содержит 1-е и последнее число', () => {
    const g = monthGrid('2026-02-20');
    expect(g).toHaveLength(42);
    expect(g[0]).toBe('2026-01-26');
    expect(g).toContain('2026-02-01');
    expect(g).toContain('2026-02-28');
    // Месяц, который начинается в понедельник, стоит с первой клетки.
    expect(monthGrid('2027-02-10')[0]).toBe('2027-02-01');
  });

  it('место задачи в сетке часов', () => {
    expect(slotOf({ date: '2026-10-13' }, 'Europe/Moscow')).toBeNull();
    expect(slotOf({ date: '2026-10-13', time: '09:30' }, 'Europe/Moscow')).toEqual({ date: '2026-10-13', minute: 570 });
    // В октябре до перевода часов Берлин UTC+2, Москва UTC+3: 00:30 по Москве это 23:30 накануне в Берлине.
    expect(slotOf({ date: '2026-10-13', time: '00:30', tz: 'Europe/Moscow' }, 'Europe/Berlin')).toEqual({ date: '2026-10-12', minute: 23 * 60 + 30 });
  });

  it('перенос в сетку часов и на день', () => {
    const tz = 'Europe/Moscow';
    expect(moveDue(null, '2026-10-14', 600, tz)).toEqual({ date: '2026-10-14', time: '10:00' });
    expect(moveDue({ date: '2026-10-13', time: '09:00' }, '2026-10-15', null, tz)).toEqual({ date: '2026-10-15', time: '09:00' });
    expect(moveDue({ date: '2026-10-13' }, '2026-10-15', null, tz)).toEqual({ date: '2026-10-15' });
    // Фиксированный пояс сохраняется, время пересчитывается.
    expect(moveDue({ date: '2026-10-13', time: '12:00', tz: 'Europe/Berlin' }, '2026-10-14', 15 * 60, tz)).toEqual({
      date: '2026-10-14',
      time: '14:00',
      tz: 'Europe/Berlin',
    });
    expect(moveDue({ date: '2026-10-13', time: '23:30', tz: 'Europe/Moscow' }, '2026-10-20', null, 'Europe/Berlin')).toEqual({
      date: '2026-10-20',
      time: '23:30',
      tz: 'Europe/Moscow',
    });
  });

  it('шаг 15 минут в пределах суток', () => {
    expect(snapMinute(607)).toBe(600);
    expect(snapMinute(608)).toBe(615);
    expect(snapMinute(-20)).toBe(0);
    expect(snapMinute(24 * 60 + 5)).toBe(24 * 60 - 15);
  });

  it('раскладка: пересекающиеся задачи рядом, непересекающиеся во всю ширину', () => {
    const placed = layoutDay([
      { id: 'a', start: 540, end: 600 },
      { id: 'b', start: 570, end: 630 },
      { id: 'c', start: 600, end: 660 },
      { id: 'd', start: 720, end: 750 },
    ]);
    const by = Object.fromEntries(placed.map((p) => [p.id, p]));
    expect(by.a).toMatchObject({ col: 0, cols: 2 });
    expect(by.b).toMatchObject({ col: 1, cols: 2 });
    expect(by.c).toMatchObject({ col: 0, cols: 2 });
    expect(by.d).toMatchObject({ col: 0, cols: 1 });
  });

  it('раскладка: в одной колонке задачи не пересекаются', () => {
    const item = fc.record({ start: fc.integer({ min: 0, max: 1400 }), len: fc.integer({ min: 15, max: 240 }) });
    fc.assert(
      fc.property(fc.array(item, { maxLength: 30 }), (raw) => {
        const items = raw.map((r, i) => ({ id: `t${i}`, start: r.start, end: r.start + r.len }));
        const placed = layoutDay(items);
        expect(placed).toHaveLength(items.length);
        for (const p of placed) {
          expect(p.col).toBeLessThan(p.cols);
          for (const q of placed) {
            if (p.id !== q.id && p.col === q.col && p.cols === q.cols) {
              expect(p.end <= q.start || q.end <= p.start).toBe(true);
            }
          }
        }
      }),
    );
  });
});

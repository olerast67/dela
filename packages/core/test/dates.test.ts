import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  daysBetween,
  instant,
  isDate,
  isDateSpec,
  isoWeekday,
  localDate,
  today,
  wallClock,
  zonedToUtc,
} from '../src/index.ts';

describe('даты', () => {
  it('проверка формата', () => {
    expect(isDate('2026-02-28')).toBe(true);
    expect(isDate('2026-02-29')).toBe(false);
    expect(isDate('2028-02-29')).toBe(true);
    expect(isDate('2026-13-01')).toBe(false);
    expect(isDate('26-01-01')).toBe(false);
    expect(isDateSpec({ date: '2026-10-13', time: '09:00' })).toBe(true);
    expect(isDateSpec({ date: '2026-10-13', time: '24:00' })).toBe(false);
    expect(isDateSpec({ date: '2026-10-13', tz: 'Europe/Moscow' })).toBe(false);
    expect(isDateSpec({ date: '2026-10-13', time: '15:00', tz: 'Mars/Base' })).toBe(false);
  });

  it('арифметика', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-10-13', '2026-10-20')).toBe(7);
    expect(isoWeekday('2026-10-12')).toBe(1);
    expect(isoWeekday('2026-10-18')).toBe(7);
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-01-31', 13)).toBe('2027-02-28');
    expect(addMonths('2026-03-15', -3)).toBe('2025-12-15');
  });

  it('часовые пояса', () => {
    // 15:00 по Москве (UTC+3) — это 12:00 UTC.
    expect(new Date(zonedToUtc('2026-10-13', '15:00', 'Europe/Moscow')).toISOString()).toBe('2026-10-13T12:00:00.000Z');
    // Летнее время в Берлине начинается 29 марта 2026 в 02:00: 02:30 не существует, сдвигается вперёд.
    expect(new Date(zonedToUtc('2026-03-29', '02:30', 'Europe/Berlin')).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(new Date(zonedToUtc('2026-07-01', '09:00', 'Europe/Berlin')).toISOString()).toBe('2026-07-01T07:00:00.000Z');
    expect(wallClock(Date.UTC(2026, 9, 13, 22, 30), 'Asia/Novosibirsk')).toEqual({ date: '2026-10-14', time: '05:30' });
    expect(today('Asia/Tokyo', Date.UTC(2026, 9, 13, 20, 0))).toBe('2026-10-14');
  });

  it('срок с фиксированным поясом попадает в правильный день пользователя', () => {
    const call = { date: '2026-10-13', time: '23:30', tz: 'Europe/Moscow' };
    expect(localDate(call, 'Europe/Moscow')).toBe('2026-10-13');
    expect(localDate(call, 'Asia/Novosibirsk')).toBe('2026-10-14');
    expect(localDate({ date: '2026-10-13', time: '23:30' }, 'Asia/Novosibirsk')).toBe('2026-10-13');
    expect(instant({ date: '2026-10-13' }, 'UTC')).toBe(Date.UTC(2026, 9, 13, 23, 59));
  });
});

import { describe, expect, it } from 'vitest';
import { describeRule, formatRule, parseRule, parseTask, type Rule } from '../src/index.ts';

const r = (s: string): Rule => {
  const rule = parseRule(s);
  if (!rule) throw new Error(`bad rule ${s}`);
  return rule;
};

describe('правило словами', () => {
  it('по-русски', () => {
    const cases: Array<[string, string]> = [
      ['FREQ=DAILY', 'каждый день'],
      ['FREQ=DAILY;INTERVAL=3', 'каждые 3 дня'],
      ['FREQ=DAILY;INTERVAL=5', 'каждые 5 дней'],
      ['FREQ=DAILY;INTERVAL=21', 'каждый 21 день'],
      ['FREQ=WEEKLY;BYDAY=MO', 'каждый понедельник'],
      ['FREQ=WEEKLY;BYDAY=WE,MO', 'каждый понедельник и среду'],
      ['FREQ=WEEKLY;BYDAY=FR', 'каждую пятницу'],
      ['FREQ=WEEKLY;BYDAY=SU', 'каждое воскресенье'],
      ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'по будням'],
      ['FREQ=WEEKLY;BYDAY=SA,SU', 'по выходным'],
      ['FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR', 'каждые 2 недели по понедельникам и пятницам'],
      ['FREQ=WEEKLY;INTERVAL=2', 'каждые 2 недели'],
      ['FREQ=MONTHLY;BYMONTHDAY=15', 'каждое 15 число'],
      ['FREQ=MONTHLY;BYMONTHDAY=-1', 'каждый последний день месяца'],
      ['FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1', 'каждые 3 месяца, 1 числа'],
      ['FREQ=MONTHLY;BYDAY=2TU', 'каждый второй вторник месяца'],
      ['FREQ=MONTHLY;BYDAY=-1FR', 'каждую последнюю пятницу месяца'],
      ['FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=15', 'каждое 15 ноября'],
      ['FREQ=YEARLY;INTERVAL=5;BYMONTH=3;BYMONTHDAY=8', 'каждые 5 лет, 8 марта'],
      ['FREQ=DAILY;UNTIL=20261231', 'каждый день до 31 декабря 2026'],
    ];
    for (const [rule, text] of cases) expect(describeRule(r(rule), 'ru'), rule).toBe(text);
  });

  it('по-английски', () => {
    const cases: Array<[string, string]> = [
      ['FREQ=DAILY', 'every day'],
      ['FREQ=DAILY;INTERVAL=3', 'every 3 days'],
      ['FREQ=WEEKLY;BYDAY=MO,WE', 'every Monday and Wednesday'],
      ['FREQ=WEEKLY;BYDAY=MO,WE,FR', 'every Monday, Wednesday and Friday'],
      ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'every weekday'],
      ['FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', 'every 2 weeks on Tuesday'],
      ['FREQ=MONTHLY;BYMONTHDAY=1', 'every 1st'],
      ['FREQ=MONTHLY;BYMONTHDAY=22', 'every 22nd'],
      ['FREQ=MONTHLY;BYMONTHDAY=11', 'every 11th'],
      ['FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=-1', 'every 2 months, on the last day'],
      ['FREQ=MONTHLY;BYDAY=2TU', 'every second Tuesday of the month'],
      ['FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=15', 'every November 15'],
      ['FREQ=WEEKLY;BYDAY=FR;UNTIL=20270115', 'every Friday until January 15, 2027'],
    ];
    for (const [rule, text] of cases) expect(describeRule(r(rule), 'en'), rule).toBe(text);
  });

  it('короткие фразы понимает строка быстрого ввода: получается то же правило', () => {
    const ctx = { now: Date.UTC(2026, 9, 14, 9), tz: 'Europe/Moscow' };
    for (const s of [
      'FREQ=DAILY',
      'FREQ=DAILY;INTERVAL=3',
      'FREQ=WEEKLY;BYDAY=MO,WE',
      'FREQ=WEEKLY;BYDAY=FR',
      'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
      'FREQ=MONTHLY;BYMONTHDAY=15',
      'FREQ=MONTHLY;BYMONTHDAY=-1',
      'FREQ=MONTHLY;BYDAY=2TU',
      'FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=15',
    ]) {
      for (const lang of ['ru', 'en'] as const) {
        const parsed = parseTask(describeRule(r(s), lang), ctx);
        expect(parsed.recurrence?.rule, `${s} ${lang}`).toBe(formatRule(r(s)));
      }
    }
  });
});

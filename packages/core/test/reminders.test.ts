import { describe, expect, it } from 'vitest';
import { Doc, HybridClock, digestsBetween, remindersBetween } from '../src/index.ts';

const NOW = Date.UTC(2026, 9, 13, 9, 0); // 12:00 по Москве
const TZ = 'Europe/Moscow';

function doc() {
  return new Doc({ spaceId: '01929c3e-0000-7000-8000-00000000eeee', clock: new HybridClock('00000000000000aa', () => NOW), now: () => NOW, timeZone: TZ });
}

describe('напоминания', () => {
  it('по умолчанию в момент срока, только у задач со временем', () => {
    const d = doc();
    d.createTask({ title: 'Созвон', due: { date: '2026-10-13', time: '15:00' } });
    d.createTask({ title: 'Без времени', due: { date: '2026-10-13' } });
    const r = remindersBetween(d, NOW, NOW + 24 * 3600_000, TZ);
    expect(r.map((x) => [x.title, new Date(x.at).toISOString()])).toEqual([['Созвон', '2026-10-13T12:00:00.000Z']]);
  });

  it('свои смещения, отключение, выполненные не напоминают', () => {
    const d = doc();
    const a = d.createTask({ title: 'A', due: { date: '2026-10-13', time: '15:00' }, reminders: [30, 0] });
    const b = d.createTask({ title: 'B', due: { date: '2026-10-13', time: '16:00' }, reminders: [] });
    const c = d.createTask({ title: 'C', due: { date: '2026-10-13', time: '17:00' } });
    d.completeTask(c);
    void b;
    const r = remindersBetween(d, NOW, NOW + 24 * 3600_000, TZ, [10]);
    expect(r.map((x) => `${x.title}-${x.offset}`)).toEqual(['A-30', 'A-0']);
    expect(r[0]!.key).toBe(`${a}:2026-10-13T15:00:30`);
    expect(remindersBetween(d, NOW + 3 * 3600_000 + 1, NOW + 24 * 3600_000, TZ)).toEqual([]);
  });

  it('испорченный список напоминаний игнорируется', () => {
    const d = doc();
    const id = d.createTask({ title: 'X', due: { date: '2026-10-13', time: '15:00' } });
    d.applyRemote([{ table: 'task', record: id, field: 'reminders', value: [-5, 'a'], hlc: '999999999999999-0000-00000000000000ff' }]);
    expect(d.task(id)?.reminders).toBeNull();
  });
});

describe('утренняя сводка', () => {
  const WEEK = 7 * 24 * 3600_000;

  it('на каждый день с задачами: число на день и просроченных к этому дню', () => {
    const d = doc();
    d.createTask({ title: 'Вчерашняя', due: { date: '2026-10-12' } });
    d.createTask({ title: 'Сегодня', due: { date: '2026-10-13', time: '15:00' } });
    d.createTask({ title: 'Завтра 1', due: { date: '2026-10-14' } });
    d.createTask({ title: 'Завтра 2', due: { date: '2026-10-14' } });
    const done = d.createTask({ title: 'Сделано', due: { date: '2026-10-14' } });
    d.completeTask(done);
    // NOW — 12:00 по Москве: сводка сегодня в 08:00 уже прошла.
    const list = digestsBetween(d, NOW, NOW + WEEK, TZ, '08:00');
    expect(list.map((x) => [x.date, x.today, x.overdue])).toEqual([
      ['2026-10-14', 2, 2],
      // Дальше задач на день нет, но просроченные остаются: сводка всё равно приходит.
      ['2026-10-15', 0, 4],
      ['2026-10-16', 0, 4],
      ['2026-10-17', 0, 4],
      ['2026-10-18', 0, 4],
      ['2026-10-19', 0, 4],
      ['2026-10-20', 0, 4],
    ]);
    expect(list[0]!.key).toBe('digest:2026-10-14');
    expect(new Date(list[0]!.at).toISOString()).toBe('2026-10-14T05:00:00.000Z');
  });

  it('без задач сводки нет; время берётся из настройки', () => {
    const d = doc();
    expect(digestsBetween(d, NOW, NOW + WEEK, TZ, '08:00')).toEqual([]);
    d.createTask({ title: 'Пятница', due: { date: '2026-10-16' } });
    const list = digestsBetween(d, NOW, NOW + WEEK, TZ, '21:30');
    expect(list.map((x) => [x.date, x.today, x.overdue])).toEqual([
      ['2026-10-16', 1, 0],
      ['2026-10-17', 0, 1],
      ['2026-10-18', 0, 1],
      ['2026-10-19', 0, 1],
    ]);
    expect(new Date(list[0]!.at).toISOString()).toBe('2026-10-16T18:30:00.000Z');
    // Сегодняшняя сводка в 21:30 ещё впереди, но на сегодня задач нет.
    expect(list.some((x) => x.date === '2026-10-13')).toBe(false);
  });

  it('ключи сводки не совпадают с ключами напоминаний задач', () => {
    const d = doc();
    d.createTask({ title: 'Созвон', due: { date: '2026-10-14', time: '08:00' } });
    const keys = new Set(remindersBetween(d, NOW, NOW + WEEK, TZ).map((r) => r.key));
    for (const x of digestsBetween(d, NOW, NOW + WEEK, TZ, '08:00')) expect(keys.has(x.key)).toBe(false);
  });
});

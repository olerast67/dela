import { describe, expect, it } from 'vitest';
import { Doc, HybridClock, remindersBetween } from '../src/index.ts';

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

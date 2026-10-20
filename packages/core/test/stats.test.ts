import { describe, expect, it } from 'vitest';
import { computeStats, Doc, HybridClock } from '../src/index.ts';

const SPACE = '01929c3e-0000-7000-8000-0000000000bb';
const at = (iso: string) => Date.parse(iso);
const ev = (iso: string, projectId = 'p') => ({ at: at(iso), projectId });

describe('статистика', () => {
  it('считает по дням, неделям и ставит границу суток по часовому поясу', () => {
    // 2026-10-20 — вторник. 21:30 UTC в Москве (+3) уже 21 октября.
    const events = [ev('2026-10-20T10:00:00Z'), ev('2026-10-20T21:30:00Z'), ev('2026-10-19T09:00:00Z'), ev('2026-10-11T09:00:00Z')];
    const utc = computeStats(events, 'UTC', '2026-10-20');
    expect(utc.today).toBe(2);
    expect(utc.days.at(-1)).toEqual({ date: '2026-10-20', count: 2 });
    expect(utc.days).toHaveLength(28);
    // Неделя с понедельника 19-го: три выполнения; 11 октября — воскресенье прошлой недели.
    expect(utc.thisWeek).toBe(3);
    expect(utc.weeks.at(-1)).toEqual({ start: '2026-10-19', count: 3 });
    expect(utc.weeks.at(-2)).toEqual({ start: '2026-10-12', count: 0 });
    expect(utc.weeks.at(-3)).toEqual({ start: '2026-10-05', count: 1 });
    expect(utc.total).toBe(4);

    const msk = computeStats(events, 'Europe/Moscow', '2026-10-21');
    expect(msk.today).toBe(1);
    expect(msk.days.at(-2)).toEqual({ date: '2026-10-20', count: 1 });
  });

  it('серия: пропуск обрывает, пустой сегодняшний день ещё нет, лучшая сохраняется', () => {
    const events = [
      ...['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'].map((d) => ev(`${d}T12:00:00Z`)),
      ...['2026-10-18', '2026-10-19'].map((d) => ev(`${d}T12:00:00Z`)),
    ];
    const s = computeStats(events, 'UTC', '2026-10-20');
    expect(s.streak).toBe(2); // сегодня пусто, считаем по вчера
    expect(s.bestStreak).toBe(4);
    expect(computeStats(events, 'UTC', '2026-10-21').streak).toBe(0); // вчера тоже пусто
    expect(computeStats([...events, ev('2026-10-20T08:00:00Z')], 'UTC', '2026-10-20').streak).toBe(3);
    expect(computeStats([], 'UTC', '2026-10-20')).toMatchObject({ streak: 0, bestStreak: 0, total: 0, today: 0 });
  });

  it('разбивка по проектам берёт только выбранный период', () => {
    const events = [ev('2026-10-20T08:00:00Z', 'a'), ev('2026-10-19T08:00:00Z', 'b'), ev('2026-10-18T08:00:00Z', 'b'), ev('2026-09-01T08:00:00Z', 'a')];
    expect(computeStats(events, 'UTC', '2026-10-20', { period: 7 }).projects).toEqual([
      { projectId: 'b', count: 2 },
      { projectId: 'a', count: 1 },
    ]);
    expect(computeStats(events, 'UTC', '2026-10-20', { period: 90 }).projects[0]).toEqual({ projectId: 'a', count: 2 });
  });

  it('Doc: каждое выполнение повтора считается, закрытая серия и корзина — как в «Выполненные»', () => {
    let time = at('2026-10-20T09:00:00Z');
    const doc = new Doc({ spaceId: SPACE, clock: new HybridClock('00000000000000bb', () => time), now: () => time, timeZone: 'UTC' });
    const once = doc.createTask({ title: 'Разовая' });
    const trashed = doc.createTask({ title: 'Удалённая' });
    const repeat = doc.createTask({ title: 'Повтор', due: { date: '2026-10-20' }, recurrence: { mode: 'schedule', rule: 'FREQ=DAILY', text: '' } });
    doc.completeTask(once);
    doc.completeTask(trashed);
    doc.deleteTask(trashed);
    doc.completeTask(repeat);
    time += 86_400_000;
    doc.completeTask(repeat);
    const s = doc.stats('UTC', '2026-10-21');
    expect(s.total).toBe(3);
    expect(s.today).toBe(1);
    expect(s.days.at(-2)!.count).toBe(2);
    expect(s.streak).toBe(2);

    // Серия с конечным правилом: закрытие даёт и экземпляр, и выполненную задачу — одно выполнение.
    const fin = doc.createTask({ title: 'Один раз повтор', due: { date: '2026-10-21' }, recurrence: { mode: 'schedule', rule: 'FREQ=DAILY;COUNT=1', text: '' } });
    doc.completeTask(fin);
    expect(doc.stats('UTC', '2026-10-21').total).toBe(4);
  });
});

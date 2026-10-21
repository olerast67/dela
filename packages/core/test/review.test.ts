import { describe, expect, it } from 'vitest';
import { DEFAULT_GAME_SETTINGS, Doc, HybridClock, Workspace, computeWeekReview, lastReview, reviewWeekOf, reviewWeeks, reviewsBetween, type GameSettings } from '../src/index.ts';

const TZ = 'Europe/Moscow';
const SPACE = '01929c3e-0000-7000-8000-00000000bbbb';

// Неделя итогов: понедельник 12 — воскресенье 18 октября 2026.
const MON = '2026-10-12';
const at = (date: string, time = '12:00') => Date.parse(`${date}T${time}:00+03:00`);

function device(node: string, start: number) {
  let time = start;
  const doc = new Doc({ spaceId: SPACE, clock: new HybridClock(node.padStart(16, '0'), () => time), now: () => time, timeZone: TZ });
  return { doc, ws: new Workspace(doc), set: (t: number) => (time = t) };
}

function sync(...docs: Doc[]): void {
  const ops = docs.flatMap((d) => [...d.pending()]);
  for (const d of docs) {
    d.applyRemote(ops);
    d.acknowledge(d.pending());
  }
}

describe('итоги недели', () => {
  it('числа, проекты, давние задачи, не успели и помодоро', () => {
    const { ws, set } = device('a', at('2026-09-20'));
    const work = ws.createProject({ name: 'Работа' });
    // Ждала с 20 сентября, закрыта 14 октября: 24 дня.
    const old = ws.createTask({ title: 'Старая', projectId: work });
    set(at('2026-10-01'));
    const mid = ws.createTask({ title: 'Средняя' });
    const late = ws.createTask({ title: 'Не успела', projectId: work, due: { date: '2026-10-15' } });
    const doneLater = ws.createTask({ title: 'Сделана после недели', due: { date: '2026-10-16' } });
    set(at('2026-10-14'));
    ws.completeTask(old);
    ws.logWork(old, 25);
    ws.logWork(old, 25);
    set(at('2026-10-17'));
    ws.completeTask(mid);
    const quick = ws.createTask({ title: 'Быстрая', projectId: work });
    ws.completeTask(quick);
    // Прошлая неделя: одно выполнение.
    set(at('2026-10-07'));
    // (время назад только для записи: выполнение помечается этим временем)
    const prev = ws.createTask({ title: 'Прошлая неделя' });
    ws.completeTask(prev);
    // Следующая неделя: выполнение «после недели» не делает её успетой.
    set(at('2026-10-20'));
    ws.completeTask(doneLater);
    ws.logWork(mid, 10);

    const r = ws.weekReview(TZ, MON, '2026-10-21');
    expect(r.start).toBe(MON);
    expect(r.end).toBe('2026-10-18');
    expect(r.current).toBe(false);
    expect(r.done).toBe(3);
    expect(r.activeDays).toBe(2);
    expect(r.previous).toBe(1);
    expect(r.projects).toEqual([
      { projectId: work, count: 2 },
      { projectId: ws.inboxId, count: 1 },
    ]);
    expect(r.waited.map((t) => [t.title, t.days])).toEqual([
      ['Старая', 24],
      ['Средняя', 16],
    ]);
    expect(r.missed.count).toBe(2);
    expect(r.missed.tasks.map((t) => [t.id, t.due])).toEqual([
      [late, '2026-10-15'],
      [doneLater, '2026-10-16'],
    ]);
    expect(r.work).toEqual({ minutes: 50, sessions: 2 });
    expect(r.goals).toBeNull();
  });

  it('граница недели по часовому поясу, как у статистики', () => {
    const { ws, set } = device('a', at('2026-10-10'));
    const a = ws.createTask({ title: 'Воскресенье поздно' });
    const b = ws.createTask({ title: 'Понедельник рано' });
    // 18 октября 23:30 по Москве — ещё неделя 12–18; в UTC это 20:30.
    set(Date.parse('2026-10-18T20:30:00Z'));
    ws.completeTask(a);
    // 19 октября 00:30 по Москве — уже следующая неделя, хотя в UTC ещё 18-е.
    set(Date.parse('2026-10-18T21:30:00Z'));
    ws.completeTask(b);
    expect(ws.weekReview(TZ, MON, '2026-10-21').done).toBe(1);
    expect(ws.weekReview(TZ, '2026-10-19', '2026-10-21').done).toBe(1);
    // В UTC обе — 18-е.
    expect(ws.weekReview('UTC', MON, '2026-10-21').done).toBe(2);
  });

  it('текущая неделя: итоги на сегодня, сегодняшние задачи ещё не «не успели»', () => {
    const { ws, set } = device('a', at('2026-10-19'));
    ws.createTask({ title: 'Вчера', due: { date: '2026-10-20' } });
    ws.createTask({ title: 'Сегодня', due: { date: '2026-10-21' } });
    set(at('2026-10-21'));
    const r = ws.weekReview(TZ, '2026-10-19', '2026-10-21');
    expect(r.current).toBe(true);
    expect(r.missed.tasks.map((t) => t.title)).toEqual(['Вчера']);
  });

  it('цели и привычки на конец недели', () => {
    const { ws, set } = device('a', at('2026-10-11'));
    ws.updateGameSettings({ dailyGoal: 1, weeklyGoal: 5 });
    const habit = ws.createTask({ title: 'Зарядка', due: { date: '2026-10-12' }, recurrence: { rule: 'FREQ=DAILY', mode: 'schedule', text: 'каждый день' }, habit: { skipsPerWeek: 0 } });
    for (const d of ['2026-10-12', '2026-10-13', '2026-10-14']) {
      set(at(d));
      ws.completeTask(habit);
    }
    const r = ws.weekReview(TZ, MON, '2026-10-14');
    expect(r.current).toBe(true);
    expect(r.done).toBe(3);
    expect(r.goals).toEqual({ daily: 1, daysMet: 3, streak: 3, weekly: 5 });
    expect(r.habits.map((h) => [h.title, h.current, h.week])).toEqual([['Зарядка', 3, 3]]);
  });
});

describe('переносы срока', () => {
  it('перенос на более позднюю дату записывается, раньше и снятие срока — нет', () => {
    const { ws } = device('a', at('2026-10-12'));
    const id = ws.createTask({ title: 'Позвонить', due: { date: '2026-10-12' } });
    ws.updateTask(id, { due: { date: '2026-10-13' } });
    ws.updateTask(id, { due: { date: '2026-10-11' } });
    ws.updateTask(id, { due: { date: '2026-10-11', time: '10:00' } });
    ws.updateTask(id, { due: null });
    ws.updateTask(id, { due: { date: '2026-10-20' } });
    expect(ws.personal.postpones().map((p) => [p.from, p.to])).toEqual([['2026-10-12', '2026-10-13']]);
  });

  it('выполнение повторяющейся задачи не перенос; отмена снимает запись', () => {
    const { ws } = device('a', at('2026-10-12'));
    const rep = ws.createTask({ title: 'Полить', due: { date: '2026-10-12' }, recurrence: { rule: 'FREQ=DAILY', mode: 'schedule', text: 'каждый день' } });
    ws.completeTask(rep);
    ws.skipOccurrence(rep);
    expect(ws.personal.postpones()).toEqual([]);
    const id = ws.createTask({ title: 'Письмо', due: { date: '2026-10-12' } });
    ws.updateTask(id, { due: { date: '2026-10-14' } });
    expect(ws.personal.postpones()).toHaveLength(1);
    ws.undo();
    expect(ws.personal.postpones()).toEqual([]);
    expect(ws.task(id)!.due!.date).toBe('2026-10-12');
  });

  it('три переноса — в «Часто переносятся»; «Оставить» начинает счёт заново; удалённая пропадает', () => {
    const { ws, set } = device('a', at('2026-10-12'));
    const id = ws.createTask({ title: 'Налоги', due: { date: '2026-10-12' } });
    for (const d of ['2026-10-13', '2026-10-14']) ws.updateTask(id, { due: { date: d } });
    expect(ws.weekReview(TZ, MON, '2026-10-14').postponed).toEqual([]);
    ws.updateTask(id, { due: { date: '2026-10-15' } });
    expect(ws.weekReview(TZ, MON, '2026-10-14').postponed).toEqual([{ id, title: 'Налоги', projectId: ws.inboxId, count: 3 }]);
    set(at('2026-10-15'));
    ws.keepPostponed(id);
    expect(ws.weekReview(TZ, MON, '2026-10-15').postponed).toEqual([]);
    set(at('2026-10-16'));
    for (const d of ['2026-10-17', '2026-10-18', '2026-10-19']) ws.updateTask(id, { due: { date: d } });
    expect(ws.weekReview(TZ, MON, '2026-10-16').postponed.map((p) => p.count)).toEqual([3]);
    ws.deleteTask(id);
    expect(ws.weekReview(TZ, MON, '2026-10-16').postponed).toEqual([]);
  });

  it('переносы с двух устройств офлайн складываются', () => {
    const a = device('a', at('2026-10-12'));
    const b = device('b', at('2026-10-12', '12:01'));
    const id = a.ws.createTask({ title: 'Отчёт', due: { date: '2026-10-12' } });
    sync(a.doc, b.doc);
    // Офлайн: на телефоне два переноса, на компьютере один, срок в итоге у позднего.
    a.ws.updateTask(id, { due: { date: '2026-10-13' } });
    a.set(at('2026-10-12', '12:02'));
    a.ws.updateTask(id, { due: { date: '2026-10-14' } });
    b.set(at('2026-10-12', '12:05'));
    b.ws.updateTask(id, { due: { date: '2026-10-16' } });
    sync(a.doc, b.doc);
    for (const d of [a, b]) {
      expect(d.doc.postpones()).toHaveLength(3);
      expect(d.ws.weekReview(TZ, MON, '2026-10-13').postponed.map((p) => p.count)).toEqual([3]);
    }
  });
});

describe('когда показывать итоги', () => {
  const s = (patch: Partial<GameSettings>): GameSettings => ({ ...DEFAULT_GAME_SETTINGS, ...patch });

  it('воскресенье и пятница — эта неделя, понедельник — прошлая', () => {
    expect(reviewWeekOf('2026-10-18', 7)).toBe(MON);
    expect(reviewWeekOf('2026-10-16', 5)).toBe(MON);
    expect(reviewWeekOf('2026-10-19', 1)).toBe(MON);
  });

  it('последний наступивший момент в поясе пользователя', () => {
    const set = s({ weeklyReviewDay: 7, weeklyReviewTime: '19:00' });
    // Воскресенье 18:59 по Москве — ещё прошлые итоги.
    expect(lastReview(set, at('2026-10-18', '18:59'), TZ)).toMatchObject({ date: '2026-10-11', week: '2026-10-05' });
    expect(lastReview(set, at('2026-10-18', '19:00'), TZ)).toEqual({ at: at('2026-10-18', '19:00'), date: '2026-10-18', week: MON });
    expect(lastReview(set, at('2026-10-21'), TZ).week).toBe(MON);
    expect(reviewWeeks(set, at('2026-10-21'), TZ, 3)).toEqual([MON, '2026-10-05', '2026-09-28']);
  });

  it('моменты для уведомлений в окне', () => {
    const set = s({ weeklyReviewDay: 1, weeklyReviewTime: '09:30' });
    const list = reviewsBetween(set, at('2026-10-12', '00:00'), at('2026-10-26', '00:00'), TZ);
    expect(list.map((m) => [m.date, m.week])).toEqual([
      ['2026-10-12', '2026-10-05'],
      ['2026-10-19', MON],
    ]);
    expect(list[0]!.at).toBe(at('2026-10-12', '09:30'));
  });

  it('чистый подсчёт без данных', () => {
    const r = computeWeekReview(
      { events: [], tasks: [], postpones: [], keptAt: () => 0, work: [], habits: [], settings: DEFAULT_GAME_SETTINGS },
      TZ,
      '2026-10-14',
      '2026-10-21',
    );
    expect(r).toMatchObject({ start: MON, done: 0, projects: [], waited: [], postponed: [], missed: { count: 0, tasks: [] }, work: { minutes: 0, sessions: 0 } });
  });
});

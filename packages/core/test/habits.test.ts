import { describe, expect, it } from 'vitest';
import { Doc, HybridClock, Workspace, exportJson, exportMarkdown, habitStreak, parseTemplate, projectToTemplate, applyTemplate, type HabitInput } from '../src/index.ts';

const SPACE = '01929c3e-0000-7000-8000-0000000000cc';
const SHARED = '01929c3e-0000-7000-8000-0000000000dd';
const TZ = 'Europe/Moscow';
const DAILY = { rule: 'FREQ=DAILY', mode: 'schedule', text: 'каждый день' } as const;
const WEEKDAYS = { rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', mode: 'schedule', text: 'по будням' } as const;

/** Даты подряд: from и n дней дальше. */
function run(from: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
}

function streak(over: Partial<HabitInput> & { today: string }) {
  return habitStreak({ recurrence: DAILY, habit: { skipsPerWeek: 0 }, occurrences: [], doneDays: [], skips: [], due: null, ...over });
}

const stateOf = (s: ReturnType<typeof streak>, date: string) => s.days.find((d) => d.date === date)?.state;

describe('привычки: серия', () => {
  it('запоминает дату, когда серия впервые дошла до 30 и 100 (для вех)', () => {
    const s = streak({ occurrences: run('2026-01-01', 120), today: '2026-04-30' });
    expect(s.reached).toEqual({ 30: '2026-01-30', 100: '2026-04-10' });
    expect(streak({ occurrences: run('2026-10-01', 5), today: '2026-10-05' }).reached).toEqual({});
  });

  it('серия — выполненные подряд экземпляры, лучшая — максимум за историю', () => {
    const s = streak({ occurrences: run('2026-10-01', 5), today: '2026-10-05' });
    expect(s).toMatchObject({ current: 5, best: 5, done: 5 });
    // 4-е пропущено: текущая серия 2 (5 и 6), лучшая — первые три дня.
    const gap = streak({ occurrences: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-05', '2026-10-06'], today: '2026-10-06' });
    expect(gap).toMatchObject({ current: 2, best: 3 });
    expect(stateOf(gap, '2026-10-04')).toBe('missed');
    expect(stateOf(gap, '2026-10-05')).toBe('done');
  });

  it('сегодняшний невыполненный экземпляр не обрывает серию до конца дня', () => {
    const s = streak({ occurrences: run('2026-10-01', 4), due: '2026-10-05', today: '2026-10-05' });
    expect(s.current).toBe(4);
    expect(stateOf(s, '2026-10-05')).toBe('today');
    expect(stateOf(s, '2026-10-06')).toBe('planned');
    // Наступило 6-е, а 5-е так и не выполнено.
    const next = streak({ occurrences: run('2026-10-01', 4), due: '2026-10-05', today: '2026-10-06' });
    expect(next).toMatchObject({ current: 0, best: 4 });
    expect(stateOf(next, '2026-10-05')).toBe('missed');
  });

  it('пропуски по правилу недели: не обрывают и не прибавляют, лишний обрывает', () => {
    // 2026-10-05 — понедельник. Пропущен вторник 6-го.
    const one = ['2026-10-05', '2026-10-07', '2026-10-08'];
    const s = streak({ habit: { skipsPerWeek: 1 }, occurrences: one, today: '2026-10-08' });
    expect(s.current).toBe(3);
    expect(stateOf(s, '2026-10-06')).toBe('allowed');
    // Второй пропуск той же недели обрывает.
    const two = streak({ habit: { skipsPerWeek: 1 }, occurrences: ['2026-10-05', '2026-10-07', '2026-10-09'], today: '2026-10-09' });
    expect(two.current).toBe(1);
    expect(stateOf(two, '2026-10-08')).toBe('missed');
    // С понедельника разрешение снова есть: пропуск воскресенья 11-го и понедельника 12-го — в разных неделях.
    const weeks = streak({ habit: { skipsPerWeek: 1 }, occurrences: [...run('2026-10-05', 6), '2026-10-13'], today: '2026-10-13' });
    expect(weeks.current).toBe(7);
    // Без правила тот же пропуск обрывает.
    expect(streak({ occurrences: one, today: '2026-10-08' }).current).toBe(2);
  });

  it('явный пропуск сохраняет серию, не прибавляет и не ограничен правилом', () => {
    const s = streak({ occurrences: ['2026-10-05', '2026-10-08'], skips: ['2026-10-06', '2026-10-07'], today: '2026-10-08' });
    expect(s).toMatchObject({ current: 2, best: 2 });
    expect(stateOf(s, '2026-10-06')).toBe('skipped');
  });

  it('по будням: пятница и понедельник идут подряд', () => {
    // 2026-10-08 — четверг, 9-е — пятница, 12-е — понедельник.
    const s = streak({ recurrence: WEEKDAYS, occurrences: ['2026-10-08', '2026-10-09', '2026-10-12'], today: '2026-10-12' });
    expect(s.current).toBe(3);
    expect(stateOf(s, '2026-10-10')).toBeNull();
    expect(stateOf(s, '2026-10-11')).toBeNull();
  });

  it('повтор после выполнения: серия по дням, когда отмечали выполнение', () => {
    const rec = { rule: 'FREQ=DAILY;INTERVAL=2', mode: 'completion', text: 'каждые 2 дня после выполнения' } as const;
    const s = streak({ recurrence: rec, doneDays: ['2026-10-05', '2026-10-06', '2026-10-07'], occurrences: ['2026-10-01', '2026-10-09', '2026-10-15'], today: '2026-10-08' });
    expect(s.current).toBe(3);
    expect(streak({ recurrence: rec, doneDays: ['2026-10-05', '2026-10-06'], today: '2026-10-08' }).current).toBe(0);
  });

  it('полоска — целые недели с понедельника, текущая последняя', () => {
    const s = streak({ occurrences: ['2026-10-20'], today: '2026-10-20' });
    expect(s.days).toHaveLength(35);
    expect(s.days[0]!.date).toBe('2026-09-21');
    expect(s.days.at(-1)!.date).toBe('2026-10-25');
  });
});

function device(node: string, start: number, tz = TZ) {
  let time = start;
  const doc = new Doc({ spaceId: SPACE, clock: new HybridClock(node, () => time), now: () => time, timeZone: tz });
  return { doc, set: (iso: string) => (time = Date.parse(iso)), tick: (ms = 1) => (time += ms) };
}

function sync(...docs: Doc[]): void {
  const ops = docs.flatMap((d) => [...d.pending()]);
  for (const d of docs) {
    d.applyRemote(ops);
    d.acknowledge(d.pending());
  }
}

describe('привычки: задачи', () => {
  it('старые задачи читаются без привычки, отметка включается правкой', () => {
    const { doc } = device('00000000000000aa', Date.parse('2026-10-05T07:00:00Z'));
    const t = doc.createTask({ title: 'Зарядка', due: { date: '2026-10-05' }, recurrence: DAILY });
    expect(doc.task(t)?.habit).toBeNull();
    expect(doc.habitStreak(t)).toBeNull();
    doc.updateTask(t, { habit: { skipsPerWeek: 9 } });
    // Число пропусков ограничено.
    expect(doc.task(t)?.habit).toEqual({ skipsPerWeek: 6 });
    expect(doc.habitStreak(t)?.current).toBe(0);
  });

  it('выполнение растит серию, «Пропустить сегодня» сохраняет её и отменяется', () => {
    const { doc, set } = device('00000000000000aa', Date.parse('2026-10-05T07:00:00Z'));
    const t = doc.createTask({ title: 'Зарядка', due: { date: '2026-10-05' }, recurrence: DAILY, habit: { skipsPerWeek: 0 } });
    doc.completeTask(t);
    set('2026-10-06T07:00:00Z');
    doc.completeTask(t);
    expect(doc.habitStreak(t)?.current).toBe(2);
    set('2026-10-07T07:00:00Z');
    doc.skipOccurrence(t);
    expect(doc.task(t)?.due?.date).toBe('2026-10-08');
    expect(doc.skips(t).map((k) => k.occurrence)).toEqual(['2026-10-07']);
    set('2026-10-08T07:00:00Z');
    doc.completeTask(t);
    expect(doc.habitStreak(t)).toMatchObject({ current: 3, best: 3 });
    doc.undo();
    doc.undo();
    // Пропуск снят: 7-е снова срок и сегодня его уже не вернуть — день прошёл.
    expect(doc.skips(t)).toEqual([]);
    expect(doc.task(t)?.due?.date).toBe('2026-10-07');
    expect(doc.habitStreak(t)?.current).toBe(0);
  });

  it('у обычной повторяющейся задачи пропуск записи не оставляет', () => {
    const { doc } = device('00000000000000aa', Date.parse('2026-10-05T07:00:00Z'));
    const t = doc.createTask({ title: 'Полив', due: { date: '2026-10-05' }, recurrence: DAILY });
    doc.skipOccurrence(t);
    expect(doc.skips()).toEqual([]);
  });

  it('граница суток — по часовому поясу пользователя', () => {
    // 22:30 UTC 5-го — в Москве уже 01:30 6-го.
    const { doc, set } = device('00000000000000aa', Date.parse('2026-10-01T07:00:00Z'));
    const t = doc.createTask({ title: 'Зарядка', due: { date: '2026-10-01' }, recurrence: DAILY, habit: { skipsPerWeek: 0 } });
    for (const d of run('2026-10-01', 4)) {
      set(`${d}T07:00:00Z`);
      doc.completeTask(t);
    }
    set('2026-10-05T22:30:00Z');
    expect(doc.habitStreak(t)?.current).toBe(0); // в Москве 5-е уже прошло
    expect(doc.habitStreak(t, '2026-10-05', 'UTC')?.current).toBe(4); // в UTC ещё 5-е
    // Отметка вчерашнего в 00:30 по Москве засчитывает и сегодняшний: срок уходит на завтра.
    set('2026-10-05T21:30:00Z');
    doc.completeTask(t);
    expect(doc.task(t)?.due?.date).toBe('2026-10-07');
    const s = doc.habitStreak(t, '2026-10-06')!;
    expect(s.current).toBe(6);
    expect(s.days.find((d) => d.date === '2026-10-06')?.state).toBe('done');
  });

  it('пропуск с двух устройств сливается в одну запись', () => {
    const a = device('00000000000000aa', Date.parse('2026-10-05T07:00:00Z'));
    const b = device('00000000000000bb', Date.parse('2026-10-05T07:00:00Z'));
    const t = a.doc.createTask({ title: 'Зарядка', due: { date: '2026-10-05' }, recurrence: DAILY, habit: { skipsPerWeek: 0 } });
    a.doc.completeTask(t);
    sync(a.doc, b.doc);
    a.set('2026-10-06T08:00:00Z');
    b.set('2026-10-06T09:00:00Z');
    a.doc.skipOccurrence(t);
    b.doc.skipOccurrence(t);
    sync(a.doc, b.doc);
    for (const d of [a.doc, b.doc]) {
      expect(d.skips(t)).toHaveLength(1);
      expect(d.task(t)?.due?.date).toBe('2026-10-07');
      expect(d.habitStreak(t, '2026-10-07')?.current).toBe(1);
    }
  });

  it('перенос в общий проект сохраняет привычку, выполнения и пропуски', () => {
    const now = Date.parse('2026-10-05T07:00:00Z');
    let time = now;
    const clock = new HybridClock('00000000000000aa', () => time);
    const personal = new Doc({ spaceId: SPACE, clock, now: () => time, timeZone: TZ });
    const shared = new Doc({ spaceId: SHARED, clock, now: () => time, timeZone: TZ, kind: 'shared' });
    const ws = new Workspace(personal);
    ws.addShared(shared);
    shared.write([['project', SHARED, 'name', 'Семья']]);
    const t = ws.createTask({ title: 'Зарядка', due: { date: '2026-10-05' }, recurrence: DAILY, habit: { skipsPerWeek: 1 } });
    ws.completeTask(t);
    time = Date.parse('2026-10-06T07:00:00Z');
    ws.skipOccurrence(t);
    time = Date.parse('2026-10-07T07:00:00Z');
    ws.completeTask(t);
    const before = ws.habitStreak(t, '2026-10-07', TZ)!;
    expect(before.current).toBe(2);

    ws.moveTask(t, { projectId: SHARED });
    const moved = ws.projectTasks(SHARED).unsectioned[0]!.task;
    expect(moved.id).not.toBe(t);
    expect(moved.habit).toEqual({ skipsPerWeek: 1 });
    expect(ws.habitStreak(moved.id, '2026-10-07', TZ)).toEqual(before);
    expect(shared.skips(moved.id)).toHaveLength(1);
    expect(ws.habits('2026-10-07', TZ).map((h) => [h.task.title, h.streak.current])).toEqual([['Зарядка', 2]]);
  });

  it('шаблон и экспорт сохраняют отметку привычки', () => {
    const { doc } = device('00000000000000aa', Date.parse('2026-10-05T07:00:00Z'));
    const ws = new Workspace(doc);
    const p = ws.createProject({ name: 'Утро' });
    const t = ws.createTask({ title: 'Зарядка', projectId: p, due: { date: '2026-10-05' }, recurrence: DAILY, habit: { skipsPerWeek: 2 } });
    ws.skipOccurrence(t);
    const tpl = parseTemplate(JSON.parse(JSON.stringify(projectToTemplate(ws, p, '2026-10-05', TZ))));
    expect(tpl.tasks[0]?.habit).toEqual({ skipsPerWeek: 2 });
    const copy = applyTemplate(ws, tpl, '2026-10-05');
    expect(ws.projectTasks(copy).unsectioned[0]?.task.habit).toEqual({ skipsPerWeek: 2 });

    const data = exportJson(doc);
    expect(data.tasks.some((x) => (x as { habit: unknown }).habit !== null)).toBe(true);
    expect(data.skips).toHaveLength(1);
    expect(exportMarkdown(doc)).toContain('🔥 привычка');
  });
});

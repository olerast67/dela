import { describe, expect, it } from 'vitest';
import {
  Doc,
  HybridClock,
  Workspace,
  busyIntervals,
  compactRest,
  dayTimeline,
  freeSlotIn,
  nextFreeSlot,
  packSequence,
  packTasks,
  placeNextFree,
  planPatch,
  planReminders,
  planSettingsChanges,
  readPlanSettings,
  shiftRest,
  widgetSnapshot,
  DEFAULT_PLAN_SETTINGS,
  type CalEvent,
  type PlanDay,
  type PlanTask,
} from '../src/index.ts';

const TZ = 'Europe/Moscow';
const DAY = '2026-11-24';
/** Момент в Москве (UTC+3) в этот день. */
const at = (time: string, date = DAY) => {
  const [h, m] = time.split(':').map(Number) as [number, number];
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, mo - 1, d, h - 3, m);
};
const task = (id: string, time: string | null, duration: number | null = null, extra: Partial<PlanTask> = {}): PlanTask => ({
  id,
  title: id,
  due: time ? { date: DAY, time } : { date: DAY },
  duration,
  completedAt: null,
  ...extra,
});
const day = (tasks: PlanTask[], events: CalEvent[] = [], defaultDuration?: number): PlanDay => ({
  date: DAY,
  tz: TZ,
  tasks,
  events,
  ...(defaultDuration ? { defaultDuration } : {}),
});
const event = (id: string, from: string, to: string): CalEvent => ({
  id,
  calendar: 'device:1',
  title: id,
  location: '',
  description: '',
  color: '#00f',
  allDay: false,
  start: at(from),
  end: at(to),
});
const times = (r: { changes: ReadonlyArray<{ taskId: string; time: string }> }) => Object.fromEntries(r.changes.map((c) => [c.taskId, c.time]));

describe('packSequence', () => {
  it('ставит встык с начала, без длительности — 15 минут', () => {
    const r = packSequence([{ id: 'a', duration: 60 }, { id: 'b', duration: null }, { id: 'c', duration: 20 }], 6 * 60, [], { date: DAY });
    expect(times(r)).toEqual({ a: '06:00', b: '07:00', c: '07:15' });
    expect(r.changes.map((c) => c.duration)).toEqual([60, 15, 20]);
    expect(r.overflow).toEqual([]);
  });

  it('длительность по умолчанию настраивается', () => {
    const r = packSequence([{ id: 'a' }, { id: 'b' }], 600, [], { date: DAY, defaultDuration: 30 });
    expect(times(r)).toEqual({ a: '10:00', b: '10:30' });
  });

  it('обходит занятые отрезки, в том числе стоящие подряд', () => {
    const busy = [
      { start: 9 * 60 + 20, end: 10 * 60 },
      { start: 10 * 60, end: 10 * 60 + 30 },
      { start: 11 * 60, end: 11 * 60 + 10 },
    ];
    const r = packSequence([{ id: 'a', duration: 30 }, { id: 'b', duration: 30 }, { id: 'c', duration: 15 }], 9 * 60, busy, { date: DAY });
    // a 9:00 не влезает до 9:20 — после 10:30; b 11:00 занято — 11:10; c встык.
    expect(times(r)).toEqual({ a: '10:30', b: '11:10', c: '11:40' });
  });

  it('влезает точно в дыру', () => {
    const busy = [{ start: 600, end: 630 }, { start: 660, end: 700 }];
    const r = packSequence([{ id: 'a', duration: 30 }], 600, busy, { date: DAY });
    expect(times(r)).toEqual({ a: '10:30' });
  });

  it('старые места укладываемых задач не мешают', () => {
    const r = packSequence([{ id: 'a', duration: 30 }], 600, [{ start: 600, end: 630, id: 'a' }], { date: DAY });
    expect(times(r)).toEqual({ a: '10:00' });
  });

  it('за полночь не уезжает: не влезшая и все после неё в overflow', () => {
    const r = packSequence([{ id: 'a', duration: 60 }, { id: 'b', duration: 60 }, { id: 'c', duration: 5 }], 22 * 60 + 30, [], { date: DAY });
    expect(times(r)).toEqual({ a: '22:30' });
    expect(r.overflow).toEqual(['b', 'c']);
  });

  it('конец ровно в 24:00 допустим', () => {
    const r = packSequence([{ id: 'a', duration: 60 }], 23 * 60, [], { date: DAY });
    expect(times(r)).toEqual({ a: '23:00' });
  });

  it('занятое до конца дня — всё в overflow', () => {
    const r = packSequence([{ id: 'a', duration: 10 }], 1000, [{ start: 990, end: 1440 }], { date: DAY });
    expect(r.changes).toEqual([]);
    expect(r.overflow).toEqual(['a']);
  });
});

describe('packTasks', () => {
  it('укладывает выбранные в заданном порядке вокруг остальных задач и событий', () => {
    const d = day([task('x', null, 30), task('y', null), task('busy', '10:15', 30), task('done', '10:00', 60, { completedAt: 1 })], [event('call', '11:00', '11:30')]);
    const r = packTasks(d, ['y', 'x'], 10 * 60);
    // y 10:00-10:15; x 10:15 занято busy до 10:45, 10:45-11:15 задевает событие → 11:30. Выполненная место не занимает.
    expect(times(r)).toEqual({ y: '10:00', x: '11:30' });
  });
});

describe('nextFreeSlot', () => {
  const d = day([task('a', '09:00', 60), task('b', '10:10', 20), task('c', '11:00', 30)], [event('e', '12:00', '13:00')]);

  it('округляет «сейчас» вверх до 5 минут', () => {
    expect(nextFreeSlot(day([]), at('08:02'), 30)).toBe(8 * 60 + 5);
    expect(nextFreeSlot(day([]), at('08:05'), 30)).toBe(8 * 60 + 5);
  });

  it('первая дыра, куда влезает длительность', () => {
    expect(nextFreeSlot(d, at('09:10'), 10)).toBe(10 * 60);
    expect(nextFreeSlot(d, at('09:10'), 15)).toBe(10 * 60 + 30);
    expect(nextFreeSlot(d, at('09:10'), 30)).toBe(10 * 60 + 30);
    expect(nextFreeSlot(d, at('09:10'), 31)).toBe(13 * 60);
  });

  it('конец занятого не кратен 5 — начало округляется', () => {
    expect(freeSlotIn([{ start: 600, end: 617 }], 600, 10)).toBe(620);
  });

  it('сама задача место не занимает', () => {
    expect(nextFreeSlot(d, at('09:10'), 60, ['b'])).toBe(10 * 60);
  });

  it('null, если до 24:00 не влезает; прошедший день — null; будущий — с 0:00', () => {
    expect(nextFreeSlot(d, at('23:40'), 30)).toBeNull();
    expect(nextFreeSlot(d, at('23:30'), 30)).toBe(23 * 60 + 30);
    expect(nextFreeSlot(d, at('10:00', '2026-11-25'), 10)).toBeNull();
    expect(nextFreeSlot(d, at('10:00', '2026-11-23'), 30)).toBe(0);
  });

  it('placeNextFree берёт длительность задачи или умолчание', () => {
    const dd = day([task('a', '09:00', 60), task('n', null), task('b', '10:20', 30)]);
    expect(placeNextFree(dd, 'n', at('09:30'))).toMatchObject({ taskId: 'n', time: '10:00', duration: 15 });
    expect(placeNextFree(day([task('a', '09:00', 60), task('n', null, 30), task('b', '10:20', 30)]), 'n', at('09:30'))).toMatchObject({ time: '10:50' });
    expect(placeNextFree(dd, 'nope', at('09:30'))).toBeNull();
  });
});

describe('shiftRest', () => {
  it('сдвигает текущий и будущие блоки, прошедшие и выполненные стоят', () => {
    const d = day([
      task('past', '07:00', 30),
      task('cur', '09:00', 30),
      task('next', '09:30', 30),
      task('done', '10:00', 30, { completedAt: 1 }),
    ]);
    const r = shiftRest(d, at('09:10'), 15);
    expect(times(r)).toEqual({ cur: '09:15', next: '09:45' });
    expect(r.overflow).toEqual([]);
  });

  it('дыра поглощает сдвиг', () => {
    const d = day([task('a', '10:00', 30), task('b', '10:40', 20), task('c', '15:00', 30)]);
    const r = shiftRest(d, at('09:00'), 30);
    // a 10:30-11:00, b 10:40+30=11:10 (после a), c 15:30.
    expect(times(r)).toEqual({ a: '10:30', b: '11:10', c: '15:30' });
    const r2 = shiftRest(day([task('a', '10:00', 30), task('b', '11:00', 30)]), at('09:00'), 15);
    expect(times(r2)).toEqual({ a: '10:15', b: '11:15' });
  });

  it('блоки встык после налезания на неподвижный уходят дальше, а дальний после дыры — только на N', () => {
    const d = day([task('a', '10:00', 30), task('fix', '10:30', 30, { fixedTime: true }), task('b', '11:00', 30), task('c', '15:00', 30)]);
    const r = shiftRest(d, at('09:00'), 15);
    // a 10:15 налезает на fix 10:30-11:00 → 11:00; b упирается в a → 11:30; c 15:15.
    expect(times(r)).toEqual({ a: '11:00', b: '11:30', c: '15:15' });
    expect(r.changes.some((c) => c.taskId === 'fix')).toBe(false);
  });

  it('события календаря и повторяющиеся задачи не двигаются', () => {
    const d = day([task('a', '10:00', 30), task('lunch', '13:00', 60, { recurrence: { rule: 'FREQ=DAILY' } }), task('b', '12:30', 30)], [event('call', '10:30', '11:00')]);
    const r = shiftRest(d, at('09:00'), 20);
    expect(times(r)).toEqual({ a: '11:00', b: '14:00' });
  });

  it('пересекавшиеся блоки сохраняют смещение', () => {
    const d = day([task('a', '10:00', 60), task('b', '10:30', 30)]);
    expect(times(shiftRest(d, at('09:00'), 15))).toEqual({ a: '10:15', b: '10:45' });
  });

  it('за 24:00 не уезжает: overflow, такие задачи не двигаются', () => {
    const d = day([task('a', '22:30', 60), task('b', '23:30', 30)]);
    const r = shiftRest(d, at('22:00'), 15);
    expect(times(r)).toEqual({ a: '22:45' });
    expect(r.overflow).toEqual(['b']);
  });

  it('0 — ничего, отрицательный — ошибка', () => {
    expect(shiftRest(day([task('a', '10:00')]), at('09:00'), 0).changes).toEqual([]);
    expect(() => shiftRest(day([]), at('09:00'), -5)).toThrow(RangeError);
  });

  it('задачи других дней и без времени не трогает', () => {
    const d = day([task('untimed', null), { ...task('tomorrow', '10:00'), due: { date: '2026-11-25', time: '10:00' } }]);
    expect(shiftRest(d, at('09:00'), 15).changes).toEqual([]);
  });
});

describe('compactRest', () => {
  it('ставит будущие встык от «сейчас», округлив до 5 минут', () => {
    const d = day([task('a', '10:00', 30), task('b', '11:00', 20), task('c', '12:00', null)]);
    const r = compactRest(d, at('09:02'));
    expect(times(r)).toEqual({ a: '09:05', b: '09:35', c: '09:55' });
  });

  it('текущий блок не двигается, уплотнение от его конца', () => {
    const d = day([task('cur', '09:00', 60), task('a', '11:00', 30), task('b', '12:00', 30)]);
    const r = compactRest(d, at('09:20'));
    expect(times(r)).toEqual({ a: '10:00', b: '10:30' });
  });

  it('обтекает неподвижные и события; уже стоящие на месте изменений не дают', () => {
    const d = day([task('a', '09:30', 30), task('fix', '10:15', 30, { fixedTime: true }), task('b', '12:00', 30), task('c', '13:00', 15)], [event('e', '11:15', '11:30')]);
    const r = compactRest(d, at('09:30'));
    // a — текущий (9:30 ≤ сейчас < 10:00); b с 10:00 не влезает до fix 10:15 → 10:45; c 11:15 занято событием → 11:30.
    expect(times(r)).toEqual({ b: '10:45', c: '11:30' });
  });

  it('прошедшие невыполненные и выполненные не трогает', () => {
    const d = day([task('missed', '07:00', 30), task('done', '11:00', 30, { completedAt: 1 }), task('a', '12:00', 30)]);
    expect(times(compactRest(d, at('09:00')))).toEqual({ a: '09:00' });
  });

  it('будущий день уплотняется от первого блока; прошедший — ничего', () => {
    const d = day([task('a', '10:00', 30), task('b', '12:00', 30)]);
    expect(times(compactRest(d, at('20:00', '2026-11-23')))).toEqual({ b: '10:30' });
    expect(compactRest(d, at('08:00', '2026-11-25')).changes).toEqual([]);
  });

  it('overflow при уплотнении в конце дня', () => {
    const d = day([task('cur', '20:00', 235), task('a', '23:56', 30)]);
    // текущий до 23:55, a 30 мин не влезает.
    const r = compactRest(d, at('21:00'));
    expect(r.changes).toEqual([]);
    expect(r.overflow).toEqual(['a']);
  });
});

describe('dayTimeline', () => {
  it('задачи и события по началу, дыры от 5 минут, текущее и остаток', () => {
    const d = day(
      [task('wake', '06:00', 60), task('bank', '07:00', 30), task('call', '07:30', 20), task('lunch', '13:00', 60), task('x', '07:52', null, { completedAt: 5 })],
      [event('meet', '12:00', '12:30')],
    );
    const rows = dayTimeline(d, at('07:40'));
    expect(rows.map((r) => (r.kind === 'free' ? `free ${r.start}+${r.minutes}` : r.id))).toEqual([
      'wake',
      'bank',
      'call',
      'x',
      `free ${8 * 60 + 7}+${12 * 60 - (8 * 60 + 7)}`,
      'meet',
      `free ${12 * 60 + 30}+30`,
      'lunch',
    ]);
    const call = rows.find((r) => r.kind === 'task' && r.id === 'call');
    expect(call).toMatchObject({ current: true, left: 10, start: 450, end: 470, defaultDuration: false });
    expect(rows.find((r) => r.kind === 'task' && r.id === 'x')).toMatchObject({ done: true, current: false, duration: 15, defaultDuration: true });
    expect(rows.find((r) => r.kind === 'event')).toMatchObject({ title: 'meet', color: '#00f', current: false });
  });

  it('дыра меньше 5 минут не показывается; пересечения подряд, дыра от самого позднего конца', () => {
    const d = day([task('a', '10:00', 60), task('b', '10:15', 15), task('c', '11:04', 10), task('d', '11:20', 10)]);
    const rows = dayTimeline(d, null);
    expect(rows.map((r) => (r.kind === 'free' ? `free ${r.minutes}` : r.id))).toEqual(['a', 'b', 'c', 'free 6', 'd']);
    expect(rows.every((r) => r.kind === 'free' || !r.current)).toBe(true);
  });

  it('несколько пересекающихся текущих; конец обрезан полночью; пустой день', () => {
    const d = day([task('a', '23:00', 120), task('b', '23:30', 10)]);
    const rows = dayTimeline(d, at('23:35'));
    expect(rows).toMatchObject([
      { id: 'a', end: 1440, current: true, left: 25 },
      { id: 'b', current: true, left: 5 },
    ]);
    expect(dayTimeline(day([]), at('10:00'))).toEqual([]);
  });

  it('фиксированные и повторяющиеся помечены', () => {
    const rows = dayTimeline(day([task('f', '10:00', 30, { fixedTime: true }), task('r', '11:00', 30, { recurrence: { rule: 'FREQ=DAILY' } })]), null);
    expect(rows.filter((r) => r.kind === 'task').map((r) => r.kind === 'task' && r.fixed)).toEqual([true, true]);
  });
});

describe('busyIntervals', () => {
  it('открытые задачи дня со временем и события, без исключённых', () => {
    const d = day([task('a', '10:00', 30), task('b', '11:00'), task('n', null), task('done', '12:00', 30, { completedAt: 1 })], [event('e', '09:00', '09:30')]);
    expect(busyIntervals(d, ['b'])).toEqual([
      { start: 540, end: 570, id: 'e' },
      { start: 600, end: 630, id: 'a' },
    ]);
  });
});

function makeDoc() {
  let time = Date.UTC(2026, 10, 24, 5, 0);
  const doc = new Doc({ spaceId: '01929c3e-0000-7000-8000-0000000000aa', clock: new HybridClock('00000000000000aa', () => (time += 1)), now: () => time, timeZone: TZ });
  return doc;
}

describe('точное время задачи (fixedTime)', () => {
  it('пишется при создании и правке, читается обратно, у старых записей false', () => {
    const doc = makeDoc();
    const a = doc.createTask({ title: 'Встреча', due: { date: DAY, time: '10:00' }, duration: 30, fixedTime: true });
    const b = doc.createTask({ title: 'Обычная' });
    expect(doc.task(a)!.fixedTime).toBe(true);
    expect(doc.task(b)!.fixedTime).toBe(false);
    doc.updateTask(a, { fixedTime: false });
    doc.updateTask(b, { fixedTime: true });
    expect(doc.task(a)!.fixedTime).toBe(false);
    expect(doc.task(b)!.fixedTime).toBe(true);
    doc.undo();
    expect(doc.task(b)!.fixedTime).toBe(false);
  });

  it('переживает перенос между пространствами (копия задачи)', () => {
    const doc = makeDoc();
    const ws = new Workspace(doc);
    const id = ws.createTask({ title: 'Звонок', due: { date: DAY, time: '10:00' }, fixedTime: true });
    expect(ws.task(id)!.fixedTime).toBe(true);
  });
});

describe('настройки плана', () => {
  it('умолчания, чтение испорченного, правка и проверка', () => {
    expect(readPlanSettings(undefined)).toEqual(DEFAULT_PLAN_SETTINGS);
    expect(readPlanSettings({ duration: 30, remind: true })).toEqual({ duration: 30, remind: true });
    expect(readPlanSettings({ duration: 2, remind: 'yes' })).toEqual(DEFAULT_PLAN_SETTINGS);
    expect(readPlanSettings({ duration: 12.5 })).toEqual(DEFAULT_PLAN_SETTINGS);
    expect(() => planSettingsChanges({ duration: 1000 })).toThrow(RangeError);
    expect(() => planSettingsChanges({ remind: 1 as unknown as boolean })).toThrow(RangeError);
    expect(() => planSettingsChanges({ nope: 1 } as never)).toThrow(RangeError);
    const doc = makeDoc();
    const ws = new Workspace(doc);
    expect(ws.getPlanSettings()).toEqual({ duration: 15, remind: false });
    ws.updatePlanSettings({ duration: 25, remind: true });
    expect(ws.getPlanSettings()).toEqual({ duration: 25, remind: true });
  });
});

describe('planPatch', () => {
  it('меняет только срок и сохраняет пояс задачи', () => {
    expect(planPatch({ due: { date: DAY, time: '09:00' } }, { taskId: 'a', date: DAY, time: '10:30', minute: 630, duration: 15 }, TZ)).toEqual({ due: { date: DAY, time: '10:30' } });
    // Задача в UTC: 10:30 по Москве — 07:30 UTC.
    expect(planPatch({ due: { date: DAY, time: '06:00', tz: 'UTC' } }, { taskId: 'a', date: DAY, time: '10:30', minute: 630, duration: 15 }, TZ)).toEqual({ due: { date: DAY, time: '07:30', tz: 'UTC' } });
    expect(planPatch({ due: null }, { taskId: 'a', date: DAY, time: '08:00', minute: 480, duration: 15 }, TZ)).toEqual({ due: { date: DAY, time: '08:00' } });
  });

  it('изменения укладки применяются к документу', () => {
    const ws = new Workspace(makeDoc());
    const a = ws.createTask({ title: 'a', duration: 30 });
    const b = ws.createTask({ title: 'b' });
    const r = packTasks({ date: DAY, tz: TZ, tasks: [ws.task(a)!, ws.task(b)!] }, [a, b], 9 * 60);
    ws.group(() => {
      for (const c of r.changes) ws.updateTask(c.taskId, planPatch(ws.task(c.taskId)!, c, TZ));
    });
    expect(ws.task(a)!.due).toEqual({ date: DAY, time: '09:00' });
    expect(ws.task(b)!.due).toEqual({ date: DAY, time: '09:30' });
    expect(ws.task(b)!.duration).toBeNull();
  });
});

describe('planReminders', () => {
  it('в момент начала открытых задач со временем, только если включено; ключ как у напоминания со смещением 0', () => {
    const doc = makeDoc();
    const a = doc.createTask({ title: 'a', due: { date: DAY, time: '10:00' } });
    doc.createTask({ title: 'quiet', due: { date: DAY, time: '11:00' }, reminders: [] });
    doc.createTask({ title: 'allday', due: { date: DAY } });
    const done = doc.createTask({ title: 'done', due: { date: DAY, time: '12:00' } });
    doc.completeTask(done);
    const from = at('00:00');
    const to = at('00:00', '2026-11-25');
    expect(planReminders(doc, from, to, TZ, { remind: false })).toEqual([]);
    const r = planReminders(doc, from, to, TZ, { remind: true });
    expect(r).toEqual([{ key: `${a}:${DAY}T10:00:0`, taskId: a, at: at('10:00'), title: 'a', dueAt: at('10:00'), offset: 0 }]);
  });
});

describe('снимок виджета: длительность и план', () => {
  it('du и fx только когда есть, план на сегодня с дырами и событиями', () => {
    let time = Date.UTC(2026, 10, 24, 5, 0);
    const doc = new Doc({ spaceId: '01929c3e-0000-7000-8000-0000000000aa', clock: new HybridClock('00000000000000aa', () => (time += 1)), now: () => time });
    const ws = new Workspace(doc);
    ws.updatePlanSettings({ duration: 20 });
    const a = ws.createTask({ title: 'Подъём', due: { date: DAY, time: '06:00' }, duration: 60 });
    const b = ws.createTask({ title: 'Банк', due: { date: DAY, time: '07:00' } });
    const c = ws.createTask({ title: 'Обед', due: { date: DAY, time: '13:00' }, duration: 60, fixedTime: true });
    const done = ws.createTask({ title: 'Готово', due: { date: DAY, time: '07:20' }, duration: 30 });
    ws.completeTask(done);
    ws.createTask({ title: 'Без срока' });
    const snap = widgetSnapshot(ws, DAY, TZ, false, 500, 'Входящие', 'ru', [event('Встреча', '12:00', '12:30')]);
    expect(snap.tasks.find((t) => t.id === a)).toMatchObject({ du: 60 });
    expect(snap.tasks.find((t) => t.id === a)).not.toHaveProperty('fx');
    expect(snap.tasks.find((t) => t.id === b)).not.toHaveProperty('du');
    expect(snap.tasks.find((t) => t.id === c)).toMatchObject({ du: 60, fx: true });
    expect(snap.pd).toBe(20);
    expect(snap.planDate).toBe(DAY);
    expect(snap.plan).toEqual([
      { k: 't', id: a, s: 360, e: 420 },
      { k: 't', id: b, s: 420, e: 440 },
      { k: 'f', s: 440, m: 280 },
      { k: 'e', t: 'Встреча', s: 720, e: 750 },
      { k: 'f', s: 750, m: 30 },
      { k: 't', id: c, s: 780, e: 840 },
    ]);
  });
});

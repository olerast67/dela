import { describe, expect, it } from 'vitest';
import { Doc, HybridClock, Workspace, dayTimeline, parseTask, type PlanDay, type PlanTask, type Reminder } from '#core';
import { afterLast, applyPlan, dayStartFor, insertPlan, nearestFreeStart, placePieces, planDayFor, reorderPlan, spotStart, visualOrder, withPlanReminders } from '../src/plan.ts';

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
const day = (tasks: PlanTask[], extra: Partial<PlanDay> = {}): PlanDay => ({ date: DAY, tz: TZ, tasks, defaultDuration: 15, ...extra });
const times = (r: { changes: ReadonlyArray<{ taskId: string; time: string }> }) => Object.fromEntries(r.changes.map((c) => [c.taskId, c.time]));

function workspace() {
  let time = at('06:00');
  const doc = new Doc({ spaceId: '01929c3e-0000-7000-8000-0000000000aa', clock: new HybridClock('00000000000000aa', () => (time += 1)), now: () => time, timeZone: TZ });
  return new Workspace(doc);
}

describe('день плана', () => {
  it('открытые и выполненные дела дня, повторы будущим экземпляром, укладываемые задачи', () => {
    const ws = workspace();
    const ctx = { now: at('06:00'), tz: TZ };
    const routine = parseTask('подъём каждый день в 6', ctx);
    const r = ws.createTask({ title: 'Подъём', due: routine.due, recurrence: routine.recurrence, duration: 30 });
    const a = ws.createTask({ title: 'Банк', due: { date: '2026-11-25', time: '09:00' } });
    const done = ws.createTask({ title: 'Почта', due: { date: '2026-11-25', time: '08:00' } });
    ws.completeTask(done);
    const loose = ws.createTask({ title: 'Без срока' });

    const tomorrow = planDayFor(ws, '2026-11-25', TZ, [], DAY, [loose]);
    const rows = dayTimeline(tomorrow, null).filter((x) => x.kind === 'task');
    expect(rows.map((x) => x.kind === 'task' && [x.title, x.start, x.fixed, x.done])).toEqual([
      ['Подъём', 360, true, false],
      ['Почта', 480, false, true],
      ['Банк', 540, false, false],
    ]);
    expect(tomorrow.tasks.some((t) => t.id === loose)).toBe(true);
    expect(tomorrow.tasks.some((t) => t.id === r)).toBe(true);
    expect(a).toBeTruthy();
  });

  it('изменения записываются одной записью отмены', () => {
    const ws = workspace();
    const a = ws.createTask({ title: 'A', due: { date: DAY, time: '09:00' } });
    const b = ws.createTask({ title: 'B', due: { date: DAY, time: '10:00' } });
    applyPlan(
      ws,
      [
        { taskId: a, date: DAY, time: '11:00', minute: 660, duration: 15 },
        { taskId: b, date: DAY, time: '11:15', minute: 675, duration: 15 },
      ],
      TZ,
    );
    expect([ws.task(a)!.due!.time, ws.task(b)!.due!.time]).toEqual(['11:00', '11:15']);
    ws.undo();
    expect([ws.task(a)!.due!.time, ws.task(b)!.due!.time]).toEqual(['09:00', '10:00']);
  });
});

describe('перестановка в ленте', () => {
  const d = day([task('a', '09:00', 30), task('b', '09:30', 15), task('c', '10:00', 20), task('d', '11:00', 30)]);

  it('вверх: время встык с самого раннего начала задетого отрезка', () => {
    expect(times(reorderPlan(d, 'c', 0))).toEqual({ c: '09:00', a: '09:20', b: '09:50' });
  });

  it('вниз: задетые дела встают встык, дальше ничего не двигается', () => {
    expect(times(reorderPlan(d, 'a', 3))).toEqual({ b: '09:00', c: '09:15', a: '09:35' });
  });

  it('на то же место — без изменений', () => {
    expect(reorderPlan(d, 'b', 1).changes).toEqual([]);
    expect(reorderPlan(d, 'b', 2).changes).toEqual([]);
  });

  it('неподвижное стоит, подвижные обтекают; поставленная перед ним заканчивается к его началу', () => {
    const f = day([task('a', '09:00', 30), task('fix', '10:00', 60, { fixedTime: true }), task('b', '11:00', 30), task('c', '11:30', 30)]);
    expect(times(reorderPlan(f, 'c', 1))).toEqual({ c: '09:30' });
    expect(times(reorderPlan(f, 'a', 3))).toEqual({ a: '11:30', c: '12:00' });
    expect(reorderPlan(f, 'fix', 0).changes).toEqual([]);
  });
});

describe('вставка в ленту', () => {
  it('встаёт в место броска и толкает следующие дела до первой дыры', () => {
    const d = day([task('a', '09:00', 30), task('b', '09:30', 30), task('c', '11:00', 30), task('new', null, 20)]);
    expect(times(insertPlan(d, 'new', 570))).toEqual({ new: '09:30', b: '09:50' });
  });

  it('толкаемое дело обходит неподвижное', () => {
    const d = day([task('a', '09:00', 30), task('fix', '09:30', 30, { fixedTime: true }), task('new', null, 15)]);
    expect(times(insertPlan(d, 'new', 540))).toEqual({ new: '09:00', a: '10:00' });
  });

  it('место броска: за делом выше, в начало дыры или до первого дела', () => {
    const d = day([task('a', '09:00', 30), task('b', '10:00', 30)]);
    const rows = dayTimeline(d, null);
    expect(rows.map((r) => r.kind)).toEqual(['task', 'free', 'task']);
    expect(spotStart(rows, { kind: 'gap', index: 1 }, 15, 0)).toBe(570);
    expect(spotStart(rows, { kind: 'free', start: 570 }, 15, 0)).toBe(570);
    expect(spotStart(rows, { kind: 'gap', index: 0 }, 15, 0)).toBe(525);
    expect(spotStart([], { kind: 'gap', index: 0 }, 15, 480)).toBe(480);
  });

  it('пустой день: сегодня с ближайших 5 минут, завтра с 9:00; конец ленты после последнего дела', () => {
    const empty = day([]);
    expect(dayStartFor(empty, at('07:02'))).toBe(425);
    expect(dayStartFor(empty, at('07:02', '2026-11-23'))).toBe(540);
    const d = day([task('a', '09:00', 30)]);
    expect(afterLast(d, at('07:00'))).toBe(570);
    expect(afterLast(d, at('12:03'))).toBe(725);
  });
});

describe('дела из строки «свободно»', () => {
  const ctx = { now: at('07:00'), tz: TZ };

  it('ведущие дела без срока встают встык с начала дыры, обходя занятое', () => {
    const d = day([task('a', '09:00', 30), task('b', '10:00', 30)]);
    const pieces = ['банк 30м', 'созвон 20м', 'почта'].map((t) => parseTask(t, ctx));
    const placed = placePieces(pieces, d, 570);
    expect(placed.map((p) => [p.title, p.due?.time])).toEqual([
      ['банк', '09:30'],
      ['созвон', '10:30'],
      ['почта', '10:50'],
    ]);
  });

  it('дело со своим временем и цепочка после него не трогаются', () => {
    const d = day([]);
    const pieces = [parseTask('банк', ctx), parseTask('обед в 13', ctx)];
    const placed = placePieces(pieces, d, 600);
    expect(placed.map((p) => p.due?.time)).toEqual(['10:00', '13:00']);
  });
});

describe('«Уложить»', () => {
  it('ближайшая дыра, куда влезают все дела подряд', () => {
    const d = day([task('a', '09:00', 30), task('b', '09:45', 30), task('x', null, 30), task('y', null, 30)]);
    expect(nearestFreeStart(d, ['x', 'y'], at('08:58'))).toBe(615);
    expect(nearestFreeStart(day([task('x', null, 15)]), ['x'], at('23:58'))).toBeNull();
  });

  it('порядок как на экране', () => {
    expect(visualOrder(['c', 'a', 'z', 'b'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c', 'z']);
  });
});

describe('напоминания о начале дел плана', () => {
  const r = (key: string, at: number): Reminder => ({ key, taskId: key.split(':')[0]!, at, title: '', dueAt: at, offset: 0 });

  it('не дублируют напоминание «в срок» с тем же ключом', () => {
    const own = [r('a:2026-11-24T09:00:0', 2), r('a:2026-11-24T09:00:15', 1)];
    const plan = [r('a:2026-11-24T09:00:0', 2), r('b:2026-11-24T10:00:0', 3)];
    expect(withPlanReminders(own, plan).map((x) => x.key)).toEqual(['a:2026-11-24T09:00:15', 'a:2026-11-24T09:00:0', 'b:2026-11-24T10:00:0']);
    expect(withPlanReminders(own, [])).toHaveLength(2);
  });
});

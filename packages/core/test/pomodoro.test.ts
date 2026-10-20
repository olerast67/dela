import { describe, expect, it } from 'vitest';
import {
  Doc,
  HybridClock,
  clockLabel,
  computeStats,
  isOver,
  parsePomodoro,
  pausePomodoro,
  pomodoroRemaining,
  resumePomodoro,
  startBreak,
  startWork,
  workedMinutes,
} from '../src/index.ts';

const SPACE = '01929c3e-0000-7000-8000-00000000aaaa';
const MIN = 60_000;

function device(node: string, start = 1_760_000_000_000) {
  let time = start;
  const doc = new Doc({ spaceId: SPACE, clock: new HybridClock(node, () => time), now: () => time });
  return { doc, tick: (ms = 1) => (time += ms) };
}

function sync(...docs: Doc[]): void {
  const ops = docs.flatMap((d) => [...d.pending()]);
  for (const d of docs) {
    d.applyRemote(ops);
    d.acknowledge(d.pending());
  }
}

describe('помодоро: таймер', () => {
  const t0 = 1_760_000_000_000;

  it('остаток считается от времени окончания, а не от тиков', () => {
    const s = startWork('p1', 'task', 25, t0);
    expect(s.endsAt).toBe(t0 + 25 * MIN);
    expect(pomodoroRemaining(s, t0 + 10 * MIN)).toBe(15 * MIN);
    // Устройство спало или страницу перезагрузили: остаток всё равно верный.
    const restored = parsePomodoro(JSON.parse(JSON.stringify(s)))!;
    expect(pomodoroRemaining(restored, t0 + 24 * MIN)).toBe(MIN);
    expect(isOver(restored, t0 + 26 * MIN)).toBe(true);
    expect(pomodoroRemaining(restored, t0 + 26 * MIN)).toBe(0);
    expect(clockLabel(pomodoroRemaining(s, t0 + 1000))).toBe('24:59');
    expect(clockLabel(65 * MIN)).toBe('1:05:00');
  });

  it('пауза замораживает остаток, время на паузе не идёт в работу', () => {
    let s = startWork('p1', 'task', 25, t0);
    s = pausePomodoro(s, t0 + 10 * MIN);
    expect(s.endsAt).toBeNull();
    // Час на паузе ничего не меняет.
    expect(pomodoroRemaining(s, t0 + 70 * MIN)).toBe(15 * MIN);
    expect(workedMinutes(s, t0 + 70 * MIN)).toBe(10);
    s = resumePomodoro(s, t0 + 70 * MIN);
    expect(s.endsAt).toBe(t0 + 85 * MIN);
    expect(workedMinutes(s, t0 + 75 * MIN)).toBe(15);
    expect(isOver(s, t0 + 85 * MIN)).toBe(true);
    expect(workedMinutes(s, t0 + 90 * MIN)).toBe(25);
  });

  it('перерыв не считается работой', () => {
    const b = startBreak(startWork('p1', 'task', 25, t0), 5, t0 + 25 * MIN);
    expect(b.phase).toBe('break');
    expect(b.taskId).toBe('task');
    expect(pomodoroRemaining(b, t0 + 27 * MIN)).toBe(3 * MIN);
    expect(workedMinutes(b, t0 + 40 * MIN)).toBe(0);
  });

  it('испорченное состояние из хранилища отбрасывается', () => {
    expect(parsePomodoro(null)).toBeNull();
    expect(parsePomodoro({ id: 'p', taskId: 't', phase: 'nap', length: 1, endsAt: 1, left: 1 })).toBeNull();
    expect(parsePomodoro({ id: 'p', taskId: 't', phase: 'work', length: -1, endsAt: 1, left: 1 })).toBeNull();
  });
});

describe('помодоро: затраченное время', () => {
  it('отрезки копятся, повтор того же отрезка не удваивает время', () => {
    const { doc, tick } = device('00000000000000aa');
    const task = doc.createTask({ title: 'Отчёт' });
    expect(doc.task(task)?.spent).toBe(0);
    doc.logWork(task, 25, { id: 'p1' });
    tick();
    doc.logWork(task, 25, { id: 'p1' });
    tick();
    doc.logWork(task, 10, { id: 'p2' });
    expect(doc.task(task)?.spent).toBe(35);
    expect(doc.logWork(task, 0)).toBeNull();
  });

  it('два устройства прибавляют время одновременно: обе прибавки сохраняются', () => {
    const a = device('00000000000000aa');
    const b = device('00000000000000bb');
    const task = a.doc.createTask({ title: 'Ремонт' });
    a.doc.logWork(task, 20);
    sync(a.doc, b.doc);
    // Офлайн на обоих.
    a.tick(10);
    b.tick(10);
    a.doc.logWork(task, 25);
    b.doc.logWork(task, 15);
    sync(a.doc, b.doc);
    expect(a.doc.task(task)?.spent).toBe(60);
    expect(b.doc.task(task)?.spent).toBe(60);
  });

  it('правка вручную заменяет известное, а отрезок с другого устройства прибавляется', () => {
    const a = device('00000000000000aa');
    const b = device('00000000000000bb');
    const task = a.doc.createTask({ title: 'Ремонт' });
    a.doc.logWork(task, 50);
    sync(a.doc, b.doc);
    a.tick(10);
    b.tick(10);
    a.doc.setSpent(task, 75);
    b.doc.logWork(task, 5);
    sync(a.doc, b.doc);
    expect(a.doc.task(task)?.spent).toBe(80);
    expect(b.doc.task(task)?.spent).toBe(80);
    a.tick(10);
    a.doc.setSpent(task, 0);
    expect(a.doc.task(task)?.spent).toBe(0);
    // Сброс отменяется.
    a.doc.undo();
    expect(a.doc.task(task)?.spent).toBe(80);
  });

  it('старые задачи без отрезков читаются с нулём; время попадает в статистику', () => {
    const { doc, tick } = device('00000000000000aa');
    const task = doc.createTask({ title: 'Старая' });
    expect(doc.task(task)?.spent).toBe(0);
    tick(1000);
    doc.logWork(task, 30);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date(1_760_000_001_001));
    const s = doc.stats('UTC', today, { period: 7 });
    expect(s.work).toEqual({ today: 30, week: 30, period: 30 });
    expect(computeStats([], 'UTC', today).work).toEqual({ today: 0, week: 0, period: 0 });
    // Задача в корзине в статистику не идёт.
    doc.deleteTask(task);
    expect(doc.stats('UTC', today).work.period).toBe(0);
  });
});

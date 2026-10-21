import { describe, expect, it } from 'vitest';
import { Doc, HybridClock, type TaskNode } from '../src/index.ts';

const SPACE = '01929c3e-0000-7000-8000-00000000aaaa';
const TZ = 'Europe/Moscow';
const TODAY = '2025-10-09';
const TOMORROW = '2025-10-10';

function device(node: string, start = 1_760_000_000_000) {
  let time = start;
  const doc = new Doc({ spaceId: SPACE, clock: new HybridClock(node, () => time), now: () => time, timeZone: TZ });
  return { doc, tick: (ms = 1) => (time += ms) };
}

function sync(...docs: Doc[]): void {
  const ops = docs.flatMap((d) => [...d.pending()]);
  for (const d of docs) {
    d.applyRemote(ops);
    d.acknowledge(d.pending());
  }
}

const todayTitles = (doc: Doc, date = TODAY) => doc.today(date, TZ).today.map((t) => t.title);
const dayIds = (doc: Doc, date = TODAY) => doc.today(date, TZ).today.map((t) => t.id);
const projectTitles = (nodes: readonly TaskNode[]) => nodes.map((n) => n.task.title);

describe('ручной порядок дня', () => {
  it('перестановка в «Сегодня» не трогает порядок в проекте и переживает новые правки', () => {
    const { doc } = device('00000000000000aa');
    const a = doc.createTask({ title: 'A', due: { date: TODAY } });
    const b = doc.createTask({ title: 'B', due: { date: TODAY } });
    const c = doc.createTask({ title: 'C', due: { date: TODAY } });
    expect(todayTitles(doc)).toEqual(['A', 'B', 'C']);
    doc.placeInDay(c, TODAY, dayIds(doc), { before: a });
    expect(todayTitles(doc)).toEqual(['C', 'A', 'B']);
    expect(projectTitles(doc.projectTasks(doc.inboxId).unsectioned)).toEqual(['A', 'B', 'C']);
    // Весь день получил ключи: следующая перестановка пишет один ключ.
    const before = doc.pending().length;
    doc.placeInDay(a, TODAY, dayIds(doc), { after: b });
    expect(doc.pending().length - before).toBe(1);
    expect(todayTitles(doc)).toEqual(['C', 'B', 'A']);
    doc.undo();
    expect(todayTitles(doc)).toEqual(['C', 'A', 'B']);
  });

  it('новая задача без порядка встаёт по старому правилу относительно соседей', () => {
    const { doc } = device('00000000000000aa');
    const a = doc.createTask({ title: 'A', due: { date: TODAY } });
    const b = doc.createTask({ title: 'B', due: { date: TODAY } });
    doc.placeInDay(b, TODAY, dayIds(doc), { before: a });
    expect(todayTitles(doc)).toEqual(['B', 'A']);
    // Без времени и приоритета — после упорядоченных (byDue ставит её после них по порядку проекта).
    doc.createTask({ title: 'Новая', due: { date: TODAY } });
    // Со временем — раньше задач без времени.
    doc.createTask({ title: 'В 9:00', due: { date: TODAY, time: '09:00' } });
    // Приоритет 1 без времени — перед упорядоченными задачами с приоритетом 4.
    doc.createTask({ title: 'Срочная', due: { date: TODAY }, priority: 1 });
    expect(todayTitles(doc)).toEqual(['В 9:00', 'Срочная', 'B', 'A', 'Новая']);
  });

  it('порядок вчерашнего дня не влияет на сегодняшний', () => {
    const { doc } = device('00000000000000aa');
    const yesterday = '2025-10-08';
    const a = doc.createTask({ title: 'A', due: { date: yesterday } });
    const b = doc.createTask({ title: 'B', due: { date: yesterday } });
    doc.placeInDay(b, yesterday, dayIds(doc, yesterday), { before: a });
    expect(todayTitles(doc, yesterday)).toEqual(['B', 'A']);
    for (const id of [a, b]) doc.updateTask(id, { due: { date: TODAY } });
    expect(todayTitles(doc)).toEqual(['A', 'B']);
    expect(doc.task(b)?.dayOrder).toMatchObject({ date: yesterday });
  });

  it('просроченные упорядочены по ключам сегодняшнего дня', () => {
    const { doc } = device('00000000000000aa');
    const a = doc.createTask({ title: 'A', due: { date: '2025-10-01' } });
    const b = doc.createTask({ title: 'B', due: { date: '2025-10-01' } });
    const ids = doc.today(TODAY, TZ).overdue.map((t) => t.id);
    doc.placeInDay(b, TODAY, ids, { before: a });
    expect(doc.today(TODAY, TZ).overdue.map((t) => t.title)).toEqual(['B', 'A']);
  });

  it('перенос из другого дня: срок меняется, задача встаёт рядом с целью одним действием', () => {
    const { doc } = device('00000000000000aa');
    const a = doc.createTask({ title: 'A', due: { date: TOMORROW } });
    doc.createTask({ title: 'B', due: { date: TOMORROW } });
    const x = doc.createTask({ title: 'X', due: { date: TODAY, time: '18:00' } });
    const day = () => doc.upcoming(TODAY, 2, TZ)[1]!.tasks;
    doc.placeInDay(x, TOMORROW, day().map((t) => t.id), { after: a }, { date: TOMORROW, time: '18:00' });
    expect(day().map((t) => t.title)).toEqual(['A', 'X', 'B']);
    expect(doc.task(x)?.due).toEqual({ date: TOMORROW, time: '18:00' });
    doc.undo();
    expect(doc.task(x)?.due?.date).toBe(TODAY);
  });

  it('поле синхронизируется между устройствами, побеждает последняя правка', () => {
    const one = device('00000000000000aa');
    const two = device('00000000000000bb');
    const a = one.doc.createTask({ title: 'A', due: { date: TODAY } });
    const b = one.doc.createTask({ title: 'B', due: { date: TODAY } });
    const c = one.doc.createTask({ title: 'C', due: { date: TODAY } });
    sync(one.doc, two.doc);
    one.doc.placeInDay(c, TODAY, dayIds(one.doc), { before: a });
    sync(one.doc, two.doc);
    expect(todayTitles(two.doc)).toEqual(['C', 'A', 'B']);
    // Офлайн оба переставили B: позже — второе устройство.
    one.tick(10);
    two.tick(10);
    one.doc.placeInDay(b, TODAY, dayIds(one.doc), { before: c });
    two.tick(5);
    two.doc.placeInDay(b, TODAY, dayIds(two.doc), { after: a });
    sync(one.doc, two.doc);
    expect(todayTitles(one.doc)).toEqual(['C', 'A', 'B']);
    expect(todayTitles(two.doc)).toEqual(todayTitles(one.doc));
  });

  it('старые записи без поля и испорченное значение читаются как без ручного порядка', () => {
    const { doc } = device('00000000000000aa');
    const a = doc.createTask({ title: 'A', due: { date: TODAY } });
    doc.createTask({ title: 'B', due: { date: TODAY } });
    expect(doc.task(a)?.dayOrder).toBeNull();
    doc.write([['task', a, 'day_order', { date: 'вчера', key: 5 }]]);
    expect(doc.task(a)?.dayOrder).toBeNull();
    expect(todayTitles(doc)).toEqual(['A', 'B']);
  });
});

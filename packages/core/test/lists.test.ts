import { describe, expect, it } from 'vitest';
import { Doc, HybridClock, type TaskNode } from '../src/index.ts';

const SPACE = '01929c3e-0000-7000-8000-00000000cccc';
const TZ = 'Europe/Moscow';
// 13 октября 2026, 12:00 по Москве.
const NOON = Date.UTC(2026, 9, 13, 9, 0);
const DAY = 24 * 3600_000;

function device(node = '00000000000000aa', time = NOON) {
  let t = time;
  const doc = new Doc({ spaceId: SPACE, clock: new HybridClock(node, () => t), now: () => t, timeZone: TZ });
  return { doc, setTime: (x: number) => (t = x) };
}

const shape = (nodes: readonly TaskNode[]): unknown => nodes.map((n) => [n.task.title, shape(n.children)]);

describe('подзадачи в «Сегодня», «Предстоящих» и фильтрах', () => {
  it('подзадача со своим сроком встаёт под родителя из списка и не дублируется', () => {
    const { doc } = device();
    const parent = doc.createTask({ title: 'Ремонт', due: { date: '2026-10-13' } });
    doc.createTask({ title: 'Краска', parentId: parent, due: { date: '2026-10-13' } });
    doc.createTask({ title: 'Кисти', parentId: parent });
    const list = doc.today('2026-10-13', TZ).today;
    expect(list.map((t) => t.title).sort()).toEqual(['Краска', 'Ремонт']);
    expect(shape(doc.nested(list))).toEqual([['Ремонт', [['Краска', []], ['Кисти', []]]]]);
  });

  it('подзадача без родителя в списке остаётся отдельной строкой; выполненные подзадачи не показываются', () => {
    const { doc } = device();
    const parent = doc.createTask({ title: 'Отпуск' });
    const sub = doc.createTask({ title: 'Билеты', parentId: parent, due: { date: '2026-10-13' } });
    const deep = doc.createTask({ title: 'Сравнить цены', parentId: sub });
    doc.createTask({ title: 'Оплатить', parentId: sub });
    doc.completeTask(deep);
    expect(shape(doc.nested(doc.today('2026-10-13', TZ).today))).toEqual([['Билеты', [['Оплатить', []]]]]);
  });

  it('внук в списке под дедом не дублируется, будущие экземпляры повторов идут без подзадач', () => {
    const { doc } = device();
    const root = doc.createTask({
      title: 'Уборка',
      due: { date: '2026-10-13' },
      recurrence: { rule: 'FREQ=DAILY', mode: 'schedule', text: 'каждый день' },
    });
    const mid = doc.createTask({ title: 'Кухня', parentId: root });
    doc.createTask({ title: 'Плита', parentId: mid, due: { date: '2026-10-14' } });
    const days = doc.upcoming('2026-10-13', 2, TZ);
    expect(shape(doc.nested(days[0]!.tasks))).toEqual([['Уборка', [['Кухня', [['Плита', []]]]]]]);
    // Завтра: будущий экземпляр «Уборки» без подзадач, «Плита» своей строкой.
    const tomorrow = doc.nested(days[1]!.tasks);
    expect(tomorrow.map((n) => [n.task.title, n.task.projected ?? false, n.children.length])).toEqual(
      expect.arrayContaining([
        ['Уборка', true, 0],
        ['Плита', false, 0],
      ]),
    );
  });
});

describe('выполненный сегодня повтор', () => {
  const daily = { rule: 'FREQ=DAILY', mode: 'schedule', text: 'каждый день' } as const;

  it('остаётся в «Сегодня» выполненным до конца дня и пропадает на следующий', () => {
    const { doc } = device();
    const id = doc.createTask({ title: 'Зарядка', due: { date: '2026-10-13', time: '08:00' }, recurrence: daily });
    const plain = doc.createTask({ title: 'Письмо', due: { date: '2026-10-13' } });
    doc.completeTask(id);
    doc.completeTask(plain);
    expect(doc.today('2026-10-13', TZ).today).toEqual([]);
    const done = doc.doneToday('2026-10-13', TZ);
    // Обычная выполненная задача сюда не попадает: она в «Выполненных».
    expect(done.map((t) => t.title)).toEqual(['Зарядка']);
    expect(done[0]).toMatchObject({ doneOccurrence: '2026-10-13', due: { date: '2026-10-13', time: '08:00' }, completedAt: NOON });
    expect(doc.doneToday('2026-10-14', TZ)).toEqual([]);
    expect(doc.today('2026-10-14', TZ).today.map((t) => t.title)).toEqual(['Зарядка']);
  });

  it('щелчок по выполненной строке возвращает срок на этот раз', () => {
    const { doc } = device();
    const id = doc.createTask({ title: 'Таблетки', due: { date: '2026-10-12' }, start: { date: '2026-10-12' }, recurrence: daily });
    doc.completeTask(id);
    expect(doc.task(id)).toMatchObject({ due: { date: '2026-10-14' }, start: { date: '2026-10-14' } });
    expect(doc.uncompleteOccurrence(id, '2026-10-12')).toBe(true);
    expect(doc.task(id)).toMatchObject({ due: { date: '2026-10-12' }, start: { date: '2026-10-12' } });
    expect(doc.completions(id)).toEqual([]);
    expect(doc.doneToday('2026-10-13', TZ)).toEqual([]);
    expect(doc.today('2026-10-13', TZ).overdue.map((t) => t.id)).toEqual([id]);
  });

  it('вернуть нельзя, если срок потом меняли или выполнен более поздний экземпляр', () => {
    const { doc, setTime } = device();
    const id = doc.createTask({ title: 'Полив', due: { date: '2026-10-13' }, recurrence: daily });
    doc.completeTask(id);
    doc.updateTask(id, { due: { date: '2026-10-20' } });
    expect(doc.canUncompleteOccurrence(id, '2026-10-13')).toBe(false);
    expect(doc.uncompleteOccurrence(id, '2026-10-13')).toBe(false);
    expect(doc.task(id)?.due?.date).toBe('2026-10-20');

    const other = doc.createTask({ title: 'Корм', due: { date: '2026-10-13' }, recurrence: daily });
    doc.completeTask(other);
    setTime(NOON + 60_000);
    doc.completeTask(other);
    expect(doc.doneToday('2026-10-13', TZ).filter((t) => t.id === other).map((t) => t.doneOccurrence)).toEqual(['2026-10-13', '2026-10-14']);
    expect(doc.canUncompleteOccurrence(other, '2026-10-13')).toBe(false);
    expect(doc.canUncompleteOccurrence(other, '2026-10-14')).toBe(true);
  });

  it('возврат экземпляра синхронизируется на другое устройство', () => {
    const a = device('00000000000000aa');
    const b = device('00000000000000bb');
    const id = a.doc.createTask({ title: 'Отчёт', due: { date: '2026-10-13' }, recurrence: daily });
    a.doc.completeTask(id);
    b.doc.applyRemote(a.doc.pending());
    expect(b.doc.doneToday('2026-10-13', TZ).map((t) => t.id)).toEqual([id]);
    a.setTime(NOON + 1000);
    a.doc.uncompleteOccurrence(id, '2026-10-13');
    b.doc.applyRemote(a.doc.pending());
    expect(b.doc.doneToday('2026-10-13', TZ)).toEqual([]);
    expect(b.doc.task(id)?.due?.date).toBe('2026-10-13');
    expect(b.doc.completions(id)).toEqual([]);
  });

  it('отмена действия снимает строку «выполнено»', () => {
    const { doc, setTime } = device();
    const id = doc.createTask({ title: 'Зарядка', due: { date: '2026-10-13' }, recurrence: daily });
    doc.completeTask(id);
    doc.undo();
    expect(doc.doneToday('2026-10-13', TZ)).toEqual([]);
    setTime(NOON + DAY);
    expect(doc.task(id)?.due?.date).toBe('2026-10-13');
  });
});

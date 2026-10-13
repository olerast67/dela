import { describe, expect, it } from 'vitest';
import { Doc, HybridClock, type Op } from '../src/index.ts';

const SPACE = '01929c3e-0000-7000-8000-0000000000aa';

function make(node = '00000000000000aa') {
  let time = 1_760_000_000_000;
  const doc = new Doc({ spaceId: SPACE, clock: new HybridClock(node, () => (time += 1)), now: () => time });
  return doc;
}

describe('корзина', () => {
  it('удаление навсегда затирает все поля задачи и подзадач, восстановить нельзя', () => {
    const doc = make();
    const ops: Op[] = [];
    const parent = doc.createTask({ title: 'Секретный план', description: 'подробности', due: { date: '2026-10-14' }, priority: 1 });
    const child = doc.createTask({ title: 'Шаг один', parentId: parent });
    doc.deleteTask(parent);
    expect(doc.trash().map((t) => t.id)).toEqual([parent]);
    doc.subscribe((o) => ops.push(...o));
    doc.purgeTask(parent);

    expect(doc.trash()).toEqual([]);
    for (const id of [parent, child]) {
      const rec = doc.replica.get('task', id)!;
      const content = Object.entries(rec).filter(([k, v]) => v !== null && k !== 'deleted_at' && k !== 'purged_at');
      expect(content).toEqual([]);
      expect(rec.purged_at).not.toBeNull();
    }
    // Каждое прежнее поле получило новое пустое значение: на сервере старый шифротекст заменится.
    expect(ops.some((o) => o.record === parent && o.field === 'title' && o.value === null)).toBe(true);
    expect(ops.some((o) => o.record === child && o.field === 'title' && o.value === null)).toBe(true);

    doc.restoreTask(parent);
    expect(doc.trash()).toEqual([]);
    expect(doc.projectTasks(doc.inboxId).unsectioned).toEqual([]);
    // Удаление навсегда не попадает в отмену.
    doc.undo();
    expect(doc.trash()).toEqual([]);
  });

  it('очистка корзины и только удалённые задачи', () => {
    const doc = make();
    const keep = doc.createTask({ title: 'Остаётся' });
    for (const title of ['а', 'б', 'в']) doc.deleteTask(doc.createTask({ title }));
    expect(doc.emptyTrash()).toBe(3);
    expect(doc.trash()).toEqual([]);
    expect(doc.task(keep)?.title).toBe('Остаётся');
    // Задачу не из корзины удалить навсегда нельзя.
    doc.purgeTask(keep);
    expect(doc.task(keep)?.title).toBe('Остаётся');
  });
});

import { describe, expect, it } from 'vitest';
import { Doc, HybridClock, type TaskNode } from '../src/index.ts';

const SPACE = '01929c3e-0000-7000-8000-00000000aaaa';
const TZ = 'Europe/Moscow';

function device(node: string, start = 1_760_000_000_000) {
  let time = start;
  const doc = new Doc({ spaceId: SPACE, clock: new HybridClock(node, () => time), now: () => time });
  return { doc, tick: (ms = 1) => (time += ms) };
}

/** Обмен очередями в обе стороны, как через сервер. */
function sync(...docs: Doc[]): void {
  const ops = docs.flatMap((d) => [...d.pending()]);
  for (const d of docs) {
    d.applyRemote(ops);
    d.acknowledge(d.pending());
  }
}

const titles = (nodes: readonly TaskNode[]): unknown[] =>
  nodes.map((n) => (n.children.length ? [n.task.title, titles(n.children)] : n.task.title));

describe('Doc: базовые действия', () => {
  it('задачи по умолчанию во Входящих, в порядке добавления', () => {
    const { doc, tick } = device('00000000000000aa');
    doc.createTask({ title: 'Первая' });
    tick();
    const b = doc.createTask({ title: 'Вторая' });
    tick();
    doc.createTask({ title: 'Между', position: { before: b } });
    expect(doc.project(doc.inboxId)?.isInbox).toBe(true);
    expect(titles(doc.projectTasks(doc.inboxId).unsectioned)).toEqual(['Первая', 'Между', 'Вторая']);
  });

  it('проекты, разделы, подзадачи', () => {
    const { doc } = device('00000000000000aa');
    const home = doc.createProject({ name: 'Дом', color: 'green' });
    const kitchen = doc.createSection(home, 'Кухня');
    const t = doc.createTask({ title: 'Ремонт', projectId: home, sectionId: kitchen });
    doc.createTask({ title: 'Купить краску', parentId: t });
    doc.createTask({ title: 'Позвонить мастеру', projectId: home });
    const view = doc.projectTasks(home);
    expect(titles(view.unsectioned)).toEqual(['Позвонить мастеру']);
    expect(view.sections.map((s) => [s.section.name, titles(s.tasks)])).toEqual([['Кухня', [['Ремонт', ['Купить краску']]]]]);
    expect(doc.task(t)?.childCount).toBe(1);
    expect(doc.projects().map((p) => p.project.name)).toEqual(['Дом']);
  });

  it('выполнение задачи закрывает подзадачи, повторное открытие — только саму задачу', () => {
    const { doc } = device('00000000000000aa');
    const t = doc.createTask({ title: 'Поездка' });
    const sub = doc.createTask({ title: 'Билеты', parentId: t });
    doc.completeTask(t);
    expect(doc.task(sub)?.completedAt).not.toBeNull();
    expect(doc.projectTasks(doc.inboxId).unsectioned).toEqual([]);
    doc.reopenTask(t);
    expect(titles(doc.projectTasks(doc.inboxId).unsectioned)).toEqual(['Поездка']);
    expect(doc.completedTasks().map((x) => x.title)).toEqual(['Билеты']);
  });

  it('удаление родителя прячет подзадачи, восстановление подзадачи возвращает родителя', () => {
    const { doc } = device('00000000000000aa');
    const t = doc.createTask({ title: 'Родитель' });
    const sub = doc.createTask({ title: 'Ребёнок', parentId: t });
    doc.deleteTask(t);
    expect(doc.isAlive(sub)).toBe(false);
    expect(doc.trash().map((x) => x.title)).toEqual(['Родитель']);
    doc.restoreTask(sub);
    expect(doc.isAlive(t)).toBe(true);
    expect(doc.isAlive(sub)).toBe(true);
  });

  it('удаление проекта прячет его задачи и подпроекты', () => {
    const { doc } = device('00000000000000aa');
    const work = doc.createProject({ name: 'Работа' });
    const sub = doc.createProject({ name: 'Отчёты', parentId: work });
    const t = doc.createTask({ title: 'Квартальный', projectId: sub });
    expect(doc.projects().map((p) => [p.project.name, p.depth])).toEqual([
      ['Работа', 0],
      ['Отчёты', 1],
    ]);
    doc.deleteProject(work);
    expect(doc.projects()).toEqual([]);
    expect(doc.isAlive(t)).toBe(false);
    expect(() => doc.deleteProject(doc.inboxId)).toThrow();
  });

  it('нельзя переместить задачу или проект внутрь самих себя', () => {
    const { doc } = device('00000000000000aa');
    const a = doc.createTask({ title: 'A' });
    const b = doc.createTask({ title: 'B', parentId: a });
    expect(() => doc.moveTask(a, { parentId: b })).toThrow();
    const p = doc.createProject({ name: 'P' });
    const q = doc.createProject({ name: 'Q', parentId: p });
    expect(() => doc.moveProject(p, { parentId: q })).toThrow();
  });

  it('метки', () => {
    const { doc } = device('00000000000000aa');
    const call = doc.createLabel('звонок');
    const urgent = doc.createLabel('срочно');
    const t = doc.createTask({ title: 'Позвонить', labels: [call] });
    doc.setLabels(t, [urgent]);
    expect(doc.task(t)?.labels).toEqual([urgent]);
    expect(doc.labels().map((l) => l.name)).toEqual(['звонок', 'срочно']);
  });

  it('поиск без учёта регистра и буквы ё', () => {
    const { doc } = device('00000000000000aa');
    doc.createTask({ title: 'Купить ЁЛКУ' });
    doc.createTask({ title: 'Другое', description: 'про елку тоже' });
    doc.createTask({ title: 'Мимо' });
    expect(doc.search('ёлк').map((t) => t.title).sort()).toEqual(['Другое', 'Купить ЁЛКУ']);
    expect(doc.search('  ')).toEqual([]);
  });

  it('событие об изменениях', () => {
    const { doc } = device('00000000000000aa');
    const seen: string[] = [];
    const off = doc.subscribe((ops, origin) => seen.push(`${origin}:${ops.length}`));
    doc.createLabel('x');
    off();
    doc.createLabel('y');
    expect(seen).toEqual(['local:3']);
  });
});

describe('Doc: Сегодня и Предстоящие', () => {
  it('просроченные, сегодняшние, порядок по времени и приоритету, отложенные скрыты', () => {
    const { doc } = device('00000000000000aa');
    doc.createTask({ title: 'Вчера', due: { date: '2026-10-12' } });
    doc.createTask({ title: 'Без времени p1', due: { date: '2026-10-13' }, priority: 1 });
    doc.createTask({ title: 'Без времени p4', due: { date: '2026-10-13' } });
    doc.createTask({ title: 'В 18', due: { date: '2026-10-13', time: '18:00' } });
    doc.createTask({ title: 'В 9', due: { date: '2026-10-13', time: '09:00' } });
    doc.createTask({ title: 'Завтра', due: { date: '2026-10-14' } });
    doc.createTask({ title: 'Отложена', due: { date: '2026-10-13' }, start: { date: '2026-10-20' } });
    const t = doc.today('2026-10-13', TZ);
    expect(t.overdue.map((x) => x.title)).toEqual(['Вчера']);
    expect(t.today.map((x) => x.title)).toEqual(['В 9', 'В 18', 'Без времени p1', 'Без времени p4']);
    const up = doc.upcoming('2026-10-13', 3, TZ);
    expect(up.map((g) => [g.date, g.tasks.length])).toEqual([
      ['2026-10-13', 5],
      ['2026-10-14', 1],
      ['2026-10-15', 0],
    ]);
  });

  it('созвон по Москве в 23:30 у пользователя в Новосибирске попадает на завтра', () => {
    const { doc } = device('00000000000000aa');
    doc.createTask({ title: 'Созвон', due: { date: '2026-10-13', time: '23:30', tz: 'Europe/Moscow' } });
    expect(doc.today('2026-10-13', 'Asia/Novosibirsk').today).toEqual([]);
    expect(doc.today('2026-10-14', 'Asia/Novosibirsk').today.map((x) => x.title)).toEqual(['Созвон']);
  });
});

describe('Doc: правки на двух устройствах офлайн', () => {
  it('разные поля одной задачи сохраняются оба', () => {
    const a = device('00000000000000aa');
    const b = device('00000000000000bb');
    const id = a.doc.createTask({ title: 'Задача' });
    sync(a.doc, b.doc);
    a.tick(10);
    b.tick(10);
    a.doc.updateTask(id, { priority: 1 });
    b.doc.updateTask(id, { due: { date: '2026-10-20' } });
    sync(a.doc, b.doc);
    for (const d of [a.doc, b.doc]) {
      expect(d.task(id)).toMatchObject({ priority: 1, due: { date: '2026-10-20' } });
    }
  });

  it('метки, добавленные на разных устройствах, не теряются', () => {
    const a = device('00000000000000aa');
    const b = device('00000000000000bb');
    const l1 = a.doc.createLabel('дом');
    const l2 = a.doc.createLabel('дача');
    const id = a.doc.createTask({ title: 'Полить цветы' });
    sync(a.doc, b.doc);
    a.doc.setLabels(id, [l1]);
    b.doc.setLabels(id, [l2]);
    sync(a.doc, b.doc);
    expect(a.doc.task(id)?.labels).toEqual([l1, l2].sort());
    expect(b.doc.task(id)?.labels).toEqual([l1, l2].sort());
  });

  it('цикл A внутри B и B внутри A разрывается одинаково на обоих устройствах', () => {
    const a = device('00000000000000aa');
    const b = device('00000000000000bb');
    const x = a.doc.createTask({ title: 'A' });
    const y = a.doc.createTask({ title: 'B' });
    sync(a.doc, b.doc);
    a.tick(5);
    a.doc.moveTask(x, { parentId: y }); // раньше
    b.tick(10);
    b.doc.moveTask(y, { parentId: x }); // позже
    sync(a.doc, b.doc);
    for (const d of [a.doc, b.doc]) {
      // Более старое перемещение (A в B) игнорируется, остаётся B внутри A.
      expect(titles(d.projectTasks(d.inboxId).unsectioned)).toEqual([['A', ['B']]]);
    }
  });

  it('подзадача, добавленная офлайн к перенесённой задаче, едет вместе с ней', () => {
    const a = device('00000000000000aa');
    const b = device('00000000000000bb');
    const work = a.doc.createProject({ name: 'Работа' });
    const parent = a.doc.createTask({ title: 'Отчёт' });
    sync(a.doc, b.doc);
    a.doc.moveTask(parent, { projectId: work });
    b.doc.createTask({ title: 'Собрать цифры', parentId: parent });
    sync(a.doc, b.doc);
    for (const d of [a.doc, b.doc]) {
      expect(titles(d.projectTasks(work).unsectioned)).toEqual([['Отчёт', ['Собрать цифры']]]);
      expect(d.projectTasks(d.inboxId).unsectioned).toEqual([]);
    }
  });

  it('Входящие, созданные на двух устройствах, сливаются в одни', () => {
    const a = device('00000000000000aa');
    const b = device('00000000000000bb');
    a.doc.createTask({ title: 'с телефона' });
    b.doc.createTask({ title: 'с ноутбука' });
    sync(a.doc, b.doc);
    expect(a.doc.projects()).toEqual([]);
    expect(titles(a.doc.projectTasks(a.doc.inboxId).unsectioned).sort()).toEqual(['с ноутбука', 'с телефона']);
  });

  it('испорченные значения от чужого клиента заменяются безопасными', () => {
    const { doc } = device('00000000000000aa');
    const id = doc.createTask({ title: 'ok' });
    doc.applyRemote([
      { table: 'task', record: id, field: 'priority', value: 99, hlc: '999999999999999-0000-00000000000000ff' },
      { table: 'task', record: id, field: 'due', value: { date: 'вчера' }, hlc: '999999999999999-0000-00000000000000ff' },
      { table: 'task', record: id, field: 'title', value: { x: 1 }, hlc: '999999999999999-0000-00000000000000ff' },
    ]);
    expect(doc.task(id)).toMatchObject({ priority: 4, due: null, title: '' });
  });
});

describe('Doc: отмена', () => {
  it('отменяет выполнение с подзадачами и удаление', () => {
    const { doc } = device('00000000000000aa');
    const t = doc.createTask({ title: 'Поездка' });
    const sub = doc.createTask({ title: 'Билеты', parentId: t });
    doc.completeTask(t);
    expect(doc.undo()).toBe(true);
    expect(doc.task(t)?.completedAt).toBeNull();
    expect(doc.task(sub)?.completedAt).toBeNull();
    doc.deleteTask(t);
    doc.undo();
    expect(doc.isAlive(t)).toBe(true);
  });

  it('отменяет выполнение повторяющейся задачи', () => {
    const { doc } = device('00000000000000aa');
    const t = doc.createTask({
      title: 'Зарядка',
      due: { date: '2026-10-13' },
      recurrence: { rule: 'FREQ=DAILY', mode: 'schedule', text: 'каждый день' },
    });
    doc.completeTask(t);
    expect(doc.task(t)?.due?.date).not.toBe('2026-10-13');
    doc.undo();
    expect(doc.task(t)?.due?.date).toBe('2026-10-13');
    expect(doc.completions(t)).toEqual([]);
  });
});

describe('Doc: отмена создания', () => {
  it('отмена создания задачи не оставляет пустую запись', () => {
    const { doc } = device('00000000000000aa');
    doc.createTask({ title: 'Лишняя' });
    doc.undo();
    expect(doc.projectTasks(doc.inboxId).unsectioned).toEqual([]);
    expect(doc.allTasks()).toEqual([]);
  });
});

describe('Doc: Входящие и отмена', () => {
  it('сколько ни отменяй, Входящие остаются', () => {
    const { doc } = device('00000000000000aa');
    doc.createTask({ title: 'Первая' });
    while (doc.undo());
    expect(doc.project(doc.inboxId)).toMatchObject({ isInbox: true, deletedAt: null });
  });
});

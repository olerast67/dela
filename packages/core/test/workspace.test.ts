import { describe, expect, it } from 'vitest';
import { Doc, HybridClock, MemoryReplica, Workspace, runFilter } from '../src/index.ts';

const NOW = Date.UTC(2026, 9, 13, 9, 0);
const TZ = 'Europe/Moscow';
const PERSONAL = '01929c3e-0000-7000-8000-0000000000a1';
const SHARED = '01929c3e-0000-7000-8000-0000000000b2';

function make() {
  const clock = new HybridClock('00000000000000aa', () => NOW);
  const personal = new Doc({ spaceId: PERSONAL, clock, now: () => NOW, timeZone: TZ });
  const ws = new Workspace(personal);
  const shared = new Doc({ spaceId: SHARED, clock, now: () => NOW, timeZone: TZ, kind: 'shared' });
  return { ws, personal, shared };
}

describe('Workspace', () => {
  it('делает личный проект общим вместе с разделами, задачами и подзадачами', () => {
    const { ws, personal, shared } = make();
    const fam = ws.createProject({ name: 'Семья', color: 'pink' });
    const sec = ws.createSection(fam, 'Покупки');
    const label = ws.createLabel('срочно');
    const t = ws.createTask({ title: 'Ремонт', projectId: fam, labels: [label], due: { date: '2026-10-13', time: '10:00' } });
    ws.createTask({ title: 'Краска', parentId: t });
    ws.createTask({ title: 'Хлеб', projectId: fam, sectionId: sec });
    const done = ws.createTask({ title: 'Сделано', projectId: fam });
    ws.completeTask(done);

    ws.shareProject(fam, shared);

    expect(personal.projects()).toEqual([]);
    expect(ws.projects().map((p) => [p.project.id, p.project.name, p.project.color])).toEqual([[SHARED, 'Семья', 'pink']]);
    const view = ws.projectTasks(SHARED);
    expect(view.unsectioned.map((n) => [n.task.title, n.children.map((c) => c.task.title)])).toEqual([['Ремонт', ['Краска']]]);
    expect(view.sections.map((s) => [s.section.name, s.tasks.map((n) => n.task.title)])).toEqual([['Покупки', ['Хлеб']]]);
    // Метки личные и в общий проект не переходят; срок сохраняется.
    expect(view.unsectioned[0]!.task).toMatchObject({ labels: [], due: { date: '2026-10-13', time: '10:00' } });
    expect(ws.completedTasks().map((x) => x.title)).toEqual(['Сделано']);
    // Своих «Входящих» в общем пространстве нет.
    expect(shared.project(SHARED)?.isInbox).toBe(false);
    expect(ws.today('2026-10-13', TZ).today.map((x) => x.title)).toEqual(['Ремонт']);
  });

  it('новые задачи и правки уходят в пространство проекта', () => {
    const { ws, personal, shared } = make();
    ws.addShared(shared);
    shared.write([['project', SHARED, 'name', 'Общий']]);
    const a = ws.createTask({ title: 'В общем', projectId: SHARED });
    const b = ws.createTask({ title: 'Во входящих' });
    expect(shared.task(a)).toBeDefined();
    expect(personal.task(b)).toBeDefined();
    ws.updateTask(a, { priority: 1 });
    expect(shared.task(a)?.priority).toBe(1);
    expect(ws.search('в').map((t) => t.title).sort()).toEqual(['В общем', 'Во входящих']);
    expect(runFilter(ws, 'p1', '2026-10-13', TZ).tasks.map((t) => t.title)).toEqual(['В общем']);
  });

  it('перенос задачи между пространствами и его отмена одним действием', () => {
    const { ws, personal, shared } = make();
    ws.addShared(shared);
    shared.write([['project', SHARED, 'name', 'Общий']]);
    const t = ws.createTask({ title: 'Перенести', priority: 2 });
    ws.createTask({ title: 'Под', parentId: t });
    ws.moveTask(t, { projectId: SHARED });
    expect(personal.isAlive(t)).toBe(false);
    const moved = ws.projectTasks(SHARED).unsectioned;
    expect(moved.map((n) => [n.task.title, n.task.priority, n.children.length])).toEqual([['Перенести', 2, 1]]);
    expect(ws.undo()).toBe(true);
    expect(personal.isAlive(t)).toBe(true);
    expect(ws.projectTasks(SHARED).unsectioned).toEqual([]);
  });

  it('удаление общего пространства из Workspace убирает его задачи из запросов', () => {
    const { ws, shared } = make();
    ws.addShared(shared);
    ws.createTask({ title: 'Чужая', projectId: SHARED, due: { date: '2026-10-13' } });
    expect(ws.today('2026-10-13', TZ).today).toHaveLength(1);
    ws.removeShared(SHARED);
    expect(ws.today('2026-10-13', TZ).today).toHaveLength(0);
    expect(ws.canUndo).toBe(false);
  });

  it('совместим с реплицированным общим пространством на втором устройстве', () => {
    const { ws, shared } = make();
    const fam = ws.createProject({ name: 'Семья' });
    ws.createTask({ title: 'Общее дело', projectId: fam });
    ws.shareProject(fam, shared);
    // Второй участник получает операции пространства.
    const other = new Doc({ spaceId: SHARED, clock: new HybridClock('00000000000000bb', () => NOW), replica: new MemoryReplica(), kind: 'shared' });
    other.applyRemote([...shared.pending()]);
    expect(other.projects().map((p) => p.project.name)).toEqual(['Семья']);
    expect(other.projectTasks(SHARED).unsectioned.map((n) => n.task.title)).toEqual(['Общее дело']);
  });
});

describe('Workspace: отмена', () => {
  it('служебное создание Входящих не сбивает историю отмены', () => {
    const { ws } = make();
    const a = ws.createTask({ title: 'A' });
    ws.updateTask(a, { priority: 1 });
    ws.undo();
    expect(ws.task(a)?.priority).toBe(4);
    ws.undo();
    expect(ws.isAlive(a)).toBe(false);
    expect(ws.undo()).toBe(false);
    expect(ws.project(ws.inboxId)?.isInbox).toBe(true);
  });
});

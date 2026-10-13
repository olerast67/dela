import { describe, expect, it } from 'vitest';
import { Doc, HybridClock, exportJson, exportMarkdown, importTodoist, todoistDue, type TodoistData } from '../src/index.ts';

const NOW = Date.UTC(2026, 9, 13, 9, 0);

function fresh() {
  return new Doc({ spaceId: '01929c3e-0000-7000-8000-00000000cccc', clock: new HybridClock('00000000000000aa', () => NOW), now: () => NOW, timeZone: 'Europe/Moscow' });
}

const data: TodoistData = {
  projects: [
    { id: 'in', name: 'Inbox', inbox_project: true, child_order: 0 },
    { id: 'w', name: 'Работа', color: 'berry_red', child_order: 2, view_style: 'board', is_favorite: true },
    { id: 'h', name: 'Дом', color: 'lime_green', child_order: 1 },
    { id: 'r', name: 'Отчёты', parent_id: 'w', child_order: 1 },
    { id: 'gone', name: 'Удалён', is_deleted: true },
  ],
  sections: [
    { id: 's2', name: 'Потом', project_id: 'w', section_order: 2 },
    { id: 's1', name: 'Сейчас', project_id: 'w', section_order: 1 },
  ],
  labels: [{ id: 'l1', name: 'звонок', color: 'blue', item_order: 1 }],
  items: [
    { id: 'a', content: 'Купить хлеб', project_id: 'in', child_order: 2, priority: 4, labels: ['звонок', 'магазин'] },
    { id: 'b', content: 'Первая', project_id: 'in', child_order: 1, due: { date: '2026-10-14' } },
    { id: 'c', content: 'Планёрка', project_id: 'w', section_id: 's1', child_order: 1, due: { date: '2026-10-19T10:00:00', is_recurring: true, string: 'every monday at 10' } },
    { id: 'd', content: 'Подзадача', project_id: 'w', parent_id: 'c', child_order: 1 },
    { id: 'e', content: 'Созвон', project_id: 'h', due: { date: '2026-10-13T12:00:00.000000Z', timezone: 'Europe/Moscow' }, duration: { amount: 45, unit: 'minute' } },
    { id: 'f', content: 'Странный повтор', project_id: 'h', due: { date: '2026-10-13', is_recurring: true, string: 'every 3rd workday of quarter' } },
    { id: 'g', content: 'Русский повтор', project_id: 'h', due: { date: '2026-10-19', is_recurring: true, string: 'каждый понедельник' }, deadline: { date: '2026-12-01' } },
    { id: 'x', content: 'Выполнена', project_id: 'h', checked: true },
    { id: 'y', content: 'Удалена', project_id: 'h', is_deleted: true },
  ],
  notes: [{ item_id: 'a', content: 'Бородинский', posted_at: '2026-10-01T10:00:00Z' }],
  filters: [{ id: 'f1', name: 'Срочное', query: 'p1 & (today | overdue)', item_order: 1 }],
};

describe('импорт из Todoist', () => {
  it('сроки: дата, плавающее время, время в поясе', () => {
    expect(todoistDue({ date: '2026-10-14' })).toEqual({ date: '2026-10-14' });
    expect(todoistDue({ date: '2026-10-14T19:00:00' })).toEqual({ date: '2026-10-14', time: '19:00' });
    expect(todoistDue({ date: '2026-10-13T12:00:00.000000Z', timezone: 'Europe/Moscow' })).toEqual({ date: '2026-10-13', time: '15:00', tz: 'Europe/Moscow' });
    expect(todoistDue({ date: 'вчера' })).toBeNull();
  });

  it('переносит проекты, разделы, задачи, метки, повторы и фильтры', () => {
    const doc = fresh();
    const summary = importTodoist(doc, data, { now: NOW, tz: 'Europe/Moscow' });
    expect(summary).toEqual({ projects: 3, sections: 2, tasks: 7, labels: 2, filters: 1, unparsedRecurrences: ['every 3rd workday of quarter'] });

    expect(doc.projects().map((p) => [p.project.name, p.depth])).toEqual([
      ['Дом', 0],
      ['Работа', 0],
      ['Отчёты', 1],
    ]);
    const work = doc.projects().find((p) => p.project.name === 'Работа')!.project;
    expect(work).toMatchObject({ color: 'pink', view: 'board', favorite: true });

    const inbox = doc.projectTasks(doc.inboxId).unsectioned.map((n) => n.task);
    expect(inbox.map((t) => t.title)).toEqual(['Первая', 'Купить хлеб']);
    const bread = inbox[1]!;
    expect(bread.priority).toBe(1);
    expect(bread.labels.map((id) => doc.label(id)!.name).sort()).toEqual(['звонок', 'магазин']);
    expect(bread.description).toContain('Бородинский');

    const wv = doc.projectTasks(work.id);
    expect(wv.sections.map((s) => s.section.name)).toEqual(['Сейчас', 'Потом']);
    const standup = wv.sections[0]!.tasks[0]!;
    expect(standup.task).toMatchObject({ title: 'Планёрка', due: { date: '2026-10-19', time: '10:00' }, recurrence: { rule: 'FREQ=WEEKLY;BYDAY=MO', text: 'every monday at 10' } });
    expect(standup.children.map((c) => c.task.title)).toEqual(['Подзадача']);

    const all = doc.allTasks();
    expect(all.find((t) => t.title === 'Созвон')).toMatchObject({ due: { date: '2026-10-13', time: '15:00', tz: 'Europe/Moscow' }, duration: 45 });
    expect(all.find((t) => t.title === 'Странный повтор')).toMatchObject({ recurrence: null, description: 'Повтор в Todoist: every 3rd workday of quarter' });
    expect(all.find((t) => t.title === 'Русский повтор')).toMatchObject({ recurrence: { rule: 'FREQ=WEEKLY;BYDAY=MO' }, deadline: '2026-12-01' });
    expect(all.some((t) => t.title === 'Выполнена' || t.title === 'Удалена')).toBe(false);
    expect(doc.filters().map((f) => [f.name, f.query])).toEqual([['Срочное', 'p1 & (today | overdue)']]);
  });

  it('метки с тем же именем не дублируются', () => {
    const doc = fresh();
    doc.createLabel('Звонок');
    importTodoist(doc, data, { now: NOW });
    expect(doc.labels().map((l) => l.name).sort()).toEqual(['Звонок', 'магазин']);
  });
});

describe('экспорт', () => {
  it('JSON содержит всё и не содержит служебных полей', () => {
    const doc = fresh();
    importTodoist(doc, data, { now: NOW });
    const out = exportJson(doc, NOW);
    expect(out).toMatchObject({ format: 'dela-export', version: 1, exportedAt: '2026-10-13T09:00:00.000Z' });
    expect(out.tasks).toHaveLength(7);
    expect(out.projects).toHaveLength(4);
    expect(JSON.stringify(out)).not.toContain('childCount');
  });

  it('Markdown', () => {
    const doc = fresh();
    importTodoist(doc, data, { now: NOW });
    const md = exportMarkdown(doc);
    expect(md).toContain('## Входящие');
    expect(md).toContain('- [ ] Купить хлеб (p1, @');
    expect(md).toContain('### Сейчас');
    expect(md).toContain('  - [ ] Подзадача');
  });
});

import { describe, expect, it } from 'vitest';
import { BUILTIN_TEMPLATES, Doc, HybridClock, Workspace, applyTemplate, parseTemplate, projectToTemplate } from '../src/index.ts';

function make(kind: 'personal' | 'shared' = 'personal') {
  let time = 1_760_000_000_000;
  const doc = new Doc({ spaceId: '01929c3e-0000-7000-8000-0000000000aa', clock: new HybridClock('00000000000000aa', () => (time += 1000)), now: () => time, kind });
  return doc;
}

describe('история', () => {
  it('создание, выполнение, повтор, комментарий, удаление; автор в общем проекте', () => {
    const doc = make('shared');
    doc.actor = '01929c3e-0000-7000-8000-0000000000b1';
    const project = doc.spaceId;
    doc.createProject({ name: 'Общий' });
    const a = doc.createTask({ title: 'Купить краску', projectId: project });
    const b = doc.createTask({ title: 'Полить цветы', projectId: project, due: { date: '2026-10-13' }, recurrence: { rule: 'FREQ=DAILY', mode: 'schedule', text: 'каждый день' } });
    doc.completeTask(a);
    doc.completeTask(b);
    doc.addComment(a, { text: 'Белую', author: doc.actor });
    const c = doc.createTask({ title: 'Лишнее', projectId: project });
    doc.deleteTask(c);
    const kinds = doc.activity().map((e) => `${e.kind}:${e.title}`);
    expect(kinds.slice(0, 4)).toEqual(['deleted:Лишнее', 'created:Лишнее', 'comment:Купить краску', 'completed:Полить цветы']);
    expect(kinds).toContain('completed:Купить краску');
    expect(doc.activity().find((e) => e.kind === 'completed' && e.title === 'Купить краску')?.actor).toBe(doc.actor);
    // Удалённое навсегда пропадает и из истории.
    doc.purgeTask(c);
    expect(doc.activity().some((e) => e.title === 'Лишнее')).toBe(false);
  });
});

describe('шаблоны', () => {
  it('проект в шаблон и обратно: разделы, подзадачи, метки, сроки относительно дня', () => {
    const ws = new Workspace(make());
    const p = ws.createProject({ name: 'Ремонт', color: 'orange' });
    const label = ws.createLabel('магазин');
    const s = ws.createSection(p, 'Покупки');
    const parent = ws.createTask({ title: 'Краска', projectId: p, sectionId: s, labels: [label], due: { date: '2026-10-15', time: '10:00' }, priority: 2 });
    ws.createTask({ title: 'Валик', parentId: parent });
    ws.createTask({ title: 'Позвать мастера', projectId: p });
    const tpl = projectToTemplate(ws, p, '2026-10-13', 'Europe/Moscow');
    expect(tpl.sections[0]).toMatchObject({ name: 'Покупки', tasks: [{ title: 'Краска', dueIn: 2, time: '10:00', priority: 2, labels: ['магазин'], children: [{ title: 'Валик' }] }] });
    const copy = applyTemplate(ws, parseTemplate(JSON.parse(JSON.stringify(tpl))), '2026-11-01', 'Ремонт 2');
    const view = ws.projectTasks(copy);
    expect(ws.project(copy)?.name).toBe('Ремонт 2');
    expect(view.unsectioned.map((n) => n.task.title)).toEqual(['Позвать мастера']);
    const krasca = view.sections[0]!.tasks[0]!;
    expect(krasca.task.due).toEqual({ date: '2026-11-03', time: '10:00' });
    expect(krasca.task.labels).toEqual([label]);
    expect(krasca.children.map((n) => n.task.title)).toEqual(['Валик']);
  });

  it('встроенные шаблоны создаются; повтор начинается в день правила; мусор не принимается', () => {
    const ws = new Workspace(make());
    for (const t of BUILTIN_TEMPLATES) applyTemplate(ws, t, '2026-10-13');
    const week = ws.projects().find((n) => n.project.name === 'Неделя')!.project.id;
    const review = ws.projectTasks(week).unsectioned.find((n) => n.task.title.startsWith('Обзор недели'))!;
    expect(review.task.due?.date).toBe('2026-10-18');
    expect(() => parseTemplate({ v: 2 })).toThrow();
    expect(() => parseTemplate({ v: 1, name: 'x', tasks: [{}], sections: [] })).toThrow();
  });

  it('свои шаблоны хранятся в личном пространстве', () => {
    const ws = new Workspace(make());
    const id = ws.saveTemplate('Мой', { v: 1, name: 'Мой', color: 'gray', tasks: [], sections: [] });
    expect(ws.templates().map((t) => t.name)).toEqual(['Мой']);
    ws.deleteTemplate(id);
    expect(ws.templates()).toEqual([]);
  });
});

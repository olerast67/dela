import { describe, expect, it } from 'vitest';
import { Doc, HybridClock, extractLinks, welcomeTasks } from '../src/index.ts';

describe('приветственные задачи', () => {
  it('первая задача ведёт на olerast.com и стоит на сегодня', () => {
    const doc = new Doc({ spaceId: '01929c3e-0000-7000-8000-00000000ffff', clock: new HybridClock('00000000000000aa', () => 1), now: () => 1 });
    for (const t of welcomeTasks('2026-10-13')) doc.createTask(t);
    const tasks = doc.projectTasks(doc.inboxId).unsectioned.map((n) => n.task);
    expect(tasks[0]).toMatchObject({ title: 'Подписаться на olerast', priority: 1, due: { date: '2026-10-13' } });
    expect(extractLinks(tasks[0]!.description)).toContain('https://olerast.com/');
    expect(tasks).toHaveLength(4);
  });

  it('ссылки из текста', () => {
    expect(extractLinks('Сайт: https://olerast.com, видео (https://youtu.be/x). javascript:alert(1) http://a.b/c?d=1.')).toEqual([
      'https://olerast.com/',
      'https://youtu.be/x',
      'http://a.b/c?d=1',
    ]);
    expect(extractLinks('ничего')).toEqual([]);
  });
});

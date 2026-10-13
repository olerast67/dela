import { describe, expect, it } from 'vitest';
import { Doc, HybridClock, Workspace, widgetSnapshot } from '../src/index.ts';

describe('снимок для виджета', () => {
  it('открытые задачи со сроком и проектом, выполненные не попадают', () => {
    let time = 1_760_000_000_000;
    const doc = new Doc({ spaceId: '01929c3e-0000-7000-8000-0000000000aa', clock: new HybridClock('00000000000000aa', () => (time += 1)), now: () => time });
    const ws = new Workspace(doc);
    const home = ws.createProject({ name: 'Дом' });
    ws.createTask({ title: 'Вчерашняя', due: { date: '2026-10-12' }, priority: 1 });
    ws.createTask({ title: 'Созвон', due: { date: '2026-10-13', time: '10:00' }, projectId: home });
    const done = ws.createTask({ title: 'Готово', due: { date: '2026-10-13' } });
    ws.completeTask(done);
    ws.createTask({ title: 'Когда-нибудь', projectId: home });
    const snap = widgetSnapshot(ws, '2026-10-13', 'Europe/Moscow', true);
    expect(snap.lock).toBe(true);
    expect(snap.projects.map((p) => p.name)).toEqual(['Входящие', 'Дом']);
    expect(snap.tasks.map((t) => t.t)).toEqual(['Вчерашняя', 'Созвон', 'Когда-нибудь']);
    expect(snap.tasks[1]).toMatchObject({ p: home, d: '2026-10-13', tm: '10:00', pr: 4, r: false });
    expect(widgetSnapshot(ws, '2026-10-13', 'Europe/Moscow', false, 1).tasks).toHaveLength(1);
  });
});

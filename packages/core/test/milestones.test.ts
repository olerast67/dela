import { describe, expect, it } from 'vitest';
import { DEFAULT_GAME_SETTINGS, Doc, HybridClock, Workspace, computeMilestones, type DoneEvent, type MilestoneInput } from '../src/index.ts';

const TZ = 'Europe/Moscow';
const DAY = 86_400_000;
const T0 = Date.parse('2026-01-01T09:00:00Z');
/** n выполнений по одному в день, начиная с 1 января. */
const daily = (n: number, projectId = 'p'): DoneEvent[] => Array.from({ length: n }, (_, i) => ({ at: T0 + i * DAY, projectId }));
const input = (patch: Partial<MilestoneInput> = {}): MilestoneInput => ({ events: [], work: [], inboxId: 'inbox', habits: [], goalStreak: null, tz: TZ, ...patch });
const ids = (m: ReturnType<typeof computeMilestones>) => m.reached.map((r) => r.id).sort();

describe('вехи', () => {
  it('пороги по числу выполненных задач и даты пересечения', () => {
    const m = computeMilestones(input({ events: daily(100) }));
    expect(ids(m)).toEqual(['tasks:10', 'tasks:100']);
    // Десятая задача — 10 января, сотая — 10 апреля.
    expect(m.reached.find((r) => r.id === 'tasks:10')?.date).toBe('2026-01-10');
    expect(m.reached.find((r) => r.id === 'tasks:100')?.date).toBe('2026-04-10');
    // Свежие первыми.
    expect(m.reached[0]?.id).toBe('tasks:100');
    expect(computeMilestones(input({ events: daily(9) })).reached).toEqual([]);
  });

  it('ближайшая следующая: по доле порога, с прогрессом', () => {
    const m = computeMilestones(input({ events: daily(88) }));
    expect(m.next).toEqual({ id: 'tasks:100', kind: 'tasks', target: 100, progress: 88 });
    // Помодоро ближе к порогу, чем задачи.
    const work = Array.from({ length: 9 }, (_, i) => ({ at: T0 + i * 60_000, minutes: 25 }));
    expect(computeMilestones(input({ events: daily(50), work })).next).toMatchObject({ id: 'pomodoro:10', progress: 9 });
    // Ничего не сделано: показываем первую веху, а не пустоту.
    expect(computeMilestones(input()).next).toMatchObject({ id: 'tasks:10', progress: 0 });
  });

  it('«Входящие» считаются отдельно, отрезки помодоро тоже', () => {
    const events = [...daily(60, 'inbox'), ...daily(5)];
    const work = Array.from({ length: 10 }, (_, i) => ({ at: T0 + i * DAY, minutes: 25 }));
    const m = computeMilestones(input({ events, work }));
    expect(ids(m)).toEqual(['inbox:50', 'pomodoro:10', 'tasks:10']);
    expect(m.reached.find((r) => r.id === 'inbox:50')?.date).toBe('2026-02-19');
    expect(m.reached.find((r) => r.id === 'pomodoro:10')?.date).toBe('2026-01-10');
  });

  it('привычка и серия целей: берутся даты порогов, самая ранняя из привычек', () => {
    const m = computeMilestones(
      input({
        habits: [
          { current: 12, reached: { 30: '2026-03-01' } },
          { current: 40, reached: { 30: '2026-02-10' } },
        ],
        goalStreak: { current: 3, reached: new Map([[7, '2026-05-02']]) },
      }),
    );
    expect(m.reached.find((r) => r.id === 'habit:30')?.date).toBe('2026-02-10');
    expect(m.reached.find((r) => r.id === 'goal:7')?.date).toBe('2026-05-02');
    expect(ids(m)).not.toContain('habit:100');
    // Прервавшаяся серия целей веху не отнимает.
    expect(ids(m)).toContain('goal:7');
  });

  it('«ждала 100 дней»: только у обычных задач, дата — день закрытия', () => {
    const at = T0 + 200 * DAY;
    const m = computeMilestones(input({ events: [{ at: T0 + 10 * DAY, projectId: 'p', createdAt: T0 }, { at, projectId: 'p', createdAt: at - 100 * DAY }] }));
    expect(m.reached.find((r) => r.id === 'waited:100')?.date).toBe('2026-07-20');
    expect(ids(computeMilestones(input({ events: [{ at, projectId: 'p', createdAt: at - 99 * DAY }] })))).toEqual([]);
    // Ближайшей такая веха не бывает.
    expect(computeMilestones(input({ events: [{ at, projectId: 'p', createdAt: at - 5 * DAY }] })).next?.kind).not.toBe('waited');
  });
});

describe('вехи в пространстве', () => {
  const NOW = Date.parse('2026-10-21T09:00:00Z');
  const make = () => {
    let now = NOW;
    const ws = new Workspace(new Doc({ spaceId: '01929c3e-0000-7000-8000-00000000eeef', clock: new HybridClock('a'.padStart(16, '0'), () => now), now: () => now, timeZone: TZ }));
    return { ws, tick: (ms: number) => (now += ms) };
  };

  it('десятая выполненная задача даёт веху; считается по данным, ничего не хранит', () => {
    const { ws, tick } = make();
    const today = '2026-10-21';
    for (let i = 0; i < 10; i++) {
      const id = ws.createTask({ title: `t${i}` });
      expect(ws.milestones(TZ, today).reached).toEqual([]);
      tick(1000);
      ws.completeTask(id);
      tick(1000);
    }
    const m = ws.milestones(TZ, today);
    expect(m.reached.map((r) => r.id)).toContain('tasks:10');
    expect(m.reached.find((r) => r.id === 'tasks:10')?.date).toBe(today);
    expect(DEFAULT_GAME_SETTINGS.milestones).toBe(true);
  });
});

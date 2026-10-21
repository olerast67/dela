import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GAME_SETTINGS,
  Doc,
  HybridClock,
  Workspace,
  afterCompletion,
  beforeCompletion,
  completionFacts,
  computeGoals,
  suggestDailyGoal,
  type GameSettings,
} from '../src/index.ts';

const TZ = 'Europe/Moscow';
// 2026-10-21 — среда; недели начинаются 12 и 19 октября.
const TODAY = '2026-10-21';
const set = (patch: Partial<GameSettings>): GameSettings => ({ ...DEFAULT_GAME_SETTINGS, ...patch });
/** n выполнений в полдень по Москве. */
const on = (date: string, n: number) => Array.from({ length: n }, (_, i) => ({ at: Date.parse(`${date}T09:00:00Z`) + i * 60_000, projectId: 'p' }));
const states = (g: ReturnType<typeof computeGoals>) => g.days.map((d) => d.state);

describe('цели дня и недели', () => {
  it('прогресс дня и недели с понедельника', () => {
    const events = [...on('2026-10-18', 5), ...on('2026-10-19', 3), ...on('2026-10-20', 2), ...on(TODAY, 1)];
    const g = computeGoals(events, set({ dailyGoal: 3, weeklyGoal: 10 }), TZ, TODAY);
    expect(g.day).toEqual({ done: 1, goal: 3, off: null });
    // Воскресенье 18-го — прошлая неделя.
    expect(g.week).toEqual({ start: '2026-10-19', done: 6, goal: 10 });
    expect(g.days.map((d) => d.count)).toEqual([3, 2, 1, 0, 0, 0, 0]);
    // Вторник не добрал цель: пропуск по запасу; сегодня ещё можно успеть.
    expect(states(g)).toEqual(['done', 'allowed', 'today', 'planned', 'planned', 'planned', 'planned']);
    expect(g.streak).toEqual({ current: 2, best: 2 });
  });

  it('без цели дня нет серии, цель недели считается', () => {
    const g = computeGoals(on(TODAY, 2), set({ weeklyGoal: 20 }), TZ, TODAY);
    expect(g.streak).toBeNull();
    expect(g.day.goal).toBeNull();
    expect(g.week.done).toBe(2);
    expect(computeGoals([], DEFAULT_GAME_SETTINGS, TZ, TODAY).week.goal).toBeNull();
  });

  it('один пропуск в неделю не рвёт серию и не прибавляет, второй — рвёт', () => {
    const events = [
      ...on('2026-10-12', 3), // done 1
      // 13-го пусто: запас недели
      ...on('2026-10-14', 3), // done 2
      // 15-го пусто: второй пропуск, серия заново
      ...on('2026-10-16', 3),
      ...on('2026-10-17', 3),
      ...on('2026-10-18', 3), // 3 подряд
      // 19-го пусто: новая неделя, новый запас
      ...on('2026-10-20', 3), // 4
    ];
    const g = computeGoals(events, set({ dailyGoal: 3 }), TZ, TODAY);
    expect(g.streak).toEqual({ current: 4, best: 4 });
    expect(states(g).slice(0, 3)).toEqual(['allowed', 'done', 'today']);
    // Без 20-го: два пропуска на новой неделе (19 и 20) — серия оборвана.
    const broken = computeGoals(events.filter((e) => e.at < Date.parse('2026-10-19T00:00:00Z')), set({ dailyGoal: 3 }), TZ, TODAY);
    expect(broken.streak).toEqual({ current: 0, best: 3 });
    expect(states(broken).slice(0, 3)).toEqual(['allowed', 'missed', 'today']);
  });

  it('сегодняшний незакрытый день серию не рвёт, выполненный — прибавляет', () => {
    const events = [...on('2026-10-19', 2), ...on('2026-10-20', 2)];
    const s = set({ dailyGoal: 2 });
    expect(computeGoals(events, s, TZ, TODAY).streak).toEqual({ current: 2, best: 2 });
    expect(computeGoals([...events, ...on(TODAY, 1)], s, TZ, TODAY).streak!.current).toBe(2);
    const done = computeGoals([...events, ...on(TODAY, 2)], s, TZ, TODAY);
    expect(done.streak!.current).toBe(3);
    expect(done.days[2]!.state).toBe('done');
  });

  it('выходные не считаются и не рвут серию', () => {
    const weekdays = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20'];
    const events = weekdays.flatMap((d) => on(d, 2));
    const s = set({ dailyGoal: 2, restDays: [6, 7] });
    const g = computeGoals(events, s, TZ, TODAY);
    expect(g.streak).toEqual({ current: 7, best: 7 });
    expect(states(g).slice(5)).toEqual(['rest', 'rest']);
    // Без выходных те же два пустых дня съели бы запас и оборвали серию.
    expect(computeGoals(events, set({ dailyGoal: 2 }), TZ, TODAY).streak!.current).toBe(2);
    // Выполненная цель в выходной тоже не прибавляет.
    expect(computeGoals([...events, ...on('2026-10-17', 5)], s, TZ, TODAY).streak!.current).toBe(7);
    // Сегодня выходной: цели нет, есть подпись.
    const restToday = computeGoals(events, set({ dailyGoal: 2, restDays: [3] }), TZ, TODAY);
    expect(restToday.day).toEqual({ done: 0, goal: null, off: 'rest' });
  });

  it('отпуск замораживает серию', () => {
    const events = [...on('2026-10-12', 1), ...on('2026-10-19', 1), ...on('2026-10-20', 1)];
    const s = set({ dailyGoal: 1, vacationFrom: '2026-10-13', vacationTo: '2026-10-18' });
    const g = computeGoals(events, s, TZ, TODAY);
    expect(g.streak).toEqual({ current: 3, best: 3 });
    // Сегодня в отпуске: цели нет.
    const away = computeGoals(events, { ...s, vacationFrom: TODAY, vacationTo: '2026-10-25' }, TZ, TODAY);
    expect(away.day).toEqual({ done: 0, goal: null, off: 'vacation' });
    expect(states(away)).toEqual(['done', 'done', 'vacation', 'vacation', 'vacation', 'vacation', 'vacation']);
    expect(away.streak!.current).toBe(2);
  });

  it('граница суток по часовому поясу, как у статистики', () => {
    // 21:30 UTC 20-го — в Москве уже 21-е.
    const events = [{ at: Date.parse('2026-10-20T21:30:00Z'), projectId: 'p' }];
    const s = set({ dailyGoal: 1 });
    expect(computeGoals(events, s, 'Europe/Moscow', TODAY).day.done).toBe(1);
    expect(computeGoals(events, s, 'UTC', TODAY).day.done).toBe(0);
    expect(computeGoals(events, s, 'UTC', '2026-10-20').day.done).toBe(1);
  });
});

describe('подсказка цели', () => {
  it('среднее за две недели без сегодня, выходных и отпуска, округлённое', () => {
    const events: ReturnType<typeof on> = [];
    // 14 дней с 7 по 20 октября: по 4 в будни, по 10 в выходные, сегодня 30.
    for (let d = 7; d <= 20; d++) {
      const date = `2026-10-${String(d).padStart(2, '0')}`;
      const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
      events.push(...on(date, wd === 0 || wd === 6 ? 10 : 4));
    }
    events.push(...on(TODAY, 30));
    expect(suggestDailyGoal(events, set({ restDays: [6, 7] }), TZ, TODAY)).toBe(4);
    // С выходными в счёте: (10 × 4 + 4 × 10) / 14 = 5,7 → 6.
    expect(suggestDailyGoal(events, DEFAULT_GAME_SETTINGS, TZ, TODAY)).toBe(6);
    // Отпуск на будни второй недели: остаются будни первой и выходные.
    expect(suggestDailyGoal(events, set({ vacationFrom: '2026-10-12', vacationTo: '2026-10-16' }), TZ, TODAY)).toBe(7);
  });

  it('новичок: дни до первого выполнения не считаются; нечего подсказать — null', () => {
    expect(suggestDailyGoal(on('2026-10-19', 3), DEFAULT_GAME_SETTINGS, TZ, TODAY)).toBe(2);
    expect(suggestDailyGoal(on(TODAY, 3), DEFAULT_GAME_SETTINGS, TZ, TODAY)).toBeNull();
    expect(suggestDailyGoal([], DEFAULT_GAME_SETTINGS, TZ, TODAY)).toBeNull();
    // В среднем меньше одной задачи в день.
    expect(suggestDailyGoal(on('2026-10-08', 1), DEFAULT_GAME_SETTINGS, TZ, TODAY)).toBeNull();
  });
});

describe('цели в Workspace и тёплых фразах', () => {
  const DAY = 86_400_000;
  const START = Date.parse('2026-10-19T09:00:00Z');
  const doc = (now: () => number) => new Doc({ spaceId: '01929c3e-0000-7000-8000-00000000eeef', clock: new HybridClock('a'.padStart(16, '0'), now), now, timeZone: TZ });

  function complete(ws: Workspace, id: string, now: number) {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(now));
    const before = beforeCompletion(ws, id, today, TZ)!;
    ws.completeTask(id);
    return completionFacts(before, afterCompletion(ws, before, today, TZ), today, TZ);
  }

  it('цель дня выполнена второй день подряд, цель недели добрана', () => {
    let t = START;
    const ws = new Workspace(doc(() => t));
    ws.updateGameSettings({ dailyGoal: 2, weeklyGoal: 4 });
    const task = () => ws.createTask({ title: 'Дело' });
    expect(complete(ws, task(), t)).toEqual([]);
    // Первый день с целью — серия 1, фразы нет.
    expect(complete(ws, task(), t)).toEqual([]);
    t += DAY;
    expect(complete(ws, task(), t)).toEqual([]);
    expect(complete(ws, task(), t)).toEqual([
      { kind: 'goalStreak', days: 2 },
      { kind: 'weekGoal', goal: 4 },
    ]);
    // Сверх цели — без повторов.
    expect(complete(ws, task(), t)).toEqual([]);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(t));
    expect(ws.goals(TZ, today)).toMatchObject({ day: { done: 3, goal: 2 }, week: { done: 5, goal: 4 }, streak: { current: 2, best: 2 } });
    expect(ws.suggestDailyGoal(TZ, today)).toBe(2);
  });
});

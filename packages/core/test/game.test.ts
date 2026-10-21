import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GAME_SETTINGS,
  Doc,
  HybridClock,
  Workspace,
  afterCompletion,
  beforeCompletion,
  completionFacts,
  gameFeature,
  initCrypto,
  isRestDay,
  newKey,
  onVacation,
  pickPhrase,
  sealOp,
  spaceKeys,
  PHRASE_GAP,
  type Op,
  type WarmFact,
} from '../src/index.ts';

const TZ = 'Europe/Moscow';
const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 1, 9, 0);
const LATER = '999999999999999-0000-00000000000000ff';

function doc(node = 'aa', now: () => number = () => START) {
  return new Doc({ spaceId: '01929c3e-0000-7000-8000-00000000eeee', clock: new HybridClock(node.padStart(16, '0'), now), now, timeZone: TZ });
}

describe('настройки игровых элементов', () => {
  it('без записи — значения по умолчанию, чтение ничего не пишет', () => {
    const d = doc();
    expect(d.getGameSettings()).toEqual(DEFAULT_GAME_SETTINGS);
    expect(DEFAULT_GAME_SETTINGS).toMatchObject({
      enabled: true,
      sound: false,
      celebrations: true,
      phrases: true,
      weeklyReview: true,
      weeklyReviewDay: 7,
      weeklyReviewTime: '19:00',
      weeklyReviewNotify: false,
      milestones: true,
      garden: true,
      dailyGoal: null,
      weeklyGoal: null,
      restDays: [],
      vacationFrom: null,
      vacationTo: null,
    });
    expect(d.pending()).toEqual([]);
  });

  it('правка пишет только изменённые поля и не попадает в отмену', () => {
    const ws = new Workspace(doc());
    ws.updateGameSettings({ sound: true, dailyGoal: 5, restDays: [7, 6, 6] });
    expect(ws.getGameSettings()).toMatchObject({ sound: true, dailyGoal: 5, restDays: [6, 7], enabled: true });
    expect(ws.personal.pending().map((o) => o.field).sort()).toEqual(['daily_goal', 'rest_days', 'sound']);
    expect(ws.canUndo).toBe(false);
    const n = ws.personal.pending().length;
    ws.updateGameSettings({ sound: true });
    expect(ws.personal.pending().length).toBe(n);
    ws.updateGameSettings({ dailyGoal: null });
    expect(ws.getGameSettings().dailyGoal).toBeNull();
  });

  it('неверные значения не записываются', () => {
    const d = doc();
    const bad: Array<Record<string, unknown>> = [
      { dailyGoal: 0 },
      { dailyGoal: 51 },
      { dailyGoal: 2.5 },
      { weeklyGoal: 301 },
      { weeklyGoal: 0 },
      { weeklyReviewTime: '24:00' },
      { weeklyReviewTime: '7:00' },
      { weeklyReviewDay: 0 },
      { weeklyReviewDay: 8 },
      { restDays: [0] },
      { restDays: [8] },
      { restDays: 'sat' },
      { enabled: 'yes' },
      { vacationFrom: '2026-02-30' },
      { vacationFrom: '2026-10-10', vacationTo: '2026-10-01' },
      { nonsense: true },
    ];
    for (const patch of bad) expect(() => d.updateGameSettings(patch as never), JSON.stringify(patch)).toThrow(RangeError);
    expect(d.pending()).toEqual([]);
    d.updateGameSettings({ dailyGoal: 50, weeklyGoal: 300, weeklyReviewTime: '07:30', weeklyReviewDay: 1, vacationTo: '2026-10-10' });
    expect(d.getGameSettings()).toMatchObject({ dailyGoal: 50, weeklyGoal: 300, weeklyReviewTime: '07:30', weeklyReviewDay: 1, vacationTo: '2026-10-10' });
    // Начало позже уже записанного конца — ошибка.
    expect(() => d.updateGameSettings({ vacationFrom: '2026-10-11' })).toThrow(RangeError);
  });

  it('испорченные значения с другого устройства читаются как умолчания', () => {
    const d = doc();
    let n = 0;
    const put = (field: string, value: unknown) =>
      d.applyRemote([{ table: 'game', record: 'settings', field, value: value as never, hlc: LATER.replace('-0000-', `-${String(++n).padStart(4, '0')}-`) }]);
    put('daily_goal', 99);
    put('weekly_review_time', 'вечером');
    put('rest_days', [1, 9]);
    put('sound', 1);
    put('vacation_from', '2026-10-20');
    put('vacation_to', '2026-10-05');
    expect(d.getGameSettings()).toEqual(DEFAULT_GAME_SETTINGS);
    put('rest_days', [7, 1, 1]);
    expect(d.getGameSettings().restDays).toEqual([1, 7]);
  });

  it('правки разных полей с двух устройств сливаются, одно поле — побеждает поздняя', () => {
    let t = START;
    const a = doc('aa', () => t);
    const b = doc('bb', () => t);
    // Оба офлайн: каждый правит своё.
    a.updateGameSettings({ sound: true, dailyGoal: 4 });
    t += 1000;
    b.updateGameSettings({ celebrations: false, dailyGoal: 6 });
    b.applyRemote(a.pending());
    a.applyRemote(b.pending());
    for (const d of [a, b]) expect(d.getGameSettings()).toMatchObject({ sound: true, celebrations: false, dailyGoal: 6, phrases: true });
  });

  it('на сервер уходит только шифротекст', async () => {
    await initCrypto();
    const keys = spaceKeys(newKey());
    const d = doc();
    const ops: Op[] = [];
    d.subscribe((o) => ops.push(...o));
    d.updateGameSettings({ vacationFrom: '2026-12-24', vacationTo: '2026-12-31' });
    const env = JSON.stringify(ops.map((op) => sealOp('space-1', keys, op)));
    expect(env).not.toMatch(/vacation|2026-12-24|game/);
  });

  it('выходные, отпуск и общий выключатель', () => {
    const s = { ...DEFAULT_GAME_SETTINGS, restDays: [6, 7], vacationTo: '2026-10-10' };
    expect(isRestDay(s, '2026-10-03')).toBe(true); // суббота
    expect(isRestDay(s, '2026-10-05')).toBe(false);
    expect(onVacation(s, '2026-01-01')).toBe(true);
    expect(onVacation(s, '2026-10-11')).toBe(false);
    expect(onVacation({ ...s, vacationFrom: '2026-10-05' }, '2026-10-04')).toBe(false);
    expect(onVacation({ ...s, vacationTo: null, vacationFrom: '2026-10-05' }, '2026-10-06')).toBe(false);
    expect(gameFeature(s, 'celebrations')).toBe(true);
    expect(gameFeature({ ...s, enabled: false }, 'celebrations')).toBe(false);
    expect(gameFeature(s, 'sound')).toBe(false);
  });
});

describe('тёплые фразы', () => {
  it(`не чаще раза за ${PHRASE_GAP} выполнений и только при факте`, () => {
    const fact: WarmFact = { kind: 'noOverdue' };
    let since = 0;
    const shown: number[] = [];
    for (let i = 1; i <= 12; i++) {
      const r = pickPhrase([fact], since + 1);
      since = r.sinceLast;
      if (r.fact) shown.push(i);
    }
    expect(shown).toEqual([5, 10]);
    // Без факта фразы нет, счётчик копится.
    expect(pickPhrase([], 9)).toEqual({ fact: null, sinceLast: 9 });
    // Несколько фактов — первый по приоритету.
    expect(pickPhrase([{ kind: 'habit', count: 10 }, fact], PHRASE_GAP).fact).toEqual({ kind: 'habit', count: 10 });
  });

  /** Выполнить задачу и собрать факты так же, как веб. */
  function complete(ws: Workspace, id: string, now: number): WarmFact[] {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(now));
    const before = beforeCompletion(ws, id, today, TZ)!;
    ws.completeTask(id);
    return completionFacts(before, afterCompletion(ws, before, today, TZ), today, TZ);
  }

  it('самая старая задача во «Входящих»: сколько висела', () => {
    let t = START;
    const ws = new Workspace(doc('aa', () => t));
    const old = ws.createTask({ title: 'Старая' });
    t += 2 * DAY;
    const newer = ws.createTask({ title: 'Новее' });
    t += 21 * DAY;
    // Не самая старая и ждала меньше месяца: фактов нет.
    expect(complete(ws, newer, t)).toEqual([]);
    expect(complete(ws, old, t)).toEqual([{ kind: 'oldestInbox', days: 23 }]);
  });

  it('пятая задача за день, просрочек больше нет, обычное выполнение без фактов', () => {
    let t = START;
    const ws = new Workspace(doc('aa', () => t));
    const late = ws.createTask({ title: 'Просроченная', due: { date: '2026-09-30' } });
    const ids = [1, 2, 3, 4].map((i) => ws.createTask({ title: `Задача ${i}` }));
    expect(complete(ws, ids[0]!, t)).toEqual([]);
    expect(complete(ws, ids[1]!, t)).toEqual([]);
    expect(complete(ws, ids[2]!, t)).toEqual([]);
    expect(complete(ws, late, t)).toEqual([{ kind: 'noOverdue' }]);
    expect(complete(ws, ids[3]!, t)).toEqual([{ kind: 'nthToday', n: 5 }]);
  });

  it('третий день подряд с выполненными задачами — при первом выполнении за день', () => {
    let t = START;
    const ws = new Workspace(doc('aa', () => t));
    const day = () => ws.createTask({ title: 'Дело' });
    complete(ws, day(), t);
    t += DAY;
    complete(ws, day(), t);
    t += DAY;
    const a = day();
    const b = day();
    expect(complete(ws, a, t)).toEqual([{ kind: 'dayStreak', days: 3 }]);
    expect(complete(ws, b, t)).toEqual([]);
  });

  it('привычка: отмечается серия 3 раза подряд', () => {
    let t = START;
    const ws = new Workspace(doc('aa', () => t));
    const id = ws.createTask({
      title: 'Зарядка',
      due: { date: '2026-10-01' },
      recurrence: { rule: 'FREQ=DAILY', mode: 'schedule', text: 'каждый день' },
      habit: { skipsPerWeek: 0 },
    });
    const kinds = [0, 1, 2].map((i) => {
      t = START + i * DAY;
      return complete(ws, id, t).map((f) => f.kind);
    });
    expect(kinds[0]).not.toContain('habit');
    t = START + 3 * DAY;
    const fourth = complete(ws, id, t);
    expect(kinds[2]).toContain('habit');
    // 4 подряд — не круглое число, не отмечается.
    expect(fourth.find((f) => f.kind === 'habit')).toBeUndefined();
  });
});

/**
 * Цели дня и недели и честная серия (docs/gamification.md, 6.2). Чистый подсчёт по выполнениям,
 * тем же, что у статистики (stats.ts), в том же часовом поясе; считается на устройстве.
 *
 * Правила серии целей:
 * - день засчитывается, если выполнено не меньше цели дня (текущей: истории целей нет);
 * - выходные (restDays) не считаются: серию не растят и не обрывают;
 * - дни отпуска замораживают серию так же;
 * - один невыполненный день за неделю (с понедельника) серию не обрывает и не растит, как запас у привычек;
 * - сегодняшний невыполненный день серию не обрывает до конца дня;
 * - серия начинается с первого дня с выполнениями; нет цели дня — нет и серии.
 */
import { weekStart } from './calendar.ts';
import { addDays, today as todayIn } from './dates.ts';
import { DAILY_GOAL_MAX, isRestDay, onVacation, type GameSettings } from './game.ts';
import type { DoneEvent } from './stats.ts';

/** Сколько невыполненных дней в неделю не обрывают серию. */
export const GOAL_SKIPS_PER_WEEK = 1;
/** Подсказка цели считается по стольким последним дням (без сегодняшнего). */
export const GOAL_HINT_DAYS = 14;

/**
 * done — цель выполнена; rest — выходной; vacation — отпуск; allowed — пропуск по запасу недели;
 * missed — не выполнена; today — ещё можно успеть; planned — впереди.
 */
export type GoalDayState = 'done' | 'rest' | 'vacation' | 'allowed' | 'missed' | 'today' | 'planned';

export interface GoalProgress {
  /** Сегодня: выполнено, цель (null — без цели) и выходной или отпуск (тогда цели нет). */
  readonly day: { readonly done: number; readonly goal: number | null; readonly off: 'rest' | 'vacation' | null };
  /** Неделя с понедельника: выполнено и цель недели. */
  readonly week: { readonly start: string; readonly done: number; readonly goal: number | null };
  /** Серия дней с выполненной целью; null — цели дня нет. */
  readonly streak: { readonly current: number; readonly best: number } | null;
  /** Дни текущей недели с понедельника: число выполненных и состояние. */
  readonly days: ReadonlyArray<{ readonly date: string; readonly count: number; readonly state: GoalDayState }>;
}

function perDay(events: readonly DoneEvent[], tz: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) {
    const d = todayIn(tz, e.at);
    out.set(d, (out.get(d) ?? 0) + 1);
  }
  return out;
}

const offDay = (s: GameSettings, date: string): 'rest' | 'vacation' | null => (onVacation(s, date) ? 'vacation' : isRestDay(s, date) ? 'rest' : null);

/**
 * onRun (необязательный) получает каждый день, засчитанный в серию, с длиной серии на этот день:
 * так вехи узнают, когда серия впервые дошла до порога.
 */
export function computeGoals(events: readonly DoneEvent[], s: GameSettings, tz: string, today: string, onRun?: (run: number, date: string) => void): GoalProgress {
  const counts = perDay(events, tz);
  const count = (d: string) => counts.get(d) ?? 0;
  const goal = s.dailyGoal;
  const monday = weekStart(today);
  const states = new Map<string, GoalDayState>();

  let streak: GoalProgress['streak'] = null;
  if (goal !== null) {
    const past = [...counts.keys()].filter((d) => d <= today);
    const anchor = past.length ? past.reduce((a, b) => (a < b ? a : b)) : today;
    let run = 0;
    let best = 0;
    let week = '';
    let allowed = 0;
    for (let d = anchor; d <= today; d = addDays(d, 1)) {
      const w = weekStart(d);
      if (w !== week) {
        week = w;
        allowed = 0;
      }
      const off = offDay(s, d);
      let state: GoalDayState;
      if (off) state = off;
      else if (count(d) >= goal) {
        state = 'done';
        run++;
        onRun?.(run, d);
      } else if (d === today) state = 'today';
      else if (allowed < GOAL_SKIPS_PER_WEEK) {
        allowed++;
        state = 'allowed';
      } else {
        state = 'missed';
        run = 0;
      }
      best = Math.max(best, run);
      if (d >= monday) states.set(d, state);
    }
    streak = { current: run, best };
  }

  let weekDone = 0;
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(monday, i);
    if (date <= today) weekDone += count(date);
    const state: GoalDayState = states.get(date) ?? offDay(s, date) ?? (date < today ? 'missed' : date === today ? 'today' : 'planned');
    return { date, count: date <= today ? count(date) : 0, state };
  });

  const off = offDay(s, today);
  return {
    day: { done: count(today), goal: off ? null : goal, off },
    week: { start: monday, done: weekDone, goal: s.weeklyGoal },
    streak,
    days,
  };
}

/**
 * Подсказка цели дня: среднее выполненных за последние две недели без сегодняшнего дня,
 * выходных и отпуска, округлённое. Дни до первого выполнения не считаются, чтобы новичку
 * не занижать темп. null — подсказывать нечего (данных нет или в среднем меньше одной).
 */
export function suggestDailyGoal(events: readonly DoneEvent[], s: GameSettings, tz: string, today: string): number | null {
  const counts = perDay(events, tz);
  const first = [...counts.keys()].filter((d) => d < today).sort()[0];
  if (!first) return null;
  let days = 0;
  let sum = 0;
  for (let i = 1; i <= GOAL_HINT_DAYS; i++) {
    const d = addDays(today, -i);
    if (d < first) break;
    if (offDay(s, d)) continue;
    days++;
    sum += counts.get(d) ?? 0;
  }
  if (!days) return null;
  const n = Math.round(sum / days);
  return n >= 1 ? Math.min(n, DAILY_GOAL_MAX) : null;
}

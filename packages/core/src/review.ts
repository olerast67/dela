/**
 * Итоги недели (docs/gamification.md, 6.3). Чистый подсчёт по уже синхронизированным данным,
 * в том же часовом поясе и с теми же выполнениями, что статистика (stats.ts). Неделя ISO: с понедельника.
 *
 * - выполнено: выполнения задач и экземпляров повторов за неделю, по проектам;
 * - «Больше всего ждали»: закрытые за неделю обычные задачи (не повторы), дольше всего жившие от создания;
 * - «Часто переносятся»: открытые задачи с тремя и более переносами срока (записи postpone) после отметки «Оставить»;
 * - «Не успели»: открытые к концу недели задачи со сроком на этой неделе (у текущей недели — до вчера), кроме часто переносимых;
 * - помодоро: минуты и число отрезков работы за неделю;
 * - привычки и цели: серии на конец недели (у текущей — на сегодня).
 */
import { weekStart } from './calendar.ts';
import { addDays, daysBetween, today as todayIn, zonedToUtc } from './dates.ts';
import type { TaskView } from './doc.ts';
import type { GameSettings } from './game.ts';
import { computeGoals } from './goals.ts';
import type { HabitStreak } from './habits.ts';
import type { Postpone } from './model.ts';
import type { DoneEvent, WorkEvent } from './stats.ts';

/** Сколько переносов делают задачу «часто переносимой». */
export const POSTPONE_THRESHOLD = 3;
/** Сколько задач показывать в «Больше всего ждали». */
export const REVIEW_WAITED = 3;
/** Сколько задач показывать в «Часто переносятся» и «Не успели». */
export const REVIEW_LIST = 5;

export interface ReviewTask {
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
}

export interface WeekReview {
  /** Понедельник и воскресенье недели. */
  readonly start: string;
  readonly end: string;
  /** Неделя ещё идёт: итоги на сегодня. */
  readonly current: boolean;
  readonly done: number;
  /** Дней с выполненными задачами. */
  readonly activeDays: number;
  /** Выполнено на прошлой неделе: для сравнения фактом, без оценок. */
  readonly previous: number;
  /** По проектам, больше выполнено — выше. */
  readonly projects: ReadonlyArray<{ readonly projectId: string; readonly count: number }>;
  /** Дольше всего ждали: дней от создания до выполнения, больше — выше. */
  readonly waited: ReadonlyArray<ReviewTask & { readonly days: number }>;
  /** Часто переносятся: число переносов, больше — выше. */
  readonly postponed: ReadonlyArray<ReviewTask & { readonly count: number }>;
  /** Не успели из запланированного на неделю: всего и первые по сроку. */
  readonly missed: { readonly count: number; readonly tasks: ReadonlyArray<ReviewTask & { readonly due: string }> };
  readonly work: { readonly minutes: number; readonly sessions: number };
  readonly habits: ReadonlyArray<ReviewTask & { readonly current: number; readonly best: number; readonly week: number }>;
  /** null — целей нет. */
  readonly goals: {
    readonly daily: number | null;
    /** Дней недели с выполненной целью дня. */
    readonly daysMet: number;
    readonly streak: number | null;
    readonly weekly: number | null;
  } | null;
}

export interface ReviewInput {
  readonly events: readonly DoneEvent[];
  /** Все задачи, которые видны (не в корзине), с выполненными. */
  readonly tasks: readonly TaskView[];
  readonly postpones: readonly Postpone[];
  /** Отметка «Оставить» по задаче: переносы до неё не считаются. */
  readonly keptAt: (taskId: string) => number;
  readonly work: readonly WorkEvent[];
  /** Привычки с сериями на конец недели и числом выполнений за неделю. */
  readonly habits: ReadonlyArray<{ readonly task: TaskView; readonly streak: HabitStreak; readonly week: number }>;
  readonly settings: GameSettings;
}

const brief = (t: TaskView): ReviewTask => ({ id: t.id, title: t.title, projectId: t.projectId });

/** Понедельник недели, итоги которой показываются в день reviewDay (1..7): пятница–воскресенье — эта неделя, иначе прошлая. */
export function reviewWeekOf(date: string, reviewDay: number): string {
  const monday = weekStart(date);
  return reviewDay >= 5 ? monday : addDays(monday, -7);
}

/** Момент итогов недели (день и время из настроек) в неделе, где лежит date. */
export function reviewMoment(s: GameSettings, date: string, tz: string): { at: number; date: string; week: string } {
  const day = addDays(weekStart(date), s.weeklyReviewDay - 1);
  return { at: zonedToUtc(day, s.weeklyReviewTime, tz), date: day, week: reviewWeekOf(day, s.weeklyReviewDay) };
}

/** Последний наступивший момент итогов (не позже now): его неделя и время. */
export function lastReview(s: GameSettings, now: number, tz: string): { at: number; date: string; week: string } {
  const m = reviewMoment(s, todayIn(tz, now), tz);
  return m.at <= now ? m : reviewMoment(s, addDays(m.date, -7), tz);
}

/** Моменты итогов в [from, to), для уведомлений. */
export function reviewsBetween(s: GameSettings, from: number, to: number, tz: string): Array<{ at: number; date: string; week: string }> {
  const out: Array<{ at: number; date: string; week: string }> = [];
  for (let d = addDays(todayIn(tz, from), -7); ; d = addDays(d, 7)) {
    const m = reviewMoment(s, d, tz);
    if (m.at >= to) break;
    if (m.at >= from) out.push(m);
  }
  return out;
}

export function computeWeekReview(input: ReviewInput, tz: string, monday: string, today: string): WeekReview {
  const start = weekStart(monday);
  const end = addDays(start, 6);
  const current = today <= end;
  // Конец недели: начало следующего понедельника; у текущей недели переносы и серии считаются на сейчас.
  const endAt = zonedToUtc(addDays(end, 1), '00:00', tz);
  const inWeek = (d: string) => d >= start && d <= end;

  let done = 0;
  let previous = 0;
  const days = new Set<string>();
  const byProject = new Map<string, number>();
  const prevStart = addDays(start, -7);
  for (const e of input.events) {
    const d = todayIn(tz, e.at);
    if (inWeek(d)) {
      done++;
      days.add(d);
      byProject.set(e.projectId, (byProject.get(e.projectId) ?? 0) + 1);
    } else if (d >= prevStart && d < start) previous++;
  }
  const projects = [...byProject].map(([projectId, count]) => ({ projectId, count })).sort((a, b) => b.count - a.count || a.projectId.localeCompare(b.projectId));

  const waited = input.tasks
    .filter((t) => t.completedAt !== null && !t.recurrence && inWeek(todayIn(tz, t.completedAt)))
    .map((t) => ({ ...brief(t), days: daysBetween(todayIn(tz, t.createdAt), todayIn(tz, t.completedAt!)) }))
    .filter((t) => t.days >= 1)
    .sort((a, b) => b.days - a.days || a.title.localeCompare(b.title))
    .slice(0, REVIEW_WAITED);

  const counts = new Map<string, number>();
  for (const p of input.postpones) {
    if (p.at >= endAt || p.at <= input.keptAt(p.taskId)) continue;
    counts.set(p.taskId, (counts.get(p.taskId) ?? 0) + 1);
  }
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const postponed = [...counts]
    .filter(([id, n]) => n >= POSTPONE_THRESHOLD && byId.get(id)?.completedAt === null)
    .map(([id, count]) => ({ ...brief(byId.get(id)!), count }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
    .slice(0, REVIEW_LIST);

  // У текущей недели сегодняшние задачи ещё можно успеть.
  const lastDue = current ? addDays(today, -1) : end;
  // Часто переносимые уже показаны отдельно, с действиями.
  const listed = new Set(postponed.map((t) => t.id));
  const missedAll = input.tasks
    .filter((t) => !listed.has(t.id) && !t.recurrence && t.due && t.due.date >= start && t.due.date <= lastDue && (t.completedAt === null || t.completedAt >= endAt))
    .map((t) => ({ ...brief(t), due: t.due!.date }))
    .sort((a, b) => a.due.localeCompare(b.due) || a.title.localeCompare(b.title));

  let minutes = 0;
  let sessions = 0;
  for (const w of input.work) {
    if (!inWeek(todayIn(tz, w.at))) continue;
    minutes += w.minutes;
    sessions++;
  }

  const habits = input.habits
    .map(({ task, streak, week }) => ({ ...brief(task), current: streak.current, best: streak.best, week }))
    .sort((a, b) => b.current - a.current || a.title.localeCompare(b.title));

  const s = input.settings;
  let goals: WeekReview['goals'] = null;
  if (s.dailyGoal !== null || s.weeklyGoal !== null) {
    const g = computeGoals(input.events, s, tz, current ? today : end);
    goals = {
      daily: s.dailyGoal,
      daysMet: g.days.filter((d) => d.state === 'done').length,
      streak: g.streak?.current ?? null,
      weekly: s.weeklyGoal,
    };
  }

  return {
    start,
    end,
    current,
    done,
    activeDays: days.size,
    previous,
    projects,
    waited,
    postponed,
    missed: { count: missedAll.length, tasks: missedAll.slice(0, REVIEW_LIST) },
    work: { minutes, sessions },
    habits,
    goals,
  };
}

/** Последние n недель с понедельниками, свежая первой; текущая — если её итоги уже наступили. */
export function reviewWeeks(s: GameSettings, now: number, tz: string, n = 12): string[] {
  const last = lastReview(s, now, tz).week;
  return Array.from({ length: n }, (_, i) => addDays(last, -7 * i));
}


/** Статистика выполненного: чистый подсчёт по событиям, считается на устройстве. */
import { addDays, daysBetween, today as todayIn } from './dates.ts';
import { weekStart } from './calendar.ts';

/** Одно выполнение: выполненная задача или экземпляр повторяющейся. */
export interface DoneEvent {
  readonly at: number;
  readonly projectId: string;
}

export interface Stats {
  /** Последние `days` дней, старые первыми, последний — сегодня. */
  days: Array<{ date: string; count: number }>;
  /** Последние `weeks` недель (понедельник первый), последняя — текущая. */
  weeks: Array<{ start: string; count: number }>;
  today: number;
  thisWeek: number;
  /** Дней подряд с выполнением; сегодняшний день без выполнений серию ещё не обрывает. */
  streak: number;
  bestStreak: number;
  total: number;
  /** Разбивка по проектам за последние `period` дней, больше выполнено — выше. */
  projects: Array<{ projectId: string; count: number }>;
}

export interface StatsOptions {
  days?: number;
  weeks?: number;
  period?: number;
}

export function computeStats(events: readonly DoneEvent[], tz: string, today: string, opts: StatsOptions = {}): Stats {
  const nDays = opts.days ?? 28;
  const nWeeks = opts.weeks ?? 12;
  const period = opts.period ?? 30;
  const perDay = new Map<string, number>();
  for (const e of events) {
    const d = todayIn(tz, e.at);
    perDay.set(d, (perDay.get(d) ?? 0) + 1);
  }
  const count = (d: string) => perDay.get(d) ?? 0;

  const days = Array.from({ length: nDays }, (_, i) => {
    const date = addDays(today, i - nDays + 1);
    return { date, count: count(date) };
  });
  const thisMonday = weekStart(today);
  const weeks = Array.from({ length: nWeeks }, (_, i) => ({ start: addDays(thisMonday, (i - nWeeks + 1) * 7), count: 0 }));
  const firstWeek = weeks[0]?.start ?? thisMonday;
  for (const [d, n] of perDay) {
    if (d > today || d < firstWeek) continue;
    weeks[Math.floor(daysBetween(firstWeek, d) / 7)]!.count += n;
  }

  // Серии: сортируем дни с выполнениями и считаем подряд идущие.
  const dates = [...perDay.keys()].filter((d) => d <= today).sort();
  let best = 0;
  let run = 0;
  let prev = '';
  for (const d of dates) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  // Текущая серия заканчивается сегодня или, если сегодня пусто, вчера.
  let streak = 0;
  for (let d = count(today) > 0 ? today : addDays(today, -1); count(d) > 0; d = addDays(d, -1)) streak++;

  const from = addDays(today, 1 - period);
  const byProject = new Map<string, number>();
  for (const e of events) {
    const d = todayIn(tz, e.at);
    if (d >= from && d <= today) byProject.set(e.projectId, (byProject.get(e.projectId) ?? 0) + 1);
  }
  const projects = [...byProject].map(([projectId, n]) => ({ projectId, count: n })).sort((a, b) => b.count - a.count);

  return { days, weeks, today: count(today), thisWeek: weeks[weeks.length - 1]?.count ?? 0, streak, bestStreak: best, total: events.length, projects };
}

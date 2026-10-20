/**
 * Привычки: серия выполнений подряд по расписанию повтора. Чистый подсчёт по записям
 * выполнений и пропусков, считается на устройстве.
 *
 * Правила:
 * - экземпляры берутся по расписанию повтора (mode 'schedule'); у повтора «после выполнения»
 *   расписания нет, поэтому серия считается по дням: каждый день — экземпляр;
 * - экземпляр выполнен, если есть выполнение с его датой или он выпал на день, когда отметили выполнение
 *   (поздняя отметка вчерашнего засчитывает и сегодняшний: срок всё равно перешёл на завтра);
 * - явный пропуск серию не обрывает и не растит, число явных пропусков не ограничено;
 * - пропущенный без отметки экземпляр обрывает серию, кроме первых skipsPerWeek за неделю (с понедельника);
 * - сегодняшний невыполненный экземпляр серию не обрывает до конца дня.
 */
import { weekStart } from './calendar.ts';
import { addDays } from './dates.ts';
import type { Habit, Recurrence } from './model.ts';
import { occurrencesBetween, parseRule } from './recurrence.ts';

/** done — выполнен; skipped — явный пропуск; allowed — пропуск по правилу недели; missed — не выполнен; today — ещё можно успеть; planned — впереди. */
export type HabitDayState = 'done' | 'skipped' | 'allowed' | 'missed' | 'today' | 'planned';

export interface HabitStreak {
  readonly current: number;
  readonly best: number;
  /** Сколько экземпляров выполнено за всю историю. */
  readonly done: number;
  /** Дни полоски: недели целиком, с понедельника; null — в этот день экземпляра нет. */
  readonly days: ReadonlyArray<{ readonly date: string; readonly state: HabitDayState | null }>;
}

export interface HabitInput {
  readonly recurrence: Recurrence;
  readonly habit: Habit;
  /** Даты выполненных экземпляров. */
  readonly occurrences: readonly string[];
  /** Дни (в поясе пользователя), когда отмечали выполнение. */
  readonly doneDays: readonly string[];
  /** Даты явно пропущенных экземпляров. */
  readonly skips: readonly string[];
  /** Текущий срок задачи: с него серия начинается, если записей ещё нет. */
  readonly due: string | null;
  readonly today: string;
  /** Сколько недель показать в полоске, текущая последняя. */
  readonly weeks?: number;
}

const DAILY = parseRule('FREQ=DAILY')!;

export function habitStreak(input: HabitInput): HabitStreak {
  const { today } = input;
  const weeks = input.weeks ?? 5;
  const stripFrom = addDays(weekStart(today), -7 * (weeks - 1));
  const stripTo = addDays(weekStart(today), 7);
  const byDay = input.recurrence.mode === 'completion';
  const rule = byDay ? DAILY : (parseRule(input.recurrence.rule) ?? DAILY);
  const occ = new Set(input.occurrences);
  const doneDays = new Set(input.doneDays);
  const skips = new Set(input.skips);

  // Начало серии: самая ранняя запись или текущий срок.
  const starts = [...(byDay ? input.doneDays : input.occurrences), ...input.skips, ...(input.due && !byDay ? [input.due] : [])];
  const anchor = starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : null;

  const states = new Map<string, HabitDayState>();
  let run = 0;
  let best = 0;
  let total = 0;
  if (anchor !== null && anchor <= today) {
    const scheduled = new Set(occurrencesBetween(rule, anchor, anchor, addDays(today, 1), 100_000));
    // Выполнения и пропуски вне расписания (срок переносили вручную) тоже идут в ленту,
    // как и отмеченные заранее будущие экземпляры.
    const timeline = new Set(scheduled);
    for (const d of byDay ? doneDays : occ) if (d >= anchor) timeline.add(d);
    for (const d of skips) if (d >= anchor) timeline.add(d);
    let week = '';
    let allowed = 0;
    for (const d of [...timeline].sort()) {
      const w = weekStart(d);
      if (w !== week) {
        week = w;
        allowed = 0;
      }
      let state: HabitDayState;
      if (occ.has(d) || (doneDays.has(d) && (byDay || scheduled.has(d)))) {
        state = 'done';
        run++;
        total++;
      } else if (skips.has(d)) state = 'skipped';
      else if (d >= today) state = 'today';
      else if (allowed < input.habit.skipsPerWeek) {
        allowed++;
        state = 'allowed';
      } else {
        state = 'missed';
        run = 0;
      }
      best = Math.max(best, run);
      if (d >= stripFrom && state !== 'today') states.set(d, state);
    }
  }
  // Впереди в полоске: экземпляры до конца текущей недели.
  const futureAnchor = anchor !== null && anchor <= today ? anchor : (input.due ?? today);
  for (const d of occurrencesBetween(rule, futureAnchor, today, stripTo, 7)) if (!states.has(d)) states.set(d, d === today ? 'today' : 'planned');

  const days: Array<{ date: string; state: HabitDayState | null }> = [];
  for (let d = stripFrom; d < stripTo; d = addDays(d, 1)) days.push({ date: d, state: states.get(d) ?? null });
  return { current: run, best, done: total, days };
}

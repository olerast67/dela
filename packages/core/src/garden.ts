/**
 * Сад (docs/gamification.md, 6.5): визуальная история прогресса. Чистый подсчёт из уже имеющихся данных:
 * выполнений (stats.ts), отрезков помодоро и настроек целей. Ничего не хранится и на сервер не уходит.
 *
 * Правила:
 * - каждый день с выполненными задачами — растение; стадия по числу выполненных:
 *   1–2 — росток, 3–5 — куст, от 6 — дерево; внутри стадии растение чуть подрастает с каждой задачей;
 * - выполнена цель дня (не в выходной и не в отпуск) — растение цветёт;
 * - выполненные привычки дня — ягоды на растении;
 * - каждый законченный отрезок помодоро — маленькое дерево фокуса рядом, прерванный — росток фокуса;
 * - день без задач — пустая земля: ничего не вянет и не умирает; выходной и отпуск отмечены нейтрально;
 * - порода растения выбирается по хешу даты: сад разнообразный и одинаковый на всех устройствах.
 */
import { weekStart } from './calendar.ts';
import { addDays, today as todayIn } from './dates.ts';
import { isRestDay, onVacation, type GameSettings } from './game.ts';
import type { DoneEvent, WorkEvent } from './stats.ts';

export const GARDEN_SPECIES = ['round', 'pine', 'poplar', 'acacia'] as const;
export type GardenSpecies = (typeof GARDEN_SPECIES)[number];

/** 0 — пусто, 1 — росток, 2 — куст, 3 — дерево. */
export type GardenStage = 0 | 1 | 2 | 3;

/** С какого числа выполненных начинается стадия: росток, куст, дерево. */
export const GARDEN_STAGES = [1, 3, 6] as const;
/** С этого числа выполненных дерево больше не растёт. */
export const GARDEN_FULL = 12;
/** Сколько недель показывает сад сразу. */
export const GARDEN_WEEKS = 12;

export interface GardenDay {
  readonly date: string;
  /** Выполнено задач (и экземпляров повторов) за день. */
  readonly done: number;
  readonly stage: GardenStage;
  /** Рост внутри стадии: 0..1. */
  readonly growth: number;
  readonly species: GardenSpecies;
  /** Число из хеша даты для мелких различий (наклон, порядок цветов). */
  readonly seed: number;
  /** Цель дня (текущая: истории целей нет); null — цели нет, выходной или отпуск. */
  readonly goal: number | null;
  /** Цель выполнена: растение цветёт. */
  readonly bloom: boolean;
  /** Выполнено привычек: ягоды. */
  readonly habits: number;
  /** Законченные отрезки помодоро: деревья фокуса. */
  readonly focus: number;
  /** Прерванные отрезки помодоро: ростки фокуса. */
  readonly focusCut: number;
  /** Минуты помодоро за день. */
  readonly focusMinutes: number;
  readonly off: 'rest' | 'vacation' | null;
  /** Сегодня; будущие дни — пустые места. */
  readonly today: boolean;
  readonly future: boolean;
}

export interface GardenWeek {
  /** Понедельник. */
  readonly start: string;
  readonly days: readonly GardenDay[];
}

export interface Garden {
  /** Недели, свежая первой; в каждой семь дней с понедельника. */
  readonly weeks: readonly GardenWeek[];
  /** Есть ли выполнения или помодоро раньше показанных недель. */
  readonly older: boolean;
  /** Итого за показанные недели. */
  readonly plants: number;
  readonly trees: number;
}

export interface GardenInput {
  readonly events: readonly DoneEvent[];
  readonly work: readonly WorkEvent[];
  readonly settings: GameSettings;
  readonly tz: string;
  readonly today: string;
  readonly weeks?: number;
}

/** FNV-1a: одинаковый на всех устройствах, без криптографии. */
export function gardenHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Перемешивание в конце: соседние даты отличаются одной цифрой, а породы должны чередоваться без узора.
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

export function gardenSpecies(date: string): GardenSpecies {
  return GARDEN_SPECIES[gardenHash(date) % GARDEN_SPECIES.length]!;
}

/** Стадия и рост внутри неё по числу выполненных. */
export function gardenStage(done: number): { stage: GardenStage; growth: number } {
  const [sprout, bush, tree] = GARDEN_STAGES;
  if (done < sprout) return { stage: 0, growth: 0 };
  if (done < bush) return { stage: 1, growth: (done - sprout) / (bush - sprout) };
  if (done < tree) return { stage: 2, growth: (done - bush) / (tree - bush) };
  return { stage: 3, growth: Math.min(1, (done - tree) / (GARDEN_FULL - tree)) };
}

interface DayData {
  done: number;
  habits: number;
  focus: number;
  focusCut: number;
  minutes: number;
}

/** Один день сада из готовых чисел: им же рисуется растение в таймере и в «Сегодня». */
export function gardenDay(date: string, data: Partial<DayData>, s: GameSettings, today: string): GardenDay {
  const done = data.done ?? 0;
  const off = onVacation(s, date) ? 'vacation' : isRestDay(s, date) ? 'rest' : null;
  const goal = off ? null : s.dailyGoal;
  const { stage, growth } = gardenStage(done);
  const seed = gardenHash(date);
  return {
    date,
    done,
    stage,
    growth,
    species: GARDEN_SPECIES[seed % GARDEN_SPECIES.length]!,
    seed,
    goal,
    bloom: goal !== null && done >= goal,
    habits: data.habits ?? 0,
    focus: data.focus ?? 0,
    focusCut: data.focusCut ?? 0,
    focusMinutes: data.minutes ?? 0,
    off,
    today: date === today,
    future: date > today,
  };
}

export function computeGarden(input: GardenInput): Garden {
  const { tz, today, settings } = input;
  const nWeeks = Math.max(1, input.weeks ?? GARDEN_WEEKS);
  const monday = weekStart(today);
  const first = addDays(monday, -7 * (nWeeks - 1));
  const end = addDays(monday, 6);
  const byDay = new Map<string, DayData>();
  const at = (d: string) => {
    let v = byDay.get(d);
    if (!v) byDay.set(d, (v = { done: 0, habits: 0, focus: 0, focusCut: 0, minutes: 0 }));
    return v;
  };
  let older = false;
  for (const e of input.events) {
    const d = todayIn(tz, e.at);
    if (d < first) {
      older = true;
      continue;
    }
    if (d > end) continue;
    const v = at(d);
    v.done++;
    if (e.habit) v.habits++;
  }
  for (const w of input.work) {
    // В саду только отрезки таймера: правка времени вручную деревьев не сажает.
    if (!w.focus) continue;
    const d = todayIn(tz, w.at);
    if (d < first) {
      older = true;
      continue;
    }
    if (d > end) continue;
    const v = at(d);
    if (w.focus === 'full') v.focus++;
    else v.focusCut++;
    v.minutes += w.minutes;
  }

  let plants = 0;
  let trees = 0;
  const weeks: GardenWeek[] = [];
  for (let i = 0; i < nWeeks; i++) {
    const start = addDays(monday, -7 * i);
    const days = Array.from({ length: 7 }, (_, k) => {
      const date = addDays(start, k);
      const day = gardenDay(date, date > today ? {} : (byDay.get(date) ?? {}), settings, today);
      if (day.stage > 0) plants++;
      trees += day.focus;
      return day;
    });
    weeks.push({ start, days });
  }
  return { weeks, older, plants, trees };
}

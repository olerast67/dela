/**
 * Игровые элементы (docs/gamification.md): настройки и тёплые фразы при выполнении.
 *
 * Настройки — одна запись game/settings в личном пространстве. Каждое поле — своя ячейка LWW,
 * поэтому правки разных полей с двух устройств сливаются, а не затирают друг друга. Запись шифруется
 * вместе с остальными операциями пространства. Нет записи или поле испорчено — значение по умолчанию.
 */
import { daysBetween, isDate, isTime, isoWeekday } from './dates.ts';
import type { Json } from './op.ts';
import type { TaskView } from './doc.ts';
import type { GoalProgress } from './goals.ts';
import type { HabitStreak } from './habits.ts';
import type { Stats } from './stats.ts';

export const GAME_TABLE = 'game';
export const GAME_RECORD = 'settings';

export interface GameSettings {
  /** Общий выключатель: выключен — ни одного игрового элемента в приложении. */
  readonly enabled: boolean;
  /** Тихий щелчок при выполнении. */
  readonly sound: boolean;
  /** «День закрыт», когда в «Сегодня» выполнена последняя задача. */
  readonly celebrations: boolean;
  /** Изредка тёплая фраза по фактам вместо «Задача выполнена». */
  readonly phrases: boolean;
  readonly weeklyReview: boolean;
  /** День итогов недели: 1 — понедельник … 7 — воскресенье. */
  readonly weeklyReviewDay: number;
  /** Время итогов недели ЧЧ:ММ. */
  readonly weeklyReviewTime: string;
  readonly weeklyReviewNotify: boolean;
  readonly milestones: boolean;
  readonly garden: boolean;
  /** Цель дня, задач: 1..50; null — без цели. */
  readonly dailyGoal: number | null;
  /** Цель недели, задач: 1..300; null — без цели. */
  readonly weeklyGoal: number | null;
  /** Выходные дни недели (1..7, по возрастанию): в серии целей не считаются. */
  readonly restDays: readonly number[];
  /** Отпуск: с даты (null — с любого дня) по дату включительно; без vacationTo отпуска нет. */
  readonly vacationFrom: string | null;
  readonly vacationTo: string | null;
}

export const DEFAULT_GAME_SETTINGS: GameSettings = Object.freeze({
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
  restDays: Object.freeze([]) as readonly number[],
  vacationFrom: null,
  vacationTo: null,
});

export const DAILY_GOAL_MAX = 50;
export const WEEKLY_GOAL_MAX = 300;

/** Поле настроек → ячейка записи. */
const FIELDS: Record<keyof GameSettings, string> = {
  enabled: 'enabled',
  sound: 'sound',
  celebrations: 'celebrations',
  phrases: 'phrases',
  weeklyReview: 'weekly_review',
  weeklyReviewDay: 'weekly_review_day',
  weeklyReviewTime: 'weekly_review_time',
  weeklyReviewNotify: 'weekly_review_notify',
  milestones: 'milestones',
  garden: 'garden',
  dailyGoal: 'daily_goal',
  weeklyGoal: 'weekly_goal',
  restDays: 'rest_days',
  vacationFrom: 'vacation_from',
  vacationTo: 'vacation_to',
};

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isGoal = (v: unknown, max: number): v is number | null => v === null || isInt(v, 1, max);
const isRestDays = (v: unknown): v is readonly number[] => Array.isArray(v) && v.length <= 7 && v.every((d) => isInt(d, 1, 7));

/** Проверка одного поля: то же правило при записи и при чтении. */
function valid(key: keyof GameSettings, v: unknown): boolean {
  switch (key) {
    case 'weeklyReviewDay':
      return isInt(v, 1, 7);
    case 'weeklyReviewTime':
      return isTime(v);
    case 'dailyGoal':
      return isGoal(v, DAILY_GOAL_MAX);
    case 'weeklyGoal':
      return isGoal(v, WEEKLY_GOAL_MAX);
    case 'restDays':
      return isRestDays(v);
    case 'vacationFrom':
    case 'vacationTo':
      return v === null || isDate(v);
    default:
      return typeof v === 'boolean';
  }
}

const normDays = (v: readonly number[]): number[] => [...new Set(v)].sort((a, b) => a - b);

/** Настройки из записи; испорченное или отсутствующее поле — значение по умолчанию. */
export function readGameSettings(rec: Readonly<Record<string, Json>> | undefined): GameSettings {
  const out: Record<string, unknown> = { ...DEFAULT_GAME_SETTINGS };
  if (!rec) return DEFAULT_GAME_SETTINGS;
  for (const key of Object.keys(FIELDS) as Array<keyof GameSettings>) {
    const v = rec[FIELDS[key]];
    if (v === undefined || !valid(key, v)) continue;
    out[key] = key === 'restDays' ? normDays(v as number[]) : v;
  }
  // Поля отпуска правят по отдельности и с разных устройств: перепутанный порядок дат — отпуска нет.
  if (out.vacationFrom !== null && out.vacationTo !== null && (out.vacationFrom as string) > (out.vacationTo as string)) {
    out.vacationFrom = null;
    out.vacationTo = null;
  }
  return out as unknown as GameSettings;
}

/** Изменения записи для правки настроек. Неверное значение — исключение: в данные оно не попадает. */
export function gameSettingsChanges(current: GameSettings, patch: Partial<GameSettings>): Array<readonly [string, string, string, Json]> {
  const out: Array<readonly [string, string, string, Json]> = [];
  for (const key of Object.keys(patch) as Array<keyof GameSettings>) {
    if (!(key in FIELDS)) throw new RangeError(`unknown game setting: ${key}`);
    const v = patch[key];
    if (v === undefined) continue;
    if (!valid(key, v)) throw new RangeError(`bad value for ${key}`);
    const value = key === 'restDays' ? normDays(v as number[]) : (v as Json);
    out.push([GAME_TABLE, GAME_RECORD, FIELDS[key], value as Json]);
  }
  const next = { ...current, ...patch };
  if (next.vacationFrom && next.vacationTo && next.vacationFrom > next.vacationTo) throw new RangeError('vacation ends before it starts');
  return out;
}

/** Включён ли элемент: общий выключатель и свой. */
export function gameFeature(s: GameSettings, key: 'sound' | 'celebrations' | 'phrases' | 'weeklyReview' | 'milestones' | 'garden'): boolean {
  return s.enabled && s[key];
}

/** Выходной день по настройкам. */
export function isRestDay(s: GameSettings, date: string): boolean {
  return s.restDays.includes(isoWeekday(date));
}

/** День попадает в отпуск: без даты окончания отпуска нет, без даты начала — отпуск до vacationTo. */
export function onVacation(s: GameSettings, date: string): boolean {
  return s.vacationTo !== null && date <= s.vacationTo && (s.vacationFrom === null || date >= s.vacationFrom);
}

// ---------- тёплые фразы ----------

/**
 * Факт о только что выполненной задаче. Только правда из данных: ни случайных наград, ни давления.
 * Порядок в списке типов — приоритет: если фактов несколько, показывается первый.
 */
export type WarmFact =
  | { readonly kind: 'habit'; readonly count: number }
  | { readonly kind: 'goalStreak'; readonly days: number }
  | { readonly kind: 'weekGoal'; readonly goal: number }
  | { readonly kind: 'dayStreak'; readonly days: number }
  | { readonly kind: 'oldestInbox'; readonly days: number }
  | { readonly kind: 'noOverdue' }
  | { readonly kind: 'nthToday'; readonly n: number }
  | { readonly kind: 'longWait'; readonly days: number };

const PRIORITY: readonly WarmFact['kind'][] = ['habit', 'goalStreak', 'weekGoal', 'dayStreak', 'oldestInbox', 'noOverdue', 'nthToday', 'longWait'];

/** Серии привычки, которые стоит отметить: дальше — каждые 50. */
const HABIT_MARKS = new Set([3, 5, 7, 10, 14, 21, 30]);
/** Дни подряд с выполненными задачами, которые стоит отметить: дальше — каждые 50. */
const STREAK_MARKS = new Set([3, 5, 7, 10, 14, 21, 30]);
/** Самая старая задача во «Входящих» отмечается, если висела хотя бы неделю. */
export const OLDEST_INBOX_DAYS = 7;
/** Любая задача, ждавшая месяц и дольше. */
export const LONG_WAIT_DAYS = 30;
/**
 * Частота: после фразы следующие PHRASE_GAP - 1 выполнений получают обычный тост,
 * фраза снова возможна с PHRASE_GAP-го выполнения и только если есть факт.
 */
export const PHRASE_GAP = 5;

const marked = (n: number, marks: ReadonlySet<number>) => marks.has(n) || (n >= 50 && n % 50 === 0);

/** Что известно до выполнения: после него задача уже закрыта, а срок повтора сдвинут. */
export interface BeforeCompletion {
  readonly task: TaskView;
  /** Задача во «Входящих» и создана раньше всех открытых там. */
  readonly oldestInInbox: boolean;
  /** Сколько просроченных задач было в «Сегодня». */
  readonly overdue: number;
  /** Сколько выполнено сегодня. */
  readonly doneToday: number;
}

/** Что известно после выполнения. */
export interface AfterCompletion {
  readonly overdue: number;
  readonly stats: Pick<Stats, 'today' | 'streak'>;
  readonly habit: HabitStreak | null;
  /** Цели и серия целей после выполнения; null — игровые цели не считаются. */
  readonly goals?: GoalProgress | null;
}

/** Данные Workspace (или Doc), нужные фразам; тип структурный, чтобы не тянуть Workspace в ядро настроек. */
export interface FactSource {
  readonly inboxId: string;
  task(id: string): TaskView | undefined;
  openTasks(): TaskView[];
  today(todayDate: string, tz: string): { overdue: TaskView[]; today: TaskView[] };
  stats(tz: string, today: string): Stats;
  habitStreak(taskId: string, today: string, tz: string): HabitStreak | null;
  goals?(tz: string, today: string): GoalProgress;
}

export function beforeCompletion(src: FactSource, taskId: string, today: string, tz: string): BeforeCompletion | null {
  const task = src.task(taskId);
  if (!task || task.completedAt !== null) return null;
  let oldest = task.projectId === src.inboxId;
  if (oldest) {
    for (const t of src.openTasks()) {
      if (t.projectId === src.inboxId && t.id !== task.id && t.createdAt <= task.createdAt) {
        oldest = false;
        break;
      }
    }
  }
  return { task, oldestInInbox: oldest, overdue: src.today(today, tz).overdue.length, doneToday: src.stats(tz, today).today };
}

export function afterCompletion(src: FactSource, before: BeforeCompletion, today: string, tz: string): AfterCompletion {
  return {
    overdue: src.today(today, tz).overdue.length,
    stats: src.stats(tz, today),
    habit: before.task.habit ? src.habitStreak(before.task.id, today, tz) : null,
    goals: src.goals ? src.goals(tz, today) : null,
  };
}

/** Факты о выполнении по приоритету. */
export function completionFacts(before: BeforeCompletion, after: AfterCompletion, today: string, tz: string): WarmFact[] {
  const out: WarmFact[] = [];
  const created = before.task.createdAt ? new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(before.task.createdAt)) : null;
  const age = created ? daysBetween(created, today) : 0;
  if (after.habit && marked(after.habit.current, HABIT_MARKS)) out.push({ kind: 'habit', count: after.habit.current });
  // Это выполнение добрало цель дня, и она выполнена уже не первый день подряд.
  const g = after.goals;
  const added = after.stats.today - before.doneToday;
  if (g?.day.goal != null && g.streak && before.doneToday < g.day.goal && g.day.done >= g.day.goal && g.streak.current >= 2) out.push({ kind: 'goalStreak', days: g.streak.current });
  // Это выполнение добрало цель недели.
  if (g?.week.goal != null && added > 0 && g.week.done - added < g.week.goal && g.week.done >= g.week.goal) out.push({ kind: 'weekGoal', goal: g.week.goal });
  // Первое выполнение за день продолжило серию дней.
  if (before.doneToday === 0 && after.stats.today > 0 && marked(after.stats.streak, STREAK_MARKS)) out.push({ kind: 'dayStreak', days: after.stats.streak });
  if (before.oldestInInbox && age >= OLDEST_INBOX_DAYS) out.push({ kind: 'oldestInbox', days: age });
  if (before.overdue > 0 && after.overdue === 0) out.push({ kind: 'noOverdue' });
  if (after.stats.today > before.doneToday && after.stats.today >= 5 && after.stats.today % 5 === 0) out.push({ kind: 'nthToday', n: after.stats.today });
  if (!out.some((f) => f.kind === 'oldestInbox') && age >= LONG_WAIT_DAYS) out.push({ kind: 'longWait', days: age });
  return out.sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));
}

/**
 * Выбор фразы. sinceLast — сколько выполнений прошло с прошлой фразы (на этом устройстве), включая текущее.
 * Возвращает факт для фразы или null (обычный тост) и новое значение счётчика.
 */
export function pickPhrase(facts: readonly WarmFact[], sinceLast: number): { fact: WarmFact | null; sinceLast: number } {
  const fact = sinceLast >= PHRASE_GAP ? (facts[0] ?? null) : null;
  return { fact, sinceLast: fact ? 0 : sinceLast };
}

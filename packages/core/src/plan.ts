/**
 * План дня: задачи со временем и длительностью как блоки расписания (docs/time-planning.md).
 *
 * Новой сущности нет: блок — задача с `due.time` и `duration`. Здесь только чистые расчёты в минутах
 * от полуночи у пользователя: укладка встык, ближайшая свободная дыра, сдвиг и уплотнение остатка дня,
 * строки ленты. Изменения возвращаются списком, записывает их вызывающий через `planPatch` и `doc.updateTask`
 * внутри `ws.group`, чтобы всё отменялось одним Ctrl+Z.
 *
 * Неподвижны: события календаря, задачи с флагом `fixedTime` и повторяющиеся задачи (у повторяющейся
 * перенос времени менял бы время всей серии). Подвижные блоки их обтекают. Ничего не уезжает за 24:00
 * молча: что не влезло, возвращается в `overflow` и остаётся на месте.
 */
import { moveDue, slotOf } from './calendar.ts';
import { instant, wallClock, type DateSpec } from './dates.ts';
import type { Doc, TaskPatch } from './doc.ts';
import { eventsOnDay, type CalEvent } from './events.ts';
import type { Json } from './op.ts';
import type { Reminder } from './reminders.ts';

export const DAY_MINUTES = 24 * 60;
/** Шаг, до которого округляется «сейчас» при поиске дыры и уплотнении. */
export const PLAN_STEP = 5;
/** Дыра короче этого в ленте не показывается. */
export const MIN_GAP = 5;

// ---------- настройки ----------

export const PLAN_TABLE = 'plan';
export const PLAN_RECORD = 'settings';

export interface PlanSettings {
  /** Длительность в плане для задачи без длительности, минуты (5–480). */
  readonly duration: number;
  /** Напоминать о начале каждого дела в плане (7.7). */
  readonly remind: boolean;
}

export const DEFAULT_PLAN_SETTINGS: PlanSettings = Object.freeze({ duration: 15, remind: false });
export const PLAN_DURATION_MIN = 5;
export const PLAN_DURATION_MAX = 480;

const PLAN_FIELDS: Record<keyof PlanSettings, string> = { duration: 'duration', remind: 'remind' };

function validSetting(key: keyof PlanSettings, v: unknown): boolean {
  if (key === 'remind') return typeof v === 'boolean';
  return typeof v === 'number' && Number.isInteger(v) && v >= PLAN_DURATION_MIN && v <= PLAN_DURATION_MAX;
}

/** Настройки из записи plan/settings; испорченное или отсутствующее поле — значение по умолчанию. */
export function readPlanSettings(rec: Readonly<Record<string, Json>> | undefined): PlanSettings {
  if (!rec) return DEFAULT_PLAN_SETTINGS;
  const out: Record<string, unknown> = { ...DEFAULT_PLAN_SETTINGS };
  for (const key of Object.keys(PLAN_FIELDS) as Array<keyof PlanSettings>) {
    const v = rec[PLAN_FIELDS[key]];
    if (v !== undefined && validSetting(key, v)) out[key] = v;
  }
  return out as unknown as PlanSettings;
}

/** Изменения записи для правки настроек. Неверное значение — RangeError: в данные оно не попадает. */
export function planSettingsChanges(patch: Partial<PlanSettings>): Array<readonly [string, string, string, Json]> {
  const out: Array<readonly [string, string, string, Json]> = [];
  for (const key of Object.keys(patch) as Array<keyof PlanSettings>) {
    if (!(key in PLAN_FIELDS)) throw new RangeError(`unknown plan setting: ${key}`);
    const v = patch[key];
    if (v === undefined) continue;
    if (!validSetting(key, v)) throw new RangeError(`bad value for ${key}`);
    out.push([PLAN_TABLE, PLAN_RECORD, PLAN_FIELDS[key], v]);
  }
  return out;
}

// ---------- типы ----------

/** Отрезок дня в минутах от полуночи, конец не включается. id — чей это отрезок (задача или событие). */
export interface Interval {
  readonly start: number;
  readonly end: number;
  readonly id?: string;
}

/** Что нужно от задачи: подходит Task и TaskView. */
export interface PlanTask {
  readonly id: string;
  readonly title?: string;
  readonly due: DateSpec | null;
  readonly duration: number | null;
  readonly completedAt?: number | null;
  readonly deletedAt?: number | null;
  readonly fixedTime?: boolean;
  readonly recurrence?: unknown;
}

/** День плана: задачи (любые, лишние отсеются), события календарей, пояс пользователя. */
export interface PlanDay {
  readonly date: string;
  readonly tz: string;
  readonly tasks: readonly PlanTask[];
  readonly events?: readonly CalEvent[];
  /** Длительность задачи без длительности; по умолчанию 15. */
  readonly defaultDuration?: number;
}

/** Новое место задачи. duration — с какой длительностью она уложена (своя или по умолчанию), в задачу не пишется. */
export interface PlanChange {
  readonly taskId: string;
  readonly date: string;
  readonly time: string;
  readonly minute: number;
  readonly duration: number;
}

export interface PackResult {
  readonly changes: readonly PlanChange[];
  /** Задачи, которые не влезли до 24:00, по порядку. Они не двигаются. */
  readonly overflow: readonly string[];
}

// ---------- мелочи ----------

export function minuteToTime(minute: number): string {
  const m = Math.max(0, Math.min(DAY_MINUTES - 1, Math.round(minute)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function timeToMinute(time: string): number {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

const ceilStep = (m: number) => Math.ceil(m / PLAN_STEP) * PLAN_STEP;

function durationOf(t: { readonly duration?: number | null }, dflt: number): number {
  return t.duration && t.duration > 0 ? t.duration : dflt;
}

/**
 * «Сейчас» в минутах дня date: день в прошлом — DAY_MINUTES (всё уже прошло), в будущем — null (весь день впереди).
 */
export function nowMinute(date: string, now: number, tz: string): number | null {
  const wall = wallClock(now, tz);
  if (wall.date < date) return null;
  if (wall.date > date) return DAY_MINUTES;
  return timeToMinute(wall.time);
}

/** Первое начало не раньше from, где отрезок длиной d не пересекает ни один из blocks. */
function fitAt(from: number, d: number, blocks: readonly Interval[]): number {
  let t = from;
  for (let moved = true; moved; ) {
    moved = false;
    for (const b of blocks) {
      if (b.start < t + d && b.end > t) {
        t = b.end;
        moved = true;
      }
    }
  }
  return t;
}

interface Entry {
  readonly task: PlanTask;
  readonly start: number;
  /** Не обрезан 24:00. */
  readonly end: number;
  readonly duration: number;
  readonly done: boolean;
  /** Неподвижна: флаг точного времени или повторяющаяся. */
  readonly fixed: boolean;
}

/** Задачи дня со временем (удалённые отброшены), по началу. */
function entries(day: PlanDay): Entry[] {
  const dflt = day.defaultDuration ?? DEFAULT_PLAN_SETTINGS.duration;
  const out: Entry[] = [];
  for (const t of day.tasks) {
    if (!t.due?.time || t.deletedAt) continue;
    const slot = slotOf(t.due, day.tz);
    if (!slot || slot.date !== day.date) continue;
    const duration = durationOf(t, dflt);
    out.push({
      task: t,
      start: slot.minute,
      end: slot.minute + duration,
      duration,
      done: t.completedAt !== null && t.completedAt !== undefined,
      fixed: t.fixedTime === true || (t.recurrence !== null && t.recurrence !== undefined),
    });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end || a.task.id.localeCompare(b.task.id));
}

function eventIntervals(day: PlanDay): Interval[] {
  if (!day.events?.length) return [];
  return eventsOnDay(day.events, day.date, day.tz).timed.map((e) => ({ start: e.start, end: e.end, id: e.event.id }));
}

/**
 * Занятое время дня: невыполненные задачи со временем и события календарей.
 * exclude — задачи, которые сейчас укладываются (их старое место не мешает).
 */
export function busyIntervals(day: PlanDay, exclude: Iterable<string> = []): Interval[] {
  const skip = new Set(exclude);
  const out: Interval[] = eventIntervals(day);
  for (const e of entries(day)) if (!e.done && !skip.has(e.task.id)) out.push({ start: e.start, end: e.end, id: e.task.id });
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

// ---------- укладка ----------

/**
 * Уложить задачи встык с минуты start в данном порядке, обходя занятые отрезки busy.
 * Отрезки с id укладываемых задач не мешают (это их старые места). Первая задача, которая
 * не влезает до opts.dayEnd (24:00), и все после неё попадают в overflow.
 */
export function packSequence(
  items: ReadonlyArray<{ readonly id: string; readonly duration?: number | null }>,
  start: number,
  busy: readonly Interval[],
  opts: { readonly date: string; readonly defaultDuration?: number | undefined; readonly dayEnd?: number | undefined },
): PackResult {
  const dflt = opts.defaultDuration ?? DEFAULT_PLAN_SETTINGS.duration;
  const dayEnd = opts.dayEnd ?? DAY_MINUTES;
  const ids = new Set(items.map((i) => i.id));
  const blocks = busy.filter((b) => b.end > b.start && !(b.id !== undefined && ids.has(b.id)));
  const changes: PlanChange[] = [];
  const overflow: string[] = [];
  let cursor = Math.max(0, start);
  for (const item of items) {
    if (overflow.length) {
      overflow.push(item.id);
      continue;
    }
    const d = durationOf(item, dflt);
    const t = fitAt(cursor, d, blocks);
    if (t + d > dayEnd) {
      overflow.push(item.id);
      continue;
    }
    changes.push({ taskId: item.id, date: opts.date, time: minuteToTime(t), minute: t, duration: d });
    cursor = t + d;
  }
  return { changes, overflow };
}

/** «Уложить» выбранные задачи дня встык с минуты start в порядке ids, обходя остальные блоки и события. */
export function packTasks(day: PlanDay, ids: readonly string[], start: number): PackResult {
  const byId = new Map(day.tasks.map((t) => [t.id, t]));
  const items = ids.map((id) => byId.get(id)).filter((t): t is PlanTask => t !== undefined);
  return packSequence(items, start, busyIntervals(day, ids), { date: day.date, defaultDuration: day.defaultDuration });
}

/** Первое начало (кратное 5 минутам) не раньше from, где влезает duration; null — до 24:00 не влезает. */
export function freeSlotIn(busy: readonly Interval[], from: number, duration: number, dayEnd = DAY_MINUTES): number | null {
  let t = ceilStep(Math.max(0, from));
  for (let guard = 0; guard < 1000; guard++) {
    const next = fitAt(t, duration, busy);
    const rounded = ceilStep(next);
    if (rounded === t) break;
    t = rounded;
  }
  return t + duration <= dayEnd ? t : null;
}

/**
 * Ближайшая дыра в дне не раньше «сейчас» (округлено вверх до 5 минут), куда влезает duration.
 * Будущий день ищется с 0:00, прошедший — null. exclude — задачи, чьё место не считается занятым
 * (обычно сама переносимая задача).
 */
export function nextFreeSlot(day: PlanDay, now: number, duration: number, exclude: Iterable<string> = []): number | null {
  const n = nowMinute(day.date, now, day.tz);
  if (n === DAY_MINUTES) return null;
  return freeSlotIn(busyIntervals(day, exclude), n ?? 0, duration);
}

/** «В ближайшее свободное» для одной задачи: изменение или null, если сегодня места нет. */
export function placeNextFree(day: PlanDay, taskId: string, now: number): PlanChange | null {
  const task = day.tasks.find((t) => t.id === taskId);
  if (!task) return null;
  const d = durationOf(task, day.defaultDuration ?? DEFAULT_PLAN_SETTINGS.duration);
  const m = nextFreeSlot(day, now, d, [taskId]);
  return m === null ? null : { taskId, date: day.date, time: minuteToTime(m), minute: m, duration: d };
}

// ---------- сдвиг и уплотнение остатка ----------

function fixedBlocks(day: PlanDay, list: readonly Entry[]): Interval[] {
  const out = eventIntervals(day);
  for (const e of list) if (!e.done && e.fixed) out.push({ start: e.start, end: e.end, id: e.task.id });
  return out;
}

/**
 * «+15», «+30»: невыполненные подвижные блоки дня, которые ещё не закончились (текущий тоже — человек
 * опаздывает и начнёт его позже), сдвигаются вперёд на minutes. Дыры между блоками поглощают сдвиг:
 * блок после дыры сдвигается только если в него упёрся предыдущий. Пересекавшиеся блоки сохраняют
 * взаимное смещение. Неподвижные блоки и события стоят, подвижный, налезший на них, встаёт сразу после.
 */
export function shiftRest(day: PlanDay, now: number, minutes: number): PackResult {
  if (!Number.isFinite(minutes) || minutes < 0) throw new RangeError('shift must be a positive number of minutes');
  if (minutes === 0) return { changes: [], overflow: [] };
  const n = nowMinute(day.date, now, day.tz) ?? 0;
  const list = entries(day);
  const blocks = fixedBlocks(day, list);
  const movable = list.filter((e) => !e.done && !e.fixed && e.end > n);
  const changes: PlanChange[] = [];
  const overflow: string[] = [];
  let prev: { origStart: number; origEnd: number; start: number; end: number } | null = null;
  for (const e of movable) {
    if (overflow.length) {
      overflow.push(e.task.id);
      continue;
    }
    let t = e.start + minutes;
    if (prev) t = e.start >= prev.origEnd ? Math.max(t, prev.end) : Math.max(t, prev.start + (e.start - prev.origStart));
    t = fitAt(t, e.duration, blocks);
    if (t + e.duration > DAY_MINUTES) {
      overflow.push(e.task.id);
      continue;
    }
    if (t !== e.start) changes.push({ taskId: e.task.id, date: day.date, time: minuteToTime(t), minute: t, duration: e.duration });
    prev = { origStart: e.start, origEnd: e.end, start: t, end: t + e.duration };
  }
  return { changes, overflow };
}

/**
 * «Уплотнить»: невыполненные подвижные блоки, которые начинаются позже «сейчас», встают встык
 * от «сейчас» (округлено вверх до 5 минут) в прежнем порядке, обходя неподвижные блоки и события.
 * Текущий блок (начался, ещё не закончился) не двигается: уплотнение идёт от его конца.
 * Прошедшие невыполненные блоки не трогаются. Будущий день уплотняется от начала первого подвижного блока.
 */
export function compactRest(day: PlanDay, now: number): PackResult {
  const nm = nowMinute(day.date, now, day.tz);
  if (nm === DAY_MINUTES) return { changes: [], overflow: [] };
  const list = entries(day);
  const open = list.filter((e) => !e.done && !e.fixed);
  const current = nm === null ? [] : open.filter((e) => e.start <= nm && e.end > nm);
  const future = open.filter((e) => (nm === null ? true : e.start > nm));
  if (!future.length) return { changes: [], overflow: [] };
  let cursor = nm === null ? future[0]!.start : ceilStep(nm);
  for (const c of current) cursor = Math.max(cursor, c.end);
  const blocks = [...fixedBlocks(day, list), ...current.map((c) => ({ start: c.start, end: c.end, id: c.task.id }))];
  const packed = packSequence(
    future.map((e) => ({ id: e.task.id, duration: e.duration })),
    cursor,
    blocks,
    { date: day.date, defaultDuration: day.defaultDuration },
  );
  const startOf = new Map(future.map((e) => [e.task.id, e.start]));
  return { changes: packed.changes.filter((c) => c.minute !== startOf.get(c.taskId)), overflow: packed.overflow };
}

/** Правка задачи для изменения плана: только срок (пояс задачи сохраняется). Длительность не пишется. */
export function planPatch(task: { readonly due: DateSpec | null }, change: PlanChange, tz: string): TaskPatch {
  return { due: moveDue(task.due, change.date, change.minute, tz) };
}

// ---------- лента ----------

export type TimelineRow =
  | {
      readonly kind: 'task';
      readonly id: string;
      readonly title: string;
      readonly start: number;
      /** Обрезан 24:00. */
      readonly end: number;
      readonly duration: number;
      /** Длительность взята по умолчанию: у задачи своей нет. */
      readonly defaultDuration: boolean;
      readonly fixed: boolean;
      readonly done: boolean;
      readonly current: boolean;
      /** Минут до конца у текущего, иначе null. */
      readonly left: number | null;
    }
  | {
      readonly kind: 'event';
      readonly id: string;
      readonly title: string;
      readonly color: string;
      readonly start: number;
      readonly end: number;
      readonly current: boolean;
      readonly left: number | null;
    }
  | { readonly kind: 'free'; readonly start: number; readonly minutes: number };

/**
 * Строки ленты дня: задачи со временем (и выполненные) и события по началу, между ними строки
 * «свободно» от 5 минут. Пересекающиеся блоки идут подряд по началу, дыра считается от самого позднего
 * конца выше. До первого и после последнего блока строк «свободно» нет. now = null — без текущего.
 */
export function dayTimeline(day: PlanDay, now: number | null): TimelineRow[] {
  const nm = now === null ? null : nowMinute(day.date, now, day.tz);
  const isCurrent = (s: number, e: number) => nm !== null && s <= nm && nm < e;
  type Row = Exclude<TimelineRow, { kind: 'free' }>;
  const rows: Row[] = [];
  for (const e of entries(day)) {
    const end = Math.min(e.end, DAY_MINUTES);
    const current = !e.done && isCurrent(e.start, end);
    rows.push({
      kind: 'task',
      id: e.task.id,
      title: e.task.title ?? '',
      start: e.start,
      end,
      duration: e.duration,
      defaultDuration: !(e.task.duration && e.task.duration > 0),
      fixed: e.fixed,
      done: e.done,
      current,
      left: current ? end - nm! : null,
    });
  }
  if (day.events?.length) {
    for (const ev of eventsOnDay(day.events, day.date, day.tz).timed) {
      const current = isCurrent(ev.start, ev.end);
      rows.push({ kind: 'event', id: ev.event.id, title: ev.event.title, color: ev.event.color, start: ev.start, end: ev.end, current, left: current ? ev.end - nm! : null });
    }
  }
  rows.sort((a, b) => a.start - b.start || a.end - b.end || (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === 'event' ? -1 : 1));
  const out: TimelineRow[] = [];
  let cover: number | null = null;
  for (const r of rows) {
    if (cover !== null && r.start - cover >= MIN_GAP) out.push({ kind: 'free', start: cover, minutes: r.start - cover });
    out.push(r);
    cover = cover === null ? r.end : Math.max(cover, r.end);
  }
  return out;
}

// ---------- напоминания о начале дел (7.7) ----------

/**
 * Напоминания о начале каждого дела в плане: у открытых задач со временем — в момент начала, в [from, to).
 * Пусто, если настройка выключена. Задача с «без напоминания» ([]) пропускается. Ключ тот же, что у
 * напоминания со смещением 0 из remindersBetween, поэтому вместе они не показываются дважды.
 */
export function planReminders(doc: Pick<Doc, 'openTasks'>, from: number, to: number, tz: string, settings: Pick<PlanSettings, 'remind'>): Reminder[] {
  if (!settings.remind) return [];
  const out: Reminder[] = [];
  for (const t of doc.openTasks()) {
    if (!t.due?.time || (t.reminders !== null && t.reminders.length === 0)) continue;
    const at = instant(t.due, tz);
    if (at < from || at >= to) continue;
    out.push({ key: `${t.id}:${t.due.date}T${t.due.time}:0`, taskId: t.id, at, title: t.title, dueAt: at, offset: 0, ...(t.alarm ? { alarm: true } : {}) });
  }
  return out.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

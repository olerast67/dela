/**
 * План дня на сайте: сбор дня для ленты и действия над ним (docs/time-planning.md, ROADMAP 7.3, 7.4).
 *
 * Расчёты укладки живут в ядре (packages/core/src/plan.ts). Здесь то, что нужно экранам: какие задачи
 * входят в день (с повторами на будущие дни), перестановка строк ленты, вставка в место броска,
 * дело из строки «свободно», запись изменений одной записью отмены.
 */
import {
  DAY_MINUTES,
  PLAN_STEP,
  busyIntervals,
  dayTimeline,
  freeSlotIn,
  nowMinute,
  packSequence,
  planPatch,
  type CalEvent,
  type Interval,
  type PackResult,
  type ParsedTask,
  type PlanChange,
  type PlanDay,
  type Reminder,
  type TaskView,
  type TimelineRow,
  type Workspace,
} from '#core';

/** Начало пустого будущего дня, куда встаёт первое дело. */
export const EMPTY_DAY_START = 9 * 60;

export type TaskRow = Extract<TimelineRow, { kind: 'task' }>;
export type FreeRow = Extract<TimelineRow, { kind: 'free' }>;

const ceilStep = (m: number) => Math.ceil(m / PLAN_STEP) * PLAN_STEP;
const empty: PackResult = { changes: [], overflow: [] };

type DayDoc = Pick<Workspace, 'upcoming' | 'completedTasks' | 'doneToday' | 'task' | 'getPlanSettings'>;

/**
 * День плана: открытые задачи на дату (повторяющиеся — и будущими экземплярами), выполненные в этот день,
 * выполненные экземпляры повторов сегодня, события календарей. extra — задачи, которые сейчас укладываются
 * в этот день, даже если срок у них другой или его нет.
 */
export function planDayFor(doc: DayDoc, date: string, tz: string, events: readonly CalEvent[], today: string, extra: readonly string[] = []): PlanDay {
  const tasks: TaskView[] = [...(doc.upcoming(date, 1, tz)[0]?.tasks ?? [])];
  const seen = new Set(tasks.filter((t) => !t.projected).map((t) => t.id));
  for (const t of doc.completedTasks()) if (t.due?.date === date && t.due.time) tasks.push(t);
  if (date === today) for (const t of doc.doneToday(today, tz)) if (t.due?.time) tasks.push(t);
  for (const id of extra) {
    if (seen.has(id)) continue;
    const t = doc.task(id);
    if (t) tasks.push(t);
  }
  return { date, tz, tasks, events, defaultDuration: doc.getPlanSettings().duration };
}

/** Записать изменения плана одной записью отмены. */
export function applyPlan(doc: Pick<Workspace, 'group' | 'task' | 'updateTask'>, changes: readonly PlanChange[], tz: string): void {
  if (!changes.length) return;
  doc.group(() => {
    for (const c of changes) {
      const t = doc.task(c.taskId);
      if (t) doc.updateTask(c.taskId, planPatch(t, c, tz));
    }
  });
}

const taskRows = (day: PlanDay): TaskRow[] => dayTimeline(day, null).filter((r): r is TaskRow => r.kind === 'task');

/** Конец занятого перед строкой index (самый поздний конец задач и событий выше). */
function coverBefore(rows: readonly TimelineRow[], index: number): number | null {
  let cover: number | null = null;
  for (let i = 0; i < index; i++) {
    const r = rows[i]!;
    if (r.kind !== 'free') cover = cover === null ? r.end : Math.max(cover, r.end);
  }
  return cover;
}

/** Подвижные дела: событие, повтор, точное время и выполненное не двигаются. */
const movable = (r: TaskRow) => !r.fixed && !r.done;

/**
 * Перестановка в ленте: задача dragId встаёт перед строкой-задачей с номером to (to = длина — в конец).
 * Время пересчитывается встык с самого раннего начала задетого отрезка; неподвижные дела и события стоят,
 * подвижные их обтекают. Если задачу поставили прямо перед неподвижным делом, она встаёт так, чтобы
 * закончиться к его началу.
 */
export function reorderPlan(day: PlanDay, dragId: string, to: number): PackResult {
  const rows = taskRows(day);
  const order = rows.map((r) => r.id);
  const from = order.indexOf(dragId);
  if (from < 0) return empty;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const drag = byId.get(dragId)!;
  if (!movable(drag)) return empty;
  const next = order.filter((id) => id !== dragId);
  const at = Math.max(0, Math.min(next.length, to > from ? to - 1 : to));
  if (at === from) return empty;
  next.splice(at, 0, dragId);
  const lo = Math.min(from, at);
  const hi = Math.max(from, at);
  const range = next.slice(lo, hi + 1).map((id) => byId.get(id)!);
  let start = Math.min(...range.map((r) => r.start));
  const after = byId.get(next[at + 1] ?? '');
  if (at < from && after && !movable(after)) {
    const before = byId.get(next[at - 1] ?? '');
    start = Math.max(before ? before.end : 0, after.start - drag.duration);
  }
  // Встык в показанном порядке: дело ниже неподвижного встаёт после него, а не в дыру перед ним.
  // За задетым отрезком дела сдвигаются, только если на них налезли, до первой дыры.
  const busy = fixedBusy(day, '');
  const opts = { date: day.date, defaultDuration: day.defaultDuration };
  const changes: PlanChange[] = [];
  const overflow: string[] = [];
  let cursor = start;
  for (let i = lo; i < next.length; i++) {
    const r = byId.get(next[i]!)!;
    const inRange = i <= hi;
    if (!movable(r)) {
      if (inRange && !r.done) cursor = Math.max(cursor, r.end);
      continue;
    }
    if (!inRange && r.start >= cursor) break;
    if (overflow.length) {
      overflow.push(r.id);
      continue;
    }
    const c = packSequence([{ id: r.id, duration: r.duration }], cursor, busy, opts).changes[0];
    if (!c) {
      overflow.push(r.id);
      continue;
    }
    if (c.minute !== r.start) changes.push(c);
    cursor = c.minute + c.duration;
  }
  return { changes, overflow };
}

/** Неподвижное в дне: события и открытые дела с точным временем или повтором. */
function fixedBusy(day: PlanDay, skip: string): Interval[] {
  const fixed = new Set(taskRows(day).filter((r) => r.fixed && !r.done).map((r) => r.id));
  return busyIntervals(day, [skip]).filter((b) => b.id === undefined || fixed.has(b.id) || !day.tasks.some((t) => t.id === b.id));
}

/**
 * Поставить задачу с минуты start (бросок в ленту, строка «свободно»). Следующие подвижные дела, на которые
 * она налезла, сдвигаются вперёд, пока не упрутся в дыру; неподвижные стоят, сдвинутое их обтекает.
 */
export function insertPlan(day: PlanDay, taskId: string, start: number): PackResult {
  const task = day.tasks.find((t) => t.id === taskId);
  if (!task) return empty;
  const opts = { date: day.date, defaultDuration: day.defaultDuration };
  const busy = fixedBusy(day, taskId);
  const first = packSequence([{ id: taskId, duration: task.duration }], start, busy, opts);
  if (!first.changes.length) return first;
  const changes: PlanChange[] = [...first.changes];
  const overflow: string[] = [];
  let cursor = first.changes[0]!.minute + first.changes[0]!.duration;
  const placedAt = first.changes[0]!.minute;
  for (const r of taskRows(day)) {
    if (r.id === taskId || !movable(r) || r.start < placedAt) continue;
    if (r.start >= cursor) break;
    const moved = packSequence([{ id: r.id, duration: r.duration }], cursor, busy, opts);
    if (!moved.changes.length) {
      overflow.push(r.id);
      continue;
    }
    changes.push(moved.changes[0]!);
    cursor = moved.changes[0]!.minute + moved.changes[0]!.duration;
  }
  return { changes, overflow };
}

/** Куда в ленте бросили: перед строкой с номером index или в строку «свободно». */
export type DropSpot = { readonly kind: 'gap'; readonly index: number } | { readonly kind: 'free'; readonly start: number };

/** С какой минуты встаёт задача длиной duration, брошенная в spot; rows — строки ленты (без самой задачи). */
export function spotStart(rows: readonly TimelineRow[], spot: DropSpot, duration: number, fallback: number): number {
  if (spot.kind === 'free') return spot.start;
  const cover = coverBefore(rows, spot.index);
  if (cover !== null) return cover;
  const next = rows.find((r) => r.kind !== 'free');
  return next ? Math.max(0, next.start - duration) : fallback;
}

/** Начало для пустого дня или конца ленты: сегодня — ближайшие 5 минут, будущий день — 9:00. */
export function dayStartFor(day: PlanDay, now: number): number {
  const n = nowMinute(day.date, now, day.tz);
  if (n === null) return EMPTY_DAY_START;
  return Math.min(ceilStep(n), DAY_MINUTES - PLAN_STEP);
}

/** После последнего дела ленты (или начало дня, если дел нет и сейчас позже). */
export function afterLast(day: PlanDay, now: number): number {
  const rows = dayTimeline(day, null);
  const cover = coverBefore(rows, rows.length);
  const n = nowMinute(day.date, now, day.tz);
  const base = n === null ? null : ceilStep(n);
  if (cover === null) return dayStartFor(day, now);
  return base === null ? cover : Math.max(cover, base);
}

/** Начало для «Уложить»: ближайшая дыра, куда влезают все дела подряд (иначе хотя бы первое). */
export function nearestFreeStart(day: PlanDay, ids: readonly string[], now: number, from?: number): number | null {
  const n = nowMinute(day.date, now, day.tz);
  if (n === DAY_MINUTES) return null;
  const dflt = day.defaultDuration ?? 15;
  const durations = ids.map((id) => {
    const t = day.tasks.find((x) => x.id === id);
    return t?.duration && t.duration > 0 ? t.duration : dflt;
  });
  const busy = busyIntervals(day, ids);
  const base = from ?? n ?? firstStart(day) ?? EMPTY_DAY_START;
  const total = durations.reduce((a, b) => a + b, 0);
  return freeSlotIn(busy, base, total) ?? freeSlotIn(busy, base, durations[0] ?? dflt);
}

function firstStart(day: PlanDay): number | null {
  const r = dayTimeline(day, null).find((x) => x.kind !== 'free');
  return r ? r.start : null;
}

/**
 * Дела из строки «свободно» или конца ленты: ведущие куски фразы без своего срока встают встык с минуты
 * start, обходя занятое; куски со своим временем (и цепочка после них) остаются, как их разобрал parsePlan.
 */
export function placePieces(pieces: readonly ParsedTask[], day: PlanDay, start: number): ParsedTask[] {
  const lead: number[] = [];
  for (let i = 0; i < pieces.length && !pieces[i]!.due; i++) lead.push(i);
  if (!lead.length) return [...pieces];
  const items = lead.map((i) => ({ id: `#${i}`, duration: pieces[i]!.duration }));
  const packed = packSequence(items, start, busyIntervals(day), { date: day.date, defaultDuration: day.defaultDuration });
  const at = new Map(packed.changes.map((c) => [c.taskId, c.time]));
  return pieces.map((p, i) => {
    const time = at.get(`#${i}`);
    if (time) return { ...p, due: { date: day.date, time } };
    return lead.includes(i) ? { ...p, due: { date: day.date } } : p;
  });
}

/** Задачи в том порядке, в каком они показаны на экране (для «Уложить»); не найденные — в конце по выбору. */
export function visualOrder(ids: readonly string[], shown: readonly string[]): string[] {
  const pos = new Map(shown.map((id, i) => [id, i]));
  return [...ids].sort((a, b) => (pos.get(a) ?? Infinity) - (pos.get(b) ?? Infinity));
}

/** Напоминания задач вместе с напоминаниями о начале дел плана; одинаковый ключ — одно напоминание. */
export function withPlanReminders(list: readonly Reminder[], plan: readonly Reminder[]): Reminder[] {
  if (!plan.length) return [...list];
  const keys = new Set(list.map((r) => r.key));
  return [...list, ...plan.filter((r) => !keys.has(r.key))].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

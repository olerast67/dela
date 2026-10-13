/**
 * Расчёты для календаря: сетка месяца и недели, место задачи в сетке часов,
 * раскладка пересекающихся задач по колонкам, новый срок после перетаскивания.
 */
import { addDays, isoWeekday, parts, makeDate, wallClock, zonedToUtc, type DateSpec } from './dates.ts';

/** Понедельник недели, в которую попадает date. */
export function weekStart(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

/** Семь дат недели с понедельника. */
export function weekDates(date: string): string[] {
  const start = weekStart(date);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** Сетка месяца: 6 недель с понедельника, первая неделя содержит 1-е число. */
export function monthGrid(date: string): string[] {
  const { year, month } = parts(date);
  const start = weekStart(makeDate(year, month, 1));
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** Первое число месяца даты. */
export function monthStart(date: string): string {
  const { year, month } = parts(date);
  return makeDate(year, month, 1);
}

/**
 * Где задача стоит в сетке часов у пользователя: дата и минута от полуночи.
 * Задача без времени в сетку не попадает (null).
 */
export function slotOf(due: DateSpec, userTz: string): { date: string; minute: number } | null {
  if (!due.time) return null;
  const wall = due.tz && due.tz !== userTz ? wallClock(zonedToUtc(due.date, due.time, due.tz), userTz) : { date: due.date, time: due.time };
  const [h, m] = wall.time.split(':').map(Number) as [number, number];
  return { date: wall.date, minute: h * 60 + m };
}

function hhmm(minute: number): string {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(minute)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * Новый срок после переноса задачи в календаре.
 * minute === null: на день без времени. Задача с фиксированным поясом остаётся в своём поясе,
 * время пересчитывается так, чтобы у пользователя она встала туда, куда её бросили.
 */
export function moveDue(due: DateSpec | null, date: string, minute: number | null, userTz: string): DateSpec {
  if (minute === null) {
    // В месячной сетке и в строке «весь день»: время остаётся, меняется только день.
    if (!due?.time) return { date };
    if (!due.tz || due.tz === userTz) return { ...due, date };
    const slot = slotOf(due, userTz)!;
    return moveDue(due, date, slot.minute, userTz);
  }
  const time = hhmm(minute);
  if (!due?.tz || due.tz === userTz) return { date, time };
  const there = wallClock(zonedToUtc(date, time, userTz), due.tz);
  return { date: there.date, time: there.time, tz: due.tz };
}

/** Округлить минуту до шага (по умолчанию 15 минут) в пределах суток. */
export function snapMinute(minute: number, step = 15): number {
  const s = Math.round(minute / step) * step;
  return Math.max(0, Math.min(24 * 60 - step, s));
}

export interface TimedItem {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

export interface PlacedItem extends TimedItem {
  /** Колонка внутри группы пересекающихся задач. */
  readonly col: number;
  /** Сколько колонок в группе. */
  readonly cols: number;
}

/**
 * Раскладка задач одного дня: пересекающиеся по времени стоят рядом, каждая в своей колонке.
 * Группа — цепочка задач, которые пересекаются друг с другом хотя бы попарно по цепочке.
 */
export function layoutDay(items: readonly TimedItem[]): PlacedItem[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id));
  const out: PlacedItem[] = [];
  let group: Array<{ item: TimedItem; col: number }> = [];
  let colsEnd: number[] = [];
  let groupEnd = -1;
  const flush = () => {
    const cols = colsEnd.length;
    for (const g of group) out.push({ ...g.item, col: g.col, cols });
    group = [];
    colsEnd = [];
  };
  for (const item of sorted) {
    if (item.start >= groupEnd) flush();
    let col = colsEnd.findIndex((end) => end <= item.start);
    if (col === -1) {
      col = colsEnd.length;
      colsEnd.push(item.end);
    } else colsEnd[col] = item.end;
    group.push({ item, col });
    groupEnd = Math.max(groupEnd, item.end);
  }
  flush();
  return out;
}

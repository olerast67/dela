/**
 * Календарные даты как строки YYYY-MM-DD и время HH:MM.
 * Дата без часового пояса «плавающая»: 9:00 там, где сейчас пользователь.
 */

export interface DateSpec {
  /** Календарная дата YYYY-MM-DD. */
  readonly date: string;
  /** Время HH:MM; без него задача на весь день. */
  readonly time?: string;
  /** IANA-пояс для фиксированного времени («15:00 по Москве»); без него время плавающее. */
  readonly tz?: string;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

export function isDate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}

export function isTime(s: unknown): s is string {
  return typeof s === 'string' && TIME_RE.test(s);
}

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isDateSpec(v: unknown): v is DateSpec {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (!isDate(o.date)) return false;
  if (o.time !== undefined && !isTime(o.time)) return false;
  if (o.tz !== undefined && (!isTimeZone(o.tz) || o.time === undefined)) return false;
  return true;
}

function toUtcDays(date: string): number {
  const m = DATE_RE.exec(date)!;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) / DAY_MS;
}

function fromUtcDays(days: number): string {
  return new Date(days * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  return fromUtcDays(toUtcDays(date) + n);
}

/** Сколько дней от a до b (b − a). */
export function daysBetween(a: string, b: string): number {
  return toUtcDays(b) - toUtcDays(a);
}

/** День недели: 1 — понедельник … 7 — воскресенье (ISO). */
export function isoWeekday(date: string): number {
  const d = new Date(toUtcDays(date) * DAY_MS).getUTCDay();
  return d === 0 ? 7 : d;
}

export function addMonths(date: string, n: number): string {
  const m = DATE_RE.exec(date)!;
  const y = +m[1]!;
  const mo = +m[2]! - 1 + n;
  const day = +m[3]!;
  const target = new Date(Date.UTC(y, mo, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return fromUtcDays(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, lastDay)) / DAY_MS);
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function parts(date: string): { year: number; month: number; day: number } {
  const m = DATE_RE.exec(date)!;
  return { year: +m[1]!, month: +m[2]!, day: +m[3]! };
}

export function makeDate(year: number, month1: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Дата и время на стенных часах пояса tz в момент ms. */
export function wallClock(ms: number, tz: string): { date: string; time: string } {
  const p: Record<string, string> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** Смещение пояса tz относительно UTC в момент ms, в мс. */
function offsetAt(ms: number, tz: string): number {
  const p: Record<string, string> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Момент времени для стенных часов date + time в поясе tz. В «дыре» перевода часов сдвигает вперёд. */
export function zonedToUtc(date: string, time: string, tz: string): number {
  const { year, month, day } = parts(date);
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(year, month - 1, day, h, mi);
  let result = guess - offsetAt(guess, tz);
  const second = guess - offsetAt(result, tz);
  if (second !== result) result = Math.max(result, second);
  return result;
}

/** Сегодняшняя дата в поясе tz. */
export function today(tz: string, now: number = Date.now()): string {
  return wallClock(now, tz).date;
}

/** Календарная дата срока для пользователя в поясе userTz. */
export function localDate(spec: DateSpec, userTz: string): string {
  if (spec.tz && spec.time) return wallClock(zonedToUtc(spec.date, spec.time, spec.tz), userTz).date;
  return spec.date;
}

/** Момент срока для сортировки и напоминаний. Задача на весь день считается до конца дня. */
export function instant(spec: DateSpec, userTz: string): number {
  if (spec.time) return zonedToUtc(spec.date, spec.time, spec.tz ?? userTz);
  return zonedToUtc(spec.date, '23:59', userTz);
}

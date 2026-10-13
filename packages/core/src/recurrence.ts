/**
 * Повторы: подмножество RRULE (RFC 5545), которого хватает задачнику.
 * FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, BYDAY (с порядковым номером для месяца: 2TU, -1FR),
 * BYMONTHDAY (−1 — последний день), BYMONTH, UNTIL=YYYYMMDD.
 *
 * Даты экземпляров считаются от якоря — даты, с которой начинается серия.
 * Если в месяце нет 31-го числа, экземпляр ставится на последний день месяца.
 */
import { addDays, daysBetween, daysInMonth, isDate, isoWeekday, makeDate, parts } from './dates.ts';

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export interface WeekdayNum {
  /** 1 — понедельник … 7 — воскресенье. */
  readonly day: number;
  /** Номер в месяце: 1…5 или −1…−5 (−1 — последний). */
  readonly n?: number;
}

export interface Rule {
  readonly freq: Freq;
  readonly interval: number;
  readonly byDay?: readonly WeekdayNum[];
  readonly byMonthDay?: readonly number[];
  readonly byMonth?: readonly number[];
  /** Последняя допустимая дата серии. */
  readonly until?: string;
}

const DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
const MAX_PERIODS = 5000;

export function parseRule(text: string): Rule | null {
  const map = new Map<string, string>();
  for (const part of text.toUpperCase().split(';')) {
    if (!part) continue;
    const [k, v] = part.split('=');
    if (!k || v === undefined || map.has(k)) return null;
    map.set(k, v);
  }
  const freq = map.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;
  const intervalText = map.get('INTERVAL') ?? '1';
  if (!/^\d{1,3}$/.test(intervalText) || Number(intervalText) < 1) return null;
  const rule: { -readonly [K in keyof Rule]: Rule[K] } = { freq, interval: Number(intervalText) };

  const byDay = map.get('BYDAY');
  if (byDay !== undefined) {
    const days: WeekdayNum[] = [];
    for (const item of byDay.split(',')) {
      const m = /^([+-]?[1-5])?(MO|TU|WE|TH|FR|SA|SU)$/.exec(item);
      if (!m) return null;
      const day = DAY_CODES.indexOf(m[2] as (typeof DAY_CODES)[number]) + 1;
      days.push(m[1] ? { day, n: Number(m[1]) } : { day });
    }
    rule.byDay = days;
  }
  const byMonthDay = map.get('BYMONTHDAY');
  if (byMonthDay !== undefined) {
    const days = byMonthDay.split(',').map(Number);
    if (days.some((d) => !Number.isInteger(d) || d === 0 || d < -31 || d > 31)) return null;
    rule.byMonthDay = days;
  }
  const byMonth = map.get('BYMONTH');
  if (byMonth !== undefined) {
    const months = byMonth.split(',').map(Number);
    if (months.some((m) => !Number.isInteger(m) || m < 1 || m > 12)) return null;
    rule.byMonth = months;
  }
  const until = map.get('UNTIL');
  if (until !== undefined) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(until);
    const date = m ? `${m[1]}-${m[2]}-${m[3]}` : '';
    if (!isDate(date)) return null;
    rule.until = date;
  }
  for (const k of map.keys()) {
    if (!['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'UNTIL', 'WKST'].includes(k)) return null;
  }
  return rule;
}

export function formatRule(rule: Rule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay?.length) parts.push(`BYDAY=${rule.byDay.map((d) => `${d.n ?? ''}${DAY_CODES[d.day - 1]}`).join(',')}`);
  if (rule.byMonthDay?.length) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`);
  if (rule.byMonth?.length) parts.push(`BYMONTH=${rule.byMonth.join(',')}`);
  if (rule.until) parts.push(`UNTIL=${rule.until.replace(/-/g, '')}`);
  return parts.join(';');
}

/** Даты недели, месяца или года с номером period от якоря (уже по возрастанию). */
function candidates(rule: Rule, anchor: string, period: number): string[] {
  const a = parts(anchor);
  const step = period * rule.interval;
  switch (rule.freq) {
    case 'DAILY':
      return [addDays(anchor, step)];
    case 'WEEKLY': {
      const weekStart = addDays(anchor, 1 - isoWeekday(anchor) + step * 7);
      const days = rule.byDay?.length ? rule.byDay.map((d) => d.day) : [isoWeekday(anchor)];
      return [...new Set(days)].sort((x, y) => x - y).map((d) => addDays(weekStart, d - 1));
    }
    case 'MONTHLY': {
      const total = a.year * 12 + (a.month - 1) + step;
      return monthDays(rule, Math.floor(total / 12), (total % 12) + 1, a.day);
    }
    case 'YEARLY': {
      const year = a.year + step;
      const months = rule.byMonth?.length ? rule.byMonth : [a.month];
      return [...new Set(months)]
        .sort((x, y) => x - y)
        .flatMap((m) => monthDays({ ...rule, byDay: rule.byDay ?? [], byMonthDay: rule.byMonthDay ?? [] }, year, m, a.day));
    }
  }
}

function monthDays(rule: Rule, year: number, month: number, anchorDay: number): string[] {
  const last = daysInMonth(year, month);
  const out = new Set<number>();
  for (const d of rule.byMonthDay ?? []) out.add(d < 0 ? Math.max(1, last + d + 1) : Math.min(d, last));
  for (const wd of rule.byDay ?? []) {
    const firstWeekday = isoWeekday(makeDate(year, month, 1));
    const first = 1 + ((wd.day - firstWeekday + 7) % 7);
    const all: number[] = [];
    for (let d = first; d <= last; d += 7) all.push(d);
    if (wd.n === undefined) all.forEach((d) => out.add(d));
    else {
      const pick = wd.n > 0 ? all[wd.n - 1] : all[all.length + wd.n];
      if (pick !== undefined) out.add(pick);
    }
  }
  if (!rule.byMonthDay?.length && !rule.byDay?.length) out.add(Math.min(anchorDay, last));
  return [...out].sort((x, y) => x - y).map((d) => makeDate(year, month, d));
}

/** Номер периода, в котором лежит дата (может быть отрицательным). */
function periodOf(rule: Rule, anchor: string, date: string): number {
  const a = parts(anchor);
  const d = parts(date);
  let units: number;
  switch (rule.freq) {
    case 'DAILY':
      units = daysBetween(anchor, date);
      break;
    case 'WEEKLY':
      units = Math.floor(daysBetween(addDays(anchor, 1 - isoWeekday(anchor)), date) / 7);
      break;
    case 'MONTHLY':
      units = (d.year - a.year) * 12 + (d.month - a.month);
      break;
    case 'YEARLY':
      units = d.year - a.year;
      break;
  }
  return Math.floor(units / rule.interval);
}

/** Первый экземпляр строго после after и не раньше якоря. null, если серия закончилась. */
export function nextOccurrence(rule: Rule, anchor: string, after: string): string | null {
  const from = Math.max(0, periodOf(rule, anchor, after));
  for (let p = from; p < from + MAX_PERIODS; p++) {
    for (const c of candidates(rule, anchor, p)) {
      if (c <= after || c < anchor) continue;
      return rule.until !== undefined && c > rule.until ? null : c;
    }
  }
  return null;
}

/** Первый экземпляр не раньше from. */
export function firstOnOrAfter(rule: Rule, anchor: string, from: string): string | null {
  return nextOccurrence(rule, anchor, addDays(from, -1));
}

/** Экземпляры в полуинтервале [from, to). */
export function occurrencesBetween(rule: Rule, anchor: string, from: string, to: string, limit = 400): string[] {
  const out: string[] = [];
  let cur = firstOnOrAfter(rule, anchor, from);
  while (cur !== null && cur < to && out.length < limit) {
    out.push(cur);
    cur = nextOccurrence(rule, anchor, cur);
  }
  return out;
}

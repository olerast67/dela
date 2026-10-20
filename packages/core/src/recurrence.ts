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

// ---------- правило словами ----------

// Род дня недели в винительном падеже: от него зависят «каждый/каждую/каждое» и форма порядкового числительного.
type Gender = 'm' | 'f' | 'n';
const RU_DAY_ACC = ['понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'] as const;
const RU_DAY_GENDER: readonly Gender[] = ['m', 'm', 'f', 'm', 'f', 'f', 'n'];
const RU_DAY_DAT_PL = ['понедельникам', 'вторникам', 'средам', 'четвергам', 'пятницам', 'субботам', 'воскресеньям'] as const;
const EN_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const RU_MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'] as const;
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

const EVERY_RU_G: Readonly<Record<Gender, string>> = { m: 'каждый', f: 'каждую', n: 'каждое' };
const RU_ORD: Readonly<Record<number, Readonly<Record<Gender, string>>>> = {
  1: { m: 'первый', f: 'первую', n: 'первое' },
  2: { m: 'второй', f: 'вторую', n: 'второе' },
  3: { m: 'третий', f: 'третью', n: 'третье' },
  4: { m: 'четвёртый', f: 'четвёртую', n: 'четвёртое' },
  5: { m: 'пятый', f: 'пятую', n: 'пятое' },
  [-1]: { m: 'последний', f: 'последнюю', n: 'последнее' },
};
const EN_ORD: Readonly<Record<number, string>> = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', [-1]: 'last' };

function ruPlural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function joinList(items: readonly string[], and: string): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${and} ${items[items.length - 1]}`;
}

function enNth(d: number): string {
  const m100 = d % 100;
  const suffix = m100 >= 11 && m100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][d % 10] ?? 'th');
  return `${d}${suffix}`;
}

/** «каждые 3 дня», «каждый 21 день» / «every 3 days»: интервал больше единицы. */
function everyN(n: number, unit: 'day' | 'week' | 'month' | 'year', lang: 'ru' | 'en'): string {
  if (lang === 'en') return `every ${n} ${unit}s`;
  const forms: Readonly<Record<typeof unit, readonly [string, string, string]>> = {
    day: ['день', 'дня', 'дней'],
    week: ['неделю', 'недели', 'недель'],
    month: ['месяц', 'месяца', 'месяцев'],
    year: ['год', 'года', 'лет'],
  };
  const [one, few, many] = forms[unit];
  const word = ruPlural(n, one, few, many);
  // «каждый 21 день», «каждую 21 неделю», но «каждые 2 недели».
  const every = word === one ? (unit === 'week' ? 'каждую' : 'каждый') : 'каждые';
  return `${every} ${n} ${word}`;
}

function enDays(days: readonly number[]): string {
  return joinList(days.map((d) => EN_DAYS[d - 1]!), 'and');
}

function weeklyText(rule: Rule, lang: 'ru' | 'en'): string {
  const days = [...new Set((rule.byDay ?? []).map((d) => d.day))].sort((a, b) => a - b);
  const key = days.join(',');
  if (rule.interval === 1) {
    if (key === '1,2,3,4,5') return lang === 'ru' ? 'по будням' : 'every weekday';
    if (key === '6,7') return lang === 'ru' ? 'по выходным' : 'every weekend';
    if (!days.length) return lang === 'ru' ? 'каждую неделю' : 'every week';
    if (lang === 'en') return `every ${enDays(days)}`;
    return `${EVERY_RU_G[RU_DAY_GENDER[days[0]! - 1]!]} ${joinList(days.map((d) => RU_DAY_ACC[d - 1]!), 'и')}`;
  }
  const base = everyN(rule.interval, 'week', lang);
  if (!days.length) return base;
  if (lang === 'en') return `${base} on ${enDays(days)}`;
  return `${base} по ${joinList(days.map((d) => RU_DAY_DAT_PL[d - 1]!), 'и')}`;
}

/** Дни месяца: «15 числа», «в последний день», «во второй вторник» / «on the 15th». */
function monthDaysText(rule: Rule, lang: 'ru' | 'en'): string {
  const pieces: string[] = [];
  for (const d of rule.byMonthDay ?? []) {
    if (lang === 'en') pieces.push(d === -1 ? 'the last day' : d < 0 ? `the ${enNth(-d)} day from the end` : `the ${enNth(d)}`);
    else pieces.push(d === -1 ? 'в последний день' : d < 0 ? `в ${-d}-й день с конца` : `${d} числа`);
  }
  for (const wd of rule.byDay ?? []) {
    const g = RU_DAY_GENDER[wd.day - 1]!;
    if (lang === 'en') pieces.push(wd.n !== undefined ? `the ${EN_ORD[wd.n] ?? wd.n} ${EN_DAYS[wd.day - 1]}` : `every ${EN_DAYS[wd.day - 1]}`);
    else if (wd.n !== undefined) pieces.push(`${wd.day === 2 ? 'во' : 'в'} ${RU_ORD[wd.n]?.[g] ?? wd.n} ${RU_DAY_ACC[wd.day - 1]}`);
    else pieces.push(`по ${RU_DAY_DAT_PL[wd.day - 1]}`);
  }
  if (!pieces.length) return '';
  return lang === 'en' ? `on ${joinList(pieces, 'and')}` : joinList(pieces, 'и');
}

function monthlyText(rule: Rule, lang: 'ru' | 'en'): string {
  const md = rule.byMonthDay ?? [];
  const bd = rule.byDay ?? [];
  if (rule.interval === 1) {
    // Короткие формы, которые понимает и строка быстрого ввода.
    if (md.length === 1 && !bd.length) {
      const d = md[0]!;
      if (d === -1) return lang === 'ru' ? 'каждый последний день месяца' : 'every last day of the month';
      if (d > 0) return lang === 'ru' ? `каждое ${d} число` : `every ${enNth(d)}`;
    }
    const wd = bd[0];
    if (bd.length === 1 && !md.length && wd?.n !== undefined) {
      const g = RU_DAY_GENDER[wd.day - 1]!;
      if (lang === 'en') return `every ${EN_ORD[wd.n] ?? wd.n} ${EN_DAYS[wd.day - 1]} of the month`;
      return `${EVERY_RU_G[g]} ${RU_ORD[wd.n]?.[g] ?? wd.n} ${RU_DAY_ACC[wd.day - 1]} месяца`;
    }
  }
  const base = rule.interval === 1 ? (lang === 'ru' ? 'каждый месяц' : 'every month') : everyN(rule.interval, 'month', lang);
  const days = monthDaysText(rule, lang);
  return days ? `${base}, ${days}` : base;
}

function yearlyText(rule: Rule, lang: 'ru' | 'en'): string {
  const months = rule.byMonth ?? [];
  const md = rule.byMonthDay ?? [];
  const base = rule.interval === 1 ? (lang === 'ru' ? 'каждый год' : 'every year') : everyN(rule.interval, 'year', lang);
  if (months.length === 1 && md.length === 1 && md[0]! > 0 && !rule.byDay?.length) {
    const m = months[0]!;
    const d = md[0]!;
    if (rule.interval === 1) return lang === 'ru' ? `каждое ${d} ${RU_MONTHS_GEN[m - 1]}` : `every ${EN_MONTHS[m - 1]} ${d}`;
    return lang === 'ru' ? `${base}, ${d} ${RU_MONTHS_GEN[m - 1]}` : `${base} on ${EN_MONTHS[m - 1]} ${d}`;
  }
  // Сложные годовые правила просто перечисляем частями через запятую.
  const extra: string[] = [];
  const days = monthDaysText(rule, lang);
  if (days) extra.push(days);
  if (months.length) {
    extra.push(lang === 'ru' ? `в ${joinList(months.map((m) => RU_MONTHS_GEN[m - 1]!), 'и')}` : `in ${joinList(months.map((m) => EN_MONTHS[m - 1]!), 'and')}`);
  }
  return extra.length ? `${base}, ${extra.join(', ')}` : base;
}

function untilText(date: string, lang: 'ru' | 'en'): string {
  const p = parts(date);
  return lang === 'ru' ? `до ${p.day} ${RU_MONTHS_GEN[p.month - 1]} ${p.year}` : `until ${EN_MONTHS[p.month - 1]} ${p.day}, ${p.year}`;
}

/**
 * Правило словами: «каждый понедельник и среду», «каждые 2 недели по пятницам до 31 декабря 2026».
 * Нужно, когда повтор задан не фразой, а кнопками: карточка задачи показывает текст повтора,
 * и он должен читаться как набранная пользователем фраза. Режим «от выполнения» карточка дописывает сама.
 */
export function describeRule(rule: Rule, lang: 'ru' | 'en'): string {
  let text: string;
  switch (rule.freq) {
    case 'DAILY':
      text = rule.interval === 1 ? (lang === 'ru' ? 'каждый день' : 'every day') : everyN(rule.interval, 'day', lang);
      break;
    case 'WEEKLY':
      text = weeklyText(rule, lang);
      break;
    case 'MONTHLY':
      text = monthlyText(rule, lang);
      break;
    case 'YEARLY':
      text = yearlyText(rule, lang);
      break;
  }
  return rule.until ? `${text} ${untilText(rule.until, lang)}` : text;
}

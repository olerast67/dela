/**
 * Разбор строки быстрого ввода на русском и английском.
 *
 * «позвонить маме завтра в 19 №Дом каждую неделю !1» →
 *   название «позвонить маме», срок, повтор, проект, приоритет.
 *
 * Каждый распознанный кусок возвращается токеном с позицией: интерфейс подсвечивает его,
 * а клик по подсветке передаёт участок в ignore, и он остаётся частью названия.
 */
import { addDays, addMonths, daysInMonth, isDate, isoWeekday, makeDate, parts, today as todayIn, wallClock, type DateSpec } from './dates.ts';
import type { Priority, Recurrence } from './model.ts';
import { firstOnOrAfter, formatRule, type Rule, type WeekdayNum } from './recurrence.ts';

export type TokenKind = 'date' | 'time' | 'recurrence' | 'deadline' | 'duration' | 'reminder' | 'priority' | 'project' | 'section' | 'label';

export interface Token {
  readonly kind: TokenKind;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface ParseContext {
  readonly now: number;
  readonly tz: string;
  readonly projects?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly sections?: ReadonlyArray<{ readonly id: string; readonly name: string; readonly projectId: string }>;
  readonly labels?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** Участки, которые не нужно разбирать. */
  readonly ignore?: ReadonlyArray<readonly [number, number]>;
  /** Распознавание выключено в настройках: весь текст — название, ни срока, ни проекта, ни подсветки. */
  readonly plain?: boolean;
}

export interface ParsedTask {
  readonly title: string;
  readonly due: DateSpec | null;
  readonly deadline: string | null;
  readonly duration: number | null;
  readonly recurrence: Recurrence | null;
  readonly priority: Priority | null;
  readonly projectId: string | null;
  /** Название проекта, которого ещё нет. */
  readonly newProject: string | null;
  readonly sectionId: string | null;
  readonly newSection: string | null;
  readonly labelIds: readonly string[];
  readonly newLabels: readonly string[];
  /** Минуты до срока из «напомни за час»; null, если в фразе о напоминаниях ничего нет, [] — «без напоминания». */
  readonly reminders: readonly number[] | null;
  readonly tokens: readonly Token[];
}

// ---------- словари ----------

const L = '[\\p{L}\\p{N}_]';
const B = `(?<!${L})`;
const E = `(?!${L})`;

const WD_RU =
  'понедельник(?:ам|а|у)?|вторник(?:ам|а|у)?|сред(?:ам|а|у|ы|е)|четверг(?:ам|а|у)?|пятниц(?:ам|а|у|ы|е)|суббот(?:ам|а|у|ы|е)|воскресень(?:ям|е|я|ю)|пн|вт|ср|чт|пт|сб|вс';
const WD_EN = 'mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|mon|tues?|wed|thur?s?|fri|sat|sun';
const WD = `${WD_RU}|${WD_EN}`;
/** Для дат без «every» английские сокращения не берём: «sun», «sat», «wed» слишком часто обычные слова. */
const WD_DATE = `${WD_RU}|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?`;
const WD_LIST = `(?:${WD})(?:\\s*(?:,|и|and|&)\\s*(?:${WD}))*`;

const MONTH_RU = 'январ[ья]|янв|феврал[ья]|фев|марта?|мар|апрел[ья]|апр|ма[йя]|июн[ья]|июн|июл[ья]|июл|августа?|авг|сентябр[ья]|сент?|октябр[ья]|окт|ноябр[ья]|нояб?|декабр[ья]|дек';
const MONTH_EN = 'january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept?|october|oct|november|nov|december|dec';
const MONTH = `${MONTH_RU}|${MONTH_EN}`;

const NUM_RU = 'одну|один|одного|два|две|двух|три|тр[её]х|четыре|четыр[её]х|пять|шесть|семь|восемь|девять|десять|полтора|полторы';
const NUM_EN = 'an?|one|two|three|four|five|six|seven|eight|nine|ten';
const NUM = `\\d{1,3}|${NUM_RU}|${NUM_EN}`;

function weekdayOf(word: string): number {
  const w = word.toLowerCase();
  const table: Array<[string[], number]> = [
    [['пн', 'понед', 'mon'], 1],
    [['вт', 'tue'], 2],
    [['ср', 'wed'], 3],
    [['чт', 'четв', 'thu'], 4],
    [['пт', 'пятн', 'fri'], 5],
    [['сб', 'суб', 'sat'], 6],
    [['вс', 'воскр', 'sun'], 7],
  ];
  for (const [prefixes, n] of table) if (prefixes.some((p) => w.startsWith(p))) return n;
  return 0;
}

function weekdaysOf(list: string): number[] {
  const re = new RegExp(`${B}(?:${WD})${E}`, 'giu');
  return [...new Set([...list.matchAll(re)].map((m) => weekdayOf(m[0])))].filter((d) => d > 0).sort((a, b) => a - b);
}

function monthOf(word: string): number {
  const w = word.toLowerCase();
  const ru = ['янв', 'фев', 'мар', 'апр', 'ма', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const en = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const i = en.findIndex((p) => w.startsWith(p));
  if (i >= 0) return i + 1;
  return ru.findIndex((p) => w.startsWith(p)) + 1;
}

function numOf(word: string | undefined): number {
  if (word === undefined || word === '') return 1;
  const w = word.toLowerCase();
  if (/^\d+$/.test(w)) return Number(w);
  const map: Record<string, number> = {
    одну: 1, один: 1, одного: 1, a: 1, an: 1, one: 1,
    два: 2, две: 2, двух: 2, two: 2,
    три: 3, трех: 3, трёх: 3, three: 3,
    четыре: 4, четырех: 4, четырёх: 4, four: 4,
    пять: 5, five: 5, шесть: 6, six: 6, семь: 7, seven: 7, восемь: 8, eight: 8,
    девять: 9, nine: 9, десять: 10, ten: 10,
    полтора: 1.5, полторы: 1.5,
  };
  return map[w] ?? 1;
}

function ordinalOf(word: string): number {
  const w = word.toLowerCase();
  if (/^(перв|1st|first)/.test(w)) return 1;
  if (/^(втор|2nd|second|other)/.test(w)) return 2;
  if (/^(трет|3rd|third)/.test(w)) return 3;
  if (/^(четв[её]рт|4th|fourth)/.test(w)) return 4;
  if (/^(последн|last)/.test(w)) return -1;
  return 0;
}

type Unit = 'day' | 'week' | 'month' | 'year' | 'hour' | 'minute';

function unitOf(word: string): Unit {
  const w = word.toLowerCase();
  if (/^(дн|ден|day)/.test(w)) return 'day';
  if (/^(недел|week)/.test(w)) return 'week';
  if (/^(месяц|month)/.test(w)) return 'month';
  if (/^(год|лет|year)/.test(w)) return 'year';
  if (/^(час|ч$|hour|hrs?$|h$)/.test(w)) return 'hour';
  return 'minute';
}

// ---------- даты ----------

interface DateForm {
  /** Регулярка с ^...$ и группами для разбора найденной фразы. */
  readonly re: RegExp;
  /** Тот же шаблон без групп для поиска в тексте. */
  readonly src: string;
  readonly resolve: (m: RegExpExecArray, today: string) => string | null;
}

function form(pattern: string, resolve: DateForm['resolve']): DateForm {
  return { re: new RegExp(`^(?:${pattern})$`, 'iu'), src: pattern.replace(/\((?!\?)/g, '(?:'), resolve };
}

function dayMonth(day: number, month: number, year: number | null, today: string): string | null {
  if (month < 1 || month > 12 || day < 1) return null;
  if (year !== null) {
    if (year < 100) year += 2000;
    return isDate(makeDate(year, month, day)) ? makeDate(year, month, day) : null;
  }
  const y = parts(today).year;
  for (const candidate of [y, y + 1]) {
    if (day > daysInMonth(candidate, month)) continue;
    const d = makeDate(candidate, month, day);
    if (d >= today) return d;
  }
  return null;
}

function nextWeekday(today: string, wd: number, nextWeek: boolean): string {
  if (nextWeek) {
    const monday = addDays(today, 8 - isoWeekday(today));
    return addDays(monday, wd - 1);
  }
  const delta = (wd - isoWeekday(today) + 7) % 7 || 7;
  return addDays(today, delta);
}

function shift(today: string, n: number, unit: Unit): string {
  switch (unit) {
    case 'day':
      return addDays(today, Math.round(n));
    case 'week':
      return addDays(today, Math.round(n * 7));
    case 'month':
      return n % 1 ? addDays(addMonths(today, Math.floor(n)), 15) : addMonths(today, n);
    case 'year':
      return addMonths(today, Math.round(n * 12));
    default:
      return today;
  }
}

const DATE_FORMS: readonly DateForm[] = [
  form('(\\d{4})-(\\d{2})-(\\d{2})', (m) => (isDate(`${m[1]}-${m[2]}-${m[3]}`) ? `${m[1]}-${m[2]}-${m[3]}` : null)),
  form('(\\d{1,2})[./](\\d{1,2})(?:[./](\\d{4}|\\d{2}))?', (m, t) => dayMonth(+m[1]!, +m[2]!, m[3] ? +m[3] : null, t)),
  form(`(\\d{1,2})(?:-?го|-?е|st|nd|rd|th)?\\s+(${MONTH})(?:\\s+(\\d{4}))?`, (m, t) =>
    dayMonth(+m[1]!, monthOf(m[2]!), m[3] ? +m[3] : null, t),
  ),
  form(`(${MONTH_EN})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, (m, t) =>
    dayMonth(+m[2]!, monthOf(m[1]!), m[3] ? +m[3] : null, t),
  ),
  form('послезавтра|day after tomorrow', (_m, t) => addDays(t, 2)),
  form('сегодня|today', (_m, t) => t),
  form('завтра|tomorrow|tmrw', (_m, t) => addDays(t, 1)),
  form('позавчера', (_m, t) => addDays(t, -2)),
  form('вчера|yesterday', (_m, t) => addDays(t, -1)),
  form(`(?:через|in)\\s+(?:(${NUM})\\s+)?(дн(?:я|ей)|день|недел[юиь]|месяц(?:а|ев)?|год(?:а)?|лет|days?|weeks?|months?|years?)`, (m, t) =>
    shift(t, numOf(m[1]), unitOf(m[2]!)),
  ),
  form('(?:на\\s+)?следующей\\s+неделе|next\\s+week', (_m, t) => nextWeekday(t, 1, false)),
  form('(?:в\\s+)?следующем\\s+месяце|next\\s+month', (_m, t) => {
    const n = addMonths(t, 1);
    return makeDate(parts(n).year, parts(n).month, 1);
  }),
  form('(?:в\\s+)?конце\\s+месяца|end\\s+of\\s+(?:the\\s+)?month', (_m, t) => {
    const p = parts(t);
    return makeDate(p.year, p.month, daysInMonth(p.year, p.month));
  }),
  form('(?:в\\s+)?конце\\s+недели|end\\s+of\\s+(?:the\\s+)?week', (_m, t) =>
    isoWeekday(t) <= 5 ? addDays(t, 5 - isoWeekday(t)) : nextWeekday(t, 5, false),
  ),
  form('(?:на|в)\\s+выходн(?:ых|ые)|(?:this\\s+)?weekend', (_m, t) => (isoWeekday(t) >= 6 ? t : addDays(t, 6 - isoWeekday(t)))),
  form(`(?:(следующ(?:ий|ую|ее|ей)|next)\\s+)?(${WD_DATE})`, (m, t) => nextWeekday(t, weekdayOf(m[2]!), Boolean(m[1]))),
];

const DATE_PHRASE = DATE_FORMS.map((f) => `(?:${f.src})`).join('|');

export function resolveDate(phrase: string, today: string): string | null {
  const text = phrase.trim().replace(/\s+/g, ' ');
  for (const f of DATE_FORMS) {
    const m = f.re.exec(text);
    if (m) return f.resolve(m, today);
  }
  return null;
}

// ---------- сканер ----------

class Scanner {
  readonly tokens: Token[] = [];
  readonly text: string;
  private readonly used: boolean[];

  constructor(text: string, ignore: ReadonlyArray<readonly [number, number]>) {
    this.text = text;
    this.used = new Array<boolean>(text.length).fill(false);
    for (const [s, e] of ignore) for (let i = Math.max(0, s); i < Math.min(e, text.length); i++) this.used[i] = true;
  }

  free(start: number, end: number): boolean {
    for (let i = start; i < end; i++) if (this.used[i]) return false;
    return true;
  }

  take(kind: TokenKind, start: number, end: number): void {
    for (let i = start; i < end; i++) this.used[i] = true;
    this.tokens.push({ kind, start, end, text: this.text.slice(start, end) });
  }

  /** Первое свободное совпадение, которое принял handler. */
  find(pattern: string, kind: TokenKind, handler: (m: RegExpMatchArray) => boolean): boolean {
    const re = new RegExp(`${B}(?:${pattern})${E}`, 'giu');
    for (const m of this.text.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (!this.free(start, end)) continue;
      if (handler(m)) {
        this.take(kind, start, end);
        return true;
      }
    }
    return false;
  }

  /** Остаток текста без распознанных кусков. */
  rest(): string {
    let out = '';
    for (let i = 0; i < this.text.length; i++) out += this.usedByToken(i) ? ' ' : this.text[i];
    return out.replace(/\s+/g, ' ').trim();
  }

  private usedByToken(i: number): boolean {
    return this.tokens.some((t) => i >= t.start && i < t.end);
  }
}

// ---------- повторы ----------

interface RecurrenceDraft {
  freq: Rule['freq'];
  interval: number;
  byDay?: WeekdayNum[];
  byMonthDay?: number[];
  byMonth?: number[];
}

interface RecurrenceForm {
  readonly pattern: string;
  readonly make: (m: RegExpMatchArray) => RecurrenceDraft | null;
}

const EVERY_RU = '(?:каждый|каждую|каждое|каждые)';
const EVERY_EN = 'every!?';

const RECURRENCE_FORMS: readonly RecurrenceForm[] = [
  { pattern: `ежедневно|${EVERY_RU}\\s+день|every!?\\s*day|daily|everyday`, make: () => ({ freq: 'DAILY', interval: 1 }) },
  {
    pattern: `(?:по\\s+будням|в\\s+будни|${EVERY_RU}\\s+будний\\s+день|${EVERY_EN}\\s*weekday|weekdays)`,
    make: () => ({ freq: 'WEEKLY', interval: 1, byDay: [1, 2, 3, 4, 5].map((day) => ({ day })) }),
  },
  {
    pattern: `(?:по\\s+выходным|${EVERY_RU}\\s+выходн(?:ые|ой)|${EVERY_EN}\\s*weekend|weekends)`,
    make: () => ({ freq: 'WEEKLY', interval: 1, byDay: [{ day: 6 }, { day: 7 }] }),
  },
  {
    pattern: `${EVERY_RU}!?\\s+(${NUM})\\s+(дн(?:я|ей)|день|недел[иь]|месяц(?:а|ев)|год(?:а)?|лет)|${EVERY_EN}\\s*(\\d{1,3}|other|two|three|four|five|six)\\s+(days?|weeks?|months?|years?)`,
    make: (m) => {
      const n = m[1] ? numOf(m[1]) : m[3] === 'other' ? 2 : numOf(m[3]);
      const unit = unitOf((m[2] ?? m[4])!);
      const freq = ({ day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' } as const)[unit as 'day'];
      return freq && Number.isInteger(n) && n >= 1 ? { freq, interval: n } : null;
    },
  },
  {
    pattern: `(?:еженедельно|${EVERY_RU}\\s+неделю|${EVERY_EN}\\s*week|weekly)`,
    make: () => ({ freq: 'WEEKLY', interval: 1 }),
  },
  {
    pattern: `(?:ежемесячно|${EVERY_RU}\\s+месяц|${EVERY_EN}\\s*month|monthly)`,
    make: () => ({ freq: 'MONTHLY', interval: 1 }),
  },
  {
    pattern: `(?:ежегодно|${EVERY_RU}\\s+год|${EVERY_EN}\\s*year|yearly|annually)`,
    make: () => ({ freq: 'YEARLY', interval: 1 }),
  },
  {
    // каждый последний день месяца
    pattern: `${EVERY_RU}\\s+последний\\s+день(?:\\s+месяца)?|${EVERY_EN}\\s*last\\s+day(?:\\s+of\\s+(?:the\\s+)?month)?`,
    make: () => ({ freq: 'MONTHLY', interval: 1, byMonthDay: [-1] }),
  },
  {
    // каждое 15 число / every 15th
    pattern: `${EVERY_RU}\\s+(\\d{1,2})(?:-?е|-?го)?\\s+числ[оа]|(\\d{1,2})(?:-?го)?\\s+числа\\s+каждого\\s+месяца|${EVERY_EN}\\s*(\\d{1,2})(?:st|nd|rd|th)(?:\\s+of\\s+(?:the\\s+)?month)?`,
    make: (m) => {
      const d = Number(m[1] ?? m[2] ?? m[3]);
      return d >= 1 && d <= 31 ? { freq: 'MONTHLY', interval: 1, byMonthDay: [d] } : null;
    },
  },
  {
    // каждое 15 ноября / every Nov 15
    pattern: `${EVERY_RU}\\s+(\\d{1,2})(?:-?е|-?го)?\\s+(${MONTH})|${EVERY_EN}\\s*(${MONTH_EN})\\s+(\\d{1,2})(?:st|nd|rd|th)?|${EVERY_EN}\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_EN})`,
    make: (m) => {
      const day = Number(m[1] ?? m[4] ?? m[5]);
      const month = monthOf((m[2] ?? m[3] ?? m[6])!);
      return day >= 1 && day <= 31 && month > 0 ? { freq: 'YEARLY', interval: 1, byMonth: [month], byMonthDay: [day] } : null;
    },
  },
  {
    // каждый второй вторник (месяца) / every 2nd tuesday (of the month) / каждую последнюю пятницу
    pattern: `${EVERY_RU}\\s+(перв(?:ый|ую|ое)|втор(?:ой|ую|ое)|трет(?:ий|ью|ье)|четв[её]рт(?:ый|ую|ое)|последн(?:ий|юю|ее))\\s+(${WD})(\\s+месяца)?|${EVERY_EN}\\s*(1st|first|2nd|second|3rd|third|4th|fourth|last|other)\\s+(${WD_EN})(\\s+of\\s+(?:the\\s+)?month)?`,
    make: (m) => {
      const ord = ordinalOf((m[1] ?? m[4])!);
      const day = weekdayOf((m[2] ?? m[5])!);
      if (!day || !ord) return null;
      // По-русски «каждый второй вторник» — раз в две недели, «…вторник месяца» — второй вторник месяца.
      // По-английски «every other tuesday» — раз в две недели, «every 2nd tuesday» — второй вторник месяца.
      const monthly = m[1] !== undefined ? Boolean(m[3]) || ord === -1 : m[4]!.toLowerCase() !== 'other';
      if (!monthly) return { freq: 'WEEKLY', interval: ord, byDay: [{ day }] };
      return { freq: 'MONTHLY', interval: 1, byDay: [{ day, n: ord }] };
    },
  },
  {
    // каждый понедельник и пятницу / по понедельникам / every mon, fri
    pattern: `${EVERY_RU}\\s+(${WD_LIST})|по\\s+(${WD_LIST})|${EVERY_EN}\\s*(${WD_LIST})`,
    make: (m) => {
      const days = weekdaysOf((m[1] ?? m[2] ?? m[3])!);
      return days.length ? { freq: 'WEEKLY', interval: 1, byDay: days.map((day) => ({ day })) } : null;
    },
  },
];

// ---------- разбор ----------

function nameAt(text: string, from: number, names: ReadonlyArray<{ id: string; name: string }>): { id: string | null; name: string; end: number } | null {
  const lower = text.toLocaleLowerCase('ru');
  let best: { id: string; name: string; end: number } | null = null;
  for (const item of names) {
    const n = item.name.toLocaleLowerCase('ru');
    if (!n || !lower.startsWith(n, from)) continue;
    const end = from + n.length;
    if (end < text.length && /[\p{L}\p{N}_]/u.test(text[end]!)) continue;
    if (!best || end > best.end) best = { id: item.id, name: item.name, end };
  }
  if (best) return best;
  const m = /^[^\s#№@/{}]+/u.exec(text.slice(from));
  return m ? { id: null, name: m[0].replace(/[.,;:!?]+$/u, ''), end: from + m[0].replace(/[.,;:!?]+$/u, '').length } : null;
}

function clampTime(h: number, mi: number): string | null {
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function dayPart(h: number, part: string | undefined): number | null {
  if (!part) return h;
  const p = part.toLowerCase().replace(/\./g, '');
  if (h < 1 || h > 12) return null;
  if (p === 'утра' || p === 'am') return h === 12 ? 0 : h;
  // «в 11 ночи» — 23:00, «в 2 ночи» — 02:00.
  if (p === 'ночи') return h === 12 ? 0 : h < 6 ? h : h >= 9 ? h + 12 : null;
  if (p === 'дня') return h === 12 ? 12 : h < 6 ? h + 12 : null;
  if (p === 'вечера' || p === 'pm') return h === 12 ? 12 : h + 12;
  return h;
}

// ---------- время словами (голосовой ввод) ----------

const WORD_NUM: Record<string, number> = {
  ноль: 0, час: 1, один: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9,
  десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16,
  семнадцать: 17, восемнадцать: 18, девятнадцать: 19, двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50,
  первого: 1, второго: 2, третьего: 3, четвертого: 4, четвёртого: 4, пятого: 5, шестого: 6, седьмого: 7, восьмого: 8,
  девятого: 9, десятого: 10, одиннадцатого: 11, двенадцатого: 12,
  zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};

/** «двадцать три» → 23, «ноль пять» → 5, «forty-five» → 45. */
function wordNum(phrase: string): number {
  return phrase
    .toLowerCase()
    .split(/[\s-]+/u)
    .reduce((sum, w) => sum + (WORD_NUM[w] ?? NaN), 0);
}

const ONES_RU = 'один|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять';
const TEENS_RU = 'десять|одиннадцать|двенадцать|тринадцать|четырнадцать|пятнадцать|шестнадцать|семнадцать|восемнадцать|девятнадцать';
// «один» в часах не берём: «в один клик», «в один день».
const HOUR_RU = `двадцать\\s+(?:один|два|три)|двадцать|${TEENS_RU}|два|три|четыре|пять|шесть|семь|восемь|девять|час`;
const MIN_RU = `ноль\\s+(?:ноль|${ONES_RU})|(?:двадцать|тридцать|сорок|пятьдесят)(?:\\s+(?:${ONES_RU}))?|${TEENS_RU}`;
const ORD_RU = 'первого|второго|третьего|четв[её]ртого|пятого|шестого|седьмого|восьмого|девятого|десятого|одиннадцатого|двенадцатого';
// После числа — не время: «в два раза», «в пять минут», «в десять яиц».
const NOT_TIME_RU =
  'раз|рубл|минут|секунд|дн|ден|сут|недел|месяц|год|лет|кило|кг|грамм|литр|метр|штук|человек|процент|этаж|класс|урок|ряд|строк|слов|част|подход|при[её]м|шаг|сч[её]т|экземпляр|копи|раунд|круг|лист|страниц|глав|яиц|яйц|бутыл|банк|пачк';

/** «в десять», «в семь вечера», «в два часа дня», «в десять тридцать», «в половине восьмого», «в полночь». */
function ruWordTime(prefix: string): string {
  return (
    `${prefix}\\s+(?:(?<h>${HOUR_RU})(?:\\s+час(?:а|ов)?)?(?:\\s+(?<mi>${MIN_RU})(?:\\s+минут[аы]?)?)?` +
    `|пол(?:овине\\s+|\\s*)(?<halfNext>${ORD_RU})|четверть\\s+(?<quarterNext>${ORD_RU})|(?<noon>полдень|полночь))` +
    `(?:\\s+(?<part>утра|дня|вечера|ночи))?(?!\\s+(?:${NOT_TIME_RU}))`
  );
}

const ONES_EN = 'one|two|three|four|five|six|seven|eight|nine';
const HOUR_EN = `${ONES_EN}|ten|eleven|twelve`;
const MIN_EN = `(?:oh|o)\\s+(?:${ONES_EN})|(?:twenty|thirty|forty|fifty)(?:[-\\s](?:${ONES_EN}))?|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen`;
const NOT_TIME_EN = 'of|point|times?|least|once|another|percent|degrees|years?|months?|weeks?|days?|hours?|minutes?|people|dollars?|euros?';

/** «at ten», «at seven thirty pm», «at half past seven», «at nine o'clock», «at noon». */
function enWordTime(prefix: string): string {
  return (
    `${prefix}\\s+(?:(?<h>${HOUR_EN})(?:\\s+(?<mi>${MIN_EN}))?(?:\\s+o['’]?\\s?clock)?|half\\s+past\\s+(?<half>${HOUR_EN})` +
    `|(?:a\\s+)?quarter\\s+past\\s+(?<quarter>${HOUR_EN})|(?:a\\s+)?quarter\\s+to\\s+(?<quarterTo>${HOUR_EN})|(?<noon>noon|midnight))` +
    `(?:\\s*(?<part>am|pm|a\\.m\\.|p\\.m\\.)|\\s+(?<partEn>in\\s+the\\s+(?:morning|afternoon|evening)|at\\s+night))?(?!\\s+(?:${NOT_TIME_EN})${E})`
  );
}

/** Время из совпадения ruWordTime/enWordTime; null — не время. */
function wordTime(g: Record<string, string | undefined>): string | null {
  if (g.noon) return /полдень|noon/iu.test(g.noon) ? '12:00' : '00:00';
  let h: number;
  let mi = 0;
  if (g.h) {
    h = wordNum(g.h);
    if (g.mi) mi = wordNum(g.mi);
    // «в час» без уточнения — днём: так говорят про обед, а не про ночь.
    if (/^час$/iu.test(g.h) && !g.part && !g.mi) return '13:00';
  } else if (g.half || g.quarter) {
    h = wordNum((g.half ?? g.quarter)!);
    mi = g.half ? 30 : 15;
  } else if (g.quarterTo) {
    h = (wordNum(g.quarterTo) + 10) % 12 + 1;
    mi = 45;
  } else {
    // «половина восьмого» — 7:30, «половина первого» — 12:30.
    h = (wordNum((g.halfNext ?? g.quarterNext)!) + 10) % 12 + 1;
    mi = g.halfNext ? 30 : 15;
  }
  let part = g.part;
  if (g.partEn) {
    const p = g.partEn.toLowerCase();
    // «eleven at night» — 23:00, «two at night» — 02:00.
    part = /morning/.test(p) ? 'am' : /night/.test(p) ? 'ночи' : 'pm';
  }
  const hour = dayPart(h, part);
  return hour === null || Number.isNaN(mi) ? null : clampTime(hour, mi);
}

/** Фраза без распознанных кусков: всё — название, пробелы схлопнуты, как в обычном разборе. */
export function plainTask(text: string): ParsedTask {
  return {
    title: text.replace(/\s+/g, ' ').trim(),
    due: null,
    deadline: null,
    duration: null,
    recurrence: null,
    priority: null,
    projectId: null,
    newProject: null,
    sectionId: null,
    newSection: null,
    labelIds: [],
    newLabels: [],
    reminders: null,
    tokens: [],
  };
}

export function parseTask(text: string, ctx: ParseContext): ParsedTask {
  if (ctx.plain) return plainTask(text);
  const sc =new Scanner(text, ctx.ignore ?? []);
  const today = todayIn(ctx.tz, ctx.now);
  let date: string | null = null;
  let time: string | null = null;
  let tz: string | undefined;
  let duration: number | null = null;
  let deadline: string | null = null;
  let priority: Priority | null = null;
  let draft: RecurrenceDraft | null = null;
  let recurrenceText = '';
  let completionMode = false;
  let seriesStart: string | null = null;
  let until: string | null = null;

  // Повторы раньше дат: «каждый понедельник» не должен стать просто датой.
  for (const f of RECURRENCE_FORMS) {
    const found = sc.find(f.pattern, 'recurrence', (m) => {
      const d = f.make(m);
      if (!d) return false;
      draft = d;
      recurrenceText = m[0];
      if (/^every!|^кажд\S*!/iu.test(m[0])) completionMode = true;
      return true;
    });
    if (found) break;
  }
  if (draft) {
    sc.find('после\\s+выполнения|от\\s+(?:даты\\s+)?выполнения|after\\s+completion', 'recurrence', (m) => {
      completionMode = true;
      recurrenceText += ` ${m[0]}`;
      return true;
    });
    sc.find(`(?:начиная\\s+)?с\\s+(${DATE_PHRASE})|starting\\s+(?:on\\s+|from\\s+)?(${DATE_PHRASE})`, 'recurrence', (m) => {
      seriesStart = resolveDate((m[1] ?? m[2])!, today);
      if (seriesStart) recurrenceText += ` ${m[0]}`;
      return seriesStart !== null;
    });
    sc.find(`(?:до|по|until)\\s+(${DATE_PHRASE})`, 'recurrence', (m) => {
      until = resolveDate(m[1]!, today);
      if (until) recurrenceText += ` ${m[0]}`;
      return until !== null;
    });
  }

  // Дедлайн: {пятница} или «дедлайн 15 ноября».
  sc.find(`\\{\\s*(${DATE_PHRASE})\\s*\\}|(?:дедлайн|крайний\\s+срок|deadline)\\s+(${DATE_PHRASE})`, 'deadline', (m) => {
    deadline = resolveDate((m[1] ?? m[2])!, today);
    return deadline !== null;
  });

  // Напоминания раньше времени: иначе «в 9» из «напомни в 9» стало бы временем задачи.
  let reminders: number[] | null = null;
  let remindAt: string | null = null;
  const REM_UNIT = `(полчаса|half\\s+an\\s+hour)|(?:(${NUM})\\s*)?(минут[уы]?|мин|час(?:а|ов)?|ч|день|дня|дней|сутки|недел[юи]|minutes?|mins?|hours?|h|days?|weeks?)`;
  const offsetOf = (m: RegExpMatchArray, at: number): number => {
    if (m[at]) return 30;
    const unit = unitOf(m[at + 2]!);
    const per = unit === 'week' ? 7 * 1440 : unit === 'day' || /^сутки$/iu.test(m[at + 2]!) ? 1440 : unit === 'hour' ? 60 : 1;
    return Math.round(numOf(m[at + 1]) * per);
  };
  const addOffset = (mins: number) => {
    if (mins >= 0 && mins <= 30 * 1440 && !reminders?.includes(mins)) reminders = [...(reminders ?? []), mins];
  };
  const firstOffset =
    sc.find(`(?:напомн(?:и|ить|ите)|напоминание)\\s+за\\s+(?:${REM_UNIT})`, 'reminder', (m) => {
      addOffset(offsetOf(m, 1));
      return true;
    }) ||
    sc.find(`remind(?:\\s+me)?\\s+(?:${REM_UNIT})\\s+(?:before|early)`, 'reminder', (m) => {
      addOffset(offsetOf(m, 1));
      return true;
    });
  // «напомни за час и за 10 минут»: следующие смещения после первого.
  for (let i = 0; firstOffset && i < 3; i++) {
    const more = sc.find(`(?:,|и|and)\\s*(?:за\\s+)?(?:${REM_UNIT})(?:\\s+before)?`, 'reminder', (m) => {
      addOffset(offsetOf(m, 1));
      return true;
    });
    if (!more) break;
  }
  sc.find(
    `(?:напомн(?:и|ить|ите)|напоминание)\\s+(?:в|во)\\s+(\\d{1,2})(?:[:.](\\d{2}))?(?:\\s*(утра|дня|вечера|ночи))?|remind(?:\\s+me)?\\s+at\\s+(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?`,
    'reminder',
    (m) => {
      const hour = dayPart(Number(m[1] ?? m[4]), m[3] ?? m[6]);
      const t = hour === null ? null : clampTime(hour, Number(m[2] ?? m[5] ?? 0));
      if (!t) return false;
      remindAt = t;
      return true;
    },
  );
  // То же словами: «напомни в девять», «remind me at seven pm».
  for (const p of [ruWordTime('(?:напомн(?:и|ить|ите)|напоминание)\\s+(?:в|во)'), enWordTime('remind(?:\\s+me)?\\s+at')]) {
    if ((remindAt as string | null) !== null) break;
    sc.find(p, 'reminder', (m) => {
      remindAt = wordTime(m.groups ?? {});
      return remindAt !== null;
    });
  }
  sc.find('без\\s+напоминани[йяе]|no\\s+reminders?', 'reminder', () => {
    reminders = [];
    return true;
  });

  // Дата ISO раньше интервала времени: иначе «2026-11-15» прочиталось бы как «11-15».
  sc.find('\\d{4}-\\d{2}-\\d{2}', 'date', (m) => {
    date = resolveDate(m[0], today);
    return date !== null;
  });

  // Интервал времени: «с 9 до 10:30», «9-10», «from 9 to 10».
  const T = '(\\d{1,2})(?:[:.](\\d{2}))?';
  sc.find(`(?:(?:с|в|во|from|at)\\s+)?${T}\\s*(?:-|–|—|до|to)\\s*${T}(?:\\s*(am|pm))?`, 'time', (m) => {
    if (m[0].includes('-') && !m[2] && !m[4] && !/^(с|в|во|from|at)\s/iu.test(m[0])) {
      // «9-10» без минут допустимо только как время в разумных пределах.
      if (+m[1]! > 23 || +m[3]! > 24) return false;
    }
    const pm = m[5]?.toLowerCase() === 'pm';
    const h1 = pm && +m[1]! < 12 ? +m[1]! + 12 : +m[1]!;
    const h2 = pm && +m[3]! < 12 ? +m[3]! + 12 : +m[3]!;
    const start = clampTime(h1, +(m[2] ?? 0));
    const end = clampTime(h2 === 24 ? 0 : h2, +(m[4] ?? 0));
    if (!start || !end) return false;
    let mins = (h2 * 60 + +(m[4] ?? 0)) - (h1 * 60 + +(m[2] ?? 0));
    if (mins <= 0) mins += 24 * 60;
    if (mins > 16 * 60) return false;
    time = start;
    duration = mins;
    return true;
  });

  // Время с предлогом: «в 9», «в 9:30», «к 18», «в 7 вечера», «at 9pm».
  if (!time) {
    sc.find(
      `(?:в|во|к|около|at)\\s+(\\d{1,2})(?:[:.](\\d{2}))?(?:\\s*(?:ч|час(?:а|ов)?))?(?:\\s*(утра|дня|вечера|ночи|am|pm|a\\.m\\.|p\\.m\\.))?|(\\d{1,2})(?::(\\d{2}))?\\s*(утра|вечера|ночи|am|pm)|(\\d{1,2}):(\\d{2})`,
      'time',
      (m) => {
        const h = Number(m[1] ?? m[4] ?? m[7]);
        const mi = Number(m[2] ?? m[5] ?? m[8] ?? 0);
        const hour = dayPart(h, m[3] ?? m[6]);
        if (hour === null) return false;
        const t = clampTime(hour, mi);
        if (!t) return false;
        time = t;
        return true;
      },
    );
  }
  // Время словами — так его выдаёт распознавание речи: «в десять утра», «at seven pm».
  for (const p of [ruWordTime('(?:в|во)'), enWordTime('at')]) {
    if ((time as string | null) !== null) break;
    sc.find(p, 'time', (m) => {
      time = wordTime(m.groups ?? {});
      return time !== null;
    });
  }
  if (!time) {
    sc.find('утром|in\\s+the\\s+morning|morning|в\\s+полдень|днём|днем|noon|midday|вечером|in\\s+the\\s+evening|evening|tonight', 'time', (m) => {
      const w = m[0].toLowerCase();
      if (/утр|morning/.test(w)) time = '09:00';
      else if (/полдень|noon|midday/.test(w)) time = '12:00';
      else if (/дн[её]м/.test(w)) time = '13:00';
      else if (/tonight/.test(w)) {
        time = '20:00';
        date ??= today;
      } else time = '19:00';
      return true;
    });
  }

  // Относительное время: «через 2 часа», «через полчаса», «in 30 min».
  sc.find(`(?:через|in)\\s+(?:(полчаса)|(?:(${NUM})\\s+)?(час(?:а|ов)?|минут[уы]?|мин|hours?|minutes?|mins?))`, 'time', (m) => {
    const minutes = m[1] ? 30 : numOf(m[2]) * (unitOf(m[3]!) === 'hour' ? 60 : 1);
    const at = wallClock(ctx.now + minutes * 60_000, ctx.tz);
    date = at.date;
    time = at.time;
    return true;
  });

  // Пояс: «по Москве», «МСК».
  sc.find('по\\s+москве|мск|msk|utc', 'time', (m) => {
    tz = /utc/i.test(m[0]) ? 'UTC' : 'Europe/Moscow';
    return true;
  });

  // Дата.
  if (!date) {
    sc.find(`(?:(?:на|к|до|в|во|on|by)\\s+)?(${DATE_PHRASE})`, 'date', (m) => {
      date = resolveDate(m[1]!, today);
      return date !== null;
    });
  }

  // Длительность: «на 30 минут», «на полтора часа», «for 2h».
  sc.find(
    `на\\s+(полчаса)|на\\s+(час)|на\\s+(полтора)\\s+часа|(?:на|for)\\s+(\\d+(?:[.,]\\d+)?)\\s*(минут[уы]?|мин|м|час(?:а|ов)?|ч|minutes?|mins?|m|hours?|hrs?|h)|for\\s+(an?|half\\s+an?)\\s+hour`,
    'duration',
    (m) => {
      let mins: number;
      if (m[1]) mins = 30;
      else if (m[2]) mins = 60;
      else if (m[3]) mins = 90;
      else if (m[4]) mins = Number(m[4].replace(',', '.')) * (unitOf(m[5]!) === 'hour' ? 60 : 1);
      else mins = /half/i.test(m[6]!) ? 30 : 60;
      mins = Math.round(mins);
      if (mins <= 0 || mins > 24 * 60) return false;
      duration = mins;
      return true;
    },
  );

  // Приоритет: p1, п1, !1, !!!, !!
  for (const m of text.matchAll(/(?<!\S)(?:[pPпП]([1-4])|!([1-4])|(!!!|!!))(?!\S)/gu)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (!sc.free(start, end)) continue;
    priority = (m[1] ? +m[1] : m[2] ? +m[2] : m[3] === '!!!' ? 1 : 2) as Priority;
    sc.take('priority', start, end);
    break;
  }

  // Проект: #Название или №Название; раздел: /Название; метки: @метка.
  let projectId: string | null = null;
  let newProject: string | null = null;
  let sectionId: string | null = null;
  let newSection: string | null = null;
  const labelIds: string[] = [];
  const newLabels: string[] = [];
  const marker = /(?<!\S)([#№@/])/gu;
  for (const m of text.matchAll(marker)) {
    const at = m.index!;
    if (!sc.free(at, at + 1)) continue;
    const sigil = m[1]!;
    if (sigil === '#' || sigil === '№') {
      if (projectId || newProject) continue;
      const hit = nameAt(text, at + 1, ctx.projects ?? []);
      if (!hit || !hit.name || !sc.free(at, hit.end)) continue;
      if (hit.id) projectId = hit.id;
      else newProject = hit.name;
      sc.take('project', at, hit.end);
    } else if (sigil === '/') {
      if (sectionId || newSection) continue;
      const pool = (ctx.sections ?? []).filter((s) => projectId === null || s.projectId === projectId);
      const hit = nameAt(text, at + 1, pool);
      if (!hit || !hit.name || !sc.free(at, hit.end)) continue;
      if (hit.id) sectionId = hit.id;
      else newSection = hit.name;
      sc.take('section', at, hit.end);
    } else {
      const hit = nameAt(text, at + 1, ctx.labels ?? []);
      if (!hit || !hit.name || !sc.free(at, hit.end)) continue;
      if (hit.id) {
        if (!labelIds.includes(hit.id)) labelIds.push(hit.id);
      } else if (!newLabels.includes(hit.name)) newLabels.push(hit.name);
      sc.take('label', at, hit.end);
    }
  }

  // «напомни в 9»: у задачи со временем это смещение до срока, задача без времени получает это время.
  const at = remindAt as string | null;
  if (at) {
    const tm = time as string | null;
    if (!tm) {
      time = at;
      addOffset(0);
    } else {
      const [th, tmin] = tm.split(':').map(Number) as [number, number];
      const [ah, amin] = at.split(':').map(Number) as [number, number];
      let off = th * 60 + tmin - (ah * 60 + amin);
      if (off < 0) off += 1440;
      addOffset(off);
    }
  }

  // Срок и повтор.
  let due: DateSpec | null = null;
  let recurrence: Recurrence | null = null;
  const d = draft as RecurrenceDraft | null;
  if (d) {
    const anchor: string = seriesStart ?? date ?? today;
    const rule: { -readonly [K in keyof Rule]: Rule[K] } = { freq: d.freq, interval: d.interval };
    if (d.byDay) rule.byDay = d.byDay;
    if (d.byMonthDay) rule.byMonthDay = d.byMonthDay;
    if (d.byMonth) rule.byMonth = d.byMonth;
    // Явные поля, чтобы серия не «дрейфовала» после коротких месяцев.
    if (rule.freq === 'WEEKLY' && !rule.byDay) rule.byDay = [{ day: isoWeekday(anchor) }];
    if (rule.freq === 'MONTHLY' && !rule.byDay && !rule.byMonthDay) rule.byMonthDay = [parts(anchor).day];
    if (rule.freq === 'YEARLY' && !rule.byMonthDay && !rule.byDay) {
      rule.byMonth = [parts(anchor).month];
      rule.byMonthDay = [parts(anchor).day];
    }
    if (until) rule.until = until;
    // Повтор со временем без явной даты: если время сегодня уже прошло, первый срок ищется с завтрашнего дня,
    // как у задачи без повтора. Иначе «по будням в 10», набранное в 12:00, сразу оказалось бы просроченным.
    let from = anchor;
    const startTime = time as string | null;
    if (!seriesStart && !date && startTime && startTime <= wallClock(ctx.now, tz ?? ctx.tz).time) from = addDays(today, 1);
    const first = firstOnOrAfter(rule, anchor, from);
    if (first) {
      due = { date: first, ...(time ? { time } : {}), ...(tz && time ? { tz } : {}) };
      recurrence = { rule: formatRule(rule), mode: completionMode ? 'completion' : 'schedule', text: recurrenceText.trim().replace(/\s+/g, ' ') };
    }
  } else {
    // Переменные заполняются внутри обработчиков, поэтому TypeScript не видит их значения: фиксируем типы явно.
    const dt = date as string | null;
    const tm = time as string | null;
    if (dt || tm) {
      let dd: string = dt ?? today;
      if (!dt && tm) {
        // Только время: сегодня, а если оно уже прошло — завтра.
        const nowClock = wallClock(ctx.now, tz ?? ctx.tz);
        if (tm <= nowClock.time) dd = addDays(today, 1);
      }
      due = { date: dd, ...(tm ? { time: tm } : {}), ...(tz && tm ? { tz } : {}) };
    }
  }

  const tokens = [...sc.tokens].sort((a, b) => a.start - b.start);
  return {
    title: sc.rest(),
    due,
    deadline,
    duration,
    recurrence,
    priority,
    projectId,
    newProject,
    sectionId,
    newSection,
    labelIds,
    newLabels,
    reminders: reminders as number[] | null,
    tokens,
  };
}

/** Строка вставленного списка: текст без маркера и уровень вложенности (0 или 1). */
export interface ListLine {
  readonly text: string;
  readonly depth: 0 | 1;
}

/**
 * Вставленный текст из нескольких строк как список задач: маркеры «-», «*», «•», «1.» и «[ ]» убираются,
 * отмеченные «[x]» пропускаются, строка с отступом под другой строкой становится подзадачей.
 * null, если непустая строка одна: тогда это обычная фраза.
 */
export function splitTaskList(text: string): ListLine[] | null {
  const out: ListLine[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim());
  const indentOf = (l: string) => /^[ \t]*/.exec(l)![0].replace(/\t/g, '    ').length;
  // Отступ считается от самой левой строки: список, скопированный целиком с отступом, остаётся плоским.
  const base = Math.min(...lines.map(indentOf));
  for (const raw of lines) {
    const indent = indentOf(raw) - base;
    let line = raw.trim().replace(/^(?:[-*+•]|\d{1,3}[.)])\s+/, '');
    const box = /^\[([ xX])\]\s*/.exec(line);
    if (box) {
      if (box[1] !== ' ') continue;
      line = line.slice(box[0].length);
    }
    line = line.trim();
    if (!line) continue;
    out.push({ text: line, depth: indent >= 2 && out.length > 0 ? 1 : 0 });
  }
  return out.length > 1 ? out : null;
}

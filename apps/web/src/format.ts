import { addDays, daysBetween, isoWeekday, localDate, type DateSpec, type TaskView } from '#core';
import { LANG, tr, tn } from './i18n.ts';

export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const EN = LANG === 'en';
const WEEKDAYS = EN ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const WEEKDAYS_LONG = EN
  ? ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
  : ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const MONTHS = EN
  ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  : ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_FULL = EN
  ? ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  : ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export function todayDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

function dayMonth(date: string, full = false): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const month = (full ? MONTHS_FULL : MONTHS)[m - 1]!;
  const thisYear = Number(todayDate().slice(0, 4));
  // По-английски месяц перед числом: «Oct 15», «October 15, 2027».
  if (EN) return y === thisYear ? `${month} ${d}` : `${month} ${d}, ${y}`;
  return y === thisYear ? `${d} ${month}` : `${d} ${month} ${y}`;
}

/** «Сегодня», «Завтра», «Пт», «15 ноя». */
export function dateLabel(date: string, today = todayDate()): string {
  const delta = daysBetween(today, date);
  if (delta === 0) return tr('Сегодня');
  if (delta === 1) return tr('Завтра');
  if (delta === -1) return tr('Вчера');
  if (delta > 1 && delta < 7) return WEEKDAYS_LONG[isoWeekday(date) - 1]!;
  return dayMonth(date);
}

/** Заголовок дня в «Предстоящих»: «Сегодня · 13 октября · Вторник». */
export function dayHeading(date: string, today = todayDate()): string {
  const weekday = WEEKDAYS_LONG[isoWeekday(date) - 1]!;
  const base = `${dayMonth(date, true)} · ${weekday}`;
  const delta = daysBetween(today, date);
  if (delta === 0) return `${tr('Сегодня')} · ${base}`;
  if (delta === 1) return `${tr('Завтра')} · ${base}`;
  return base;
}

export function dueLabel(due: DateSpec, today = todayDate()): string {
  const d = localDate(due, TZ);
  const time = due.time ? ` ${due.time}` : '';
  return `${dateLabel(d, today)}${time}`;
}

export type DueTone = 'overdue' | 'today' | 'soon' | 'later';

export function dueTone(t: TaskView, today = todayDate()): DueTone {
  if (!t.due) return 'later';
  const d = localDate(t.due, TZ);
  if (d < today) return 'overdue';
  if (d === today) return 'today';
  if (d <= addDays(today, 6)) return 'soon';
  return 'later';
}

export function weekdayShort(date: string): string {
  return WEEKDAYS[isoWeekday(date) - 1]!;
}

export function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hu = tr('ч');
  const mu = tr('мин');
  if (h && m) return `${h} ${hu} ${m} ${mu}`;
  if (h) return `${h} ${hu}`;
  return `${m} ${mu}`;
}

/** «3 задачи», «5 задач»; по-английски «3 tasks». */
export const plural = tn;

const MONTHS_NOMINATIVE = EN
  ? MONTHS_FULL
  : ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

/** «Октябрь 2026». */
export function monthTitle(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return `${MONTHS_NOMINATIVE[m - 1]} ${y}`;
}

/** «12-18 октября», «28 сентября - 4 октября», «13 октября». */
export function rangeTitle(from: string, to: string): string {
  if (from === to) return dayMonth(from, true);
  const [, m1, d1] = from.split('-').map(Number) as [number, number, number];
  const [, m2] = to.split('-').map(Number) as [number, number, number];
  if (m1 === m2) return EN ? `${dayMonth(from, true)}-${Number(to.slice(8))}` : `${d1}-${dayMonth(to, true)}`;
  return `${dayMonth(from, true)} - ${dayMonth(to, true)}`;
}

/** «09:30» из минут от полуночи. */
export function clock(minute: number): string {
  return `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

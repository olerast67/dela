import { addDays, daysBetween, isoWeekday, localDate, type DateSpec, type TaskView } from '#core';

export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const WEEKDAYS_LONG = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_FULL = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export function todayDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

function dayMonth(date: string, full = false): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const month = (full ? MONTHS_FULL : MONTHS)[m - 1]!;
  const thisYear = Number(todayDate().slice(0, 4));
  return y === thisYear ? `${d} ${month}` : `${d} ${month} ${y}`;
}

/** «Сегодня», «Завтра», «Пт», «15 ноя». */
export function dateLabel(date: string, today = todayDate()): string {
  const delta = daysBetween(today, date);
  if (delta === 0) return 'Сегодня';
  if (delta === 1) return 'Завтра';
  if (delta === -1) return 'Вчера';
  if (delta > 1 && delta < 7) return WEEKDAYS_LONG[isoWeekday(date) - 1]!;
  return dayMonth(date);
}

/** Заголовок дня в «Предстоящих»: «Сегодня · 13 октября · Вторник». */
export function dayHeading(date: string, today = todayDate()): string {
  const weekday = WEEKDAYS_LONG[isoWeekday(date) - 1]!;
  const base = `${dayMonth(date, true)} · ${weekday}`;
  const delta = daysBetween(today, date);
  if (delta === 0) return `Сегодня · ${base}`;
  if (delta === 1) return `Завтра · ${base}`;
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
  if (h && m) return `${h} ч ${m} мин`;
  if (h) return `${h} ч`;
  return `${m} мин`;
}

/** «3 задачи», «5 задач». */
export function plural(n: number, one: string, few: string, many: string): string {
  const rule = new Intl.PluralRules('ru').select(n);
  return `${n} ${rule === 'one' ? one : rule === 'few' ? few : many}`;
}

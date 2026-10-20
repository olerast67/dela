/**
 * Напоминания. У задачи со временем по умолчанию одно напоминание в момент срока
 * (смещения по умолчанию задаёт пользователь). Поле reminders задачи переопределяет их:
 * список минут «до срока», пустой список — без напоминаний.
 */
import { addDays, instant, today as todayIn, zonedToUtc } from './dates.ts';
import type { Doc, TaskView } from './doc.ts';

export interface Reminder {
  /** Одинаков для одного и того же напоминания на любом устройстве: по нему не показываем дважды. */
  readonly key: string;
  readonly taskId: string;
  readonly at: number;
  readonly title: string;
  /** Момент срока. */
  readonly dueAt: number;
  readonly offset: number;
  /** Срочное напоминание задачи: на Android — будильник. */
  readonly alarm?: boolean;
}

export const MAX_REMINDERS = 5;
export const MAX_OFFSET = 7 * 24 * 60;

export function isReminderList(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length <= MAX_REMINDERS &&
    v.every((x) => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= MAX_OFFSET)
  );
}

export function offsetsOf(t: TaskView, defaults: readonly number[]): readonly number[] {
  return t.reminders ?? (t.due?.time ? defaults : []);
}

/** Напоминания в полуинтервале [from, to), по времени. */
export function remindersBetween(doc: Pick<Doc, 'openTasks'>, from: number, to: number, tz: string, defaults: readonly number[] = [0]): Reminder[] {
  const out: Reminder[] = [];
  for (const t of doc.openTasks()) {
    if (!t.due?.time) continue;
    const dueAt = instant(t.due, tz);
    for (const offset of new Set(offsetsOf(t, defaults))) {
      const at = dueAt - offset * 60_000;
      if (at < from || at >= to) continue;
      out.push({ key: `${t.id}:${t.due.date}T${t.due.time}:${offset}`, taskId: t.id, at, title: t.title, dueAt, offset, ...(t.alarm ? { alarm: true } : {}) });
    }
  }
  return out.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

/** Открытые задачи со срочным напоминанием. Отложенные будильники остальных задач (выполненных, удалённых, без флага) телефон снимает. */
export function alarmTasks(doc: Pick<Doc, 'openTasks'>): string[] {
  return doc.openTasks().filter((t) => t.alarm).map((t) => t.id);
}

/** Утренняя сводка за день: сколько задач на этот день и сколько просрочено к моменту сводки. */
export interface Digest {
  /** «digest:2026-10-21»: не пересекается с ключами напоминаний задач («<id задачи>:…»), одна сводка в день. */
  readonly key: string;
  readonly date: string;
  readonly at: number;
  readonly today: number;
  readonly overdue: number;
}

export const DIGEST_KEY_PREFIX = 'digest:';

/**
 * Сводки, время которых попадает в [from, to). Считаются по текущему документу так, будто до сводки ничего не изменится:
 * при каждой правке расписание пересчитывается, поэтому на момент показа числа совпадают с экраном «Сегодня».
 * Дни, где нет ни задач на день, ни просроченных, пропускаются.
 */
export function digestsBetween(doc: Pick<Doc, 'today'>, from: number, to: number, tz: string, time: string): Digest[] {
  const out: Digest[] = [];
  // Первый день берётся на сутки раньше: момент сводки вчерашнего дня по часовому поясу может попасть в окно.
  for (let date = addDays(todayIn(tz, from), -1); ; date = addDays(date, 1)) {
    const at = zonedToUtc(date, time, tz);
    if (at >= to) break;
    if (at < from) continue;
    const { today, overdue } = doc.today(date, tz);
    if (today.length === 0 && overdue.length === 0) continue;
    out.push({ key: `${DIGEST_KEY_PREFIX}${date}`, date, at, today: today.length, overdue: overdue.length });
  }
  return out;
}

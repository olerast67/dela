/**
 * Напоминания. У задачи со временем по умолчанию одно напоминание в момент срока
 * (смещения по умолчанию задаёт пользователь). Поле reminders задачи переопределяет их:
 * список минут «до срока», пустой список — без напоминаний.
 */
import { instant } from './dates.ts';
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
export function remindersBetween(doc: Doc, from: number, to: number, tz: string, defaults: readonly number[] = [0]): Reminder[] {
  const out: Reminder[] = [];
  for (const t of doc.openTasks()) {
    if (!t.due?.time) continue;
    const dueAt = instant(t.due, tz);
    for (const offset of new Set(offsetsOf(t, defaults))) {
      const at = dueAt - offset * 60_000;
      if (at < from || at >= to) continue;
      out.push({ key: `${t.id}:${t.due.date}T${t.due.time}:${offset}`, taskId: t.id, at, title: t.title, dueAt, offset });
    }
  }
  return out.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

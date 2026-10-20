/**
 * Срочные напоминания на Android: будильник на весь экран вместо уведомления.
 * Чистые функции отдельно от platform.ts, чтобы их можно было проверить тестами.
 */

/** Сколько ближайших будильников держит телефон; остальные срочные приходят обычным уведомлением, пока до них не дойдёт очередь. */
export const ALARM_LIMIT = 20;

/**
 * Разделить будущие напоминания: срочные идут будильником, остальные — уведомлением.
 * Без разрешения на будильник (alarmsAllowed = false) всё идёт уведомлениями: напоминание не теряется.
 */
export function splitAlarms<T extends { readonly alarm?: boolean; readonly taskId: string | null }>(
  list: readonly T[],
  alarmsAllowed: boolean,
  limit = ALARM_LIMIT,
): { alarms: T[]; notifications: T[] } {
  const alarms: T[] = [];
  const notifications: T[] = [];
  for (const r of list) {
    if (alarmsAllowed && r.alarm && r.taskId && alarms.length < limit) alarms.push(r);
    else notifications.push(r);
  }
  return { alarms, notifications };
}

/**
 * Действия плана дня для экранов: выбранный день ленты, «Уложить», «В ближайшее свободное», «+15», «Уплотнить».
 * Каждое действие — одна запись отмены и тост с «Отменить».
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { compactRest, minuteToTime, packTasks, placeNextFree, shiftRest, type PackResult, type Workspace } from '#core';
import { calendarEvents } from '../calendars.ts';
import { TZ, timeLabel, todayDate } from '../format.ts';
import { tn, tr } from '../i18n.ts';
import { haptic } from '../platform.ts';
import { applyPlan, planDayFor } from '../plan.ts';
import { showToast } from './toast.tsx';

// ---------- выбранный день ленты (общий для «Входящих», «Сегодня» и «Уложить») ----------

/** null — сегодня: после полуночи лента сама переходит на новый день. */
let chosen: string | null = null;
const listeners = new Set<() => void>();

export function planDate(): string {
  const today = todayDate();
  return chosen && chosen >= today ? chosen : today;
}

export function setPlanDate(date: string): void {
  chosen = date === todayDate() ? null : date;
  for (const fn of listeners) fn();
}

export function usePlanDate(): string {
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => chosen,
  );
  return planDate();
}

/** «Сейчас» с перерисовкой каждые 20 секунд: текущее дело и минуты до конца. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 20_000);
    const wake = () => setNow(Date.now());
    document.addEventListener('visibilitychange', wake);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', wake);
    };
  }, []);
  return now;
}

// ---------- действия ----------

export function dayOf(doc: Workspace, date: string, extra: readonly string[] = []) {
  return planDayFor(doc, date, TZ, calendarEvents(date, 1), todayDate(), extra);
}

/** Записать результат укладки и сказать, что получилось. */
export function commitPlan(doc: Workspace, result: PackResult, done: string): boolean {
  if (!result.changes.length) {
    showToast(result.overflow.length ? tr('До 24:00 не влезает') : tr('Двигать нечего'));
    return false;
  }
  applyPlan(doc, result.changes, TZ);
  haptic('light');
  const over = result.overflow.length ? `. ${tr('Не влезло до 24:00: {n}', { n: result.overflow.length })}` : '';
  showToast(`${done}${over}`, { label: tr('Отменить'), run: () => doc.undo() });
  return true;
}

/** «Уложить» выбранные задачи встык с минуты start в дне date. */
export function packSelected(doc: Workspace, ids: readonly string[], date: string, start: number): boolean {
  const result = packTasks(dayOf(doc, date, ids), ids, start);
  return commitPlan(doc, result, `${tr('Уложено')}: ${tn(result.changes.length, 'задача', 'задачи', 'задач')}`);
}

/** «В ближайшее свободное» сегодня (клавиша N). */
export function toNextFree(doc: Workspace, taskId: string): void {
  const change = placeNextFree(dayOf(doc, todayDate(), [taskId]), taskId, Date.now());
  if (!change) {
    showToast(tr('Сегодня нет свободного места'));
    return;
  }
  applyPlan(doc, [change], TZ);
  haptic('light');
  showToast(tr('Поставлено на {time}', { time: timeLabel(minuteToTime(change.minute)) }), { label: tr('Отменить'), run: () => doc.undo() });
}

/** «+15», «+30»: сдвинуть остаток дня. */
export function shiftPlan(doc: Workspace, date: string, minutes: number): void {
  const result = shiftRest(dayOf(doc, date), Date.now(), minutes);
  commitPlan(doc, result, tr('Сдвинуто на {n} мин', { n: minutes }));
}

/** «Уплотнить»: убрать дыры в остатке дня. */
export function compactPlan(doc: Workspace, date: string): void {
  const result = compactRest(dayOf(doc, date), Date.now());
  commitPlan(doc, result, tr('Уплотнено'));
}

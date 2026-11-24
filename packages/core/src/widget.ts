/**
 * Снимок задач для виджета на главном экране Android. Виджет работает без открытого приложения,
 * поэтому получает короткий список открытых задач и сам выбирает нужный (сегодня, неделя, проект).
 * Снимок лежит в хранилище приложения на телефоне и на сервер не уходит.
 */
import { addDays, localDate } from './dates.ts';
import type { TaskNode, TaskView } from './doc.ts';
import type { CalEvent } from './events.ts';
import { dayTimeline } from './plan.ts';
import type { Workspace } from './workspace.ts';

export interface WidgetTask {
  readonly id: string;
  /** Название. */
  readonly t: string;
  /** Проект. */
  readonly p: string;
  /** Приоритет 1-4. */
  readonly pr: number;
  /** Дата срока у пользователя или null. */
  readonly d: string | null;
  /** Время срока или null. */
  readonly tm: string | null;
  /** Повторяется. */
  readonly r: boolean;
  /** Длительность в минутах; нет поля — длительности нет (в плане берётся pd). */
  readonly du?: number;
  /** Точное время в плане: «+15» и «Уплотнить» задачу не двигают. Нет поля — false. */
  readonly fx?: true;
}

/**
 * Строка плана на сегодня: k='t' задача (id из tasks), 'e' событие календаря (t — название),
 * 'f' дыра m минут. s и e — минуты от полуночи у пользователя. Текущее дело виджет определяет сам по часам,
 * выполненные на виджете задачи пропускает (дыра при этом не пересчитывается до нового снимка).
 */
export type WidgetPlanRow =
  | { readonly k: 't'; readonly id: string; readonly s: number; readonly e: number }
  | { readonly k: 'e'; readonly t: string; readonly s: number; readonly e: number }
  | { readonly k: 'f'; readonly s: number; readonly m: number };

export interface WidgetSnapshot {
  readonly v: 1;
  /** Включена блокировка PIN-кодом: виджет может скрыть задачи. */
  readonly lock: boolean;
  /** Язык интерфейса приложения: виджет показывает строки и время на нём, а не на языке телефона. */
  readonly lang?: 'ru' | 'en';
  readonly projects: ReadonlyArray<{ readonly id: string; readonly name: string; readonly color: string; readonly inbox: boolean }>;
  /** В порядке проекта; задачи со сроком дальше недели и без проекта в списке не нужны. */
  readonly tasks: readonly WidgetTask[];
  /** Длительность по умолчанию в плане, минуты. Нет поля — 15 (снимок старой версии). */
  readonly pd?: number;
  /** Дата плана (сегодня у пользователя) и его строки по началу. Нет поля — снимок старой версии. */
  readonly planDate?: string;
  readonly plan?: readonly WidgetPlanRow[];
}

export const WIDGET_TASK_LIMIT = 500;

export function widgetSnapshot(
  ws: Workspace,
  today: string,
  tz: string,
  lock: boolean,
  limit = WIDGET_TASK_LIMIT,
  inboxName = 'Входящие',
  lang: 'ru' | 'en' = 'ru',
  events: readonly CalEvent[] = [],
): WidgetSnapshot {
  const pd = ws.getPlanSettings().duration;
  const views: TaskView[] = [];
  const horizon = addDays(today, 8);
  const projects = [ws.project(ws.inboxId), ...ws.projects().map((n) => n.project)].filter((p) => p !== undefined);
  const tasks: WidgetTask[] = [];
  const seen = new Set<string>();
  const walk = (nodes: readonly TaskNode[]) => {
    for (const n of nodes) {
      const t = n.task;
      if (t.completedAt === null && !seen.has(t.id)) {
        seen.add(t.id);
        const d = t.due ? localDate(t.due, tz) : null;
        views.push(t);
        tasks.push({
          id: t.id,
          t: t.title,
          p: t.projectId,
          pr: t.priority,
          d,
          tm: t.due?.time ?? null,
          r: t.recurrence !== null,
          ...(t.duration ? { du: t.duration } : {}),
          ...(t.fixedTime ? { fx: true as const } : {}),
        });
      }
      walk(n.children);
    }
  };
  for (const p of projects) {
    const view = ws.projectTasks(p.id);
    walk(view.unsectioned);
    for (const s of view.sections) walk(s.tasks);
  }
  // Сначала задачи со сроком в ближайшую неделю (их видит «Сегодня»), потом остальные по порядку проектов.
  const near = tasks.filter((t) => t.d !== null && t.d <= horizon);
  const rest = tasks.filter((t) => !(t.d !== null && t.d <= horizon));
  const kept = [...near, ...rest].slice(0, limit);
  const keptIds = new Set(kept.map((t) => t.id));
  const plan: WidgetPlanRow[] = [];
  for (const row of dayTimeline({ date: today, tz, tasks: views.filter((v) => keptIds.has(v.id)), events, defaultDuration: pd }, null)) {
    if (row.kind === 'task') plan.push({ k: 't', id: row.id, s: row.start, e: row.end });
    else if (row.kind === 'event') plan.push({ k: 'e', t: row.title, s: row.start, e: row.end });
    else plan.push({ k: 'f', s: row.start, m: row.minutes });
  }
  return {
    v: 1,
    lock,
    lang,
    projects: projects.map((p) => ({ id: p.id, name: p.isInbox ? inboxName : p.name, color: p.color, inbox: p.isInbox })),
    tasks: kept,
    pd,
    planDate: today,
    plan,
  };
}

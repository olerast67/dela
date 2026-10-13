/**
 * Снимок задач для виджета на главном экране Android. Виджет работает без открытого приложения,
 * поэтому получает короткий список открытых задач и сам выбирает нужный (сегодня, неделя, проект).
 * Снимок лежит в хранилище приложения на телефоне и на сервер не уходит.
 */
import { addDays, localDate } from './dates.ts';
import type { TaskNode } from './doc.ts';
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
}

export interface WidgetSnapshot {
  readonly v: 1;
  /** Включена блокировка PIN-кодом: виджет может скрыть задачи. */
  readonly lock: boolean;
  readonly projects: ReadonlyArray<{ readonly id: string; readonly name: string; readonly color: string; readonly inbox: boolean }>;
  /** В порядке проекта; задачи со сроком дальше недели и без проекта в списке не нужны. */
  readonly tasks: readonly WidgetTask[];
}

export const WIDGET_TASK_LIMIT = 500;

export function widgetSnapshot(ws: Workspace, today: string, tz: string, lock: boolean, limit = WIDGET_TASK_LIMIT, inboxName = 'Входящие'): WidgetSnapshot {
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
        tasks.push({ id: t.id, t: t.title, p: t.projectId, pr: t.priority, d, tm: t.due?.time ?? null, r: t.recurrence !== null });
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
  return {
    v: 1,
    lock,
    projects: projects.map((p) => ({ id: p.id, name: p.isInbox ? inboxName : p.name, color: p.color, inbox: p.isInbox })),
    tasks: [...near, ...rest].slice(0, limit),
  };
}

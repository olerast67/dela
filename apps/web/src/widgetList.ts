import type { QuickAddDefaults } from './ui/QuickAdd.tsx';

/** Экран и умолчания быстрого добавления для списка виджета Android. */
export interface WidgetListTarget {
  readonly hash: string;
  readonly defaults: QuickAddDefaults;
}

/**
 * Список виджета: «today», «week», «inbox» или «project:<id>» (Входящие тоже приходят проектом).
 * «+» и микрофон на виджете открывают этот список и добавляют задачу в него:
 * в «Сегодня» со сроком на сегодня, в «Неделю» без срока, как кнопка на экране «Предстоящие».
 * null — список неизвестен, быстрое добавление открывается как раньше.
 */
export function widgetListTarget(list: string | undefined, inboxId: string, today: string): WidgetListTarget | null {
  if (list === 'today') return { hash: '#/today', defaults: { due: { date: today } } };
  if (list === 'week') return { hash: '#/upcoming', defaults: {} };
  const id = list === 'inbox' ? inboxId : list?.startsWith('project:') ? list.slice('project:'.length) : '';
  if (!id) return null;
  if (id === inboxId) return { hash: '#/inbox', defaults: { projectId: inboxId } };
  return { hash: `#/project/${encodeURIComponent(id)}`, defaults: { projectId: id } };
}

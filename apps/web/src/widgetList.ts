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
 * Проект, которого уже нет (удалён после настройки виджета), заменяется «Входящими».
 * «plan» и «plan@HH:MM» — режим «План»: задача на сегодня, время — конец последнего дела плана
 * или начало нажатой дыры, но не раньше «сейчас» (округлено вверх до 5 минут); после 24:00 без времени.
 * null — список неизвестен, быстрое добавление открывается как раньше.
 */
export function widgetListTarget(
  list: string | undefined,
  inboxId: string,
  today: string,
  hasProject: (id: string) => boolean = () => true,
  now: Date = new Date(),
): WidgetListTarget | null {
  if (list === 'today') return { hash: '#/today', defaults: { due: { date: today } } };
  if (list === 'plan' || list?.startsWith('plan@')) {
    const time = planStartTime(list.slice('plan@'.length), now);
    return { hash: '#/today', defaults: { due: time ? { date: today, time } : { date: today } } };
  }
  if (list === 'week') return { hash: '#/upcoming', defaults: {} };
  const id = list === 'inbox' ? inboxId : list?.startsWith('project:') ? list.slice('project:'.length) : '';
  if (!id) return null;
  if (id === inboxId || !hasProject(id)) return { hash: '#/inbox', defaults: { projectId: inboxId } };
  return { hash: `#/project/${encodeURIComponent(id)}`, defaults: { projectId: id } };
}

/** Время начала новой задачи плана: не раньше «сейчас», шаг 5 минут; null — день кончился. */
function planStartTime(hhmm: string, now: Date): string | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  const from = m ? Number(m[1]) * 60 + Number(m[2]) : 0;
  const nowMin = Math.ceil((now.getHours() * 60 + now.getMinutes()) / 5) * 5;
  const start = Math.max(from, nowMin);
  if (start >= 24 * 60) return null;
  return `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;
}

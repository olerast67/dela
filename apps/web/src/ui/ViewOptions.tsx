/**
 * Группировка и сортировка в списках задач. Выбор запоминается для каждого экрана отдельно
 * и хранится на этом устройстве: это настройка отображения, а не данные задач.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { localDate, slotOf, type Priority, type TaskNode, type TaskView, type Workspace } from '#core';
import { TZ, dayHeading } from '../format.ts';
import { LOCALE, tr } from '../i18n.ts';

export type GroupBy = 'none' | 'date' | 'priority' | 'project' | 'label';
export type SortBy = 'manual' | 'date' | 'priority' | 'name';
export type Layout = 'list' | 'board';

export interface ViewOptions {
  readonly group: GroupBy;
  readonly sort: SortBy;
  readonly layout: Layout;
}

const KEY = 'dela.viewOptions';
const GROUPS: readonly GroupBy[] = ['none', 'date', 'priority', 'project', 'label'];
const SORTS: readonly SortBy[] = ['manual', 'date', 'priority', 'name'];

let cache: Record<string, Partial<ViewOptions>> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function load(): Record<string, Partial<ViewOptions>> {
  if (cache) return cache;
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    cache = v && typeof v === 'object' ? (v as Record<string, Partial<ViewOptions>>) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Настройки вида для экрана key; сохранённое значение, которого нет среди допустимых, заменяется значением по умолчанию. */
export function useViewOptions(
  key: string,
  defaults: Partial<ViewOptions> = {},
  allowed: { groups?: readonly GroupBy[]; sorts?: readonly SortBy[] } = {},
): [ViewOptions, (patch: Partial<ViewOptions>) => void] {
  useSyncExternalStore(subscribe, () => version);
  const saved = load()[key] ?? {};
  const groups = allowed.groups ?? GROUPS;
  const sorts = allowed.sorts ?? SORTS;
  const base: ViewOptions = { group: 'none', sort: 'manual', layout: 'list', ...defaults };
  const opts: ViewOptions = {
    group: saved.group && groups.includes(saved.group) ? saved.group : base.group,
    sort: saved.sort && sorts.includes(saved.sort) ? saved.sort : base.sort,
    layout: saved.layout === 'board' || saved.layout === 'list' ? saved.layout : base.layout,
  };
  const set = (patch: Partial<ViewOptions>) => {
    cache = { ...load(), [key]: { ...opts, ...patch } };
    version++;
    try {
      localStorage.setItem(KEY, JSON.stringify(cache));
    } catch {
      // без хранилища выбор живёт до перезагрузки
    }
    for (const fn of listeners) fn();
  };
  return [opts, set];
}

const GROUP_LABEL: Record<GroupBy, string> = {
  none: tr('Без группировки'),
  date: tr('По дате'),
  priority: tr('По приоритету'),
  project: tr('По проекту'),
  label: tr('По метке'),
};

const SORT_LABEL: Record<SortBy, string> = {
  manual: tr('Вручную'),
  date: tr('По дате'),
  priority: tr('По приоритету'),
  name: tr('По названию'),
};

/**
 * Кнопка «Порядок» в шапке экрана: под ней два списка, группировка и сортировка.
 * manualLabel: как назвать исходный порядок экрана (в проекте он ручной, в фильтре — порядок запроса).
 */
export function ViewOptionsButton({
  opts,
  onChange,
  groups = GROUPS,
  sorts = SORTS,
  defaults = {},
  manualLabel,
}: {
  opts: ViewOptions;
  onChange: (patch: Partial<ViewOptions>) => void;
  groups?: readonly GroupBy[];
  sorts?: readonly SortBy[];
  defaults?: Partial<ViewOptions>;
  manualLabel?: string;
}) {
  const changed = opts.group !== (defaults.group ?? 'none') || opts.sort !== (defaults.sort ?? 'manual');
  return (
    <OptionsPopover label={tr('Порядок')} title={tr('Группировка и сортировка')} on={changed}>
      {groups.length > 1 && (
        <label>
          <span>{tr('Группировать')}</span>
          <select value={opts.group} onChange={(e) => onChange({ group: e.target.value as GroupBy })}>
            {groups.map((g) => (
              <option key={g} value={g}>
                {GROUP_LABEL[g]}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        <span>{tr('Сортировать')}</span>
        <select value={opts.sort} onChange={(e) => onChange({ sort: e.target.value as SortBy })}>
          {sorts.map((s) => (
            <option key={s} value={s}>
              {s === 'manual' && manualLabel ? manualLabel : SORT_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      {/* Ручной порядок есть только в проекте (там нет manualLabel): только там перетаскивание что-то переставляет. */}
      {changed && !manualLabel && (
        <p className="muted">{tr('Пока выбран другой порядок, задачи не переставляются перетаскиванием. Задачу можно бросить на заголовок группы.')}</p>
      )}
    </OptionsPopover>
  );
}

/** Кнопка с выпадающей панелью настроек отображения (порядок в списках, вид календаря). */
export function OptionsPopover({ label, title, on, children }: { label: string; title: string; on: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  // Щелчок мимо панели и Esc закрывают её.
  useEffect(() => {
    const close = (e: Event) => {
      const el = ref.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !el.contains(e.target as Node)) el.open = false;
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);
  return (
    <details
      className="view-opts"
      ref={ref}
      onToggle={(e) => {
        // Панель прижата к правому краю кнопки, но не выходит за края экрана: на телефоне кнопка бывает и слева, и посередине.
        const el = e.currentTarget;
        if (!el.open) return;
        const r = el.getBoundingClientRect();
        const w = Math.min(250, window.innerWidth - 32);
        const left = Math.max(16, Math.min(r.right - w, window.innerWidth - 16 - w));
        el.style.setProperty('--panel-left', `${left - r.left}px`);
      }}
    >
      <summary className={on ? 'on' : ''} title={title} aria-label={label}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
          <circle cx="16" cy="7" r="2" />
          <circle cx="10" cy="17" r="2" />
        </svg>
        <span>{label}</span>
      </summary>
      <div className="view-opts-panel">{children}</div>
    </details>
  );
}

// ---------- порядок и группы ----------

/** Плоский список задач как дерево: подзадача, чей родитель тоже в списке, встаёт под него. */
export function forest(tasks: readonly TaskView[]): TaskNode[] {
  const ids = new Set(tasks.filter((t) => !t.projected).map((t) => t.id));
  const kids = new Map<string, TaskView[]>();
  const roots: TaskView[] = [];
  for (const t of tasks) {
    if (t.parentId && ids.has(t.parentId) && !t.projected) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t]);
    else roots.push(t);
  }
  const build = (t: TaskView): TaskNode => ({ task: t, children: (kids.get(t.id) ?? []).map(build) });
  return roots.map(build);
}

function dueKey(t: TaskView): string {
  if (!t.due) return '~';
  const minute = slotOf(t.due, TZ)?.minute ?? 24 * 60;
  return `${localDate(t.due, TZ)} ${String(minute).padStart(4, '0')}`;
}

export function comparator(sort: SortBy): ((a: TaskView, b: TaskView) => number) | null {
  switch (sort) {
    case 'manual':
      return null;
    case 'date':
      return (a, b) => {
        const ak = dueKey(a);
        const bk = dueKey(b);
        return ak !== bk ? (ak < bk ? -1 : 1) : a.priority - b.priority;
      };
    case 'priority':
      return (a, b) => a.priority - b.priority;
    case 'name':
      return (a, b) => a.title.localeCompare(b.title, LOCALE, { numeric: true, sensitivity: 'base' });
  }
}

/** Отсортировать задачи; при равенстве остаётся исходный порядок (сортировка устойчивая). */
export function sortTasks(tasks: readonly TaskView[], sort: SortBy): TaskView[] {
  const cmp = comparator(sort);
  return cmp ? [...tasks].sort(cmp) : [...tasks];
}

/** Отсортировать дерево: подзадачи остаются под родителем и сортируются между собой. */
export function sortNodes(nodes: readonly TaskNode[], sort: SortBy): TaskNode[] {
  const cmp = comparator(sort);
  if (!cmp) return [...nodes];
  const walk = (list: readonly TaskNode[]): TaskNode[] => [...list].sort((a, b) => cmp(a.task, b.task)).map((n) => ({ task: n.task, children: walk(n.children) }));
  return walk(nodes);
}

/** Группа задач. drop: что сделать с задачей, брошенной на заголовок группы (если в эту группу можно перенести). */
export interface TaskGroup {
  readonly key: string;
  readonly title: string;
  readonly nodes: TaskNode[];
  readonly drop?: (taskId: string) => void;
}

export function priorityTitle(p: Priority): string {
  return tr('Приоритет {n}', { n: p });
}

/** Разложить задачи верхнего уровня по группам; подзадачи едут вместе с родителем. */
export function groupNodes(doc: Workspace, nodes: readonly TaskNode[], group: GroupBy, sort: SortBy, today: string): TaskGroup[] {
  const sorted = sortNodes(nodes, sort);
  if (group === 'none') return [{ key: 'all', title: '', nodes: sorted }];
  const buckets = new Map<string, TaskNode[]>();
  const put = (k: string, n: TaskNode) => buckets.set(k, [...(buckets.get(k) ?? []), n]);
  for (const n of sorted) {
    const t = n.task;
    if (group === 'date') put(!t.due ? '~' : localDate(t.due, TZ) < today ? '!' : localDate(t.due, TZ), n);
    else if (group === 'priority') put(String(t.priority), n);
    else if (group === 'project') put(t.projectId, n);
    else {
      const live = t.labels.filter((id) => doc.label(id)?.deletedAt === null);
      if (live.length === 0) put('~', n);
      for (const id of live) put(id, n);
    }
  }
  const setDate = (date: string) => (id: string) => {
    const t = doc.task(id);
    if (t) doc.updateTask(id, { due: { ...(t.due ?? {}), date } });
  };
  let order: string[];
  const title = (k: string): string => {
    if (group === 'date') return k === '~' ? tr('Без даты') : k === '!' ? tr('Просрочено') : dayHeading(k, today);
    if (group === 'priority') return priorityTitle(Number(k) as Priority);
    if (group === 'project') {
      const p = doc.project(k);
      return !p ? '' : p.isInbox ? tr('Входящие') : p.name;
    }
    return k === '~' ? tr('Без метки') : (doc.label(k)?.name ?? '');
  };
  const drop = (k: string): ((id: string) => void) | undefined => {
    if (group === 'date') return k === '~' || k === '!' ? undefined : setDate(k);
    if (group === 'priority') return (id) => doc.updateTask(id, { priority: Number(k) as Priority });
    if (group === 'project') return (id) => doc.moveTask(id, { projectId: k, sectionId: null });
    if (k === '~') return undefined;
    return (id) => {
      const t = doc.task(id);
      if (t && !t.labels.includes(k)) doc.setLabels(id, [...t.labels, k]);
    };
  };
  const keys = [...buckets.keys()];
  if (group === 'date') order = keys.sort((a, b) => (a === '!' ? -1 : b === '!' ? 1 : a < b ? -1 : a > b ? 1 : 0));
  else if (group === 'priority') order = keys.sort();
  else if (group === 'project') {
    const pos = new Map<string, number>([[doc.inboxId, -1], ...doc.projects().map((p, i) => [p.project.id, i] as const)]);
    order = keys.sort((a, b) => (pos.get(a) ?? 1e9) - (pos.get(b) ?? 1e9));
  } else {
    const all = doc.labels();
    order = keys.sort((a, b) => (a === '~' ? 1 : b === '~' ? -1 : all.findIndex((l) => l.id === a) - all.findIndex((l) => l.id === b)));
  }
  return order.map((k) => {
    const d = drop(k);
    return { key: k, title: title(k), nodes: buckets.get(k)!, ...(d ? { drop: d } : {}) };
  });
}

/**
 * Импорт из Todoist и экспорт данных.
 *
 * Импорт принимает ответ Todoist Sync API (POST /api/v1/sync, sync_token=*, resource_types=["all"])
 * и записывает всё одним пакетом операций. Повторы Todoist хранит фразой (due.string),
 * её разбирает наш разборщик; если фраза не распознана, срок сохраняется без повтора,
 * а исходная фраза дописывается в описание.
 */
import { wallClock, type DateSpec } from './dates.ts';
import type { Change, Doc, TaskNode } from './doc.ts';
import { keysBetween } from './fractional.ts';
import { LABEL_PREFIX, type Color } from './model.ts';
import type { Json } from './op.ts';
import { parseTask } from './parse.ts';
import { uuidv7 } from './uuid.ts';

interface TodoistDue {
  date?: string;
  timezone?: string | null;
  string?: string;
  lang?: string;
  is_recurring?: boolean;
}

interface TodoistItem {
  id: string;
  content?: string;
  description?: string;
  project_id?: string;
  section_id?: string | null;
  parent_id?: string | null;
  child_order?: number;
  priority?: number;
  labels?: string[];
  due?: TodoistDue | null;
  deadline?: { date?: string } | null;
  duration?: { amount?: number; unit?: string } | null;
  checked?: boolean;
  is_deleted?: boolean;
  added_at?: string;
}

export interface TodoistData {
  projects?: Array<{
    id: string;
    name?: string;
    color?: string;
    parent_id?: string | null;
    child_order?: number;
    is_archived?: boolean;
    is_deleted?: boolean;
    is_favorite?: boolean;
    inbox_project?: boolean;
    view_style?: string;
  }>;
  sections?: Array<{ id: string; name?: string; project_id?: string; section_order?: number; is_deleted?: boolean; is_archived?: boolean; is_collapsed?: boolean }>;
  items?: TodoistItem[];
  labels?: Array<{ id: string; name?: string; color?: string; item_order?: number; is_deleted?: boolean }>;
  filters?: Array<{ id: string; name?: string; query?: string; color?: string; item_order?: number; is_deleted?: boolean }>;
  notes?: Array<{ item_id?: string; content?: string; posted_at?: string; is_deleted?: boolean }>;
}

export interface ImportSummary {
  readonly projects: number;
  readonly sections: number;
  readonly tasks: number;
  readonly labels: number;
  readonly filters: number;
  /** Повторы, которые не удалось распознать (фраза сохранена в описании). */
  readonly unparsedRecurrences: readonly string[];
}

const COLOR_MAP: Record<string, Color> = {
  berry_red: 'pink',
  red: 'red',
  orange: 'orange',
  yellow: 'yellow',
  olive_green: 'green',
  lime_green: 'green',
  green: 'green',
  mint_green: 'teal',
  teal: 'teal',
  sky_blue: 'blue',
  light_blue: 'blue',
  blue: 'blue',
  grape: 'violet',
  violet: 'violet',
  lavender: 'violet',
  magenta: 'pink',
  salmon: 'pink',
  charcoal: 'gray',
  grey: 'gray',
  taupe: 'brown',
};

function color(c: string | undefined): Color {
  return (c && COLOR_MAP[c]) || 'gray';
}

/** Срок Todoist в наш формат: дата, плавающее время или время в поясе. */
export function todoistDue(due: TodoistDue): DateSpec | null {
  const d = due.date ?? '';
  let m = /^(\d{4}-\d{2}-\d{2})$/.exec(d);
  if (m) return { date: m[1]! };
  m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(d);
  if (m) return { date: m[1]!, time: m[2]! };
  m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)Z$/.exec(d);
  if (m) {
    const tz = due.timezone || 'UTC';
    const ms = Date.parse(`${m[1]}Z`);
    if (Number.isNaN(ms)) return null;
    try {
      const wall = wallClock(ms, tz);
      return { date: wall.date, time: wall.time, tz };
    } catch {
      const wall = wallClock(ms, 'UTC');
      return { date: wall.date, time: wall.time, tz: 'UTC' };
    }
  }
  return null;
}

function orderKeys<T extends { id: string }>(items: readonly T[], orderOf: (x: T) => number | undefined): Map<string, string> {
  const sorted = [...items].sort((a, b) => (orderOf(a) ?? 0) - (orderOf(b) ?? 0));
  const keys = keysBetween(null, null, sorted.length);
  return new Map(sorted.map((x, i) => [x.id, keys[i]!]));
}

function groupBy<T>(items: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of items) {
    const k = key(x);
    let list = out.get(k);
    if (!list) out.set(k, (list = []));
    list.push(x);
  }
  return out;
}

export function importTodoist(doc: Doc, data: TodoistData, options: { now?: number; tz?: string } = {}): ImportSummary {
  const now = options.now ?? Date.now();
  const tz = options.tz ?? doc.timeZone;
  doc.ensureInbox();
  const changes: Change[] = [];
  const unparsed: string[] = [];

  // Проекты: Входящие Todoist сливаются с нашими.
  const projects = (data.projects ?? []).filter((p) => !p.is_deleted);
  const projectId = new Map<string, string>();
  for (const p of projects) projectId.set(p.id, p.inbox_project ? doc.inboxId : uuidv7(now));
  const byParent = groupBy(
    projects.filter((p) => !p.inbox_project),
    (p) => p.parent_id ?? '',
  );
  // Новые проекты встают после существующих.
  const existingTop = doc.projects().filter((p) => p.depth === 0);
  const lastTop = existingTop[existingTop.length - 1]?.project.order ?? null;
  for (const [parent, list] of byParent) {
    const sorted = [...list].sort((a, b) => (a.child_order ?? 0) - (b.child_order ?? 0));
    const keys = keysBetween(parent === '' ? lastTop || null : null, null, sorted.length);
    sorted.forEach((p, i) => {
      const id = projectId.get(p.id)!;
      const parentId = p.parent_id ? (projectId.get(p.parent_id) ?? null) : null;
      changes.push(
        ['project', id, 'name', (p.name ?? '').slice(0, 500)],
        ['project', id, 'color', color(p.color)],
        ['project', id, 'parent', parentId === doc.inboxId ? null : parentId],
        ['project', id, 'order', keys[i]!],
        ['project', id, 'view', p.view_style === 'board' ? 'board' : 'list'],
      );
      if (p.is_favorite) changes.push(['project', id, 'favorite', true]);
      if (p.is_archived) changes.push(['project', id, 'archived', true]);
    });
  }

  // Разделы.
  const sections = (data.sections ?? []).filter((s) => !s.is_deleted && !s.is_archived && s.project_id && projectId.has(s.project_id));
  const sectionId = new Map<string, string>();
  for (const [pid, list] of groupBy(sections, (s) => s.project_id!)) {
    const keys = orderKeys(list, (s) => s.section_order);
    for (const s of list) {
      const id = uuidv7(now);
      sectionId.set(s.id, id);
      changes.push(['section', id, 'project', projectId.get(pid)!], ['section', id, 'name', (s.name ?? '').slice(0, 500)], ['section', id, 'order', keys.get(s.id)!]);
      if (s.is_collapsed) changes.push(['section', id, 'collapsed', true]);
    }
  }

  // Метки: Todoist ссылается на них по имени. Существующие метки с тем же именем переиспользуются.
  const labelByName = new Map(doc.labels().map((l) => [l.name.toLocaleLowerCase('ru'), l.id]));
  let labelCount = 0;
  const ensureLabel = (name: string, c?: string): string => {
    const key = name.toLocaleLowerCase('ru');
    let id = labelByName.get(key);
    if (!id) {
      id = uuidv7(now);
      labelByName.set(key, id);
      labelCount++;
      changes.push(['label', id, 'name', name.slice(0, 200)], ['label', id, 'color', color(c)], ['label', id, 'order', `a${String(labelCount).padStart(4, '0')}`]);
    }
    return id;
  };
  for (const l of [...(data.labels ?? [])].filter((x) => !x.is_deleted).sort((a, b) => (a.item_order ?? 0) - (b.item_order ?? 0))) {
    if (l.name) ensureLabel(l.name, l.color);
  }

  // Комментарии дописываются к описанию: отдельных комментариев пока нет.
  const notes = groupBy(
    (data.notes ?? []).filter((n) => !n.is_deleted && n.item_id && n.content),
    (n) => n.item_id!,
  );

  // Задачи.
  const items = (data.items ?? []).filter((t) => !t.is_deleted && !t.checked);
  const itemIds = new Set(items.map((t) => t.id));
  const taskId = new Map(items.map((t) => [t.id, uuidv7(now)] as const));
  const siblings = groupBy(items, (t) => (t.parent_id && itemIds.has(t.parent_id) ? `p:${t.parent_id}` : `s:${t.project_id}:${t.section_id ?? ''}`));
  const order = new Map<string, string>();
  for (const list of siblings.values()) for (const [k, v] of orderKeys(list, (t) => t.child_order)) order.set(k, v);

  for (const t of items) {
    const id = taskId.get(t.id)!;
    const parent = t.parent_id && itemIds.has(t.parent_id) ? taskId.get(t.parent_id)! : null;
    let description = t.description ?? '';
    changes.push(
      ['task', id, 'title', (t.content ?? '').slice(0, 2000)],
      ['task', id, 'project', (t.project_id && projectId.get(t.project_id)) || doc.inboxId],
      ['task', id, 'section', parent === null && t.section_id ? (sectionId.get(t.section_id) ?? null) : null],
      ['task', id, 'parent', parent],
      ['task', id, 'order', order.get(t.id)!],
      ['task', id, 'created_at', t.added_at ? Date.parse(t.added_at) || now : now],
    );
    // В Todoist 4 — самый срочный приоритет.
    const p = t.priority ?? 1;
    if (p >= 2 && p <= 4) changes.push(['task', id, 'priority', 5 - p]);
    if (t.due) {
      const due = todoistDue(t.due);
      if (due) {
        changes.push(['task', id, 'due', due as unknown as Json]);
        if (t.due.is_recurring && t.due.string) {
          const parsed = parseTask(t.due.string, { now, tz });
          // Повтор принимается, только если фраза разобрана целиком: частичный разбор молча исказил бы его.
          if (parsed.recurrence && parsed.title === '') {
            changes.push(['task', id, 'recurrence', { ...parsed.recurrence, text: t.due.string } as unknown as Json]);
          } else {
            unparsed.push(t.due.string);
            description = `${description}${description ? '\n\n' : ''}Повтор в Todoist: ${t.due.string}`;
          }
        }
      }
    }
    if (t.deadline?.date) changes.push(['task', id, 'deadline', t.deadline.date]);
    if (t.duration?.amount) {
      const minutes = t.duration.unit === 'day' ? t.duration.amount * 24 * 60 : t.duration.amount;
      changes.push(['task', id, 'duration', minutes]);
    }
    for (const name of t.labels ?? []) changes.push(['task', id, LABEL_PREFIX + ensureLabel(name), true]);
    const comments = notes.get(t.id);
    if (comments) {
      const text = comments.map((n) => `${n.posted_at ? `${n.posted_at.slice(0, 10)}: ` : ''}${n.content}`).join('\n');
      description = `${description}${description ? '\n\n' : ''}Комментарии из Todoist:\n${text}`;
    }
    if (description) changes.push(['task', id, 'description', description]);
  }

  // Фильтры: синтаксис запросов переносится как есть.
  const filters = (data.filters ?? []).filter((f) => !f.is_deleted && f.name && f.query);
  const filterKeys = orderKeys(filters, (f) => f.item_order);
  for (const f of filters) {
    const id = uuidv7(now);
    changes.push(['filter', id, 'name', f.name!.slice(0, 200)], ['filter', id, 'query', f.query!], ['filter', id, 'color', color(f.color)], ['filter', id, 'order', filterKeys.get(f.id)!]);
  }

  doc.write(changes, { undoable: false });
  return {
    projects: projects.filter((p) => !p.inbox_project).length,
    sections: sections.length,
    tasks: items.length,
    labels: labelCount,
    filters: filters.length,
    unparsedRecurrences: unparsed,
  };
}

/** Загрузить данные из Todoist по личному токену (Настройки → Интеграции → Токен API). */
export async function fetchTodoist(token: string, fetcher: typeof fetch = (i, init) => fetch(i, init)): Promise<TodoistData> {
  const body = new URLSearchParams({ sync_token: '*', resource_types: JSON.stringify(['all']) });
  const res = await fetcher('https://api.todoist.com/api/v1/sync', {
    method: 'POST',
    headers: { authorization: `Bearer ${token.trim()}`, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (res.status === 401 || res.status === 403) throw new Error('todoist_unauthorized');
  if (!res.ok) throw new Error(`todoist_http_${res.status}`);
  return (await res.json()) as TodoistData;
}

// ---------- экспорт ----------

export interface ExportData {
  readonly format: 'dela-export';
  readonly version: 1;
  readonly exportedAt: string;
  readonly projects: unknown[];
  readonly sections: unknown[];
  readonly tasks: unknown[];
  readonly labels: unknown[];
  readonly filters: unknown[];
  readonly completions: unknown[];
}

/** Полный экспорт в открытом формате JSON. Делается на устройстве, поэтому работает и с шифрованием. */
export function exportJson(doc: Doc, now = Date.now()): ExportData {
  const projects = [doc.project(doc.inboxId), ...doc.projects().map((p) => p.project), ...doc.projects({ archived: true }).map((p) => p.project)].filter(
    (p) => p !== undefined,
  );
  return {
    format: 'dela-export',
    version: 1,
    exportedAt: new Date(now).toISOString(),
    projects,
    sections: projects.flatMap((p) => doc.sections(p.id)),
    tasks: doc.allTasks().map(({ depth: _d, childCount: _c, projected: _p, ...t }) => t),
    labels: doc.labels(),
    filters: doc.filters(),
    completions: doc.completions(),
  };
}

/** Экспорт в Markdown: проекты заголовками, задачи списками с отметками. */
export function exportMarkdown(doc: Doc): string {
  const lines: string[] = ['# Dela', ''];
  const labelName = (id: string) => doc.label(id)?.name ?? id;
  const write = (projectId: string, title: string) => {
    const view = doc.projectTasks(projectId, { completed: true });
    lines.push(`## ${title}`, '');
    const out = (nodes: readonly TaskNode[], depth: number) => {
      for (const n of nodes) {
        const t = n.task;
        const meta = [
          t.due ? `📅 ${t.due.date}${t.due.time ? ` ${t.due.time}` : ''}` : '',
          t.recurrence ? `🔁 ${t.recurrence.text}` : '',
          t.priority < 4 ? `p${t.priority}` : '',
          ...t.labels.map((l) => `@${labelName(l)}`),
        ].filter(Boolean);
        lines.push(`${'  '.repeat(depth)}- [${t.completedAt ? 'x' : ' '}] ${t.title}${meta.length ? ` (${meta.join(', ')})` : ''}`);
        if (t.description) for (const d of t.description.split('\n')) lines.push(`${'  '.repeat(depth + 1)}${d}`);
        out(n.children, depth + 1);
      }
    };
    out(view.unsectioned, 0);
    for (const s of view.sections) {
      lines.push('', `### ${s.section.name}`, '');
      out(s.tasks, 0);
    }
    lines.push('');
  };
  // У общего пространства нет «Входящих»: его единственный проект выводится ниже.
  if (doc.kind !== 'shared') write(doc.inboxId, 'Входящие');
  for (const p of doc.projects()) write(p.project.id, `${'↳ '.repeat(p.depth)}${p.project.name}`);
  return lines.join('\n');
}

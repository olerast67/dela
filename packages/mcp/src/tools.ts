/**
 * Инструменты MCP поверх Workspace ядра. Перед каждым вызовом — синхронизация с сервером,
 * после изменения — отправка. Удаления нет намеренно: ошибка ассистента не должна стирать задачи.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  addDays,
  localDate,
  normalizeText,
  parseTask,
  today as todayIn,
  type DateSpec,
  type Priority,
  type Recurrence,
  type TaskPatch,
  type TaskView,
} from '../../core/src/index.ts';
import type { Dela, SyncReport } from './dela.ts';

export const VERSION = '1.0.0';

const INBOX_NAMES = ['inbox', 'входящие'];

interface Context {
  readonly dela: Dela;
  readonly report: SyncReport;
  readonly now: number;
  readonly tz: string;
  readonly today: string;
}

class ToolError extends Error {}

function projectName(dela: Dela, projectId: string): string {
  if (projectId === dela.ws.inboxId) return 'Inbox';
  return dela.ws.project(projectId)?.name ?? '';
}

function dueText(due: DateSpec | null): string | null {
  if (!due) return null;
  return due.time ? `${due.date} ${due.time}${due.tz ? ` ${due.tz}` : ''}` : due.date;
}

/** Задача в ответе: только то, что нужно ассистенту. */
function taskOut(ctx: Context, t: TaskView) {
  const { dela } = ctx;
  return {
    id: t.id,
    title: t.title,
    ...(t.description ? { description: t.description.length > 500 ? `${t.description.slice(0, 500)}…` : t.description } : {}),
    due: dueText(t.due),
    ...(t.recurrence ? { repeat: t.recurrence.text } : {}),
    ...(t.deadline ? { deadline: t.deadline } : {}),
    ...(t.due && localDate(t.due, ctx.tz) < ctx.today && t.completedAt === null ? { overdue: true } : {}),
    project: projectName(dela, t.projectId),
    ...(t.sectionId ? { section: dela.ws.sections(t.projectId).find((s) => s.id === t.sectionId)?.name ?? null } : {}),
    ...(t.parentId ? { parent_id: t.parentId } : {}),
    labels: t.labels.map((id) => dela.ws.label(id)).filter((l) => l && l.deletedAt === null).map((l) => l!.name),
    priority: t.priority,
    completed: t.completedAt !== null,
  };
}

function sortTasks(ctx: Context, tasks: TaskView[]): TaskView[] {
  return tasks.sort((a, b) => {
    const ad = a.due ? `${localDate(a.due, ctx.tz)} ${a.due.time ?? '99:99'}` : '~';
    const bd = b.due ? `${localDate(b.due, ctx.tz)} ${b.due.time ?? '99:99'}` : '~';
    if (ad !== bd) return ad < bd ? -1 : 1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.createdAt - a.createdAt;
  });
}

/** Проект по id или имени (без учёта регистра); «Inbox» и «Входящие» — входящие. */
function findProject(dela: Dela, query: string): string {
  const q = normalizeText(query);
  if (INBOX_NAMES.includes(q)) return dela.ws.inboxId;
  if (query === dela.ws.inboxId || dela.ws.projects().some((p) => p.project.id === query)) return query;
  const hits = dela.ws.projects().filter((p) => normalizeText(p.project.name) === q);
  if (hits.length === 1) return hits[0]!.project.id;
  if (hits.length > 1) throw new ToolError(`Several projects are named "${query}"; pass the project id from list_projects.`);
  const names = dela.ws.projects().map((p) => p.project.name);
  throw new ToolError(`No project named "${query}". Projects: Inbox${names.length ? `, ${names.join(', ')}` : ''}.`);
}

/** Метки по именам; недостающие создаются, как при быстром добавлении в приложении. */
function labelIds(dela: Dela, names: readonly string[], created: string[]): string[] {
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim().replace(/^@/, '');
    if (!name) continue;
    const found = dela.ws.labels().find((l) => normalizeText(l.name) === normalizeText(name));
    if (found) out.push(found.id);
    else {
      out.push(dela.ws.createLabel(name));
      created.push(name);
    }
  }
  return out;
}

/** Срок фразой («завтра в 10», «next friday», «каждый понедельник») или датой 2026-10-21 / 2026-10-21 10:00. */
function parseDue(ctx: Context, text: string): { due: DateSpec | null; recurrence?: Recurrence } {
  const s = text.trim();
  if (!s || /^(none|no date|clear|без срока|нет)$/iu.test(s)) return { due: null };
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?$/.exec(s);
  if (iso) {
    const p = parseTask(iso[1]!, { now: ctx.now, tz: ctx.tz });
    if (!p.due) throw new ToolError(`Invalid date: ${s}`);
    return { due: iso[2] ? { date: p.due.date, time: iso[2] } : { date: p.due.date } };
  }
  const p = parseTask(s, { now: ctx.now, tz: ctx.tz });
  if (!p.due) throw new ToolError(`Could not understand the date "${s}". Use a phrase like "tomorrow 10am", "в пятницу" or a date like 2026-10-21.`);
  return { due: p.due, ...(p.recurrence ? { recurrence: p.recurrence } : {}) };
}

function liveTask(ctx: Context, id: string): TaskView {
  const t = ctx.dela.ws.task(id);
  if (!t || !ctx.dela.ws.isAlive(id)) throw new ToolError(`No task with id ${id}. Find it with search_tasks.`);
  return t;
}

function writable(ctx: Context, projectId: string): void {
  if (ctx.dela.role(projectId) === 'viewer') throw new ToolError(`Project "${projectName(ctx.dela, projectId)}" is shared with you read-only.`);
}

const priority = z.number().int().min(1).max(4).describe('1 = highest (p1), 4 = none');

/**
 * Сервер MCP. open() отдаёт открытую сессию Dela (или бросает «не выполнен вход»); now — для тестов.
 * Вызовы выполняются по одному: синхронизация и запись файла сессии не пересекаются.
 */
export function createServer(open: () => Promise<Dela>, options: { now?: () => number } = {}): McpServer {
  const server = new McpServer(
    { name: 'dela-mcp', version: VERSION },
    {
      instructions:
        'Tasks from the user\'s Dela task manager (end-to-end encrypted; this program decrypts them locally). ' +
        'Use search_tasks or today to find task ids before update_task or complete_task. Tasks cannot be deleted through these tools.',
    },
  );
  let queue: Promise<unknown> = Promise.resolve();

  function tool<A>(fn: (ctx: Context, args: A) => unknown, changes: boolean) {
    return (args: A): Promise<CallToolResult> => {
      const run = async (): Promise<CallToolResult> => {
        try {
          const dela = await open();
          const report = await dela.sync();
          const now = options.now?.() ?? Date.now();
          const tz = dela.ws.timeZone;
          const ctx: Context = { dela, report, now, tz, today: todayIn(tz, now) };
          const result = fn(ctx, args) as Record<string, unknown>;
          const after = changes ? await dela.sync() : report;
          const note = after.offline
            ? changes
              ? { note: `Dela server is unreachable: saved on this computer, ${after.pending} change(s) will be sent on the next call.` }
              : { note: 'Dela server is unreachable: showing data cached on this computer.' }
            : {};
          return { content: [{ type: 'text', text: JSON.stringify({ ...result, ...note }) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
        }
      };
      const p = queue.then(run, run);
      queue = p;
      return p;
    };
  }

  server.registerTool(
    'search_tasks',
    {
      title: 'Search tasks',
      description:
        'Find tasks by text, project, label and due date. Open tasks by default. Returns id, title, due, project, labels and priority.',
      inputSchema: {
        query: z.string().optional().describe('Text to find in the title or description'),
        project: z.string().optional().describe('Project name or id ("Inbox" for the inbox)'),
        label: z.string().optional().describe('Label name'),
        due: z.enum(['today', 'overdue', 'week', 'no_date']).optional().describe('today: due today; overdue: before today; week: today and the next 6 days; no_date: without a due date'),
        status: z.enum(['open', 'completed', 'all']).optional().describe('Default: open'),
        limit: z.number().int().min(1).max(200).optional().describe('Default: 50'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool((ctx, a: { query?: string | undefined; project?: string | undefined; label?: string | undefined; due?: 'today' | 'overdue' | 'week' | 'no_date' | undefined; status?: 'open' | 'completed' | 'all' | undefined; limit?: number | undefined }) => {
      const ws = ctx.dela.ws;
      const status = a.status ?? 'open';
      let tasks = status === 'open' ? ws.openTasks() : ws.allTasks().filter((t) => status === 'all' || t.completedAt !== null);
      if (a.query) {
        const needle = normalizeText(a.query);
        tasks = tasks.filter((t) => normalizeText(t.title).includes(needle) || normalizeText(t.description).includes(needle));
      }
      if (a.project) {
        const id = findProject(ctx.dela, a.project);
        tasks = tasks.filter((t) => t.projectId === id);
      }
      if (a.label) {
        const label = ws.labels().find((l) => normalizeText(l.name) === normalizeText(a.label!.replace(/^@/, '')));
        if (!label) throw new ToolError(`No label named "${a.label}".`);
        tasks = tasks.filter((t) => t.labels.includes(label.id));
      }
      if (a.due) {
        const end = addDays(ctx.today, 6);
        tasks = tasks.filter((t) => {
          if (a.due === 'no_date') return !t.due;
          if (!t.due) return false;
          const d = localDate(t.due, ctx.tz);
          return a.due === 'today' ? d === ctx.today : a.due === 'overdue' ? d < ctx.today : d >= ctx.today && d <= end;
        });
      }
      const limit = a.limit ?? 50;
      const sorted = status === 'completed' ? tasks.sort((x, y) => (y.completedAt ?? 0) - (x.completedAt ?? 0)) : sortTasks(ctx, tasks);
      return { today: ctx.today, total: sorted.length, tasks: sorted.slice(0, limit).map((t) => taskOut(ctx, t)) };
    }, false),
  );

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'List projects (with the inbox) and labels. Shared projects show your role.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool((ctx) => {
      const ws = ctx.dela.ws;
      const open = ws.openTasks();
      const count = (id: string) => open.filter((t) => t.projectId === id).length;
      return {
        projects: [
          { id: ws.inboxId, name: 'Inbox', open_tasks: count(ws.inboxId) },
          ...ws.projects().map((p) => ({
            id: p.project.id,
            name: p.project.name,
            ...(p.project.parentId ? { parent: projectName(ctx.dela, p.project.parentId) } : {}),
            ...(ws.isShared(p.project.id) ? { shared: true, role: ctx.dela.role(p.project.id) } : {}),
            open_tasks: count(p.project.id),
          })),
        ],
        labels: ws.labels().map((l) => l.name),
      };
    }, false),
  );

  server.registerTool(
    'add_task',
    {
      title: 'Add task',
      description:
        'Add a task. `text` is a quick-add phrase in English or Russian, parsed like in the Dela app: ' +
        '"Call mom tomorrow 7pm #Home @phone p1", "Купить хлеб завтра в 10 каждую неделю". Explicit fields override the phrase.',
      inputSchema: {
        text: z.string().min(1).describe('Title with optional date, repeat, #project, @label, p1–p4'),
        project: z.string().optional().describe('Project name or id; default Inbox'),
        description: z.string().optional(),
        due: z.string().optional().describe('Due date phrase or YYYY-MM-DD [HH:MM]'),
        priority: priority.optional(),
        labels: z.array(z.string()).optional().describe('Label names; missing labels are created'),
        parent_id: z.string().optional().describe('Make it a subtask of this task'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    tool((ctx, a: { text: string; project?: string | undefined; description?: string | undefined; due?: string | undefined; priority?: number | undefined; labels?: string[] | undefined; parent_id?: string | undefined }) => {
      const { dela } = ctx;
      const ws = dela.ws;
      const parsed = parseTask(a.text, {
        now: ctx.now,
        tz: ctx.tz,
        projects: [...ws.projects().map((p) => ({ id: p.project.id, name: p.project.name })), { id: ws.inboxId, name: 'Входящие' }, { id: ws.inboxId, name: 'Inbox' }],
        sections: ws.projects().flatMap((p) => ws.sections(p.project.id).map((s) => ({ id: s.id, name: s.name, projectId: p.project.id }))),
        labels: ws.labels().map((l) => ({ id: l.id, name: l.name })),
      });
      const title = parsed.title || a.text.trim();
      const created: string[] = [];
      const parent = a.parent_id ? liveTask(ctx, a.parent_id) : null;
      let projectId = parent?.projectId ?? (a.project ? findProject(dela, a.project) : (parsed.projectId ?? undefined));
      writable(ctx, projectId ?? ws.inboxId);
      // Новый проект из фразы «#Название» создаётся, как в приложении.
      if (!projectId && parsed.newProject) {
        projectId = ws.createProject({ name: parsed.newProject });
        created.push(`project ${parsed.newProject}`);
      }
      let sectionId: string | null = null;
      if (!a.project && !parent) {
        sectionId = parsed.sectionId;
        if (!sectionId && parsed.newSection && projectId) {
          sectionId = ws.createSection(projectId, parsed.newSection);
          created.push(`section ${parsed.newSection}`);
        }
      }
      const labels = [...parsed.labelIds];
      const newLabels: string[] = [];
      for (const name of parsed.newLabels) {
        labels.push(ws.createLabel(name));
        newLabels.push(name);
      }
      if (a.labels) labels.push(...labelIds(dela, a.labels, newLabels));
      for (const n of newLabels) created.push(`label ${n}`);
      const due = a.due !== undefined ? parseDue(ctx, a.due) : null;
      const id = ws.createTask({
        title,
        ...(projectId ? { projectId } : {}),
        sectionId,
        parentId: parent?.id ?? null,
        ...(a.description ? { description: a.description } : {}),
        priority: (a.priority ?? parsed.priority ?? 4) as Priority,
        labels: [...new Set(labels)],
        due: due ? due.due : parsed.due,
        deadline: parsed.deadline,
        duration: parsed.duration,
        recurrence: due?.recurrence ?? parsed.recurrence,
        ...(parsed.reminders ? { reminders: parsed.reminders } : {}),
      });
      const task = ws.task(id)!;
      return {
        added: taskOut(ctx, task),
        ...(created.length ? { created } : {}),
        ...(labels.length && ws.isShared(task.projectId) ? { note: 'Labels are personal and are not kept on tasks in shared projects.' } : {}),
      };
    }, true),
  );

  server.registerTool(
    'update_task',
    {
      title: 'Update task',
      description: 'Change a task: title, description, due date, priority, project or labels. Only the given fields change.',
      inputSchema: {
        id: z.string().describe('Task id from search_tasks or today'),
        title: z.string().min(1).optional(),
        description: z.string().optional().describe('Replaces the description; "" clears it'),
        due: z.string().optional().describe('Phrase ("tomorrow 9am", "каждый понедельник"), YYYY-MM-DD [HH:MM], or "none" to clear'),
        priority: priority.optional(),
        project: z.string().optional().describe('Move to this project (name or id)'),
        labels: z.array(z.string()).optional().describe('Replace labels with these names; [] removes all'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    tool((ctx, a: { id: string; title?: string | undefined; description?: string | undefined; due?: string | undefined; priority?: number | undefined; project?: string | undefined; labels?: string[] | undefined }) => {
      const ws = ctx.dela.ws;
      const task = liveTask(ctx, a.id);
      writable(ctx, task.projectId);
      const target = a.project !== undefined ? findProject(ctx.dela, a.project) : null;
      if (target) writable(ctx, target);
      if (a.labels !== undefined && ws.isShared(target ?? task.projectId)) throw new ToolError('Labels are personal and cannot be set on tasks in shared projects.');
      const created: string[] = [];
      const patch: { -readonly [K in keyof TaskPatch]: TaskPatch[K] } = {};
      if (a.title !== undefined) patch.title = a.title;
      if (a.description !== undefined) patch.description = a.description;
      if (a.priority !== undefined) patch.priority = a.priority as Priority;
      if (a.due !== undefined) {
        const d = parseDue(ctx, a.due);
        patch.due = d.due;
        if (d.recurrence) patch.recurrence = d.recurrence;
        else if (d.due === null) patch.recurrence = null;
      }
      let id = task.id;
      ws.group(() => {
        if (Object.keys(patch).length) ws.updateTask(id, patch);
        if (target && target !== task.projectId) {
          // Между личным и общим проектом задача переносится копией: у копии новый id.
          const before = new Set(ws.docForProject(target).allTasks().map((t) => t.id));
          ws.moveTask(id, { projectId: target });
          if (!ws.isAlive(id)) {
            const copy = ws.docForProject(target).allTasks().find((t) => !before.has(t.id) && t.parentId === null);
            if (copy) id = copy.id;
          }
        }
        if (a.labels !== undefined) ws.setLabels(id, labelIds(ctx.dela, a.labels, created));
      });
      return { updated: taskOut(ctx, ws.task(id)!), ...(id !== task.id ? { note: `The task moved to another space and got a new id: ${id}` } : {}), ...(created.length ? { created_labels: created } : {}) };
    }, true),
  );

  server.registerTool(
    'complete_task',
    {
      title: 'Complete task',
      description: 'Mark a task done (with its subtasks). A repeating task moves to its next date instead, as in the app.',
      inputSchema: { id: z.string().describe('Task id from search_tasks or today') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    tool((ctx, a: { id: string }) => {
      const ws = ctx.dela.ws;
      const task = liveTask(ctx, a.id);
      writable(ctx, task.projectId);
      if (task.completedAt !== null) return { already_completed: taskOut(ctx, task) };
      ws.completeTask(task.id);
      const after = ws.task(task.id)!;
      return after.completedAt === null
        ? { completed_occurrence: task.due?.date ?? null, next: taskOut(ctx, after) }
        : { completed: taskOut(ctx, after) };
    }, true),
  );

  server.registerTool(
    'today',
    {
      title: 'Today',
      description: 'Tasks due today and overdue tasks, like the Today view in Dela.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool((ctx) => {
      const { overdue, today } = ctx.dela.ws.today(ctx.today, ctx.tz);
      return { date: ctx.today, overdue: overdue.map((t) => taskOut(ctx, t)), today: today.map((t) => taskOut(ctx, t)) };
    }, false),
  );

  return server;
}

/**
 * Doc: задачи одного пространства поверх реплики.
 *
 * Изменения превращаются в операции над полями, получают метки HLC, применяются к реплике
 * и попадают в очередь исходящих. Запросы читают разобранный снимок, который
 * пересобирается лениво после изменений.
 */
import { addDays, daysBetween, instant, localDate, today as todayIn, type DateSpec } from './dates.ts';
import { compareOrder, keyBetween } from './fractional.ts';
import type { HybridClock } from './hlc.ts';
import {
  LABEL_PREFIX,
  toCompletion,
  toFilter,
  toLabel,
  toProject,
  toSection,
  toTask,
  type Completion,
  type Label,
  type Priority,
  type Project,
  type ProjectView,
  type Recurrence,
  type SavedFilter,
  type Section,
  type Task,
  toComment,
  type Attachment,
  type Comment,
} from './model.ts';
import type { Json, Op } from './op.ts';
import { nextOccurrence, occurrencesBetween, parseRule } from './recurrence.ts';
import { MemoryReplica } from './replica.ts';
import { uuidv7 } from './uuid.ts';

export type Change = readonly [table: string, record: string, field: string, value: Json];
export type Origin = 'local' | 'remote';
/** undoable: локальная запись попала в историю отмены. */
export type Listener = (ops: readonly Op[], origin: Origin, undoable?: boolean) => void;

/** Задача с действующими значениями: проект, раздел и родитель после разбора дерева. */
export interface TaskView extends Task {
  readonly depth: number;
  readonly childCount: number;
  /** Сколько комментариев у задачи. */
  readonly commentCount?: number;
  /** Будущий экземпляр повторяющейся задачи, показанный в «Предстоящих»; сам по себе не существует. */
  readonly projected?: boolean;
}

export interface TaskNode {
  readonly task: TaskView;
  readonly children: readonly TaskNode[];
}

export interface ProjectNode {
  readonly project: Project;
  readonly depth: number;
}

export interface ProjectTasks {
  readonly unsectioned: readonly TaskNode[];
  readonly sections: ReadonlyArray<{ readonly section: Section; readonly tasks: readonly TaskNode[] }>;
}

export interface Position {
  readonly before?: string | null;
  readonly after?: string | null;
}

export interface TaskInput {
  readonly title: string;
  readonly projectId?: string;
  readonly sectionId?: string | null;
  readonly parentId?: string | null;
  readonly description?: string;
  readonly priority?: Priority;
  readonly labels?: readonly string[];
  readonly start?: DateSpec | null;
  readonly due?: DateSpec | null;
  readonly deadline?: string | null;
  readonly duration?: number | null;
  readonly recurrence?: Recurrence | null;
  readonly reminders?: readonly number[] | null;
  readonly position?: Position;
}

export interface TaskPatch {
  readonly title?: string;
  readonly description?: string;
  readonly priority?: Priority;
  readonly start?: DateSpec | null;
  readonly due?: DateSpec | null;
  readonly deadline?: string | null;
  readonly duration?: number | null;
  readonly recurrence?: Recurrence | null;
  readonly reminders?: readonly number[] | null;
  readonly assignee?: string | null;
}

const PROJECT_PALETTE = ['blue', 'green', 'orange', 'violet', 'teal', 'red', 'pink', 'yellow', 'brown'] as const;

/** Таблицы с мягким удалением: отмена создания помечает запись удалённой. */
const DELETABLE = new Set(['task', 'project', 'section', 'label', 'filter', 'comment']);

const TASK_PATCH_FIELDS: Record<keyof TaskPatch, string> = {
  title: 'title',
  description: 'description',
  priority: 'priority',
  start: 'start',
  due: 'due',
  deadline: 'deadline',
  duration: 'duration',
  recurrence: 'recurrence',
  reminders: 'reminders',
  assignee: 'assignee',
};

interface Snapshot {
  readonly projects: ReadonlyMap<string, Project>;
  readonly sections: ReadonlyMap<string, Section>;
  readonly tasks: ReadonlyMap<string, TaskView>;
  readonly labels: ReadonlyMap<string, Label>;
  readonly filters: ReadonlyMap<string, SavedFilter>;
  readonly completions: ReadonlyMap<string, Completion>;
  /** Действующий родитель задачи после разрыва циклов. */
  readonly taskParent: ReadonlyMap<string, string | null>;
  readonly taskChildren: ReadonlyMap<string, readonly string[]>;
  readonly projectParent: ReadonlyMap<string, string | null>;
  /** Задача видна: она, её предки и проект не удалены. */
  readonly alive: ReadonlySet<string>;
  /** Проект виден: он и предки не удалены. */
  readonly liveProjects: ReadonlySet<string>;
}

/**
 * Родители без циклов. Если правки офлайн замкнули цикл, игнорируется ребро
 * с самой старой меткой поля parent: правило одинаково на всех устройствах.
 */
function acyclicParents(
  ids: Iterable<string>,
  parentOf: (id: string) => string | null,
  hlcOf: (id: string) => string,
): Map<string, string | null> {
  const all = [...ids];
  const broken = new Set<string>();
  const effective = (id: string): string | null => (broken.has(id) ? null : parentOf(id));
  for (;;) {
    const done = new Set<string>();
    let victim: string | undefined;
    outer: for (const start of all) {
      if (done.has(start)) continue;
      const path: string[] = [];
      const index = new Map<string, number>();
      let cur: string | null = start;
      while (cur !== null && !done.has(cur)) {
        const seen = index.get(cur);
        if (seen !== undefined) {
          const cycle = path.slice(seen);
          victim = cycle.reduce((a, b) => {
            const ha = hlcOf(a);
            const hb = hlcOf(b);
            return ha < hb || (ha === hb && a < b) ? a : b;
          });
          break outer;
        }
        index.set(cur, path.length);
        path.push(cur);
        cur = effective(cur);
      }
      for (const id of path) done.add(id);
    }
    if (victim === undefined) break;
    broken.add(victim);
  }
  const result = new Map<string, string | null>();
  for (const id of all) result.set(id, effective(id));
  return result;
}

export interface DocOptions {
  readonly spaceId: string;
  readonly clock: HybridClock;
  readonly replica?: MemoryReplica;
  readonly now?: () => number;
  /** Пояс пользователя: от него считается «сегодня» при выполнении повторяющихся задач. */
  readonly timeZone?: string;
  /**
   * personal — личное пространство со «Входящими»; shared — общее пространство одного проекта,
   * id проекта совпадает с id пространства, своих «Входящих» нет.
   */
  readonly kind?: 'personal' | 'shared';
}

export class Doc {
  readonly spaceId: string;
  readonly replica: MemoryReplica;
  readonly timeZone: string;
  readonly kind: 'personal' | 'shared';
  private readonly clock: HybridClock;
  private readonly now: () => number;
  private outbox: Op[] = [];
  private readonly listeners = new Set<Listener>();
  private snap: Snapshot | null = null;

  constructor(options: DocOptions) {
    this.spaceId = options.spaceId;
    this.clock = options.clock;
    this.replica = options.replica ?? new MemoryReplica();
    this.now = options.now ?? Date.now;
    this.timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.kind = options.kind ?? 'personal';
  }

  // ---------- операции ----------

  /** Записать локальные изменения. Возвращает созданные операции. */
  write(changes: readonly Change[], options: { undoable?: boolean } = {}): Op[] {
    if (changes.length === 0) return [];
    if (options.undoable !== false) {
      // Прежние значения в обратном порядке: отмена возвращает ячейки к состоянию до записи.
      const inverse: Change[] = [];
      const seen = new Set<string>();
      const created = new Set<string>();
      for (const [table, record, field] of changes) {
        const existing = this.replica.get(table, record);
        // Запись создана этим действием: отмена её удаляет, а не оставляет пустую.
        if (existing === undefined && DELETABLE.has(table)) {
          if (!created.has(`${table}\u0000${record}`)) {
            created.add(`${table}\u0000${record}`);
            inverse.push([table, record, 'deleted_at', this.now()]);
          }
          continue;
        }
        const key = `${table}\u0000${record}\u0000${field}`;
        if (seen.has(key)) continue;
        seen.add(key);
        inverse.push([table, record, field, existing?.[field] ?? null]);
      }
      this.undoStack.push(inverse);
      if (this.undoStack.length > 100) this.undoStack.shift();
    }
    const ops = changes.map(([table, record, field, value]): Op => ({ table, record, field, value, hlc: this.clock.tick() }));
    for (const op of ops) this.replica.apply(op);
    this.outbox.push(...ops);
    this.changed(ops, 'local', options.undoable !== false);
    return ops;
  }

  private readonly undoStack: Change[][] = [];

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Отменить последнее действие. Отмена — тоже обычные операции и синхронизируется как правка. */
  undo(): boolean {
    const inverse = this.undoStack.pop();
    if (!inverse) return false;
    this.write(inverse, { undoable: false });
    return true;
  }

  /** Применить операции, полученные с сервера. Возвращает число изменённых ячеек. */
  applyRemote(ops: readonly Op[]): number {
    let n = 0;
    const applied: Op[] = [];
    for (const op of ops) {
      this.clock.receive(op.hlc);
      if (this.replica.apply(op)) {
        n++;
        applied.push(op);
      }
    }
    if (n > 0) this.changed(applied, 'remote');
    return n;
  }

  /** Загрузить сохранённое состояние без уведомлений об изменениях как о новых. */
  load(ops: Iterable<Op>, outbox: readonly Op[] = []): void {
    for (const op of ops) {
      this.clock.receive(op.hlc);
      this.replica.apply(op);
    }
    this.outbox = [...outbox];
    this.snap = null;
  }

  /** Операции, ещё не подтверждённые сервером. */
  pending(): readonly Op[] {
    return this.outbox;
  }

  /** Убрать из очереди операции, которые сервер принял. */
  acknowledge(ops: readonly Op[]): void {
    const done = new Set(ops);
    this.outbox = this.outbox.filter((op) => !done.has(op));
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(ops: readonly Op[], origin: Origin, undoable = false): void {
    this.snap = null;
    for (const fn of this.listeners) fn(ops, origin, undoable);
  }

  // ---------- снимок ----------

  private snapshot(): Snapshot {
    if (this.snap) return this.snap;
    const r = this.replica;
    const projects = new Map<string, Project>();
    for (const [id, rec] of r.all('project')) projects.set(id, toProject(id, rec));
    const sections = new Map<string, Section>();
    for (const [id, rec] of r.all('section')) sections.set(id, toSection(id, rec));
    const rawTasks = new Map<string, Task>();
    for (const [id, rec] of r.all('task')) rawTasks.set(id, toTask(id, rec));
    const commentCount = new Map<string, number>();
    for (const [, rec] of r.all('comment')) {
      if (rec.deleted_at == null && typeof rec.task === 'string') commentCount.set(rec.task, (commentCount.get(rec.task) ?? 0) + 1);
    }
    const labels = new Map<string, Label>();
    for (const [id, rec] of r.all('label')) labels.set(id, toLabel(id, rec));
    const filters = new Map<string, SavedFilter>();
    for (const [id, rec] of r.all('filter')) filters.set(id, toFilter(id, rec));
    const completions = new Map<string, Completion>();
    for (const [id, rec] of r.all('completion')) {
      const c = toCompletion(id, rec);
      if (c) completions.set(id, c);
    }

    const projectParent = acyclicParents(
      projects.keys(),
      (id) => {
        const p = projects.get(id)!.parentId;
        return p !== null && projects.has(p) && p !== id ? p : null;
      },
      (id) => r.hlcOf('project', id, 'parent') ?? '',
    );
    const liveProjects = new Set<string>();
    const projectAlive = (id: string): boolean => {
      for (let cur: string | null = id; cur !== null; cur = projectParent.get(cur) ?? null) {
        if (projects.get(cur)?.deletedAt != null) return false;
      }
      return true;
    };
    for (const id of projects.keys()) if (projectAlive(id)) liveProjects.add(id);

    const taskParent = acyclicParents(
      rawTasks.keys(),
      (id) => {
        const p = rawTasks.get(id)!.parentId;
        return p !== null && rawTasks.has(p) && p !== id ? p : null;
      },
      (id) => r.hlcOf('task', id, 'parent') ?? '',
    );
    const rootOf = (id: string): string => {
      let cur = id;
      for (let p = taskParent.get(cur) ?? null; p !== null; p = taskParent.get(cur) ?? null) cur = p;
      return cur;
    };
    const depthOf = (id: string): number => {
      let d = 0;
      for (let p = taskParent.get(id) ?? null; p !== null; p = taskParent.get(p) ?? null) d++;
      return d;
    };

    const inbox = this.spaceId;
    const taskChildren = new Map<string, string[]>();
    for (const [id, parent] of taskParent) {
      if (parent === null) continue;
      let list = taskChildren.get(parent);
      if (!list) taskChildren.set(parent, (list = []));
      list.push(id);
    }

    const tasks = new Map<string, TaskView>();
    const alive = new Set<string>();
    for (const [id, t] of rawTasks) {
      const root = rawTasks.get(rootOf(id))!;
      // Проекта может ещё не быть на устройстве: тогда задача видна во Входящих.
      const projectId = projects.has(root.projectId) ? root.projectId : inbox;
      const sec = root.sectionId !== null ? sections.get(root.sectionId) : undefined;
      const sectionId = sec && sec.projectId === projectId && sec.deletedAt === null ? sec.id : null;
      const parentId = taskParent.get(id) ?? null;
      tasks.set(id, {
        ...t,
        projectId,
        sectionId: parentId === null ? sectionId : null,
        parentId,
        depth: depthOf(id),
        childCount: (taskChildren.get(id) ?? []).filter((c) => rawTasks.get(c)!.deletedAt === null).length,
        commentCount: commentCount.get(id) ?? 0,
      });
    }
    for (const [id, t] of tasks) {
      let ok = (liveProjects.has(t.projectId) || (t.projectId === inbox && !projects.has(inbox)));
      for (let cur: string | null = id; ok && cur !== null; cur = taskParent.get(cur) ?? null) {
        if (rawTasks.get(cur)!.deletedAt !== null) ok = false;
      }
      if (ok) alive.add(id);
    }

    this.snap = {
      projects,
      sections,
      tasks,
      labels,
      filters,
      completions,
      taskParent,
      taskChildren,
      projectParent,
      alive,
      liveProjects,
    };
    return this.snap;
  }

  // ---------- порядок ----------

  private orderBetween(siblings: ReadonlyArray<{ id: string; order: string }>, id: string | null, pos: Position = {}): string {
    const list = siblings.filter((s) => s.id !== id).slice().sort(compareOrder);
    let prev: string | null = null;
    let next: string | null = null;
    if (pos.after) {
      const i = list.findIndex((s) => s.id === pos.after);
      if (i >= 0) {
        prev = list[i]!.order || null;
        next = list[i + 1]?.order || null;
      }
    } else if (pos.before) {
      const i = list.findIndex((s) => s.id === pos.before);
      if (i >= 0) {
        prev = list[i - 1]?.order || null;
        next = list[i]!.order || null;
      }
    }
    if (!pos.after && !pos.before) prev = list[list.length - 1]?.order || null;
    // Равные ключи у соседей (вставки в одно место с разных устройств): ставим после prev.
    if (prev !== null && next !== null && prev >= next) next = null;
    try {
      return keyBetween(prev, next);
    } catch {
      return keyBetween(prev, null);
    }
  }

  // ---------- Входящие ----------

  /** Id проекта «Входящие»: совпадает с id пространства, поэтому два устройства не создадут два разных. */
  get inboxId(): string {
    return this.spaceId;
  }

  ensureInbox(): string {
    if (this.kind === 'shared') return this.inboxId;
    const p = this.snapshot().projects.get(this.inboxId);
    if (!p || !p.isInbox) {
      // Служебная запись: отмена не должна удалять «Входящие».
      this.write(
        [
          ['project', this.inboxId, 'inbox', true],
          ['project', this.inboxId, 'order', 'a0'],
        ],
        { undoable: false },
      );
    }
    return this.inboxId;
  }

  // ---------- проекты ----------

  createProject(input: { name: string; color?: string; parentId?: string | null; view?: ProjectView; position?: Position }): string {
    const id = uuidv7(this.now());
    const parentId = input.parentId ?? null;
    const siblings = this.activeProjects().filter((p) => p.parentId === parentId && !p.isInbox);
    this.write([
      ['project', id, 'name', input.name.trim()],
      // Без явного цвета проекты получают цвета по кругу: в списке их легче различать.
      ['project', id, 'color', input.color ?? PROJECT_PALETTE[this.activeProjects().filter((p) => !p.isInbox).length % PROJECT_PALETTE.length]!],
      ['project', id, 'parent', parentId],
      ['project', id, 'view', input.view ?? 'list'],
      ['project', id, 'order', this.orderBetween(siblings, id, input.position)],
    ]);
    return id;
  }

  updateProject(
    id: string,
    patch: { name?: string; color?: string; view?: ProjectView; favorite?: boolean; archived?: boolean },
  ): void {
    const changes: Change[] = [];
    if (patch.name !== undefined) changes.push(['project', id, 'name', patch.name.trim()]);
    if (patch.color !== undefined) changes.push(['project', id, 'color', patch.color]);
    if (patch.view !== undefined) changes.push(['project', id, 'view', patch.view]);
    if (patch.favorite !== undefined) changes.push(['project', id, 'favorite', patch.favorite]);
    if (patch.archived !== undefined) changes.push(['project', id, 'archived', patch.archived]);
    this.write(changes);
  }

  moveProject(id: string, target: { parentId: string | null; position?: Position }): void {
    if (id === this.inboxId) throw new Error('inbox cannot be moved');
    if (target.parentId !== null && this.projectAncestors(target.parentId).includes(id)) {
      throw new Error('cannot move a project into itself');
    }
    const siblings = this.activeProjects().filter((p) => p.parentId === target.parentId && !p.isInbox);
    this.write([
      ['project', id, 'parent', target.parentId],
      ['project', id, 'order', this.orderBetween(siblings, id, target.position)],
    ]);
  }

  deleteProject(id: string): void {
    if (id === this.inboxId) throw new Error('inbox cannot be deleted');
    this.write([['project', id, 'deleted_at', this.now()]]);
  }

  restoreProject(id: string): void {
    this.write([['project', id, 'deleted_at', null]]);
  }

  private projectAncestors(id: string): string[] {
    const s = this.snapshot();
    const out: string[] = [];
    for (let cur: string | null = id; cur !== null; cur = s.projectParent.get(cur) ?? null) out.push(cur);
    return out;
  }

  // ---------- разделы ----------

  createSection(projectId: string, name: string, position?: Position): string {
    const id = uuidv7(this.now());
    this.write([
      ['section', id, 'project', projectId],
      ['section', id, 'name', name.trim()],
      ['section', id, 'order', this.orderBetween(this.sections(projectId), id, position)],
    ]);
    return id;
  }

  updateSection(id: string, patch: { name?: string; collapsed?: boolean }): void {
    const changes: Change[] = [];
    if (patch.name !== undefined) changes.push(['section', id, 'name', patch.name.trim()]);
    if (patch.collapsed !== undefined) changes.push(['section', id, 'collapsed', patch.collapsed]);
    this.write(changes);
  }

  moveSection(id: string, position: Position): void {
    const sec = this.snapshot().sections.get(id);
    if (!sec) return;
    this.write([['section', id, 'order', this.orderBetween(this.sections(sec.projectId), id, position)]]);
  }

  /** Удаляет раздел вместе с его задачами (их можно вернуть из корзины по одной). */
  deleteSection(id: string): void {
    const s = this.snapshot();
    const t = this.now();
    const changes: Change[] = [['section', id, 'deleted_at', t]];
    for (const task of s.tasks.values()) {
      if (task.sectionId === id && task.parentId === null && task.deletedAt === null) changes.push(['task', task.id, 'deleted_at', t]);
    }
    this.write(changes);
  }

  // ---------- задачи ----------

  createTask(input: TaskInput): string {
    const id = uuidv7(this.now());
    const s = this.snapshot();
    let projectId = input.projectId ?? this.inboxId;
    let sectionId = input.sectionId ?? null;
    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      const parent = s.tasks.get(parentId);
      if (!parent) throw new Error(`unknown parent task: ${parentId}`);
      projectId = parent.projectId;
      sectionId = parent.sectionId;
    }
    if (projectId === this.inboxId) this.ensureInbox();
    const siblings = this.siblingTasks(projectId, parentId === null ? sectionId : null, parentId);
    const changes: Change[] = [
      ['task', id, 'title', input.title.trim()],
      ['task', id, 'project', projectId],
      ['task', id, 'section', sectionId],
      ['task', id, 'parent', parentId],
      ['task', id, 'order', this.orderBetween(siblings, id, input.position)],
      ['task', id, 'created_at', this.now()],
    ];
    if (input.description) changes.push(['task', id, 'description', input.description]);
    if (input.priority !== undefined && input.priority !== 4) changes.push(['task', id, 'priority', input.priority]);
    if (input.start) changes.push(['task', id, 'start', input.start as unknown as Json]);
    if (input.due) changes.push(['task', id, 'due', input.due as unknown as Json]);
    if (input.deadline) changes.push(['task', id, 'deadline', input.deadline]);
    if (input.duration) changes.push(['task', id, 'duration', input.duration]);
    if (input.recurrence) changes.push(['task', id, 'recurrence', input.recurrence as unknown as Json]);
    if (input.reminders) changes.push(['task', id, 'reminders', [...input.reminders]]);
    for (const label of input.labels ?? []) changes.push(['task', id, LABEL_PREFIX + label, true]);
    this.write(changes);
    return id;
  }

  updateTask(id: string, patch: TaskPatch): void {
    const changes: Change[] = [];
    for (const [key, field] of Object.entries(TASK_PATCH_FIELDS) as Array<[keyof TaskPatch, string]>) {
      if (!(key in patch)) continue;
      let value = patch[key] as unknown as Json | undefined;
      if (value === undefined) continue;
      if (key === 'title' && typeof value === 'string') value = value.trim();
      changes.push(['task', id, field, value]);
    }
    this.write(changes);
  }

  setLabels(id: string, labelIds: readonly string[]): void {
    const task = this.snapshot().tasks.get(id);
    if (!task) return;
    const want = new Set(labelIds);
    const changes: Change[] = [];
    for (const l of want) if (!task.labels.includes(l)) changes.push(['task', id, LABEL_PREFIX + l, true]);
    for (const l of task.labels) if (!want.has(l)) changes.push(['task', id, LABEL_PREFIX + l, false]);
    this.write(changes);
  }

  moveTask(
    id: string,
    target: { projectId?: string; sectionId?: string | null; parentId?: string | null; position?: Position },
  ): void {
    const s = this.snapshot();
    const task = s.tasks.get(id);
    if (!task) throw new Error(`unknown task: ${id}`);
    const parentId = target.parentId === undefined ? null : target.parentId;
    let projectId = target.projectId ?? task.projectId;
    let sectionId = target.sectionId === undefined ? null : target.sectionId;
    if (parentId !== null) {
      const parent = s.tasks.get(parentId);
      if (!parent) throw new Error(`unknown parent task: ${parentId}`);
      if (parentId === id || this.taskAncestors(parentId).includes(id)) throw new Error('cannot move a task into itself');
      projectId = parent.projectId;
      sectionId = parent.sectionId;
    }
    if (projectId === this.inboxId) this.ensureInbox();
    const siblings = this.siblingTasks(projectId, parentId === null ? sectionId : null, parentId);
    const changes: Change[] = [
      ['task', id, 'project', projectId],
      ['task', id, 'section', parentId === null ? sectionId : null],
      ['task', id, 'parent', parentId],
      ['task', id, 'order', this.orderBetween(siblings, id, target.position)],
    ];
    // Потомки переезжают в тот же проект: если связь с родителем потом разорвётся, они останутся рядом.
    for (const d of this.descendants(id)) {
      if (s.tasks.get(d)!.projectId !== projectId) changes.push(['task', d, 'project', projectId]);
    }
    this.write(changes);
  }

  /**
   * Отметить выполненной вместе с невыполненными подзадачами.
   * У повторяющейся задачи выполняется текущий экземпляр, а срок переходит на следующий.
   */
  completeTask(id: string): void {
    const s = this.snapshot();
    const task = s.tasks.get(id);
    if (!task || task.completedAt !== null) return;
    if (task.recurrence && task.due) {
      this.advance(task, true);
      return;
    }
    const t = this.now();
    const changes: Change[] = [['task', id, 'completed_at', t]];
    for (const d of this.descendants(id)) {
      if (s.tasks.get(d)!.completedAt === null) changes.push(['task', d, 'completed_at', t]);
    }
    this.write(changes);
  }

  /** Пропустить текущий экземпляр повторяющейся задачи. */
  skipOccurrence(id: string): void {
    const task = this.snapshot().tasks.get(id);
    if (task?.recurrence && task.due) this.advance(task, false);
  }

  /** Id записи о выполнении: одинаков на всех устройствах, поэтому двойная отметка офлайн не даёт дубля. */
  static completionId(taskId: string, occurrence: string): string {
    return `${taskId}:${occurrence}`;
  }

  private advance(task: TaskView, complete: boolean): void {
    const s = this.snapshot();
    const t = this.now();
    const due = task.due!;
    const occurrence = due.date;
    const todayDate = todayIn(this.timeZone, t);
    const rule = parseRule(task.recurrence!.rule);
    const changes: Change[] = [];
    if (complete) {
      const cid = Doc.completionId(task.id, occurrence);
      changes.push(['completion', cid, 'task', task.id], ['completion', cid, 'occurrence', occurrence], ['completion', cid, 'completed_at', t]);
    }
    let next: string | null = null;
    if (rule) {
      next =
        task.recurrence!.mode === 'completion'
          ? nextOccurrence(rule, todayDate, todayDate)
          : nextOccurrence(rule, occurrence, occurrence > todayDate ? occurrence : todayDate);
    }
    if (next === null) {
      // Серия закончилась.
      if (complete) changes.push(['task', task.id, 'completed_at', t]);
      else changes.push(['task', task.id, 'recurrence', null]);
    } else {
      changes.push(['task', task.id, 'due', { ...due, date: next } as unknown as Json]);
      if (task.start) {
        const shifted = addDays(task.start.date, daysBetween(occurrence, next));
        changes.push(['task', task.id, 'start', { ...task.start, date: shifted } as unknown as Json]);
      }
      // Подзадачи повторяющейся задачи начинаются заново.
      for (const d of this.descendants(task.id)) {
        if (s.tasks.get(d)!.completedAt !== null) changes.push(['task', d, 'completed_at', null]);
      }
    }
    this.write(changes);
  }

  reopenTask(id: string): void {
    this.write([['task', id, 'completed_at', null]]);
  }

  deleteTask(id: string): void {
    this.write([['task', id, 'deleted_at', this.now()]]);
  }

  restoreTask(id: string): void {
    if (this.purged(id)) return;
    const s = this.snapshot();
    const changes: Change[] = [];
    // Восстанавливая подзадачу, возвращаем и удалённых предков: иначе она останется невидимой.
    for (const a of [id, ...this.taskAncestors(id).slice(1)]) {
      if (s.tasks.get(a)?.deletedAt != null) changes.push(['task', a, 'deleted_at', null]);
    }
    this.write(changes);
  }

  private taskAncestors(id: string): string[] {
    const s = this.snapshot();
    const out: string[] = [];
    for (let cur: string | null = id; cur !== null; cur = s.taskParent.get(cur) ?? null) out.push(cur);
    return out;
  }

  private descendants(id: string): string[] {
    const s = this.snapshot();
    const out: string[] = [];
    const stack = [...(s.taskChildren.get(id) ?? [])];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      out.push(cur);
      stack.push(...(s.taskChildren.get(cur) ?? []));
    }
    return out;
  }

  private siblingTasks(projectId: string, sectionId: string | null, parentId: string | null): TaskView[] {
    const s = this.snapshot();
    const out: TaskView[] = [];
    for (const t of s.tasks.values()) {
      if (!s.alive.has(t.id)) continue;
      if (parentId !== null ? t.parentId === parentId : t.parentId === null && t.projectId === projectId && t.sectionId === sectionId) {
        out.push(t);
      }
    }
    return out;
  }

  // ---------- комментарии ----------

  addComment(taskId: string, input: { text: string; author: string | null; file?: Attachment | null }): string {
    const id = uuidv7(this.now());
    const changes: Change[] = [
      ['comment', id, 'task', taskId],
      ['comment', id, 'text', input.text.trim()],
      ['comment', id, 'author', input.author],
      ['comment', id, 'created_at', this.now()],
    ];
    if (input.file) changes.push(['comment', id, 'file', { ...input.file }]);
    this.write(changes);
    return id;
  }

  /** Удалить комментарий: текст и файл затираются, отменить нельзя. */
  deleteComment(id: string): Attachment | null {
    const rec = this.replica.get('comment', id);
    if (!rec || rec.deleted_at != null) return null;
    const file = toComment(id, rec).file;
    this.write(
      [
        ['comment', id, 'text', null],
        ['comment', id, 'file', null],
        ['comment', id, 'deleted_at', this.now()],
      ],
      { undoable: false },
    );
    return file;
  }

  hasComment(id: string): boolean {
    return this.replica.get('comment', id) !== undefined;
  }

  comments(taskId: string): Comment[] {
    const out: Comment[] = [];
    for (const [id, rec] of this.replica.all('comment')) {
      if (rec.task === taskId && rec.deleted_at == null) out.push(toComment(id, rec));
    }
    return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  // ---------- метки и фильтры ----------

  createLabel(name: string, color = 'gray'): string {
    const id = uuidv7(this.now());
    this.write([
      ['label', id, 'name', name.trim()],
      ['label', id, 'color', color],
      ['label', id, 'order', this.orderBetween(this.labels(), id)],
    ]);
    return id;
  }

  updateLabel(id: string, patch: { name?: string; color?: string }): void {
    const changes: Change[] = [];
    if (patch.name !== undefined) changes.push(['label', id, 'name', patch.name.trim()]);
    if (patch.color !== undefined) changes.push(['label', id, 'color', patch.color]);
    this.write(changes);
  }

  deleteLabel(id: string): void {
    this.write([['label', id, 'deleted_at', this.now()]]);
  }

  createFilter(name: string, query: string, color = 'gray'): string {
    const id = uuidv7(this.now());
    this.write([
      ['filter', id, 'name', name.trim()],
      ['filter', id, 'query', query],
      ['filter', id, 'color', color],
      ['filter', id, 'order', this.orderBetween(this.filters(), id)],
    ]);
    return id;
  }

  updateFilter(id: string, patch: { name?: string; query?: string; color?: string }): void {
    const changes: Change[] = [];
    if (patch.name !== undefined) changes.push(['filter', id, 'name', patch.name.trim()]);
    if (patch.query !== undefined) changes.push(['filter', id, 'query', patch.query]);
    if (patch.color !== undefined) changes.push(['filter', id, 'color', patch.color]);
    this.write(changes);
  }

  deleteFilter(id: string): void {
    this.write([['filter', id, 'deleted_at', this.now()]]);
  }

  // ---------- запросы ----------

  project(id: string): Project | undefined {
    return this.snapshot().projects.get(id);
  }

  /** Живые проекты, включая архивные. */
  private activeProjects(): Project[] {
    const s = this.snapshot();
    return [...s.projects.values()].filter((p) => s.liveProjects.has(p.id));
  }

  /** Дерево проектов в порядке отображения: Входящие первыми, затем обход в глубину. */
  projects(options: { archived?: boolean } = {}): ProjectNode[] {
    const s = this.snapshot();
    const visible = this.activeProjects().filter((p) => !p.isInbox && p.archived === (options.archived ?? false));
    const ids = new Set(visible.map((p) => p.id));
    const byParent = new Map<string | null, Project[]>();
    for (const p of visible) {
      const parent = s.projectParent.get(p.id) ?? null;
      const key = parent !== null && ids.has(parent) ? parent : null;
      let list = byParent.get(key);
      if (!list) byParent.set(key, (list = []));
      list.push(p);
    }
    const out: ProjectNode[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const p of (byParent.get(parent) ?? []).sort(compareOrder)) {
        out.push({ project: p, depth });
        walk(p.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }

  sections(projectId: string): Section[] {
    return [...this.snapshot().sections.values()]
      .filter((x) => x.projectId === projectId && x.deletedAt === null)
      .sort(compareOrder);
  }

  labels(): Label[] {
    return [...this.snapshot().labels.values()].filter((l) => l.deletedAt === null).sort(compareOrder);
  }

  label(id: string): Label | undefined {
    return this.snapshot().labels.get(id);
  }

  filters(): SavedFilter[] {
    return [...this.snapshot().filters.values()].filter((f) => f.deletedAt === null).sort(compareOrder);
  }

  task(id: string): TaskView | undefined {
    return this.snapshot().tasks.get(id);
  }

  isAlive(id: string): boolean {
    return this.snapshot().alive.has(id);
  }

  /** Все живые задачи (для фильтров и поиска). */
  allTasks(): TaskView[] {
    const s = this.snapshot();
    return [...s.tasks.values()].filter((t) => s.alive.has(t.id));
  }

  /** Невыполненные задачи без выполненных предков. */
  openTasks(): TaskView[] {
    const s = this.snapshot();
    return this.allTasks().filter((t) => {
      for (let cur: string | null = t.id; cur !== null; cur = s.taskParent.get(cur) ?? null) {
        if (s.tasks.get(cur)!.completedAt !== null) return false;
      }
      return true;
    });
  }

  completions(taskId?: string): Completion[] {
    return [...this.snapshot().completions.values()]
      .filter((c) => taskId === undefined || c.taskId === taskId)
      .sort((a, b) => b.completedAt - a.completedAt);
  }

  private tree(roots: readonly TaskView[], openOnly: boolean): TaskNode[] {
    const s = this.snapshot();
    const build = (t: TaskView): TaskNode => ({
      task: t,
      children: (s.taskChildren.get(t.id) ?? [])
        .map((c) => s.tasks.get(c)!)
        .filter((c) => s.alive.has(c.id) && (!openOnly || c.completedAt === null))
        .sort(compareOrder)
        .map(build),
    });
    return [...roots].sort(compareOrder).map(build);
  }

  /** Задачи проекта деревом: без раздела и по разделам. */
  projectTasks(projectId: string, options: { completed?: boolean } = {}): ProjectTasks {
    const openOnly = !options.completed;
    const top = this.allTasks().filter(
      (t) => t.projectId === projectId && t.parentId === null && (openOnly ? t.completedAt === null : true),
    );
    return {
      unsectioned: this.tree(
        top.filter((t) => t.sectionId === null),
        openOnly,
      ),
      sections: this.sections(projectId).map((section) => ({
        section,
        tasks: this.tree(
          top.filter((t) => t.sectionId === section.id),
          openOnly,
        ),
      })),
    };
  }

  /** Подзадачи задачи деревом. */
  subtasks(id: string, options: { completed?: boolean } = {}): TaskNode[] {
    const s = this.snapshot();
    const openOnly = !options.completed;
    const kids = (s.taskChildren.get(id) ?? [])
      .map((c) => s.tasks.get(c)!)
      .filter((c) => s.alive.has(c.id) && (!openOnly || c.completedAt === null));
    return this.tree(kids, openOnly);
  }

  /** Сегодня: просроченные и на сегодня. Задачи с датой начала в будущем не показываются. */
  today(todayDate: string, tz: string): { overdue: TaskView[]; today: TaskView[] } {
    const overdue: TaskView[] = [];
    const todays: TaskView[] = [];
    for (const t of this.openTasks()) {
      if (!t.due || this.deferred(t, todayDate, tz)) continue;
      const d = localDate(t.due, tz);
      if (d < todayDate) overdue.push(t);
      else if (d === todayDate) todays.push(t);
    }
    const sort = byDue(tz);
    return { overdue: overdue.sort(sort), today: todays.sort(sort) };
  }

  /** Предстоящие: задачи по дням начиная с from, days дней. */
  upcoming(from: string, days: number, tz: string): Array<{ date: string; tasks: TaskView[] }> {
    const groups = new Map<string, TaskView[]>();
    for (let i = 0; i < days; i++) groups.set(addDays(from, i), []);
    const to = addDays(from, days);
    const put = (t: TaskView) => {
      const d = localDate(t.due!, tz);
      const delta = daysBetween(from, d);
      if (delta >= 0 && delta < days) groups.get(d)!.push(t);
    };
    for (const t of this.openTasks()) {
      if (!t.due) continue;
      put(t);
      const rule = t.recurrence?.mode === 'schedule' ? parseRule(t.recurrence.rule) : null;
      if (!rule) continue;
      const start = addDays(t.due.date, 1) > from ? addDays(t.due.date, 1) : from;
      for (const occ of occurrencesBetween(rule, t.due.date, start, to, days)) {
        put({ ...t, due: { ...t.due, date: occ }, projected: true });
      }
    }
    const sort = byDue(tz);
    return [...groups.entries()].map(([date, tasks]) => ({ date, tasks: tasks.sort(sort) }));
  }

  /** Задача отложена: дата начала ещё не наступила. */
  deferred(t: Task, todayDate: string, tz: string): boolean {
    return t.start !== null && localDate(t.start, tz) > todayDate;
  }

  /** Поиск по названию и описанию без учёта регистра и буквы ё. */
  search(text: string, options: { completed?: boolean } = {}): TaskView[] {
    const needle = normalizeText(text);
    if (!needle) return [];
    const pool = options.completed ? this.allTasks() : this.openTasks();
    return pool
      .filter((t) => normalizeText(t.title).includes(needle) || normalizeText(t.description).includes(needle))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Выполненные задачи, новые первыми. */
  completedTasks(projectId?: string): TaskView[] {
    return this.allTasks()
      .filter((t) => t.completedAt !== null && (projectId === undefined || t.projectId === projectId))
      .sort((a, b) => b.completedAt! - a.completedAt!);
  }

  /** Удалённые задачи для корзины. */
  trash(): TaskView[] {
    return [...this.snapshot().tasks.values()]
      .filter((t) => t.deletedAt !== null && !this.purged(t.id))
      .sort((a, b) => b.deletedAt! - a.deletedAt!);
  }

  private purged(id: string): boolean {
    return this.replica.get('task', id)?.purged_at != null;
  }

  /**
   * Удалить задачу из корзины навсегда вместе с подзадачами. Каждое поле затирается null,
   * остаётся только отметка purged_at. Сервер хранит последнее значение каждого поля,
   * поэтому прежний зашифрованный текст с него тоже уходит. Отменить нельзя.
   */
  purgeTask(id: string): Attachment[] {
    const root = this.snapshot().tasks.get(id);
    if (!root || root.deletedAt === null || this.purged(id)) return [];
    const files: Attachment[] = [];
    const all = this.replica.all('task');
    const ids = new Set([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const [tid, rec] of all) {
        if (!ids.has(tid) && typeof rec.parent === 'string' && ids.has(rec.parent)) {
          ids.add(tid);
          grew = true;
        }
      }
    }
    const t = this.now();
    const changes: Change[] = [];
    for (const tid of ids) {
      for (const [field, value] of Object.entries(all.get(tid) ?? {})) {
        if (value !== null && field !== 'deleted_at' && field !== 'purged_at') changes.push(['task', tid, field, null]);
      }
      if (all.get(tid)?.deleted_at == null) changes.push(['task', tid, 'deleted_at', t]);
      changes.push(['task', tid, 'purged_at', t]);
    }
    for (const [cid, rec] of this.replica.all('comment')) {
      if (typeof rec.task !== 'string' || !ids.has(rec.task)) continue;
      const file = toComment(cid, rec).file;
      if (file) files.push(file);
      for (const [field, value] of Object.entries(rec)) {
        if (value !== null && field !== 'deleted_at' && field !== 'task') changes.push(['comment', cid, field, null]);
      }
      if (rec.deleted_at == null) changes.push(['comment', cid, 'deleted_at', t]);
    }
    this.write(changes, { undoable: false });
    return files;
  }

  /** Очистить корзину: все удалённые задачи навсегда. */
  /** Очистить корзину. Возвращает файлы комментариев, которые надо удалить с сервера. */
  emptyTrash(): { count: number; files: Attachment[] } {
    const roots = this.trash();
    const files = roots.flatMap((task) => this.purgeTask(task.id));
    return { count: roots.length, files };
  }
}

export function normalizeText(s: string): string {
  return s.toLocaleLowerCase('ru').replace(/ё/g, 'е').trim();
}

/** Порядок внутри дня: сначала задачи со временем по времени, потом по приоритету, потом по ручному порядку. */
function byDue(tz: string): (a: TaskView, b: TaskView) => number {
  return (a, b) => {
    const at = a.due?.time ? instant(a.due, tz) : Number.POSITIVE_INFINITY;
    const bt = b.due?.time ? instant(b.due, tz) : Number.POSITIVE_INFINITY;
    if (at !== bt) return at < bt ? -1 : 1;
    const ad = a.due ? localDate(a.due, tz) : '';
    const bd = b.due ? localDate(b.due, tz) : '';
    if (ad !== bd) return ad < bd ? -1 : 1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return compareOrder(a, b);
  };
}

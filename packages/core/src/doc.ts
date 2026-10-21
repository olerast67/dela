/**
 * Doc: задачи одного пространства поверх реплики.
 *
 * Изменения превращаются в операции над полями, получают метки HLC, применяются к реплике
 * и попадают в очередь исходящих. Запросы читают разобранный снимок, который
 * пересобирается лениво после изменений.
 */
import { habitStreak, type HabitStreak } from './habits.ts';
import { computeStats, type DoneEvent, type Stats, type StatsOptions, type WorkEvent } from './stats.ts';
import { computeGoals, type GoalProgress } from './goals.ts';
import { addDays, daysBetween, instant, isDateSpec, localDate, today as todayIn, type DateSpec } from './dates.ts';
import type { CommentSigned } from './crypto.ts';
import { normalizeCalendarUrl, toCalendarSub, type CalendarSub } from './events.ts';
import { compareOrder, keyBetween, keysBetween } from './fractional.ts';
import type { HybridClock } from './hlc.ts';
import {
  LABEL_PREFIX,
  toCompletion,
  toFilter,
  toLabel,
  toProject,
  toSection,
  toTask,
  toWorkLog,
  toSkip,
  toPostpone,
  type Postpone,
  type Completion,
  type Habit,
  type Skip,
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
  type WorkLog,
} from './model.ts';
import type { Json, Op } from './op.ts';
import { gameSettingsChanges, readGameSettings, GAME_RECORD, GAME_TABLE, type GameSettings } from './game.ts';
import { clampRadius, coordValue, toPlace, placeValue, type PlaceReminder, type SavedPlace } from './places.ts';
import { nextOccurrence, occurrencesBetween, parseRule } from './recurrence.ts';
import { MemoryReplica } from './replica.ts';
import { uuidv7 } from './uuid.ts';

export type Change = readonly [table: string, record: string, field: string, value: Json];
export type Origin = 'local' | 'remote';
/** undoable: локальная запись попала в историю отмены. */
export interface ActivityEvent {
  readonly kind: 'created' | 'completed' | 'deleted' | 'comment';
  readonly at: number;
  readonly taskId: string;
  readonly title: string;
  readonly projectId: string;
  /** Кто сделал (id пользователя), если известно. */
  readonly actor: string | null;
  readonly text?: string;
}

export type Listener = (ops: readonly Op[], origin: Origin, undoable?: boolean) => void;

/** Задача с действующими значениями: проект, раздел и родитель после разбора дерева. */
export interface TaskView extends Task {
  readonly depth: number;
  readonly childCount: number;
  /** Сколько комментариев у задачи. */
  readonly commentCount?: number;
  /** Затраченное время в минутах: сумма отрезков работы (помодоро и правок вручную). */
  readonly spent?: number;
  /** Будущий экземпляр повторяющейся задачи, показанный в «Предстоящих»; сам по себе не существует. */
  readonly projected?: boolean;
  /** Выполненный экземпляр повторяющейся задачи (дата экземпляра): строка «выполнено сегодня» в «Сегодня». */
  readonly doneOccurrence?: string;
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
  readonly habit?: Habit | null;
  readonly reminders?: readonly number[] | null;
  readonly alarm?: boolean;
  readonly place?: PlaceReminder | null;
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
  readonly habit?: Habit | null;
  readonly reminders?: readonly number[] | null;
  readonly alarm?: boolean;
  readonly place?: PlaceReminder | null;
  readonly assignee?: string | null;
}

const PROJECT_PALETTE = ['blue', 'green', 'orange', 'violet', 'teal', 'red', 'pink', 'yellow', 'brown'] as const;

/** Таблицы с мягким удалением: отмена создания помечает запись удалённой. */
const DELETABLE = new Set(['task', 'project', 'section', 'label', 'filter', 'comment', 'template', 'work', 'place', 'calendar', 'postpone']);

const TASK_PATCH_FIELDS: Record<keyof TaskPatch, string> = {
  title: 'title',
  description: 'description',
  priority: 'priority',
  start: 'start',
  due: 'due',
  deadline: 'deadline',
  duration: 'duration',
  recurrence: 'recurrence',
  habit: 'habit',
  reminders: 'reminders',
  alarm: 'alarm',
  place: 'place',
  assignee: 'assignee',
};

interface Snapshot {
  readonly projects: ReadonlyMap<string, Project>;
  readonly sections: ReadonlyMap<string, Section>;
  readonly tasks: ReadonlyMap<string, TaskView>;
  readonly labels: ReadonlyMap<string, Label>;
  readonly filters: ReadonlyMap<string, SavedFilter>;
  readonly completions: ReadonlyMap<string, Completion>;
  readonly work: ReadonlyMap<string, WorkLog>;
  readonly skips: ReadonlyMap<string, Skip>;
  /** Серии привычек, посчитанные для этого снимка: ключ — задача и сегодняшняя дата. */
  readonly habits: Map<string, HabitStreak>;
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
  /** Кто делает правки на этом устройстве (id пользователя): для истории в общих проектах. */
  actor: string | null = null;

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
  write(changes: readonly Change[], options: { undoable?: boolean; postpones?: boolean } = {}): Op[] {
    if (changes.length === 0) return [];
    // Перенос срока на более позднюю дату пишет запись о переносе в том же действии: отмена снимет и её.
    if (options.undoable !== false && options.postpones !== false) changes = [...changes, ...this.postponeChanges(changes)];
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
    const skips = new Map<string, Skip>();
    for (const [id, rec] of r.all('skip')) {
      const k = toSkip(id, rec);
      if (k) skips.set(id, k);
    }
    const work = new Map<string, WorkLog>();
    const spent = new Map<string, number>();
    for (const [id, rec] of r.all('work')) {
      const w = toWorkLog(id, rec);
      if (!w) continue;
      work.set(id, w);
      spent.set(w.taskId, (spent.get(w.taskId) ?? 0) + w.minutes);
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
        spent: spent.get(id) ?? 0,
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
      work,
      skips,
      habits: new Map(),
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
    patch: { name?: string; description?: string; color?: string; view?: ProjectView; favorite?: boolean; archived?: boolean },
  ): void {
    const changes: Change[] = [];
    if (patch.name !== undefined) changes.push(['project', id, 'name', patch.name.trim()]);
    if (patch.description !== undefined) changes.push(['project', id, 'description', patch.description.trimEnd()]);
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

  updateSection(id: string, patch: { name?: string; description?: string; collapsed?: boolean }): void {
    const changes: Change[] = [];
    if (patch.name !== undefined) changes.push(['section', id, 'name', patch.name.trim()]);
    if (patch.description !== undefined) changes.push(['section', id, 'description', patch.description.trimEnd()]);
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
      ...(this.actor && this.kind === 'shared' ? ([['task', id, 'created_by', this.actor]] as Change[]) : []),
    ];
    if (input.description) changes.push(['task', id, 'description', input.description]);
    if (input.priority !== undefined && input.priority !== 4) changes.push(['task', id, 'priority', input.priority]);
    if (input.start) changes.push(['task', id, 'start', input.start as unknown as Json]);
    if (input.due) changes.push(['task', id, 'due', input.due as unknown as Json]);
    if (input.deadline) changes.push(['task', id, 'deadline', input.deadline]);
    if (input.duration) changes.push(['task', id, 'duration', input.duration]);
    if (input.recurrence) changes.push(['task', id, 'recurrence', input.recurrence as unknown as Json]);
    if (input.habit) changes.push(['task', id, 'habit', input.habit as unknown as Json]);
    if (input.reminders) changes.push(['task', id, 'reminders', [...input.reminders]]);
    if (input.alarm) changes.push(['task', id, 'alarm', true]);
    if (input.place) changes.push(['task', id, 'place', placeValue(input.place)]);
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
      if (key === 'place' && value !== null) value = placeValue(patch.place!);
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
    if (this.actor && this.kind === 'shared') changes.push(['task', id, 'completed_by', this.actor]);
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
      if (this.actor && this.kind === 'shared') changes.push(['completion', cid, 'by', this.actor]);
    } else if (task.habit) {
      // Пропуск привычки помнится отдельной записью на экземпляр: серия его не считает обрывом.
      const sid = Doc.completionId(task.id, occurrence);
      changes.push(['skip', sid, 'task', task.id], ['skip', sid, 'occurrence', occurrence], ['skip', sid, 'at', t]);
      if (this.actor && this.kind === 'shared') changes.push(['skip', sid, 'by', this.actor]);
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
    // Срок повтора сдвигает выполнение или пропуск экземпляра: это не перенос.
    this.write(changes, { postpones: false });
  }

  /**
   * Вернуть выполненный экземпляр повторяющейся задачи: срок снова на дату экземпляра, выполнение снимается.
   * Можно только для последнего выполнения и пока срок стоит там, куда его перенесло выполнение:
   * иначе потерялась бы чужая или более поздняя правка срока.
   */
  uncompleteOccurrence(taskId: string, occurrence: string): boolean {
    const changes = this.uncompletePlan(taskId, occurrence);
    if (!changes) return false;
    this.write(changes);
    return true;
  }

  canUncompleteOccurrence(taskId: string, occurrence: string): boolean {
    return this.uncompletePlan(taskId, occurrence) !== null;
  }

  private uncompletePlan(taskId: string, occurrence: string): Change[] | null {
    const s = this.snapshot();
    const task = s.tasks.get(taskId);
    const c = s.completions.get(Doc.completionId(taskId, occurrence));
    if (!task || !c || !s.alive.has(taskId) || task.completedAt !== null || !task.recurrence || !task.due) return null;
    for (const o of s.completions.values()) if (o.taskId === taskId && o.occurrence !== null && o.occurrence > occurrence) return null;
    const rule = parseRule(task.recurrence.rule);
    if (!rule) return null;
    // Куда выполнение перенесло срок; если сейчас срок другой, его меняли после выполнения.
    const day = todayIn(this.timeZone, c.completedAt);
    const expected =
      task.recurrence.mode === 'completion' ? nextOccurrence(rule, day, day) : nextOccurrence(rule, occurrence, occurrence > day ? occurrence : day);
    if (expected !== task.due.date) return null;
    const changes: Change[] = [
      ['task', taskId, 'due', { ...task.due, date: occurrence } as unknown as Json],
      // Запись о выполнении без отметки времени не считается выполнением: так же её снимает отмена действия.
      ['completion', c.id, 'completed_at', null],
    ];
    if (task.start) {
      const shifted = addDays(task.start.date, -daysBetween(occurrence, task.due.date));
      changes.push(['task', taskId, 'start', { ...task.start, date: shifted } as unknown as Json]);
    }
    return changes;
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

  // ---------- история ----------

  /**
   * История действий по отметкам времени, которые и так лежат в записях: создание, выполнение
   * (в том числе каждого повтора), удаление, комментарии. Автор известен в общих проектах.
   */
  activity(): ActivityEvent[] {
    const out: ActivityEvent[] = [];
    const tasks = this.replica.all('task');
    const info = (id: string) => {
      const rec = tasks.get(id);
      if (!rec || rec.purged_at != null) return null;
      return { title: typeof rec.title === 'string' ? rec.title : '', projectId: typeof rec.project === 'string' ? rec.project : '' };
    };
    const who = (v: Json | undefined) => (typeof v === 'string' ? v : null);
    for (const [id, rec] of tasks) {
      const t = info(id);
      if (!t) continue;
      if (typeof rec.created_at === 'number') out.push({ kind: 'created', at: rec.created_at, taskId: id, ...t, actor: who(rec.created_by) });
      if (typeof rec.completed_at === 'number') out.push({ kind: 'completed', at: rec.completed_at, taskId: id, ...t, actor: who(rec.completed_by) });
      if (typeof rec.deleted_at === 'number') out.push({ kind: 'deleted', at: rec.deleted_at, taskId: id, ...t, actor: null });
    }
    for (const [, rec] of this.replica.all('completion')) {
      const id = typeof rec.task === 'string' ? rec.task : '';
      const t = info(id);
      if (t && typeof rec.completed_at === 'number') out.push({ kind: 'completed', at: rec.completed_at, taskId: id, ...t, actor: who(rec.by) });
    }
    for (const [, rec] of this.replica.all('comment')) {
      const id = typeof rec.task === 'string' ? rec.task : '';
      const t = info(id);
      if (t && rec.deleted_at == null && typeof rec.created_at === 'number') {
        out.push({ kind: 'comment', at: rec.created_at, taskId: id, ...t, actor: who(rec.author), text: typeof rec.text === 'string' ? rec.text : '' });
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  // ---------- шаблоны ----------

  saveTemplate(name: string, data: unknown): string {
    const id = uuidv7(this.now());
    this.write([
      ['template', id, 'name', name.trim()],
      ['template', id, 'data', data as Json],
      ['template', id, 'created_at', this.now()],
    ]);
    return id;
  }

  deleteTemplate(id: string): void {
    this.write(
      [
        ['template', id, 'data', null],
        ['template', id, 'deleted_at', this.now()],
      ],
      { undoable: false },
    );
  }

  templates(): Array<{ id: string; name: string; data: Json; createdAt: number }> {
    const out: Array<{ id: string; name: string; data: Json; createdAt: number }> = [];
    for (const [id, rec] of this.replica.all('template')) {
      if (rec.deleted_at != null || rec.data == null) continue;
      out.push({ id, name: typeof rec.name === 'string' ? rec.name : '', data: rec.data, createdAt: typeof rec.created_at === 'number' ? rec.created_at : 0 });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  // ---------- сохранённые места ----------

  /** Место для напоминаний по месту («Дом», «Работа»). Хранится в личном пространстве, координаты зашифрованы. */
  savePlace(input: { name: string; lat: number; lon: number; radius: number }): string {
    const id = uuidv7(this.now());
    this.write([
      ['place', id, 'name', input.name.trim().slice(0, 100)],
      ['place', id, 'lat', coordValue(input.lat)],
      ['place', id, 'lon', coordValue(input.lon)],
      ['place', id, 'radius', clampRadius(input.radius)],
      ['place', id, 'created_at', this.now()],
    ]);
    return id;
  }

  deletePlace(id: string): void {
    // Координаты стираются: удалённое место не должно хранить, где оно было.
    this.write([
      ['place', id, 'lat', null],
      ['place', id, 'lon', null],
      ['place', id, 'deleted_at', this.now()],
    ]);
  }

  places(): SavedPlace[] {
    const out: SavedPlace[] = [];
    for (const [id, rec] of this.replica.all('place')) {
      const p = toPlace(id, rec);
      if (p && p.deletedAt === null) out.push(p);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'ru') || a.createdAt - b.createdAt);
  }

  // ---------- игровые элементы ----------

  /** Настройки игровых элементов (game.ts): одна запись, поля сливаются по ячейкам; без записи — умолчания. */
  getGameSettings(): GameSettings {
    return readGameSettings(this.replica.get(GAME_TABLE, GAME_RECORD));
  }

  /** Записать изменённые поля. Неверное значение — RangeError. Настройки не отменяются Ctrl+Z вместе с задачами. */
  updateGameSettings(patch: Partial<GameSettings>): void {
    const current = this.getGameSettings();
    const changes = gameSettingsChanges(current, patch).filter(([, , field, value]) => JSON.stringify(this.replica.get(GAME_TABLE, GAME_RECORD)?.[field]) !== JSON.stringify(value));
    this.write(changes, { undoable: false });
  }

  // ---------- комментарии ----------

  addComment(
    taskId: string,
    input: { text: string; author: string | null; file?: Attachment | null; sign?: (c: CommentSigned) => string },
  ): string {
    const id = uuidv7(this.now());
    const text = input.text.trim();
    const createdAt = this.now();
    const changes: Change[] = [
      ['comment', id, 'task', taskId],
      ['comment', id, 'text', text],
      ['comment', id, 'author', input.author],
      ['comment', id, 'created_at', createdAt],
    ];
    if (input.file) changes.push(['comment', id, 'file', { ...input.file }]);
    if (input.sign) {
      changes.push(['comment', id, 'sig', input.sign({ spaceId: this.spaceId, id, taskId, author: input.author, createdAt, text, file: input.file ?? null })]);
    }
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

  // ---------- затраченное время ----------

  /**
   * Записать отрезок работы над задачей. Id задаёт вызывающий: таймер передаёт id своего отрезка,
   * поэтому повторная запись того же отрезка (две вкладки, перезапуск) не удваивает время.
   */
  logWork(taskId: string, minutes: number, input: { id?: string; at?: number; focus?: 'full' | 'cut' } = {}): string | null {
    const m = Math.round(minutes);
    if (m <= 0) return null;
    const id = input.id ?? uuidv7(this.now());
    const changes: Change[] = [
      ['work', id, 'task', taskId],
      ['work', id, 'minutes', m],
      ['work', id, 'at', input.at ?? this.now()],
    ];
    // Отрезок таймера: закончен или прерван. По этой отметке сад сажает дерево фокуса или росток.
    if (input.focus) changes.push(['work', id, 'focus', input.focus]);
    if (this.actor && this.kind === 'shared') changes.push(['work', id, 'by', this.actor]);
    // Время от таймера не отменяется Ctrl+Z вместе с соседними правками.
    this.write(changes, { undoable: false });
    return id;
  }

  /**
   * Поправить затраченное время вручную: известные отрезки помечаются удалёнными, вместо них один новый.
   * Отрезок, который другое устройство записало, пока эта правка не дошла, сохранится и прибавится.
   */
  setSpent(taskId: string, minutes: number): void {
    const t = this.now();
    const changes: Change[] = [];
    for (const w of this.snapshot().work.values()) if (w.taskId === taskId) changes.push(['work', w.id, 'deleted_at', t]);
    const m = Math.round(minutes);
    if (m > 0) {
      const id = uuidv7(t);
      changes.push(['work', id, 'task', taskId], ['work', id, 'minutes', m], ['work', id, 'at', t]);
    }
    this.write(changes);
  }

  // ---------- привычки ----------

  /** Явные пропуски экземпляров, новые первыми. */
  skips(taskId?: string): Skip[] {
    return [...this.snapshot().skips.values()].filter((k) => taskId === undefined || k.taskId === taskId).sort((a, b) => b.at - a.at);
  }

  /**
   * Серия привычки на дату today (по умолчанию сегодня в поясе пространства).
   * null, если задача не привычка или у неё нет повтора.
   */
  habitStreak(taskId: string, today = todayIn(this.timeZone, this.now()), tz = this.timeZone): HabitStreak | null {
    const s = this.snapshot();
    const task = s.tasks.get(taskId);
    if (!task?.habit || !task.recurrence) return null;
    const key = `${taskId}|${today}|${tz}`;
    const cached = s.habits.get(key);
    if (cached) return cached;
    const occurrences: string[] = [];
    const doneDays: string[] = [];
    for (const c of s.completions.values()) {
      if (c.taskId !== taskId) continue;
      if (c.occurrence !== null) occurrences.push(c.occurrence);
      doneDays.push(todayIn(tz, c.completedAt));
    }
    const skips = [...s.skips.values()].filter((k) => k.taskId === taskId).map((k) => k.occurrence);
    const result = habitStreak({ recurrence: task.recurrence, habit: task.habit, occurrences, doneDays, skips, due: task.due?.date ?? null, today });
    s.habits.set(key, result);
    return result;
  }

  /**
   * Перенести историю привычки (выполнения и пропуски) к копии задачи в этом пространстве:
   * id записей считаются от нового id задачи, отметки времени прежние.
   */
  importHabitHistory(taskId: string, completions: readonly Completion[], skips: readonly Skip[]): void {
    const changes: Change[] = [];
    for (const c of completions) {
      if (c.occurrence === null) continue;
      const cid = Doc.completionId(taskId, c.occurrence);
      changes.push(['completion', cid, 'task', taskId], ['completion', cid, 'occurrence', c.occurrence], ['completion', cid, 'completed_at', c.completedAt]);
    }
    for (const k of skips) {
      const sid = Doc.completionId(taskId, k.occurrence);
      changes.push(['skip', sid, 'task', taskId], ['skip', sid, 'occurrence', k.occurrence], ['skip', sid, 'at', k.at]);
    }
    this.write(changes);
  }

  // ---------- переносы срока ----------

  /**
   * Записи о переносах для изменений срока в changes: открытая задача, срок был и стал позже по дате.
   * Убрать срок или перенести раньше — не перенос.
   */
  private postponeChanges(changes: readonly Change[]): Change[] {
    const out: Change[] = [];
    const seen = new Set<string>();
    for (const [table, id, field, value] of changes) {
      if (table !== 'task' || field !== 'due' || seen.has(id)) continue;
      const rec = this.replica.get('task', id);
      if (!rec || rec.completed_at != null || rec.deleted_at != null) continue;
      const from = rec.due;
      if (!isDateSpec(from) || !isDateSpec(value) || value.date <= from.date) continue;
      seen.add(id);
      const pid = uuidv7(this.now());
      out.push(['postpone', pid, 'task', id], ['postpone', pid, 'from', from.date], ['postpone', pid, 'to', value.date], ['postpone', pid, 'at', this.now()]);
    }
    return out;
  }

  /** Переносы срока задач, которые видны (не в корзине), старые первыми. */
  postpones(): Postpone[] {
    const s = this.snapshot();
    const out: Postpone[] = [];
    for (const [id, rec] of this.replica.all('postpone')) {
      const p = toPostpone(id, rec);
      if (p && s.alive.has(p.taskId)) out.push(p);
    }
    return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  }

  /** Отметка «Оставить» в итогах недели: переносы до неё не считаются. 0 — отметки нет. */
  postponeKeptAt(taskId: string): number {
    const v = this.replica.get('task', taskId)?.postpone_kept;
    return typeof v === 'number' ? v : 0;
  }

  /** «Оставить» задачу, которую часто переносят: счёт переносов начинается заново. */
  keepPostponed(taskId: string): void {
    this.write([['task', taskId, 'postpone_kept', this.now()]]);
  }

  /** Отрезки работы для статистики: без задач из корзины. */

  workEvents(): WorkEvent[] {
    const s = this.snapshot();
    const out: WorkEvent[] = [];
    for (const w of s.work.values()) if (s.alive.has(w.taskId)) out.push(w.focus ? { at: w.at, minutes: w.minutes, focus: w.focus } : { at: w.at, minutes: w.minutes });
    return out;
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

  // ---------- подписки на календари ----------

  /** Подписка на календарь iCal. Ссылка — секрет: она живёт только в зашифрованной записи пространства. */
  addCalendar(input: { name: string; url: string; color?: string }): string {
    const url = normalizeCalendarUrl(input.url);
    if (!url) throw new Error('bad calendar url');
    const id = uuidv7(this.now());
    this.write([
      ['calendar', id, 'name', input.name.trim()],
      ['calendar', id, 'url', url],
      ['calendar', id, 'color', input.color ?? 'blue'],
      ['calendar', id, 'order', this.orderBetween(this.calendars(), id)],
      ['calendar', id, 'created_at', this.now()],
    ]);
    return id;
  }

  updateCalendar(id: string, patch: { name?: string; url?: string; color?: string; enabled?: boolean }): void {
    const changes: Change[] = [];
    if (patch.name !== undefined) changes.push(['calendar', id, 'name', patch.name.trim()]);
    if (patch.url !== undefined) {
      const url = normalizeCalendarUrl(patch.url);
      if (!url) throw new Error('bad calendar url');
      changes.push(['calendar', id, 'url', url]);
    }
    if (patch.color !== undefined) changes.push(['calendar', id, 'color', patch.color]);
    if (patch.enabled !== undefined) changes.push(['calendar', id, 'off', !patch.enabled]);
    this.write(changes);
  }

  /** Удалить подписку: ссылка стирается из записи, отменить нельзя. */
  deleteCalendar(id: string): void {
    this.write(
      [
        ['calendar', id, 'url', null],
        ['calendar', id, 'deleted_at', this.now()],
      ],
      { undoable: false },
    );
  }

  /** Живые подписки по порядку, включая выключенные. */
  calendars(): CalendarSub[] {
    const out: CalendarSub[] = [];
    for (const [id, rec] of this.replica.all('calendar')) {
      const c = toCalendarSub(id, rec);
      if (c.deletedAt === null && c.url) out.push(c);
    }
    return out.sort(compareOrder);
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
    return { overdue: dayOrdered(overdue, todayDate, tz), today: dayOrdered(todays, todayDate, tz) };
  }

  /**
   * Повторяющиеся задачи, чей экземпляр выполнен в день todayDate: в «Сегодня» они остаются отмеченными до конца дня.
   * Срок у строки — дата выполненного экземпляра, completedAt — время выполнения.
   */
  doneToday(todayDate: string, tz: string): TaskView[] {
    const s = this.snapshot();
    const open = new Set(this.openTasks().map((t) => t.id));
    const out: TaskView[] = [];
    for (const c of s.completions.values()) {
      const t = s.tasks.get(c.taskId);
      // Закрытая серия — обычная выполненная задача, её здесь нет.
      if (!t || c.occurrence === null || !t.recurrence || !open.has(t.id) || todayIn(tz, c.completedAt) !== todayDate) continue;
      out.push({ ...t, due: { ...(t.due ?? {}), date: c.occurrence }, completedAt: c.completedAt, doneOccurrence: c.occurrence });
    }
    return out.sort((a, b) => a.completedAt! - b.completedAt!);
  }

  /** Список задач деревом: под задачей её открытые подзадачи, без повторов (см. nestTasks). */
  nested(tasks: readonly TaskView[]): TaskNode[] {
    return nestTasks(this, tasks);
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
    return [...groups.entries()].map(([date, tasks]) => ({ date, tasks: dayOrdered(tasks, date, tz) }));
  }

  /**
   * Поставить задачу в ручном порядке дня date перед или после другой. list — задачи дня в показанном порядке
   * (верхний уровень). Если у остальных уже есть возрастающие ключи этого дня, пишется один ключ; иначе
   * ключи получает весь день, чтобы показанный порядок закрепился. due — новый срок в том же действии
   * (задача пришла из другого дня).
   */
  placeInDay(id: string, date: string, list: readonly string[], position: Position, due?: DateSpec): void {
    this.write(dayOrderChanges((x) => this.snapshot().tasks.get(x), id, date, list, position, due));
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

  /**
   * Выполнения для статистики: выполненные задачи и каждый выполненный экземпляр повторяющихся.
   * Как и «Выполненные», без задач из корзины. Закрытая серия записана и задачей, и экземпляром с тем же временем — считается один раз.
   */
  doneEvents(): DoneEvent[] {
    const s = this.snapshot();
    const out: DoneEvent[] = [];
    const closed = new Set<string>();
    for (const c of s.completions.values()) {
      const t = s.tasks.get(c.taskId);
      if (!t || !s.alive.has(t.id)) continue;
      out.push(t.habit ? { at: c.completedAt, projectId: t.projectId, habit: true } : { at: c.completedAt, projectId: t.projectId });
      closed.add(`${t.id}:${c.completedAt}`);
    }
    for (const t of this.allTasks()) {
      if (t.completedAt !== null && !closed.has(`${t.id}:${t.completedAt}`)) {
        out.push(t.recurrence || !t.createdAt ? { at: t.completedAt, projectId: t.projectId } : { at: t.completedAt, projectId: t.projectId, createdAt: t.createdAt });
      }
    }
    return out;
  }

  /** Статистика выполненного по дням и неделям в поясе tz на дату today. */
  stats(tz: string, today: string, opts?: StatsOptions): Stats {
    return computeStats(this.doneEvents(), tz, today, { ...opts, work: this.workEvents() });
  }

  /** Цели дня и недели и серия целей (goals.ts). */
  goals(tz: string, today: string): GoalProgress {
    return computeGoals(this.doneEvents(), this.getGameSettings(), tz, today);
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
    for (const [wid, rec] of this.replica.all('work')) {
      if (typeof rec.task === 'string' && ids.has(rec.task) && rec.deleted_at == null) changes.push(['work', wid, 'deleted_at', t]);
    }
    for (const [pid, rec] of this.replica.all('postpone')) {
      if (typeof rec.task === 'string' && ids.has(rec.task) && rec.deleted_at == null) changes.push(['postpone', pid, 'deleted_at', t]);
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

/**
 * Плоский список задач («Сегодня», «Предстоящие», фильтр) деревом: под задачей — все её открытые подзадачи.
 * Задача, чей предок тоже в списке, отдельно не показывается: она уже в его поддереве.
 * Порядок верхнего уровня — как в списке; будущие и выполненные экземпляры повторов идут без подзадач.
 */
export function nestTasks(src: { task(id: string): TaskView | undefined; subtasks(id: string): TaskNode[] }, tasks: readonly TaskView[]): TaskNode[] {
  const plain = (t: TaskView) => t.projected || t.doneOccurrence !== undefined;
  const ids = new Set(tasks.filter((t) => !plain(t)).map((t) => t.id));
  const out: TaskNode[] = [];
  for (const t of tasks) {
    if (plain(t)) {
      out.push({ task: t, children: [] });
      continue;
    }
    let inside = false;
    for (let p = t.parentId; p !== null && !inside; p = src.task(p)?.parentId ?? null) inside = ids.has(p);
    if (!inside) out.push({ task: t, children: src.subtasks(t.id) });
  }
  return out;
}

export function normalizeText(s: string): string {
  return s.toLocaleLowerCase('ru').replace(/ё/g, 'е').trim();
}

/** Правки для placeInDay; get — задача по id (в Workspace задачи дня лежат в разных пространствах). */
export function dayOrderChanges(
  get: (id: string) => TaskView | undefined,
  id: string,
  date: string,
  list: readonly string[],
  position: Position,
  due?: DateSpec,
): Change[] {
  if (!get(id)) return [];
  const order = list.filter((x) => x !== id && get(x));
  const anchor = position.after ?? position.before;
  let at = anchor ? order.indexOf(anchor) : -1;
  if (at < 0) at = order.length;
  else if (position.after) at++;
  const keyOf = (x: string): string | null => {
    const d = get(x)!.dayOrder;
    return d && d.date === date ? d.key : null;
  };
  const keys = order.map(keyOf);
  const sorted = keys.every((k, i) => k !== null && (i === 0 || keys[i - 1]! < k));
  const changes: Change[] = due ? [['task', id, 'due', due as unknown as Json]] : [];
  if (sorted) {
    changes.push(['task', id, 'day_order', { date, key: keyBetween(keys[at - 1] ?? null, keys[at] ?? null) }]);
  } else {
    const all = [...order.slice(0, at), id, ...order.slice(at)];
    const fresh = keysBetween(null, null, all.length);
    all.forEach((x, i) => {
      if (keyOf(x) !== fresh[i]) changes.push(['task', x, 'day_order', { date, key: fresh[i]! }]);
    });
  }
  return changes;
}

/**
 * Задачи одного дня: переставленные вручную в этот день идут по своим ключам, остальные — по byDue.
 * Неупорядоченная задача встаёт перед первой упорядоченной, которую byDue ставит после неё:
 * новая задача на сегодня появляется там же, где была бы без ручного порядка относительно соседей.
 */
export function dayOrdered(tasks: readonly TaskView[], date: string, tz: string): TaskView[] {
  const sort = byDue(tz);
  const manual: TaskView[] = [];
  const rest: TaskView[] = [];
  for (const t of tasks) (t.dayOrder?.date === date && !t.projected ? manual : rest).push(t);
  rest.sort(sort);
  if (manual.length === 0) return rest;
  manual.sort((a, b) => (a.dayOrder!.key < b.dayOrder!.key ? -1 : a.dayOrder!.key > b.dayOrder!.key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: TaskView[] = [];
  let i = 0;
  let j = 0;
  while (i < manual.length || j < rest.length) {
    if (j < rest.length && (i >= manual.length || sort(rest[j]!, manual[i]!) < 0)) out.push(rest[j++]!);
    else out.push(manual[i++]!);
  }
  return out;
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

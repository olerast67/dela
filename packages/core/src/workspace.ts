/**
 * Workspace: личное пространство и общие проекты как одно целое для интерфейса.
 *
 * Каждое пространство — свой Doc со своим ключом. Запросы («Сегодня», поиск, фильтры)
 * собираются по всем, изменения уходят в пространство нужной записи. Перенос задачи
 * между пространствами — это создание копии в одном и удаление в другом: так данные
 * перешифровываются ключом нового пространства.
 */
import { localDate, instant } from './dates.ts';
import type { CommentSigned } from './crypto.ts';
import type { ActivityEvent, Change, Doc, Listener, Position, ProjectNode, ProjectTasks, TaskInput, TaskNode, TaskPatch, TaskView } from './doc.ts';
import { nestTasks } from './doc.ts';
import { computeStats, type Stats, type StatsOptions } from './stats.ts';
import { compareOrder } from './fractional.ts';
import type { Attachment, Comment, Completion, Label, Project, ProjectView, SavedFilter, Section } from './model.ts';

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

export class Workspace {
  readonly personal: Doc;
  private readonly shared = new Map<string, Doc>();
  private readonly listeners = new Set<Listener>();
  private readonly unsub = new Map<Doc, () => void>();
  /** Отмена: каждая запись — документы, записавшие изменения в одном действии пользователя. */
  private readonly undoStack: Doc[][] = [];
  private recording: Doc[] | null = null;
  private undoing = false;

  constructor(personal: Doc) {
    this.personal = personal;
    this.watch(personal);
  }

  private watch(doc: Doc): void {
    this.unsub.set(
      doc,
      doc.subscribe((ops, origin, undoable) => {
        if (origin === 'local' && undoable && !this.undoing) {
          if (this.recording) this.recording.push(doc);
          else this.undoStack.push([doc]);
          if (this.undoStack.length > 100) this.undoStack.shift();
        }
        for (const fn of this.listeners) fn(ops, origin, undoable);
      }),
    );
  }

  /** Несколько изменений как одна запись отмены: действия над выделенными задачами. */
  group<T>(fn: () => T): T {
    return this.batch(fn);
  }

  /** Выполнить действие как одну запись отмены, даже если оно пишет в несколько пространств. */
  private batch<T>(fn: () => T): T {
    const outer = this.recording === null;
    if (outer) this.recording = [];
    try {
      return fn();
    } finally {
      if (outer) {
        const docs = this.recording!;
        this.recording = null;
        if (docs.length > 0) this.undoStack.push(docs);
      }
    }
  }

  // ---------- пространства ----------

  addShared(doc: Doc): void {
    if (this.shared.has(doc.spaceId)) return;
    this.shared.set(doc.spaceId, doc);
    doc.actor = this.actor;
    this.watch(doc);
    for (const fn of this.listeners) fn([], 'remote');
  }

  removeShared(spaceId: string): void {
    const doc = this.shared.get(spaceId);
    if (!doc) return;
    this.unsub.get(doc)?.();
    this.unsub.delete(doc);
    this.shared.delete(spaceId);
    for (let i = this.undoStack.length - 1; i >= 0; i--) if (this.undoStack[i]!.includes(doc)) this.undoStack.splice(i, 1);
    for (const fn of this.listeners) fn([], 'remote');
  }

  docs(): Doc[] {
    return [this.personal, ...this.shared.values()];
  }

  sharedDoc(spaceId: string): Doc | undefined {
    return this.shared.get(spaceId);
  }

  isShared(projectId: string): boolean {
    return this.shared.has(projectId);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get inboxId(): string {
    return this.personal.inboxId;
  }

  get timeZone(): string {
    return this.personal.timeZone;
  }

  /** Пространство проекта (общий проект — своё пространство, остальные — личное). */
  docForProject(projectId: string | undefined): Doc {
    return (projectId && this.shared.get(projectId)) || this.personal;
  }

  docForTask(taskId: string): Doc {
    for (const d of this.docs()) if (d.task(taskId)) return d;
    return this.personal;
  }

  private docForSection(sectionId: string): Doc {
    for (const d of this.docs()) {
      const projectIds = [d.inboxId, ...d.projects().map((p) => p.project.id), ...d.projects({ archived: true }).map((p) => p.project.id)];
      if (projectIds.some((pid) => d.sections(pid).some((s) => s.id === sectionId))) return d;
    }
    return this.personal;
  }

  // ---------- запросы ----------

  project(id: string): Project | undefined {
    return this.docForProject(id).project(id);
  }

  projects(options: { archived?: boolean } = {}): ProjectNode[] {
    const shared = [...this.shared.values()]
      .flatMap((d) => d.projects(options))
      .sort((a, b) => a.project.name.localeCompare(b.project.name, 'ru'));
    return [...this.personal.projects(options), ...shared];
  }

  sections(projectId: string): Section[] {
    return this.docForProject(projectId).sections(projectId);
  }

  projectTasks(projectId: string, options: { completed?: boolean } = {}): ProjectTasks {
    return this.docForProject(projectId).projectTasks(projectId, options);
  }

  subtasks(id: string, options: { completed?: boolean } = {}): TaskNode[] {
    return this.docForTask(id).subtasks(id, options);
  }

  labels(): Label[] {
    return this.personal.labels();
  }

  label(id: string): Label | undefined {
    return this.personal.label(id);
  }

  filters(): SavedFilter[] {
    return this.personal.filters();
  }

  task(id: string): TaskView | undefined {
    for (const d of this.docs()) {
      const t = d.task(id);
      if (t) return t;
    }
    return undefined;
  }

  isAlive(id: string): boolean {
    return this.docForTask(id).isAlive(id);
  }

  allTasks(): TaskView[] {
    return this.docs().flatMap((d) => d.allTasks());
  }

  openTasks(): TaskView[] {
    return this.docs().flatMap((d) => d.openTasks());
  }

  completions(taskId?: string): Completion[] {
    return this.docs()
      .flatMap((d) => d.completions(taskId))
      .sort((a, b) => b.completedAt - a.completedAt);
  }

  today(todayDate: string, tz: string): { overdue: TaskView[]; today: TaskView[] } {
    const parts = this.docs().map((d) => d.today(todayDate, tz));
    const sort = byDue(tz);
    return { overdue: parts.flatMap((p) => p.overdue).sort(sort), today: parts.flatMap((p) => p.today).sort(sort) };
  }

  doneToday(todayDate: string, tz: string): TaskView[] {
    return this.docs()
      .flatMap((d) => d.doneToday(todayDate, tz))
      .sort((a, b) => a.completedAt! - b.completedAt!);
  }

  nested(tasks: readonly TaskView[]): TaskNode[] {
    return nestTasks(this, tasks);
  }

  upcoming(from: string, days: number, tz: string): Array<{ date: string; tasks: TaskView[] }> {
    const parts = this.docs().map((d) => d.upcoming(from, days, tz));
    const sort = byDue(tz);
    return parts[0]!.map((g, i) => ({ date: g.date, tasks: parts.flatMap((p) => p[i]!.tasks).sort(sort) }));
  }

  deferred(t: TaskView, todayDate: string, tz: string): boolean {
    return this.personal.deferred(t, todayDate, tz);
  }

  search(text: string, options: { completed?: boolean } = {}): TaskView[] {
    return this.docs()
      .flatMap((d) => d.search(text, options))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  completedTasks(projectId?: string): TaskView[] {
    const docs = projectId === undefined ? this.docs() : [this.docForProject(projectId)];
    return docs.flatMap((d) => d.completedTasks(projectId)).sort((a, b) => b.completedAt! - a.completedAt!);
  }

  /** Статистика выполненного по личному и общим проектам вместе. */
  stats(tz: string, today: string, opts?: StatsOptions): Stats {
    return computeStats(this.docs().flatMap((d) => d.doneEvents()), tz, today, { ...opts, work: this.docs().flatMap((d) => d.workEvents()) });
  }

  trash(): TaskView[] {
    return this.docs()
      .flatMap((d) => d.trash())
      .sort((a, b) => b.deletedAt! - a.deletedAt!);
  }

  // ---------- изменения: задачи ----------

  createTask(input: TaskInput): string {
    const doc = input.parentId ? this.docForTask(input.parentId) : this.docForProject(input.projectId ?? this.inboxId);
    // Метки личные: в общем проекте их id ничего не значат для других участников.
    const { labels, ...rest } = input;
    return this.batch(() => doc.createTask(doc === this.personal ? input : rest));
  }

  updateTask(id: string, patch: TaskPatch): void {
    this.batch(() => this.docForTask(id).updateTask(id, patch));
  }

  setLabels(id: string, labelIds: readonly string[]): void {
    const doc = this.docForTask(id);
    if (doc === this.personal) this.batch(() => doc.setLabels(id, labelIds));
  }

  completeTask(id: string): void {
    this.batch(() => this.docForTask(id).completeTask(id));
  }

  reopenTask(id: string): void {
    this.batch(() => this.docForTask(id).reopenTask(id));
  }

  skipOccurrence(id: string): void {
    this.batch(() => this.docForTask(id).skipOccurrence(id));
  }

  uncompleteOccurrence(id: string, occurrence: string): boolean {
    return this.batch(() => this.docForTask(id).uncompleteOccurrence(id, occurrence));
  }

  canUncompleteOccurrence(id: string, occurrence: string): boolean {
    return this.docForTask(id).canUncompleteOccurrence(id, occurrence);
  }

  deleteTask(id: string): void {
    this.batch(() => this.docForTask(id).deleteTask(id));
  }

  restoreTask(id: string): void {
    this.batch(() => this.docForTask(id).restoreTask(id));
  }

  addComment(taskId: string, input: { text: string; author: string | null; file?: Attachment | null; sign?: (c: CommentSigned) => string }): string {
    let id = '';
    this.batch(() => {
      id = this.docForTask(taskId).addComment(taskId, input);
    });
    return id;
  }

  deleteComment(id: string): Attachment | null {
    const doc = this.docs().find((d) => d.hasComment(id));
    let file: Attachment | null = null;
    if (doc) this.batch(() => (file = doc.deleteComment(id)));
    return file;
  }

  comments(taskId: string): Comment[] {
    return this.docForTask(taskId).comments(taskId);
  }

  /** Записать отрезок работы над задачей (таймер помодоро). */
  logWork(taskId: string, minutes: number, input: { id?: string; at?: number } = {}): string | null {
    let id: string | null = null;
    this.batch(() => (id = this.docForTask(taskId).logWork(taskId, minutes, input)));
    return id;
  }

  /** Поправить затраченное время вручную; 0 — сбросить. */
  setSpent(taskId: string, minutes: number): void {
    this.batch(() => this.docForTask(taskId).setSpent(taskId, minutes));
  }

  /** История действий по всем пространствам, новые первыми. */
  activity(limit = 500): Array<ActivityEvent & { spaceId: string }> {
    return this.docs()
      .flatMap((d) => d.activity().map((e) => ({ ...e, spaceId: d.spaceId })))
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  }

  /** Кто работает на этом устройстве: пишется в историю общих проектов. */
  setActor(userId: string | null): void {
    for (const d of this.docs()) d.actor = userId;
    this.actor = userId;
  }

  actor: string | null = null;

  saveTemplate(name: string, data: unknown): string {
    let id = '';
    this.batch(() => (id = this.personal.saveTemplate(name, data)));
    return id;
  }

  deleteTemplate(id: string): void {
    this.batch(() => this.personal.deleteTemplate(id));
  }

  templates() {
    return this.personal.templates();
  }

  /** Пространство задачи: для общих проектов нужен список участников. */
  spaceOfTask(taskId: string): string {
    return this.docForTask(taskId).spaceId;
  }

  /** Удалить задачу навсегда. Возвращает файлы её комментариев с пространством: их удаляют с сервера. */
  purgeTask(id: string): Array<{ spaceId: string; file: Attachment }> {
    const doc = this.docForTask(id);
    let files: Attachment[] = [];
    this.batch(() => (files = doc.purgeTask(id)));
    return files.map((file) => ({ spaceId: doc.spaceId, file }));
  }

  emptyTrash(): { count: number; files: Array<{ spaceId: string; file: Attachment }> } {
    let count = 0;
    const files: Array<{ spaceId: string; file: Attachment }> = [];
    this.batch(() => {
      for (const d of this.docs()) {
        const r = d.emptyTrash();
        count += r.count;
        files.push(...r.files.map((file) => ({ spaceId: d.spaceId, file })));
      }
    });
    return { count, files };
  }

  moveTask(id: string, target: { projectId?: string; sectionId?: string | null; parentId?: string | null; position?: Position }): void {
    const src = this.docForTask(id);
    const dst = target.parentId ? this.docForTask(target.parentId) : this.docForProject(target.projectId ?? src.task(id)?.projectId);
    if (src === dst) {
      this.batch(() => src.moveTask(id, target));
      return;
    }
    this.batch(() => {
      this.copyTree(src, dst, id, {
        projectId: target.parentId ? undefined : (target.projectId ?? dst.inboxId),
        sectionId: target.sectionId ?? null,
        parentId: target.parentId ?? null,
        ...(target.position ? { position: target.position } : {}),
      });
      src.deleteTask(id);
    });
  }

  /** Скопировать задачу с подзадачами в другое пространство. Возвращает новый id. */
  private copyTree(
    src: Doc,
    dst: Doc,
    id: string,
    at: { projectId: string | undefined; sectionId: string | null; parentId: string | null; position?: Position },
  ): string {
    const t = src.task(id)!;
    const keepLabels = src === dst || (src === this.personal && dst === this.personal);
    const newId = dst.createTask({
      title: t.title,
      ...(at.projectId ? { projectId: at.projectId } : {}),
      sectionId: at.sectionId,
      parentId: at.parentId,
      description: t.description,
      priority: t.priority,
      labels: keepLabels ? t.labels : [],
      start: t.start,
      due: t.due,
      deadline: t.deadline,
      duration: t.duration,
      recurrence: t.recurrence,
      reminders: t.reminders,
      ...(at.position ? { position: at.position } : {}),
    });
    const extra: Change[] = [['task', newId, 'created_at', t.createdAt]];
    if (t.completedAt !== null) extra.push(['task', newId, 'completed_at', t.completedAt]);
    dst.write(extra, { undoable: true });
    // Затраченное время переезжает одним отрезком: отдельные записи старого пространства там и остаются удалёнными.
    if (t.spent) dst.logWork(newId, t.spent, { at: t.createdAt });
    for (const child of src.subtasks(id, { completed: true })) {
      this.copyTree(src, dst, child.task.id, { projectId: undefined, sectionId: null, parentId: newId });
    }
    return newId;
  }

  /** Изменение нескольких задач разом (например, «перенести просроченное на сегодня»). */
  writeTasks(changes: readonly Change[]): void {
    const groups = new Map<Doc, Change[]>();
    for (const c of changes) {
      const doc = c[0] === 'task' ? this.docForTask(c[1]) : this.personal;
      let list = groups.get(doc);
      if (!list) groups.set(doc, (list = []));
      list.push(c);
    }
    this.batch(() => {
      for (const [doc, list] of groups) doc.write(list);
    });
  }

  // ---------- изменения: проекты, разделы, метки, фильтры ----------

  createProject(input: { name: string; color?: string; parentId?: string | null; view?: ProjectView; position?: Position }): string {
    return this.batch(() => this.personal.createProject(input));
  }

  updateProject(id: string, patch: { name?: string; description?: string; color?: string; view?: ProjectView; favorite?: boolean; archived?: boolean }): void {
    this.batch(() => this.docForProject(id).updateProject(id, patch));
  }

  moveProject(id: string, target: { parentId: string | null; position?: Position }): void {
    if (this.shared.has(id)) return;
    this.batch(() => this.personal.moveProject(id, target));
  }

  deleteProject(id: string): void {
    const doc = this.docForProject(id);
    // Проект общего пространства помечается удалённым внутри него, а не как «Входящие».
    this.batch(() => (doc === this.personal ? doc.deleteProject(id) : doc.write([['project', id, 'deleted_at', Date.now()]])));
  }

  restoreProject(id: string): void {
    this.batch(() => this.docForProject(id).restoreProject(id));
  }

  createSection(projectId: string, name: string, position?: Position): string {
    return this.batch(() => this.docForProject(projectId).createSection(projectId, name, position));
  }

  updateSection(id: string, patch: { name?: string; description?: string; collapsed?: boolean }): void {
    this.batch(() => this.docForSection(id).updateSection(id, patch));
  }

  moveSection(id: string, position: Position): void {
    this.batch(() => this.docForSection(id).moveSection(id, position));
  }

  deleteSection(id: string): void {
    this.batch(() => this.docForSection(id).deleteSection(id));
  }

  createLabel(name: string, color?: string): string {
    return this.batch(() => this.personal.createLabel(name, color));
  }

  updateLabel(id: string, patch: { name?: string; color?: string }): void {
    this.batch(() => this.personal.updateLabel(id, patch));
  }

  deleteLabel(id: string): void {
    this.batch(() => this.personal.deleteLabel(id));
  }

  createFilter(name: string, query: string, color?: string): string {
    return this.batch(() => this.personal.createFilter(name, query, color));
  }

  updateFilter(id: string, patch: { name?: string; query?: string; color?: string }): void {
    this.batch(() => this.personal.updateFilter(id, patch));
  }

  deleteFilter(id: string): void {
    this.batch(() => this.personal.deleteFilter(id));
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  undo(): boolean {
    const docs = this.undoStack.pop();
    if (!docs) return false;
    this.undoing = true;
    try {
      for (const d of [...docs].reverse()) d.undo();
    } finally {
      this.undoing = false;
    }
    return true;
  }

  /**
   * Сделать личный проект общим: перенести его с разделами и задачами в пустое общее пространство.
   * Ключ пространства и запись на сервере создаёт вызывающий код.
   */
  shareProject(projectId: string, target: Doc): void {
    const project = this.personal.project(projectId);
    if (!project || project.isInbox) throw new Error('only a personal project can be shared');
    if (target.kind !== 'shared') throw new Error('target must be a shared space');
    this.addShared(target);
    this.batch(() => {
      target.write([
        ['project', target.spaceId, 'name', project.name],
        ['project', target.spaceId, 'color', project.color],
        ['project', target.spaceId, 'view', project.view],
        ['project', target.spaceId, 'order', 'a0'],
        ...(project.description ? [['project', target.spaceId, 'description', project.description] as Change] : []),
      ]);
      const view = this.personal.projectTasks(projectId, { completed: true });
      for (const node of view.unsectioned) this.copyTree(this.personal, target, node.task.id, { projectId: target.spaceId, sectionId: null, parentId: null });
      for (const { section, tasks } of view.sections) {
        const sid = target.createSection(target.spaceId, section.name);
        if (section.description) target.updateSection(sid, { description: section.description });
        for (const node of tasks) this.copyTree(this.personal, target, node.task.id, { projectId: target.spaceId, sectionId: sid, parentId: null });
      }
      this.personal.deleteProject(projectId);
    });
  }
}


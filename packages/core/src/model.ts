/**
 * Сущности задачника и их разбор из записей реплики.
 * Записи могли прийти от клиента другой версии или от недобросовестного участника,
 * поэтому каждое поле проверяется и при ошибке заменяется значением по умолчанию.
 */
import { isDate, isDateSpec, type DateSpec } from './dates.ts';
import type { Json } from './op.ts';
import { isReminderList } from './reminders.ts';

export type Priority = 1 | 2 | 3 | 4;
export type ProjectView = 'list' | 'board' | 'calendar';

export interface Recurrence {
  /** Правило RRULE (RFC 5545) без DTSTART: FREQ=WEEKLY;BYDAY=MO. */
  readonly rule: string;
  /** schedule — по расписанию; completion — следующая дата отсчитывается от выполнения. */
  readonly mode: 'schedule' | 'completion';
  /** Исходная фраза пользователя: «каждый понедельник». */
  readonly text: string;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  /** Описание в Markdown; '' — нет описания (и у старых записей без поля). */
  readonly description: string;
  readonly color: string;
  readonly parentId: string | null;
  readonly order: string;
  readonly view: ProjectView;
  readonly favorite: boolean;
  readonly archived: boolean;
  readonly isInbox: boolean;
  readonly deletedAt: number | null;
}

export interface Section {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  /** Описание в Markdown; '' — нет описания. */
  readonly description: string;
  readonly order: string;
  readonly collapsed: boolean;
  readonly deletedAt: number | null;
}

export interface Task {
  readonly id: string;
  readonly projectId: string;
  readonly sectionId: string | null;
  readonly parentId: string | null;
  readonly title: string;
  readonly description: string;
  readonly priority: Priority;
  readonly labels: readonly string[];
  /** «Не показывать до». */
  readonly start: DateSpec | null;
  /** Срок: когда собираюсь сделать. */
  readonly due: DateSpec | null;
  /** Жёсткий дедлайн. */
  readonly deadline: string | null;
  /** Длительность в минутах. */
  readonly duration: number | null;
  readonly recurrence: Recurrence | null;
  /** Минуты до срока для напоминаний; null — по умолчанию пользователя, [] — без напоминаний. */
  readonly reminders: readonly number[] | null;
  /** Исполнитель в общем проекте (id пользователя). */
  readonly assignee: string | null;
  readonly order: string;
  readonly completedAt: number | null;
  readonly deletedAt: number | null;
  readonly createdAt: number;
}

export interface Label {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly order: string;
  readonly deletedAt: number | null;
}

export interface SavedFilter {
  readonly id: string;
  readonly name: string;
  readonly query: string;
  readonly color: string;
  readonly order: string;
  readonly deletedAt: number | null;
}

/** Выполнение экземпляра задачи. Id детерминирован: completionId(task, occurrence). */
export interface Completion {
  readonly id: string;
  readonly taskId: string;
  /** Дата экземпляра (для повторяющихся) или null. */
  readonly occurrence: string | null;
  readonly completedAt: number;
}

export const COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'violet', 'pink', 'brown'] as const;
export type Color = (typeof COLORS)[number];

export const LABEL_PREFIX = 'label:';

type Rec = Readonly<Record<string, Json>>;

function s(v: Json | undefined, fallback = '', max = 100_000): string {
  return typeof v === 'string' ? v.slice(0, max) : fallback;
}

function idOrNull(v: Json | undefined): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null;
}

function num(v: Json | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function bool(v: Json | undefined): boolean {
  return v === true;
}

function color(v: Json | undefined): string {
  return typeof v === 'string' && (COLORS as readonly string[]).includes(v) ? v : 'gray';
}

function priority(v: Json | undefined): Priority {
  return v === 1 || v === 2 || v === 3 ? v : 4;
}

function order(v: Json | undefined): string {
  return typeof v === 'string' && v.length <= 512 ? v : '';
}

function dateSpec(v: Json | undefined): DateSpec | null {
  return isDateSpec(v) ? (v as DateSpec) : null;
}

function recurrence(v: Json | undefined): Recurrence | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const { rule, mode, text } = v;
  if (typeof rule !== 'string' || rule.length > 500) return null;
  if (mode !== 'schedule' && mode !== 'completion') return null;
  return { rule, mode, text: typeof text === 'string' ? text.slice(0, 200) : '' };
}

export function toProject(id: string, r: Rec): Project {
  const view = r.view === 'board' || r.view === 'calendar' ? r.view : 'list';
  return {
    id,
    name: s(r.name, '', 500),
    description: s(r.description, '', 20_000),
    color: color(r.color),
    parentId: idOrNull(r.parent),
    order: order(r.order),
    view,
    favorite: bool(r.favorite),
    archived: bool(r.archived),
    isInbox: bool(r.inbox),
    deletedAt: num(r.deleted_at),
  };
}

export function toSection(id: string, r: Rec): Section {
  return {
    id,
    projectId: idOrNull(r.project) ?? '',
    name: s(r.name, '', 500),
    description: s(r.description, '', 20_000),
    order: order(r.order),
    collapsed: bool(r.collapsed),
    deletedAt: num(r.deleted_at),
  };
}

/** Файл в комментарии: зашифрован на устройстве своим ключом, на сервере лежит только шифротекст. */
export interface Attachment {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly type: string;
  /** Ключ файла (base64). Лежит в зашифрованной записи комментария. */
  readonly key: string;
}

export interface Comment {
  readonly id: string;
  readonly taskId: string;
  readonly text: string;
  /** Автор (id пользователя); null в старых записях. */
  readonly author: string | null;
  readonly file: Attachment | null;
  readonly createdAt: number;
  readonly deletedAt: number | null;
  /** Подпись автора (Ed25519, base64); null у комментариев до подписей. */
  readonly sig: string | null;
}

const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function attachment(v: Json | undefined): Attachment | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, Json>;
  if (typeof o.id !== 'string' || typeof o.key !== 'string' || typeof o.name !== 'string') return null;
  // id файла попадает в адрес запроса: только UUID, иначе участник подсунул бы путь вроде «../members/…».
  if (!FILE_ID.test(o.id) || !/^[A-Za-z0-9+/=_-]{20,100}$/.test(o.key)) return null;
  return { id: o.id.slice(0, 64), name: o.name.slice(0, 300), size: typeof o.size === 'number' ? o.size : 0, type: typeof o.type === 'string' ? o.type.slice(0, 100) : '', key: o.key };
}

export function toComment(id: string, r: Rec): Comment {
  return {
    id,
    taskId: idOrNull(r.task) ?? '',
    text: s(r.text, '', 20_000),
    author: idOrNull(r.author),
    file: attachment(r.file),
    createdAt: num(r.created_at) ?? 0,
    deletedAt: num(r.deleted_at),
    sig: typeof r.sig === 'string' && r.sig.length <= 200 ? r.sig : null,
  };
}

export function toTask(id: string, r: Rec): Task {
  const labels: string[] = [];
  for (const [k, v] of Object.entries(r)) {
    if (k.startsWith(LABEL_PREFIX) && v === true) labels.push(k.slice(LABEL_PREFIX.length));
  }
  labels.sort();
  const duration = num(r.duration);
  return {
    id,
    projectId: idOrNull(r.project) ?? '',
    sectionId: idOrNull(r.section),
    parentId: idOrNull(r.parent),
    title: s(r.title, '', 2000),
    description: s(r.description),
    priority: priority(r.priority),
    labels,
    start: dateSpec(r.start),
    due: dateSpec(r.due),
    deadline: isDate(r.deadline) ? (r.deadline as string) : null,
    duration: duration !== null && duration > 0 && duration <= 24 * 60 * 31 ? Math.round(duration) : null,
    recurrence: recurrence(r.recurrence),
    reminders: isReminderList(r.reminders) ? [...new Set(r.reminders as number[])].sort((a, b) => a - b) : null,
    assignee: idOrNull(r.assignee),
    order: order(r.order),
    completedAt: num(r.completed_at),
    deletedAt: num(r.deleted_at),
    createdAt: num(r.created_at) ?? 0,
  };
}

export function toLabel(id: string, r: Rec): Label {
  return { id, name: s(r.name, '', 200), color: color(r.color), order: order(r.order), deletedAt: num(r.deleted_at) };
}

export function toFilter(id: string, r: Rec): SavedFilter {
  return {
    id,
    name: s(r.name, '', 200),
    query: s(r.query, '', 2000),
    color: color(r.color),
    order: order(r.order),
    deletedAt: num(r.deleted_at),
  };
}

export function toCompletion(id: string, r: Rec): Completion | null {
  const taskId = idOrNull(r.task);
  const completedAt = num(r.completed_at);
  if (!taskId || completedAt === null) return null;
  return { id, taskId, occurrence: isDate(r.occurrence) ? (r.occurrence as string) : null, completedAt };
}

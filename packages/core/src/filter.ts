/**
 * Язык фильтров, совместимый с Todoist, плюс русские синонимы.
 *
 *   (today | overdue) & p1        сегодня | просрочено
 *   #Работа & !@ждёт              ##Работа (с подпроектами)
 *   search: молоко                поиск: молоко
 *   due before: friday            до: пятница
 *   7 days, next 7 days           следующие 7 дней
 *   no date, recurring, subtask   без даты, повторяющиеся, подзадачи
 *
 * Операторы: & (и), | (или), ! (не), скобки. Запятая разделяет списки, здесь они объединяются.
 * Неизвестные условия не совпадают ни с чем и возвращаются в unknown, чтобы показать их пользователю.
 */
import { addDays, localDate } from './dates.ts';
import { normalizeText, type Doc, type TaskView } from './doc.ts';
import { resolveDate } from './parse.ts';

type Node = { op: 'or' | 'and'; items: Node[] } | { op: 'not'; item: Node } | { op: 'term'; text: string };

export class FilterSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilterSyntaxError';
  }
}

function tokenize(query: string): string[] {
  const out: string[] = [];
  let term = '';
  const flush = () => {
    if (term.trim()) out.push(term.trim());
    term = '';
  };
  for (let i = 0; i < query.length; i++) {
    const ch = query[i]!;
    // «!» — оператор только в начале условия: «!subtask», но не «привет!».
    if ('&|(),'.includes(ch) || (ch === '!' && term.trim() === '')) {
      flush();
      out.push(ch === ',' ? '|' : ch);
    } else term += ch;
  }
  flush();
  return out;
}

export function parseFilter(query: string): Node {
  const tokens = tokenize(query);
  let i = 0;
  const peek = () => tokens[i];
  const expr = (): Node => {
    const items = [and()];
    while (peek() === '|') {
      i++;
      items.push(and());
    }
    return items.length === 1 ? items[0]! : { op: 'or', items };
  };
  const and = (): Node => {
    const items = [unary()];
    while (peek() === '&') {
      i++;
      items.push(unary());
    }
    return items.length === 1 ? items[0]! : { op: 'and', items };
  };
  const unary = (): Node => {
    if (peek() === '!') {
      i++;
      return { op: 'not', item: unary() };
    }
    if (peek() === '(') {
      i++;
      const inner = expr();
      if (peek() !== ')') throw new FilterSyntaxError('не хватает закрывающей скобки');
      i++;
      return inner;
    }
    const t = peek();
    if (t === undefined || '&|)'.includes(t)) throw new FilterSyntaxError('ожидается условие');
    i++;
    return { op: 'term', text: t };
  };
  if (tokens.length === 0) throw new FilterSyntaxError('пустой запрос');
  const tree = expr();
  if (i < tokens.length) throw new FilterSyntaxError(`лишнее: «${tokens[i]}»`);
  return tree;
}

interface Ctx {
  readonly doc: Doc;
  readonly today: string;
  readonly tz: string;
  readonly unknown: Set<string>;
}

function wildcard(pattern: string): RegExp {
  const esc = normalizeText(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${esc}$`, 'u');
}

function projectMatches(ctx: Ctx, t: TaskView, name: string, withChildren: boolean): boolean {
  const re = wildcard(name);
  const inboxNames = ['входящие', 'inbox'];
  for (let id: string | null = t.projectId; id !== null; ) {
    const p = ctx.doc.project(id);
    if (!p) return false;
    const pname = p.isInbox ? null : normalizeText(p.name);
    if ((pname !== null && re.test(pname)) || (p.isInbox && inboxNames.some((n) => re.test(n)))) return true;
    if (!withChildren) return false;
    id = p.parentId;
  }
  return false;
}

function dueDate(t: TaskView, ctx: Ctx): string | null {
  return t.due ? localDate(t.due, ctx.tz) : null;
}

function term(text: string, t: TaskView, ctx: Ctx): boolean {
  const raw = text.trim();
  const s = normalizeText(raw).replace(/\s+/g, ' ');
  const due = dueDate(t, ctx);

  if (raw.startsWith('##')) return projectMatches(ctx, t, raw.slice(2).trim(), true);
  if (raw.startsWith('#') || raw.startsWith('№')) return projectMatches(ctx, t, raw.slice(1).trim(), false);
  if (raw.startsWith('@')) {
    const re = wildcard(raw.slice(1).trim());
    return t.labels.some((id) => {
      const l = ctx.doc.label(id);
      return l !== undefined && re.test(normalizeText(l.name));
    });
  }
  if (raw.startsWith('/')) {
    const re = wildcard(raw.slice(1).trim());
    const sec = t.sectionId ? ctx.doc.sections(t.projectId).find((x) => x.id === t.sectionId) : undefined;
    return sec !== undefined && re.test(normalizeText(sec.name));
  }

  switch (s) {
    case 'today':
    case 'сегодня':
      return due === ctx.today;
    case 'overdue':
    case 'od':
    case 'просрочено':
    case 'просроченные':
      return due !== null && due < ctx.today;
    case 'tomorrow':
    case 'завтра':
      return due === addDays(ctx.today, 1);
    case 'yesterday':
    case 'вчера':
      return due === addDays(ctx.today, -1);
    case 'no date':
    case 'no due date':
    case 'без даты':
    case 'без срока':
      return due === null;
    case 'has date':
    case 'с датой':
      return due !== null;
    case 'recurring':
    case 'повторяющиеся':
    case 'повтор':
      return t.recurrence !== null;
    case 'subtask':
    case 'subtasks':
    case 'подзадачи':
    case 'подзадача':
      return t.parentId !== null;
    case 'no labels':
    case 'без меток':
      return t.labels.length === 0;
    case 'no deadline':
    case 'без дедлайна':
      return t.deadline === null;
    case 'no priority':
    case 'без приоритета':
      return t.priority === 4;
  }

  let m = /^(?:p|п)([1-4])$/.exec(s);
  if (m) return t.priority === Number(m[1]);

  m = /^(?:next |следующие |ближайшие )?(\d{1,3}) (?:days?|дн(?:я|ей)|день)$/.exec(s);
  if (m) return due !== null && due >= ctx.today && due < addDays(ctx.today, Number(m[1]));

  m = /^(?:search|поиск):\s*(.+)$/.exec(s);
  if (m) return normalizeText(`${t.title}\n${t.description}`).includes(m[1]!.trim());

  m = /^(?:due before|до|срок до):\s*(.+)$/.exec(s);
  if (m) {
    const d = resolveDate(m[1]!, ctx.today);
    if (!d) return unknown(ctx, raw);
    return due !== null && due < d;
  }
  m = /^(?:due after|после|срок после):\s*(.+)$/.exec(s);
  if (m) {
    const d = resolveDate(m[1]!, ctx.today);
    if (!d) return unknown(ctx, raw);
    return due !== null && due > d;
  }
  m = /^(?:deadline before|дедлайн до):\s*(.+)$/.exec(s);
  if (m) {
    const d = resolveDate(m[1]!, ctx.today);
    if (!d) return unknown(ctx, raw);
    return t.deadline !== null && t.deadline < d;
  }
  m = /^(?:due|срок|date|дата):\s*(.+)$/.exec(s);
  const datePhrase = m ? m[1]! : s;
  const d = resolveDate(datePhrase, ctx.today);
  if (d) return due === d;

  return unknown(ctx, raw);
}

function unknown(ctx: Ctx, raw: string): false {
  ctx.unknown.add(raw);
  return false;
}

function evaluate(node: Node, t: TaskView, ctx: Ctx): boolean {
  switch (node.op) {
    case 'or':
      return node.items.some((n) => evaluate(n, t, ctx));
    case 'and':
      return node.items.every((n) => evaluate(n, t, ctx));
    case 'not':
      return !evaluate(node.item, t, ctx);
    case 'term':
      return term(node.text, t, ctx);
  }
}

export interface FilterResult {
  readonly tasks: TaskView[];
  /** Условия, которые фильтр не понял. */
  readonly unknown: string[];
}

/** Невыполненные задачи, подходящие под запрос, по сроку и приоритету. */
export function runFilter(doc: Doc, query: string, today: string, tz: string): FilterResult {
  const tree = parseFilter(query);
  const ctx: Ctx = { doc, today, tz, unknown: new Set() };
  const tasks = doc.openTasks().filter((t) => evaluate(tree, t, ctx));
  tasks.sort((a, b) => {
    const da = a.due ? localDate(a.due, tz) + (a.due.time ?? '99') : '~';
    const db = b.due ? localDate(b.due, tz) + (b.due.time ?? '99') : '~';
    if (da !== db) return da < db ? -1 : 1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.order < b.order ? -1 : a.order > b.order ? 1 : 0;
  });
  return { tasks, unknown: [...ctx.unknown] };
}

/**
 * Шаблоны проектов: структура проекта (разделы, задачи с подзадачами, приоритеты, метки, повторы)
 * со сроками относительно дня создания. Свои шаблоны хранятся в личном пространстве, зашифрованными.
 */
import { addDays, daysBetween, localDate, type DateSpec } from './dates.ts';
import type { TaskNode } from './doc.ts';
import { MAX_HABIT_SKIPS, type Habit, type Priority, type Recurrence } from './model.ts';
import { firstOnOrAfter, parseRule } from './recurrence.ts';
import type { Workspace } from './workspace.ts';

export interface TemplateTask {
  readonly title: string;
  readonly description?: string;
  readonly priority?: number;
  /** Имена меток. */
  readonly labels?: readonly string[];
  /** Срок: через сколько дней после создания проекта. */
  readonly dueIn?: number;
  readonly time?: string;
  readonly duration?: number;
  readonly recurrence?: Recurrence;
  /** Привычка: сама серия в шаблон не попадает, только отметка и правило пропусков. */
  readonly habit?: Habit;
  readonly children?: readonly TemplateTask[];
}

export interface ProjectTemplate {
  readonly v: 1;
  readonly name: string;
  readonly color: string;
  /** Подпись в галерее шаблонов. */
  readonly description?: string;
  /** Описание создаваемого проекта (Markdown). */
  readonly projectDescription?: string;
  readonly tasks: readonly TemplateTask[];
  readonly sections: ReadonlyArray<{ readonly name: string; readonly description?: string; readonly tasks: readonly TemplateTask[] }>;
}

/** Собрать шаблон из проекта: открытые задачи, сроки становятся смещением от today. */
export function projectToTemplate(ws: Workspace, projectId: string, today: string, tz: string, inboxName = 'Входящие'): ProjectTemplate {
  const project = ws.project(projectId);
  if (!project) throw new Error('unknown project');
  const labelName = (id: string) => ws.label(id)?.name;
  const toTpl = (n: TaskNode): TemplateTask => {
    const t = n.task;
    const due = t.due ? daysBetween(today, localDate(t.due, tz)) : undefined;
    const labels = t.labels.map(labelName).filter((x): x is string => typeof x === 'string');
    return {
      title: t.title,
      ...(t.description ? { description: t.description } : {}),
      ...(t.priority !== 4 ? { priority: t.priority } : {}),
      ...(labels.length ? { labels } : {}),
      ...(due !== undefined ? { dueIn: due } : {}),
      ...(t.due?.time ? { time: t.due.time } : {}),
      ...(t.duration ? { duration: t.duration } : {}),
      ...(t.recurrence ? { recurrence: t.recurrence } : {}),
      ...(t.habit && t.recurrence ? { habit: t.habit } : {}),
      ...(n.children.length ? { children: n.children.map(toTpl) } : {}),
    };
  };
  const view = ws.projectTasks(projectId);
  return {
    v: 1,
    name: project.isInbox ? inboxName : project.name,
    color: project.color,
    ...(project.description ? { projectDescription: project.description } : {}),
    tasks: view.unsectioned.map(toTpl),
    sections: view.sections.map((s) => ({ name: s.section.name, ...(s.section.description ? { description: s.section.description } : {}), tasks: s.tasks.map(toTpl) })),
  };
}

/** Создать проект по шаблону. Метки создаются, если их нет. Возвращает id проекта. */
export function applyTemplate(ws: Workspace, tpl: ProjectTemplate, today: string, name = tpl.name): string {
  const projectId = ws.createProject({ name, color: tpl.color });
  if (tpl.projectDescription) ws.updateProject(projectId, { description: tpl.projectDescription });
  const labelIds = new Map(ws.labels().map((l) => [l.name.toLocaleLowerCase('ru'), l.id]));
  const labelId = (n: string) => {
    const key = n.toLocaleLowerCase('ru');
    let id = labelIds.get(key);
    if (!id) {
      id = ws.createLabel(n);
      labelIds.set(key, id);
    }
    return id;
  };
  const add = (t: TemplateTask, sectionId: string | null, parentId: string | null) => {
    let date = t.dueIn !== undefined ? addDays(today, t.dueIn) : null;
    // Повтор по расписанию: первый срок совпадает с правилом («каждое воскресенье» начинается в воскресенье).
    const rule = t.recurrence?.mode === 'schedule' ? parseRule(t.recurrence.rule) : null;
    if (date && rule) date = firstOnOrAfter(rule, date, date) ?? date;
    const due: DateSpec | null = date ? { date, ...(t.time ? { time: t.time } : {}) } : null;
    const id = ws.createTask({
      title: t.title,
      description: t.description ?? '',
      projectId,
      sectionId,
      parentId,
      priority: (t.priority ?? 4) as Priority,
      labels: (t.labels ?? []).map(labelId),
      due,
      duration: t.duration ?? null,
      recurrence: t.recurrence ?? null,
      ...(t.habit && t.recurrence ? { habit: t.habit } : {}),
    });
    for (const c of t.children ?? []) add(c, null, id);
  };
  for (const t of tpl.tasks) add(t, null, null);
  for (const s of tpl.sections) {
    const sectionId = ws.createSection(projectId, s.name);
    if (s.description) ws.updateSection(sectionId, { description: s.description });
    for (const t of s.tasks) add(t, sectionId, null);
  }
  return projectId;
}

/** Проверить шаблон из файла: только известные поля и разумные размеры. */
export function parseTemplate(raw: unknown): ProjectTemplate {
  const o = raw as ProjectTemplate;
  if (!o || typeof o !== 'object' || o.v !== 1 || typeof o.name !== 'string' || !Array.isArray(o.tasks) || !Array.isArray(o.sections)) {
    throw new Error('Это не шаблон Dela');
  }
  let count = 0;
  const task = (t: TemplateTask): TemplateTask => {
    if (++count > 2000) throw new Error('Слишком большой шаблон');
    if (!t || typeof t.title !== 'string') throw new Error('Задача без названия в шаблоне');
    return {
      title: t.title.slice(0, 2000),
      ...(typeof t.description === 'string' ? { description: t.description.slice(0, 20_000) } : {}),
      ...(typeof t.priority === 'number' && t.priority >= 1 && t.priority <= 4 ? { priority: Math.round(t.priority) } : {}),
      ...(Array.isArray(t.labels) ? { labels: t.labels.filter((l) => typeof l === 'string').map((l) => l.slice(0, 200)) } : {}),
      ...(typeof t.dueIn === 'number' && Math.abs(t.dueIn) < 3650 ? { dueIn: Math.round(t.dueIn) } : {}),
      ...(typeof t.time === 'string' && /^\d{2}:\d{2}$/.test(t.time) ? { time: t.time } : {}),
      ...(typeof t.duration === 'number' && t.duration > 0 && t.duration <= 1440 ? { duration: Math.round(t.duration) } : {}),
      ...(t.recurrence && typeof t.recurrence === 'object' ? { recurrence: t.recurrence } : {}),
      ...(t.habit && typeof t.habit === 'object'
        ? { habit: { skipsPerWeek: Math.min(MAX_HABIT_SKIPS, Math.max(0, Math.round(Number(t.habit.skipsPerWeek) || 0))) } }
        : {}),
      ...(Array.isArray(t.children) ? { children: t.children.map(task) } : {}),
    };
  };
  return {
    v: 1,
    name: o.name.slice(0, 500),
    color: typeof o.color === 'string' ? o.color : 'gray',
    ...(typeof o.projectDescription === 'string' && o.projectDescription ? { projectDescription: o.projectDescription.slice(0, 20_000) } : {}),
    tasks: o.tasks.map(task),
    sections: o.sections.map((s) => ({
      name: String(s?.name ?? '').slice(0, 500),
      ...(typeof s?.description === 'string' && s.description ? { description: s.description.slice(0, 20_000) } : {}),
      tasks: Array.isArray(s?.tasks) ? s.tasks.map(task) : [],
    })),
  };
}

export const BUILTIN_TEMPLATES: readonly ProjectTemplate[] = [
  {
    v: 1,
    name: 'Ролик на YouTube',
    color: 'red',
    description: 'От идеи до публикации и разбора удержания',
    tasks: [],
    sections: [
      { name: 'Подготовка', tasks: [{ title: 'Собрать факты и тезисы', dueIn: 0 }, { title: 'Написать сценарий', dueIn: 1, priority: 2 }, { title: 'Список того, что подснять', dueIn: 1 }] },
      { name: 'Съёмка', tasks: [{ title: 'Записать озвучку', dueIn: 2 }, { title: 'Снять перебивки', dueIn: 2 }] },
      { name: 'Монтаж', tasks: [{ title: 'Черновой монтаж', dueIn: 3, priority: 2 }, { title: 'Графика, музыка, звук', dueIn: 4 }, { title: 'Превью и три варианта названия', dueIn: 4, priority: 1 }] },
      { name: 'Публикация', tasks: [{ title: 'Описание с главами', dueIn: 5 }, { title: 'Опубликовать', dueIn: 5, priority: 1 }, { title: 'Разобрать удержание через неделю', dueIn: 12 }] },
    ],
  },
  {
    v: 1,
    name: 'Переезд',
    color: 'orange',
    description: 'Что сделать до и после переезда',
    tasks: [],
    sections: [
      { name: 'За месяц', tasks: [{ title: 'Выбрать перевозчика', dueIn: 0, priority: 2 }, { title: 'Разобрать вещи, лишнее продать', dueIn: 7 }] },
      { name: 'За неделю', tasks: [{ title: 'Купить коробки и скотч', dueIn: 21 }, { title: 'Перевести интернет на новый адрес', dueIn: 21, priority: 1 }] },
      { name: 'После', tasks: [{ title: 'Сменить адрес в банке и на почте', dueIn: 31 }, { title: 'Передать показания счётчиков', dueIn: 31 }] },
    ],
  },
  {
    v: 1,
    name: 'Неделя',
    color: 'green',
    description: 'Обзор недели каждое воскресенье',
    tasks: [
      { title: 'Обзор недели: разобрать Входящие', recurrence: { rule: 'FREQ=WEEKLY;BYDAY=SU', mode: 'schedule', text: 'каждое воскресенье' }, dueIn: 0 },
      { title: 'Выбрать три главные задачи на неделю', recurrence: { rule: 'FREQ=WEEKLY;BYDAY=MO', mode: 'schedule', text: 'каждый понедельник' }, dueIn: 1, priority: 1 },
    ],
    sections: [],
  },
];

/** Готовые шаблоны по-английски: те же проекты, что в BUILTIN_TEMPLATES. */
export const BUILTIN_TEMPLATES_EN: readonly ProjectTemplate[] = [
  {
    v: 1,
    name: 'YouTube video',
    color: 'red',
    description: 'From the idea to publishing and the retention review',
    tasks: [],
    sections: [
      { name: 'Preparation', tasks: [{ title: 'Collect facts and key points', dueIn: 0 }, { title: 'Write the script', dueIn: 1, priority: 2 }, { title: 'List of extra shots', dueIn: 1 }] },
      { name: 'Shooting', tasks: [{ title: 'Record the voice-over', dueIn: 2 }, { title: 'Shoot B-roll', dueIn: 2 }] },
      { name: 'Editing', tasks: [{ title: 'Rough cut', dueIn: 3, priority: 2 }, { title: 'Graphics, music, sound', dueIn: 4 }, { title: 'Thumbnail and three title options', dueIn: 4, priority: 1 }] },
      { name: 'Publishing', tasks: [{ title: 'Description with chapters', dueIn: 5 }, { title: 'Publish', dueIn: 5, priority: 1 }, { title: 'Review retention a week later', dueIn: 12 }] },
    ],
  },
  {
    v: 1,
    name: 'Moving house',
    color: 'orange',
    description: 'What to do before and after the move',
    tasks: [],
    sections: [
      { name: 'A month before', tasks: [{ title: 'Choose a moving company', dueIn: 0, priority: 2 }, { title: 'Sort things out, sell what you do not need', dueIn: 7 }] },
      { name: 'A week before', tasks: [{ title: 'Buy boxes and tape', dueIn: 21 }, { title: 'Move the internet to the new address', dueIn: 21, priority: 1 }] },
      { name: 'After', tasks: [{ title: 'Change the address at the bank and post office', dueIn: 31 }, { title: 'Submit meter readings', dueIn: 31 }] },
    ],
  },
  {
    v: 1,
    name: 'Week',
    color: 'green',
    description: 'Weekly review every Sunday',
    tasks: [
      { title: 'Weekly review: sort the Inbox', recurrence: { rule: 'FREQ=WEEKLY;BYDAY=SU', mode: 'schedule', text: 'every sunday' }, dueIn: 0 },
      { title: 'Pick the three main tasks for the week', recurrence: { rule: 'FREQ=WEEKLY;BYDAY=MO', mode: 'schedule', text: 'every monday' }, dueIn: 1, priority: 1 },
    ],
    sections: [],
  },
];

export function builtinTemplates(lang: 'ru' | 'en' = 'ru'): readonly ProjectTemplate[] {
  return lang === 'en' ? BUILTIN_TEMPLATES_EN : BUILTIN_TEMPLATES;
}

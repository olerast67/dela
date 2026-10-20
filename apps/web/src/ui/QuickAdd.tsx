import { listenVoice, voiceAvailable } from '../platform.ts';
import { IconMic } from './icons.tsx';
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { parseTask, splitTaskList, type DateSpec, type ListLine, type ParsedTask, type Priority, type Token, type Workspace } from '#core';
import { controller } from '../controller.ts';
import { useDoc } from '../hooks.ts';
import { TZ, dueLabel, durationLabel, dateLabel } from '../format.ts';
import { showToast } from './toast.tsx';
import { tn, tr } from '../i18n.ts';

export interface QuickAddDefaults {
  readonly projectId?: string;
  readonly sectionId?: string | null;
  readonly parentId?: string | null;
  readonly due?: DateSpec;
  /** Приоритет по умолчанию: колонка доски «Сегодня». */
  readonly priority?: Priority;
}

interface Ignored {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const KIND_LABEL: Record<Token['kind'], string> = {
  date: tr('Срок'),
  time: tr('Время'),
  recurrence: tr('Повтор'),
  deadline: tr('Дедлайн'),
  duration: tr('Длительность'),
  reminder: tr('Напоминание'),
  priority: tr('Приоритет'),
  project: tr('Проект'),
  section: tr('Раздел'),
  label: tr('Метка'),
};

/** Создать задачу из разобранной фразы; недостающие проект, раздел и метки создаются. */
export function createFromParsed(doc: Workspace, parsed: ParsedTask, defaults: QuickAddDefaults): string {
  let projectId = parsed.projectId ?? undefined;
  if (!projectId && parsed.newProject) projectId = doc.createProject({ name: parsed.newProject });
  projectId ??= defaults.projectId;
  let sectionId: string | null | undefined = parsed.sectionId ?? undefined;
  if (!sectionId && parsed.newSection && projectId) sectionId = doc.createSection(projectId, parsed.newSection);
  if (sectionId === undefined && projectId === defaults.projectId) sectionId = defaults.sectionId ?? null;
  const labels = [...parsed.labelIds];
  for (const name of parsed.newLabels) labels.push(doc.createLabel(name));
  return doc.createTask({
    title: parsed.title,
    ...(projectId ? { projectId } : {}),
    sectionId: sectionId ?? null,
    parentId: defaults.parentId ?? null,
    priority: (parsed.priority ?? defaults.priority ?? 4) as Priority,
    labels,
    due: parsed.due ?? defaults.due ?? null,
    deadline: parsed.deadline,
    duration: parsed.duration,
    recurrence: parsed.recurrence,
    ...(parsed.reminders ? { reminders: parsed.reminders } : {}),
  });
}

export function QuickAdd({
  defaults = {},
  onClose,
  placeholder = tr('Например: позвонить маме завтра в 19 №Дом !1'),
  compact = false,
  initialText = '',
  autoVoice = false,
}: {
  defaults?: QuickAddDefaults;
  onClose?: () => void;
  placeholder?: string;
  compact?: boolean;
  initialText?: string;
  /** Сразу открыть голосовой ввод (кнопка микрофона на виджете). */
  autoVoice?: boolean;
}) {
  const doc = useDoc();
  // Вставленный или присланный через «Поделиться» список: по задаче на строку.
  const [batch, setBatch] = useState<ListLine[] | null>(() => splitTaskList(initialText));
  const [text, setText] = useState(() => (splitTaskList(initialText) ? '' : initialText));
  const [ignored, setIgnored] = useState<Ignored[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const mirror = useRef<HTMLDivElement>(null);

  useEffect(() => input.current?.focus(), []);

  // Голосовой ввод на телефоне: фраза попадает в поле и разбирается так же, как набранная.
  const [voice, setVoice] = useState(false);
  useEffect(() => {
    void voiceAvailable().then(setVoice);
  }, []);
  const dictate = async () => {
    const said = await listenVoice().catch(() => null);
    if (said) setText((prev) => (prev.trim() ? `${prev.trim()} ${said}` : said));
    input.current?.focus();
  };
  useEffect(() => {
    if (autoVoice) void dictate();
  }, [autoVoice]);

  const ctx = useMemo(
    () => ({
      now: Date.now(),
      tz: TZ,
      projects: [
        ...doc.projects().map((p) => ({ id: p.project.id, name: p.project.name })),
        { id: doc.inboxId, name: tr('Входящие') },
        { id: doc.inboxId, name: 'Inbox' },
      ],
      sections: doc.projects().flatMap((p) => doc.sections(p.project.id).map((s) => ({ id: s.id, name: s.name, projectId: p.project.id }))),
      labels: doc.labels().map((l) => ({ id: l.id, name: l.name })),
    }),
    [doc, controller.getDocVersion()],
  );

  // Пропуски, текст которых изменился, больше не действуют.
  const activeIgnored = ignored.filter((i) => text.slice(i.start, i.end) === i.text);
  const parsed = useMemo(
    () => parseTask(text, { ...ctx, ignore: activeIgnored.map((i) => [i.start, i.end] as const) }),
    [text, ctx, activeIgnored.map((i) => `${i.start}:${i.end}`).join(',')],
  );

  function ignore(t: Token) {
    setIgnored([...activeIgnored, { start: t.start, end: t.end, text: t.text }]);
    input.current?.focus();
  }

  function submit() {
    if (!parsed.title) return;
    createFromParsed(doc, parsed, defaults);
    setText('');
    setIgnored([]);
    if (compact) showToast(tr('Задача добавлена'));
  }

  function addBatch(lines: readonly ListLine[]) {
    let parent: string | null = null;
    let added = 0;
    for (const line of lines) {
      const p = parseTask(line.text, ctx);
      if (!p.title) continue;
      const top = parent ? doc.task(parent) : undefined;
      if (line.depth === 1 && top) {
        createFromParsed(doc, p, { ...defaults, projectId: top.projectId, sectionId: top.sectionId, parentId: top.id });
      } else {
        parent = createFromParsed(doc, p, defaults);
      }
      added++;
    }
    setBatch(null);
    showToast(tr('Добавлено: {n}', { n: tn(added, 'задача', 'задачи', 'задач') }));
    onClose?.();
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const lines = splitTaskList(e.clipboardData.getData('text/plain'));
    if (!lines) return;
    e.preventDefault();
    // Уже набранная фраза становится первой задачей списка.
    setBatch(text.trim() ? [{ text: text.trim(), depth: 0 }, ...lines] : lines);
    setText('');
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose?.();
    }
  }

  // Зеркало с подсветкой под прозрачным полем ввода.
  const segments: Array<{ text: string; kind?: Token['kind'] }> = [];
  let pos = 0;
  for (const t of parsed.tokens) {
    if (t.start > pos) segments.push({ text: text.slice(pos, t.start) });
    segments.push({ text: t.text, kind: t.kind });
    pos = t.end;
  }
  if (pos < text.length) segments.push({ text: text.slice(pos) });

  const chips: Array<{ key: string; label: string; token?: Token }> = [];
  const tokenOf = (kind: Token['kind']) => parsed.tokens.find((t) => t.kind === kind);
  const dueToken = tokenOf('date') ?? tokenOf('time');
  if (parsed.due) chips.push({ key: 'due', label: dueLabel(parsed.due), ...(dueToken ? { token: dueToken } : {}) });
  else if (defaults.due) chips.push({ key: 'due', label: dueLabel(defaults.due) });
  if (parsed.recurrence) chips.push({ key: 'rec', label: `↻ ${parsed.recurrence.text}`, token: tokenOf('recurrence')! });
  if (parsed.deadline) chips.push({ key: 'deadline', label: tr('Дедлайн {n}', { n: dateLabel(parsed.deadline) }), token: tokenOf('deadline')! });
  if (parsed.duration) chips.push({ key: 'duration', label: durationLabel(parsed.duration), token: tokenOf('duration')! });
  if (parsed.reminders) {
    const label =
      parsed.reminders.length === 0
        ? tr('Без напоминания')
        : parsed.reminders.map((m) => (m === 0 ? tr('в срок') : tr('за {n}', { n: m % 1440 === 0 ? tr('{n} дн', { n: m / 1440 }) : m % 60 === 0 ? tr('{n} ч', { n: m / 60 }) : tr('{offset} мин', { offset: m }) }))).join(', ');
    chips.push({ key: 'reminder', label: `${tr('Напомнить')}: ${label}`, token: tokenOf('reminder')! });
  }
  if (parsed.priority) chips.push({ key: 'priority', label: tr('Приоритет {priority}', { priority: parsed.priority }), token: tokenOf('priority')! });
  if (parsed.projectId || parsed.newProject) {
    const name = parsed.newProject ? tr('{newProject} (новый)', { newProject: parsed.newProject }) : doc.project(parsed.projectId!)?.isInbox ? tr('Входящие') : doc.project(parsed.projectId!)?.name;
    chips.push({ key: 'project', label: `# ${name}`, token: tokenOf('project')! });
  }
  for (const t of parsed.tokens.filter((x) => x.kind === 'label')) chips.push({ key: `l${t.start}`, label: t.text, token: t });

  if (batch) {
    return (
      <div className={compact ? 'quick-add compact' : 'quick-add'}>
        <p className="qa-batch-title">{tr('Вставлен список: {n}', { n: tn(batch.length, 'задача', 'задачи', 'задач') })}</p>
        <ul className="qa-batch">
          {batch.map((line, i) => {
            const p = parseTask(line.text, ctx);
            return (
              <li key={i} className={line.depth ? 'sub' : undefined}>
                <span>{p.title || line.text}</span>
                {p.due && <span className="qa-batch-due">{dueLabel(p.due)}</span>}
              </li>
            );
          })}
        </ul>
        <div className="qa-bar">
          <span />
          <div className="qa-actions">
            <button
              type="button"
              onClick={() => {
                setText(batch.map((l) => l.text).join(' '));
                setBatch(null);
                input.current?.focus();
              }}
            >
              {tr('Одной задачей')}
            </button>
            <button type="button" onClick={() => (onClose ? onClose() : setBatch(null))}>
              {tr('Отмена')}
            </button>
            <button type="button" className="primary" onClick={() => addBatch(batch)}>
              {tr('Добавить все')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={compact ? 'quick-add compact' : 'quick-add'}>
      <div className="qa-field">
        <div className="qa-mirror" ref={mirror} aria-hidden="true">
          {segments.map((s, i) =>
            s.kind ? (
              <mark key={i} className={`tok tok-${s.kind}`}>
                {s.text}
              </mark>
            ) : (
              <span key={i}>{s.text}</span>
            ),
          )}
        </div>
        <input
          ref={input}
          className="qa-input"
          value={text}
          placeholder={placeholder}
          aria-label={tr('Новая задача')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          onScroll={(e) => {
            if (mirror.current) mirror.current.scrollLeft = e.currentTarget.scrollLeft;
          }}
          spellCheck
        />
      </div>
      {(chips.length > 0 || !compact) && (
        <div className="qa-bar">
          <div className="chips">
            {chips.map((c) => (
              <span key={c.key} className="chip">
                {c.label}
                {c.token && (
                  <button className="chip-x" title={tr('Оставить «{text}» в тексте ({n})', { text: c.token.text, n: KIND_LABEL[c.token.kind] })} onClick={() => ignore(c.token!)}>
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
          <div className="qa-actions">
            {voice && (
              <button type="button" className="icon qa-mic" onClick={() => void dictate()} aria-label={tr('Сказать задачу голосом')} title={tr('Голосом')}>
                <IconMic />
              </button>
            )}
            {onClose && (
              <button type="button" onClick={onClose}>
                {tr('Отмена')}
              </button>
            )}
            <button type="button" className="primary" disabled={!parsed.title} onClick={submit}>
              {tr('Добавить')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { parseTask, type DateSpec, type Doc, type ParsedTask, type Priority, type Token } from '#core';
import { controller } from '../controller.ts';
import { useDoc } from '../hooks.ts';
import { TZ, dueLabel, durationLabel, dateLabel } from '../format.ts';
import { showToast } from './toast.tsx';

export interface QuickAddDefaults {
  readonly projectId?: string;
  readonly sectionId?: string | null;
  readonly parentId?: string | null;
  readonly due?: DateSpec;
}

interface Ignored {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const KIND_LABEL: Record<Token['kind'], string> = {
  date: 'Срок',
  time: 'Время',
  recurrence: 'Повтор',
  deadline: 'Дедлайн',
  duration: 'Длительность',
  priority: 'Приоритет',
  project: 'Проект',
  section: 'Раздел',
  label: 'Метка',
};

/** Создать задачу из разобранной фразы; недостающие проект, раздел и метки создаются. */
export function createFromParsed(doc: Doc, parsed: ParsedTask, defaults: QuickAddDefaults): string {
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
    priority: (parsed.priority ?? 4) as Priority,
    labels,
    due: parsed.due ?? defaults.due ?? null,
    deadline: parsed.deadline,
    duration: parsed.duration,
    recurrence: parsed.recurrence,
  });
}

export function QuickAdd({
  defaults = {},
  onClose,
  placeholder = 'Например: позвонить маме завтра в 19 №Дом !1',
  compact = false,
}: {
  defaults?: QuickAddDefaults;
  onClose?: () => void;
  placeholder?: string;
  compact?: boolean;
}) {
  const doc = useDoc();
  const [text, setText] = useState('');
  const [ignored, setIgnored] = useState<Ignored[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const mirror = useRef<HTMLDivElement>(null);

  useEffect(() => input.current?.focus(), []);

  const ctx = useMemo(
    () => ({
      now: Date.now(),
      tz: TZ,
      projects: [
        ...doc.projects().map((p) => ({ id: p.project.id, name: p.project.name })),
        { id: doc.inboxId, name: 'Входящие' },
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
    if (compact) showToast('Задача добавлена');
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
  if (parsed.deadline) chips.push({ key: 'deadline', label: `Дедлайн ${dateLabel(parsed.deadline)}`, token: tokenOf('deadline')! });
  if (parsed.duration) chips.push({ key: 'duration', label: durationLabel(parsed.duration), token: tokenOf('duration')! });
  if (parsed.priority) chips.push({ key: 'priority', label: `Приоритет ${parsed.priority}`, token: tokenOf('priority')! });
  if (parsed.projectId || parsed.newProject) {
    const name = parsed.newProject ? `${parsed.newProject} (новый)` : doc.project(parsed.projectId!)?.isInbox ? 'Входящие' : doc.project(parsed.projectId!)?.name;
    chips.push({ key: 'project', label: `# ${name}`, token: tokenOf('project')! });
  }
  for (const t of parsed.tokens.filter((x) => x.kind === 'label')) chips.push({ key: `l${t.start}`, label: t.text, token: t });

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
          aria-label="Новая задача"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
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
                  <button className="chip-x" title={`Оставить «${c.token.text}» в тексте (${KIND_LABEL[c.token.kind]})`} onClick={() => ignore(c.token!)}>
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
          <div className="qa-actions">
            {onClose && (
              <button type="button" onClick={onClose}>
                Отмена
              </button>
            )}
            <button type="button" className="primary" disabled={!parsed.title} onClick={submit}>
              Добавить
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

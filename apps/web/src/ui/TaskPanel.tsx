import { useEffect, useState } from 'react';
import { parseTask, type DateSpec, type Priority } from '#core';
import { TZ, dateLabel, durationLabel } from '../format.ts';
import { useDoc } from '../hooks.ts';
import { IconRepeat, IconTrash, IconX } from './icons.tsx';
import { QuickAdd } from './QuickAdd.tsx';
import { TaskTree, completeWithUndo } from './Task.tsx';
import { showToast } from './toast.tsx';

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];

/** Поле, которое сохраняет значение при уходе фокуса или Enter. */
function useDraft(value: string, commit: (v: string) => void) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return {
    value: draft,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: () => draft !== value && commit(draft),
  };
}

export function TaskPanel({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const doc = useDoc();
  const task = doc.task(id);
  const [repeatText, setRepeatText] = useState('');
  const [addingSub, setAddingSub] = useState(false);
  const title = useDraft(task?.title ?? '', (v) => v.trim() && doc.updateTask(id, { title: v }));
  const description = useDraft(task?.description ?? '', (v) => doc.updateTask(id, { description: v }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!task || !doc.isAlive(id)) {
    return (
      <aside className="panel">
        <div className="panel-head">
          <span className="muted">Задача удалена</span>
          <button className="icon" onClick={onClose} aria-label="Закрыть">
            <IconX />
          </button>
        </div>
      </aside>
    );
  }

  const projects = doc.projects();
  const labels = doc.labels();
  const setDue = (due: DateSpec | null) => doc.updateTask(id, { due });

  function applyRepeat() {
    const text = repeatText.trim();
    if (!text) return;
    const parsed = parseTask(text, { now: Date.now(), tz: TZ });
    if (!parsed.recurrence) {
      showToast('Не получилось понять повтор. Пример: «каждый понедельник»');
      return;
    }
    const base = parsed.due!;
    doc.updateTask(id, {
      recurrence: parsed.recurrence,
      due: { ...base, ...(task!.due?.time && !base.time ? { time: task!.due.time } : {}) },
    });
    setRepeatText('');
  }

  return (
    <aside className="panel" aria-label="Задача">
      <div className="panel-head">
        <select
          className="ghost"
          value={task.parentId ? '' : `${task.projectId}|${task.sectionId ?? ''}`}
          disabled={task.parentId !== null}
          onChange={(e) => {
            const [projectId, sectionId] = e.target.value.split('|') as [string, string];
            doc.moveTask(id, { projectId, sectionId: sectionId || null });
          }}
          aria-label="Проект"
        >
          {task.parentId && <option value="">Подзадача</option>}
          <option value={`${doc.inboxId}|`}>Входящие</option>
          {projects.map((p) => [
            <option key={p.project.id} value={`${p.project.id}|`}>
              {'  '.repeat(p.depth)}
              {p.project.name}
            </option>,
            ...doc.sections(p.project.id).map((s) => (
              <option key={s.id} value={`${p.project.id}|${s.id}`}>
                {'  '.repeat(p.depth)}
                {p.project.name} / {s.name}
              </option>
            )),
          ])}
        </select>
        <button className="icon" onClick={onClose} aria-label="Закрыть">
          <IconX />
        </button>
      </div>

      <div className="panel-body">
        <div className="panel-title-row">
          <button
            className={`check prio-${task.priority}${task.completedAt ? ' checked' : ''}`}
            aria-label={task.completedAt ? 'Вернуть в работу' : 'Выполнить'}
            onClick={() => (task.completedAt ? doc.reopenTask(id) : completeWithUndo(doc, task))}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6.5 12.5l3.6 3.6 7.4-7.6" />
            </svg>
          </button>
          <textarea
            className="panel-title"
            rows={1}
            {...title}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                (e.target as HTMLTextAreaElement).blur();
              }
            }}
            aria-label="Название"
          />
        </div>
        <textarea className="panel-desc" placeholder="Описание" rows={3} {...description} aria-label="Описание" />

        <dl className="fields">
          <dt>Срок</dt>
          <dd className="row">
            <input
              type="date"
              value={task.due?.date ?? ''}
              onChange={(e) => setDue(e.target.value ? { ...(task.due ?? {}), date: e.target.value } : null)}
              aria-label="Дата"
            />
            <input
              type="time"
              value={task.due?.time ?? ''}
              disabled={!task.due}
              onChange={(e) => {
                if (!task.due) return;
                const { time: _t, tz: _z, ...rest } = task.due;
                setDue(e.target.value ? { ...rest, time: e.target.value, ...(task.due.tz ? { tz: task.due.tz } : {}) } : rest);
              }}
              aria-label="Время"
            />
            {task.due && (
              <button className="icon small" onClick={() => setDue(null)} aria-label="Убрать срок">
                <IconX width={14} height={14} />
              </button>
            )}
          </dd>

          <dt>Повтор</dt>
          <dd>
            {task.recurrence ? (
              <div className="row">
                <span className="pill">
                  <IconRepeat /> {task.recurrence.text || task.recurrence.rule}
                  {task.recurrence.mode === 'completion' ? ' (от выполнения)' : ''}
                </span>
                <button onClick={() => doc.skipOccurrence(id)}>Пропустить раз</button>
                <button className="icon small" onClick={() => doc.updateTask(id, { recurrence: null })} aria-label="Убрать повтор">
                  <IconX width={14} height={14} />
                </button>
              </div>
            ) : (
              <input
                placeholder="каждый понедельник, по будням, каждые 3 дня…"
                value={repeatText}
                onChange={(e) => setRepeatText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && applyRepeat()}
                onBlur={applyRepeat}
                aria-label="Повтор"
              />
            )}
          </dd>

          <dt>Приоритет</dt>
          <dd className="row prio-picker">
            {([1, 2, 3, 4] as Priority[]).map((p) => (
              <button key={p} className={`prio-btn prio-${p}${task.priority === p ? ' active' : ''}`} onClick={() => doc.updateTask(id, { priority: p })}>
                {p === 4 ? 'Нет' : `P${p}`}
              </button>
            ))}
          </dd>

          <dt>Метки</dt>
          <dd className="row wrap">
            {labels.map((l) => {
              const on = task.labels.includes(l.id);
              return (
                <button
                  key={l.id}
                  className={`pill toggle c-${l.color}${on ? ' on' : ''}`}
                  onClick={() => doc.setLabels(id, on ? task.labels.filter((x) => x !== l.id) : [...task.labels, l.id])}
                >
                  {l.name}
                </button>
              );
            })}
            <input
              className="inline"
              placeholder="+ метка"
              onKeyDown={(e) => {
                const v = e.currentTarget.value.trim();
                if (e.key === 'Enter' && v) {
                  const existing = labels.find((l) => l.name.toLowerCase() === v.toLowerCase());
                  const lid = existing?.id ?? doc.createLabel(v);
                  if (!task.labels.includes(lid)) doc.setLabels(id, [...task.labels, lid]);
                  e.currentTarget.value = '';
                }
              }}
              aria-label="Новая метка"
            />
          </dd>

          <dt>Дедлайн</dt>
          <dd className="row">
            <input type="date" value={task.deadline ?? ''} onChange={(e) => doc.updateTask(id, { deadline: e.target.value || null })} aria-label="Дедлайн" />
            {task.deadline && <span className="muted">{dateLabel(task.deadline)}</span>}
          </dd>

          <dt>Начать не раньше</dt>
          <dd className="row">
            <input
              type="date"
              value={task.start?.date ?? ''}
              onChange={(e) => doc.updateTask(id, { start: e.target.value ? { date: e.target.value } : null })}
              aria-label="Дата начала"
            />
          </dd>

          <dt>Длительность</dt>
          <dd>
            <select value={task.duration ?? ''} onChange={(e) => doc.updateTask(id, { duration: e.target.value ? Number(e.target.value) : null })} aria-label="Длительность">
              <option value="">Не задана</option>
              {[...new Set([...DURATIONS, ...(task.duration ? [task.duration] : [])])]
                .sort((a, b) => a - b)
                .map((m) => (
                  <option key={m} value={m}>
                    {durationLabel(m)}
                  </option>
                ))}
            </select>
          </dd>
        </dl>

        <section className="subtasks">
          <h3>Подзадачи</h3>
          <TaskTree nodes={doc.subtasks(id)} onOpen={onOpen} selectedId={null} showDate />
          {addingSub ? (
            <QuickAdd defaults={{ parentId: id }} onClose={() => setAddingSub(false)} placeholder="Подзадача" />
          ) : (
            <button className="add-row" onClick={() => setAddingSub(true)}>
              + Добавить подзадачу
            </button>
          )}
        </section>
      </div>

      <div className="panel-foot">
        <span className="muted">Создано {new Date(task.createdAt).toLocaleString('ru', { dateStyle: 'medium', timeStyle: 'short' })}</span>
        <button
          className="danger"
          onClick={() => {
            doc.deleteTask(id);
            onClose();
            showToast('Задача удалена', { label: 'Отменить', run: () => doc.undo() });
          }}
        >
          <IconTrash width={16} height={16} /> Удалить
        </button>
      </div>
    </aside>
  );
}

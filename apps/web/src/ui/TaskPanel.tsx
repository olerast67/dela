import { useEffect, useRef, useState } from 'react';
import { extractLinks, parseTask, type DateSpec, type Priority } from '#core';
import { openExternal } from '../platform.ts';
import { Comments } from './Comments.tsx';
import { Markdown, toggleTask } from './Markdown.tsx';
import { TZ, dateLabel, durationLabel, todayDate } from '../format.ts';
import { useDoc } from '../hooks.ts';
import { controller } from '../controller.ts';
import { IconLink, IconRepeat, IconTrash, IconX } from './icons.tsx';
import { QuickAdd } from './QuickAdd.tsx';
import { RepeatEditor } from './RepeatEditor.tsx';
import { TaskTree, completeWithUndo } from './Task.tsx';
import { showToast } from './toast.tsx';
import { LOCALE, tr } from '../i18n.ts';

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];

export const REMINDER_OPTIONS: Array<[number, string]> = [
  [0, tr('в срок')],
  [10, tr('за 10 мин')],
  [30, tr('за 30 мин')],
  [60, tr('за 1 ч')],
  [1440, tr('за день')],
];

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

export function TaskPanel({ id, onClose, onOpen, onCopyLink }: { id: string; onClose: () => void; onOpen: (id: string) => void; onCopyLink: () => void }) {
  const doc = useDoc();
  const task = doc.task(id);
  const [repeatText, setRepeatText] = useState('');
  const [repeatEditor, setRepeatEditor] = useState(false);
  // Редактор повтора относится к открытой задаче: при переходе к другой он закрывается.
  useEffect(() => setRepeatEditor(false), [id]);
  const [addingSub, setAddingSub] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  useEffect(() => setEditingDesc(false), [id]);
  const title = useDraft(task?.title ?? '', (v) => v.trim() && doc.updateTask(id, { title: v }));
  const description = useDraft(task?.description ?? '', (v) => doc.updateTask(id, { description: v }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // На телефоне карточка задачи открыта листом снизу: потянуть за полоску вниз, чтобы закрыть.
  const panelRef = useRef<HTMLElement>(null);
  const grip = {
    onPointerDown(e: React.PointerEvent) {
      const el = panelRef.current;
      if (!el) return;
      const y0 = e.clientY;
      let dy = 0;
      const target = e.currentTarget as HTMLElement;
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        // указатель уже отпущен
      }
      el.style.transition = 'none';
      const move = (ev: PointerEvent) => {
        dy = Math.max(0, ev.clientY - y0);
        el.style.transform = `translateY(${dy}px)`;
      };
      const up = () => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
        el.style.transition = '';
        if (dy > 110) {
          el.style.transform = 'translateY(100%)';
          setTimeout(onClose, 200);
        } else el.style.transform = '';
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
      target.addEventListener('pointercancel', up);
    },
  };

  if (!task || !doc.isAlive(id)) {
    return (
      <aside className="panel">
        <div className="panel-head">
          <span className="muted">{tr('Задача удалена')}</span>
          <button className="icon" onClick={onClose} aria-label={tr('Закрыть')}>
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
      showToast(tr('Не получилось понять повтор. Пример: «каждый понедельник»'));
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
    <aside className="panel" aria-label={tr('Задача')} ref={panelRef}>
      <div className="panel-grip" {...grip} aria-hidden="true" />
      <div className="panel-head">
        <select
          className="ghost"
          value={task.parentId ? '' : `${task.projectId}|${task.sectionId ?? ''}`}
          disabled={task.parentId !== null}
          onChange={(e) => {
            const [projectId, sectionId] = e.target.value.split('|') as [string, string];
            doc.moveTask(id, { projectId, sectionId: sectionId || null });
          }}
          aria-label={tr('Проект')}
        >
          {task.parentId && <option value="">{tr('Подзадача')}</option>}
          <option value={`${doc.inboxId}|`}>{tr('Входящие')}</option>
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
        <button className="icon panel-link" onClick={onCopyLink} aria-label={tr('Копировать ссылку')} title={tr('Копировать ссылку (Ctrl+Shift+C)')}>
          <IconLink />
        </button>
        <button className="icon" onClick={onClose} aria-label={tr('Закрыть')}>
          <IconX />
        </button>
      </div>

      <div className="panel-body">
        <div className="panel-title-row">
          <button
            className={`check prio-${task.priority}${task.completedAt ? ' checked' : ''}`}
            aria-label={task.completedAt ? tr('Вернуть в работу') : tr('Выполнить')}
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
            aria-label={tr('Название')}
          />
        </div>
        {editingDesc || !task.description.trim() ? (
          <textarea
            className="panel-desc"
            placeholder={tr('Описание')}
            rows={3}
            {...description}
            onBlur={() => {
              description.onBlur();
              setEditingDesc(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
            }}
            autoFocus={editingDesc}
            aria-label={tr('Описание')}
          />
        ) : (
          // Описание показывается размеченным; щелчок по тексту (не по ссылке и не по пункту чек-листа) открывает правку.
          <div
            className="panel-desc panel-desc-view"
            role="button"
            tabIndex={0}
            aria-label={tr('Описание, изменить')}
            title={tr('Щёлкните, чтобы изменить')}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('a, input, button')) return;
              if (window.getSelection()?.toString()) return;
              setEditingDesc(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.target === e.currentTarget) {
                e.preventDefault();
                setEditingDesc(true);
              }
            }}
          >
            <Markdown text={task.description} onToggle={(i) => doc.updateTask(id, { description: toggleTask(task.description, i) })} />
          </div>
        )}
        {extractLinks(task.title).length > 0 && (
          <div className="links">
            {extractLinks(task.title).map((url) => (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.preventDefault();
                  void openExternal(url);
                }}
              >
                {url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
              </a>
            ))}
          </div>
        )}

        <dl className="fields">
          <dt>{tr('Срок')}</dt>
          <dd className="row">
            <input
              type="date"
              value={task.due?.date ?? ''}
              onChange={(e) => setDue(e.target.value ? { ...(task.due ?? {}), date: e.target.value } : null)}
              aria-label={tr('Дата')}
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
              aria-label={tr('Время')}
            />
            {task.due && (
              <button className="icon small" onClick={() => setDue(null)} aria-label={tr('Убрать срок')}>
                <IconX width={14} height={14} />
              </button>
            )}
          </dd>

          <dt>{tr('Повтор')}</dt>
          <dd>
            {task.recurrence ? (
              <div className="row">
                <span className="pill">
                  <IconRepeat /> {task.recurrence.text || task.recurrence.rule}
                  {task.recurrence.mode === 'completion' ? tr(' (от выполнения)') : ''}
                </span>
                <button onClick={() => doc.skipOccurrence(id)}>{tr('Пропустить раз')}</button>
                <button onClick={() => setRepeatEditor((v) => !v)} aria-expanded={repeatEditor}>
                  {tr('Настроить')}
                </button>
                <button className="icon small" onClick={() => doc.updateTask(id, { recurrence: null })} aria-label={tr('Убрать повтор')}>
                  <IconX width={14} height={14} />
                </button>
              </div>
            ) : (
              <div className="row repeat-row">
                <input
                  placeholder={tr('каждый понедельник, по будням, каждые 3 дня…')}
                  value={repeatText}
                  onChange={(e) => setRepeatText(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && applyRepeat()}
                  onBlur={applyRepeat}
                  aria-label={tr('Повтор')}
                />
                <button onClick={() => setRepeatEditor((v) => !v)} aria-expanded={repeatEditor}>
                  {tr('Настроить')}
                </button>
              </div>
            )}
            {repeatEditor && (
              // key: после сохранения или смены задачи форма заново заполняется из правила.
              <RepeatEditor
                key={`${id}|${task.recurrence?.rule ?? ''}|${task.recurrence?.mode ?? ''}`}
                recurrence={task.recurrence}
                due={task.due}
                today={todayDate()}
                onApply={(recurrence, due) => {
                  doc.updateTask(id, { recurrence, due });
                  setRepeatEditor(false);
                }}
                onCancel={() => setRepeatEditor(false)}
                onError={(message) => showToast(message)}
              />
            )}
          </dd>

          <dt>{tr('Напоминания')}</dt>
          <dd className="row wrap">
            {!task.due?.time ? (
              <span className="muted">{tr('Нужно время срока')}</span>
            ) : (
              <>
                {REMINDER_OPTIONS.map(([m, label]) => {
                  const current = task.reminders ?? controller.reminderDefaults();
                  const on = current.includes(m);
                  return (
                    <button
                      key={m}
                      className={`pill toggle c-green${on ? ' on' : ''}`}
                      onClick={() => doc.updateTask(id, { reminders: on ? current.filter((x) => x !== m) : [...current, m].sort((a, b) => a - b) })}
                    >
                      {label}
                    </button>
                  );
                })}
                {task.reminders !== null && (
                  <button className="link" onClick={() => doc.updateTask(id, { reminders: null })}>
                    {tr('как по умолчанию')}
                  </button>
                )}
              </>
            )}
          </dd>

          <dt>{tr('Приоритет')}</dt>
          <dd className="row prio-picker">
            {([1, 2, 3, 4] as Priority[]).map((p) => (
              <button key={p} className={`prio-btn prio-${p}${task.priority === p ? ' active' : ''}`} onClick={() => doc.updateTask(id, { priority: p })}>
                {p === 4 ? tr('Нет') : `P${p}`}
              </button>
            ))}
          </dd>

          {doc.isShared(task.projectId) && (
            <>
              <dt>{tr('Исполнитель')}</dt>
              <dd>
                <select
                  value={task.assignee ?? ''}
                  onChange={(e) => doc.updateTask(id, { assignee: e.target.value || null })}
                  aria-label={tr('Исполнитель')}
                >
                  <option value="">{tr('Никто')}</option>
                  {controller.cachedMembers(doc.spaceOfTask(id)).map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.userId === controller.userId ? tr('{email} (вы)', { email: m.email }) : m.email}
                    </option>
                  ))}
                </select>
              </dd>
            </>
          )}
          {!doc.isShared(task.projectId) && <dt>{tr('Метки')}</dt>}
          {!doc.isShared(task.projectId) && (
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
              placeholder={tr('+ метка')}
              onKeyDown={(e) => {
                const v = e.currentTarget.value.trim();
                if (e.key === 'Enter' && v) {
                  const existing = labels.find((l) => l.name.toLowerCase() === v.toLowerCase());
                  const lid = existing?.id ?? doc.createLabel(v);
                  if (!task.labels.includes(lid)) doc.setLabels(id, [...task.labels, lid]);
                  e.currentTarget.value = '';
                }
              }}
              aria-label={tr('Новая метка')}
            />
          </dd>
          )}

          <dt>{tr('Дедлайн')}</dt>
          <dd className="row">
            <input type="date" value={task.deadline ?? ''} onChange={(e) => doc.updateTask(id, { deadline: e.target.value || null })} aria-label={tr('Дедлайн')} />
            {task.deadline && <span className="muted">{dateLabel(task.deadline)}</span>}
          </dd>

          <dt>{tr('Начать не раньше')}</dt>
          <dd className="row">
            <input
              type="date"
              value={task.start?.date ?? ''}
              onChange={(e) => doc.updateTask(id, { start: e.target.value ? { date: e.target.value } : null })}
              aria-label={tr('Дата начала')}
            />
          </dd>

          <dt>{tr('Длительность')}</dt>
          <dd>
            <select value={task.duration ?? ''} onChange={(e) => doc.updateTask(id, { duration: e.target.value ? Number(e.target.value) : null })} aria-label={tr('Длительность')}>
              <option value="">{tr('Не задана')}</option>
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
          <h3>{tr('Подзадачи')}</h3>
          <TaskTree nodes={doc.subtasks(id)} onOpen={onOpen} selectedId={null} showDate />
          {addingSub ? (
            <QuickAdd defaults={{ parentId: id }} onClose={() => setAddingSub(false)} placeholder={tr('Подзадача')} />
          ) : (
            <button className="add-row" onClick={() => setAddingSub(true)}>
              {tr('+ Добавить подзадачу')}
            </button>
          )}
        </section>

        <Comments taskId={id} />
      </div>

      <div className="panel-foot">
        <span className="muted">{tr('Создано')} {new Date(task.createdAt).toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short' })}</span>
        <button
          className="danger"
          onClick={() => {
            doc.deleteTask(id);
            onClose();
            showToast(tr('Задача удалена'), { label: tr('Отменить'), run: () => doc.undo() });
          }}
        >
          <IconTrash width={16} height={16} /> {tr('Удалить')}
        </button>
      </div>
    </aside>
  );
}

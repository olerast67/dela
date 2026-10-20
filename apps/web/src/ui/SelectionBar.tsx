import { addDays, type Priority, type TaskView } from '#core';
import { todayDate } from '../format.ts';
import { useDoc } from '../hooks.ts';
import { tn, tr } from '../i18n.ts';
import { haptic } from '../platform.ts';
import { clearPicked, usePicked } from './selection.ts';
import { showToast } from './toast.tsx';

/** Панель действий над выделенными задачами. Всё действие отменяется одной кнопкой «Отменить». */
export function SelectionBar() {
  const doc = useDoc();
  const picked = usePicked();
  // Задача могла пропасть с другого устройства, пока была выделена.
  const tasks = [...picked].map((id) => doc.task(id)).filter((t): t is TaskView => !!t && t.deletedAt === null);
  if (tasks.length === 0) return null;

  // Подзадача, у которой выделен и родитель, переносится и удаляется вместе с ним.
  const ids = new Set(tasks.map((t) => t.id));
  const hasPickedAncestor = (t: TaskView) => {
    for (let p = t.parentId; p; p = doc.task(p)?.parentId ?? null) if (ids.has(p)) return true;
    return false;
  };
  const roots = tasks.filter((t) => !hasPickedAncestor(t));

  const apply = (label: string, fn: (t: TaskView) => void, list: readonly TaskView[] = tasks) => {
    doc.group(() => list.forEach(fn));
    haptic('success');
    clearPicked();
    showToast(`${label}: ${tn(list.length, 'задача', 'задачи', 'задач')}`, { label: tr('Отменить'), run: () => doc.undo() });
  };
  const setDate = (date: string | null) => apply(tr('Перенесено'), (t) => doc.updateTask(t.id, { due: date ? { ...(t.due ?? {}), date } : null }));
  const today = todayDate();

  return (
    <div className="selection-bar" role="toolbar" aria-label={tr('Действия с выделенными задачами')}>
      <span className="selection-count">{tr('Выбрано: {n}', { n: tasks.length })}</span>
      <button onClick={() => apply(tr('Выполнено'), (t) => t.completedAt === null && doc.completeTask(t.id))}>{tr('Выполнить')}</button>
      <button onClick={() => setDate(today)}>{tr('Сегодня')}</button>
      <button onClick={() => setDate(addDays(today, 1))}>{tr('Завтра')}</button>
      <button onClick={() => setDate(null)}>{tr('Без даты')}</button>
      <select
        aria-label={tr('Приоритет')}
        value=""
        onChange={(e) => {
          const priority = Number(e.target.value) as Priority;
          apply(tr('Приоритет {priority}', { priority }), (t) => doc.updateTask(t.id, { priority }));
        }}
      >
        <option value="" disabled>
          {tr('Приоритет')}
        </option>
        {[1, 2, 3, 4].map((p) => (
          <option key={p} value={p}>
            {tr('Приоритет {priority}', { priority: p })}
          </option>
        ))}
      </select>
      <select
        aria-label={tr('Проект')}
        value=""
        onChange={(e) => {
          const [projectId, sectionId] = e.target.value.split('|') as [string, string];
          apply(tr('Перенесено'), (t) => doc.moveTask(t.id, { projectId, sectionId: sectionId || null, parentId: null }), roots);
        }}
      >
        <option value="" disabled>
          {tr('Проект')}
        </option>
        <option value={`${doc.inboxId}|`}>{tr('Входящие')}</option>
        {doc.projects().map((p) => [
          <option key={p.project.id} value={`${p.project.id}|`}>
            {'  '.repeat(p.depth)}
            {p.project.name}
          </option>,
          ...doc.sections(p.project.id).map((s) => (
            <option key={s.id} value={`${p.project.id}|${s.id}`}>
              {'  '.repeat(p.depth + 1)}/ {s.name}
            </option>
          )),
        ])}
      </select>
      {doc.labels().length > 0 && (
        <select
          aria-label={tr('Метка')}
          value=""
          onChange={(e) => {
            const id = e.target.value;
            apply(tr('Метка добавлена'), (t) => !t.labels.includes(id) && doc.setLabels(t.id, [...t.labels, id]));
          }}
        >
          <option value="" disabled>
            {tr('Метка')}
          </option>
          {doc.labels().map((l) => (
            <option key={l.id} value={l.id}>
              @{l.name}
            </option>
          ))}
        </select>
      )}
      <button className="danger" onClick={() => apply(tr('Удалено'), (t) => doc.deleteTask(t.id), roots)}>
        {tr('Удалить')}
      </button>
      <button className="icon" onClick={clearPicked} aria-label={tr('Снять выделение')} title={tr('Снять выделение (Esc)')}>
        ×
      </button>
    </div>
  );
}

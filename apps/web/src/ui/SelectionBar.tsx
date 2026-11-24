import { useEffect, useRef, useState } from 'react';
import { addDays, minuteToTime, nowMinute, timeToMinute, type Priority, type TaskView } from '#core';
import { TZ, todayDate } from '../format.ts';
import { afterLast, nearestFreeStart, visualOrder } from '../plan.ts';
import { dayOf, packSelected, planDate, setPlanDate } from './planActions.ts';
import { useDoc } from '../hooks.ts';
import type { Workspace } from '#core';
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
      <PackButton doc={doc} ids={roots.filter((t) => t.completedAt === null).map((t) => t.id)} />
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

/** Задачи на экране сверху вниз: «Уложить» ставит выбранные в том порядке, в каком их видно. */
function shownOrder(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.content .task[data-id]')].map((el) => el.dataset.id!);
}

/**
 * «Уложить»: выбранные задачи встают встык в выбранный день с начала: сейчас, ближайшее свободное место,
 * где они помещаются подряд, или своё время. Занятые блоки и события они обходят.
 */
function PackButton({ doc, ids }: { doc: Workspace; ids: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const today = todayDate();
  const tomorrow = addDays(today, 1);
  const [date, setDate] = useState(() => planDate());
  const ordered = visualOrder(ids, shownOrder());
  const defaultTime = (d: string) => minuteToTime(afterLast(dayOf(doc, d, ordered), Date.now()));
  const [time, setTime] = useState('');
  useEffect(() => {
    if (!open) return;
    const d = planDate();
    setDate(d);
    setTime(defaultTime(d));
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  if (ids.length === 0) return null;
  const pack = (start: number | null) => {
    if (start === null) {
      showToast(tr('До 24:00 не влезает'));
      return;
    }
    if (packSelected(doc, ordered, date, start)) {
      setPlanDate(date);
      clearPicked();
    }
    setOpen(false);
  };
  const pick = (d: string) => {
    setDate(d);
    setTime(defaultTime(d));
  };
  const nm = nowMinute(date, Date.now(), TZ);
  return (
    <div className="pack" ref={ref}>
      <button className={open ? 'active' : ''} aria-expanded={open} onClick={() => setOpen(!open)}>
        {tr('Уложить')}
      </button>
      {open && (
        <div className="pack-pop" role="dialog" aria-label={tr('Уложить')}>
          <div className="segmented" role="group" aria-label={tr('День плана')}>
            <button className={date === today ? 'active' : ''} onClick={() => pick(today)}>
              {tr('Сегодня')}
            </button>
            <button className={date === tomorrow ? 'active' : ''} onClick={() => pick(tomorrow)}>
              {tr('Завтра')}
            </button>
          </div>
          <div className="pack-starts">
            {nm !== null && <button onClick={() => pack(Math.ceil(nm / 5) * 5)}>{tr('Сейчас')}</button>}
            <button onClick={() => pack(nearestFreeStart(dayOf(doc, date, ordered), ordered, Date.now(), nm === null && time ? timeToMinute(time) : undefined))}>
              {tr('Ближайшее свободное')}
            </button>
          </div>
          <form
            className="pack-time"
            onSubmit={(e) => {
              e.preventDefault();
              if (time) pack(timeToMinute(time));
            }}
          >
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label={tr('Начало')} required />
            <button type="submit" className="primary">
              {tr('Уложить')}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

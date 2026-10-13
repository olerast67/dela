/** Быстрый перенос задачи: лист снизу после смахивания влево. Время задачи сохраняется. */
import { createPortal } from 'react-dom';
import { addDays, isoWeekday, type TaskView } from '#core';
import { todayDate, weekdayShort } from '../format.ts';
import { useDoc } from '../hooks.ts';
import { haptic } from '../platform.ts';
import { showToast } from './toast.tsx';
import { tr } from '../i18n.ts';

export function RescheduleSheet({ task, onClose }: { task: TaskView; onClose: () => void }) {
  const doc = useDoc();
  const today = todayDate();
  const saturday = addDays(today, ((6 - isoWeekday(today) + 7) % 7) || 7);
  const monday = addDays(today, 8 - isoWeekday(today));
  const options: ReadonlyArray<[string, string | null, string]> = [
    [tr('Сегодня'), today, weekdayShort(today)],
    [tr('Завтра'), addDays(today, 1), weekdayShort(addDays(today, 1))],
    [tr('В выходные'), saturday, tr('Сб {n}', { n: Number(saturday.slice(8)) })],
    [tr('На следующей неделе'), monday, tr('Пн {n}', { n: Number(monday.slice(8)) })],
    [tr('Без даты'), null, ''],
  ];
  const move = (date: string | null) => {
    doc.updateTask(task.id, { due: date ? { ...(task.due ?? {}), date } : null });
    haptic('light');
    showToast(date ? tr('Задача перенесена') : tr('Дата убрана'), { label: tr('Отменить'), run: () => doc.undo() });
    onClose();
  };
  return createPortal(
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={tr('Перенести задачу')} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-title">{task.title}</div>
        {options.map(([label, date, hint]) => (
          <button key={label} className="sheet-option" onClick={() => move(date)}>
            <span>{label}</span>
            <span className="muted">{hint}</span>
          </button>
        ))}
        <label className="sheet-option">
          <span>{tr('Выбрать дату')}</span>
          <input type="date" defaultValue={task.due?.date ?? today} onChange={(e) => e.target.value && move(e.target.value)} aria-label={tr('Дата')} />
        </label>
      </div>
    </div>,
    document.body,
  );
}

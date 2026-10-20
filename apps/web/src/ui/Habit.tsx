/** Привычки: значок серии в строке задачи и блок в карточке (серия, полоска недель, пропуски). */
import { MAX_HABIT_SKIPS, type HabitDayState, type HabitStreak, type TaskView, type Workspace } from '#core';
import { TZ, dateLabel, todayDate } from '../format.ts';
import { useDoc } from '../hooks.ts';
import { tn, tr } from '../i18n.ts';
import { IconFlame } from './icons.tsx';
import { showToast } from './toast.tsx';

const STATE_LABEL: Record<HabitDayState, string> = {
  done: tr('выполнено'),
  skipped: tr('пропуск'),
  allowed: tr('пропуск по правилу'),
  missed: tr('не выполнено'),
  today: tr('сегодня, ещё не выполнено'),
  planned: tr('впереди'),
};

const times = (n: number) => tn(n, 'раз', 'раза', 'раз');

/** Серия в строке задачи: огонёк и число. Без серии огонёк серый. */
export function HabitBadge({ task }: { task: TaskView }) {
  const doc = useDoc();
  const s = task.habit && !task.projected ? doc.habitStreak(task.id, todayDate(), TZ) : null;
  if (!s) return null;
  const title = tr('Привычка: серия {n}, лучшая {best}', { n: s.current, best: s.best });
  return (
    <span className={`habit-badge${s.current > 0 ? ' on' : ''}`} title={title} aria-label={title}>
      <IconFlame /> {s.current}
    </span>
  );
}

/** Полоска последних недель: строки — недели с понедельника. */
export function HabitStrip({ streak }: { streak: HabitStreak }) {
  return (
    <div className="habit-strip" role="img" aria-label={tr('Последние недели')}>
      {streak.days.map((d) => {
        const hint = `${dateLabel(d.date)}: ${d.state ? STATE_LABEL[d.state] : tr('нет экземпляра')}`;
        return <span key={d.date} className={`habit-day${d.state ? ` s-${d.state}` : ''}`} title={hint} />;
      })}
    </div>
  );
}

function makeHabit(doc: Workspace, task: TaskView): void {
  if (task.recurrence) {
    doc.updateTask(task.id, { habit: { skipsPerWeek: 0 } });
    return;
  }
  // Без повтора привычка становится ежедневной с сегодняшнего дня.
  doc.updateTask(task.id, {
    recurrence: { rule: 'FREQ=DAILY', mode: 'schedule', text: tr('каждый день') },
    due: task.due ?? { date: todayDate() },
    habit: { skipsPerWeek: 0 },
  });
}

/** Поле «Привычка» в карточке задачи: строки dt/dd для списка полей. */
export function HabitField({ task }: { task: TaskView }) {
  const doc = useDoc();
  const today = todayDate();
  const byCompletion = task.recurrence?.mode === 'completion';
  const s = doc.habitStreak(task.id, today, TZ);
  return (
    <>
      <dt>{tr('Привычка')}</dt>
      <dd className="habit-field">
        <label className="checkline">
          <input
            type="checkbox"
            checked={task.habit !== null}
            disabled={task.habit === null && byCompletion}
            onChange={(e) => (e.target.checked ? makeHabit(doc, task) : doc.updateTask(task.id, { habit: null }))}
          />
          {task.habit ? tr('Считать серию') : task.recurrence ? tr('Считать серию дней подряд') : tr('Сделать привычкой: каждый день')}
        </label>
        {task.habit === null && byCompletion && <p className="muted habit-note">{tr('Серия считается по расписанию: выберите повтор без «после выполнения».')}</p>}
        {task.habit && s && (
          <>
            <div className="habit-sum">
              <span className={`habit-now${s.current > 0 ? ' on' : ''}`}>
                <IconFlame width={18} height={18} /> <b>{s.current}</b>
                <span className="muted">{tr('серия')}</span>
              </span>
              <span className="muted">{tr('лучшая: {n}', { n: s.best })}</span>
              {task.due && task.due.date <= today && task.completedAt === null && (
                <button
                  onClick={() => {
                    doc.skipOccurrence(task.id);
                    showToast(tr('Пропуск отмечен, серия сохранена'), { label: tr('Отменить'), run: () => doc.undo() });
                  }}
                  title={tr('Например, в болезнь или праздник: серия не прервётся и не вырастет')}
                >
                  {tr('Пропустить сегодня')}
                </button>
              )}
            </div>
            <HabitStrip streak={s} />
            <div className="habit-legend muted">
              <span><i className="habit-day s-done" /> {tr('выполнено')}</span>
              <span><i className="habit-day s-skipped" /> {tr('пропуск')}</span>
              <span><i className="habit-day s-allowed" /> {tr('по правилу')}</span>
              <span><i className="habit-day s-missed" /> {tr('не выполнено')}</span>
            </div>
            <label className="habit-skips">
              {tr('Можно пропустить в неделю')}
              <select
                value={task.habit.skipsPerWeek}
                onChange={(e) => doc.updateTask(task.id, { habit: { skipsPerWeek: Number(e.target.value) } })}
                aria-label={tr('Можно пропустить в неделю')}
              >
                {Array.from({ length: MAX_HABIT_SKIPS + 1 }, (_, n) => (
                  <option key={n} value={n}>
                    {n === 0 ? tr('ни разу') : times(n)}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </dd>
    </>
  );
}

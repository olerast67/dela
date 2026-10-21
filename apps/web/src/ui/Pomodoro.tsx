/** Помодоро: управление в карточке задачи и компактный таймер поверх любого экрана. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { clockLabel, gameFeature, pomodoroRemaining, type PomodoroState } from '#core';
import { durationLabel } from '../format.ts';
import { useDoc, useGame } from '../hooks.ts';
import { tr } from '../i18n.ts';
import { loadPomodoro, onPomodoroChange, pausePomo, pomodoroSettings, resumePomo, setPomodoroSettings, settlePomodoro, startPomodoro, startRest, stopPomodoro } from '../pomodoro.ts';
import { FocusSprout } from './Garden.tsx';
import { IconPause, IconPlay, IconStop, IconTimer } from './icons.tsx';
import { showToast } from './toast.tsx';

/** Состояние таймера и текущее время: пока таймер идёт, раз в секунду. */
function usePomodoro(): { s: PomodoroState | null; now: number } {
  const s = useSyncExternalStore(onPomodoroChange, loadPomodoro);
  const [now, setNow] = useState(() => Date.now());
  const running = s !== null && s.endsAt !== null && !s.logged;
  useEffect(() => {
    setNow(Date.now());
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running, s]);
  return { s, now };
}

function phaseLabel(s: PomodoroState): string {
  if (s.phase === 'break') return tr('Перерыв');
  return s.logged ? tr('Помодоро закончен') : tr('Работа');
}

/**
 * Дерево фокуса (сад): во время работы росток растёт по доле прошедшего времени, законченный отрезок — дерево.
 * Без сада — прежний значок таймера.
 */
function FocusIcon({ s, now, size }: { s: PomodoroState; now: number; size: number }) {
  if (!gameFeature(useGame(), 'garden')) return size > 24 ? null : <IconTimer width={16} height={16} />;
  const done = s.logged === true || s.phase === 'break';
  return <FocusSprout progress={done ? 1 : 1 - pomodoroRemaining(s, now) / Math.max(1, s.length)} done={done} size={size} />;
}

/** Пауза, продолжить, стоп; после работы — начать перерыв. */
function Controls({ s }: { s: PomodoroState }) {
  const doc = useDoc();
  const rest = pomodoroSettings().rest;
  return (
    <>
      {s.logged ? (
        <button className="pomo-btn pomo-rest" onClick={() => startRest()}>
          {tr('Перерыв {n} мин', { n: rest })}
        </button>
      ) : s.endsAt === null ? (
        <button className="icon small" onClick={() => resumePomo()} aria-label={tr('Продолжить таймер')} title={tr('Продолжить таймер')}>
          <IconPlay width={16} height={16} />
        </button>
      ) : (
        <button className="icon small" onClick={() => pausePomo()} aria-label={tr('Пауза')} title={tr('Пауза')}>
          <IconPause width={16} height={16} />
        </button>
      )}
      <button className="icon small" onClick={() => stopPomodoro(doc)} aria-label={tr('Остановить таймер')} title={tr('Остановить таймер')}>
        <IconStop width={16} height={16} />
      </button>
    </>
  );
}

/**
 * Таймер поверх любого экрана: щелчок открывает задачу. Он же следит за часами:
 * работа кончилась — время записывается в задачу, перерыв кончился — таймер снимается.
 */
export function PomodoroChip({ onOpen }: { onOpen: (taskId: string) => void }) {
  const doc = useDoc();
  const { s, now } = usePomodoro();
  useEffect(() => {
    const ended = settlePomodoro(doc, now);
    if (ended === 'break' && s) {
      const taskId = s.taskId;
      showToast(tr('Перерыв окончен'), { label: tr('Ещё помодоро'), run: () => startPomodoro(doc, taskId) }, 60_000);
    }
  }, [doc, s, now]);
  if (!s) return null;
  const task = doc.task(s.taskId);
  const left = pomodoroRemaining(s, now);
  return (
    <div className={`pomo-chip pomo-${s.phase}${s.endsAt === null ? ' paused' : ''}`} role="timer" aria-label={tr('Таймер помодоро')}>
      <button className="pomo-open" onClick={() => onOpen(s.taskId)} title={task?.title ?? ''}>
        <FocusIcon s={s} now={now} size={24} />
        <span className="pomo-time">{s.logged ? phaseLabel(s) : clockLabel(left)}</span>
        <span className="pomo-task">{s.phase === 'break' ? tr('Перерыв') : task?.title || tr('Задача')}</span>
      </button>
      <Controls s={s} />
    </div>
  );
}

/** Строка в карточке задачи: запуск помодоро и затраченное время. */
export function PomodoroField({ taskId, spent }: { taskId: string; spent: number }) {
  const doc = useDoc();
  const { s, now } = usePomodoro();
  const [editing, setEditing] = useState(false);
  const mine = s !== null && s.taskId === taskId;
  return (
    <>
      <dt>{tr('Помодоро')}</dt>
      <dd className="row wrap pomo-field">
        {mine ? (
          <>
            <FocusIcon s={s} now={now} size={34} />
            <span className={`pomo-big pomo-${s.phase}`} role="timer">
              {s.logged ? phaseLabel(s) : clockLabel(pomodoroRemaining(s, now))}
            </span>
            {!s.logged && <span className="muted">{s.endsAt === null ? tr('На паузе') : phaseLabel(s)}</span>}
            <Controls s={s} />
          </>
        ) : (
          <button
            className="pomo-btn"
            onClick={() => startPomodoro(doc, taskId)}
            title={s ? tr('Таймер на другой задаче остановится, отработанное там сохранится') : undefined}
          >
            <IconTimer width={16} height={16} /> {tr('Помодоро {n} мин', { n: pomodoroSettings().work })}
          </button>
        )}
      </dd>
      <dt>{tr('Затрачено')}</dt>
      <dd className="row wrap">
        {editing ? (
          <SpentEditor
            spent={spent}
            onDone={(minutes) => {
              if (minutes !== null && minutes !== spent) doc.setSpent(taskId, minutes);
              setEditing(false);
            }}
          />
        ) : (
          <>
            <span className="pomo-spent">{spent > 0 ? durationLabel(spent) : tr('нет')}</span>
            <button className="link" onClick={() => setEditing(true)}>
              {tr('Изменить')}
            </button>
            {spent > 0 && (
              <button
                className="link"
                onClick={() => {
                  doc.setSpent(taskId, 0);
                  showToast(tr('Затраченное время сброшено'), { label: tr('Отменить'), run: () => doc.undo() });
                }}
              >
                {tr('Сбросить')}
              </button>
            )}
          </>
        )}
      </dd>
    </>
  );
}

/** Правка вручную: часы и минуты. */
function SpentEditor({ spent, onDone }: { spent: number; onDone: (minutes: number | null) => void }) {
  const [h, setH] = useState(String(Math.floor(spent / 60)));
  const [m, setM] = useState(String(spent % 60));
  const value = () => {
    const hh = Number(h || 0);
    const mm = Number(m || 0);
    return Number.isFinite(hh) && Number.isFinite(mm) && hh >= 0 && mm >= 0 ? Math.round(hh * 60 + mm) : null;
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') onDone(value());
    if (e.key === 'Escape') onDone(null);
  };
  return (
    <>
      <input className="pomo-num" type="number" min={0} value={h} onChange={(e) => setH(e.target.value)} onKeyDown={keys} aria-label={tr('Часы')} autoFocus />
      <span className="muted">{tr('ч')}</span>
      <input className="pomo-num" type="number" min={0} max={59} value={m} onChange={(e) => setM(e.target.value)} onKeyDown={keys} aria-label={tr('Минуты')} />
      <span className="muted">{tr('мин')}</span>
      <button onClick={() => onDone(value())}>{tr('Сохранить')}</button>
      <button className="link" onClick={() => onDone(null)}>
        {tr('Отмена')}
      </button>
    </>
  );
}

/** Длительности работы и перерыва: настройка этого устройства. */
export function PomodoroSettings() {
  // Поля без привязки к состоянию: пока число стёрто для ввода нового, настройка не меняется.
  const [v] = useState(() => pomodoroSettings());
  const change = (key: 'work' | 'rest', raw: string, max: number) => {
    const n = Math.round(Number(raw));
    if (!raw || !Number.isFinite(n) || n < 1 || n > max) return;
    setPomodoroSettings({ ...pomodoroSettings(), [key]: n });
  };
  return (
    <section className="settings">
      <h2>{tr('Помодоро')}</h2>
      <p className="muted">
        {tr('Кнопка «Помодоро» в карточке задачи запускает таймер работы, потом предлагает перерыв. Отработанное время копится в задаче.')}
      </p>
      <div className="row wrap">
        <label className="row">
          {tr('Работа')}
          <input className="pomo-num" type="number" min={1} max={180} defaultValue={v.work} onChange={(e) => change('work', e.target.value, 180)} aria-label={tr('Работа, минут')} />
          {tr('мин')}
        </label>
        <label className="row">
          {tr('Перерыв')}
          <input className="pomo-num" type="number" min={1} max={60} defaultValue={v.rest} onChange={(e) => change('rest', e.target.value, 60)} aria-label={tr('Перерыв, минут')} />
          {tr('мин')}
        </label>
      </div>
    </section>
  );
}
